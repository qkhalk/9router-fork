/**
 * proxyxoay.org rotation + forwarding manager (singleton).
 *
 * A proxyxoay pool is a special "group" pool (`type:"proxyxoay"`, `isGroup:true`)
 * whose entries are 1:1 with the user's API keys. This manager keeps each
 * entry's `proxyUrl` fresh by polling the provider shortly before the current
 * proxy dies (`time_die`), so the existing group resolver
 * (`resolveConnectionProxyConfig`) and cooldown machinery work unchanged — a
 * connection bound to the pool simply rotates across the N live keys.
 *
 * Optionally (pool.forwardEnabled) it also runs a local proxy-chain forwarding
 * server per key on 127.0.0.1, so external tools can point at
 * `127.0.0.1:<port>` and ride the current rotating IP — mirroring the
 * proxy.exe.exe reference tool.
 *
 * Lifecycle:
 *   - `syncAllFromDb()` runs once at boot (via initProxyXoay + instrumentation),
 *     registering every active proxyxoay pool.
 *   - `registerPool/unregisterPool` are called from the proxy-pool API routes
 *     on create/update/delete.
 *
 * The manager is server-only (uses net/proxy-chain + the DB) and must never be
 * imported from client code.
 */

import net from "net";
import { getProxyPoolById, getProxyPools, updateProxyPool, mutateProxyPoolEntries } from "@/models";
import { fetchProxyXoay, ProxyXoayError } from "./proxyxoayClient.js";
// Namespace import: proxy-chain is a transpiled CJS module (sets __esModule but
// no `.default`), so a default import resolves to `undefined` under webpack —
// `import * as` reliably exposes `Server` / `anonymizeProxy` etc.
import * as ProxyChain from "proxy-chain";

const FORWARD_BASE = parseInt(process.env.PROXYXOAY_FORWARD_BASE || "10000", 10);
const FORWARD_HOST = "127.0.0.1"; // local only — never expose forwarding ports
const DIE_BUFFER_S = 30; // refresh this many seconds before the proxy dies
const MIN_DELAY_S = 30; // never schedule an auto-rotation sooner than this
const BACKOFF_S = 60; // after a fetch error, retry after this (capped by nextAllowed)

// registry: poolId -> { pool, keyTimers, forwardServers, currentUpstreams, rotating }
const registry = new Map();
let booted = false;

