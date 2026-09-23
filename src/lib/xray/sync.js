/**
 * Multi-subscription sync service (v2rayN per-sub model).
 *
 * Each subscription row (xraySubscriptions) is an independent fetch source
 * with its own enable flag, interval, retention, and last-sync/traffic state.
 * Syncing sub X only rewrites membership/active state for configs that X
 * carries — a config shared with sub Y stays active when X drops it
 * (cross-sub isolation). A config with NO remaining membership is deactivated
 * and scheduled for deletion per the retention of the sub that lost it.
 *
 * The subscription is fetched with the regular (proxy-aware) fetch — this
 * uses the global outbound proxy if configured, but NEVER the local xray
 * SOCKS port, because xray itself may depend on the very subscription we
 * are downloading (chicken-and-egg). Fetching goes direct or via the
 * user's normal outbound proxy.
 */

import {
  getProtocol,
  extractEndpoint,
  decodeSubscriptionBase64,
} from "./parser.js";
// Re-export pure parse helpers (split into syncParse.js for unit-testability
// without the DB layer).
export { parseSubscription, parseConfigName, linkToConfigEntry } from "./syncParse.js";
import { parseSubscription, linkToConfigEntry } from "./syncParse.js";
import { parseSubscriptionUserinfo } from "./userinfo.js";
import {
  bulkUpsertXrayConfigs,
  upsertMemberships,
  removeMissingMemberships,
  getConfigIdsWithNoMembership,
  getTombstonedConfigIds,
  countSubMemberships,
  deactivateXrayConfigs,
  sweepStaleXrayConfigs,
  getXraySyncState,
  setXraySyncState,
} from "../db/repos/xrayRepo.js";
import {
  listXraySubscriptions,
  getXraySubscription,
  setXraySubscriptionSyncState,
  setXraySubscriptionUserinfo,
  resolveIntervalMin,
  resolveRetentionDays,
} from "../db/repos/subscriptionRepo.js";
import { pruneOrphanModelFilterResults } from "../db/repos/modelFilterResultsRepo.js";
import { getSettings } from "../db/repos/settingsRepo.js";

export const DEFAULT_V2GO_SUBSCRIPTION =
  "https://raw.githubusercontent.com/Danialsamadi/v2go/main/AllConfigsSub.txt";

// A hostile/misconfigured subscription URL must not balloon the Node
// process: response bodies are read through a size-capped stream. The env
// override exists for tests; production default is 50 MB.
const MAX_BODY_BYTES =
  Number(process.env.XRAY_SYNC_MAX_BODY_BYTES) > 0
    ? Number(process.env.XRAY_SYNC_MAX_BODY_BYTES)
    : 50 * 1024 * 1024;

// Per-sub single-flight (RT-13): a scheduled run, a manual Sync Now, and a
// DELETE-subscription all contend on this map — same-sub syncs queue instead
// of interleaving membership writes (last-writer-wins truncated fetches would
// corrupt the membership pipeline).
const inFlightSyncs = new Map();

/** Is a sync of this subscription currently running or queued? */
export function isSubscriptionSyncInFlight(subscriptionId) {
  return inFlightSyncs.has(subscriptionId);
}

function withSingleFlight(subscriptionId, fn) {
  const existing = inFlightSyncs.get(subscriptionId);
  // Swallow a rejected predecessor: a queued caller must run its own sync and
  // report its own outcome, not replay the previous run's DB-level error.
  const run = existing
    ? existing.catch(() => {}).then(() => fn())
    : Promise.resolve().then(fn);
  const tracked = run.finally
    ? run.finally(() => {
        if (inFlightSyncs.get(subscriptionId) === tracked) inFlightSyncs.delete(subscriptionId);
      })
    : run;
  inFlightSyncs.set(subscriptionId, tracked);
  return run;
}

