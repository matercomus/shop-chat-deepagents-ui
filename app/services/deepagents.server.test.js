import { describe, it, expect, vi } from "vitest";
import {
  normalizeSyncResponse,
  mapProductCard,
  imageUrlOf,
  normalizeImageEntries,
  buildRequestHeaders,
  buildRequestBody,
  buildTurnEvents,
  buildAssistantBlocks,
  buildUserBlocks,
  createDeepAgentsService,
  DeepAgentsError,
} from "./deepagents.server.js";

describe("normalizeSyncResponse", () => {
  it("defaults every field on an empty body", () => {
    expect(normalizeSyncResponse()).toEqual({
      ok: false,
      reply_text: "",
      products: [],
      images: [],
      links: [],
      thread_id: "",
      auth_required: null,
      runtime_session_id: "",
    });
  });

  it("preserves a populated envelope", () => {
    const body = {
      ok: true,
      reply_text: "hi",
      products: [{ id: "1" }],
      images: ["https://x/y.png"],
      links: [{ url: "u", text: "t" }],
      thread_id: "th",
      auth_required: null,
      runtime_session_id: "rs",
    };
    expect(normalizeSyncResponse(body)).toEqual(body);
  });

  it("coerces non-array collections to empty arrays", () => {
    const out = normalizeSyncResponse({ products: "nope", images: null });
    expect(out.products).toEqual([]);
    expect(out.images).toEqual([]);
  });
});

describe("mapProductCard", () => {
  it("passes through a complete card", () => {
    const card = {
      id: "p1",
      title: "Bag",
      price: "USD 100",
      image_url: "https://i/img.png",
      description: "nice",
      url: "https://shop/p/bag",
    };
    expect(mapProductCard(card)).toEqual(card);
  });

  it("fills sensible defaults for missing fields", () => {
    const out = mapProductCard({ title: "X" });
    expect(out.title).toBe("X");
    expect(out.price).toBe("Price not available");
    expect(out.image_url).toBe("");
    expect(out.url).toBe("");
    expect(out.id).toMatch(/^product-/);
  });
});

describe("imageUrlOf", () => {
  it("returns a string entry unchanged", () => {
    expect(imageUrlOf("https://x/y.png")).toBe("https://x/y.png");
  });
  it("reads url / image_url from an object", () => {
    expect(imageUrlOf({ url: "u" })).toBe("u");
    expect(imageUrlOf({ image_url: "iu" })).toBe("iu");
  });
  it("returns empty string for nothing", () => {
    expect(imageUrlOf(null)).toBe("");
    expect(imageUrlOf({})).toBe("");
  });
});

describe("buildRequestBody", () => {
  it("uses the conversation id as the customer id (thread anchor)", () => {
    const body = buildRequestBody({ message: "hi", conversationId: "uuid-1" });
    expect(body.message).toBe("hi");
    expect(body.customer_id).toBe("uuid-1");
    expect(body.conversation_id).toBe("uuid-1");
    expect("shop_domain" in body).toBe(false);
  });
  it("includes shop_domain only when provided", () => {
    const body = buildRequestBody({ message: "hi", conversationId: "u", shopDomain: "shop.example" });
    expect(body.shop_domain).toBe("shop.example");
  });
  it("omits images[] entirely for a text-only turn", () => {
    const body = buildRequestBody({ message: "hi", conversationId: "u" });
    expect("images" in body).toBe(false);
    const body2 = buildRequestBody({ message: "hi", conversationId: "u", images: [] });
    expect("images" in body2).toBe(false);
  });
  it("carries images[] in the locked {mime_type, data} shape when present", () => {
    const body = buildRequestBody({
      message: "do you have this in black?",
      conversationId: "u",
      images: [{ mime_type: "image/jpeg", data: "QUJD" }],
    });
    expect(body.images).toEqual([{ mime_type: "image/jpeg", data: "QUJD" }]);
  });
  it("supports an image-only turn (empty message + non-empty images[])", () => {
    const body = buildRequestBody({
      message: "",
      conversationId: "u",
      images: [{ mime_type: "image/png", data: "QUJD" }],
    });
    expect(body.message).toBe("");
    expect(body.images).toEqual([{ mime_type: "image/png", data: "QUJD" }]);
  });
});

