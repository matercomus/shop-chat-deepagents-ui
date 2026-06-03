# App-side scope — shop-chat-deepagents-ui (Session 2)

**Repo:** `shop-chat-deepagents-ui` · **Date:** 2026-06-02 · **Status:** scope/plan
**Scope:** the `[shopify]` / app-half slices of §7 of the feasibility doc — **slices 3, 7, 8, 9**
(the storefront edge that proxies to the new deepagents sync endpoint and owns SSE/CORS/customer-OAuth).

> Companion deepagents-side plan: `0001-shopify-multiagent-runtime-deepagents-plan.md`.
> This doc lives in `ponhu_chat_agent/docs/plans/` while both sessions are driven together; it
> should be copied into `shop-chat-deepagents-ui/docs/` when the app-side work begins (do not
> clobber any parallel app-side working-tree edits).

---

## 0. Verified anchors (drift-corrected this session)

App-side line numbers spot-checked against the current `shop-chat-deepagents-ui` tree:

| Anchor | Handoff | Actual | Note |
|---|---|---|---|
| Orchestration loop (`chat.jsx`) | :179-266 | **:182-266** | the `while(stop_reason!=="end_turn")` Anthropic loop |
| SSE stream open | — | :84-96 (`createSseStream`/`handleChatSession`) | wraps the loop |
| Shop identity (Origin/X-Shopify-Shop-Id) | :127-128 | :127-128 | **untrusted** browser Origin |
| getCustomerAccountUrls | :298-303 | :299-303 | `.well-known` fetches off Origin |
| History load (Prisma→Anthropic blocks) | :166-177 | :163-177 | |
| SSE frame emitter (`streaming.server.js`) | :17-24 | :17-24 | exact |
| `product_results` shape (`tool.server.js`) | :56-89 | :56-89 | + `formatProductData` :96-111 |
| widget stream URL (`chat.js`) | :484 | :484 | hardcoded `https://localhost:3458/chat` |
| widget history URL | :633 (mislabeled "streamUrl") | :633 | `?history=true&conversation_id=` |
| widget token-status URL | :782 (mislabeled "streamUrl") | :782 | `/auth/token-status?...` (polled 10s) |
| chunk accumulator | :556 | :555-558 | `dataset.rawText += data.chunk` |
| markdown/link render | :363-396 | :363-396 | `formatMessageContent` (renders `[t](u)`) |
| product card render | :840-847 | :840-847 | reads `{id,title,price,image_url,url}` (no description) |
| history re-render | :663-674 | :662-674 | only `type==='text'` blocks |
| POST body (text-only) | :478-482 | :477-482 | `{message, conversation_id, prompt_type}` |
| storefront MCP endpoint | :89-91 | **:21** (constructor `/api/mcp`) | TODO at :20 |
| customer MCP tool call | :144-147 | **:197-205** | major drift |
| refreshToken column | schema :38 | schema :38, **never written** by `db.server.js` | |
| dev command | `shopify app dev --use-localhost` | `shopify app dev` (bare) | `--use-localhost` not in package.json |

**Full SSE event vocabulary `chat.jsx` emits today:** `id`, `chunk`, `message_complete`,
`end_turn`, `product_results`, `tool_use`, `new_message`, `content_block_complete`, plus
`error` / `rate_limit_exceeded` (from `streaming.server.js`).

---

## 0b. Review corrections (adversarial pass — binding before any app-side code)

These five must be resolved before the corresponding slice is coded; they were surfaced by the
multi-agent plan review and **govern the sections below**.

> **RESOLVED 2026-06-02 (grill-with-docs pass).** All five are now settled (see the per-bullet
> "RESOLVED" notes). The deepagents-side contract is locked in **ADR 0015** + the
> `ShopifySyncResponse` TypedDict in `ponhu_chat_agent/api/shopify_ingress.py` (import it / mirror
> it app-side). H6/H7 resolutions are recorded inline below and in §7.