/** Read the response body through a byte-capped stream (50 MB). */
async function readBodyCapped(res, cap = MAX_BODY_BYTES) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* stream already closed */ }
      throw new Error(`subscription body exceeds ${Math.round(cap / (1024 * 1024))} MB cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

// ─── per-subscription sync core ───────────────────────────────────────────

/**
 * Sync ONE subscription with replace-that-sub semantics (v2rayN):
 * upsert fetched links, add memberships, drop memberships absent from the
 * fetch, deactivate configs whose LAST membership just disappeared, then run
 * the guarded retention sweeper. Never touches other subs' memberships, and
 * never resurrects a tombstoned config.
 *
 * @returns per-sub result { subscriptionId, name, count, stalePruned?, error?, aborted? }
 */
export async function syncOneSubscription(sub, settings, filterSource = "sync") {
  return withSingleFlight(sub.id, async () => {
    const result = {
      subscriptionId: sub.id,
      name: sub.name,
      count: 0,
      stalePruned: 0,
    };

    let text;
    let userinfo = null;
    try {
      const res = await fetch(sub.url, {
        cache: "no-store",
        headers: { "User-Agent": "9router-xray-sync/1.0" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      // Traffic/expiry display (v2rayN convention): parse BEFORE anything can
      // abort, persist only after the pipeline succeeds below.
      userinfo = parseSubscriptionUserinfo(res.headers);
      text = await readBodyCapped(res);
    } catch (e) {
      const error = String(e.message || e);
      await setXraySubscriptionSyncState(sub.id, { lastSyncError: error });
      return { ...result, error };
    }

    const links = parseSubscription(text);
    const entries = [];
    const fetchedIds = [];
    for (const link of links) {
      const entry = linkToConfigEntry(link);
      if (!entry) continue;
      entries.push(entry);
      fetchedIds.push(entry.id);
    }

    // Per-sub fail-closed (X2): an HTTP 200 body with ZERO parseable links
    // must never wipe THIS sub's memberships — abort only this sub.
    const currentMemberships = await countSubMemberships(sub.id);
    if (entries.length === 0 && currentMemberships > 0) {
      const reason = "empty-parse";
      const msg = `subscription returned 0 parseable links over HTTP 200 — keeping ${currentMemberships} existing config(s) (fail-closed)`;
      console.error(`[XraySync] sub #${sub.id} (${sub.name}): ${msg}`);
      await setXraySubscriptionSyncState(sub.id, { lastSyncError: msg });
      return { ...result, count: currentMemberships, error: msg, aborted: reason };
    }

    // Shrink guard (RT-13): a partial cache / captive portal serving a
    // handful of links would otherwise mass-deactivate (and with retention 0
    // mass-DELETE). Abort when the fetch keeps < 50% of a sizable membership.
    if (
      entries.length > 0 &&
      currentMemberships >= 10 &&
      fetchedIds.length < currentMemberships / 2
    ) {
      const msg = `shrink-guard: only ${fetchedIds.length}/${currentMemberships} links kept — aborting sync`;
      console.error(`[XraySync] sub #${sub.id} (${sub.name}): ${msg}`);
      await setXraySubscriptionSyncState(sub.id, { lastSyncError: msg });
      return { ...result, count: currentMemberships, error: msg, aborted: "shrink-guard" };
    }

    // Tombstoned rows are user-intent deletes: skip them entirely — no
    // upsert, no membership, no deactivation, no sweep (RT-10).
    const tombstoned = new Set(await getTombstonedConfigIds());
    const keepIds = fetchedIds.filter((id) => !tombstoned.has(id));
    const keepEntries = entries.filter((e) => !tombstoned.has(e.id));

    // Preserve isSelected state for configs that already exist.
    const selected = await getSelectedBeforeSync(keepIds);

    await bulkUpsertXrayConfigs(keepEntries);
    await upsertMemberships(sub.id, keepIds, new Date().toISOString());
    const lost = await removeMissingMemberships(sub.id, keepIds);

    // Configs that lost their LAST membership with this sub get deactivated
    // and scheduled per this sub's retention (-1 forever, 0 now, N days).
    const stillUnmembered = new Set(await getConfigIdsWithNoMembership());
    const zeroMember = lost.filter((id) => stillUnmembered.has(id));
    if (zeroMember.length) {
      const retentionDays = resolveRetentionDays(sub, settings.xrayStaleRetentionDays);
      const deleteAfter =
        retentionDays < 0
          ? null
          : new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
      await deactivateXrayConfigs(zeroMember, deleteAfter);
    }

    // Guarded sweeper: only inactive + non-tombstoned + membership-free rows
    // past their horizon are physically deleted.
    result.stalePruned = await sweepStaleXrayConfigs(new Date().toISOString());

    // Drop cached model-filter results for configs that are no longer active
    // (dropped from the subscription or aged out). Keeps the cache in lockstep
    // with the catalog so the "skip if cached" path never trusts a dead row.
    await pruneOrphanModelFilterResults().catch(() => {});

    // Re-apply selection if the previously-selected config is still present.
    if (selected) {
      const { setSelectedXrayConfig } = await import("@/lib/db/repos/xrayRepo.js");
      await setSelectedXrayConfig(selected);
    }

    result.count = keepIds.length;
    await setXraySubscriptionSyncState(sub.id, { lastSyncCount: result.count, lastSyncError: null });

    // Persist traffic/expiry only when the server actually sent the header
    // (no header → keep last known values; UI shows N/A when absent).
    if (userinfo) {
      await setXraySubscriptionUserinfo(sub.id, userinfo);
    }

    return result;
  });
}

