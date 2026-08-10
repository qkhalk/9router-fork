/**
 * V2Ray/xray proxy manager — the orchestration facade.
 *
 * Pulls together every moving piece: install xray, pick/select a config from
 * the DB catalog, build a client config, spawn the process, probe SOCKS health,
 * and expose a proxy pool to the rest of 9router so provider connections can
 * route through the active server.
 *
 * This is the single source of truth for xray runtime state. API routes and
 * the boot sequence talk to this module; nothing else spawns xray directly.
 *
 * Lifecycle: stopped → starting → running (↔ error). Switching servers is a
 * restart with a new config.json (the v2rayN convention, see plan).
 */

import fs from "node:fs";
import { buildClientConfig, validateLink } from "./configBuilder.js";
import { convertLink } from "./parser.js";
import {
  isXrayInstalled,
  getXrayConfigPath,
  getXrayBinaryPath,
  getInstalledVersion,
  getXrayRuntimeVersion,
  installXray,
} from "./installer.js";
import {
  startManagedXray,
  stopXray,
  restartXray,
  getManagedPid,
  getXrayLogTail,
  spawnTempXray,
} from "./process.js";
import { testProxy, testProxyLatency, isSocksPortOpen } from "./tester.js";
import {
  getSelectedXrayConfig,
  getXrayConfigById,
  setSelectedXrayConfig,
  updateXrayTestResult,
  getXrayConfigs,
  getXraySyncState,
} from "../db/repos/xrayRepo.js";
import {
  getProxyPoolById,
  createProxyPool,
  updateProxyPool,
} from "../db/repos/proxyPoolsRepo.js";
import { getSettings, updateSettings } from "../db/repos/settingsRepo.js";

// Fixed pool id so re-runs update the same row rather than creating dupes.
const MANAGED_POOL_ID = "v2go-xray-managed";

// In-memory runtime state. Persisted bits (selected config id, ports, version)
// live in the settings blob + xrayConfigs table.
const state = {
  status: "stopped", // stopped | starting | running | error
  pid: null,
  activeConfigId: null,
  socksPort: null,
  httpPort: null,
  lastError: null,
  lastHealthAt: null,
  lastHealth: null, // { latencyMs, exitIp }
};

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
}

/** Current runtime status snapshot. */
export function getStatus() {
  const pid = getManagedPid();
  // Reconcile in-memory state with reality: if a managed pid is alive but the
  // in-memory status says "stopped" (e.g. after Next.js HMR reset module state),
  // report "running". Ports are read from settings as a fallback.
  const effectiveStatus = pid && state.status === "stopped" ? "running" : (pid ? state.status : "stopped");
  return {
    status: effectiveStatus,
    pid,
    binaryInstalled: isXrayInstalled(),
    binaryPath: isXrayInstalled() ? getXrayBinaryPath() : null,
    installedVersion: getInstalledVersion(),
    activeConfigId: state.activeConfigId,
    socksPort: state.socksPort,
    httpPort: state.httpPort,
    lastError: state.lastError,
    lastHealthAt: state.lastHealthAt,
    lastHealth: state.lastHealth,
  };
}

/**
 * Write the client config.json for the given outbound to disk.
 * @param {object} outbound — from convertLink
 * @param {{ socksPort: number, httpPort: number }} ports
 */
