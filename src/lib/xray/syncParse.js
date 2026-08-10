/**
 * Pure parsing helpers for the v2go subscription sync.
 *
 * Split out of sync.js so they can be unit-tested without dragging in the
 * DB layer (which pulls in @/ alias chains that vitest does not resolve).
 * sync.js re-exports these for callers that want the full API.
 */

import { createHash } from "node:crypto";
import {
  getProtocol,
  extractEndpoint,
  decodeSubscriptionBase64,
} from "./parser.js";

/**
 * Parse a subscription response body into an array of share links.
 * v2go's main file is plain text (one link per line, with a few header
 * comment lines). Base64-encoded subscription variants are also accepted.
 *
 * @param {string} text — raw response body
 * @returns {string[]} share links
 */
export function parseSubscription(text) {
  if (!text) return [];
  // Heuristic: if the body has no "://" it's probably base64-encoded.
  let body = text;
  if (!body.includes("://")) {
    const decoded = decodeSubscriptionBase64(body.replace(/\s+/g, ""));
    if (decoded && decoded.includes("://")) body = decoded;
  }
  const out = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes("://")) continue;
    // Undo the one HTML-escape v2go applies during aggregation.
    out.push(line.replaceAll("&amp;", "&"));
  }
  return out;
}

/**
 * Parse a v2go config name fragment into structured metadata.
 * The canonical v2go rename format is:  "v2go | <flag> <CC> | <PROTO> | <n>"
 * e.g. "v2go | 🇩🇪 DE | VLESS | 12" → { flag:"🇩🇪", country:"DE", protocol:"vless", index:12 }
 * Falls back gracefully for non-v2go names.
 *
 * @param {string} name — the URL-decoded fragment after "#"
 */
export function parseConfigName(name) {
  if (!name) return {};
  const m = name.match(/^v2go\s*\|\s*(?:([^\s]*)\s+([A-Z]{2}))?\s*\|\s*([A-Z0-9]+)\s*\|\s*(\d+)/i);
  if (m) {
    return {
      flag: m[1] || "",
      country: (m[2] || "").toUpperCase(),
      protocol: m[3].toLowerCase(),
      index: parseInt(m[4], 10),
    };
  }
  return { name };
}

/**
 * Build a full DB-ready config entry from a raw share link.
 * Returns null if the link is unparseable or an unsupported protocol.
 */
export function linkToConfigEntry(link) {
  const protocol = getProtocol(link);
  if (protocol === "unknown") return null;

  // Extract name/fragment (after "#").
  let nameRaw = "";
  const hashIdx = link.indexOf("#");
  if (hashIdx >= 0) {
    try {
      nameRaw = decodeURIComponent(link.slice(hashIdx + 1));
    } catch {
      nameRaw = link.slice(hashIdx + 1);
    }
  }
  const meta = parseConfigName(nameRaw);

  // Endpoint (host/port). For vmess this decodes the base64 blob.
  const ep = extractEndpoint(link) || {};

  // Deterministic stable id = sha1 of the canonical link (without fragment,
  // so re-syncs with cosmetic name changes don't duplicate rows).
  let canon = link;
  const h = link.indexOf("#");
  if (h >= 0) canon = link.slice(0, h);
  const id = createHash("sha1").update(canon).digest("hex");

  return {
    id,
    link,
    name: nameRaw,
    protocol: meta.protocol || protocol,
    country: meta.country || "",
    host: ep.host || "",
    port: ep.port || null,
    flag: meta.flag || "",
  };
}
