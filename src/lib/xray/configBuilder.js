/**
 * Build a full Xray-core client config from a single outbound.
 *
 * The result is a complete, runnable `config.json` that exposes a local
 * SOCKS5 + HTTP inbound pair and routes all traffic through the given
 * outbound (the active V2Ray server). Structure verified against the
 * official Xray docs (xtls.github.io/config) and the in-process template
 * used by v2go's tester (internal/tester/tester.go).
 *
 * Design: one xray process = one active outbound (the v2rayN / Hiddify
 * convention). Switching servers = kill + respawn with a new config.
 */

import { convertLink } from "./parser.js";

/**
 * Build the inbounds array for a local SOCKS5 + HTTP listener pair.
 * @param {{ socksPort?: number, httpPort?: number }} opts
 */
function buildInbounds({ socksPort = 10808, httpPort = 10809 } = {}) {
  return [
    {
      tag: "socks-in",
      listen: "127.0.0.1",
      port: socksPort,
      protocol: "socks",
      settings: { auth: "noauth", udp: true, ip: "127.0.0.1" },
      sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
    },
    {
      tag: "http-in",
      listen: "127.0.0.1",
      port: httpPort,
      protocol: "http",
      settings: {},
    },
  ];
}

/**
 * Build the full Xray client config object.
 *
 * @param {object} outbound — the proxy outbound from convertLink() (tag:"proxy")
 * @param {{ socksPort?: number, httpPort?: number, logLevel?: string }} opts
 * @returns {object} complete config ready to JSON.stringify for `xray run -c`
 */
export function buildClientConfig(outbound, opts = {}) {
  const { socksPort, httpPort, logLevel = "warning" } = opts;
  return {
    log: { loglevel: logLevel },
    inbounds: buildInbounds({ socksPort, httpPort }),
    outbounds: [
      outbound,
      { tag: "direct", protocol: "freedom" },
      { tag: "block", protocol: "blackhole" },
    ],
  };
}

/**
 * Convenience: parse a share link and build the full client config in one call.
 * @param {string} link — v2ray share link
 * @param {{ socksPort?: number, httpPort?: number, logLevel?: string }} opts
 */
export function buildClientConfigFromLink(link, opts = {}) {
  const outbound = convertLink(link);
  return buildClientConfig(outbound, opts);
}

/**
 * Validate that a share link will produce a runnable config. Returns
 * { ok: true, config } or { ok: false, error }. Does NOT spawn xray —
 * this is a structural check used before persisting a config to the DB.
 *
 * Beyond convertLink's own validation, this rejects combinations Xray
 * itself rejects at runtime, most notably REALITY + WebSocket (REALITY only
 * pairs with RAW/gRPC/XHTTP per the transport docs).
 */
export function validateLink(link) {
  try {
    const outbound = convertLink(link);
    const ss = outbound.streamSettings || {};
    if (ss.security === "reality") {
      const net = ss.network;
      if (net === "ws" || net === "websocket" || net === "httpupgrade") {
        return { ok: false, error: `REALITY is not compatible with ${net} transport` };
      }
    }
    return { ok: true, outbound };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
