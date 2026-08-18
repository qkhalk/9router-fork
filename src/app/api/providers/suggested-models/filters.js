// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // Generic OpenAI-compatible models endpoint ({data:[{id,...}]}). Used by
  // aggregate api-key gateways (orcarouter, ds2api, venice, tokenrouter,
  // perplexity-agent, vercel-ai-gateway) — the route already fetched + parsed
  // the JSON, so this only shapes the array.
  openai: (models) =>
    (Array.isArray(models) ? models : [])
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .filter((m) => m.id),

  // NewAPI pricing endpoint ({data:[{model_name, model_ratio, ...}]}). Keeps only
  // free models (model_ratio === 0). Used by tokenrouter + totu-ai (modelsFetcher
  // type "pricing") — the route already fetched + parsed the JSON.
  pricing: (models) => {
    const list = Array.isArray(models) ? models : Array.isArray(models?.data) ? models.data : [];
    return list
      .filter((m) => Number(m.model_ratio) === 0)
      .map((m) => ({ id: m.model_name || m.id, name: m.model_name || m.id }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  },
};
