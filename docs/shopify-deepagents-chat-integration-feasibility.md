# Feasibility: Using the deepagents agent as the brain for the Shopify chat extension

**Date:** 2026-06-02
**Status:** Assessment + agreed plan. The goal later widened from "add a Shopify channel" to a
**multi-agent runtime**; the architecture decisions are recorded as ADRs **0011** (route = agent host),
**0012** (DeliverySurface channel seam), and **0013** (per-brand memory isolation; sharing deferred) in
`ponhu_chat_agent/docs/adr/`. §7 below is the agreed merged build sequence.
**Repos:**
- `shop-chat-deepagents-ui` (this repo) — Shopify app + `chat-bubble` theme extension; current brain is the Claude API.
- `ponhu_chat_agent` (`~/Dev/ponhu_chat_agent`) — deepagents/LangGraph agent on AWS; today serves 2 TikTok accounts via 2 ManyChat accounts (webhook in → reply pushed out via the ManyChat API).

> This document is symlinked into both repos' `docs/` directories. The canonical file lives in
> `shop-chat-deepagents-ui/docs/`; the copy under `ponhu_chat_agent/docs/` is a relative symlink
> (requires the two repos to remain siblings under `~/Dev/`).

**Provenance.** Produced by a multi-agent review (4 parallel code readers → synthesis → 4 adversarial
verifiers) plus independent manual reading of the deepagents I/O boundary (`main.py`, `contracts.py`,
`webhook_service.py`, `response_formatting.py`, `manychat_platform.py`). The adversarial pass confirmed
two claims, nuanced one (the synchronous reply already exists in the ack body), and **refuted** one
(there is no generic Platform/Channel abstraction to plug into — see §2.2). Findings below incorporate
those corrections. File:line citations refer to the state of both repos on the date above.

---

## 1. Verdict

**Feasible — yes, with caveats.** The proposed approach (add a new webhook/endpoint URL to deepagents
that serves the Shopify chat extension) is the right architecture. Three things make it tractable:

- The agent already computes a **complete reply synchronously** (`AgentRuntimeResponse.reply_text`,
  `ponhu_chat_agent/api/contracts.py:27`) before any ManyChat send, so returning it in an HTTP response
  is an extension, not a re-architecture.
- The Shopify widget's **token streaming is cosmetic, not structural** (the `chunk` handler is a pure
  accumulator, `extensions/chat-bubble/assets/chat.js:556`), so a single-payload reply renders
  identically. deepagents has no streaming and doesn't need to gain it.
- The Shopify **storefront catalog MCP tool requires no auth**, so it can move into deepagents cleanly.

The caveats that make this **not** plug-and-play:

- **Delivery is hardwired to ManyChat** (no generic channel interface). You must build the first
  non-ManyChat delivery surface yourself.
- **Customer-account MCP tools require interactive per-customer OAuth** that cannot run on a headless
  AWS agent — that flow must stay in the Shopify app.
- **Latency / deployment**: the current AWS path is async fire-and-forget with a ~9s webhook budget; a
  synchronous storefront endpoint needs a different deployment posture.

---

## 2. The core architecture mismatch

### 2.1 Synchronous SSE (Shopify) vs asynchronous push (ManyChat)

**Shopify side — synchronous SSE pull.** The widget POSTs `{message, conversation_id, prompt_type}`
with `Accept: text/event-stream` (`chat.js:478-495`) and the backend (`app/routes/chat.jsx`) holds an
SSE `ReadableStream` open, emitting `data: <json>\n\n` frames (`app/services/streaming.server.js:17-24`)
until `end_turn`. The customer reads the reply **off the HTTP response stream**.

**deepagents side — asynchronous out-of-band push.** ManyChat fires a webhook; `WebhookService.handle`
runs one synchronous turn via `runtime_client.invoke` (`api/webhook_service.py:307-324`) and then
**pushes** the reply back by calling the ManyChat HTTP API (`current_manychat_client.send_text(...)`,
`api/webhook_service.py:622`). The webhook's HTTP response body is only an ack/debug envelope
(`build_webhook_ack_response`, `api/response_formatting.py:190-203`); `main.py:321` logs the model
explicitly: *"ManyChat delivery model=api_send_only (webhook response is ack/debug, user messages are
API sends)."* In the default config (`INTERLEAVED_DELIVERY_ENABLED=True`), `ProseDeliveryMiddleware`
pushes prose to ManyChat **mid-turn**, after which the handler sets `already_sent_by_tools` and
**suppresses `reply_text`** (`api/webhook_service.py:620`).

