/**
 * Proxy-pool rotation logic.
 *
 * A proxy pool can be a "group" (pool.isGroup === true): it holds an ordered
 * list of `entries`, each pointing to a proxy URL or a "direct" (no-proxy /
 * server-IP) slot. On each request the resolver picks one entry according to
 * the group's `rotationMode`:
 *
 *   - "on-error":   least-recently-used (spreads load, avoids the entry that
 *                   just failed). This is the default and the primary mode for
 *                   dodging per-IP rate limits — a 429 on one entry cools it
 *                   down and the next pick naturally skips it.
 *   - "round-robin": cycle through entries in order (advances every request).
 *   - "random":     uniform random per request.
 *
 * Cooldown state lives on each entry (cooldownUntil / lastError / lastUsedAt)
 * inside the pool's JSON `data` blob; it is mutated by the chat retry loop via
 * `markProxyEntryCooldown` when a request fails with a rotatable error.
 */

// --- error classification -------------------------------------------------

// Text substrings (case-insensitive) that indicate the upstream rejected us in
// a way that is often IP/proxy-specific and worth trying a different entry.
// These mirror the account-fallback ERROR_RULES but are evaluated independently
// here so proxy rotation and account rotation can disagree if needed.
const ROTATABLE_ERROR_TEXT = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "freeusagelimit", // Anthropic-style "FreeUsageLimitError"
  "capacity",
  "overloaded",
  "request not allowed",
  // Cloudflare edge rate-limiting the exit IP (error 1015 block page) — a
  // short per-IP window at the edge, so rotate with the normal rate-limit
  // cooldown. (Status is usually 429, which is already rotatable; these
  // signatures catch the status-less text form.)
  "you are being rate limited",
  "error 1015",
];

// HTTP statuses that warrant a proxy switch. 5xx/408 are upstream/proxy
// trouble; 429 is the headline rate-limit case. 401/403 are NOT here because
// those are account/credential problems, not proxy problems — EXCEPT the
// Cloudflare edge-IP blocks below, which are exit-IP-specific.
const ROTATABLE_ERROR_STATUS = [408, 429, 500, 502, 503, 504];

// Cloudflare edge blocks that follow the EXIT IP: the site is behind
// Cloudflare and the proxy's egress IP is banned/restricted at the edge.
// Every request through this IP fails identically regardless of account —
// switching proxy is the only fix. Matched against the block-page body,
// which formatProviderError embeds in the error text (a normal API 403 JSON
// error never contains these strings). Hard bans only — edge blocks that are
// NOT IP-specific (1010 browser-signature, 1000-series DNS/domain issues,
// 52x origin errors) deliberately stay out: rotating cannot fix those.
const IP_BAN_ERROR_TEXT = [
  "edge ip restricted", // 1034 — DNS points somewhere CF doesn't proxy for this IP
  "error 1034",
  "error code: 1034",
  "errorcode: 1034",
  "error 1006", // "Your IP address has been banned"
  "error 1007",
  "error 1008",
  "ip address has been banned",
  "access denied by firewall rules", // 1020 — WAF, usually IP reputation
  "error 1020",
];

/**
 * Is this error a Cloudflare-style edge block on the proxy's exit IP?
 * (Block-page signature — NOT an account/credential 403. Hard bans only;
 * the edge rate-limit 1015 is classified via ROTATABLE_ERROR_TEXT instead.)
 */
export function isProxyIpBanError(status, errorText) {
  const lower = errorText
    ? (typeof errorText === "string" ? errorText : String(errorText)).toLowerCase()
    : "";
  return !!lower && IP_BAN_ERROR_TEXT.some((t) => lower.includes(t));
}

/**
 * Does this error look like it could be resolved by switching proxy/IP?
 * Used by the chat retry loop to decide whether to cool down the current entry
 * and try another one before giving up on the account.
 */
export function isProxyRotatableError(status, errorText) {
  if (isProxyIpBanError(status, errorText)) return true;
  if (status && ROTATABLE_ERROR_STATUS.includes(status)) return true;
  const lower = errorText
    ? (typeof errorText === "string" ? errorText : String(errorText)).toLowerCase()
    : "";
  if (lower && ROTATABLE_ERROR_TEXT.some((t) => lower.includes(t))) return true;
  return false;
}

// Signatures of a *connection-level* proxy failure (the proxy itself was
// unreachable / dropped the connection), as opposed to an upstream HTTP error
// the proxy successfully forwarded. `formatProviderError` surfaces the undici /
// socket cause in the `(cause: ...)` suffix, so we can tell a SOCKS-port-down
// event (rotation teardown) from a genuine upstream 502. `terminated` is
// undici's mid-body abort (TypeError: terminated) — the proxy/process died
// under the response stream; client-side aborts surface as "AbortError"
// instead, so the word `terminated` stays unambiguous here.
const CONNECTION_FAILURE_RE =
  /fetch failed|socket hang up|und_err_socket|other side closed|\bterminated\b|cause:\s*e(connrefused|connreset|timedout|pipe|connaborted|eof)/i;

