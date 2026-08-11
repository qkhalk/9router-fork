/**
 * v2go subscription sync service.
 *
 * Fetches the working-configs subscription from raw.githubusercontent.com
 * (updated hourly by v2go's GitHub Actions), parses the share links,
 * extracts metadata, and upserts them into the xrayConfigs table.
 *
 * The subscription is fetched with the regular (proxy-aware) fetch — this
 * uses the global outbound proxy if configured, but NEVER the local xray
 * SOCKS port, because xray itself may depend on the very subscription we
 * are downloading (chicken-and-egg). Fetching goes direct or via the
 * user's normal outbound proxy.
 */

import { createHash } from "node:crypto";
import {
  getProtocol,
  extractEndpoint,
  decodeSubscriptionBase64,
} from "./parser.js";
// Re-export pure parse helpers (split into syncParse.js for unit-testability
// without the DB layer).
export { parseSubscription, parseConfigName, linkToConfigEntry } from "./syncParse.js";
import { parseSubscription, linkToConfigEntry } from "./syncParse.js";
import {
  bulkUpsertXrayConfigs,
  markStaleXrayConfigs,
  cleanupStaleXrayConfigs,
  getXraySyncState,
  setXraySyncState,
} from "../db/repos/xrayRepo.js";
import { pruneOrphanModelFilterResults } from "../db/repos/modelFilterResultsRepo.js";
import { getSettings } from "../db/repos/settingsRepo.js";

export const DEFAULT_V2GO_SUBSCRIPTION =
  "https://raw.githubusercontent.com/Danialsamadi/v2go/main/AllConfigsSub.txt";

// ─── sync ─────────────────────────────────────────────────────────────────

/**
 * Fetch and ingest the v2go subscription into the DB. Idempotent: re-running
 * with the same data updates `updatedAt` but does not duplicate rows.
 *
 * @param {{ sourceUrl?: string }} opts — override subscription URL
 * @returns {{ count: number, error?: string, sourceUrl: string }}
 */
export async function syncSubscription(opts = {}) {
  const settings = await getSettings();
  const sourceUrl = opts.sourceUrl || settings.xraySubscriptionUrl || DEFAULT_V2GO_SUBSCRIPTION;

  let text;
  try {
    const res = await fetch(sourceUrl, {
      cache: "no-store",
      headers: { "User-Agent": "9router-xray-sync/1.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    text = await res.text();
  } catch (e) {
    await setXraySyncState({
      sourceUrl,
      lastSyncAt: new Date().toISOString(),
      lastSyncError: String(e.message || e),
      incrementRuns: true,
    });
    return { count: 0, error: String(e.message || e), sourceUrl };
  }

  const links = parseSubscription(text);
  const entries = [];
  const keepIds = [];
  for (const link of links) {
    const entry = linkToConfigEntry(link);
    if (!entry) continue;
    entries.push(entry);
    keepIds.push(entry.id);
  }

  // Preserve isSelected state for configs that already exist.
  const selected = await getSelectedBeforeSync(keepIds);

  const count = await bulkUpsertXrayConfigs(entries);
  await markStaleXrayConfigs(keepIds);
  const stalePruned = await cleanupStaleXrayConfigs(settings.xrayStaleRetentionDays);
  // Drop cached model-filter results for configs that are no longer active
  // (dropped from the subscription or aged out). Keeps the cache in lockstep
  // with the catalog so the "skip if cached" path never trusts a dead row.
  await pruneOrphanModelFilterResults().catch(() => {});

  // Re-apply selection if the previously-selected config is still present.
  if (selected) {
    const { setSelectedXrayConfig } = await import("@/lib/db/repos/xrayRepo.js");
    await setSelectedXrayConfig(selected);
  }

  await setXraySyncState({
    sourceUrl,
    lastSyncAt: new Date().toISOString(),
    lastSyncCount: count,
    lastSyncError: null,
    incrementRuns: true,
  });

  const autoFilter = await maybeRunModelFilterAfterSync(opts.filterSource || "sync");
  return { count, sourceUrl, stalePruned, autoFilter };
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

// ─── scheduler ────────────────────────────────────────────────────────────

let syncTimer = null;
let initialTimer = null;

// Minimum interval the scheduler will actually run at. Anything strictly
// positive but below this is clamped up so users can't accidentally hammer an
// upstream subscription. 0 means "Never" (manual-only mode) and is honored
// as-is by NOT starting any timer.
const MIN_SYNC_INTERVAL_MIN = 5;

/**
 * Resolve the effective sync interval (in minutes) from an explicit override,
 * persisted settings, or the built-in default. Returns 0 for manual-only
 * mode. Strictly positive results are clamped to at least MIN_SYNC_INTERVAL_MIN.
 */
function resolveIntervalMin(explicit, settings) {
  let min = explicit;
  if (min == null || min === "" || Number.isNaN(Number(min))) {
    min = settings?.xraySyncIntervalMin;
  }
  min = Number(min);
  if (!Number.isFinite(min) || min <= 0) return 0; // Never / manual-only
  return Math.max(MIN_SYNC_INTERVAL_MIN, Math.floor(min));
}

/**
 * Start (or restart) the periodic sync scheduler. Safe to call multiple times;
 * the previous timer is cleared first. Uses .unref() so it never keeps the
 * process alive on its own.
 *
 * Pass an explicit `intervalMin` (in minutes) to override persisted settings,
 * or omit it to read `settings.xraySyncIntervalMin`. A value of 0 (or any
 * non-positive value) puts the scheduler into manual-only mode: no timer is
 * scheduled and syncs only happen via explicit `syncSubscription()` calls.
 */
export async function startSyncScheduler(intervalMin) {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  const settings = await getSettings();
  const min = resolveIntervalMin(intervalMin, settings);

  if (min <= 0) {
    console.log("[XraySync] scheduler stopped: manual-only mode (interval = 0)");
    return;
  }

  // Do an initial sync shortly after (re)start so the catalog isn't empty for
  // a full interval on first run, then settle into the configured interval.
  initialTimer = setTimeout(() => {
    initialTimer = null;
    syncSubscription({ filterSource: "initial-sync" }).catch((e) =>
      console.error("[XraySync] initial sync failed:", e.message)
    );
  }, 5000);
  if (initialTimer.unref) initialTimer.unref();

  syncTimer = setInterval(() => {
    syncSubscription({ filterSource: "scheduled-sync" }).catch((e) =>
      console.error("[XraySync] scheduled sync failed:", e.message)
    );
  }, min * 60 * 1000);
  if (syncTimer.unref) syncTimer.unref();
  console.log(`[XraySync] scheduler started: every ${min} min`);
}

export function stopSyncScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
}

export { getXraySyncState };
