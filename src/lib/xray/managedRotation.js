/**
 * Managed-pool outbound rotation on rotatable errors (429 / rate-limit / 5xx).
 *
 * The `v2go-xray-managed` proxy pool is a single-URL pool: its proxyUrl is
 * `socks5://127.0.0.1:<socksPort>`, and the SOCKS port is backed by exactly
 * one running xray instance with exactly one outbound server. Changing the
 * outbound requires rewriting config.json and restarting xray — see
 * `switchConfig()` in manager.js. Unlike proxy *group* pools, the standard
 * connection-proxy resolution path does not set `connectionProxyEntryId`, so
 * the group-entry rotation in src/sse/handlers/chat.js never fires for this
 * pool, and every request through it reuses the same egress IP.
 *
 * That becomes a problem when the active IP gets rate-limited (e.g. opencode
 * `FreeUsageLimitError` 429): the chat loop retries with the same IP and loops
 * on 429 until the account is burned. This module is the missing rotation
 * path for the managed pool: on a rotatable error, switch the active xray
 * outbound to the next config known-healthy for that model.
 *
 * Safety constraints baked in here (switchConfig has no internal lock):
 *   - Single-flight: at most one rotation in flight; concurrent triggers are
 *     coalesced into the running promise.
 *   - Cooldown: do not rotate again within ROTATION_COOLDOWN_MS of the last
 *     switch, to avoid thrashing under a burst of 429s.
 *   - Adaptive bypass: if errors keep coming from the config we JUST rotated
 *     to (the new IP is also bad), the cooldown is bypassed so we rotate
 *     again immediately instead of pinning the user on a known-bad IP.
 *     `recentlyTried` still prevents re-picking the same IP.
 *   - Fire-and-forget from the request loop: the caller does NOT await; the
 *     current request returns its 429 while the outbound is swapped in the
 *     background. The next request picks up the new IP. (A victim request that
 *     hits the SOCKS-port-down window is retried by the chat loop, not here.)
 *   - Never rotates to the same active config, and skips configs already
 *     tried within the current cooldown window.
 */

import fs from "node:fs";
import path from "node:path";
import { getSelectedXrayConfig } from "../db/repos/xrayRepo.js";
import { getNextHealthyConfigsForModel } from "../db/repos/modelFilterResultsRepo.js";

/**
 * The Model Filter cache keys results by the model string the job was run
 * with — typically the short alias form (`oc/...`, not the resolved provider
 * id `opencode/...`). The chat loop, however, passes `${provider}/${model}`
 * using the *resolved* provider id. Normalize before lookup: try the passed
 * form first, and if empty, swap the provider prefix to the alias. Returns
 * the candidates whichever form matched.
 */
async function findCandidatesForModel(model, activeId) {
  let cands = await getNextHealthyConfigsForModel(model, activeId, { limit: 5 });
  if (cands.length) return { candidates: cands, matchedModel: model };
  // Try swapping the provider prefix. opencode <-> oc, claude <-> anthropic, etc.
  const slash = model.indexOf("/");
  if (slash > 0) {
    const swapped = swapProviderPrefix(model.slice(0, slash)) + model.slice(slash);
    if (swapped !== model) {
      cands = await getNextHealthyConfigsForModel(swapped, activeId, { limit: 5 });
      if (cands.length) return { candidates: cands, matchedModel: swapped };
    }
  }
  return { candidates: [], matchedModel: model };
}

// Common alias <-> id swaps. Mirror PROVIDER_ID_TO_ALIAS / OAUTH_ALIASES in
// open-sse/config/providerModels.js without importing it (keeps this module
// free of open-sse deps).
function swapProviderPrefix(prefix) {
  const SWAPS = {
    opencode: "oc",
    oc: "opencode",
    anthropic: "claude",
    claude: "anthropic",
    gemini: "gmn",
    gmn: "gemini",
  };
  return SWAPS[prefix] || prefix;
}

// Avoid a static import of manager.js here to keep the dependency graph one-
// directional (manager.js does not import this module, but other request-path
// modules import manager.js). We lazy-load switchConfig + status at call time.
async function loadManager() {
  return import("./manager.js");
}

// Rotation events are rare and important — persist them to their own log file
// (independent of next-server stdout, which is often redirected to /dev/null
// in headless deploys). Append-only, best-effort.
const ROTATION_LOG_FILE =
  process.env.NINEROUTER_ROTATION_LOG ||
  path.join(process.env.HOME || "/tmp", ".9router", "logs", "managed-rotation.log");

function logRotation(level, message, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  });
  try {
    fs.mkdirSync(path.dirname(ROTATION_LOG_FILE), { recursive: true });
    fs.appendFileSync(ROTATION_LOG_FILE, line + "\n", { flag: "a" });
  } catch {
    /* logging must never break rotation */
  }
  // Also emit to console for foreground deploys that capture stdout.
  try {
    console.warn(`[Xray] ${message}`);
  } catch {
    /* noop */
  }
}

