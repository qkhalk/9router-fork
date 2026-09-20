import { dbg } from "../utils/debugLog.js";
import { gensparkSidecarFetch } from "../services/gensparkTlsSidecar.js";

/**
 * Live model catalog for Genspark Web, mirrored from the same endpoints the
 * genspark.ai AI Chat UI reads at runtime:
 *
 *   - https://www.genspark.ai/api/moa_models_config  → chat models (the AI
 *     Chat model selector, including the Mixture-of-Agents entry)
 *   - https://www.genspark.ai/api/models_config      → image/audio/video
 *     model selectors
 *
 * Both endpoints are public (no cookie required). The catalog refreshes in
 * the background (first lookup + every CATALOG_REFRESH_MS). Until the first
 * fetch resolves — and whenever a fetch fails — lookups fail open to the
 * static fallback sets below, so requests never depend on genspark.ai being
 * reachable from the router itself.
 *
 * Why live: genspark rotates its model lineup continuously (new releases
 * appear weekly, old ones get hidden). A hardcoded list ships stale ids that
 * the upstream rejects; the live catalog tracks the selector exactly.
 */
const MOA_MODELS_URL = "https://www.genspark.ai/api/moa_models_config";
const MEDIA_MODELS_URL = "https://www.genspark.ai/api/models_config";
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;

// Fallbacks only — used before the first successful sync and whenever a
// refresh fails. The live selector always wins once synced.
const FALLBACK_TEXT_MODELS = new Set([
  "gpt-5-pro", "gpt-5.1-low", "gpt-5.2", "gpt-5.2-pro", "o3-pro",
  "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-6", "claude-opus-4-5",
  "claude-4-5-haiku", "gemini-2.5-pro", "gemini-3-flash-preview",
  "gemini-3.1-pro-preview", "gemini-3-pro-preview", "grok-4-0709",
]);
const FALLBACK_IMAGE_MODELS = new Set([
  "nano-banana-pro", "nano-banana-2",
  "fal-ai/bytedance/seedream/v5/lite", "fal-ai/flux-2", "fal-ai/flux-2-pro",
  "fal-ai/z-image/turbo", "fal-ai/gpt-image-1.5", "recraft-v3", "ideogram/V_3",
  "qwen-image",
]);

let textModels = null;   // Set<string> of chat model ids (live)
let imageModels = null;  // Set<string> of image model ids (live)
let suggestedModels = null; // shaped [{id, name}] for the dashboard
let refreshTimer = null;
let inFlight = null;

function parseChatModels(json) {
  const models = json?.models;
  if (!Array.isArray(models)) throw new Error("moa_models_config missing models array");
  const ids = new Set();
  const suggestions = [];
  for (const m of models) {
    const id = typeof m?.name === "string" ? m.name.trim() : "";
    if (!id || m.hidden) continue;
    ids.add(id);
    suggestions.push({
      id,
      name: m.label || m.full_label || id,
      flagship: m.member_price_tier === "flagship" || undefined,
      vision: m.support_images === true || undefined,
    });
  }
  if (!ids.size) throw new Error("moa_models_config produced an empty model set");
  return { ids, suggestions };
}

function parseImageModels(json) {
  const models = json?.data?.image_models;
  if (!Array.isArray(models)) throw new Error("models_config missing data.image_models");
  const ids = new Set();
  for (const m of models) {
    const id = typeof m?.name === "string" ? m.name.trim() : "";
    // "auto" is a UI affordance (auto-select), not a requestable model id.
    if (id && id !== "auto") ids.add(id);
  }
  return ids;
}

// Read one public genspark endpoint through the TLS sidecar: genspark's
// Cloudflare edge challenges Node's fetch fingerprint (403), while the
// sidecar's curl_cffi Chrome impersonation passes. Returns parsed JSON.
async function sidecarGetJson(url) {
  const res = await gensparkSidecarFetch({
    cookies: {},
    payload: null,
    url,
    method: "GET",
    timeoutMs: CATALOG_TIMEOUT_MS + 5_000,
    log: { debug: (...a) => dbg("GENSPARK", ...a) },
  });
  const { body, exitHint } = res || {};
  if (typeof body?.getReader !== "function") {
    throw new Error(`sidecar ${url} unavailable: ${res?.error?.message || "no body"}${exitHint ? ` (exit: ${await exitHint})` : ""}`);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  if (!text.trim()) {
    throw new Error(`sidecar ${url} returned no body${exitHint ? ` (exit: ${exitHint})` : ""}`);
  }
  // The harness re-prefixes upstream lines with "data: " — strip and rejoin.
  const jsonText = text
    .split("\n")
    .map((l) => (l.startsWith("data: ") ? l.slice(6) : l))
    .join("")
    .trim();
  const json = JSON.parse(jsonText);
  return json;
}

async function fetchCatalog() {
  const chatJson = await sidecarGetJson(MOA_MODELS_URL);
  const chat = parseChatModels(chatJson);
  // The media config is best-effort: image classification falls back to the
  // static set when it is unreachable, without failing the chat catalog.
  let image = null;
  try {
    image = parseImageModels(await sidecarGetJson(MEDIA_MODELS_URL));
  } catch (e) {
    dbg("GENSPARK", `image catalog ignored (${e?.message || e}); keeping fallback set`);
  }
  textModels = chat.ids;
  suggestedModels = chat.suggestions;
  if (image) imageModels = image;
  dbg("GENSPARK", `catalog synced: ${chat.ids.size} chat, ${image ? image.size : imageModels ? imageModels.size : FALLBACK_IMAGE_MODELS.size} image models`);
}

function refreshCatalog() {
  inFlight = fetchCatalog().catch((e) => {
    dbg("GENSPARK", `catalog refresh failed (${e?.message || e}); keeping previous state`);
  });
  return inFlight;
}

// Idempotent: kicks off the first fetch on the first lookup and schedules
// periodic refreshes. The timer is unref'd so it never keeps the process
// alive on its own.
export function ensureGensparkCatalog() {
  if (!refreshTimer) {
    refreshCatalog();
    refreshTimer = setInterval(refreshCatalog, CATALOG_REFRESH_MS);
    refreshTimer.unref?.();
  }
  return inFlight;
}

/** Chat model ids from the live selector (fallback set before first sync). */
export function getGensparkTextModels() {
  ensureGensparkCatalog();
  return textModels || FALLBACK_TEXT_MODELS;
}

/** True when the id is an image-generation model (live set + fallback). */
export function isGensparkImageModel(modelId) {
  ensureGensparkCatalog();
  const id = String(modelId || "");
  return (imageModels || FALLBACK_IMAGE_MODELS).has(id) || FALLBACK_IMAGE_MODELS.has(id);
}

/** Dashboard suggestion list — live chat selector, hidden entries dropped. */
export function getGensparkSuggestedModels() {
  ensureGensparkCatalog();
  return suggestedModels || [];
}

/** Sync status for UI surfaces (synced:false = never fetched; fail-open). */
export function getGensparkCatalogSnapshot() {
  return { synced: textModels !== null };
}
