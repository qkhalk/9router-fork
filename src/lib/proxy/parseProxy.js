/**
 * Multi-format proxy URL parser / normalizer.
 *
 * Proxy URLs in the wild come in many shapes, and crucially the credentials
 * can appear on EITHER side of the host:
 *
 *   scheme://user:pass@host:port     ← standard URL order (what undici wants)
 *   scheme://host:port@user:pass     ← REVERSED — common from some panels, and
 *                                       NOT a valid URL (`new URL` mis-parses it)
 *
 * On top of that, proxies are frequently pasted as bare colon forms with no
 * scheme and no `@`:
 *
 *   host:port:user:pass              ← e.g. proxyxoay.org's `proxyhttp` field
 *   user:pass:host:port
 *   host:port
 *
 * `new URL()` only understands the standard order, so every other shape either
 * throws or — worse — silently parses into the wrong host/credentials. This
 * module is the single source of truth that understands all of them and emits
 * a canonical `scheme://[user[:pass]@]host[:port]` URL that undici's
 * `ProxyAgent` (and the browser) accept.
 *
 * The module is pure JS + regex only (no `URL`, no Node APIs) so it runs
 * identically on the client (dashboard) and the server (API routes).
 */

// --- scheme / port tables --------------------------------------------------

/** Schemes we know how to default a port for. */
const DEFAULT_PORTS = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks4a: 1080,
  socks5: 1080,
  socks5h: 1080,
};

/** Schemes accepted at the network layer (mirrors VALID_PROXY_SCHEMES). */
export const KNOWN_SCHEMES = Object.freeze(
  Object.keys(DEFAULT_PORTS).map((s) => `${s}:`)
);

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([\s\S]*)$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_BARE_RE = /^[0-9a-fA-F:]+$/; // must also contain a ":" to count as v6
const HOSTNAME_RE = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/; // has at least one dot

/**
 * Does `h` look like a real host (IP or dotted hostname) rather than a bare
 * username? Used to disambiguate the reversed `host:port@user:pass` order from
 * the standard `user:pass@host:port` when both sides *technically* parse.
 */
function looksLikeHost(h) {
  if (!h) return false;
  if (h === "localhost") return true;
  if (IPV4_RE.test(h)) return true;
  if (h.includes(":") && IPV6_BARE_RE.test(h)) return true; // bare IPv6
  if (HOSTNAME_RE.test(h)) return true; // dotted hostname
  return false;
}

function isValidPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Is `h` a syntactically plausible host? Rejects whitespace, sentences, and
 * other junk so free text ("not a proxy") isn't mistaken for a hostname.
 * Bracketed IPv6 hosts arrive here without their brackets.
 */
function isValidHost(h, ipv6) {
  if (!h) return false;
  if (/\s/.test(h)) return false; // hosts never contain whitespace
  if (ipv6) return /^[0-9a-fA-F:]+$/.test(h);
  return /^[a-zA-Z0-9.\-]+$/.test(h); // IPv4 dotted or hostname
}

/**
 * Try to read `str` as a clean `host[:port]` pair.
 * Returns `{ host, port }` (port may be null) or `null` when it clearly isn't
 * a hostport (e.g. `user:pass` — 2 tokens but the 2nd isn't numeric; or 3+
 * unbracketed tokens like `user:pass:host`).
 *
 * IPv6 hosts must be bracketed (`[::1]:8080`); bare `::1` without brackets is
 * ambiguous against the colon forms and is rejected here.
 */
function tryParseHostPort(str) {
  const s = (str || "").trim();
  if (!s) return null;

  // Bracketed IPv6: [host] or [host]:port
  if (s.startsWith("[")) {
    const m = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!m) return null;
    const port = m[2] != null && m[2] !== "" ? parseInt(m[2], 10) : null;
    if (port != null && !isValidPort(port)) return null;
    return { host: m[1], port, ipv6: true };
  }

  const parts = s.split(":");
  if (parts.length === 1) {
    return { host: parts[0], port: null, ipv6: false };
  }
  if (parts.length === 2) {
    if (!/^\d{1,5}$/.test(parts[1])) return null; // 2nd token must be the port
    const port = parseInt(parts[1], 10);
    if (!isValidPort(port)) return null;
    return { host: parts[0], port, ipv6: false };
  }
  // 3+ unbracketed tokens → not a clean hostport (it's a credential-laden
  // colon form). The colon-form handler deals with those.
  return null;
}

