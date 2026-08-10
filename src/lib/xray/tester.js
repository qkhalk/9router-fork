/**
 * Proxy health testing: measure latency and exit IP through a local SOCKS port.
 *
 * Two probes:
 *  - testProxyLatency: GET a 204 endpoint through the SOCKS proxy, return ms.
 *  - testProxyExitIp:  GET cloudflare cdn-cgi/trace through the SOCKS proxy,
 *    parse the egress IP (ports the fetchExitIP logic from v2go's tester.go).
 *
 * Both use the global fetch with a SocksProxyAgent dispatcher, matching how
 * 9router's proxyAwareFetch works at request time.
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 6000;
const LATENCY_URL = "http://gstatic.com/generate_204";
const TRACE_URL = "http://www.cloudflare.com/cdn-cgi/trace";

function socksAgent(socksPort) {
  // SocksProxyAgent speaks the http.Agent API; pass as `agent` for node-fetch-
  // style. For the global fetch (undici-backed), we wrap via dispatcher.
  return new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);
}

/**
 * Measure round-trip latency through the SOCKS proxy.
 * @returns {Promise<number>} latency in ms, or -1 on failure/timeout
 */
export async function testProxyLatency(socksPort, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  try {
    const agent = socksAgent(socksPort);
    const res = await fetch(LATENCY_URL, {
      agent,
      // Disable compression/redirect so the timing reflects a single round-trip.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "9router-xray-test/1.0" },
    });
    if (res.status === 204 || res.status === 200) {
      return Date.now() - start;
    }
    return -1;
  } catch {
    return -1;
  }
}

/**
 * Discover the exit IP as seen by the destination, through the SOCKS proxy.
 * Parses cloudflare's cdn-cgi/trace for an `ip=` line. Returns "" on failure.
 *
 * Ports v2go's fetchExitIP (internal/tester/tester.go): same endpoint, same
 * parsing, same empty-string-on-malformed behavior.
 */
export async function testProxyExitIp(socksPort, timeoutMs = 4000) {
  try {
    const agent = socksAgent(socksPort);
    const res = await fetch(TRACE_URL, {
      agent,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "9router-xray-test/1.0" },
    });
    if (!res.ok) return "";
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("ip=")) {
        const ip = line.slice(3).trim();
        // Basic IP validation — reject obviously garbage values.
        if (/^[\d.a-fA-F:]+$/.test(ip)) return ip;
      }
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Combined health probe: latency + exit IP in one call.
 * @returns {Promise<{ ok: boolean, latencyMs: number, exitIp: string }>}
 */
export async function testProxy(socksPort, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const latencyMs = await testProxyLatency(socksPort, timeoutMs);
  if (latencyMs < 0) return { ok: false, latencyMs: -1, exitIp: "" };
  const exitIp = await testProxyExitIp(socksPort);
  return { ok: true, latencyMs, exitIp };
}

/**
 * Quick TCP-level probe: is anything listening on the SOCKS port?
 * Cheaper than a full proxy round-trip — used to detect port conflicts and
 * confirm the process is accepting connections before a latency test.
 */
export function isSocksPortOpen(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}
