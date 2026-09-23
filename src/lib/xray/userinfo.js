/**
 * Pure parser for the `subscription-userinfo` response header (v2rayN
 * convention). Split from sync.js so it is unit-testable without the DB
 * layer — same pattern as syncParse.js.
 *
 * Header format: "upload=1234; download=2234; total=3456; expire=1641000000"
 * — bytes + unix seconds, case-insensitive key match, vendor prefixes
 * tolerated (e.g. `x-amz-meta-subscription-userinfo`).
 *
 * Garbage never throws: missing keys → 0, unparseable values → ignored.
 * total=0/missing → unlimited; expire=0/missing → never (null).
 */

export const MAX_USERINFO_BYTES = Number.MAX_SAFE_INTEGER;

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function") {
    return [...headers.entries()];
  }
  return Object.entries(headers);
}

function toNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * @param {Headers|Record<string,string>} headers — response headers
 * @returns {{ uploadBytes: number, downloadBytes: number, totalBytes: number, expireAt: string|null }}
 */
export function parseSubscriptionUserinfo(headers) {
  const result = { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, expireAt: null };
  let raw = null;
  for (const [name, value] of headerEntries(headers)) {
    if (/subscription-userinfo$/i.test(name)) {
      raw = value;
      break;
    }
  }
  if (!raw || typeof raw !== "string") return result;

  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue; // garbage: no key=value separator
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (!key || !value) continue;
    switch (key) {
      case "upload":
        result.uploadBytes = toNonNegativeInt(value);
        break;
      case "download":
        result.downloadBytes = toNonNegativeInt(value);
        break;
      case "total":
        result.totalBytes = toNonNegativeInt(value);
        break;
      case "expire": {
        const secs = Number(value);
        if (Number.isFinite(secs) && secs > 0) {
          result.expireAt = new Date(secs * 1000).toISOString();
        }
        break;
      }
      default:
        break; // unknown key — ignore
    }
  }
  return result;
}
