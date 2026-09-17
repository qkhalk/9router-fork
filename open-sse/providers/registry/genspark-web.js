/**
 * Genspark Web (cookie-based) — exposes https://www.genspark.ai Agent (AI Chat) backend
 * as an OpenAI-compatible chat completions endpoint.
 *
 * Auth: paste the FULL cookie jar exported from genspark.ai (F12 → Application → Cookies →
 * www.genspark.ai → Export). Genspark's edge requires `session_id`, `__cf_bm` (Cloudflare),
 * `c1`/`c2` and `gslogin` — a bare session id alone fails login/model usage. The pasted jar is
 * parsed and serialized by `open-sse/services/gensparkWebCookie.js`; a bare `session_id=...`
 * is still accepted for backward compatibility.
 *
 * Transport: this provider requires the Python TLS sidecar (`open-sse/services/gensparkTlsSidecar.py`
 * + `gensparkTlsSidecar.js` harness). Node's vanilla `fetch` is blocked by genspark's
 * Cloudflare edge (TLS/JA3 fingerprint), so the executor POSTs the body through a
 * `curl_cffi` (Chrome impersonation) subprocess instead. Endpoint:
 * POST https://www.genspark.ai/api/agent/ask_proxy, body type `ai_chat`. The response is a
 * stream of `data:` frames: project_start | agent_notification | message_start |
 * project_field | message_field | message_field_delta | message_result.
 *
 * Models are NOT hardcoded. The dashboard suggestion list is fed live from the
 * same endpoints the genspark.ai AI Chat selector reads (moa_models_config —
 * see providers/gensparkCatalog.js), so new genspark releases appear without a
 * code change. Model ids are forwarded verbatim as `ai_chat_model` (verified:
 * unreleased-in-any-list ids like glm-5p3 and the Mixture-of-Agents comma mix
 * are accepted upstream), and "-search" on any id enables web grounding.
 *
 * Image models are intentionally NOT suggested: genspark's current API has no
 * image generation flow (feeding an image id returns a plain text chat).
 * Requests for an image model id get an honest 400.
 *
 * Reference: github.com/SharpWizard/genspark-py (TLS bypass) + github.com/deanxv/genspark2api
 */
export default {
  id: "genspark-web",
  priority: 240,
  alias: "genspark-web",
  aliases: ["gs-web", "gspark", "genspark"],
  uiAlias: "gspark",
  display: {
    name: "Genspark Web (Subscription)",
    icon: "auto_awesome",
    color: "#FF6B35",
    textIcon: "GS",
    website: "https://www.genspark.ai",
  },
  category: "webCookie",
  authType: "cookie",
  hasProviderSpecificData: true,
  authHint: "Paste your full cookie export from genspark.ai (F12 → Application → Cookies → www.genspark.ai → Export). session_id, __cf_bm, c1/c2 and gslogin are all required — a bare session_id is not enough. The executor tunnels this through a bundled Python TLS sidecar (curl_cffi) so genspark's Cloudflare edge doesn't challenge it.",
  transport: {
    baseUrl: "https://www.genspark.ai/api/agent/ask_proxy",
    format: "genspark-web",
    authType: "cookie",
  },
  passthroughModels: true,
  // Live model discovery — the suggested-models route special-cases this type
  // and returns gensparkCatalog's merged snapshot of the genspark.ai selector.
  // No seeded `models` list on purpose: genspark rotates its lineup weekly and
  // a hardcoded list ships stale ids upstream rejects.
  modelsFetcher: { url: "https://www.genspark.ai/api/moa_models_config", type: "genspark-web" },
};