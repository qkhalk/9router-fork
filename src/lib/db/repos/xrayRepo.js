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
    deletedAt: row.deletedAt ?? null,
    staleDeleteAfter: row.staleDeleteAfter ?? null,
  };
}

/**
 * List configs, optionally filtered. Filtering happens in SQL where cheap
 * (protocol, country, isActive); sorting is in JS so latency-aware sorts
 * (where null means "untested") behave sensibly.
 */
export async function getXrayConfigs(filter = {}) {
  const db = await getAdapter();
  const where = ["deletedAt IS NULL"]; // tombstoned rows are invisible unless explicitly requested
  const params = [];
  if (filter.protocol) { where.push("protocol = ?"); params.push(filter.protocol); }
  if (filter.country) { where.push("country = ?"); params.push(filter.country); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.healthyOnly) { where.push("lastLatencyMs > 0"); }
  if (filter.includeDeleted) { where.pop(); }
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

// Point lookups exclude tombstoned rows (typed NOT_FOUND via the existing
// null contract) so switchConfig/startXrayService/restartXrayService cannot
// operate on a deleted config — their existing !config handling 404s.
export async function getXrayConfigById(id) {
  const db = await getAdapter();
  return rowToConfig(db.get(`SELECT * FROM xrayConfigs WHERE id = ? AND deletedAt IS NULL`, [id]));
}

export async function getXrayConfigByLink(link) {
  const db = await getAdapter();
  return rowToConfig(db.get(`SELECT * FROM xrayConfigs WHERE link = ? AND deletedAt IS NULL`, [link]));
}

export async function getXrayConfigCounts() {
  const db = await getAdapter();
  const row = db.get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN isActive = 1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN isActive = 0 THEN 1 ELSE 0 END) AS inactive
    FROM xrayConfigs
    WHERE deletedAt IS NULL
  `);
  return {
    total: Number(row?.total) || 0,
    active: Number(row?.active) || 0,
    inactive: Number(row?.inactive) || 0,
  };
}

/** Distinct countries/protocols present in the catalog — for UI filters. */
export async function getXrayFacets(filter = {}) {
  const db = await getAdapter();
  const where = ["deletedAt IS NULL"];
  const params = [];
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  const prefix = where.length ? ` WHERE ${where.join(" AND ")} AND` : " WHERE";
  const countries = db
    .all(`SELECT DISTINCT country FROM xrayConfigs${prefix} country IS NOT NULL AND country != '' ORDER BY country`, params)
    .map((r) => r.country);
  const protocols = db
    .all(`SELECT DISTINCT protocol FROM xrayConfigs${prefix} protocol IS NOT NULL AND protocol != '' ORDER BY protocol`, params)
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
       isActive=1, staleDeleteAfter=NULL, updatedAt=excluded.updatedAt`,
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
           isActive=1, staleDeleteAfter=NULL, updatedAt=excluded.updatedAt`,
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

// ─── delete semantics (multi-subscription) ────────────────────────────────
//
// User-intent delete = TOMBSTONE (soft). A tombstoned row is invisible to
// every read path, is never resurrected by a sync upsert, and is never fed
// to the retention sweeper — it persists until an explicit restore or
// hard-delete. Only the model-filter auto-prune uses hardDeleteXrayConfig
// (auto-prune must never permanently ban configs with no restore path).

export async function tombstoneXrayConfig(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const res = db.run(
    `UPDATE xrayConfigs SET deletedAt = ?, isActive = 0, isSelected = 0, updatedAt = ?
     WHERE id = ? AND deletedAt IS NULL`,
    [now, now, id]
  );
  return (res?.changes || 0) > 0;
}

/** Repurposed (was physical delete): user delete now tombstones. */
export async function deleteXrayConfig(id) {
  return tombstoneXrayConfig(id);
}

export async function restoreXrayConfig(id) {
  const db = await getAdapter();
  // A restored config has a membership only if a future sync re-sees it;
  // until then it is active-but-unmembered and EXEMPT from the sweeper
  // (sweeping requires staleDeleteAfter set, which restore clears). It
  // persists until re-adopted by a subscription or deleted again — nothing
  // is silently lost.
  const res = db.run(
    `UPDATE xrayConfigs SET deletedAt = NULL, staleDeleteAfter = NULL, isActive = 1, updatedAt = ?
     WHERE id = ? AND deletedAt IS NOT NULL`,
    [new Date().toISOString(), id]
  );
  return (res?.changes || 0) > 0;
}

/** Physical delete: removes the config row and its membership rows atomically. */
export async function hardDeleteXrayConfig(id) {
  const db = await getAdapter();
  let removed = false;
  db.transaction(() => {
    const res = db.run(`DELETE FROM xrayConfigs WHERE id = ?`, [id]);
    if ((res?.changes || 0) > 0) {
      removed = true;
      db.run(`DELETE FROM xrayConfigSubscriptions WHERE configId = ?`, [id]);
    }
  });
  return removed;
}

// ─── membership lifecycle (per-subscription sync primitives) ──────────────

/**
 * Record that `subscriptionId` currently carries `keepIds`. Resets
 * staleDeleteAfter for every remembered id (RT-2 re-adoption invariant: a
 * config dropped by sub A and re-added by sub B must never be swept on A's
 * schedule).
 */
export async function upsertMemberships(subscriptionId, keepIds = [], seenAtIso) {
  if (!keepIds.length) return 0;
  const db = await getAdapter();
  const now = seenAtIso || new Date().toISOString();
  let count = 0;
  db.transaction(() => {
    // SQLite parameter limit is generous (999+); chunk defensively for big catalogs.
    const CHUNK = 250; // 3 params per row
    for (let i = 0; i < keepIds.length; i += CHUNK) {
      const slice = keepIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      db.run(
        `INSERT INTO xrayConfigSubscriptions(configId, subscriptionId, lastSeenAt)
         VALUES ${slice.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT(configId, subscriptionId) DO UPDATE SET lastSeenAt = excluded.lastSeenAt`,
        slice.flatMap((id) => [id, subscriptionId, now])
      );
      db.run(`UPDATE xrayConfigs SET staleDeleteAfter = NULL WHERE id IN (${placeholders})`, slice);
      count += slice.length;
    }
  });
  return count;
}

/**
 * Drop memberships of `subscriptionId` for configs NOT in keepIds.
 * Returns the configIds that lost their membership with this sub.
 */
export async function removeMissingMemberships(subscriptionId, keepIds = []) {
  const db = await getAdapter();
  const current = db
    .all(`SELECT configId FROM xrayConfigSubscriptions WHERE subscriptionId = ?`, [subscriptionId])
    .map((r) => r.configId);
  const keep = new Set(keepIds);
  const lost = current.filter((id) => !keep.has(id));
  if (!lost.length) return [];
  const CHUNK = 500;
  for (let i = 0; i < lost.length; i += CHUNK) {
    const slice = lost.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    db.run(
      `DELETE FROM xrayConfigSubscriptions WHERE subscriptionId = ? AND configId IN (${placeholders})`,
      [subscriptionId, ...slice]
    );
  }
  return lost;
}

/** Catalog ids (non-tombstoned) that no subscription currently carries. */
export async function getConfigIdsWithNoMembership() {
  const db = await getAdapter();
  return db
    .all(
      `SELECT x.id FROM xrayConfigs x
       WHERE x.deletedAt IS NULL
         AND NOT EXISTS (SELECT 1 FROM xrayConfigSubscriptions m WHERE m.configId = x.id)`
    )
    .map((r) => r.id);
}

/** Tombstoned config ids (the sync flow must skip/never resurrect these). */
export async function getTombstonedConfigIds() {
  const db = await getAdapter();
  return db.all(`SELECT id FROM xrayConfigs WHERE deletedAt IS NOT NULL`).map((r) => r.id);
}

/** How many configs a subscription currently carries (X2/shrink-guard input). */
export async function countSubMemberships(subscriptionId) {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) AS c FROM xrayConfigSubscriptions WHERE subscriptionId = ?`, [subscriptionId]);
  return Number(row?.c) || 0;
}

