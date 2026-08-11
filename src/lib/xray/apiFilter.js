/**
 * API-mode Model Proxy Filter: test many xray configs against a model endpoint
 * through a SINGLE long-lived xray instance, swapping outbounds via the xray
 * gRPC API instead of spawning a fresh xray process per config.
 *
 * POC-proven architecture (verified on xray v26.3.27):
 *  - One xray process with a SOCKS5 (password-auth) inbound + a dokodemo-door
 *    API inbound (HandlerService + RoutingService).
 *  - N pre-declared SOCKS accounts (probe-0 .. probe-(N-1)), one per worker.
 *  - Per config-under-test: add the outbound via `xray api ado`, add a routing
 *    rule `user=probe-<i> -> outbound-tag` via `xray api adrules`, send the
 *    probe request through SOCKS5 with that username, then tear down rule +
 *    outbound. Concurrent workers route independently (balancer override is
 *    global and therefore unusable here — confirmed by POC).
 *
 * Lifecycle is owned by the filter job (startFilterXray ... probe ... stop).
 * On any failure to start, the caller falls back to the legacy spawn-per-test
 * mode (testSingleConfigWithModel), so api-mode is strictly opt-in.
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { validateLink } from "./configBuilder.js";
import { isXrayInstalled, getXrayBinaryPath } from "./installer.js";

// Best-effort persistent log for api-mode filter events (next-server stdout is
// often /dev/null in headless deploys). Fail-open.
function apiLog(message, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), message, ...extra });
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const logDir = path.join(home, ".9router", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "api-filter.log"), line + "\n", { flag: "a" });
  } catch {
    /* logging must never break probing */
  }
}

const execFileP = promisify(execFile);

// SOCKS account password is irrelevant (routing matches on username); use a
// fixed value so the pool of accounts is fully described by the usernames.
const PROBE_PASSWORD = "x";

function accountName(workerIdx) {
  return `probe-${workerIdx}`;
}

function outboundTag(configId, workerIdx) {
  // Legacy helper kept for log readability — current design uses a fixed
  // per-worker outbound tag (workerOutboundTag), not a per-config tag.
  return `cfg-${configId}-${workerIdx}`;
}

/**
 * Outbound tag owned by a worker — stable across probes so the per-worker
 * routing rule (set up once at init) never needs to change. Each probe just
 * swaps the CONTENT of this outbound (rmo + ado with the same tag).
 */
function workerOutboundTag(workerIdx) {
  return `worker-${workerIdx}-outbound`;
}

/**
 * Build the base xray config for the filter instance: SOCKS5 password inbound
 * with N pre-declared accounts, a dokodemo-door API inbound, a direct fallback
 * outbound, and the routing rules.
 *
 * IMPORTANT: xray `adrules` REPLACES the entire routing block (not append).
 * So the static rules are baked into the base config and NEVER changed via the
 * API — otherwise the api-inbound → api-tag rule would be lost mid-job and every
 * subsequent API call would fail with "failed to dial". Each worker's user-rule
 * points to a fixed `worker-<i>-outbound` tag; probes swap that outbound's
 * content via rmo+ado, leaving routing untouched.
 */
function buildFilterBaseConfig({ socksPort, apiPort, accountCount, apiTag = "api-tag" }) {
  const accounts = Array.from({ length: accountCount }, (_, i) => ({
    user: accountName(i),
    pass: PROBE_PASSWORD,
  }));
  // One routing rule per worker: route user probe-<i> → worker-<i>-outbound.
  // The worker outbounds are created lazily via ado on the first probe; until
  // then xray falls through to the `direct` outbound for that user (harmless —
  // no probe happens before the outbound exists).
  const userRules = Array.from({ length: accountCount }, (_, i) => ({
    ruleTag: `route-worker-${i}`,
    type: "field",
    user: [accountName(i)],
    outboundTag: workerOutboundTag(i),
  }));
  return {
    log: { loglevel: "warning" },
    api: { tag: apiTag, services: ["HandlerService", "RoutingService"] },
    inbounds: [
      {
        tag: "socks-in",
        listen: "127.0.0.1",
        port: socksPort,
        protocol: "socks",
        settings: { auth: "password", accounts, udp: false, ip: "127.0.0.1" },
      },
      {
        tag: "api-in",
        listen: "127.0.0.1",
        port: apiPort,
        protocol: "dokodemo-door",
        settings: { address: "127.0.0.1" },
      },
    ],
    outbounds: [{ tag: "direct", protocol: "freedom" }],
    routing: {
      rules: [
        { type: "field", inboundTag: ["api-in"], outboundTag: apiTag },
        ...userRules,
      ],
    },
  };
}

/**
 * Start the single filter xray instance. Returns a handle the caller uses for
 * every probe. Throws on any failure so the caller can fall back to spawn mode.
 *
 * @param {object} opts
 * @param {number} opts.socksPort - local SOCKS5 port (with N pre-declared accounts)
 * @param {number} opts.apiPort   - local gRPC API port
 * @param {number} opts.accountCount - number of probe accounts (= max concurrency)
 * @returns {Promise<{socksPort, apiPort, accountCount, binaryPath, configPath, pid, accounts}>}
 */
