/**
 * Data-access layer for the v2go/xray proxy integration.
 *
 * Two concerns live here:
 *  - xrayConfigs: the catalog of synced V2Ray share links (one row per config)
 *  - xraySyncState: a single-row singleton tracking the last subscription sync
 *
 * Mirrors the rowToX / XToRow + upsert + transaction pattern used by the
 * other repos (see proxyPoolsRepo.js). Conforms to the db adapter API
 * (get/all/run/transaction) so it works across all four SQLite backends.
 */

import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

// ─── xrayConfigs ──────────────────────────────────────────────────────────

function rowToConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    link: row.link,
    name: row.name,
    protocol: row.protocol,
    country: row.country,
    host: row.host,
    port: row.port,
    isActive: row.isActive === 1 || row.isActive === true,
    lastLatencyMs: row.lastLatencyMs,
    lastTestedAt: row.lastTestedAt,
    lastExitIp: row.lastExitIp,
    isSelected: row.isSelected === 1 || row.isSelected === true,
    addedAt: row.addedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * List configs, optionally filtered. Filtering happens in SQL where cheap
 * (protocol, country, isActive); sorting is in JS so latency-aware sorts
 * (where null means "untested") behave sensibly.
 */
export async function getXrayConfigs(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.protocol) { where.push("protocol = ?"); params.push(filter.protocol); }
  if (filter.country) { where.push("country = ?"); params.push(filter.country); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.healthyOnly) { where.push("lastLatencyMs > 0"); }
  const sql = `SELECT * FROM xrayConfigs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToConfig);
  // Default sort: selected first, then by latency asc (untested/negative last).
  list.sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    const la = a.lastLatencyMs != null && a.lastLatencyMs > 0 ? a.lastLatencyMs : Infinity;
    const lb = b.lastLatencyMs != null && b.lastLatencyMs > 0 ? b.lastLatencyMs : Infinity;
    return la - lb;
  });
  return list;
}

export async function getXrayConfigById(id) {
  const db = await getAdapter();
  return rowToConfig(db.get(`SELECT * FROM xrayConfigs WHERE id = ?`, [id]));
}

export async function getXrayConfigByLink(link) {
  const db = await getAdapter();
  return rowToConfig(db.get(`SELECT * FROM xrayConfigs WHERE link = ?`, [link]));
}

/** Distinct countries/protocols present in the catalog — for UI filters. */
export async function getXrayFacets() {
  const db = await getAdapter();
  const countries = db
    .all(`SELECT DISTINCT country FROM xrayConfigs WHERE country IS NOT NULL AND country != '' ORDER BY country`)
    .map((r) => r.country);
  const protocols = db
    .all(`SELECT DISTINCT protocol FROM xrayConfigs WHERE protocol IS NOT NULL AND protocol != '' ORDER BY protocol`)
    .map((r) => r.protocol);
  return { countries, protocols };
}

/**
 * Upsert a single config. The id is a stable hash of the link (caller supplies),
 * so re-syncing the same link updates in place rather than duplicating.
 * Sets isActive=1 (present in latest sync); caller marks the rest stale.
 */
export async function upsertXrayConfig(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = data.id || uuidv4();
  const existing = db.get(`SELECT addedAt FROM xrayConfigs WHERE id = ?`, [id]);
  db.run(
    `INSERT INTO xrayConfigs(id, link, name, protocol, country, host, port,
        isActive, lastLatencyMs, lastTestedAt, lastExitIp, isSelected,
        addedAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       link=excluded.link, name=excluded.name, protocol=excluded.protocol,
       country=excluded.country, host=excluded.host, port=excluded.port,
       isActive=1, updatedAt=excluded.updatedAt`,
    [
      id, data.link, data.name, data.protocol, data.country, data.host, data.port,
      data.lastLatencyMs ?? null, data.lastTestedAt ?? null, data.lastExitIp ?? null,
      data.isSelected ? 1 : 0,
      existing?.addedAt || data.addedAt || now, now,
    ]
  );
  return getXrayConfigById(id);
}

/**
 * Bulk-upsert a set of configs in one transaction. Returns the count written.
 * Each entry must include at least { id, link }; other fields are optional.
 */
export async function bulkUpsertXrayConfigs(entries = []) {
  if (!entries.length) return 0;
  const db = await getAdapter();
  const now = new Date().toISOString();
  let count = 0;
  db.transaction(() => {
    for (const data of entries) {
      const id = data.id || uuidv4();
      const existing = db.get(`SELECT addedAt, lastLatencyMs, lastTestedAt, lastExitIp, isSelected FROM xrayConfigs WHERE id = ?`, [id]);
      db.run(
        `INSERT INTO xrayConfigs(id, link, name, protocol, country, host, port,
            isActive, lastLatencyMs, lastTestedAt, lastExitIp, isSelected,
            addedAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           link=excluded.link, name=excluded.name, protocol=excluded.protocol,
           country=excluded.country, host=excluded.host, port=excluded.port,
           isActive=1, updatedAt=excluded.updatedAt`,
        [
          id, data.link, data.name, data.protocol, data.country, data.host, data.port,
          existing?.lastLatencyMs ?? data.lastLatencyMs ?? null,
          existing?.lastTestedAt ?? data.lastTestedAt ?? null,
          existing?.lastExitIp ?? data.lastExitIp ?? null,
          existing?.isSelected ? 1 : (data.isSelected ? 1 : 0),
          existing?.addedAt || data.addedAt || now, now,
        ]
      );
      count++;
    }
  });
  return count;
}

/**
 * Mark configs whose id is NOT in keepIds as isActive=0 (stale — dropped from
 * the latest subscription). Does not delete; stale rows retain latency history.
 */
export async function markStaleXrayConfigs(keepIds = []) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  if (keepIds.length === 0) {
    db.run(`UPDATE xrayConfigs SET isActive = 0, updatedAt = ?`, [now]);
    return;
  }
  const keep = new Set(keepIds);
  const staleIds = db
    .all(`SELECT id FROM xrayConfigs`)
    .map((r) => r.id)
    .filter((id) => !keep.has(id));
  if (staleIds.length === 0) return;

  // SQLite parameter limit is generous (999+); chunk defensively for big catalogs.
  const CHUNK = 500;
  for (let i = 0; i < staleIds.length; i += CHUNK) {
    const slice = staleIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    db.run(
      `UPDATE xrayConfigs SET isActive = 0, updatedAt = ?
       WHERE id IN (${placeholders})`,
      [now, ...slice]
    );
  }
}

/** Permanently remove configs inactive longer than the given ISO timestamp. */
export async function deleteStaleXrayConfigs(beforeIso) {
  const db = await getAdapter();
  if (!beforeIso) return 0;
  const res = db.run(`DELETE FROM xrayConfigs WHERE isActive = 0 AND updatedAt < ?`, [beforeIso]);
  return res?.changes || 0;
}

export async function deleteXrayConfig(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM xrayConfigs WHERE id = ?`, [id]);
}

