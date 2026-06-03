/**
 * DeepAgents Service
 *
 * Thin HTTP client for the deepagents synchronous Shopify endpoint
 * (`POST /shopify/agent/{brand}`). Replaces the in-browser Anthropic
 * orchestration loop (`claude.server.js`) per ADR 0015 + plan 0002 §1.
 *
 * The deepagents runtime owns catalog search, tool calls and the agent
 * thread (DynamoDBSaver checkpointer); this client just sends one turn and
 * reads back the locked `ShopifySyncResponse` envelope.
 */
import AppConfig from "./config.server";

/**
 * Error raised when the deepagents endpoint returns a non-2xx response.
 * Carries the HTTP status so callers can decide on a fallback reply.
 */
export class DeepAgentsError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "DeepAgentsError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Normalize the deepagents sync response into a fully-populated envelope.
 *
 * The contract (ADR 0015) is `{ok, reply_text, products[], images[], links[],
 * thread_id, auth_required, runtime_session_id}`. We default every field so
 * downstream code never has to null-check, and so a partial/garbled body still
 * yields a deliverable shape.
 *
 * @param {Object} data - Raw JSON body from the endpoint
 * @returns {Object} The normalized envelope
 */
export function normalizeSyncResponse(data = {}) {
  const safe = data && typeof data === "object" ? data : {};
  return {
    ok: Boolean(safe.ok),
    reply_text: typeof safe.reply_text === "string" ? safe.reply_text : "",
    products: Array.isArray(safe.products) ? safe.products : [],
    images: Array.isArray(safe.images) ? safe.images : [],
    links: Array.isArray(safe.links) ? safe.links : [],
    thread_id: typeof safe.thread_id === "string" ? safe.thread_id : "",
    auth_required: safe.auth_required ?? null,
    runtime_session_id:
      typeof safe.runtime_session_id === "string" ? safe.runtime_session_id : "",
  };
}

/**
 * Map a deepagents product card to the legacy widget shape.
 *
 * The deepagents catalog tool already buffers `{id, title, price, image_url,
 * description, url}` (the exact `formatProductData` shape the widget renders),
 * so this is defensive normalization, not reshaping.
 *
 * @param {Object} product - A product card from the sync body `products[]`
 * @returns {Object} `{id, title, price, image_url, description, url}`
 */
export function mapProductCard(product = {}) {
  const p = product && typeof product === "object" ? product : {};
  return {
    id: p.id || `product-${Math.random().toString(36).substring(7)}`,
    title: p.title || "Product",
    price: p.price || "Price not available",
    image_url: p.image_url || "",
    description: p.description || "",
    url: p.url || "",
  };
}

/**
 * Coerce a sync-body image entry to a URL string.
 *
 * `ShopifySyncResponse.images` is a list of URL strings, but accept
 * `{url}` / `{image_url}` objects defensively.
 *
 * @param {string|Object} image - An image entry
 * @returns {string} The image URL (empty string if none)
 */
export function imageUrlOf(image) {
  if (typeof image === "string") return image;
  if (image && typeof image === "object") return image.url || image.image_url || "";
  return "";
}

/**
 * Build the HTTP headers for a sync request.
 *
 * Always JSON. When an auth token is configured (the cloud shim path, issue #8
 * / ADR 0017) it is attached as `Authorization: Bearer <token>`; in dev the
 * token is empty and no auth header is sent (local `main.py` has no auth). The
 * token only ever lives in this server-side module — it must never reach the
 * client bundle.
 *
 * @param {string} [authToken] - The shared bearer secret (empty in dev)
 * @returns {Object} Request headers
 */
export function buildRequestHeaders(authToken) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return headers;
}