/**
 * Split `user[:pass]` into credentials. Each piece is percent-decoded (if it
 * was already encoded) so the final output is a single canonical encoding no
 * matter how the user pasted it.
 */
function parseUserinfo(str) {
  const s = (str || "").trim();
  if (!s) return { username: "", password: "" };
  const idx = s.indexOf(":");
  let userRaw = s;
  let passRaw = "";
  if (idx >= 0) {
    userRaw = s.slice(0, idx);
    passRaw = s.slice(idx + 1);
  }
  return { username: safeDecode(userRaw), password: safeDecode(passRaw) };
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function enc(v) {
  return encodeURIComponent(v ?? "");
}

/**
 * Parse a colon form with NO scheme and NO `@`. The token that holds the
 * numeric port reveals the layout:
 *   host:port:user:pass   (port at idx 1)
 *   user:pass:host:port   (port at last idx)
 *   host:port             (2 tokens)
 *   host                  (1 token)
 * Bracketed IPv6 host (`[::1]:8080:user:pass`) is handled by peeling the
 * leading `[...]` off before tokenising the rest.
 */
function parseColonForm(body) {
  let host = null;
  let port = null;
  let ipv6 = false;
  let rest = body;

  // Peel a bracketed IPv6 host (optionally with its port) off the front.
  const v6 = body.match(/^\[([^\]]+)\](?::(\d{1,5}))?(.*)$/);
  if (v6) {
    host = v6[1];
    ipv6 = true;
    if (v6[2] != null && v6[2] !== "") {
      port = parseInt(v6[2], 10);
      if (!isValidPort(port)) return null;
    }
    rest = v6[3].replace(/^:/, ""); // drop the leading colon separating from remainder
    if (rest) {
      const creds = parseUserinfo(rest);
      return assemble(host, port, ipv6, creds.username, creds.password);
    }
    return assemble(host, port, ipv6, "", "");
  }

  const parts = body.split(":").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  if (parts.length === 1) {
    return assemble(parts[0], null, false, "", "");
  }

  // Find candidate numeric-port positions. A port must be a bare integer.
  const isNum = (p) => /^\d{1,5}$/.test(p);
  const toPort = (p) => parseInt(p, 10);

  if (parts.length === 2) {
    if (!isNum(parts[1])) return null; // can't be host:port → too ambiguous
    const port = toPort(parts[1]);
    if (!isValidPort(port)) return null;
    return assemble(parts[0], port, false, "", "");
  }

  if (parts.length === 3) {
    // host:port:user  (user only, no pass)
    if (isNum(parts[1])) {
      const port = toPort(parts[1]);
      if (!isValidPort(port)) return null;
      return assemble(parts[0], port, false, parts[2], "");
    }
    return null;
  }

  // 4+ tokens. Decide layout by where the port sits.
  // host:port:user:pass[:extra...]  → port at idx 1
  // user:pass:host:port[:extra...]  → port at idx 3
  if (isNum(parts[1])) {
    const port = toPort(parts[1]);
    if (!isValidPort(port)) return null;
    const host2 = parts[0];
    const user = parts[2] || "";
    const pass = parts.slice(3).join(":"); // allow ":" inside the password
    return assemble(host2, port, false, user, pass);
  }
  if (parts.length >= 4 && isNum(parts[3])) {
    const port = toPort(parts[3]);
    if (!isValidPort(port)) return null;
    const user = parts[0];
    const pass = parts[1];
    const host2 = parts[2];
    return assemble(host2, port, false, user, pass);
  }
  return null;
}

/** Bundle the parsed parts into the canonical result object. */
function assemble(host, port, ipv6, username, password) {
  if (!host) return null;
  return {
    host: String(host),
    port: port != null ? port : null,
    ipv6: !!ipv6,
    username: username || "",
    password: password || "",
  };
}

/**
 * Normalise a proxy string of (almost) any common shape into a canonical URL.
 *
 * @param {string} raw - The raw proxy string.
 * @param {{ defaultScheme?: string }} [opts] - Scheme to assume when none is
 *   present (default `"http"`).
 * @returns {{ ok: true, canonicalUrl: string, parsed: {scheme:string, host:string, port:number|null, username:string, password:string}, original: string }}
 *          | {{ ok: false, error: string, original: string }}
 */