**The seam.** `AgentRuntimeClient.invoke()` (`api/contracts.py:35`) returns
`AgentRuntimeResponse{ok, reply_text, tool_names, raw}` — the synchronous reply is already there, and
the ack body already carries a (sanitized) `reply` field. A Shopify endpoint reuses this invocation
seam and returns `reply_text` **in-band**, with ManyChat delivery disabled.

**Streaming is not a blocker.** `astream` is unused anywhere in deepagents (every path is a blocking
`agent.ainvoke`). The widget's `chunk` handler accumulates (`'' + fullText === fullText`), so the
Shopify proxy can "fake-stream": emit `id` → one `chunk` (full text) → `message_complete` → `end_turn`.
True token streaming (`agent.astream` + `StreamingResponse`) is a later, optional nicety.

### 2.2 There is no Platform/Channel abstraction (refuted assumption)

An adversarial verifier **refuted** the assumption that a new "Shopify channel" could simply implement
an existing platform interface. There is **no** `Platform` / `Channel` / `DeliveryClient` Protocol
anywhere. Delivery is hardwired to ManyChat in three places:

- Direct `send_text(...)` calls in the webhook layer (`api/webhook_service.py:448,550,622`), with a hard
  `MANYCHAT_API_KEY is required` guard.
- `ProseDeliveryMiddleware` calls `client.send_text` **inside the agent's model loop**
  (`api/agent_factory.py:2844-2909`).
- The agent's own LLM-facing tools are ManyChat-named: `manychat_send_text_message`
  (`api/agent_factory.py:3525`), `manychat_send_image_message` (`:3543`), `manychat_send_product_buy_now`.
- The `platform` field is validated against an allowlist `{instagram, tiktok}` that **raises** on
  anything else (`api/manychat_platform.py:69-78`).

**Consequence:** the reusable part is the *invocation* seam (`AgentRuntimeClient` + per-route
`delivery_tool_names_resolver`), **not** delivery. Adding Shopify means building the first non-ManyChat
delivery surface, widening/bypassing the platform allowlist, and gating the ManyChat send tail. That is
bounded but real work — do not estimate it as "implement an interface."

---

## 3. Integration options

### Option A — New synchronous Shopify endpoint in deepagents; Shopify `/chat` proxies + adapts to SSE  ✅ recommended

Add a deepagents endpoint (e.g. `POST /chat/shopify`, or a new `{agent_route}` with a Shopify delivery
preset) that mints a Shopify identity, runs `agent.ainvoke`, and returns
`{reply_text, images[], links[], products[]}` **in the response body** with ManyChat delivery disabled.
The Shopify `app/routes/chat.jsx` keeps its SSE shell but replaces the `claudeService.streamConversation`
loop with one call to the deepagents endpoint, re-emitting the reply as the existing SSE events.

- **deepagents changes:** new identity builder (do **not** reuse `build_manychat_actor_id` — it raises on
  non-IG/TikTok platforms, `api/manychat_platform.py:97-110`); widen platform validation or add a
  `shopify` channel dimension; new route/preset with `manychat_required: false`,
  `delivery_tool_names: []`, interleaved delivery off (precedent: the `user-analysis` route,
  `routes.local.yaml:38-45`); new endpoint serializing `reply_text` + structured content; **net-new
  inbound auth** (the webhook has none today, `main.py:553-560`).
- **Shopify changes:** remove the Anthropic loop in `app/routes/chat.jsx:179-266`; replace with one call
  to deepagents; map the response onto existing SSE events; decide who owns MCP tools and persistence.
- **Effort:** Medium-High. **Risk:** Medium. **Upside:** clean long-term boundary — deepagents is the
  brain (its prompt, skills, subagents, tools), the Shopify app is the storefront edge.

### Option B — Thin proxy: swap `claude.server.js` for a deepagents client; Shopify keeps tools + loop + persistence  ❌

Keep `chat.jsx`'s `while(stop_reason !== 'end_turn')` loop, Prisma persistence, and MCP client; only
swap the inner `claudeService.streamConversation` call for an HTTP call to deepagents.

- **Why worse than it looks:** deepagents is **not** a stateless message-completion service. It owns
  conversation state via a LangGraph checkpointer keyed by `thread_id` (`api/agent_factory.py:1624-1696`),
  plus its own tools/subagents/skills/prompt. Forcing it to behave like a raw Claude Messages endpoint
  that accepts an external tool list and emits Anthropic `tool_use` blocks discards its value and creates
  **split-brain state** (Shopify Prisma vs deepagents checkpointer). **Effort:** High. **Risk:** High.
  **Not recommended.**