const ROTATION_COOLDOWN_MS = 8 * 1000;        // min gap between rotations
const RECENT_SWITCH_SKIP_MS = 5 * 60 * 1000;  // skip configs rotated-to recently
const MAX_RECENTLY_TRIED = 8;                  // cap the in-memory try history

let inflight = null;        // Promise<{rotated:boolean, reason:string}> | null
let lastRotateAt = 0;       // epoch ms of last successful rotation
let lastRotatedToConfigId = null; // the configId we most recently rotated TO
const recentlyTried = new Map(); // configId -> epoch ms it was rotated to

function nowMs() { return Date.now(); }

function pruneRecentlyTried() {
  const cutoff = nowMs() - RECENT_SWITCH_SKIP_MS;
  for (const [id, ts] of recentlyTried) {
    if (ts < cutoff) recentlyTried.delete(id);
  }
}

/**
 * Is a rotation currently allowed? False during cooldown or while one is
 * already running. Exposed for tests / status introspection.
 */
export function canRotate() {
  return !inflight && nowMs() - lastRotateAt >= ROTATION_COOLDOWN_MS;
}

/**
 * The in-flight rotation promise, or null when idle. Side-effect-free (unlike
 * triggerManagedRotationOnProxyError, which would START a rotation if idle).
 * Used by the request-retry path to await an ongoing switch before retrying.
 */
export function getInflightRotation() {
  return inflight;
}

/**
 * Read-only snapshot of rotation bookkeeping (cooldown remaining, last rotated
 * config, etc.) for observability and the retry path's heuristics.
 */
export function getRotationState() {
  const now = nowMs();
  return {
    inflight: !!inflight,
    lastRotateAt,
    lastRotatedToConfigId,
    cooldownRemainingMs: Math.max(0, ROTATION_COOLDOWN_MS - (now - lastRotateAt)),
    canRotate: canRotate(),
  };
}

/**
 * Wait for any in-flight rotation to settle (resolve/reject), up to maxWaitMs.
 * Resolves with the rotation result if it completed in time, else {timedOut:true}.
 * Never throws. Used by the chat-loop retry path so a victim request doesn't
 * fire into the SOCKS-port-down window of an ongoing switch.
 */
export async function waitForManagedRotationSettle({ maxWaitMs = 6000 } = {}) {
  const current = inflight;
  if (!current) return { idle: true };
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timedOut: true }), maxWaitMs);
    t.unref?.();
  });
  try {
    const result = await Promise.race([current, timeout]);
    return { settled: true, result };
  } catch (e) {
    return { settled: true, error: e?.message || String(e) };
  }
}

/**
 * Background rotation coroutine. Resolves to { rotated, reason }. Never throws
 * — all errors are swallowed and reported via the reason string so callers can
 * fire-and-forget.
 */
async function doRotate({ status, errorText, model }) {
  const startedAt = nowMs();
  logRotation("info", "managed-pool rotation triggered", { status, model, errorSnippet: (errorText || "").slice(0, 160) });

  // Identify the currently active outbound so we never rotate to itself.
  const active = await getSelectedXrayConfig().catch(() => null);
  const activeId = active?.id || null;

  if (!model) {
    logRotation("warn", "managed-pool rotation aborted: no model", { status });
    return { rotated: false, reason: "no-model" };
  }

  pruneRecentlyTried();
  const exclude = new Set([activeId, ...recentlyTried.keys()].filter(Boolean));

  // Pull a few healthy candidates (ordered by latency asc) so we can fall
  // through to the next one if switchConfig rejects the first. The lookup
  // tolerates alias/id prefix differences between the chat path and the
  // filter cache (e.g. "opencode/x" vs "oc/x").
  const { candidates, matchedModel } = await findCandidatesForModel(model, activeId);
  logRotation("info", "managed-pool rotation candidates", {
    activeId,
    requestedModel: model,
    matchedModel,
    excludeCount: exclude.size,
    candidateCount: candidates.length,
    candidates: candidates.map((c) => ({ id: c.configId, name: c.name, latencyMs: c.latencyMs })),
  });

  if (!candidates.length) {
    logRotation("warn", "managed-pool rotation aborted: no healthy candidate", { model, activeId });
    // Enter cooldown so we don't spam the (empty) filter cache on every 429.
    lastRotateAt = nowMs();
    return { rotated: false, reason: "no-healthy-candidate" };
  }

  const manager = await loadManager();
  const { switchConfig } = manager;

  for (const cand of candidates) {
    if (exclude.has(cand.configId)) continue;
    try {
      logRotation("info", "managed-pool rotation attempting switchConfig", { toConfigId: cand.configId, name: cand.name });
      await switchConfig(cand.configId);
      // Success: record + update bookkeeping.
      recentlyTried.set(cand.configId, nowMs());
      // Keep the set bounded.
      while (recentlyTried.size > MAX_RECENTLY_TRIED) {
        const oldest = [...recentlyTried.entries()].sort((a, b) => a[1] - b[1])[0];
        if (!oldest) break;
        recentlyTried.delete(oldest[0]);
      }
      lastRotateAt = nowMs();
      lastRotatedToConfigId = cand.configId;
      logRotation("info", "managed-pool rotated on proxy error", {
        status,
        model,
        from: active?.name || activeId || "?",
        to: cand.name || cand.configId,
        toConfigId: cand.configId,
        tookMs: nowMs() - startedAt,
        errorSnippet: (errorText || "").slice(0, 120),
      });
      return { rotated: true, reason: `rotated-to:${cand.configId}`, toConfigId: cand.configId };
    } catch (e) {
      // This candidate failed to switch (e.g. its link is bad). Try the next.
      logRotation("warn", "managed-pool rotation candidate failed", { toConfigId: cand.configId, error: e?.message || String(e) });
      recentlyTried.set(cand.configId, nowMs());
    }
  }
  logRotation("warn", "managed-pool rotation exhausted all candidates", { triedCount: candidates.length });
  // All candidates failed to switch — enter cooldown to avoid hot-spinning.
  lastRotateAt = nowMs();
  return { rotated: false, reason: "all-candidates-failed" };
}