/**
 * Is this error a connection-level proxy failure (proxy unreachable / dropped),
 * rather than an upstream response the proxy forwarded? Used by the managed-pool
 * retry path: such failures during a rotation's teardown/respawn window are
 * transient and worth retrying once the SOCKS port is back up — they are NOT a
 * reason to mark the account unavailable.
 */
export function isConnectionFailure(errorText) {
  if (!errorText) return false;
  const text = typeof errorText === "string" ? errorText : String(errorText);
  return CONNECTION_FAILURE_RE.test(text);
}

// --- cooldown durations ---------------------------------------------------

const PROXY_COOLDOWN_MS = {
  rateLimit: 60 * 1000, // 429 / rate-limit / quota → 60s
  server: 30 * 1000, // 5xx → 30s
  transient: 20 * 1000, // other rotatable → 20s
  ipBan: 60 * 60 * 1000, // Cloudflare edge IP block → 1h (edge bans last hours)
};

/**
 * How long to cool down an entry after a rotatable error.
 */
export function proxyCooldownForError(status, errorText) {
  if (status === 429) return PROXY_COOLDOWN_MS.rateLimit;
  const lower = errorText
    ? (typeof errorText === "string" ? errorText : String(errorText)).toLowerCase()
    : "";
  if (isProxyIpBanError(status, errorText)) return PROXY_COOLDOWN_MS.ipBan;
  if (lower && ["rate limit", "too many requests", "quota exceeded", "freeusagelimit", "capacity", "overloaded"].some((t) => lower.includes(t))) {
    return PROXY_COOLDOWN_MS.rateLimit;
  }
  if (status >= 500) return PROXY_COOLDOWN_MS.server;
  return PROXY_COOLDOWN_MS.transient;
}

// --- entry selection ------------------------------------------------------

function isEntryAvailable(entry, now, excludeEntryIds) {
  if (!entry) return false;
  if (entry.isActive === false) return false;
  if (excludeEntryIds && excludeEntryIds.has(entry.id)) return false;
  // A "direct" slot needs no URL; every other entry must carry a usable proxy
  // URL — empty-URL placeholders (e.g. a proxyxoay key awaiting its first
  // rotation) must never be selected (P4).
  if (entry.type !== "direct" && !String(entry.proxyUrl || "").trim()) return false;
  const until = entry.cooldownUntil ? Number(entry.cooldownUntil) : 0;
  if (until && until > now) return false;
  return true;
}

// Round-robin cursor per pool id (in-memory). The legacy pool.rrCounter field
// wrote the DB on every pick, churning updatedAt (which the pool list used to
// sort by) — a module Map keeps cursors stable without per-request writes (P7).
// Resets on restart, same trade-off as the pool-level rotate state.
const groupRrCursors = new Map();

/** Reset all round-robin cursors. Intended for tests. */
export function _resetGroupRrCursors() {
  groupRrCursors.clear();
}

/**
 * Pick the next entry from a proxy group.
 *
 * @param {object} pool - a proxy pool with isGroup=true and an `entries` array.
 * @param {Set<string>} [excludeEntryIds] - entry ids to skip this turn (already tried).
 * @returns {{entry: object}|null} the chosen entry with lastUsedAt stamped
 *   (caller persists the stamp via stampProxyEntryUsed). null when no entry is
 *   available (all inactive/cooled-down/excluded/empty-URL).
 */
export function pickProxyGroupEntry(pool, excludeEntryIds = new Set()) {
  if (!pool || !pool.isGroup || !Array.isArray(pool.entries)) return null;
  const now = Date.now();
  const available = pool.entries.filter((e) => isEntryAvailable(e, now, excludeEntryIds));
  if (available.length === 0) return null;

  const mode = pool.rotationMode || "on-error";
  let chosen;

  if (mode === "round-robin") {
    // Advance the in-memory per-pool counter; wrap against available length.
    const counter = groupRrCursors.get(pool.id) || 0;
    chosen = available[counter % available.length];
    groupRrCursors.set(pool.id, counter + 1);
  } else if (mode === "random") {
    chosen = available[Math.floor(Math.random() * available.length)];
  } else {
    // "on-error" (default): least-recently-used so we don't immediately retry
    // the entry that just failed. Entries never used sort first.
    const sorted = [...available].sort((a, b) => {
      const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return ta - tb;
    });
    chosen = sorted[0];
  }

  // Stamp lastUsedAt so subsequent picks in the same rotation window prefer
  // other entries. The caller persists the stamp as a delta-write.
  return { entry: { ...chosen, lastUsedAt: new Date(now).toISOString() } };
}

/**
 * Are there any entries in the group that are still usable (not cooled down /
 * excluded)? Used by the chat loop to decide whether to keep rotating proxies
 * on the same account or give up and fall back to the next account.
 */
export function groupHasAvailableEntry(pool, excludeEntryIds = new Set()) {
  if (!pool || !pool.isGroup || !Array.isArray(pool.entries)) return false;
  const now = Date.now();
  return pool.entries.some((e) => isEntryAvailable(e, now, excludeEntryIds));
}
