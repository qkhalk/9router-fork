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
import path from "node:path";
import { buildClientConfig, validateLink } from "./configBuilder.js";
import { reapOrphanedTempProbes } from "./reaper.js";
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
import { testProxy, testProxyLatency, isSocksPortOpen, testProxyExitIpWithUri } from "./tester.js";
import { startFilterXray, stopFilterXray, probeConfigViaApi } from "./apiFilter.js";
import {
  getSelectedXrayConfig,
  getXrayConfigById,
  setSelectedXrayConfig,
  updateXrayTestResult,
  getXrayConfigs,
  getXraySyncState,
  deleteXrayConfig,
} from "../db/repos/xrayRepo.js";
import {
  getModelFilterResultsByConfigIds,
  getModelFilterCacheStats,
  upsertModelFilterResult,
  clearModelFilterResultsByModel,
  deleteModelFilterResultsByConfigIds,
} from "../db/repos/modelFilterResultsRepo.js";
import {
  getProxyPoolById,
  createProxyPool,
  updateProxyPool,
} from "../db/repos/proxyPoolsRepo.js";
import { getSettings, updateSettings } from "../db/repos/settingsRepo.js";
import { getModelInfo } from "@/sse/services/model.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import {
  getActiveLiveTrafficCount,
  getLiveTrafficQuietForMs,
  waitForLiveTrafficQuiet,
} from "./modelFilterTraffic.js";

// Fixed pool id so re-runs update the same row rather than creating dupes.
const MANAGED_POOL_ID = "v2go-xray-managed";

const silentProbeLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  line() {},
  errorLine() {},
  request() {},
  response() {},
  stream() {},
  nextTag() { return ""; },
  tagForSession() { return ""; },
  fmtThink() { return null; },
  maskKey(key) { return key ? "***" : ""; },
};

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

const modelFilterState = {
  status: "idle", // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  source: null,
  model: null,
  all: false,
  limit: 50,
  prune: false,
  concurrency: 2,
  pauseOnTraffic: true,
  quietMs: 15000,
  tested: 0,
  passed: 0,
  failed: 0,
  pruned: 0,
  cached: 0,
  trafficWaiters: 0,
  error: null,
};

// Mirror of getModelFilterCacheStats(), refreshed at job boundaries and on
// cache mutations. Kept in-memory so the (sync) status reader can surface it
// without making the status endpoint async.
let modelFilterCacheStats = { total: 0, byModel: {} };
// Whether the snapshot has been seeded since boot. getStatus() kicks off a
// background refresh once so the cache badge is correct on first page load.
let modelFilterCacheStatsSeeded = false;

async function refreshModelFilterCacheStats() {
  try {
    modelFilterCacheStats = await getModelFilterCacheStats();
  } catch {
    // leave the previous snapshot in place on failure
  }
}

export { refreshModelFilterCacheStats };

// True while a filter job is mid-flight. Used by the clear-cache endpoint to
// reject concurrent cache wipes that would race with in-progress writes.
export function isModelFilterRunning() {
  return modelFilterRunning != null;
}

let modelFilterRunning = null;
const allocatedTempSocksPorts = new Set();

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
  // Lazy-seed the cache-stats snapshot once after boot so the badge reflects
  // rows persisted from prior sessions (survives restarts). Fire-and-forget;
  // the next poll picks up the refreshed numbers.
  if (!modelFilterCacheStatsSeeded) {
    modelFilterCacheStatsSeeded = true;
    refreshModelFilterCacheStats();
  }
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
    modelFilter: getModelFilterStatus(),
  };
}

export function getModelFilterStatus() {
  const quietForMs = getLiveTrafficQuietForMs();
  return {
    ...modelFilterState,
    liveTraffic: {
      active: getActiveLiveTrafficCount(),
      quietForMs: Number.isFinite(quietForMs) ? quietForMs : null,
    },
    cache: { ...modelFilterCacheStats },
  };
}