function writeConfig(outbound, { socksPort, httpPort }) {
  const configPath = getXrayConfigPath();
  const config = buildClientConfig(outbound, { socksPort, httpPort });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Create or refresh the managed proxy pool so the rest of 9router can route
 * through the local SOCKS port like any other proxy pool. The pool is marked
 * with _v2goManaged so it is visually distinguishable from user-created pools.
 */
async function syncManagedPool(active, socksPort, configId) {
  const proxyUrl = `socks5://127.0.0.1:${socksPort}`;
  const existing = await getProxyPoolById(MANAGED_POOL_ID);
  const data = {
    name: "V2Ray Proxy (v2go)",
    proxyUrl,
    type: "socks5",
    isActive: active,
    strictProxy: false,
    testStatus: active ? "unknown" : "offline",
    _v2goManaged: true,
    _v2goConfigId: configId || null,
  };
  if (existing) {
    await updateProxyPool(MANAGED_POOL_ID, data);
  } else {
    await createProxyPool({ id: MANAGED_POOL_ID, ...data });
  }
}

/**
 * Start the xray service. If no configId is given, uses the selected config
 * from the DB (or the healthiest active one). Writes config.json, spawns the
 * process, waits for the SOCKS port, runs a health probe, and syncs the pool.
 *
 * @param {{ configId?: string }} opts
 * @throws {Error} with code NOT_INSTALLED | NO_CONFIG | NO_BINARY | STARTUP_FAILED
 */
export async function startXrayService(opts = {}) {
  if (!isXrayInstalled()) {
    const e = new Error("Xray binary is not installed. Install it from the dashboard first.");
    e.code = "NOT_INSTALLED";
    throw e;
  }

  const settings = await getSettings();
  const socksPort = Number(settings.xraySocksPort) || 10808;
  const httpPort = Number(settings.xrayHttpPort) || 10809;

  // Resolve which config to run.
  let config = opts.configId ? await getXrayConfigById(opts.configId) : null;
  if (!config) config = await getSelectedXrayConfig();
  if (!config) {
    // Fall back to the first active config.
    const all = await getXrayConfigs({ isActive: true });
    config = all[0];
  }
  if (!config) {
    const e = new Error("No V2Ray configs available. Run a subscription sync first.");
    e.code = "NO_CONFIG";
    throw e;
  }

  // Validate the link produces a runnable outbound before spawning.
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config "${config.name}" is not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  setStatus("starting", { lastError: null });

  try {
    const configPath = writeConfig(v.outbound, { socksPort, httpPort });
    const { pid } = await startManagedXray({ configPath });

    // Wait for the SOCKS port to accept connections (process is up + inbound bound).
    let ready = false;
    for (let i = 0; i < 20; i++) {
      if (await isSocksPortOpen(socksPort)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) {
      stopXray();
      const e = new Error("SOCKS port did not open within 6s — check xray.log");
      e.code = "STARTUP_FAILED";
      setStatus("error", { lastError: e.message });
      throw e;
    }

    // Persist selection + ports.
    await setSelectedXrayConfig(config.id);
    await updateSettings({ xraySelectedConfigId: config.id });

    // Health probe (non-fatal if it fails — the process is up).
    const health = await testProxy(socksPort);
    if (health.ok) {
      await updateXrayTestResult(config.id, health);
    }

    await syncManagedPool(true, socksPort, config.id);
    setStatus("running", {
      pid,
      activeConfigId: config.id,
      socksPort,
      httpPort,
      lastHealth: health.ok ? health : null,
      lastHealthAt: new Date().toISOString(),
    });

    return { pid, configId: config.id, health };
  } catch (e) {
    setStatus("error", { lastError: e.message });
    await syncManagedPool(false, socksPort, null);
    throw e;
  }
}

/** Stop the xray process and mark the managed pool inactive. */
export async function stopXrayService() {
  const result = stopXray();
  const settings = await getSettings();
  const socksPort = Number(settings.xraySocksPort) || 10808;
  await syncManagedPool(false, socksPort, null);
  setStatus("stopped", { pid: null, activeConfigId: null, lastError: null });
  return result;
}

/**
 * Switch to a different server. Records the selection, restarts the process
 * with the new config, and refreshes health. Equivalent to startXrayService
 * with an explicit configId but uses restart instead of cold start.
 */
export async function switchConfig(configId) {
  const config = await getXrayConfigById(configId);
  if (!config) {
    const e = new Error(`Config ${configId} not found`);
    e.code = "NOT_FOUND";
    throw e;
  }
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config "${config.name}" is not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  const settings = await getSettings();
  const socksPort = Number(settings.xraySocksPort) || 10808;
  const httpPort = Number(settings.xrayHttpPort) || 10809;

  setStatus("starting", { lastError: null });
  try {
    const configPath = writeConfig(v.outbound, { socksPort, httpPort });
    const { pid } = await restartXray({ configPath });

    let ready = false;
    for (let i = 0; i < 20; i++) {
      if (await isSocksPortOpen(socksPort)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) {
      const e = new Error("SOCKS port did not open after switch");
      e.code = "STARTUP_FAILED";
      setStatus("error", { lastError: e.message });
      throw e;
    }

    await setSelectedXrayConfig(config.id);
    await updateSettings({ xraySelectedConfigId: config.id });

    const health = await testProxy(socksPort);
    if (health.ok) await updateXrayTestResult(config.id, health);

    await syncManagedPool(true, socksPort, config.id);
    setStatus("running", {
      pid,
      activeConfigId: config.id,
      socksPort,
      httpPort,
      lastHealth: health.ok ? health : null,
      lastHealthAt: new Date().toISOString(),
    });
    return { pid, configId: config.id, health };
  } catch (e) {
    setStatus("error", { lastError: e.message });
    throw e;
  }
}

/** Restart the active config (e.g. after a port change in settings). */
export async function restartXrayService() {
  const current = state.activeConfigId;
  if (!current) return startXrayService();
  return switchConfig(current);
}

/**
 * Test a single config's latency without disturbing the active service.
 * Spawns an ISOLATED temporary xray on an ephemeral port, probes, kills —
 * the active proxy (if any) keeps running untouched. Used by the per-row
 * "Test" button in the UI.
 *
 * @returns {Promise<{ latencyMs: number, exitIp: string }>}
 */
export async function testSingleConfig(configId) {
  const config = await getXrayConfigById(configId);
  if (!config) {
    const e = new Error(`Config ${configId} not found`);
    e.code = "NOT_FOUND";
    throw e;
  }
  if (!isXrayInstalled()) {
    const e = new Error("Xray binary is not installed");
    e.code = "NOT_INSTALLED";
    throw e;
  }
  const v = validateLink(config.link);
  if (!v.ok) {
    const e = new Error(`Config not usable: ${v.error}`);
    e.code = "BAD_CONFIG";
    throw e;
  }

  // Use an ephemeral high port unlikely to collide with the active instance.
  const tempSocks = 51808 + Math.floor(Math.random() * 1000);
  const tempHttp = tempSocks + 1;
  const tempConfigPath = getXrayConfigPath() + `.test-${configId}.json`;
  const tempConfig = buildClientConfig(v.outbound, { socksPort: tempSocks, httpPort: tempHttp });
  fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig, null, 2));

  let tempHandle = null;
  try {
    tempHandle = await spawnTempXray({ configPath: tempConfigPath });
    // Wait briefly for the temp port to accept connections.
    for (let i = 0; i < 15; i++) {
      if (await isSocksPortOpen(tempSocks)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const health = await testProxy(tempSocks, 8000);
    await updateXrayTestResult(config.id, health);
    return health;
  } finally {
    // Kill the isolated temp instance — does NOT touch the shared PID file.
    if (tempHandle) tempHandle.kill();
    try { fs.unlinkSync(tempConfigPath); } catch {}
  }
}

/**
 * Periodic health check of the active proxy + a sample of alternatives.
 * Updates latency rankings so the UI can recommend fast servers. If the
 * active server is dead and autoRotate is on, switches to the next best.
 */
export async function runHealthCheck() {
  const settings = await getSettings();
  // Recover from HMR: if the in-memory state was reset but a managed pid is
  // alive, treat the service as running and read the port from settings.
  const pid = getManagedPid();
  if (!pid) return { skipped: true };
  const socksPort = state.socksPort || Number(settings.xraySocksPort) || 10808;
  const activeConfigId = state.activeConfigId || settings.xraySelectedConfigId || null;
  if (state.status === "stopped") setStatus("running", { pid, socksPort, activeConfigId });

  // Probe the active server.
  const latencyMs = await testProxyLatency(socksPort);
  state.lastHealthAt = new Date().toISOString();
  if (latencyMs > 0 && activeConfigId) {
    state.lastHealth = { latencyMs, exitIp: state.lastHealth?.exitIp || "" };
    await updateXrayTestResult(activeConfigId, { latencyMs, ok: true });
  } else if (activeConfigId) {
    await updateXrayTestResult(activeConfigId, { ok: false });
    state.lastHealth = null;
    // Auto-rotate to the next healthy server if enabled.
    if (settings.xrayAutoRotate) {
      const all = await getXrayConfigs({ isActive: true, healthyOnly: false });
      const next = all.find((c) => c.id !== activeConfigId);
      if (next) {
        try {
          console.log(`[Xray] active server unhealthy, auto-rotating to ${next.name}`);
          await switchConfig(next.id);
        } catch (e) {
          console.error(`[Xray] auto-rotation failed: ${e.message}`);
          setStatus("error", { lastError: e.message });
        }
      }
    }
  }
  return { latencyMs, activeConfigId };
}

export { installXray, getXrayRuntimeVersion, getXrayLogTail, getXraySyncState };
export { MANAGED_POOL_ID };
