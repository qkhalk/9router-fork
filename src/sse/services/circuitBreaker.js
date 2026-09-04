/**
 * Per-account circuit breaker (phase 06) — connectionId-keyed state machine
 * layered ON TOP of the existing modelLock (modelLock internals untouched).
 *
 * States: closed → open (N failures in window) → half-open (after cooldown,
 * admits exactly ONE real request as a passive probe) → closed/re-opened with
 * exponential backoff (60s × 2 per consecutive open, capped at 10 min).
 *
 * In-memory only (same Map idiom as antigravityQuota): a restart forgets all
 * breakers and they re-learn within one failure window — accepted trade-off.
 * Public functions are synchronous and O(1): the hot path (checkBreaker) must
 * never await. Config comes from settings but is cached with a TTL so the gate
 * stays sync; under NODE_ENV=test the loader is skipped and defaults apply.
 */

import * as log from "../utils/logger.js";

const DEFAULT_CONFIG = {
  enabled: true,
  failureThreshold: 5,
  windowMs: 60_000,
  baseCooldownMs: 60_000,
};
const MAX_COOLDOWN_MS = 600_000;
const CONFIG_TTL_MS = 10_000;

let config = { ...DEFAULT_CONFIG };
let configLoadedAt = 0;
let configLoadInFlight = false;

// connectionId → {
//   state: "closed" | "open" | "half-open",
//   failures: number[]       (timestamps of recent failures, window-pruned),
//   openedAt: number,        (ms epoch of last open transition)
//   openUntil: number,       (ms epoch — cooldown deadline),
//   consecutiveOpens: number,(backoff exponent+1; reset on success),
//   probeInFlight: boolean,  (half-open single-probe guard),
//   provider: string | null, (display hint from call sites),
//   lastRecoveredAt: number | null
// }
const breakers = new Map();