// ─── orchestrator ─────────────────────────────────────────────────────────

/**
 * Sync one subscription (opts.subscriptionId — manual sync works on disabled
 * subs) or all enabled subscriptions sequentially. Per-sub failures are
 * recorded on the sub row and surfaced in results[] — they never stop the
 * remaining subs.
 *
 * @returns {{ count, results: [{subscriptionId, name, count, error?, aborted?}], stalePruned, autoFilter }}
 */
export async function syncSubscription(opts = {}) {
  const settings = await getSettings();
  const filterSource = opts.filterSource || "sync";

  if (opts.subscriptionId != null) {
    const sub = await getXraySubscription(opts.subscriptionId);
    if (!sub) {
      return {
        count: 0,
        stalePruned: 0,
        results: [],
        error: `subscription ${opts.subscriptionId} not found`,
        unknownSubscriptionId: opts.subscriptionId,
      };
    }
    const r = await syncOneSubscription(sub, settings, filterSource);
    const autoFilter = await maybeRunModelFilterAfterSync(filterSource);
    await writeAggregateState([r]);
    return {
      count: r.error ? 0 : r.count,
      stalePruned: r.stalePruned || 0,
      autoFilter,
      results: [r],
      error: r.error,
    };
  }

  const subs = await listXraySubscriptions({ enabled: true });
  const results = [];
  for (const sub of subs) {
    try {
      results.push(await syncOneSubscription(sub, settings, filterSource));
    } catch (e) {
      // Engine-level crash on one sub must not kill the whole run.
      results.push({ subscriptionId: sub.id, name: sub.name, count: 0, error: String(e.message || e) });
    }
  }
  const autoFilter = await maybeRunModelFilterAfterSync(filterSource);
  await writeAggregateState(results);

  return {
    count: results.reduce((n, r) => n + (r.error ? 0 : r.count), 0),
    stalePruned: results.reduce((n, r) => n + (r.stalePruned || 0), 0),
    autoFilter,
    results,
  };
}

/** Sub-agnostic aggregate for the global xraySyncState singleton. */
async function writeAggregateState(results) {
  const ok = results.filter((r) => !r.error);
  await setXraySyncState({
    lastSyncAt: new Date().toISOString(),
    lastSyncCount: ok.reduce((n, r) => n + r.count, 0),
    lastSyncError: results.find((r) => r.error)?.error ?? null,
    incrementRuns: true,
  });
}

async function maybeRunModelFilterAfterSync(source = "sync") {
  try {
    const settings = await getSettings();
    if (settings.xrayModelFilterEnabled !== true) return { queued: false, reason: "disabled" };
    import("./manager.js")
      .then(({ runModelFilterFromSettings }) => runModelFilterFromSettings(source))
      .then((result) => {
        if (result?.skipped) {
          console.log(`[XrayFilter] skipped after sync: ${result.reason || "unknown"}`);
          return;
        }
        console.log(`[XrayFilter] done after sync: ${result.passed}/${result.tested} usable${result.pruned ? `, pruned=${result.pruned}` : ""}`);
      })
      .catch((error) => console.error("[XrayFilter] auto filter failed:", error.message));
    return {
      queued: true,
      model: settings.xrayModelFilterModel,
      all: settings.xrayModelFilterAll === true,
      limit: settings.xrayModelFilterAll === true ? "all" : settings.xrayModelFilterLimit,
      prune: settings.xrayModelFilterPrune === true,
    };
  } catch (error) {
    return { queued: false, error: error.message };
  }
}