### Option C — Point `chat.js` directly at the deepagents webhook (bypass the Shopify app server)  ❌

Edit the hardcoded `https://localhost:3458` URLs in `chat.js` (lines 484, 633, 782) to the deepagents
endpoint.

- **Why not:** (1) the webhook returns an **ack envelope, not the reply** (`api/response_formatting.py:190`),
  and pushes the real reply to ManyChat; (2) **no inbound auth** on deepagents — exposing it to storefront
  browsers is a security hole; (3) the Shopify backend derives shop identity and MCP endpoints from the
  `Origin` header (`chat.jsx:128,298-303`) — that logic lives in the app, not deepagents; (4) CORS +
  `X-Shopify-Shop-Id`; (5) the customer OAuth callback/popup must be browser-reachable and is registered
  in `shopify.app.toml`. **Not recommended** except as a throwaway spike.

### Recommendation: **Option A.**

It respects deepagents as the brain while keeping the Shopify app as the storefront edge (owns
`Origin`-derived shop identity, SSE adaptation, CORS, and the customer-OAuth callback/popup). The Shopify
app becomes a thin SSE-adapting proxy in front of a new synchronous deepagents Shopify endpoint.

---

## 4. Feature-parity gap table

| Capability | Shopify path today | deepagents+ManyChat today | After Option A | Work required |
|---|---|---|---|---|
| Streaming tokens | Yes (cosmetic; `chat.js:554-559`) | No (`ainvoke`, no `astream`) | Yes (fake-streamed: one `chunk`+`message_complete`) | None for parity; real streaming = wire `agent.astream` (unused) |
| Inbound user images | No (text-only POST, `chat.js:478-482`) | Yes (`api/image_handles.py`) | Net-new | Upload UI + extend POST body + endpoint accepts image refs |
| Outbound assistant images | No (only product thumbnails, `chat.js:840-847`) | Yes (`manychat_send_image_message`, `agent_factory.py:3543`) | Net-new | New SSE `image` event + `chat.js` render branch + deepagents delivery adapter emitting `{type:image,url}` to body |
| Markdown links | Yes (`chat.js:363-396`) | Via send tools; raw URLs stripped from prose (`sanitization.py:37,49`) | Yes-with-fix | Disable URL stripping for the Shopify channel; widget already renders `[text](url)` |
| Product cards / `product_results` | Yes (bound to `search_shop_catalog`, `tool.server.js:44`; `config.server.js:27`) | N/A (Lingxing/ERP catalog) | Needs adapter | deepagents emits products in the exact `{products:[{id,title,price,image_url,description,url}]}` shape, or proxy maps from a Shopify catalog tool result |
| Conversation history | Yes (Prisma, Anthropic content blocks, `chat.jsx:166-177`) | Yes (LangGraph checkpointer by `thread_id`) | Yes — deepagents owns it | Pick single source of truth; avoid split-brain (Prisma → display cache or drop) |
| Customer-auth tools (OAuth) | Yes (popup + PKCE + Prisma token store) | No | Yes — keep in Shopify app | Keep OAuth + callback + token store app-side; app executes customer MCP tools on deepagents' request |
| Multi-account / multi-shop | Per-shop via `Origin`/`X-Shopify-Shop-Id` (`chat.jsx:127-128`) | ManyChat-API-key accounts (`app_config.py`) | Needs new tenant model | shop-domain + Storefront/Admin token credential + parallel client registry |

---

## 5. Shopify MCP tools under deepagents (auth boundary)

The MCP tools do **not** all have to move into deepagents — and the two servers split cleanly. Protocol
is plain JSON-RPC 2.0 over HTTPS (`app/mcp-client.js:250-270`), so either side can speak it.

**(a) Storefront catalog search (`search_shop_catalog` via `${shop}/api/mcp`) — unauthenticated; move to
deepagents.** No Authorization header is sent (`app/mcp-client.js:89-91,144-147`). A deepagents tool can
call it server-to-server; it only needs the **shop domain**, which the Shopify app must pass explicitly
and trustworthily (do **not** trust a browser `Origin` for a server-side agent). Model it like the
existing ERP/web tool builders, quarantined to a `search_product_catalog`-style subagent.