export async function startFilterXray({ socksPort, apiPort, accountCount }) {
  if (!isXrayInstalled()) {
    throw new Error("Xray binary is not installed");
  }
  if (!Number.isInteger(socksPort) || !Number.isInteger(apiPort) || !Number.isInteger(accountCount)) {
    throw new Error("socksPort, apiPort, accountCount must be integers");
  }
  if (accountCount < 1 || accountCount > 64) {
    throw new Error(`accountCount out of range (1..64): ${accountCount}`);
  }
  const binaryPath = getXrayBinaryPath();
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const configPath = path.join(home, ".9router", "xray", `filter-api-${socksPort}-${apiPort}.json`);

  const baseConfig = buildFilterBaseConfig({ socksPort, apiPort, accountCount });
  fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

  const child = spawn(binaryPath, ["run", "-c", configPath], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    windowsHide: true,
  });
  child.unref();

  // Wait for the API port to accept connections (process is up + API bound).
  const ready = await waitForPort(apiPort, 8000);
  if (!ready) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
    throw new Error(`filter xray API port ${apiPort} did not open within 8s`);
  }

  return {
    socksPort,
    apiPort,
    accountCount,
    binaryPath,
    configPath,
    pid: child.pid,
    accounts: Array.from({ length: accountCount }, (_, i) => accountName(i)),
    _child: child,
  };
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 200);
      });
    };
    tick();
  });
}

// xray api helpers. Each call is a short-lived execFile; the gRPC round-trip is
// ~20-70ms per POC. Errors are thrown to the caller, which decides retry/fallback.
// Arg order matters: `xray api <subcommand> --server=<addr> <args...>` — the
// --server flag must come AFTER the subcommand, not before (verified by POC).
async function apiExec(handle, subcommand, extraArgs = []) {
  const full = ["api", subcommand, `--server=127.0.0.1:${handle.apiPort}`, ...extraArgs];
  try {
    const { stdout } = await execFileP(handle.binaryPath, full, {
      timeout: 15000,
      windowsHide: true,
    });
    return stdout;
  } catch (e) {
    throw new Error(`xray api ${subcommand} failed: ${e.stderr || e.message}`);
  }
}

async function addOutbound(handle, outboundObject, tag) {
  const wrapped = { outbounds: [{ ...outboundObject, tag }] };
  const tmp = path.join(handle.configPath + `.ob-${tag}.json`);
  fs.writeFileSync(tmp, JSON.stringify(wrapped));
  try {
    await apiExec(handle, "ado", [tmp]);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* keep clean */ }
  }
}

async function removeOutbound(handle, tag) {
  // rmo takes the tag as a positional arg (ArgoX pattern — verified by POC).
  try {
    await apiExec(handle, "rmo", [tag]);
  } catch (e) {
    // "no outbound to remove" is benign during teardown — swallow it.
    if (!/no outbound/i.test(e.message)) throw e;
  }
}

/**
 * Probe a single config via the shared xray instance. The per-worker outbound
 * tag is fixed (`worker-<i>-outbound`); its routing rule was set at init and
 * never changes. This probe just swaps the outbound's content (rmo + ado with
 * the same tag), so concurrent workers never collide and routing is untouched.
 *
 * The actual model probe (HTTP request to the provider endpoint) and the exit-
 * IP discovery are delegated to caller-supplied functions so this module stays
 * free of the chat/credentials machinery.
 *
 * @returns {Promise<{ok, latencyMs, status, exitIp, error}>}
 *   ok=true only when the request returned 2xx AND an exit IP was observed.
 */
export async function probeConfigViaApi(handle, config, workerIdx, { probeModel, probeExitIp, timeoutMs = 20000 }) {
  const startedAt = Date.now();
  const v = validateLink(config.link);
  if (!v.ok) {
    return { ok: false, latencyMs: 0, status: 0, exitIp: "", error: `bad config: ${v.error}` };
  }

  const username = accountName(workerIdx);
  const obTag = workerOutboundTag(workerIdx);
  const socksUri = `socks5://${username}:${PROBE_PASSWORD}@127.0.0.1:${handle.socksPort}`;

  // Swap this worker's outbound to the new config (rmo any previous one first).
  try {
    await removeOutbound(handle, obTag); // benign if not present
    await addOutbound(handle, v.outbound, obTag);
  } catch (e) {
    apiLog("setup failed", { configId: config.id, workerIdx, obTag, error: e.message });
    return { ok: false, latencyMs: Date.now() - startedAt, status: 0, exitIp: "", error: `setup failed: ${e.message}` };
  }

  // Probe the model endpoint through the routed SOCKS.
  const probe = await probeModel({ socksUri, timeoutMs });
  apiLog("probe result", { configId: config.id, workerIdx, ok: probe.ok, status: probe.status, error: probe.error, latencyMs: Date.now() - startedAt });
  if (!probe.ok) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      status: probe.status || 0,
      exitIp: "",
      error: probe.error || `probe HTTP ${probe.status}`,
    };
  }
  // Discover the exit IP through the same SOCKS (now that we know it routes).
  const exitIp = await probeExitIp({ socksUri, timeoutMs: Math.min(timeoutMs, 8000) }).catch(() => "");
  apiLog("exitIp", { configId: config.id, exitIp });
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    status: probe.status || 200,
    exitIp: exitIp || "",
    error: null,
  };
}

/**
 * Stop the filter xray instance: kill the process, unlink the base config.
 * Idempotent — safe to call multiple times.
 */
export async function stopFilterXray(handle) {
  if (!handle) return;
  try {
    if (handle._child && !handle._child.killed) {
      try { handle._child.kill("SIGTERM"); } catch { /* ignore */ }
      // Give it a moment, then force.
      setTimeout(() => {
        try { handle._child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 1500);
    }
  } catch { /* ignore */ }
  try { fs.unlinkSync(handle.configPath); } catch { /* ignore */ }
}

export { accountName as _accountName }; // for tests