/**
 * Mark one config as the selected/active one (exclusive). Clears isSelected
 * on all others, sets it on the given id. Persists the user's choice across
 * restarts so the manager can resume the same server.
 */
export async function setSelectedXrayConfig(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(`UPDATE xrayConfigs SET isSelected = 0`);
    if (id) db.run(`UPDATE xrayConfigs SET isSelected = 1, updatedAt = ? WHERE id = ?`, [now, id]);
  });
}

export async function getSelectedXrayConfig() {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM xrayConfigs WHERE isSelected = 1 LIMIT 1`);
  if (row) return rowToConfig(row);
  // No explicit selection — fall back to the healthiest active config.
  // Sort so tested configs (lastLatencyMs > 0) come first, then by latency asc;
  // untested (null) and failed (-1) configs sink to the bottom.
  return rowToConfig(
    db.get(`SELECT * FROM xrayConfigs WHERE isActive = 1
            ORDER BY CASE WHEN lastLatencyMs IS NOT NULL AND lastLatencyMs > 0 THEN 0 ELSE 1 END,
                     lastLatencyMs ASC LIMIT 1`)
  );
}

/** Record a latency/exit-IP test result for one config. */
export async function updateXrayTestResult(id, { latencyMs, exitIp, ok }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `UPDATE xrayConfigs SET lastLatencyMs = ?, lastTestedAt = ?, lastExitIp = ?, updatedAt = ?
     WHERE id = ?`,
    [latencyMs ?? (ok === false ? -1 : null), now, exitIp ?? null, now, id]
  );
}

export async function clearXrayConfigs() {
  const db = await getAdapter();
  db.run(`DELETE FROM xrayConfigs`);
}

// ─── xraySyncState (singleton, id=1) ──────────────────────────────────────

export async function getXraySyncState() {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM xraySyncState WHERE id = 1`);
  if (!row) {
    return {
      sourceUrl: null,
      lastSyncAt: null,
      lastSyncCount: 0,
      lastSyncError: null,
      totalSyncRuns: 0,
    };
  }
  return {
    sourceUrl: row.sourceUrl,
    lastSyncAt: row.lastSyncAt,
    lastSyncCount: row.lastSyncCount,
    lastSyncError: row.lastSyncError,
    totalSyncRuns: row.totalSyncRuns || 0,
  };
}

export async function setXraySyncState(data = {}) {
  const db = await getAdapter();
  const current = db.get(`SELECT totalSyncRuns FROM xraySyncState WHERE id = 1`);
  const totalSyncRuns = (current?.totalSyncRuns || 0) + (data.incrementRuns ? 1 : 0);
  db.run(
    `INSERT INTO xraySyncState(id, sourceUrl, lastSyncAt, lastSyncCount, lastSyncError, totalSyncRuns)
     VALUES(1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       sourceUrl = COALESCE(excluded.sourceUrl, sourceUrl),
       lastSyncAt = COALESCE(excluded.lastSyncAt, lastSyncAt),
       lastSyncCount = COALESCE(excluded.lastSyncCount, lastSyncCount),
       lastSyncError = excluded.lastSyncError,
       totalSyncRuns = excluded.totalSyncRuns`,
    [
      data.sourceUrl ?? null,
      data.lastSyncAt ?? null,
      data.lastSyncCount ?? null,
      data.lastSyncError ?? null,
      totalSyncRuns,
    ]
  );
  return getXraySyncState();
}
