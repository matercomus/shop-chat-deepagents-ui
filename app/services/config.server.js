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
  deepagents: {
    url: process.env.DEEPAGENTS_URL || 'http://localhost:8000',
    brand: process.env.DEEPAGENTS_BRAND || 'lux3three',
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
    agentUnavailable: "Sorry, I'm having trouble responding right now. Please try again in a moment."
  },

  // Tool Configuration
  tools: {
    productSearchName: "search_shop_catalog",
    maxProductsToDisplay: 3
  }
};

export default AppConfig;
