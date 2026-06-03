import { describe, it, expect, vi } from "vitest";
import {
  normalizeSyncResponse,
  mapProductCard,
  imageUrlOf,
  buildRequestBody,
  buildTurnEvents,
  buildAssistantBlocks,
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