**(b) Customer-account tools (cart/orders via `*.account.myshopify.com/customer/api/mcp`) — per-customer
OAuth (PKCE); keep app-side.** The flow is interactive: 401 → `generateAuthUrl` → popup → Shopify
redirect to `/auth/callback` → token exchange → Prisma `CustomerToken` keyed by `conversationId`
(`app/auth.server.js`, `app/routes/auth.callback.jsx`, `app/db.server.js`). A **headless AWS agent
cannot complete an interactive consent**, and the `redirect_uri` is pinned in `shopify.app.toml`.
Recommended execution model: **deepagents requests a customer action → the Shopify app runs the JSON-RPC
call with that conversation's token → returns the result.** Customer PII tokens then **never leave the
Shopify app** (this is protected customer data; the token is a bare PKCE bearer with no client secret).
Passing the token to AWS is possible but crosses a PII boundary — avoid unless necessary.

**Auth boundary summary:** shop identity (domain/shop-id) flows Shopify→deepagents; customer tokens stay
in Shopify Prisma; storefront MCP is open; customer MCP additionally requires a custom domain +
protected-customer-data approval (prerequisites independent of where the brain runs). Note: no
refresh-token handling exists (`refreshToken` column is never written, `prisma/schema.prisma:38`) —
expiry forces full re-auth.

> **Endpoint/tool drift caveat:** this repo hardcodes the legacy `/api/mcp` + `search_shop_catalog`,
> while current Shopify docs show migration to `/api/ucp/mcp` + `search_catalog`. Run `tools/list`
> against the actual target store before wiring. Also note the TODO at `app/mcp-client.js:20`:
> storefront MCP can be restricted on password-protected/demo stores.

---

## 6. Image round-trip

A TikTok-style image-in/image-out flow **can** work in the Shopify widget, but both ends need net-new
code — it is **not** supported today.

- **Inbound (user → assistant): none.** POST body is text-only (`chat.js:478-482`); no upload UI.
- **Outbound (assistant → user): none for assistant content.** The only `<img>` elements are product-card
  thumbnails (`chat.js:840-847`); the markdown renderer has no `![alt](url)` branch (`chat.js:363-396`);
  history re-render only handles `type==='text'` blocks (`chat.js:663-674`). deepagents emits images only
  as a ManyChat side-effect, and **strips raw URLs from prose** (`sanitization.py:37,49`).

**To add it:**
- **Frontend (`chat.js`):** (inbound) file-upload control + multipart/base64 in the POST body + a
  user-image render path; (outbound) a new SSE `image` event (or an `![alt](url)` branch in
  `formatMessageContent`), plus the same branch in `fetchChatHistory`.
- **SSE protocol / Shopify proxy:** define and emit the image event(s) from the deepagents response.
- **deepagents:** a Shopify-aware delivery adapter that emits `{type:image,url}` into the **body** instead
  of calling ManyChat, and **disable URL stripping** for the Shopify channel so links survive in prose.
  Inbound: accept image references in the endpoint and feed them to `agent.ainvoke`
  (`api/image_handles.py` already models image handling).

The inbound and outbound halves are independent vertical slices.

---

## 7. Recommended build sequence (merged: delivery strangler-fig + multi-agent runtime)

> **Reframe (2026-06-02).** The goal widened to a **multi-agent runtime** hosting the live `dm-chat`
> agent and a new Shopify brand agent on one harness (deepagents/langgraph — no port to the Claude
> Agent SDK). This sequence supersedes the original 10-step plan, reflecting **ADR 0011** (route = agent
> host), **ADR 0012** (DeliverySurface seam), **ADR 0013** (per-brand memory isolation). Key changes: the
> tool-preset registry refactor now lands *before* the Shopify preset, memory isolation is a first-class
> early slice, and the DeliverySurface strangler-fig is the *vehicle* for the Shopify endpoint. **Each
> slice leaves the live TikTok `dm-chat` agent green** — its `actor_id`, ManyChat send path, and Context
> Hub bundle untouched until explicitly noted. Tags: `[deepagents]` = `ponhu_chat_agent`,
> `[shopify]` = `shop-chat-deepagents-ui`, `[both]`.

**Core — reach "two agents on two channels, live agent green":**

1. **[deepagents] `DeliverySurface` seam, test-first** (ADR 0012) — extract `send_*` + `finalize`; wrap the
   ManyChat path byte-for-byte (golden payload test guards the dedup window); TDD the currently-untested
   `finalize` decision. Live agent unchanged. *(Pure addition — cannot regress production.)*
2. **[deepagents] tool_preset registry refactor** (ADR 0011) — convert the inline `tool_presets` dict
   (`api/agent_factory.py:4193-4231`) into an append-able registry, preserving `dm_chat` / `user_analysis`
   byte-for-byte. Pure enablement for Step 5.
