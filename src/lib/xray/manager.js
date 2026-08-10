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
  deleteXrayConfig,
} from "../db/repos/xrayRepo.js";
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
  concurrency: 4,
  tested: 0,
  passed: 0,
  failed: 0,
  pruned: 0,
  error: null,
};

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
  return { ...modelFilterState };
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
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo,
      credentials,
      log: silentProbeLog,
      clientRawRequest: {
        endpoint: "/api/xray/configs/model-test",
        body: { model: modelStr, max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] },
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

function normalizeModelFilterConcurrency(concurrency = 4) {
  return Math.max(1, Math.min(Number(concurrency) || 4, 16));
}

export async function filterConfigsByModel({ model, limit = 50, all = false, prune = false, timeoutMs = 20000, concurrency = 4, onProgress = null } = {}) {
  const configs = await getXrayConfigs({ isActive: true });
  const normalized = normalizeModelFilterLimit({ limit, all });
  const selected = normalized.all ? configs : configs.slice(0, normalized.limit);
  const workerCount = Math.min(normalizeModelFilterConcurrency(concurrency), selected.length || 1);
  const results = [];
  let cursor = 0;

  const testConfig = async (config) => {
    try {
      const probe = await testSingleConfigWithModel(config.id, { model, timeoutMs });
      const result = { configId: config.id, name: config.name, host: config.host, country: config.country, ...probe };
      results.push(result);
      if (prune && !probe.ok) await deleteXrayConfig(config.id);
      onProgress?.(result);
    } catch (error) {
      const failed = {
        configId: config.id,
        name: config.name,
        host: config.host,
        country: config.country,
        ok: false,
        latencyMs: -1,
        status: null,
        error: error.message,
      };
      results.push(failed);
      await updateXrayTestResult(config.id, { ok: false }).catch(() => {});
      if (prune) await deleteXrayConfig(config.id);
      onProgress?.(failed);
    }
  };

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      await testConfig(selected[index]);
    }
  });
  await Promise.all(workers);

  return {
    model,
    all: normalized.all,
    limit: normalized.all ? "all" : normalized.limit,
    concurrency: workerCount,
    tested: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    pruned: prune ? results.filter((r) => !r.ok).length : 0,
    results,
  };
}

export async function runModelFilterJob({ model, limit = 50, all = false, prune = false, timeoutMs = 20000, concurrency = 4, source = "manual" } = {}) {
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
      tested: 0,
      passed: 0,
      failed: 0,
      pruned: 0,
      error: null,
    });

    try {
      const result = await filterConfigsByModel({
        model,
        limit: normalized.limit,
        all: normalized.all,
        prune,
        timeoutMs,
        concurrency: normalizedConcurrency,
        onProgress: (result) => {
          modelFilterState.tested += 1;
          if (result.ok) modelFilterState.passed += 1;
          else modelFilterState.failed += 1;
          if (prune && !result.ok) modelFilterState.pruned += 1;
        },
      });
      Object.assign(modelFilterState, {
        status: "done",
        finishedAt: new Date().toISOString(),
        tested: result.tested,
        passed: result.passed,
        failed: result.failed,
        pruned: result.pruned,
        error: null,
      });
      return result;
    } catch (error) {
      Object.assign(modelFilterState, {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: error.message,
      });
      throw error;
    } finally {
      modelFilterRunning = null;
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
    concurrency: Number(settings.xrayModelFilterConcurrency) || 4,
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
