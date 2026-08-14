/**
 * SOCKS-capable dispatcher factory for undici.
 *
 * undici's ProxyAgent only speaks HTTP CONNECT. Feeding it a socks:// URL makes
 * it open a TCP connection to the SOCKS server and send an HTTP CONNECT line,
 * which the SOCKS inbound can't parse — the server drops the connection and
 * the request dies mid-TLS-handshake with "Client network socket disconnected
 * before secure TLS connection was established (ECONNRESET)".
 *
 * For SOCKS proxies (socks4/4a/5/5h, optional user/pass) we instead build a
 * plain undici Agent whose custom connector tunnels each origin connection
 * through the proxy via the `socks` library and performs the TLS upgrade
 * itself for https targets — the same contract undici's default connector
 * fulfils (a custom connector owns TLS: undici will not wrap the socket).
 */

import tls from "node:tls";
import { Agent } from "undici";
import { SocksClient } from "socks";

const SOCKS_SCHEMES = new Set(["socks5:", "socks5h:", "socks4:", "socks4a:"]);

export function isSocksProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== "string") return false;
  try {
    return SOCKS_SCHEMES.has(new URL(proxyUrl).protocol);
  } catch {
    return false;
  }
}

const DEFAULT_SOCKS_PORT = 1080;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Build an undici Agent that connects to origins through a SOCKS proxy.
 *
 * @param {string} proxyUrl - canonical socks(4|4a|5|5h)://[user:pass@]host:port
 * @param {object} [agentOptions] - extra options forwarded to undici's Agent
 * @returns {import("undici").Agent}
 */
export function createSocksDispatcher(proxyUrl, agentOptions = {}) {
  const parsed = new URL(proxyUrl);
  const type = parsed.protocol === "socks4:" || parsed.protocol === "socks4a:" ? 4 : 5;
  const proxy = {
    host: parsed.hostname,
    port: Number(parsed.port) || DEFAULT_SOCKS_PORT,
    type,
  };
  if (parsed.username) proxy.userId = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);

  return new Agent({
    ...agentOptions,
    connect: async ({ hostname, protocol, port, servername, httpSocket }, callback) => {
      if (httpSocket) {
        callback(new Error("SOCKS connector does not support upgrading an existing socket"));
        return;
      }
      // Custom connectors fire the callback exactly once; guard against the
      // TLS socket emitting both secureConnect and error.
      let settled = false;
      const once = (err, socket) => {
        if (settled) return;
        settled = true;
        callback(err, socket);
      };

      try {
        // Hostname destinations are sent as ATYP=Hostname for socks5, i.e. the
        // proxy resolves them (socks5h semantics) — never leaked to local DNS.
        const { socket } = await SocksClient.createConnection({
          proxy,
          command: "connect",
          destination: {
            host: hostname,
            port: Number(port) || (protocol === "https:" ? 443 : 80),
          },
          timeout: CONNECT_TIMEOUT_MS,
        });
        socket.setKeepAlive(true, 60_000);
        socket.setNoDelay(true);

        if (protocol !== "https:") {
          once(null, socket);
          return;
        }

        const tlsSocket = tls.connect({
          socket,
          servername: servername || hostname,
          ALPNProtocols: ["http/1.1"],
        });
        tlsSocket.once("secureConnect", () => once(null, tlsSocket));
        tlsSocket.once("error", (err) => once(err));
        socket.once("error", (err) => once(err));
      } catch (err) {
        once(err);
      }
    },
  });
}