describe("normalizeImageEntries", () => {
  it("returns [] for non-array / empty input", () => {
    expect(normalizeImageEntries()).toEqual([]);
    expect(normalizeImageEntries(null)).toEqual([]);
    expect(normalizeImageEntries("nope")).toEqual([]);
    expect(normalizeImageEntries([])).toEqual([]);
  });
  it("drops entries with no base64 data and defaults a missing mime_type", () => {
    const out = normalizeImageEntries([
      { mime_type: "image/jpeg", data: "QUJD" },
      { mime_type: "image/png" }, // no data -> dropped
      { data: "REVG" }, // no mime -> defaulted to ""
      "not-an-object",
    ]);
    expect(out).toEqual([
      { mime_type: "image/jpeg", data: "QUJD" },
      { mime_type: "", data: "REVG" },
    ]);
  });
});

describe("buildUserBlocks", () => {
  it("builds a text block plus a data: URL image block", () => {
    const blocks = buildUserBlocks({
      message: "do you have this in black?",
      images: [{ mime_type: "image/jpeg", data: "QUJD" }],
    });
    expect(blocks).toEqual([
      { type: "text", text: "do you have this in black?" },
      { type: "image", url: "data:image/jpeg;base64,QUJD" },
    ]);
  });
  it("omits the text block for an image-only turn", () => {
    const blocks = buildUserBlocks({
      message: "",
      images: [{ mime_type: "image/png", data: "QUJD" }],
    });
    expect(blocks).toEqual([{ type: "image", url: "data:image/png;base64,QUJD" }]);
  });
  it("passes through a data: URL already carrying its prefix", () => {
    const blocks = buildUserBlocks({
      images: [{ mime_type: "image/jpeg", data: "data:image/webp;base64,QUJD" }],
    });
    expect(blocks).toEqual([{ type: "image", url: "data:image/webp;base64,QUJD" }]);
  });
  it("is empty when there is nothing to show", () => {
    expect(buildUserBlocks({})).toEqual([]);
    expect(buildUserBlocks({ message: "   ", images: [] })).toEqual([]);
  });
});

describe("buildTurnEvents", () => {
  it("emits chunk -> message_complete -> image* -> end_turn -> product_results in order", () => {
    const events = buildTurnEvents({
      reply_text: "hello",
      images: ["https://i/1.png", { url: "https://i/2.png" }],
      products: [{ id: "p1", title: "Bag" }],
    });
    expect(events.map((e) => e.type)).toEqual([
      "chunk",
      "message_complete",
      "image",
      "image",
      "end_turn",
      "product_results",
    ]);
    expect(events[0].chunk).toBe("hello");
    expect(events[2].url).toBe("https://i/1.png");
    expect(events[3].url).toBe("https://i/2.png");
    expect(events[5].products[0].title).toBe("Bag");
  });

  it("omits the chunk when reply_text is empty (still delivers structure)", () => {
    const events = buildTurnEvents({ reply_text: "", products: [], images: [] });
    expect(events.map((e) => e.type)).toEqual(["message_complete", "end_turn"]);
  });

  it("omits product_results when there are no products", () => {
    const events = buildTurnEvents({ reply_text: "hi" });
    expect(events.some((e) => e.type === "product_results")).toBe(false);
  });
});

describe("buildAssistantBlocks", () => {
  it("builds text + image display-cache blocks", () => {
    const blocks = buildAssistantBlocks({ reply_text: "hi", images: ["https://i/1.png"] });
    expect(blocks).toEqual([
      { type: "text", text: "hi" },
      { type: "image", url: "https://i/1.png" },
    ]);
  });
  it("is empty when there is nothing to show", () => {
    expect(buildAssistantBlocks({ reply_text: "", images: [] })).toEqual([]);
  });
});

