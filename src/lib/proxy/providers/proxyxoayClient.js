/**
 * proxyxoay.org API client.
 *
 * proxyxoay sells rotating residential/4G proxies keyed by an API key. Each
 * call to `key_xoay.php` returns the CURRENT proxy for that key (rotating the
 * IP server-side at most once every `next_allowed_in_seconds`). The proxy is
 * handed back in the colon form `IP:PORT:USER:PASS`, which we run through the
 * shared parser to get a canonical URL undici / proxy-chain can consume.
 *
 * Verified live (2026-08-13):
 *   GET .../key_xoay.php?key=FAKE&live=1  → {"error":"invalid_key","message":"Key không tồn tại"}
 *   GET .../key_xoay.php?live=1           → HTTP 400
 *
 * Success shape (per provider spec):
 *   { key, time, proxyhttp, proxysocks5, nha_mang, vi_tri, time_die,
 *     next_allowed_in_seconds, next_allowed_at_timestamp }
 */

import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { normalizeProxyInput } from "../parseProxy.js";

const API_BASE = "https://api.proxyxoay.org/api/key_xoay.php";
const FETCH_TIMEOUT_MS = 20_000;

/** Localised error so callers can distinguish provider errors from network ones. */
export class ProxyXoayError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "ProxyXoayError";
    this.code = code || "proxyxoay_error";
  }
}

// The provider doesn't document a hard max for `live`; similar Vietnamese 4G
// providers cap IP lifetime around 30–60 min, so accept up to 60 and let the
// provider's own response (`time_die` / error) be the source of truth.
const LIVE_MIN = 1;
const LIVE_MAX = 60;

function clampLive(minutes) {
  const n = parseInt(minutes, 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(LIVE_MAX, Math.max(LIVE_MIN, n));
}

/**
 * Build the canonical proxy URL for a given raw `IP:PORT:USER:PASS` string and
 * preferred scheme ("http" uses proxyhttp semantics, "socks5" uses proxysocks5).
 * Returns null if the raw value can't be parsed.
 */
function toCanonical(rawColon, fallbackScheme) {
  if (!rawColon || typeof rawColon !== "string") return null;
  const r = normalizeProxyInput(rawColon.trim(), { defaultScheme: fallbackScheme });
  return r.ok ? r.canonicalUrl : null;
}

/**
 * Fetch the current proxy for a key from proxyxoay.org.
 *
 * @param {{ apiKey: string, liveMinutes?: number, protocol?: "http"|"socks5" }} opts
 * @returns {Promise<{ apiKey, liveMinutes, proxyhttp, proxysocks5, nha_mang, vi_tri,
 *                     time_die, next_allowed_in_seconds, next_allowed_at_timestamp,
 *                     canonicalUrl, exitIp, fetchedAt }>}
 */
export async function fetchProxyXoay({ apiKey, liveMinutes = 5, protocol = "http" }) {
  const key = (apiKey || "").trim();
  if (!key) throw new ProxyXoayError("Missing API key", { code: "missing_key" });

  const live = clampLive(liveMinutes);
  const scheme = protocol === "socks5" ? "socks5" : "http";
  const url = `${API_BASE}?key=${encodeURIComponent(key)}&live=${live}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    // proxyOptions=null → uses the global outbound proxy (HTTP_PROXY env) if the
    // 9router server itself sits behind a proxy, otherwise direct. We never want
    // to route the provider call through one of our own rotating pools.
    res = await proxyAwareFetch(
      url,
      {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      },
      null
    );
  } catch (e) {
    throw new ProxyXoayError(`Network error reaching proxyxoay: ${e?.message || e}`, {
      code: "network_error",
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ProxyXoayError(`proxyxoay returned HTTP ${res.status}`, {
      code: `http_${res.status}`,
    });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new ProxyXoayError("proxyxoay returned a non-JSON response", {
      code: "bad_response",
    });
  }

  if (body && body.error) {
    // e.g. { error: "invalid_key", message: "Key không tồn tại" }
    throw new ProxyXoayError(body.message || body.error, { code: body.error });
  }

  const proxyhttp = typeof body?.proxyhttp === "string" ? body.proxyhttp.trim() : "";
  const proxysocks5 = typeof body?.proxysocks5 === "string" ? body.proxysocks5.trim() : "";

  // Pick the raw value matching the requested scheme, fall back to whichever exists.
  const rawForScheme = scheme === "socks5" ? proxysocks5 || proxyhttp : proxyhttp || proxysocks5;
  const canonicalUrl = toCanonical(rawForScheme, scheme);
  if (!canonicalUrl) {
    throw new ProxyXoayError(
      `proxyxoay response missing a usable proxy (proxyhttp=${proxyhttp || "∅"}, proxysocks5=${proxysocks5 || "∅"})`,
      { code: "no_proxy" }
    );
  }

  const exitIp = (() => {
    const r = normalizeProxyInput(rawForScheme, { defaultScheme: scheme });
    return r.ok ? r.parsed.host : "";
  })();

  return {
    apiKey: key,
    liveMinutes: live,
    proxyhttp,
    proxysocks5,
    nha_mang: body?.nha_mang || "",
    vi_tri: body?.vi_tri || "",
    time_die: Number(body?.time_die) || 0,
    next_allowed_in_seconds: Number(body?.next_allowed_in_seconds) || 0,
    next_allowed_at_timestamp: Number(body?.next_allowed_at_timestamp) || 0,
    canonicalUrl,
    exitIp,
    fetchedAt: new Date().toISOString(),
  };
}