- **C4 — lock the sync contract first (blocks slice 3).** Today `agentcore_runtime/app.py:644-660`
  returns only `{ok, reply_text, tool_names, delivery_sent_with_tools, prose_delivered_live,
  manychat_required, runtime_session_id}` — **no** `products[]`/`images[]`/`links[]`/`auth_required`/
  `thread_id`, and `ShopifyDeliverySurface` does not exist yet. Precondition for slice 3: (1)
  `api/delivery/shopify_surface.py` implements `send_product/send_image/send_link` buffering +
  `finalize()` returning those lists; (2) the agentcore return dict is extended to carry the
  buffer; (3) the `/shopify/agent/<brand>` endpoint routes it out. Lock the shape as a shared
  TypedDict visible to both repos before writing `chat.jsx`.
  **RESOLVED → ADR 0015.** `ShopifyDeliverySurface` already exists (shipped slice 1) and
  `finalize()` returns `{reply_text, products, images, links}`. The locked envelope is the
  `ShopifySyncResponse` TypedDict (`api/shopify_ingress.py`): `{ok, reply_text, products[],
  images[], links[], thread_id, auth_required: AuthRequired|None, runtime_session_id}`. The
  endpoint (not the surface) assembles `ok`/`thread_id`/`runtime_session_id`/`auth_required`
  around `finalize()`'s body.
- **H6 — anonymous `thread_id` anchor (blocks slice 3).** `conversation_id` is a client-side
  timestamp persisted only in `sessionStorage` (cleared on tab close) → the majority of
  storefront (pre-auth) traffic orphans its thread on every return visit. Use a **first-party
  cookie scoped to the shop domain** OR a **random UUID in `localStorage`** as the anonymous
  thread seed; on auth, document whether to merge into the OAuth-`sub`-derived thread or start
  fresh. D1's grammar covers only the *authenticated* actor — the anonymous case must be named.
  **RESOLVED:** random UUID in `localStorage` (`crypto.randomUUID()`, generated once client-side,
  sent as `conversation_id`). **Cookie rejected:** the widget fetches cross-origin (storefront
  page → app server, `mode:'cors'`, no `credentials`) and there is **no Shopify App Proxy** in
  `shopify.app.toml`, so any app-set cookie is third-party (blocked by ITP/ETP) AND unreadable by
  the widget JS that must populate `conversation_id`. localStorage is same-origin, survives tab
  close (today's `sessionStorage` is the orphan defect), needs zero new infra. **On auth: start
  fresh** under the OAuth-`sub` actor_id (`{brand}:{account}:shopify:{customer}`, D1); no
  checkpointer thread merge. The anonymous UUID is carried only as a Prisma/display join key. The
  ingress supplies the anonymous UUID into `build_shopify_actor_id`'s `customer_id` slot (which
  fails closed on empty) so pre-auth turns still get a stable namespace.
- **H7 — customer-MCP execution model (blocks slice 9).** `DeliverySurface` has no
  `invoke_customer_tool`; `auth_required` is only a boolean; the app's direct-call MCP loop is
  deleted in slice 3. Pick one model: **(A)** deepagents calls the customer-MCP endpoint with the
  OAuth token forwarded per-request (token-in-request; simplest, but token transits AWS), or
  **(B)** deepagents returns a structured tool-call intent `{tool_name, args, tool_use_id}`; the
  app executes it with its token and POSTs the result back to a deepagents **continuation
  endpoint** (keeps tokens app-side; needs a new endpoint). Specify in slice 9 before coding.
  **RESOLVED → ADR 0015: model (B)** (tokens never leave the app — the PKCE bearer grants
  order/cart PII and must not enter AWS/LangSmith/the checkpointer). **Phasing:** slices 3–8 ship
  text/products/images/links only; deepagents emits a structured `auth_required` intent
  (`{tool_name, tool_use_id, args, reason}`) but no customer-account tool fires yet, so
  `auth_required` is `null/absent`. The continuation endpoint (LangGraph `interrupt()` /
  `Command(resume)`, keyed by `runtime_session_id` + `tool_use_id`) and customer-account tools
  land in **slice 9**. A contract test asserts the slice-3 endpoint never emits a non-null
  `auth_required`.
