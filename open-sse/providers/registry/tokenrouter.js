export default {
  id: "tokenrouter",
  alias: "tokenrouter",
  aliases: ["tr"],
  uiAlias: "tokenrouter",
  display: {
    name: "TokenRouter",
    icon: "hub",
    color: "#0EA5E9",
    textIcon: "TR",
    website: "https://www.tokenrouter.com",
    notice: {
      text: "OpenAI-compatible gateway. 300+ models (OpenAI, Claude, Gemini, Qwen, DeepSeek, Kimi, GLM, dsb).",
      apiKeyUrl: "https://www.tokenrouter.com",
    },
  },
  category: "apikey",
  thinkingConfig: {
    options: ["low", "medium", "high", "xhigh", "max"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: "https://api.tokenrouter.com/v1/chat/completions",
    validateUrl: "https://api.tokenrouter.com/v1/models",
    thinkingFormat: "tokenrouter",
  },
  // Small example set only — the full catalogue (300+ models) is fetched live via
  // modelsFetcher and offered in "Suggested free models"; any provider-prefixed id
  // is accepted via passthroughModels. Keep this list short so it stays a hint,
  // not a hardcoded catalog.
  models: [
    { id: "deepseek/deepseek-v4-pro-0813-free", name: "Deepseek V4 Pro 0813 Free" },
    { id: "qwen/qwen3.8-max-free", name: "Qwen3.8 Max Free" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B A3B Reasoning:Free" },
    { id: "openai/gpt-5", name: "Gpt 5" },
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash" },

  ],
  features: { usage: true, usageApikey: true },
  serviceKinds: ["llm", "embedding", "image"],
  embeddingConfig: {
    baseUrl: "https://api.tokenrouter.com/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
  imageConfig: {
    baseUrl: "https://api.tokenrouter.com/v1/images/generations",
  },
  modelsFetcher: { url: "https://api.tokenrouter.com/api/pricing", type: "pricing" },
  passthroughModels: true,
};
