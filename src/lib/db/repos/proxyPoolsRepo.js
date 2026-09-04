import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  // Stable creation order (P7): updatedAt churn (cooldown stamps, lastUsedAt
  // bumps) must not reshuffle rotation candidates between picks.
  list.sort((a, b) =>
    (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)) ||
    String(a.id).localeCompare(String(b.id))
  );
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  // Proxy-group fields (additive; absent for legacy single-proxy pools).
  if (data.isGroup === true) {
    pool.isGroup = true;
    pool.rotationMode = data.rotationMode || "on-error";
    pool.entries = Array.isArray(data.entries) ? data.entries : [];
    pool.rrCounter = 0;
  }
  // proxyxoay.org rotating-provider pools: a group whose entries are synced
  // 1:1 with API keys by the proxyxoay manager. Persist the provider config +
  // runtime state (forwardPorts) so they survive restarts.
  if (data.type === "proxyxoay") {
    pool.isGroup = true;
    pool.rotationMode = data.rotationMode || "on-error";
    pool.entries = Array.isArray(data.entries) ? data.entries : [];
    pool.rrCounter = data.rrCounter || 0;
    pool.keys = Array.isArray(data.keys) ? data.keys : [];
    pool.liveMinutes = data.liveMinutes || 5;
    pool.protocol = data.protocol === "socks5" ? "socks5" : "http";
    pool.autoRotate = data.autoRotate !== false;
    pool.forwardEnabled = data.forwardEnabled === true;
    pool.forwardPorts = data.forwardPorts || {};
  }
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}

/**
 * Coerce a cooldownUntil value into epoch-ms (P12). Strings are parsed (ISO
 * dates from older clients/imports; bare digit strings treated as epoch-ms);
 * anything unparseable becomes null (no cooldown) with a warning.
 */
export function normalizeCooldownUntil(value) {
  if (value === null || value === undefined || value === "") return null;
  let ms;
  if (typeof value === "number") {
    ms = value;
  } else {
    const s = String(value).trim();
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms)) {
    console.warn(`[proxyPoolsRepo] unparseable cooldownUntil (${JSON.stringify(value)}); treating as no cooldown`);
    return null;
  }
  return ms;
}

/**
 * Read-modify-write over a group pool's `entries` inside ONE transaction, so
 * concurrent writers (per-request stamps, cooldowns, proxyxoay rotations) can
 * never persist a stale whole-entries snapshot over each other (P2/N2).
 *
 * @param {string} poolId
 * @param {(entries: Array) => Array} mutator - maps current entries to next
 *   entries; runs inside the transaction against a freshly-read pool.
 * @returns {object|null} the updated pool, or null if the pool isn't a group.
 */
export async function mutateProxyPoolEntries(poolId, mutator) {
  if (!poolId) return null;
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [poolId]);
    if (!row) return;
    const pool = rowToPool(row);
    if (!pool || pool.isGroup !== true || !Array.isArray(pool.entries)) return;
    const entries = mutator(pool.entries) || pool.entries;
    const merged = { ...pool, entries, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

/** Stamp lastUsedAt on one entry (delta-write; safe under concurrency). */
export async function stampProxyEntryUsed(poolId, entryId) {
  if (!poolId || !entryId) return null;
  const nowIso = new Date().toISOString();
  return mutateProxyPoolEntries(poolId, (entries) =>
    entries.map((e) => (e.id === entryId ? { ...e, lastUsedAt: nowIso } : e))
  );
}

/**
 * Put one entry on cooldown until an absolute epoch-ms (delta-write). Used by
 * the pool test route and proxyxoay's rotateKey cooldown-clear (P10).
 */
export async function setEntryCooldown(poolId, entryId, untilMs, errorText = null) {
  if (!poolId || !entryId) return null;
  const until = normalizeCooldownUntil(untilMs);
  if (until === null) return null;
  return mutateProxyPoolEntries(poolId, (entries) =>
    entries.map((e) =>
      e.id === entryId
        ? { ...e, cooldownUntil: until, lastError: (errorText || "").slice(0, 300) || null }
        : e
    )
  );
}

/** Persist a group pool's round-robin cursor (scalar field; tx-merged). */
export async function rotateGroupCursor(poolId, nextIndex) {
  if (!poolId) return null;
  return updateProxyPool(poolId, { rrCounter: nextIndex });
}

/**
 * Cool down a single entry within a proxy-group pool after a rotatable error.
 * Stamps cooldownUntil/lastError on the matching entry and persists the pool.
 * No-op (returns null) if the pool isn't a group or the entry id isn't found.
 *
 * @param {string} poolId
 * @param {string} entryId
 * @param {number} cooldownMs - how long to keep the entry out of rotation
 * @param {string} errorText - the upstream error that triggered the cooldown
 * @returns {object|null} the updated pool, or null if nothing changed
 */
export async function markProxyEntryCooldown(poolId, entryId, cooldownMs, errorText) {
  if (!poolId || !entryId) return null;
  return setEntryCooldown(poolId, entryId, Date.now() + (cooldownMs || 0), errorText);
}