describe("buildRequestHeaders", () => {
  it("sends JSON with no auth header in dev (empty token)", () => {
    expect(buildRequestHeaders("")).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(buildRequestHeaders(undefined)).not.toHaveProperty("Authorization");
  });
  it("attaches a bearer header for the cloud shim when a token is set", () => {
    expect(buildRequestHeaders("s3cr3t")).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer s3cr3t",
    });
  });
});

describe("createDeepAgentsService endpoint/auth selection (issue #8)", () => {
  it("targets the local main.py endpoint with no auth header by default", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const svc = createDeepAgentsService({
      baseUrl: "http://localhost:8000",
      brand: "lux3three",
      authToken: "",
      fetchImpl,
    });
    expect(svc.endpoint).toBe("http://localhost:8000/shopify/agent/lux3three");
    await svc.invoke({ message: "hi", conversationId: "u" });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("targets the cloud shim and attaches the bearer header when a token is configured", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const svc = createDeepAgentsService({
      baseUrl: "https://jyr4f78wzb.execute-api.us-east-1.amazonaws.com",
      brand: "lux3three",
      authToken: "shim-token",
      fetchImpl,
    });
    expect(svc.endpoint).toBe(
      "https://jyr4f78wzb.execute-api.us-east-1.amazonaws.com/shopify/agent/lux3three",
    );
    await svc.invoke({ message: "hi", conversationId: "u" });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer shim-token");
  });

  it("forwards images[] over the cloud endpoint too (slice 8 over the shim)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const svc = createDeepAgentsService({
      baseUrl: "https://shim.example",
      brand: "lux3three",
      authToken: "t",
      fetchImpl,
    });
    await svc.invoke({
      message: "",
      conversationId: "u",
      images: [{ mime_type: "image/jpeg", data: "QUJD" }],
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer t");
    expect(JSON.parse(init.body).images).toEqual([{ mime_type: "image/jpeg", data: "QUJD" }]);
  });

  it("surfaces a 504 gateway timeout as a DeepAgentsError carrying status 504", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 504,
      text: async () => "gateway timeout",
    }));
    const svc = createDeepAgentsService({ baseUrl: "https://shim.example", authToken: "t", fetchImpl });
    await expect(svc.invoke({ message: "hi", conversationId: "u" })).rejects.toMatchObject({
      name: "DeepAgentsError",
      status: 504,
    });
  });
});

describe("createDeepAgentsService.invoke", () => {
  it("posts to /shopify/agent/{brand} and normalizes the response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, reply_text: "hi", products: [{ id: "p1" }] }),
    }));
    const svc = createDeepAgentsService({
      baseUrl: "http://localhost:8000/",
      brand: "lux3three",
      fetchImpl,
    });
    expect(svc.endpoint).toBe("http://localhost:8000/shopify/agent/lux3three");

    const out = await svc.invoke({ message: "hi", conversationId: "u", shopDomain: "s.example" });
    expect(out.reply_text).toBe("hi");
    expect(out.products).toEqual([{ id: "p1" }]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:8000/shopify/agent/lux3three");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      message: "hi",
      customer_id: "u",
      conversation_id: "u",
      shop_domain: "s.example",
    });
  });

  it("forwards images[] in the POST body when present", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const svc = createDeepAgentsService({ baseUrl: "http://x", brand: "b", fetchImpl });
    await svc.invoke({
      message: "",
      conversationId: "u",
      images: [{ mime_type: "image/jpeg", data: "QUJD" }],
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body).images).toEqual([{ mime_type: "image/jpeg", data: "QUJD" }]);
  });

  it("throws DeepAgentsError carrying the status on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "upstream down",
    }));
    const svc = createDeepAgentsService({ baseUrl: "http://x", brand: "b", fetchImpl });
    await expect(svc.invoke({ message: "hi", conversationId: "u" })).rejects.toMatchObject({
      name: "DeepAgentsError",
      status: 503,
    });
    await expect(svc.invoke({ message: "hi", conversationId: "u" })).rejects.toBeInstanceOf(
      DeepAgentsError,
    );
  });
});