/**
 * Coerce inbound image entries to the locked `images[]` contract shape.
 *
 * The widget reads a picked file with `FileReader` and sends each as
 * `{mime_type, data}` where `data` is base64 (ADR 0016, slice 8-inbound). The
 * server strips any `data:<mime>;base64,` prefix and sniffs the real mime, so
 * `mime_type` is advisory; we still forward it. Entries without a `data`
 * payload are dropped (an empty image is nothing to reason over).
 *
 * @param {Array<Object>} [images] - Raw image entries
 * @returns {Array<Object>} `[{mime_type, data}]` entries (possibly empty)
 */
export function normalizeImageEntries(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    const data = typeof image.data === "string" ? image.data : "";
    if (!data) continue;
    out.push({
      mime_type: typeof image.mime_type === "string" ? image.mime_type : "",
      data,
    });
  }
  return out;
}

/**
 * Build the request body for the deepagents sync endpoint.
 *
 * `customer_id` carries the anonymous `localStorage` UUID — it is the
 * checkpointer thread anchor (plan 0002 H6). `shop_domain` is advisory only:
 * the endpoint is config-authoritative and ignores it when `SHOPIFY_SHOP_DOMAIN`
 * is set server-side. `images[]` carries inbound customer-uploaded photos as
 * base64 (ADR 0016); it is included only when non-empty so a text-only turn
 * sends the same body it always did. An image-only turn (no caption) sends an
 * empty `message` with a non-empty `images[]`.
 *
 * @param {Object} params
 * @param {string} params.message - The user's text
 * @param {string} params.conversationId - The anonymous thread anchor (UUID)
 * @param {string} [params.shopDomain] - Advisory shop domain
 * @param {Array<Object>} [params.images] - Inbound images `[{mime_type, data}]`
 * @returns {Object} JSON-serializable request body
 */
export function buildRequestBody({ message, conversationId, shopDomain, images }) {
  const body = {
    message,
    customer_id: conversationId,
    conversation_id: conversationId,
  };
  if (shopDomain) body.shop_domain = shopDomain;
  const imageEntries = normalizeImageEntries(images);
  if (imageEntries.length) body.images = imageEntries;
  return body;
}

/**
 * Build the ordered SSE events to re-emit for one turn (excluding the leading
 * `id` event, which the caller emits before the turn so the client anchors
 * early). Streaming is cosmetic (plan 0002 §1): the whole reply is one `chunk`.
 *
 * Order: chunk -> message_complete -> image* -> end_turn -> product_results.
 * Images land right after the text (inline with the assistant turn); product
 * cards trail at the end, matching the legacy placement.
 *
 * @param {Object} sync - A normalized `ShopifySyncResponse`
 * @returns {Array<Object>} Ordered SSE event payloads
 */
export function buildTurnEvents(sync = {}) {
  const events = [];
  const reply = sync.reply_text || "";
  if (reply) events.push({ type: "chunk", chunk: reply });
  events.push({ type: "message_complete" });

  for (const image of sync.images || []) {
    const url = imageUrlOf(image);
    if (url) events.push({ type: "image", url });
  }

  events.push({ type: "end_turn" });

  const products = (sync.products || []).map(mapProductCard);
  if (products.length) events.push({ type: "product_results", products });

  return events;
}

/**
 * Build the assistant message content blocks for the thin Prisma display cache
 * (so `fetchChatHistory` can re-render text + images after a reload). The
 * deepagents checkpointer remains the canonical thread; this is display-only.
 *
 * @param {Object} sync - A normalized `ShopifySyncResponse`
 * @returns {Array<Object>} Content blocks (`{type:'text'|'image', ...}`)
 */
export function buildAssistantBlocks(sync = {}) {
  const blocks = [];
  if (sync.reply_text) blocks.push({ type: "text", text: sync.reply_text });
  for (const image of sync.images || []) {
    const url = imageUrlOf(image);
    if (url) blocks.push({ type: "image", url });
  }
  return blocks;
}

