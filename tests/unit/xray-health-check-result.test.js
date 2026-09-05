// Phase 07: runHealthCheck's additive rotation-outcome return fields, which
// the health scheduler maps to xray-rotation-failed. Same mock harness as
// xray-manager-smoke.test.js (manager.js deps virtualized).
import { beforeEach, describe, expect, it, vi } from "vitest";

const alerts = vi.hoisted(() => ({ emitAlert: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => importOriginal());
vi.mock("../../src/lib/xray/configBuilder.js", () => ({
  buildClientConfig: vi.fn(),
  validateLink: vi.fn(() => ({ ok: true })),
}));
vi.mock("../../src/lib/xray/reaper.js", () => ({ reapOrphanedTempProbes: vi.fn() }));
vi.mock("../../src/lib/xray/parser.js", () => ({ convertLink: vi.fn() }));
vi.mock("../../src/lib/xray/installer.js", () => ({
  isXrayInstalled: vi.fn(() => false),
  getXrayConfigPath: vi.fn(() => "/tmp/xray/config.json"),
  getXrayBinaryPath: vi.fn(() => "/tmp/xray/xray"),
  getInstalledVersion: vi.fn(() => null),
  getXrayRuntimeVersion: vi.fn(async () => null),
  installXray: vi.fn(),
  getXrayDir: vi.fn(() => "/tmp/xray"),
}));
vi.mock("../../src/lib/xray/process.js", () => ({
  startManagedXray: vi.fn(),
  stopXray: vi.fn(() => ({ stopped: false })),
  getManagedPid: vi.fn(() => null),
  getVerifiedManagedPid: vi.fn(() => null),
  getXrayLogTail: vi.fn(() => ""),
  spawnTempXray: vi.fn(),
  spawnNextManagedXray: vi.fn(),
  setManagedPid: vi.fn(),
  terminateXrayPid: vi.fn(async () => {}),
  getDrainingPids: vi.fn(() => []),
  addDrainingPid: vi.fn(),
  removeDrainingPid: vi.fn(),
}));
vi.mock("../../src/lib/xray/tester.js", () => ({
  testProxy: vi.fn(),
  testProxyLatency: vi.fn(async () => 0),
  isSocksPortOpen: vi.fn(async () => false),
  testProxyExitIpWithUri: vi.fn(),
  waitForSocksPortOpen: vi.fn(async () => false),
}));
vi.mock("../../src/lib/xray/apiFilter.js", () => ({
  startFilterXray: vi.fn(),
  stopFilterXray: vi.fn(),
  probeConfigViaApi: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  getSelectedXrayConfig: vi.fn(async () => null),
  getXrayConfigById: vi.fn(async () => null),
  setSelectedXrayConfig: vi.fn(),
  updateXrayTestResult: vi.fn(),
  getXrayConfigs: vi.fn(async () => []),
  getXraySyncState: vi.fn(async () => ({})),
  deleteXrayConfig: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  getModelFilterResultsByConfigIds: vi.fn(async () => []),
  getModelFilterCacheStats: vi.fn(async () => ({})),
  upsertModelFilterResult: vi.fn(),
  clearModelFilterResultsByModel: vi.fn(),
  deleteModelFilterResultsByConfigIds: vi.fn(),
  getNextHealthyConfigsForModel: vi.fn(async () => []),
  getModelFilterResult: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/proxyPoolsRepo.js", () => ({
  getProxyPoolById: vi.fn(async () => null),
  createProxyPool: vi.fn(),
  updateProxyPool: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/alerts", () => ({
  emitAlert: alerts.emitAlert,
  EVENT_TYPES: { XRAY_NODE_DOWN: "xray-node-down", XRAY_ROTATION_FAILED: "xray-rotation-failed" },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }), { virtual: true });
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "https://example.com" }), { virtual: true });
vi.mock("../../src/lib/xray/modelFilterTraffic.js", () => ({
  getActiveLiveTrafficCount: vi.fn(() => 0),
  getLiveTrafficQuietForMs: vi.fn(() => 99999),
  waitForLiveTrafficQuiet: vi.fn(async () => true),
  beginLiveModelTraffic: vi.fn(),
  wrapLiveModelResponse: vi.fn(),
}));
vi.mock("../../src/lib/xray/modelProbe.js", () => ({
  buildModelProbeBody: vi.fn(),
  withProbeTimeout: vi.fn(),
}));

const manager = await import("../../src/lib/xray/manager.js");
const processMod = await import("../../src/lib/xray/process.js");
const tester = await import("../../src/lib/xray/tester.js");
const xrayRepo = await import("../../src/lib/db/repos/xrayRepo.js");
const settingsRepo = await import("../../src/lib/db/repos/settingsRepo.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => { });
  vi.spyOn(console, "warn").mockImplementation(() => { });
  vi.spyOn(console, "error").mockImplementation(() => { });
});

function xrayOn({ latency = 0, configs = [], settings = {} } = {}) {
  processMod.getManagedPid.mockReturnValue(4242);
  tester.testProxyLatency.mockResolvedValue(latency);
  xrayRepo.getXrayConfigs.mockResolvedValue(configs);
  settingsRepo.getSettings.mockResolvedValue({
    xraySelectedConfigId: "cfg-active",
    xrayAutoRotate: true,
    ...settings,
  });
}

describe("runHealthCheck rotation-outcome return fields (phase 07)", () => {
  it("no managed pid → { skipped: true }", async () => {
    processMod.getManagedPid.mockReturnValue(null);
    const res = await manager.runHealthCheck();
    expect(res).toEqual({ skipped: true });
  });

  it("healthy active node → latencyMs + no rotation flags", async () => {
    xrayOn({ latency: 120 });
    const res = await manager.runHealthCheck();
    expect(res.latencyMs).toBe(120);
    expect(res.activeConfigId).toBe("cfg-active");
    expect(res.rotatedTo).toBeNull();
    expect(res.rotationFailed).toBe(false);
    expect(res.rotationError).toBeUndefined();
    expect(alerts.emitAlert).not.toHaveBeenCalled();
  });

  it("dead node, rotation attempted and failed → rotationFailed true with reason", async () => {
    // Candidate exists but switchConfig fails (config lookup misses → throws).
    xrayOn({ latency: 0, configs: [{ id: "cfg-2", name: "n2" }] });
    xrayRepo.getXrayConfigById.mockResolvedValue(null);
    const res = await manager.runHealthCheck();
    expect(res.latencyMs).toBe(0);
    expect(res.rotatedTo).toBeNull();
    expect(res.rotationFailed).toBe(true);
    expect(res.rotationError).toContain("auto-rotation failed for all 1 candidate(s)");
    // node-down is phase-05's emit inside runHealthCheck; rotation alert is the
    // scheduler's job — neither emits here for rotation, only node-down:
    expect(alerts.emitAlert).toHaveBeenCalledWith("xray-node-down", expect.anything());
  });

  it("dead node, no candidates (single-node install) → rotationFailed stays false", async () => {
    xrayOn({ latency: 0, configs: [] });
    const res = await manager.runHealthCheck();
    expect(res.rotationFailed).toBe(false);
    expect(res.rotationError).toBeUndefined();
  });

  it("dead node, autoRotate disabled → no rotation flags", async () => {
    xrayOn({ latency: 0, configs: [{ id: "cfg-2", name: "n2" }], settings: { xrayAutoRotate: false } });
    const res = await manager.runHealthCheck();
    expect(res.rotationFailed).toBe(false);
    expect(res.rotatedTo).toBeNull();
  });
});
