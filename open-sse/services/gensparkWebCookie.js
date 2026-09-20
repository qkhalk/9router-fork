/**
 * Genspark Web cookie-jar parsing and serialization.
 *
 * Genspark's edge requires the FULL browser cookie jar (not just `session_id`):
 *   - `__cf_bm`   — Cloudflare bot-management token; missing it trips a challenge page
 *   - `c1` / `c2` — auth cookies
 *   - `gslogin`   — login marker
 *   - `session_id` — the primary session token
 *   - `ai_user` / `ai_session` / `g_state` etc. — analytics (harmless, included)
 *
 * This mirrors the proven parsing machinery in `open-sse/services/geminiWebCookie.js`
 * but is scoped to genspark.ai domains instead of Google ones. Accepted inputs:
 *   1. A Chrome "Export cookie" JSON array  (the `[{name, value, domain, ...}]` shape DevTools
 *      and cookie editors (e.g. Cookie Editor) produce — this is what the genspark.ai export
 *      looks like). Values may be percent-encoded (`%220%22` = `"0"`); they are decoded so the
 *      serialized `Cookie:` header carries the raw value a browser would send.
 *   2. A JSON object `{ "name": "value", ... }`.
 *   3. Netscape cookies.txt format.
 *   4. Plain text `name=value; name2=value2` pairs (a `Cookie:` header line).
 *
 * Fail-open by design (like the RTK token saver): a parse error never throws —
 * it returns whatever cookies it could salvage plus a warning, so a malformed
 * paste surfaces as "session_id missing" rather than a crash.
 */

const REQUIRED_COOKIE = "session_id";
// Cookies that matter for auth/anti-bot — used only for warnings, not as a gate.
const IMPORTANT_COOKIE_NAMES = new Set(["__cf_bm", "c1", "c2", "gslogin", "session_id"]);

const GENSPARKISH_DOMAIN_RE = /(^|\.)genspark\.ai$/i;
const COOKIE_PAIR_RE = /(?:^|[;\s,])([A-Za-z0-9_.-]+)\s*=\s*([^;\r\n]+)/g;
const JSON_ENTITY_QUOTE_RE = /&#34;|&quot;/g;

export class GensparkWebCookieError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GensparkWebCookieError";
    this.code = code;
    this.status = details.status || 401;
    this.warnings = details.warnings || [];
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input.trim();
  return input;
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

/**
 * Decode a percent-encoded cookie value from a browser-cookie editor export.
 *
 * Chrome DevTools "Export cookies" and the Cookie Editor extension store values
 * percent-encoded (`%220%22` → `"0"`, `%2B` → `+`), but a browser sends them raw
 * in the `Cookie:` header. Sending the encoded form makes genspark's auth fail.
 *
 * The round-trip guard is the safety net: we only decode when re-encoding the
 * result reproduces the original (i.e. it really was one percent-encoding pass),
 * so a legit value that happens to contain `%XX` is never mangled and malformed
 * escapes (`50%`) are left untouched.
 */
function decodeCookieValue(value) {
  if (typeof value !== "string" || !value) return value;
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    const decoded = decodeURIComponent(value);
    if (encodeURIComponent(decoded) === value) return decoded;
    return value;
  } catch {
    return value; // malformed escape — keep raw
  }
}

function isExpiredCookie(cookie) {
  const exp = cookie?.expirationDate ?? cookie?.expires ?? cookie?.expiry;
  if (exp == null || exp === "" || exp === 0) return false;
  const n = Number(exp);
  if (!Number.isFinite(n)) return false;
  return n < (n > 1e12 ? Date.now() : nowSeconds());
}

function domainAllowed(domain) {
  if (!domain) return true;
  return GENSPARKISH_DOMAIN_RE.test(String(domain).replace(/^\./, ""));
}

function setCookie(out, name, value, warnings, source = "unknown") {
  const key = safeTrim(name);
  const val = decodeCookieValue(safeTrim(value));
  if (!key || !val) return;
  if (out[key] && out[key] !== val) {
    warnings.push(`duplicate cookie '${key}' encountered; using latest value from ${source}`);
  }
  out[key] = val;
}

function parseJsonCookieArray(arr, warnings) {
  const out = {};
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if (isExpiredCookie(item)) continue;
    if (!domainAllowed(item.domain)) {
      warnings.push(`ignored cookie '${safeTrim(item.name) || "unknown"}' from non-genspark.ai domain`);
      continue;
    }
    setCookie(out, item.name, item.value, warnings, "json-array");
  }
  return out;
}

function parseJsonObject(obj, warnings) {
  const out = {};
  for (const [name, value] of Object.entries(obj || {})) {
    if (value && typeof value === "object" && "value" in value) {
      if (isExpiredCookie(value)) continue;
      if (!domainAllowed(value.domain)) continue;
      setCookie(out, name, value.value, warnings, "json-object");
    } else if (typeof value === "string" || typeof value === "number") {
      setCookie(out, name, value, warnings, "json-object");
    }
  }
  return out;
}

