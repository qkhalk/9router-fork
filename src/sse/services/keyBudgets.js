/**
 * Per-API-key budget enforcement (phase 08). Windows are server-local time
 * (daily = local midnight, monthly = 1st local midnight — documented, no tz
 * UI v1). Spend is read FRESH from usageHistory at enforcement (never cached
 * — LiteLLM #27735). The soft alert is edge-triggered per window (LiteLLM
 * #16185): a Map keyed by key-fingerprint + window-key fires once per
 * crossing and re-arms automatically when the window rolls over.
 *
 * Scope caveat: enforcement lives in the chat handler's requireApiKey branch,
 * so budgets are inert unless "Require API key" is enabled (UI documents it).
 */

import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";
import { getSpendForKey } from "@/lib/db/repos/usageRepo.js";
import { maskApiKey } from "@/lib/db/repos/apiKeysRepo.js";
import * as log from "../utils/logger.js";

// fingerprint → { windowKey, alerted } — survives HMR via global (Map idiom).
const g = (global.__keyBudgetAlerts ??= { alerted: new Map() });

function localMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Start of the current budget window (server-local). */
export function startOfWindow(window, now = new Date()) {
  if (window === "monthly") return new Date(now.getFullYear(), now.getMonth(), 1);
  return localMidnight(now);
}

/** End of the current budget window = start of the next one. */
export function windowEndDate(window, now = new Date()) {
  if (window === "monthly") return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const next = localMidnight(now);
  next.setDate(next.getDate() + 1);
  return next;
}

/** Stable key for the current window ("2026-09-05" / "2026-09"). */
export function windowKey(window, now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  if (window === "monthly") return `${y}-${m}`;
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(4).replace(/\.?0+$/, "") || "0"}`;
}

function fmtWindowEnd(end) {
  const totalMin = Math.max(1, Math.ceil((end.getTime() - Date.now()) / 60_000));
  if (totalMin < 90) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function maybeEmitThresholdAlert(apiKey, keyRow, wk, ctx) {
  const fp = maskApiKey(apiKey);
  const mapKey = `${fp}|${wk}`;
  const state = g.alerted.get(mapKey);
  if (state?.alerted) return; // edge-triggered: once per window per key
  g.alerted.set(mapKey, { windowKey: wk, alerted: true });
  // Opportunistic pruning: drop stale entries from other (older) windows.
  if (g.alerted.size > 500) {
    for (const [k, v] of g.alerted) {
      if (k.endsWith(`|${wk}`)) continue;
      if (v.windowKey !== wk) g.alerted.delete(k);
    }
  }
  const label = keyRow?.name ? `${keyRow.name} (${fp})` : fp;
  const spendStr = ctx.type === "usd" ? fmtUsd(ctx.used) : `${ctx.used.toLocaleString()} tokens`;
  const limitStr = ctx.type === "usd" ? fmtUsd(ctx.limit) : `${ctx.limit.toLocaleString()} tokens`;
  try {
    emitAlert(EVENT_TYPES.BUDGET_THRESHOLD, {
      severity: SEVERITY.WARN,
      dedupKey: mapKey,
      title: "API-key budget threshold reached",
      body: `Key ${label} used ${spendStr} of ${limitStr} (${Math.round(ctx.pct * 100)}%, ${ctx.window} window) — resets in ${fmtWindowEnd(ctx.windowEnd)}.`,
    });
  } catch { /* alerts must never break the request path */ }
}

/**
 * Budget gate for one request. Returns null when the request may proceed,
 * or a 429 Response when the key is hard-blocked at its limit.
 * Unbudgeted keys short-circuit before any spend query (hot-path guard).
 */
export async function checkKeyBudget(apiKey, keyRow) {
  if (!apiKey || !keyRow) return null;
  const type = keyRow.budgetType;
  if (type !== "usd" && type !== "tokens") return null;
  const limit = Number(keyRow.budgetLimit) || 0;
  if (limit <= 0) return null;

  const window = keyRow.budgetWindow === "monthly" ? "monthly" : "daily";
  const now = new Date();
  const since = startOfWindow(window, now);
  const end = windowEndDate(window, now);
  const wk = windowKey(window, now);

  let spend;
  try {
    spend = await getSpendForKey(apiKey, since);
  } catch (e) {
    // Budget enforcement must never take the request path down — fail open
    // and log; the next request re-reads.
    log.warn("BUDGET", `spend read failed for ${maskApiKey(apiKey)}: ${e?.message || e}`);
    return null;
  }
  const used = type === "usd" ? spend.usd : spend.tokens;
  const pct = used / limit;

  const thresholdPct = (Number(keyRow.softThresholdPct) > 0 ? Math.min(100, Number(keyRow.softThresholdPct)) : 80) / 100;
  if (pct >= thresholdPct) {
    maybeEmitThresholdAlert(apiKey, keyRow, wk, { used, limit, pct, type, window, windowEnd: end });
  }

  const hardBlock = keyRow.hardBlock === 1 || keyRow.hardBlock === true;
  if (hardBlock && used >= limit) {
    const spendStr = type === "usd" ? fmtUsd(used) : `${used.toLocaleString()} tokens`;
    const limitStr = type === "usd" ? fmtUsd(limit) : `${limit.toLocaleString()} tokens`;
    const retryAfterSec = Math.max(1, Math.ceil((end.getTime() - Date.now()) / 1000));
    log.warn("BUDGET", `BLOCK ${maskApiKey(apiKey)} ${spendStr} >= ${limitStr} (${window}) — 429, retry after ${retryAfterSec}s`);
    return new Response(
      JSON.stringify({
        error: {
          message: `API key budget exceeded: ${spendStr} of ${limitStr} (${window} window). Resets at ${end.toISOString()}.`,
          type: "rate_limit_error",
          code: "api_key_budget_exceeded",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSec),
          "X-9Router-Budget": "limit-exceeded",
        },
      }
    );
  }
  return null;
}

/** Test hook: forget alert edges (windows re-arm naturally by key change). */
export function __resetKeyBudgetsForTests() {
  g.alerted.clear();
}