function maybeRefreshConfig() {
  if (process.env.NODE_ENV === "test") return; // defaults only — no DB in tests
  const now = Date.now();
  if (configLoadInFlight || now - configLoadedAt < CONFIG_TTL_MS) return;
  configLoadInFlight = true;
  import("@/lib/localDb")
    .then(async (m) => {
      const s = await m.getSettings();
      config = {
        enabled: s.breakerEnabled !== false,
        failureThreshold: clamp(Number(s.breakerFailureThreshold) || DEFAULT_CONFIG.failureThreshold, 1, 50),
        windowMs: clamp((Number(s.breakerWindowSec) || DEFAULT_CONFIG.windowMs / 1000) * 1000, 10_000, 3_600_000),
        baseCooldownMs: clamp((Number(s.breakerBaseCooldownSec) || DEFAULT_CONFIG.baseCooldownMs / 1000) * 1000, 10_000, 3_600_000),
      };
      configLoadedAt = Date.now();
    })
    .catch(() => { /* keep last known config */ })
    .finally(() => { configLoadInFlight = false; });
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function ensureRecord(connectionId) {
  let b = breakers.get(connectionId);
  if (!b) {
    b = {
      state: "closed",
      failures: [],
      openedAt: 0,
      openUntil: 0,
      consecutiveOpens: 0,
      probeInFlight: false,
      provider: null,
      lastRecoveredAt: null,
    };
    breakers.set(connectionId, b);
  }
  return b;
}

function emitBreakerAlert(eventType, payload) {
  if (process.env.NODE_ENV === "test") return;
  import("@/lib/alerts")
    .then((m) => m.emitAlert(eventType, payload))
    .catch(() => { /* alerts must never break breaker transitions */ });
}

function openBreaker(b, now, connectionId) {
  b.state = "open";
  b.openedAt = now;
  b.consecutiveOpens += 1;
  b.failures = [];
  b.probeInFlight = false;
  b.openUntil = now + Math.min(
    config.baseCooldownMs * 2 ** (b.consecutiveOpens - 1),
    MAX_COOLDOWN_MS
  );
  const cooldownSec = Math.round((b.openUntil - now) / 1000);
  log.warn("BREAKER", `${connectionId.slice(0, 8)} OPEN after ${config.failureThreshold} failures (cooldown ${cooldownSec}s, streak ${b.consecutiveOpens})`);
  emitBreakerAlert("breaker-open", {
    severity: "warn",
    dedupKey: connectionId,
    title: "Account circuit breaker opened",
    body: `${b.provider || "Account"} ${connectionId.slice(0, 8)} opened after ${config.failureThreshold} failures in ${Math.round(config.windowMs / 1000)}s — cooldown ${cooldownSec}s.`,
  });
}

/**
 * Should this account be attempted right now? O(1), synchronous.
 * noauth credentials (connectionId undefined) are always allowed — keying a
 * breaker on undefined would make every public provider share one breaker.
 * @returns {{allowed: true, probe?: boolean} | {allowed: false, retryAfterMs: number}}
 */
export function checkBreaker(connectionId, providerHint = null) {
  if (!connectionId) return { allowed: true };
  maybeRefreshConfig();
  if (!config.enabled) return { allowed: true };
  const b = breakers.get(connectionId);
  if (!b) return { allowed: true };
  if (providerHint) b.provider = providerHint;
  const now = Date.now();
  if (b.state === "open") {
    if (now < b.openUntil) {
      return { allowed: false, retryAfterMs: b.openUntil - now };
    }
    // Cooldown elapsed → half-open. Admit exactly ONE request as a passive
    // probe; the flag is set synchronously before returning, so concurrent
    // callers in the same tick cannot all win the probe (phase-01 P8 lesson).
    b.state = "half-open";
    b.probeInFlight = true;
    return { allowed: true, probe: true };
  }
  if (b.state === "half-open") {
    if (b.probeInFlight) {
      // A probe is already running; its outcome will close or re-open the
      // breaker. Deny with a short floor — by then the state has resolved.
      return { allowed: false, retryAfterMs: Math.max(b.openUntil - now, 5_000) };
    }
    b.probeInFlight = true;
    return { allowed: true, probe: true };
  }
  return { allowed: true }; // closed
}

/**
 * Feed an account-level failure (markAccountUnavailable / shouldFallback path).
 * closed: appends to the sliding window; opens at N in-window failures.
 * half-open (probe failed): re-opens with the next backoff step.
 */
export function recordFailure(connectionId, providerHint = null) {
  if (!connectionId) return;
  maybeRefreshConfig();
  if (!config.enabled) return;
  const b = ensureRecord(connectionId);
  if (providerHint) b.provider = providerHint;
  const now = Date.now();
  if (b.state === "half-open") {
    openBreaker(b, now, connectionId);
    return;
  }
  if (b.state === "open") {
    // In-flight attempt from before the open transition — record the
    // timestamp but don't extend the cooldown (it's already open).
    b.failures = b.failures.filter((t) => now - t <= config.windowMs);
    b.failures.push(now);
    return;
  }
  b.failures = b.failures.filter((t) => now - t <= config.windowMs);
  b.failures.push(now);
  if (b.failures.length >= config.failureThreshold) {
    openBreaker(b, now, connectionId);
  }
}

/**
 * Feed a success (first forwarded byte — the N7 signal). Any state → closed,
 * backoff reset. Only creates observable state when recovering.
 */
export function recordSuccess(connectionId) {
  if (!connectionId) return;
  if (!config.enabled) return;
  const b = breakers.get(connectionId);
  if (!b) return; // healthy fast path — no record to update
  const wasOpen = b.state === "open" || b.state === "half-open";
  b.state = "closed";
  b.failures = [];
  b.probeInFlight = false;
  b.consecutiveOpens = 0;
  b.openedAt = 0;
  b.openUntil = 0;
  if (wasOpen) {
    b.lastRecoveredAt = Date.now();
    log.info("BREAKER", `${connectionId.slice(0, 8)} RECOVERED — closed`);
    emitBreakerAlert("breaker-recovered", {
      severity: "info",
      dedupKey: connectionId,
      title: "Account circuit breaker recovered",
      body: `${b.provider || "Account"} ${connectionId.slice(0, 8)} served a successful request — breaker closed.`,
    });
  }
}

/**
 * Snapshot for the dashboard panel. `failures` counts only in-window
 * timestamps; `remainingMs` is the cooldown left while open.
 */
export function getBreakerStates() {
  const now = Date.now();
  const states = [];
  for (const [connectionId, b] of breakers) {
    const inWindow = b.failures.filter((t) => now - t <= config.windowMs).length;
    states.push({
      connectionId,
      provider: b.provider,
      state: b.state,
      failures: b.state === "closed" ? inWindow : 0,
      consecutiveOpens: b.consecutiveOpens,
      openedAt: b.openedAt ? new Date(b.openedAt).toISOString() : null,
      openUntil: b.state === "open" ? new Date(b.openUntil).toISOString() : null,
      remainingMs: b.state === "open" ? Math.max(0, b.openUntil - now) : 0,
      probeInFlight: b.probeInFlight,
      lastRecoveredAt: b.lastRecoveredAt ? new Date(b.lastRecoveredAt).toISOString() : null,
    });
  }
  return states;
}

/** Manual reset (dashboard button): forget the account's breaker entirely. */
export function resetBreaker(connectionId) {
  return breakers.delete(connectionId);
}

/** Test hook: wipe all state and restore default config. */
export function __resetBreakersForTests() {
  breakers.clear();
  config = { ...DEFAULT_CONFIG };
  configLoadedAt = 0;
  configLoadInFlight = false;
}
