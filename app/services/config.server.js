/**
 * Configuration Service
 * Centralizes all configuration values for the chat service
 */

export const AppConfig = {
  // API Configuration
  api: {
    defaultModel: 'claude-sonnet-4-20250514',
    maxTokens: 2000,
    defaultPromptType: 'standardAssistant',
  },

  // DeepAgents sync endpoint (ADR 0015 / plan 0002 §1).
  // The agent runtime owns catalog search + the conversation thread; the app
  // server is a thin SSE adapter in front of `POST /shopify/agent/{brand}`.
  //
  // Environment-switched target (issue #8): in dev the URL points at the local
  // `main.py` Shopify endpoint (`http://localhost:8000`, no auth); in
  // prod/preview it points at the public bearer-authenticated cloud shim
  // (ADR 0017 — `ponhu_chat_agent` #309/#310) via `SHOPIFY_AGENT_SHIM_URL` +
  // `SHOPIFY_AGENT_SHIM_TOKEN`. The token is read **server-side only** (this is
  // a `*.server.js` module, never bundled to the client) and is attached as an
  // `Authorization: Bearer` header by `deepagents.server.js`. Both legs speak
  // the same wire contract (request ADR 0016, response ADR 0015), so no other
  // code changes between dev and cloud.
  deepagents: {
    url:
      process.env.SHOPIFY_AGENT_SHIM_URL ||
      process.env.DEEPAGENTS_URL ||
      'http://localhost:8000',
    brand: process.env.DEEPAGENTS_BRAND || 'lux3three',
    // Shared bearer secret for the cloud shim. Empty in dev (local main.py has
    // no auth) -> no Authorization header is sent. NEVER expose to the client.
    authToken: process.env.SHOPIFY_AGENT_SHIM_TOKEN || '',
    // Server-trusted shop domain. The deepagents endpoint is config-authoritative
    // on shop_domain, so when set this wins over the browser Origin (plan 0002 §1).
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || '',
  },

  // Error Message Templates
  errorMessages: {
    missingMessage: "Message is required",
    apiUnsupported: "This endpoint only supports server-sent events (SSE) requests or history requests.",
    authFailed: "Authentication failed with Claude API",
    apiKeyError: "Please check your API key in environment variables",
    rateLimitExceeded: "Rate limit exceeded",
    rateLimitDetails: "Please try again later",
    genericError: "Failed to get response from Claude",
    // Customer-facing apology delivered when the deepagents turn errors out.
    agentUnavailable: "Sorry, I'm having trouble responding right now. Please try again in a moment.",
    // Delivered on a gateway timeout (504). The turn may still have committed
    // server-side, so we ask the customer to re-send rather than auto-retrying
    // (ADR 0017 — a 504 is indeterminate; blind retry risks double-advancing the
    // thread).
    agentTimeout: "I'm still working on that one, sorry it's taking a moment. Could you send that again?"
  },

  // Tool Configuration
  tools: {
    productSearchName: "search_shop_catalog",
    maxProductsToDisplay: 3
  }
};

export default AppConfig;