export function normalizeProxyInput(raw, opts = {}) {
  const original = raw == null ? "" : String(raw);
  const s = original.trim();
  if (!s) return { ok: false, error: "Empty proxy string", original };

  let defaultScheme = (opts.defaultScheme || "http").replace(/:$/, "").toLowerCase();
  if (!DEFAULT_PORTS[defaultScheme]) defaultScheme = "http";

  // 1. Peel off an optional `scheme://` prefix.
  let scheme = "";
  let body = s;
  const sm = s.match(SCHEME_RE);
  if (sm) {
    scheme = sm[1].toLowerCase();
    body = sm[2];
    // Accept the bare alias "socks" as socks5.
    if (scheme === "socks") scheme = "socks5";
    if (!DEFAULT_PORTS[scheme]) {
      return { ok: false, error: `Unsupported scheme "${scheme}://"`, original };
    }
  } else {
    scheme = defaultScheme;
  }

  // 2. Parse the body into host/port/credentials.
  let parsed = null;

  const atIdx = body.lastIndexOf("@");
  if (atIdx >= 0) {
    const left = body.slice(0, atIdx);
    const right = body.slice(atIdx + 1);
    const L = tryParseHostPort(left);
    const R = tryParseHostPort(right);
    const Lreal = !!(L && looksLikeHost(L.host));
    const Rreal = !!(R && looksLikeHost(R.host));

    let userinfoStr = "";
    let hostportStr = "";
    if (Rreal && !Lreal) {
      // standard: userinfo@hostport
      userinfoStr = left;
      hostportStr = right;
    } else if (Lreal && !Rreal) {
      // reversed: hostport@userinfo
      userinfoStr = right;
      hostportStr = left;
    } else if (R && !L) {
      userinfoStr = left;
      hostportStr = right;
    } else if (L && !R) {
      userinfoStr = right;
      hostportStr = left;
    } else {
      // both look like hosts, or neither — default to standard order.
      userinfoStr = left;
      hostportStr = right;
    }

    const hp = tryParseHostPort(hostportStr);
    const creds = parseUserinfo(userinfoStr);
    if (!hp) return { ok: false, error: "Could not parse host:port", original };
    parsed = assemble(hp.host, hp.port, hp.ipv6, creds.username, creds.password);
  } else {
    parsed = parseColonForm(body);
  }

  if (!parsed) {
    return { ok: false, error: "Unrecognised proxy format", original };
  }

  // Reject junk hosts (free text, sentences) that otherwise slip through the
  // single-token / colon-form paths.
  if (!isValidHost(parsed.host, parsed.ipv6)) {
    return { ok: false, error: "Invalid host", original };
  }

  // 3. Fill a default port from the scheme when none was given.
  const port = parsed.port != null ? parsed.port : DEFAULT_PORTS[scheme] ?? null;
  const hostDisplay = parsed.ipv6 ? `[${parsed.host}]` : parsed.host;

  // 4. Build the canonical URL.
  let auth = "";
  if (parsed.username) {
    auth = enc(parsed.username);
    if (parsed.password) auth += `:${enc(parsed.password)}`;
    auth += "@";
  }
  const portStr = port != null ? `:${port}` : "";
  const canonicalUrl = `${scheme}://${auth}${hostDisplay}${portStr}`;

  return {
    ok: true,
    canonicalUrl,
    parsed: {
      scheme,
      host: parsed.host,
      port,
      username: parsed.username,
      password: parsed.password,
    },
    original,
  };
}

/**
 * Convenience: return just the canonical URL string, or `null` on failure.
 * Handy at the network layer where only the URL is needed.
 */
export function canonicalizeProxyUrl(raw, opts) {
  const r = normalizeProxyInput(raw, opts);
  return r.ok ? r.canonicalUrl : null;
}

/**
 * Convenience: return just the parsed parts, or `null` on failure. Used by the
 * UI to render host/port/credentials for display.
 */
export function parseProxyParts(raw, opts) {
  const r = normalizeProxyInput(raw, opts);
  return r.ok ? r.parsed : null;
}

/**
 * Does `raw` carry one of the accepted proxy schemes? Used to validate group
 * entries without coupling the UI to the scheme table.
 */
export function getProxyScheme(raw) {
  const r = normalizeProxyInput(raw);
  return r.ok ? `${r.parsed.scheme}:` : null;
}