/**
 * Build the display-cache content blocks for the customer's own turn.
 *
 * The widget renders the picked image immediately from a local data URL, but
 * the deepagents sync response never echoes the customer's upload back, so the
 * save path must persist it itself or the image vanishes on a history reload
 * (slice 8-inbound AC). We store each inbound image as a `data:` URL block that
 * `fetchChatHistory` re-renders with the same `{type:'image', url}` path it uses
 * for assistant images. The text block is included only when there is a caption,
 * so an image-only turn persists just its image(s).
 *
 * @param {Object} params
 * @param {string} [params.message] - The user's caption (may be empty)
 * @param {Array<Object>} [params.images] - Inbound images `[{mime_type, data}]`
 * @returns {Array<Object>} Content blocks (`{type:'text'|'image', ...}`)
 */
export function buildUserBlocks({ message, images } = {}) {
  const blocks = [];
  const text = typeof message === "string" ? message.trim() : "";
  if (text) blocks.push({ type: "text", text });
  for (const image of normalizeImageEntries(images)) {
    const data = image.data;
    const url = data.startsWith("data:")
      ? data
      : `data:${image.mime_type || "image/jpeg"};base64,${data}`;
    blocks.push({ type: "image", url });
  }
  return blocks;
}

/**
 * Creates a deepagents service instance.
 *
 * The target is environment-switched (issue #8): `baseUrl` resolves to the local
 * `main.py` endpoint in dev and the cloud shim in prod/preview, and `authToken`
 * is attached as a bearer header only on the cloud path. Both speak the same
 * wire contract, so the rest of the turn is identical.
 *
 * @param {Object} [options]
 * @param {string} [options.baseUrl] - deepagents base URL
 * @param {string} [options.brand] - Shopify route brand
 * @param {string} [options.authToken] - Cloud shim bearer secret (empty in dev)
 * @param {Function} [options.fetchImpl] - fetch override (for tests)
 * @returns {Object} Service with an `invoke` method and the resolved endpoint
 */
export function createDeepAgentsService(options = {}) {
  const baseUrl = (
    options.baseUrl ||
    process.env.SHOPIFY_AGENT_SHIM_URL ||
    process.env.DEEPAGENTS_URL ||
    AppConfig.deepagents.url
  ).replace(/\/+$/, "");
  const brand = options.brand || process.env.DEEPAGENTS_BRAND || AppConfig.deepagents.brand;
  const authToken =
    options.authToken ?? process.env.SHOPIFY_AGENT_SHIM_TOKEN ?? AppConfig.deepagents.authToken;
  const fetchImpl = options.fetchImpl || fetch;
  const endpoint = `${baseUrl}/shopify/agent/${encodeURIComponent(brand)}`;

  /**
   * Run one synchronous turn against the deepagents endpoint.
   *
   * @param {Object} params
   * @param {string} params.message - The user's text
   * @param {string} params.conversationId - The anonymous thread anchor (UUID)
   * @param {string} [params.shopDomain] - Advisory shop domain
   * @param {Array<Object>} [params.images] - Inbound images `[{mime_type, data}]`
   * @returns {Promise<Object>} The normalized `ShopifySyncResponse` envelope
   * @throws {DeepAgentsError} On a non-2xx response
   */
  const invoke = async ({ message, conversationId, shopDomain, images }) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: buildRequestHeaders(authToken),
      body: JSON.stringify(buildRequestBody({ message, conversationId, shopDomain, images })),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DeepAgentsError(
        `deepagents sync endpoint returned ${response.status}`,
        response.status,
        text,
      );
    }

    const data = await response.json();
    return normalizeSyncResponse(data);
  };

  return { invoke, endpoint, brand };
}

export default {
  createDeepAgentsService,
  normalizeSyncResponse,
  mapProductCard,
  imageUrlOf,
  normalizeImageEntries,
  buildRequestHeaders,
  buildRequestBody,
  buildTurnEvents,
  buildAssistantBlocks,
  buildUserBlocks,
  DeepAgentsError,
};