- **H8 — product-card data ownership after slice 3 (blocks slice 3).** Decide: **(a)** products
  arrive via the sync body (`ShopifyDeliverySurface.send_product` buffer) → **remove** the
  `tool.server.js:44` `toolName === productSearchName` guard and drive cards entirely off
  `products[]`; or **(b)** app still calls MCP directly → verify/update the legacy
  `search_shop_catalog` name (`config.server.js:28`) against the store's `tools/list` (docs show
  `/api/ucp/mcp` + `search_catalog`). Default: (a).
  **RESOLVED: (a)** — drive cards off the sync-body `products[]`. **MCP drift confirmed (H8):**
  the legacy `/api/mcp` + `search_shop_catalog` was **removed** (~2025-10-31, June-15 UCP
  cutover); current is `/api/ucp/mcp` + `search_catalog` (no auth, requires `meta.ucp-agent.profile`).
  The deepagents Shopify catalog tool calls UCP server-to-server and buffers the `{id, title,
  price, image_url, description, url}` cards into the surface. **Buyable gate (ADR 0015 / CONTEXT.md):**
  a card must not surface a live buy URL for a zero-stock `active` listing — the catalog tool emits
  only buyable variants (`status=="active"` AND in stock). Ops note: confirm the real store's
  `tools/list` before launch (endpoint/tool name are config-driven `SHOPIFY_*` knobs so this is a
  config change, not code).
- **M8 — outbound image is a 5-part vertical slice (slice 8).** The widget has **no** `image` SSE
  case today, so a partial slice silently drops images. Ship together: (1)
  `ShopifyDeliverySurface.send_image` buffers `{type:image,url}`; (2) agentcore returns
  `images[]`; (3) `chat.jsx` re-emits an SSE `image` event; (4) `chat.js handleStreamEvent` adds
  `case 'image':` rendering inline; (5) `fetchChatHistory` handles image blocks on re-render.

---

## 1. Slice 3 — Sync ingress consumer: `chat.jsx` becomes a thin SSE adapter

**What `chat.jsx` becomes.** Replace the `while(finalMessage.stop_reason !== "end_turn")`
Anthropic orchestration loop (`:182-266`) — and the `mcpClient.tools` / `onToolUse` MCP loop —
with **one call** to the deepagents sync endpoint, then re-emit the existing SSE events so the
widget renders unchanged:
```
emit {type:'id', conversation_id}
POST deepagents sync endpoint  ->  { reply_text, products[], images[], links[], auth_required? }
emit {type:'chunk', chunk: reply_text}        // single chunk; widget accumulator handles it (chat.js:555-558)
emit {type:'message_complete'}
emit {type:'end_turn'}
if products.length: emit {type:'product_results', products}   // mapped to the legacy shape
```
- **Streaming is cosmetic** (feasibility §2.1; widget accumulator `chat.js:555-558`). One chunk
  carrying the whole reply renders identically. No `astream` needed (deferred, ADR/anti-scope).
