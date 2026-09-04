// Phase 02 smoke: manager.js (heavily edited for X4/X6) still imports, and
// its public surface is intact — switchConfig exists (serialized wrapper),
// doSwitchConfig is the inner implementation.
import { describe, expect, it, vi } from "vitest";

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

describe("xray manager post-edit smoke (X4/X6)", () => {
  it("imports and exposes the expected surface", () => {
    expect(typeof manager.switchConfig).toBe("function");
    expect(typeof manager.doSwitchConfig).toBe("function");
    expect(typeof manager.runHealthCheck).toBe("function");
    expect(typeof manager.stopXrayService).toBe("function");
    expect(typeof manager.startXrayService).toBe("function");
  });

  it("switchConfig rejects unknown configs (wrapper passes errors through)", async () => {
    const repo = await import("../../src/lib/db/repos/xrayRepo.js");
    repo.getXrayConfigById.mockResolvedValueOnce(null);
    await expect(manager.switchConfig("missing")).rejects.toThrow("Config missing not found");
  });
});
