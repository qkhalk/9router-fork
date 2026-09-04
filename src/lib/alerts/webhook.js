/**
 * Generic webhook sender factory. POSTs a stable, versioned JSON schema and
 * enforces a minimal SSRF posture: operator-configured URLs only, with
 * string-level hostname checks (loopback / private IPv4 / the app's own
 * public host), a hard 5s timeout, and redirects disabled.
 *
 * DNS-rebinding is OUT OF SCOPE for v1: webhook URLs are entered by the
 * operator (settings UI), not by untrusted users, so hostname-level checks
 * are proportionate. If URLs ever become remotely settable, resolve+pin the
 * IP before connecting.
 */

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Pure string-level check (NO DNS): is this hostname a loopback/private
 * address this app should never be webhook'd to?
 *
 * Blocks: localhost (+ trailing-dot form), 127.0.0.0/8 loopback, ::1,
 * private IPv4 (10/8, 172.16/12, 192.168/16), and link-local 169.254/16.
 *
 * @param {string} hostname - URL hostname (case-insensitive; brackets on
 *   IPv6 literals are tolerated).
 * @returns {boolean}
 */
export function isPrivateHostname(hostname) {
  if (!hostname) return false;
  const h = String(hostname)
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, ""); // "localhost." FQDN-trailing-dot form

  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::ffff:127.0.0.1") return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const octets = m.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false; // not a real IPv4 literal
    const [a, b] = octets;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
    if (a === 192 && b === 168) return true; // private 192.168/16
    if (a === 169 && b === 254) return true; // link-local 169.254/16
  }
  return false;
}

/**
 * @param {{ getUrl: () => Promise<string>, getOwnHost: () => Promise<string | null> }} deps
 *   Async getters — settings may not be loaded yet at construction time.
 * @returns {(message: { eventType: string, severity: string, title: string, body: string, host: string, timestamp: string }) => Promise<void>}
 */
export function createWebhookSender({ getUrl, getOwnHost }) {
  return async function webhookSend(message) {
    const url = await getUrl();
    if (!url) {
      throw new Error("webhook not configured");
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      const err = new Error("webhook URL not allowed");
      err.noRetry = true;
      throw err;
    }

    // SSRF posture (see module doc): operator-configured URLs, hostname-level checks.
    const hostname = parsed.hostname.toLowerCase();
    const ownHost = String((await getOwnHost()) || "").toLowerCase();
    if (isPrivateHostname(hostname) || (ownHost && hostname === ownHost)) {
      const err = new Error("webhook URL not allowed");
      err.noRetry = true; // permanent misconfiguration — the queue must not retry
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          eventType: message.eventType,
          severity: message.severity,
          timestamp: message.timestamp || new Date().toISOString(),
          host: message.host,
          payload: { title: message.title, body: message.body },
        }),
        redirect: "manual", // never follow redirects
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("webhook timed out after 5000ms");
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      // redirect:"manual" makes fetch return the 3xx itself instead of following.
      throw new Error("webhook redirect blocked");
    }
    if (res.status === 429) {
      const retryAfterSec = Number(res.headers && res.headers.get("retry-after")) || 0;
      const err = new Error(`webhook 429 rate limited (retry_after=${retryAfterSec}s)`);
      err.retryAfterMs = retryAfterSec * 1000;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`webhook send failed: HTTP ${res.status}`);
    }
  };
}