/** Config ids a subscription currently carries (sub-DELETE orphan detection). */
export async function getSubMemberConfigIds(subscriptionId) {
  const db = await getAdapter();
  return db
    .all(`SELECT configId FROM xrayConfigSubscriptions WHERE subscriptionId = ?`, [subscriptionId])
    .map((r) => r.configId);
}

/**
 * Source-sub names per config (server-table badges). One grouped query; the
 * configs list path already loads the full table.
 */
export async function getConfigSubscriptionNames() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT m.configId AS configId, s.name AS name
     FROM xrayConfigSubscriptions m
     JOIN xraySubscriptions s ON s.id = m.subscriptionId
     ORDER BY s.id ASC`
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.configId)) map.set(r.configId, []);
    map.get(r.configId).push(r.name);
  }
  return map;
}

/**
 * Deactivate configs that just lost their last membership. deleteAfterIso is
 * the retention horizon for the sweeper (now+retention, now for retention 0,
 * or NULL to keep forever). Tombstoned rows are never touched.
 */
export async function deactivateXrayConfigs(ids = [], deleteAfterIso = null) {
  if (!ids.length) return 0;
  const db = await getAdapter();
  const now = new Date().toISOString();
  let changes = 0;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const res = db.run(
      `UPDATE xrayConfigs SET isActive = 0, staleDeleteAfter = ?, updatedAt = ?
       WHERE id IN (${placeholders}) AND deletedAt IS NULL`,
      [deleteAfterIso, now, ...slice]
    );
    changes += res?.changes || 0;
  }
  return changes;
}

/**
 * Retention sweeper. Deletes ONLY rows that: have a due staleDeleteAfter,
 * are inactive, are not tombstoned, and have zero memberships. The
 * membership guard means a scheduled row that later re-activates (or gains a
 * membership again) can never be swept even if the horizon already passed.
 * ISO timestamps compare lexicographically.
 */
export async function sweepStaleXrayConfigs(nowIso) {
  if (!nowIso) return 0;
  const db = await getAdapter();
  const res = db.run(
    `DELETE FROM xrayConfigs
     WHERE staleDeleteAfter IS NOT NULL AND staleDeleteAfter <= ?
       AND isActive = 0 AND deletedAt IS NULL
       AND NOT EXISTS (SELECT 1 FROM xrayConfigSubscriptions m WHERE m.configId = xrayConfigs.id)`,
    [nowIso]
  );
  return res?.changes || 0;
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
    // Guard: never (re)select a tombstoned config.
    if (id) db.run(`UPDATE xrayConfigs SET isSelected = 1, updatedAt = ? WHERE id = ? AND deletedAt IS NULL`, [now, id]);
  });
}

export async function getSelectedXrayConfig() {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM xrayConfigs WHERE isSelected = 1 AND deletedAt IS NULL LIMIT 1`);
  if (row) return rowToConfig(row);
  // No explicit selection (or it was tombstoned) — fall back to the
  // healthiest active config. Sort so tested configs (lastLatencyMs > 0)
  // come first, then by latency asc; untested (null) and failed (-1) configs
  // sink to the bottom.
  return rowToConfig(
    db.get(`SELECT * FROM xrayConfigs WHERE isActive = 1 AND deletedAt IS NULL
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
  db.run(`DELETE FROM xrayConfigSubscriptions`);
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