// --- helpers ---------------------------------------------------------------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function genId() {
  return `px_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find a free TCP port near `preferred` on 127.0.0.1 by probe-listening. Tries
 * preferred, preferred+1, … up to +200, then falls back to an OS-assigned port.
 */
function findFreePort(preferred) {
  return new Promise((resolve) => {
    let attempt = 0;
    const tryPort = (p) => {
      const tester = net.createServer();
      tester.once("error", () => {
        attempt += 1;
        if (attempt < 200) tryPort(p + 1);
        else resolve(0); // give up → let the OS pick
      });
      tester.once("listening", () => tester.close(() => resolve(p)));
      tester.listen(p, FORWARD_HOST);
    };
    tryPort(preferred);
  });
}

function clearKeyTimer(state, entryId) {
  const t = state.keyTimers.get(entryId);
  if (t) {
    clearTimeout(t);
    state.keyTimers.delete(entryId);
  }
}

function isFresh(entry) {
  const px = entry?._px;
  if (!px?.expiresAt) return false;
  return px.expiresAt > nowSec() + DIE_BUFFER_S;
}

/**
 * Compute the delay (ms) until the next auto-rotation for an entry, based on
 * the last fetch's `time_die` and the provider rate-limit (`next_allowed`).
 */
function nextDelayMs(entry, liveMinutes) {
  const px = entry?._px || {};
  const nextAllowed = px.nextAllowedAt || 0; // absolute epoch seconds
  const expiresAt = px.expiresAt || 0;
  const dieBased = expiresAt ? expiresAt - nowSec() - DIE_BUFFER_S : null;
  const liveBased = (liveMinutes || 5) * 60;
  let delay = dieBased != null ? Math.min(dieBased, liveBased) : liveBased;
  delay = Math.max(delay, MIN_DELAY_S);
  // never try sooner than the provider allows
  const allowedIn = nextAllowed - nowSec();
  if (allowedIn + 1 > delay) delay = allowedIn + 1;
  return Math.max(delay, MIN_DELAY_S) * 1000;
}

// --- entry sync ------------------------------------------------------------

/**
 * Make sure the pool's `entries[]` is 1:1 with `keys[]` (entry.id === key.id),
 * preserving existing entry state (proxyUrl, _px, cooldown) for keys that remain.
 * Returns the reconciled entries array (does NOT persist).
 */
function reconcileEntries(pool) {
  const keys = Array.isArray(pool.keys) ? pool.keys : [];
  const byId = new Map((pool.entries || []).map((e) => [e.id, e]));
  return keys.map((k) => {
    const existing = byId.get(k.id);
    if (existing) return existing;
    return {
      id: k.id,
      name: k.label || `proxyxoay ${k.apiKey.slice(-5)}`,
      type: pool.protocol === "socks5" ? "socks5" : "http",
      proxyUrl: "",
      isActive: true,
      cooldownUntil: null,
      lastError: null,
      lastUsedAt: null,
      _px: null,
    };
  });
}

// --- persistence -----------------------------------------------------------

/**
 * Patch a single entry in the pool and persist as a transactional delta-write
 * (read-modify-write inside one transaction — no stale whole-entries snapshot
 * can clobber a concurrent runtime cooldown; P2/N2). Best-effort (non-throwing).
 */
async function persistEntry(poolId, entryId, patch) {
  try {
    return await mutateProxyPoolEntries(poolId, (entries) =>
      entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e))
    );
  } catch (e) {
    console.warn(`[proxyxoay] persistEntry failed for ${poolId}/${entryId}:`, e?.message || e);
    return null;
  }
}

// --- core rotation ---------------------------------------------------------

/**
 * Fetch a fresh proxy for one key and update its entry + in-memory upstream.
 * Respects the provider rate-limit: returns early (without fetching) if called
 * too soon and `force` is false.
 *
 * @returns {Promise<{ok:boolean, retryIn?:number, reason?:string, info?:object}>}
 */
async function rotateKey(state, pool, entry, { force = false } = {}) {
  const keyObj = (pool.keys || []).find((k) => k.id === entry.id);
  if (!keyObj) return { ok: false, reason: "Key removed" };

  // Rate-limit gate (manual rotate without force).
  const nextAllowed = entry._px?.nextAllowedAt || 0;
  if (!force && nextAllowed && nextAllowed > nowSec()) {
    return { ok: false, retryIn: nextAllowed - nowSec(), reason: "rate_limited" };
  }
  if (state.rotating.has(entry.id)) {
    return { ok: false, reason: "already_rotating" };
  }
  state.rotating.add(entry.id);
  try {
    const info = await fetchProxyXoay({
      apiKey: keyObj.apiKey,
      liveMinutes: pool.liveMinutes,
      protocol: pool.protocol,
    });
    const ts = nowSec();
    const expiresAt = ts + (info.time_die > 0 ? info.time_die : (pool.liveMinutes || 5) * 60);
    const patch = {
      proxyUrl: info.canonicalUrl,
      isActive: true,
      lastError: null,
      // Clear any runtime cooldown so the fresh IP is immediately selectable (P10).
      cooldownUntil: null,
      _px: {
        proxyhttp: info.proxyhttp,
        proxysocks5: info.proxysocks5,
        nha_mang: info.nha_mang,
        vi_tri: info.vi_tri,
        exitIp: info.exitIp,
        timeDie: info.time_die,
        expiresAt,
        nextAllowedAt: info.next_allowed_at_timestamp || (ts + info.next_allowed_in_seconds),
        fetchedAt: info.fetchedAt,
      },
    };
    state.currentUpstreams.set(entry.id, info.canonicalUrl);
    const updated = await persistEntry(pool.id, entry.id, patch);
    // Keep the manager's snapshot in sync so the UI status endpoint sees fresh data.
    if (updated) {
      state.pool = updated;
    } else {
      // persist failed; still reflect upstream in-memory so forwarding keeps working
      state.pool = {
        ...state.pool,
        entries: (state.pool.entries || []).map((e) =>
          e.id === entry.id ? { ...e, ...patch } : e
        ),
      };
    }
    // Reset the forward server's upstream snapshot (prepareRequestFunction reads live).
    await refreshForwardUpstream(state, entry.id, info.canonicalUrl);
    return { ok: true, info: patch._px };
  } catch (e) {
    const msg = e instanceof ProxyXoayError ? e.message : String(e?.message || e);
    await persistEntry(pool.id, entry.id, { lastError: msg.slice(0, 300) });
    return { ok: false, reason: "fetch_error", error: msg };
  } finally {
    state.rotating.delete(entry.id);
  }
}

/** (Re)schedule the next auto-rotation tick for one key. */
function scheduleKeyNext(state, pool, entry) {
  if (!pool.autoRotate || entry.isActive === false) return;
  clearKeyTimer(state, entry.id);
  const delay = nextDelayMs(entry, pool.liveMinutes);
  const t = setTimeout(() => {
    runKeyTick(state, pool.id, entry.id).catch(() => {});
  }, delay);
  t.unref?.();
  state.keyTimers.set(entry.id, t);
}

async function runKeyTick(state, poolId, entryId) {
  // Re-read the pool in case config (keys/live/autoRotate) changed under us.
  const pool = await getProxyPoolById(poolId);
  if (!pool || pool.type !== "proxyxoay" || !pool.isActive) return;
  state.pool = pool;
  const entry = (pool.entries || []).find((e) => e.id === entryId);
  if (!entry) return;
  const res = await rotateKey(state, pool, entry, { force: true });
  if (!res.ok) {
    // Backoff: retry sooner rather than abandoning the key.
    const backoff = Math.min(BACKOFF_S, 60) * 1000;
    const t = setTimeout(() => runKeyTick(state, poolId, entryId).catch(() => {}), backoff);
    t.unref?.();
    state.keyTimers.set(entryId, t);
    return;
  }
  scheduleKeyNext(state, pool, { ...entry, _px: res.info });
}

// --- forwarding servers (B) -----------------------------------------------

async function refreshForwardUpstream(state, entryId, upstreamUrl) {
  // proxy-chain reads upstreamProxyUrl live from prepareRequestFunction, which
  // closes over state.currentUpstreams — so just keeping that map fresh is
  // enough. This hook exists for future pre-warm / logging.
  state.currentUpstreams.set(entryId, upstreamUrl);
}

async function startForwardServer(state, pool, entry) {
  if (!pool?.id || !entry?.id) return null;
  if (state.forwardServers.has(entry.id)) return state.forwardServers.get(entry.id);
  const preferred = FORWARD_BASE + Math.abs(hashCode(entry.id)) % 200;
  const port = await findFreePort(preferred);
  const upstreamGetter = () => state.currentUpstreams.get(entry.id) || null;
  const server = new ProxyChain.Server({
    port,
    host: FORWARD_HOST,
    verbose: false,
    prepareRequestFunction: () => {
      const upstream = upstreamGetter();
      if (!upstream) {
        // No proxy fetched yet — refuse until the first rotation lands.
        return { requestAuthentication: false, failMsg: "proxyxoay: no proxy yet" };
      }
      return { upstreamProxyUrl: upstream };
    },
  });
  try {
    await server.listen();
  } catch (e) {
    console.warn(`[proxyxoay] forward server failed to listen for ${entry.id}:`, e?.message || e);
    return null;
  }
  const actualPort = server.port;
  // P11: the pool row can vanish mid-registration (deleted while the port was
  // being probed/listened). Null-guard instead of crashing — if it's gone,
  // tear the just-started server back down and skip.
  const poolRow = await getProxyPoolById(pool.id).catch(() => null);
  if (!poolRow) {
    console.warn(`[proxyxoay] pool ${pool.id} vanished mid-registration; stopping forward server for ${entry.id}`);
    state.forwardServers.delete(entry.id);
    try { await server.close(true); } catch { /* ignore */ }
    return null;
  }
  state.forwardServers.set(entry.id, { server, port: actualPort });
  // Persist the port so the UI/API can show it.
  const forwardPorts = { ...poolRow.forwardPorts, [entry.id]: actualPort };
  await updateProxyPool(pool.id, { forwardPorts }).catch(() => {});
  return { server, port: actualPort };
}

async function stopForwardServer(state, entryId) {
  const entry = state.forwardServers.get(entryId);
  if (!entry) return;
  state.forwardServers.delete(entryId);
  // proxy-chain's close() can occasionally stall (e.g. lingering tunnels from
  // active clients); race it against a hard 3s cap so callers never hang.
  try {
    const closeP = (async () => {
      try {
        await entry.server.close(true);
      } catch {
        /* ignore */
      }
    })();
    await Promise.race([closeP, new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    /* ignore */
  }
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// --- public API ------------------------------------------------------------

/**
 * Register (or re-register) a proxyxoay pool: reconcile entries to keys, start
 * forwarding servers if enabled, do an initial fetch for stale/empty entries,
 * and arm the auto-rotation timers. Safe to call repeatedly (idempotent).
 */
export async function registerPool(pool) {
  if (!pool || pool.type !== "proxyxoay") return;
  // Tear down any previous state for this pool first.
  await unregisterPool(pool.id);

  const entries = reconcileEntries(pool);
  const persisted = await updateProxyPool(pool.id, { entries }).catch(async () => pool);
  const current = persisted && persisted.type === "proxyxoay" ? persisted : { ...pool, entries };

  const state = {
    pool: current,
    keyTimers: new Map(),
    forwardServers: new Map(),
    currentUpstreams: new Map(),
    rotating: new Set(),
  };
  registry.set(pool.id, state);

  // Seed in-memory upstreams from existing entries (so forwarding works pre-fetch).
  for (const e of current.entries || []) {
    if (e.proxyUrl) state.currentUpstreams.set(e.id, e.proxyUrl);
  }

  for (const entry of current.entries || []) {
    if (current.forwardEnabled) {
      await startForwardServer(state, current, entry);
    }
    if (current.isActive === false) continue;
    if (isFresh(entry)) {
      // Already has a live proxy — just arm the next tick.
      scheduleKeyNext(state, current, entry);
    } else {
      // Stale or empty — fetch now, then arm.
      const res = await rotateKey(state, current, entry, { force: true });
      if (res.ok) scheduleKeyNext(state, current, { ...entry, _px: res.info });
      else if (current.autoRotate) {
        // Retry shortly even if the first fetch failed.
        const t = setTimeout(() => runKeyTick(state, current.id, entry.id).catch(() => {}), BACKOFF_S * 1000);
        t.unref?.();
        state.keyTimers.set(entry.id, t);
      }
    }
  }
}

/** Stop all timers and forwarding servers for a pool and drop it from memory. */
export async function unregisterPool(poolId) {
  const state = registry.get(poolId);
  if (!state) return;
  for (const entryId of state.keyTimers.keys()) clearKeyTimer(state, entryId);
  for (const entryId of state.forwardServers.keys()) await stopForwardServer(state, entryId);
  registry.delete(poolId);
}

/**
 * Manually rotate one key (entryId provided) or all keys in a pool.
 * Honors the provider rate-limit per key unless `force` is true.
 */
export async function rotateNow(poolId, entryId = null, { force = false } = {}) {
  const state = registry.get(poolId);
  if (!state) return { ok: false, reason: "pool_not_registered" };
  const pool = await getProxyPoolById(poolId);
  if (!pool || pool.type !== "proxyxoay") return { ok: false, reason: "not_proxyxoay" };
  state.pool = pool;
  const targets = entryId
    ? (pool.entries || []).filter((e) => e.id === entryId)
    : pool.entries || [];
  const results = [];
  for (const entry of targets) {
    const res = await rotateKey(state, pool, entry, { force });
    results.push({ entryId: entry.id, ...res });
    if (res.ok) scheduleKeyNext(state, pool, { ...entry, _px: res.info });
  }
  const anyOk = results.some((r) => r.ok);
  return { ok: anyOk, results };
}

/** Enable/disable all forwarding servers for a pool. */
export async function setForwarding(poolId, enabled) {
  const state = registry.get(poolId);
  if (!state) return { ok: false, reason: "pool_not_registered" };
  const pool = await getProxyPoolById(poolId);
  if (!pool) return { ok: false, reason: "not_found" };
  state.pool = pool;
  if (enabled) {
    for (const entry of pool.entries || []) {
      await startForwardServer(state, pool, entry);
    }
  } else {
    for (const entryId of [...state.forwardServers.keys()]) {
      await stopForwardServer(state, entryId);
    }
  }
  return { ok: true, enabled };
}

/** Runtime snapshot for the dashboard (counts, per-key IP/info/ports/countdowns). */
export async function getStatus(poolId) {
  const state = registry.get(poolId);
  const pool = await getProxyPoolById(poolId);
  if (!pool || pool.type !== "proxyxoay") return null;
  const now = nowSec();
  const keys = (pool.entries || []).map((e) => {
    const px = e._px || {};
    return {
      entryId: e.id,
      label: e.name,
      isActive: e.isActive !== false,
      proxyUrl: e.proxyUrl || "",
      exitIp: px.exitIp || "",
      nha_mang: px.nha_mang || "",
      vi_tri: px.vi_tri || "",
      expiresIn: px.expiresAt ? Math.max(0, px.expiresAt - now) : null,
      nextAllowedIn: px.nextAllowedAt ? Math.max(0, px.nextAllowedAt - now) : null,
      fetchedAt: px.fetchedAt || null,
      lastError: e.lastError || "",
      forwardPort: pool.forwardPorts?.[e.id] || state?.forwardServers.get(e.id)?.port || null,
      forwardRunning: !!(state && state.forwardServers.has(e.id)),
    };
  });
  return {
    poolId,
    autoRotate: pool.autoRotate === true,
    forwardEnabled: pool.forwardEnabled === true,
    liveMinutes: pool.liveMinutes,
    protocol: pool.protocol,
    rotationMode: pool.rotationMode,
    keys,
  };
}

export function isRegistered(poolId) {
  return registry.has(poolId);
}

/**
 * Boot-time: register every active proxyxoay pool from the DB. Called once from
 * initProxyXoay (instrumentation). Guards against double-boot.
 */
export async function syncAllFromDb() {
  if (booted) return;
  booted = true;
  try {
    const pools = await getProxyPools({ isActive: 1 });
    const px = pools.filter((p) => p.type === "proxyxoay");
    for (const pool of px) {
      try {
        await registerPool(pool);
      } catch (e) {
        console.warn(`[proxyxoay] failed to register pool ${pool.id}:`, e?.message || e);
      }
    }
    if (px.length) {
      console.log(`[proxyxoay] registered ${px.length} pool(s) at boot`);
    }
  } catch (e) {
    console.warn("[proxyxoay] syncAllFromDb failed:", e?.message || e);
  }
}