export function updateRunningModelFilterOptions(options = {}) {
  if (!modelFilterRunning) return false;
  if (Object.prototype.hasOwnProperty.call(options, "pauseOnTraffic")) {
    modelFilterState.pauseOnTraffic = options.pauseOnTraffic === true;
  }
  if (Object.prototype.hasOwnProperty.call(options, "quietMs")) {
    modelFilterState.quietMs = Math.max(3000, Math.min(Number(options.quietMs) || 15000, 120000));
  }
  return true;
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

// Re-export the orphan reaper (defined in ./reaper.js, a dependency-free module
// so it can be statically imported at app boot without pulling manager.js).
export { reapOrphanedTempProbes };

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
    strictProxy: true,
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

  // Note: orphan reaping runs at app boot in initializeApp.runHeavyStartup,
  // independent of this function, so it fires even when the managed xray is
  // already running and we early-return below.

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

async function spawnTempConfig(config, timeoutMs = 8000) {
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

  let tempSocks = 51808 + Math.floor(Math.random() * 1000);
  for (let i = 0; i < 1200 && allocatedTempSocksPorts.has(tempSocks); i++) {
    tempSocks = 51808 + Math.floor(Math.random() * 1000);
  }
  allocatedTempSocksPorts.add(tempSocks);
  const tempHttp = tempSocks + 1;
  const tempConfigPath = getXrayConfigPath() + `.model-test-${config.id}.json`;
  const tempConfig = buildClientConfig(v.outbound, { socksPort: tempSocks, httpPort: tempHttp });
  fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig, null, 2));

  let tempHandle;
  try {
    tempHandle = await spawnTempXray({ configPath: tempConfigPath });
  } catch (error) {
    allocatedTempSocksPorts.delete(tempSocks);
    try { fs.unlinkSync(tempConfigPath); } catch {}
    throw error;
  }
  let ready = false;
  for (let i = 0; i < 15; i++) {
    if (await isSocksPortOpen(tempSocks)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) {
    tempHandle.kill();
    allocatedTempSocksPorts.delete(tempSocks);
    try { fs.unlinkSync(tempConfigPath); } catch {}
    const e = new Error("SOCKS port did not open for temp model test");
    e.code = "STARTUP_FAILED";
    throw e;
  }

  return {
    socksPort: tempSocks,
    cleanup() {
      tempHandle.kill();
      allocatedTempSocksPorts.delete(tempSocks);
      try { fs.unlinkSync(tempConfigPath); } catch {}
    },
    timeoutMs,
  };
}

function summarizeProbeBody(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || parsed?.error || text.slice(0, 240);
  } catch {
    return text.slice(0, 240);
  }
}

/**
 * Test whether a single Xray config can actually reach a routed model/provider.
 * This uses the same chatCore/executor path as normal requests, but injects a
 * temporary strict SOCKS proxy so failure cannot silently fall back to direct.
 */
