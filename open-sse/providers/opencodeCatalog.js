import { dbg } from "../utils/debugLog.js";

/**
 * Live catalog for OpenCode Free zen models, mirrored from the same source the
 * official CLI reads at runtime: https://models.opencode.ai/api.json. The zen
 * /v1/models endpoint exposes bare ids only, so which models are served by
 * /zen/v1/responses (per-model provider.npm "@ai-sdk/openai") and which are
 * deprecated (status:"deprecated" — e.g. deepseek-v4-flash-free, alive in the
 * list but broken upstream) can only be learned from api.json.
 *
 * The catalog refreshes in the background (first lookup + every
 * CATALOG_REFRESH_MS). Until the first fetch resolves — and whenever a fetch
 * fails — lookups fail open: the static registry keeps routing exactly as
 * before, so this only ever adds information.
 */
const CATALOG_URL = "https://models.opencode.ai/api.json";
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;

// null = never loaded → all lookups fall through to the static registry.
let responsesIds = null;
let deprecatedIds = null;
let refreshTimer = null;
let inFlight = null;

export function isResponsesServed(modelId) {
  return responsesIds?.has(modelId) === true;
}

export function isDeprecatedModel(modelId) {
  return deprecatedIds?.has(modelId) === true;
}

function parseCatalog(json) {
  const models = json?.opencode?.models;
  if (!models || typeof models !== "object") throw new Error("api.json missing opencode.models");
  const responses = new Set();
  const deprecated = new Set();
  for (const m of Object.values(models)) {
    if (typeof m?.id !== "string") continue;
    // @ai-sdk/openai targets the OpenAI Responses API; the provider default
    // (@ai-sdk/openai-compatible) stays on chat/completions.
    if (m.provider?.npm === "@ai-sdk/openai") responses.add(m.id);
    if (m.status === "deprecated") deprecated.add(m.id);
  }
  return { responses, deprecated };
}

async function fetchCatalog() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`api.json HTTP ${res.status}`);
    const parsed = parseCatalog(await res.json());
    responsesIds = parsed.responses;
    deprecatedIds = parsed.deprecated;
    dbg("OPENCODE", `catalog synced: ${parsed.responses.size} responses-only, ${parsed.deprecated.size} deprecated models`);
  } finally {
    clearTimeout(timer);
  }
}

function refreshCatalog() {
  // Fire-and-forget: a failed refresh keeps the last good cache (or the
  // initial null = registry-only fallback) and never surfaces as an
  // unhandled rejection.
  inFlight = fetchCatalog().catch((e) => {
    dbg("OPENCODE", `catalog refresh failed (${e?.message || e}); keeping previous state`);
  });
  return inFlight;
}

// Idempotent: kicks off the first fetch on the first routing lookup and
// schedules periodic refreshes. The timer is unref'd so it never keeps the
// process alive on its own.
export function ensureOpencodeCatalog() {
  if (!refreshTimer) {
    refreshCatalog();
    refreshTimer = setInterval(refreshCatalog, CATALOG_REFRESH_MS);
    refreshTimer.unref?.();
  }
  return inFlight;
}

// Test hook: reset cache + timer so each case starts from a clean slate.
export function __resetOpencodeCatalogForTests() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  inFlight = null;
  responsesIds = null;
  deprecatedIds = null;
}

// Test hook: force one refresh cycle without waiting for the interval.
export function __refreshOpencodeCatalogForTests() {
  return refreshCatalog();
}
