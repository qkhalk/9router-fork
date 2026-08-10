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
  getXraySyncState,
  setXraySyncState,
} from "../db/repos/xrayRepo.js";
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

  return { count, sourceUrl };
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

/**
 * Start (or restart) the periodic sync scheduler. Safe to call multiple times;
 * the previous timer is cleared first. Uses .unref() so it never keeps the
 * process alive on its own.
 */
export async function startSyncScheduler(intervalMin) {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  const settings = await getSettings();
  const min = intervalMin || settings.xraySyncIntervalMin || 60;
  // Do an initial sync shortly after boot so the catalog isn't empty for an
  // hour on first run, then settle into the configured interval.
  setTimeout(() => {
    syncSubscription().catch((e) =>
      console.error("[XraySync] initial sync failed:", e.message)
    );
  }, 5000).unref();
  syncTimer = setInterval(() => {
    syncSubscription().catch((e) =>
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
}

export { getXraySyncState };