export async function testSingleConfigWithModel(configId, { model: modelStr, timeoutMs = 20000 } = {}) {
  if (!modelStr || typeof modelStr !== "string") {
    const e = new Error("model is required");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const config = await getXrayConfigById(configId);
  if (!config) {
    const e = new Error(`Config ${configId} not found`);
    e.code = "NOT_FOUND";
    throw e;
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo?.provider || !modelInfo?.model) {
    const e = new Error(`Invalid model: ${modelStr}`);
    e.code = "BAD_MODEL";
    throw e;
  }

  const temp = await spawnTempConfig(config, timeoutMs);
  const startedAt = Date.now();
  try {
    const baseCredentials = await getProviderCredentials(modelInfo.provider, new Set(), modelInfo.model);
    if (!baseCredentials || baseCredentials.allRateLimited) {
      const e = new Error(`No active credentials for provider: ${modelInfo.provider}`);
      e.code = "NO_CREDENTIALS";
      throw e;
    }

    const refreshed = await checkAndRefreshToken(modelInfo.provider, baseCredentials);
    const credentials = {
      ...refreshed,
      providerSpecificData: {
        ...(refreshed.providerSpecificData || {}),
        connectionProxyEnabled: true,
        connectionProxyUrl: `socks5://127.0.0.1:${temp.socksPort}`,
        connectionNoProxy: "",
        connectionProxyPoolId: "xray-model-filter",
        strictProxy: true,
      },
    };
    const settings = await getSettings();
    const result = await handleChatCore({
      body: {
        model: `${modelInfo.provider}/${modelInfo.model}`,
        max_tokens: 1,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo,
      credentials,
      log: silentProbeLog,
      clientRawRequest: {
        endpoint: "/api/xray/configs/model-test",
        body: { model: modelStr, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] },
        headers: { accept: "application/json", "content-type": "application/json", "x-9r-internal": "xray-model-filter" },
      },
      connectionId: baseCredentials.connectionId,
      userAgent: "9router-xray-model-filter/1.0",
      apiKey: null,
      ccFilterNaming: false,
      rtkEnabled: false,
      headroomEnabled: false,
      headroomUrl: settings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: false,
      cavemanEnabled: false,
      cavemanLevel: "full",
      ponytailEnabled: false,
      ponytailLevel: "full",
      pxpipeEnabled: false,
      pxpipeMinChars: settings.pxpipeMinChars,
      pxpipeTimeoutMs: settings.pxpipeTimeoutMs,
      pxpipeTransform: null,
      providerThinking: null,
      sourceFormatOverride: "openai",
    });

    const latencyMs = Date.now() - startedAt;
    if (!result.success) {
      await updateXrayTestResult(config.id, { ok: false });
      return { ok: false, latencyMs, status: result.status || 502, error: result.error || "Model probe failed" };
    }

    const rawText = await result.response.text().catch(() => "");
    if (!result.response.ok) {
      await updateXrayTestResult(config.id, { ok: false });
      return {
        ok: false,
        latencyMs,
        status: result.response.status,
        error: summarizeProbeBody(rawText) || `HTTP ${result.response.status}`,
      };
    }

    const health = await testProxy(temp.socksPort, Math.min(timeoutMs, 8000));
    await updateXrayTestResult(config.id, health.ok ? health : { ok: true, latencyMs });
    return {
      ok: true,
      latencyMs,
      status: result.response.status,
      exitIp: health.exitIp || "",
      error: null,
    };
  } finally {
    temp.cleanup();
  }
}

function normalizeModelFilterLimit({ limit = 50, all = false } = {}) {
  if (all === true || limit === "all") return { all: true, limit: null };
  return { all: false, limit: Math.max(1, Math.min(Number(limit) || 50, 500)) };
}

function normalizeModelFilterConcurrency(concurrency = 2) {
  return Math.max(1, Math.min(Number(concurrency) || 2, 16));
}

/**
 * Build the probe function used by api-mode filter. Each call:
 *  1. Adds the config's outbound + a user-routing rule to the shared filter xray.
 *  2. Probes the model endpoint via handleChatCore through the routed SOCKS.
 *  3. Records the exit IP observed through that SOCKS.
 *  4. Tears down rule + outbound (atomic).
 *
 * Returns the same shape as testSingleConfigWithModel so the rest of the
 * pipeline (cache, prune, results) is unchanged.
 */
function makeApiProbeFn(apiHandle, modelInfo, modelStr, timeoutMs) {
  return async (config, workerIdx) => {
    if (!modelInfo?.provider || !modelInfo?.model) {
      throw new Error(`Invalid model for api probe: ${modelStr}`);
    }
    return probeConfigViaApi(apiHandle, config, workerIdx, {
      timeoutMs,
      probeExitIp: async ({ socksUri, timeoutMs: tm }) => testProxyExitIpWithUri(socksUri, tm),
      probeModel: async ({ socksUri, timeoutMs: tm }) =>
        probeModelViaChatCore(modelInfo, socksUri, tm),
    });
  };
}

/**
 * Probe the model endpoint through a given SOCKS URI by invoking handleChatCore
 * with a minimal "hi" request, mirroring testSingleConfigWithModel's chat path
 * but without spawning a temp xray (the SOCKS is already routed by api-mode).
 * Returns { ok, status, error }.
 */
async function probeModelViaChatCore(modelInfo, socksUri, timeoutMs) {
  const baseCredentials = await getProviderCredentials(modelInfo.provider, new Set(), modelInfo.model);
  if (!baseCredentials || baseCredentials.allRateLimited) {
    return { ok: false, status: 503, error: "No active credentials for provider" };
  }
  const refreshed = await checkAndRefreshToken(modelInfo.provider, baseCredentials);
  const credentials = {
    ...refreshed,
    providerSpecificData: {
      ...(refreshed.providerSpecificData || {}),
      connectionProxyEnabled: true,
      connectionProxyUrl: socksUri,
      connectionNoProxy: "",
      connectionProxyPoolId: "xray-model-filter-api",
      strictProxy: true,
    },
  };
  const settings = await getSettings();
  const startedAt = Date.now();
  const result = await handleChatCore({
    body: {
      model: `${modelInfo.provider}/${modelInfo.model}`,
      max_tokens: 1,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo,
    credentials,
    log: silentProbeLog,
    clientRawRequest: {
      endpoint: "/api/xray/configs/model-test",
      body: { model: `${modelInfo.provider}/${modelInfo.model}`, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] },
      headers: { accept: "application/json", "content-type": "application/json", "x-9r-internal": "xray-model-filter" },
    },
    connectionId: baseCredentials.connectionId,
    userAgent: "9router-xray-model-filter-api/1.0",
    apiKey: null,
    ccFilterNaming: false,
    rtkEnabled: false,
    headroomEnabled: false,
    headroomUrl: settings.headroomUrl || DEFAULT_HEADROOM_URL,
    headroomCompressUserMessages: false,
    cavemanEnabled: false,
    cavemanLevel: "full",
    ponytailEnabled: false,
    ponytailLevel: "full",
    pxpipeEnabled: false,
    pxpipeMinChars: settings.pxpipeMinChars,
    pxpipeTimeoutMs: settings.pxpipeTimeoutMs,
    pxpipeTransform: null,
    providerThinking: null,
    sourceFormatOverride: "openai",
  });
  if (!result.success) {
    return { ok: false, status: result.status || 502, error: result.error || "probe failed" };
  }
  if (!result.response.ok) {
    const text = await result.response.text().catch(() => "");
    return { ok: false, status: result.response.status, error: summarizeProbeBody(text) || `HTTP ${result.response.status}` };
  }
  return { ok: true, status: result.response.status, error: null, _ttft: Date.now() - startedAt };
}

export async function filterConfigsByModel({ model, limit = 50, all = false, prune = false, timeoutMs = 20000, concurrency = 2, pauseOnTraffic = true, quietMs = 15000, onProgress = null, forceRetest = false } = {}) {
  const configs = await getXrayConfigs({ isActive: true });
  // Resolve model info up front — api-mode needs it to build probe credentials.
  const modelInfo = await getModelInfo(model).catch(() => null);
  const settings = await getSettings();
  const runningActiveConfigId = getManagedPid()
    ? (state.activeConfigId || settings.xraySelectedConfigId || null)
    : null;
  const normalized = normalizeModelFilterLimit({ limit, all });
  const selected = normalized.all ? configs : configs.slice(0, normalized.limit);

  // Cache layer: configs with a fresh cached result for this model are reused
  // instead of re-probed. forceRetest bypasses the cache entirely (the caller
  // also clears the model's cache before invoking). The cache key is the
  // (configId, model) pair — configId is a sha1 of the canonical link, so a
  // config whose underlying server/credentials change is naturally a new id
  // and therefore a fresh cache entry.
  //
  // Two freshness knobs (settings, in hours, 0 = legacy/forever):
  //  - xrayModelFilterCacheTtlH: a SUCCESS row older than this is re-tested.
  //  - xrayModelFilterRetryFailAfterH: a FAIL row older than this is retried,
  //    so a server that was temporarily down isn't blacklisted forever.
  let toTest = selected;
  // Bypass the cache entirely when forceRetest or prune is on:
  //  - forceRetest: caller already cleared this model's cache; nothing to hit.
  //  - prune: destructive mode — always re-probe fresh so maybePruneConfig
  //    gets the chance to run on every selected config. Otherwise a cached
  //    failed row would be reused and silently skip deletion.
  const useCache = !forceRetest && !prune;
  const cacheTtlMs = (Number(settings.xrayModelFilterCacheTtlH) || 0) * 3600 * 1000;
  // For the cache lookup, honor the success TTL: rows older than cacheTtlMs are
  // excluded entirely. Failed-row retry is handled separately below (fail rows
  // within retryFailAfterH are NOT in the success-TTL-gated map, so they'll be
  // treated as "to test" naturally; but fail rows older than the success TTL
  // would also drop out — which is fine, they need re-test anyway).
  const retryFailMs = (Number(settings.xrayModelFilterRetryFailAfterH) || 0) * 3600 * 1000;
  // Build TWO maps: success-only (for reuse), and all-recent (for fail-retry gating).
  // For reuse we want successes that are still within the success TTL.
  // For fail-retry we need to know which fails are old enough to re-test.
  const reuseMap = useCache
    ? await getModelFilterResultsByConfigIds(selected.map((c) => c.id), model, {
        maxAgeMs: cacheTtlMs > 0 ? cacheTtlMs : 0,
      })
    : new Map();
  const failMap = useCache
    ? await getModelFilterResultsByConfigIds(selected.map((c) => c.id), model, { maxAgeMs: 0 })
    : new Map();

  const now = Date.now();
  const isFailRetryDue = (configId) => {
    if (retryFailMs <= 0) return false; // policy disabled
    const row = failMap.get(configId);
    if (!row || row.ok) return false;
    const testedAt = row.testedAt ? Date.parse(row.testedAt) : 0;
    if (!testedAt) return true; // unparseable/missing timestamp → re-test
    return now - testedAt >= retryFailMs;
  };

  const results = [];
  for (const config of selected) {
    const cached = reuseMap.get(config.id);
    // Only reuse SUCCESS rows whose TTL is still valid. Fail rows are never
    // reused — they're either re-tested (if retry due) or skipped this pass.
    if (!cached || !cached.ok) continue;
    const result = {
      configId: config.id,
      name: config.name,
      host: config.host,
      country: config.country,
      ok: cached.ok,
      latencyMs: cached.latencyMs,
      status: cached.status,
      exitIp: cached.exitIp,
      error: cached.error,
      cached: true,
      testedAt: cached.testedAt,
    };
    results.push(result);
    onProgress?.(result);
  }
  // Re-test: configs with no reuse success AND (no row at all OR fail-retry due).
  toTest = selected.filter((c) => {
    if (reuseMap.has(c.id) && reuseMap.get(c.id).ok) return false; // reused
    const anyRow = failMap.get(c.id);
    if (!anyRow) return true; // never tested
    // Has a row but not reused (fail, or success-expired). Re-test.
    if (anyRow.ok) return true; // success but expired past TTL
    return isFailRetryDue(c.id); // fail: only re-test if retry policy due
  });

  // When every selected config is cached (toTest empty) the worker pool is a
  // no-op; keep at least 1 worker so the pool initializes harmlessly.
  const workerCount = Math.min(normalizeModelFilterConcurrency(concurrency), toTest.length || 1);
  let cursor = 0;

  const maybePruneConfig = async (config, result) => {
    if (!prune || result.ok) return result;
    if (runningActiveConfigId && config.id === runningActiveConfigId) {
      return { ...result, pruned: false, pruneSkipped: "active_config_running" };
    }
    await deleteXrayConfig(config.id);
    // Cascade: the config row is gone, so its cache entries are meaningless.
    await deleteModelFilterResultsByConfigIds([config.id]).catch(() => {});
    return { ...result, pruned: true };
  };

  // Persist a fresh probe result so subsequent runs (incl. after a restart or
  // re-sync that leaves the config unchanged) can skip it. Skipped when the
  // config was pruned — the row no longer exists. Awaited so the post-job
  // cache-stats snapshot reflects this run's writes.
  const recordCache = async (config, result) => {
    if (result.pruned === true || result.pruneSkipped) return;
    try {
      await upsertModelFilterResult({
        configId: config.id,
        model,
        ok: !!result.ok,
        latencyMs: result.latencyMs,
        status: result.status,
        exitIp: result.exitIp,
        error: result.error,
      });
    } catch {
      // cache write failure is non-fatal — next run will re-probe
    }
  };

  const testConfig = async (config, probeFn, workerIdx) => {
    const shouldPauseForTraffic = () => (modelFilterRunning ? modelFilterState.pauseOnTraffic : pauseOnTraffic === true);
    if (shouldPauseForTraffic()) {
      modelFilterState.trafficWaiters += 1;
      try {
        await waitForLiveTrafficQuiet({
          quietMs: modelFilterRunning ? modelFilterState.quietMs : quietMs,
          maxWaitMs: 10 * 60 * 1000,
          shouldContinue: shouldPauseForTraffic,
        });
      } finally {
        modelFilterState.trafficWaiters = Math.max(0, modelFilterState.trafficWaiters - 1);
      }
    }
    try {
      const probe = await probeFn(config, workerIdx);
      let result = { configId: config.id, name: config.name, host: config.host, country: config.country, ...probe };
      result = await maybePruneConfig(config, result);
      results.push(result);
      await recordCache(config, result);
      onProgress?.(result);
    } catch (error) {
      let failed = {
        configId: config.id,
        name: config.name,
        host: config.host,
        country: config.country,
        ok: false,
        latencyMs: -1,
        status: null,
        error: error.message,
      };
      await updateXrayTestResult(config.id, { ok: false }).catch(() => {});
      failed = await maybePruneConfig(config, failed);
      results.push(failed);
      await recordCache(config, failed);
      onProgress?.(failed);
    }
  };

  // Probe function + filter-xray lifecycle. api-mode keeps one long-lived xray
  // and swaps outbounds via the gRPC API; spawn-mode spawns a fresh temp xray
  // per config. api-mode falls back to spawn if the filter instance can't start
  // (binary too old, port conflict, etc.). forceRetest/prune always use spawn
  // mode (they need fully isolated temp xray state).
  const wantApiMode = settings.xrayFilterMode === "api" && !forceRetest && !prune;
  let apiHandle = null;
  let probeFn = null;
  let apiMode = false;
  if (wantApiMode) {
    try {
      apiHandle = await startFilterXray({
        socksPort: Number(settings.xrayFilterApiSocksPort) || 53080,
        apiPort: Number(settings.xrayFilterApiPort) || 15491,
        accountCount: Math.min(Math.max(Number(settings.xrayFilterApiAccounts) || 16, 1), Math.max(workerCount, 1)),
      });
      probeFn = makeApiProbeFn(apiHandle, modelInfo, model, timeoutMs);
      apiMode = true;
      console.log(`[Xray] model filter running in api-mode (socks=${apiHandle.socksPort} api=${apiHandle.apiPort} pid=${apiHandle.pid})`);
    } catch (e) {
      console.warn(`[Xray] api-mode filter start failed, falling back to spawn mode: ${e.message}`);
      apiHandle = null;
    }
  }
  if (!apiMode) {
    probeFn = (config) => testSingleConfigWithModel(config.id, { model, timeoutMs });
  }

  const workers = Array.from({ length: workerCount }, async (_, workerIdx) => {
    while (cursor < toTest.length) {
      const index = cursor;
      cursor += 1;
      await testConfig(toTest[index], probeFn, workerIdx);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    if (apiHandle) {
      await stopFilterXray(apiHandle).catch(() => {});
    }
  }

  const cachedCount = results.filter((r) => r.cached).length;
  return {
    model,
    all: normalized.all,
    limit: normalized.all ? "all" : normalized.limit,
    concurrency: workerCount,
    filterMode: apiMode ? "api" : "spawn",
    tested: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    pruned: results.filter((r) => r.pruned === true).length,
    pruneSkipped: results.filter((r) => r.pruneSkipped).length,
    cached: cachedCount,
    results,
  };
}

export async function runModelFilterJob({ model, limit = 50, all = false, prune = false, timeoutMs = 20000, concurrency = 2, pauseOnTraffic = true, quietMs = 15000, source = "manual", forceRetest = false } = {}) {
  if (modelFilterRunning) {
    return { skipped: true, reason: "already_running", ...getModelFilterStatus() };
  }

  const normalized = normalizeModelFilterLimit({ limit, all });
  const normalizedConcurrency = normalizeModelFilterConcurrency(concurrency);
  const job = (async () => {
    Object.assign(modelFilterState, {
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      source,
      model,
      all: normalized.all,
      limit: normalized.all ? "all" : normalized.limit,
      prune: prune === true,
      concurrency: normalizedConcurrency,
      pauseOnTraffic: pauseOnTraffic === true,
      quietMs,
      tested: 0,
      passed: 0,
      failed: 0,
      pruned: 0,
      cached: 0,
      trafficWaiters: 0,
      error: null,
    });

    try {
      // forceRetest wipes the cache for this model so every selected config is
      // re-probed fresh. Done before the probe loop so the splitter in
      // filterConfigsByModel finds nothing to skip.
      if (forceRetest) await clearModelFilterResultsByModel(model).catch(() => {});
      await refreshModelFilterCacheStats();

      const result = await filterConfigsByModel({
        model,
        limit: normalized.limit,
        all: normalized.all,
        prune,
        timeoutMs,
        concurrency: normalizedConcurrency,
        pauseOnTraffic,
        quietMs,
        forceRetest,
        onProgress: (result) => {
          modelFilterState.tested += 1;
          if (result.cached) modelFilterState.cached += 1;
          if (result.ok) modelFilterState.passed += 1;
          else modelFilterState.failed += 1;
          if (result.pruned === true) modelFilterState.pruned += 1;
        },
      });
      Object.assign(modelFilterState, {
        status: "done",
        finishedAt: new Date().toISOString(),
        tested: result.tested,
        passed: result.passed,
        failed: result.failed,
        pruned: result.pruned,
        cached: result.cached,
        trafficWaiters: 0,
        error: null,
      });
      return result;
    } catch (error) {
      Object.assign(modelFilterState, {
        status: "error",
        finishedAt: new Date().toISOString(),
        trafficWaiters: 0,
        error: error.message,
      });
      throw error;
    } finally {
      modelFilterRunning = null;
      await refreshModelFilterCacheStats();
    }
  })();

  modelFilterRunning = job;
  return job;
}

export async function runModelFilterFromSettings(source = "auto-sync") {
  const settings = await getSettings();
  if (settings.xrayModelFilterEnabled !== true) return { skipped: true, reason: "disabled" };
  const model = String(settings.xrayModelFilterModel || "").trim();
  if (!model) return { skipped: true, reason: "missing_model" };
  return runModelFilterJob({
    model,
    limit: settings.xrayModelFilterLimit,
    all: settings.xrayModelFilterAll === true,
    prune: settings.xrayModelFilterPrune === true,
    concurrency: Number(settings.xrayModelFilterConcurrency) || 2,
    pauseOnTraffic: settings.xrayModelFilterPauseOnTraffic !== false,
    quietMs: Number(settings.xrayModelFilterQuietMs) || 15000,
    timeoutMs: Number(settings.xrayModelFilterTimeoutMs) || 20000,
    source,
  });
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