function tryParseJson(input, warnings) {
  if (typeof input !== "string") {
    if (Array.isArray(input)) return { cookies: parseJsonCookieArray(input, warnings), sourceFormat: "chrome-json" };
    if (input && typeof input === "object") return { cookies: parseJsonObject(input, warnings), sourceFormat: "json-object" };
    return null;
  }
  const s = input.replace(JSON_ENTITY_QUOTE_RE, '"');
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return { cookies: parseJsonCookieArray(parsed, warnings), sourceFormat: "chrome-json" };
    if (parsed && typeof parsed === "object") return { cookies: parseJsonObject(parsed, warnings), sourceFormat: "json-object" };
  } catch {
    warnings.push("input looked like JSON but could not be parsed; trying text cookie extraction");
  }
  return null;
}

function parseNetscape(input, warnings) {
  const out = {};
  let count = 0;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 7) continue;
    const [domain, , , , expires, name, ...valueParts] = cols;
    if (!domainAllowed(domain)) continue;
    const exp = Number(expires);
    if (Number.isFinite(exp) && exp > 0 && exp < nowSeconds()) continue;
    setCookie(out, name, valueParts.join(" "), warnings, "netscape");
    count++;
  }
  return count ? out : null;
}

function parsePairs(input, warnings) {
  const out = {};
  const text = input.replace(JSON_ENTITY_QUOTE_RE, '"');

  // Chrome JSON fragments in pasted text: "name":"x" ... "value":"y"
  const fragmentRe = /"name"\s*:\s*"([^"]+)"[\s\S]{0,300}?"value"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = fragmentRe.exec(text))) setCookie(out, m[1], m[2], warnings, "mixed-json-fragment");

  COOKIE_PAIR_RE.lastIndex = 0;
  while ((m = COOKIE_PAIR_RE.exec(text))) {
    const name = m[1];
    const value = m[2].trim().replace(/^"|"$/g, "");
    setCookie(out, name, value, warnings, "text");
  }
  return out;
}

export function parseGensparkWebCookies(input, options = {}) {
  const warnings = [];
  const normalized = normalizeInput(input);
  if (normalized == null || normalized === "") {
    return { cookies: {}, sourceFormat: "empty", warnings: ["empty cookie input"] };
  }

  const jsonResult = tryParseJson(normalized, warnings);
  let cookies = jsonResult?.cookies || {};
  let sourceFormat = jsonResult?.sourceFormat || "auto";

  if (!Object.keys(cookies).length && typeof normalized === "string") {
    const netscape = parseNetscape(normalized, warnings);
    if (netscape && Object.keys(netscape).length) {
      cookies = netscape;
      sourceFormat = "netscape";
    } else {
      cookies = parsePairs(normalized, warnings);
      sourceFormat = normalized.includes(";") ? "header" : "kv";
    }
  }

  const validation = validateGensparkWebCookies(cookies, { throwOnError: false });
  warnings.push(...validation.warnings);
  if (options.throwOnError && !validation.valid) {
    throw new GensparkWebCookieError(validation.code, validation.error, { warnings });
  }

  return { cookies, sourceFormat, warnings };
}

export function validateGensparkWebCookies(cookies, options = {}) {
  const warnings = [];
  if (!cookies || typeof cookies !== "object") {
    const result = { valid: false, code: "invalid_cookie", error: "Invalid Genspark Web cookie input", warnings };
    if (options.throwOnError) throw new GensparkWebCookieError(result.code, result.error, { warnings });
    return result;
  }
  if (!safeTrim(cookies[REQUIRED_COOKIE])) {
    const result = { valid: false, code: "invalid_cookie", error: `Missing required Genspark cookie: ${REQUIRED_COOKIE}`, warnings };
    if (options.throwOnError) throw new GensparkWebCookieError(result.code, result.error, { warnings });
    return result;
  }
  for (const name of IMPORTANT_COOKIE_NAMES) {
    if (name === REQUIRED_COOKIE) continue;
    if (!safeTrim(cookies[name])) warnings.push(`recommended Genspark cookie missing: ${name}`);
  }
  return { valid: true, code: null, error: null, warnings };
}

export function maskGensparkSecret(value) {
  const s = safeTrim(value);
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function maskGensparkWebCookies(cookies = {}) {
  const out = {};
  for (const [k, v] of Object.entries(cookies || {})) out[k] = maskGensparkSecret(v);
  return out;
}

export function serializeGensparkWebCookieHeader(cookies = {}) {
  return Object.entries(cookies)
    .filter(([k, v]) => safeTrim(k) && safeTrim(v))
    .map(([k, v]) => `${k}=${safeTrim(v)}`)
    .join("; ");
}

export function extractGensparkWebCredentials(credentials = {}) {
  const psd = credentials?.providerSpecificData || {};
  if (psd.cookies && typeof psd.cookies === "object") {
    const validation = validateGensparkWebCookies(psd.cookies, { throwOnError: false });
    return { cookies: psd.cookies, source: "providerSpecificData.cookies", warnings: validation.warnings, valid: validation.valid, error: validation.error };
  }
  const input = psd.cookieText || credentials.apiKey || credentials.accessToken || "";
  const parsed = parseGensparkWebCookies(input, { throwOnError: false });
  const validation = validateGensparkWebCookies(parsed.cookies, { throwOnError: false });
  return { cookies: parsed.cookies, source: parsed.sourceFormat, warnings: parsed.warnings, valid: validation.valid, error: validation.error };
}

export const GENSPARK_WEB_COOKIE_SENTINEL = "__cookie_stored_in_provider_specific_data__";
export const GENSPARK_WEB_REQUIRED_COOKIE = REQUIRED_COOKIE;
