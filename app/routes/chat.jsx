/**
 * Chat API Route
 *
 * Thin SSE adapter in front of the deepagents synchronous Shopify endpoint
 * (ADR 0015 / plan 0002 §1). One customer message -> one sync call to
 * `POST /shopify/agent/{brand}` -> re-emit the existing SSE events so the
 * storefront widget renders unchanged.
 *
 * The in-browser Anthropic + MCP orchestration loop (claude.server.js /
 * tool.server.js / mcp-client.js) is gone: catalog search, tool calls and the
 * conversation thread now live in the deepagents runtime. Prisma keeps only a
 * thin display cache (text + image blocks) so widget history survives reloads;
 * the deepagents checkpointer is the canonical thread.
 */
import { saveMessage, getConversationHistory } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import {
  createDeepAgentsService,
  buildTurnEvents,
  buildAssistantBlocks,
  buildUserBlocks,
  normalizeImageEntries,
  DeepAgentsError,
} from "../services/deepagents.server";


/**
 * React Router loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  const url = new URL(request.url);

  // Handle history fetch requests - matches /chat?history=true&conversation_id=XYZ
  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  // Handle SSE requests
  if (!url.searchParams.has('history') && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  // API-only: reject all other requests
  return new Response(JSON.stringify({ error: AppConfig.errorMessages.apiUnsupported }), { status: 400, headers: getCorsHeaders(request) });
}

/**
 * React Router action function for handling POST requests
 */
export async function action({ request }) {
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 * @param {Request} request - The request object
 * @param {string} conversationId - The conversation ID
 * @returns {Response} JSON response with chat history
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);

  return new Response(JSON.stringify({ messages }), { headers: getCorsHeaders(request) });
}

/**
 * Handle chat requests (both GET and POST)
 * @param {Request} request - The request object
 * @returns {Response} Server-sent events stream
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();
    const userMessage = body.message;
    // Inbound customer-uploaded images as base64 (ADR 0016 / slice 8-inbound).
    const images = normalizeImageEntries(body.images);

    // A turn must carry something. An image-only turn (a photo with no caption)
    // is valid: empty `message` + non-empty `images[]` (ADR 0016).
    if (!userMessage && images.length === 0) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // The widget generates a stable localStorage UUID and sends it as the
    // anonymous thread anchor (plan 0002 H6); fall back to a fresh UUID only if
    // a client somehow omits it.
    const conversationId = body.conversation_id || crypto.randomUUID();
    const shopDomain = resolveShopDomain(request);

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        userMessage,
        images,
        conversationId,
        shopDomain,
        stream
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Handle a complete chat session: one sync turn through deepagents, re-emitted
 * as the widget's SSE event vocabulary.
 *
 * @param {Object} params - Session parameters
 * @param {string} params.userMessage - The user's message
 * @param {Array<Object>} params.images - Inbound images `[{mime_type, data}]`
 * @param {string} params.conversationId - The conversation ID (thread anchor)
 * @param {string} params.shopDomain - The (advisory) shop domain
 * @param {Object} params.stream - Stream manager for sending responses
 */
async function handleChatSession({
  userMessage,
  images,
  conversationId,
  shopDomain,
  stream
}) {
  const deepagents = createDeepAgentsService();

  // Anchor the client on the conversation id up front, even if the turn is slow.
  stream.sendMessage({ type: 'id', conversation_id: conversationId });

  // Thin display cache: persist the user turn (text + any uploaded image blocks)
  // for history reload. The customer's image is stored as a data: URL block —
  // the sync response never echoes the upload back, so without this it vanishes
  // on refresh (slice 8-inbound AC).
  const userBlocks = buildUserBlocks({ message: userMessage, images });
  if (userBlocks.length > 0) {
    saveMessage(conversationId, 'user', JSON.stringify(userBlocks))
      .catch((error) => console.error('Error saving user message:', error));
  }

  // One synchronous turn. Any failure is mapped to a deliverable apology so the
  // contract's "deliver reply_text even when ok is false" holds.
  let sync;
  try {
    sync = await deepagents.invoke({ message: userMessage, conversationId, shopDomain, images });
  } catch (error) {
    console.error('DeepAgents invoke failed:', error);
    // A 504 from the cloud shim is a gateway timeout and is *indeterminate*: the
    // agent turn may still have committed its checkpoint server-side (ADR 0017).
    // We never auto-retry (there is no retry here) — instead we ask the customer
    // to re-send, so a slow turn does not double-advance the thread.
    const isTimeout = error instanceof DeepAgentsError && error.status === 504;
    sync = {
      ok: false,
      reply_text: isTimeout
        ? AppConfig.errorMessages.agentTimeout
        : AppConfig.errorMessages.agentUnavailable,
      products: [],
      images: [],
      links: [],
      thread_id: '',
      auth_required: null,
      runtime_session_id: ''
    };
  }

  // Re-emit the turn as SSE events (chunk -> message_complete -> image* ->
  // end_turn -> product_results). reply_text is delivered regardless of `ok`.
  for (const event of buildTurnEvents(sync)) {
    stream.sendMessage(event);
  }

  // Persist the assistant reply (text + images) to the display cache.
  const assistantBlocks = buildAssistantBlocks(sync);
  if (assistantBlocks.length > 0) {
    saveMessage(conversationId, 'assistant', JSON.stringify(assistantBlocks))
      .catch((error) => console.error('Error saving assistant message:', error));
  }
}

/**
 * Resolve the shop domain for the turn.
 *
 * The deepagents endpoint is config-authoritative on `shop_domain` (it ignores
 * a request value when `SHOPIFY_SHOP_DOMAIN` is set server-side), so this is
 * advisory. Prefer a server-side env var; the browser `Origin` is an untrusted
 * dev-only fallback (plan 0002 §1 auth boundary) and is never the security
 * source of truth.
 *
 * @param {Request} request - The request object
 * @returns {string} The shop domain (empty string if unknown)
 */
function resolveShopDomain(request) {
  const configuredDomain = AppConfig.deepagents.shopDomain;
  if (configuredDomain) return configuredDomain;

  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      // not a parseable URL; fall through
    }
  }
  return "";
}

/**
 * Gets CORS headers for the response
 * @param {Request} request - The request object
 * @returns {Object} CORS headers object
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400" // 24 hours
  };
}

/**
 * Get SSE headers for the response
 * @param {Request} request - The request object
 * @returns {Object} SSE headers object
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  };
}