3. **[both] Sync ingress + Shopify `DeliverySurface`** (ADR 0012; feasibility Option A) — a FastAPI endpoint
   that returns the turn synchronously; a sync `DeliverySurface` impl (`supports_interleaved_delivery=
   False` auto-disables `ProseDeliveryMiddleware`). Wire to a toolless preset first to prove transport.
   In `chat.jsx`, replace the Anthropic loop (`chat.jsx:179-266`) and re-emit `id` → `chunk` (full text) →
   `message_complete` → `end_turn`. → **text round-trip end-to-end.**
4. **[deepagents] Brand dimension in `actor_id` for NEW routes only + idempotency re-key** (ADR 0013) —
   thread `brand` into the actor_id seed on the Shopify path; re-key sourcing idempotency to actor_id
   (fixes the confirmed gap). `dm-chat`'s seed unchanged → no namespace rotation for the live agent.
5. **[both] Shopify tool_preset + agent config** (ADR 0011) — add the `shopify_<brand>` preset (Shopify
   Storefront/Admin GraphQL catalog/order tools, its *own* client — not the shared ERP singletons) to the
   Step-2 registry; emit `product_results` in the exact legacy shape (`tool.server.js:56-89`) so cards
   render unchanged. Add `agents/shopify-<brand>/AGENTS.md` + skills + subagents + a `routes.*.yaml` entry
   (`manychat_required: false`, `delivery_tool_names: []`). Config on the agent-identity side.
6. **[both] Register the Shopify route in all 3 runtimes + env lists** — add to `NO_MANYCHAT_ROUTES`
   (`cloud/lambdas/job_worker/handler.py:304`); confirm local / AgentCore / worker route resolution.
   → **two agents on two channels, live agent green.**

**Feature-parity tail — match the deepagents+ManyChat experience (images & links, the stated primary goal):**

7. **[both] Markdown links parity** — disable URL stripping for the Shopify channel (`sanitization.py`); the
   widget already renders `[text](url)`.
8. **[both] Image round-trip** (§6) — outbound first (new `image` SSE event + `chat.js` render branch, live
   + history; the Shopify `DeliverySurface` emits `{type:image,url}` into the body), then inbound (upload
   UI + POST-body change + endpoint feeds image refs to `ainvoke`). Independent halves.
9. **[both] Customer-auth tools** — keep the OAuth dance + token store app-side; the app executes customer
   MCP tools on deepagents' request (tokens never leave Shopify). Surface `auth_required` explicitly
   (today smuggled in tool-result text, `tool.server.js:22-31`).

**Deferred / anti-scope (ADR 0011 §Consequences, ADR 0013) — do NOT build for two agents on two channels:**

10. Generalize the Context Hub `bundle_route_prefix` (`api/agent_factory.py:4108`); per-brand wiring of the
    shared ERP/Feishu clients; the shared/exchange memory pool (ADR 0013 — explicit opt-in *per fact*); the
    cross-runtime `route`→`agent` wire rename (ADR 0011); a multi-shop tenant model; and true token
    streaming via `agent.astream`. Each only when its trigger condition is met.

---

## 8. Open questions / risks to resolve before committing

- **Latency & no async escape hatch.** deepagents shows ~6–32s/turn with adaptive extended thinking on by
  default (`agent_factory.py:4085-4099`), and the webhook has a ~9s `WEBHOOK_MAX_PROCESSING_SECONDS`
  budget (`app_config.py:486`). A synchronous Shopify path can't fall back to a late ManyChat followup the
  way the current flow does. Measure real latency; consider disabling extended thinking for the storefront
  route.
- **Deployment target.** The AWS path is async fire-and-forget (API GW → ingress Lambda → SQS → worker →
  AgentCore). A low-latency synchronous endpoint likely needs a dedicated always-warm FastAPI service or a
  direct AgentCore Runtime `/invoke`. Cold-start impact unquantified.
- **`/auth/token-status` polling contract.** The widget polls it every 10s (`chat.js:782`); the loader was
  outside the reviewed files. Confirm its contract before reworking the auth resume flow.
- **MCP endpoint/tool drift** on the live store (legacy `/api/mcp` vs `ucp`); verify with `tools/list`.
- **`conversation_id` trust.** Client-generated, no auth binding (server falls back to `Date.now()`); any
  conversation is addressable by id. The new auth layer should bind it to a session.
- **Coexistence.** Is the Shopify channel the *same* deployed agent as ManyChat, or a separate deployment?
  Determines whether `SUPPORTED_MANYCHAT_PLATFORMS` is widened in place (`manychat_platform.py:8`) or a
  separate channel dimension is introduced.
- **Conversation ownership / split-brain.** Whether Prisma history is deprecated or kept as a cache is a
  product decision; both stores currently exist.
