export default {
  id: "orcarouter",
  alias: "orcarouter",
  aliases: ["orca"],
  uiAlias: "orcarouter",
  display: {
    name: "OrcaRouter",
    icon: "hub",
    color: "#0EA5E9",
    textIcon: "OR",
    website: "https://orcarouter.ai",
    notice: {
      text: "OpenAI-compatible gateway. 40+ providers (OpenAI, Claude, Gemini, DeepSeek, Grok, Qwen, Kimi, GLM...). Rate limits are per workspace — account rotation only helps keys from different workspaces.",
      apiKeyUrl: "https://orcarouter.ai",
    },
  },
  category: "apikey",
  // Seed snapshot from the live public /v1/models catalog (top headers only). The
  // full catalogue is fetched via modelsFetcher; any provider-prefixed id is still
  // accepted via passthroughModels.
  models: [
    { id: "openai/gpt-4o-mini", name: "GPT 4O Mini" },
    { id: "openai/gpt-5", name: "GPT 5" },
    { id: "openai/gpt-5-pro/2025-10-06", name: "GPT 5 Pro (2025-10-06)" },
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner" },
    { id: "grok/grok-4.6", name: "Grok 4.6" },
    { id: "qwen/qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "kimi/kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "minimax/minimax-m3", name: "MiniMax M3" },
    { id: "z-ai/glm-5", name: "GLM 5" },
  ],
  transport: {
    baseUrl: "https://api.orcarouter.ai/v1/chat/completions",
    validateUrl: "https://api.orcarouter.ai/v1/models",
  },
  modelsFetcher: { url: "https://api.orcarouter.ai/v1/models", type: "openai" },
  passthroughModels: true,
  serviceKinds: ["llm"],
};