// Look up the currently-selected config id; return it only if it survives the sync.
async function getSelectedBeforeSync(keepIds) {
  const { getSelectedXrayConfig } = await import("@/lib/db/repos/xrayRepo.js");
  try {
    const sel = await getSelectedXrayConfig();
    if (sel && keepIds.includes(sel.id)) return sel.id;
  } catch {
    // ignore — no selection yet
  }
  return null;
}

// ─── scheduler (next-run across enabled subs) ─────────────────────────────

let nextTimer = null;
let bootTimer = null;

// Any single timer is capped at 24h with a re-check loop on wake; the
// interval itself is clamped to ≤14 days by resolveIntervalMin. Both caps
// exist because Node's setTimeout clamps delays > 2^31-1 ms (~24.8 d) to
// 1 ms — an unclamped long interval would become a sync storm (RT-11).
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 5000;

function clearTimers() {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

/** Fetch posture per sub with resolved interval. Never-synced subs are due now. */
async function computeNextDue() {
  const settings = await getSettings();
  const subs = await listXraySubscriptions({ enabled: true });
  let best = null;
  for (const sub of subs) {
    const interval = resolveIntervalMin(sub, settings.xraySyncIntervalMin);
    if (interval <= 0) continue; // manual-only
    const last = sub.lastSyncAt ? Date.parse(sub.lastSyncAt) : NaN;
    const dueAt = Number.isFinite(last) ? last + interval * 60 * 1000 : Date.now();
    if (!best || dueAt < best.dueAt) best = { sub, dueAt, interval };
  }
  return best;
}

/**
 * Arm the timer for the earliest-due enabled subscription. When NO enabled
 * sub has a positive interval (all manual / never, or zero subs) this clears
 * timers and returns — setTimeout(fn, undefined) fires in ~1ms and would
 * spin DB queries (RT-11 empty-set rule).
 */
export async function scheduleNext() {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }
  const next = await computeNextDue();
  if (!next) {
    console.log("[XraySync] scheduler idle: no enabled subscription with an auto interval");
    return null;
  }
  const delay = Math.max(0, Math.min(MAX_TIMER_MS, next.dueAt - Date.now()));
  nextTimer = setTimeout(() => {
    nextTimer = null;
    fireDueSyncs().catch((e) => console.error("[XraySync] scheduled run failed:", e.message));
  }, delay);
  if (nextTimer.unref) nextTimer.unref();
  return { subscriptionId: next.sub.id, dueAt: new Date(next.dueAt).toISOString(), intervalMin: next.interval };
}

/** Sync every enabled sub whose interval has elapsed, then re-arm. */
async function fireDueSyncs() {
  const settings = await getSettings();
  const subs = await listXraySubscriptions({ enabled: true });
  const due = subs.filter((sub) => {
    const interval = resolveIntervalMin(sub, settings.xraySyncIntervalMin);
    if (interval <= 0) return false;
    if (!sub.lastSyncAt) return true; // never synced
    return Date.now() - Date.parse(sub.lastSyncAt) >= interval * 60 * 1000;
  });
  const results = [];
  for (const sub of due) {
    try {
      results.push(await syncOneSubscription(sub, settings, "scheduled-sync"));
    } catch (e) {
      results.push({ subscriptionId: sub.id, name: sub.name, count: 0, error: String(e.message || e) });
    }
  }
  // finally: a DB hiccup in aggregate/filter writes must never leave the
  // scheduler disarmed — the next run would never fire until reboot.
  try {
    if (results.length) {
      await writeAggregateState(results);
      await maybeRunModelFilterAfterSync("scheduled-sync");
    }
  } finally {
    await scheduleNext().catch((e) => console.error("[XraySync] scheduler re-arm failed:", e.message));
  }
}

/**
 * Start (or restart) the next-run scheduler across subscriptions. Idempotent
 * — safe to call repeatedly (boot, after each sync, after subscription CRUD);
 * previous timers are always cleared first. All timers are .unref()ed so they
 * never keep the process alive on their own.
 */
export async function startSyncScheduler() {
  clearTimers();
  // Boot timer: shortly after (re)start, sync whichever subs are due so a
  // fresh install gets its first sync and recently-synced subs don't
  // re-fetch.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    fireDueSyncs().catch((e) => console.error("[XraySync] initial sync failed:", e.message));
  }, BOOT_DELAY_MS);
  if (bootTimer.unref) bootTimer.unref();
  return scheduleNext();
}

export function stopSyncScheduler() {
  clearTimers();
}

export { getXraySyncState };