- **Replaces `app/services/claude.server.js`** with `app/services/deepagents.server.js` — a thin
  HTTP client: `invoke({message, threadId, brand, shopDomain, images?}) -> {reply_text, products,
  images, links, auth_required}`. Keep `app/services/streaming.server.js` (frame emitter) and
  `app/services/tool.server.js`'s `formatProductData` shape (`{id,title,price,image_url,
  description,url}`) — map the deepagents `products[]` to it.
- **`stop_reason` trap (area-E risk #1):** the loop's sentinel must go. With a single sync call
  there is no loop; just emit-once. If you keep any loop shape, guarantee termination.
- **Auth boundary (feasibility §5):** shop domain flows **app → deepagents** explicitly and
  **trustworthily** — derive it server-side (Shopify session / signed app-proxy header), **not**
  from the browser `Origin` (`chat.jsx:128`, area-E risk #6). Customer OAuth tokens **never leave
  the app** (slice 9).

**Deepagents sync contract (the seam, from plan 0001 §6/§7):** `POST /shopify/agent/<brand>`
(local `main.py`) / AgentCore `/invoke` with `route="shopify-<brand>"`; request carries
`{message, actor_id|customer_id, brand, shop_domain, thread_id, images?}`; response is
`{ok, reply_text, products, images, links, auth_required, thread_id}` produced via
`ShopifyDeliverySurface.finalize` (buffers sends, returns them in-band). **D7:** direct
AgentCore `/invoke` (already sync-capable) is the default posture.

---

## 2. Persistence ownership (the split-brain decision) — slice 3 sub-decision

Today Prisma owns 100% of conversation state (`Message` table: `conversationId`, `role`,
`content` = JSON Anthropic blocks). The deepagents checkpointer (DynamoDBSaver, keyed by
`thread_id`) will own canonical agent state (messages incl. tool_call/ToolMessage pairs).

**Recommendation:** deepagents checkpointer becomes the **single source of truth** for the
message thread; Prisma retains **only** the auth/session tables it uniquely owns —
`CustomerToken`, `CodeVerifier`, `CustomerAccountUrls`, `Session`. The `Conversation` +
`Message` tables and the widget history endpoint (`chat.jsx:54-58`, `chat.js:633`) become
either (a) removed, or (b) a thin display cache rebuilt from the deepagents thread. Avoid
dual-writing the thread (split-brain).

**`thread_id` stability (area-E risk #8, open Q2).** `conversationId` is `Date.now().toString()`
— ephemeral per page load. For checkpointer resume to work, `thread_id` must survive refresh:
persist `conversationId` in `sessionStorage` (anonymous) and/or derive `thread_id` from the
customer OAuth `sub` once authenticated. This is the app-side analog of plan 0001's `actor_id`
grammar (D1) — keep them consistent (`{brand}:{account}:shopify:{customer}` once known).

---

## 3. Slice 7 — Markdown links parity

- The widget **already renders** `[text](url)` (`formatMessageContent` `chat.js:363-396`), with
  special-casing for auth links and `/cart`|`checkout` links.
- deepagents currently **strips raw URLs** from prose (`api/sanitization.py`) — designed for DM
  platforms. **Disable URL stripping for the Shopify channel** so links survive in `reply_text`.
  This is a deepagents-side toggle keyed on the channel/route (plan 0001 — small follow-up), not
  an app-side change. App-side: nothing further; confirm links render.

---

## 4. Slice 8 — Image round-trip (two independent halves)

The widget has **no** image support today: no upload UI, no `FileReader`, no `![alt](url)`
branch, no image render path (`Message.add` handles only text; `chat.js`). Both halves are net-new.

- **Outbound first (assistant → user):** add an SSE `image` event (or an `![alt](url)` branch in
  `formatMessageContent` + the same branch in `fetchChatHistory` re-render `chat.js:662-674`).
  deepagents `ShopifyDeliverySurface.send_image` emits `{type:image,url}` into the body
  (plan 0001 slice 1); `chat.jsx` re-emits it as the SSE `image` event; widget renders it.
- **Inbound (user → assistant):** file-upload control + multipart/base64 in the POST body
  (`chat.js:477-482` is text-only today) + a user-image render path; the deepagents endpoint
  accepts image refs and feeds them to `ainvoke` (`api/image_handles.py` already models images
  on the ManyChat side — reuse the multimodal block builder).
- These two are independent vertical slices; ship outbound first (matches the stated primary
  goal of image parity with the ManyChat experience).

---

## 5. Slice 9 — Customer-auth tools (stay app-side)

Keep the OAuth dance + token store **in the app** (feasibility §5b): a headless AWS agent cannot
complete interactive PKCE consent, and `redirect_uri` is pinned in `shopify.app.toml`. Customer
PII tokens never cross to AWS.

- **Execution model:** deepagents requests a customer action → the app runs the JSON-RPC call
  with that conversation's token (`CustomerToken` keyed by `conversationId`, `db.server.js:78-135`)
  → returns the result to deepagents. So the app exposes a small "run customer MCP tool" endpoint
  that deepagents calls; deepagents owns *deciding* to call it, the app owns *executing* it.
- **Surface `auth_required` explicitly** instead of smuggling a markdown link through tool-result
  text (`tool.server.js:22-31`; area-E risk #4). Add an SSE `auth_required` event the widget
  handles directly (it already polls `/auth/token-status` every 10s, `chat.js:758-819`).
- **Known gaps to fix opportunistically:** `refreshToken` is never written (`db.server.js`;
  schema `:38`) → tokens expire to full re-auth; the `state = conversationId-shopId` split-on-`-`
  is fragile (`auth.server.js:22` / `auth.callback.jsx:10`); `conversation_id` is client-generated
  with no auth binding (feasibility §8) — bind it to a session in the new auth layer.

---

## 6. MCP endpoint/tool drift (verify before wiring)

- Code hardcodes the **legacy** `/api/mcp` + tool `search_shop_catalog` (`mcp-client.js:21`,
  `config.server.js:28`); current Shopify docs show `/api/ucp/mcp` + `search_catalog`. Run
  `tools/list` against the **actual target store** before wiring (feasibility §5 caveat).
- The `product_results` event is driven by the exact tool name `search_shop_catalog`
  (`tool.server.js:44`); if the name changes, product cards stop appearing — keep the mapping
  centralized.
- **Storefront catalog MCP moves into deepagents** (unauthenticated, server-to-server, needs only
  the trusted shop domain — feasibility §5a); **customer-account MCP stays app-side** (per-customer
  OAuth — §5b).

---

## 7. App-side decisions — RESOLVED (2026-06-02; mirror plan 0001 §8)

- **D-app1 — RESOLVED → ADR 0015.** deepagents sync response = the `ShopifySyncResponse` TypedDict
  `{ok, reply_text, products[], images[], links[], thread_id, auth_required: AuthRequired|None,
  runtime_session_id}` (`api/shopify_ingress.py`). `auth_required` is a **structured intent**
  (`{tool_name, tool_use_id, args, reason}`, H7 model B), never a bare bool; `null/absent` until
  slice 9. `runtime_session_id` is retained (the auth-resume continuation key). `thread_id` is the
  server-resolved checkpointer thread, echoed so the anonymous client re-anchors (H6).
- **D-app2 — RESOLVED.** `thread_id` source = client-generated `crypto.randomUUID()` persisted in
  **`localStorage`** (not `sessionStorage`, not a cookie — see §0b H6), sent as `conversation_id`;
  switch to the OAuth-`sub` actor_id (`{brand}:{account}:shopify:{customer}`, D1) once
  authenticated, starting a fresh thread (no merge).
- **D-app3:** Prisma history — recommend removing the `Message` thread (deepagents checkpointer is
  the single source of truth), keep the auth tables (`CustomerToken`/`CodeVerifier`/
  `CustomerAccountUrls`/`Session`). (Still app-side product call; not load-bearing for slice 3.)
- **D-app4 — RESOLVED ordering:** 3 (text round-trip) → 7 (links) → 8-outbound (images) → 9 (auth +
  continuation endpoint) → 8-inbound, matching feasibility §7.
- **Storefront route config (D2, deepagents-side, nothing app-side):** the storefront route runs
  thinking `off` with an explicit `max_tokens` set on its `RouteAgentOverrides`; Shopify creds are
  flat `SHOPIFY_*` `AppConfig` fields.
- **Env note:** dev is bare `shopify app dev`; `npm install` is required before first run
  (repo pins `prisma@^6.2.1`; bare `npx` pulls `prisma@7` → `P1012` on the `url` datasource).

---

## 8. Effort/risk summary

| Slice | App-side work | Risk | Depends on (deepagents) |
|---|---|---|---|
| 3 | replace `chat.jsx` loop with one sync call + SSE re-emit; new `deepagents.server.js`; persistence decision | Med | slice 1 (sync surface) + 5/6 (endpoint) |
| 7 | none (widget already renders links) | Low | URL-strip toggle for channel |
| 8 | upload UI + image render branch + SSE `image` event | Med | `ShopifyDeliverySurface.send_image` + endpoint image-in |
| 9 | `auth_required` SSE event + "run customer tool" endpoint; opportunistic refreshToken/state fixes | Med-High | deepagents emits `auth_required` intent |