/**
 * Public entry point. Fire-and-forget by design: returns a promise that the
 * caller may ignore (or `.catch(() => {})`). Concurrent calls during an
 * in-flight rotation or inside the cooldown window are coalesced/no-ops.
 *
 * ADAPTIVE COOLDOWN: the base cooldown (ROTATION_COOLDOWN_MS) is bypassed when
 * the error is coming from the SAME config we most recently rotated TO — i.e.
 * the new IP is *also* bad, so rotating again immediately is the right move
 * (not waiting out the full window). This is what keeps a burst of 429s from
 * pinning the user on a known-bad freshly-rotated IP for the whole window.
 *
 * @param {{status?: number|string, error?: string, model?: string}} info
 * @returns {Promise<{rotated:boolean, reason:string}>}
 *   - When a rotation is already in flight, resolves to that same promise.
 *   - During cooldown, resolves immediately with {rotated:false, reason:"cooldown"}
 *     (or "cooldown-bypassed-then-rotated" if the adaptive rule fires).
 */
export async function triggerManagedRotationOnProxyError({ status, error, model } = {}) {
  if (inflight) {
    logRotation("debug", "managed-pool rotation skipped: already in flight", { status, model });
    return inflight;
  }
  if (nowMs() - lastRotateAt < ROTATION_COOLDOWN_MS) {
    // Adaptive bypass: if the CURRENT active config is the one we just rotated
    // to, the new IP is also erroring — don't make the user wait out cooldown,
    // rotate again immediately. recentlyTried prevents re-picking the same IP.
    if (await shouldBypassCooldown()) {
      logRotation("info", "managed-pool rotation cooldown bypassed (active == last rotated-to)", {
        status, model, sinceLastRotateMs: nowMs() - lastRotateAt, cooldownMs: ROTATION_COOLDOWN_MS,
      });
      // Fall through to start a new rotation below.
    } else {
      logRotation("debug", "managed-pool rotation skipped: cooldown", {
        status,
        model,
        sinceLastRotateMs: nowMs() - lastRotateAt,
        cooldownMs: ROTATION_COOLDOWN_MS,
      });
      return { rotated: false, reason: "cooldown" };
    }
  }
  inflight = doRotate({ status, errorText: typeof error === "string" ? error : "", model })
    .catch((e) => ({ rotated: false, reason: `exception:${e?.message || String(e)}` }))
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Adaptive-cooldown predicate. True when we are inside the cooldown window AND
 * the currently-active xray outbound is exactly the config we last rotated to.
 * In that case the freshly-rotated IP is itself erroring, so there's no point
 * holding back — allow another rotation (the candidate picker excludes both the
 * active config and recentlyTried, so we won't loop on the same bad IP).
 */
async function shouldBypassCooldown() {
  if (!lastRotatedToConfigId) return false;
  const active = await getSelectedXrayConfig().catch(() => null);
  return !!active && active.id === lastRotatedToConfigId;
}

/** Reset all in-memory state. Intended for tests. */
export function _resetManagedRotationState() {
  inflight = null;
  lastRotateAt = 0;
  lastRotatedToConfigId = null;
  recentlyTried.clear();
}
