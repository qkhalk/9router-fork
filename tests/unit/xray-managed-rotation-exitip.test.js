/**
 * Managed-pool rotation guards (blue-green switch era):
 *  - rotation must skip candidates that share the active config's exit IP
 *    (a per-IP rate limit can't be dodged by switching to the same IP)
 *  - rotation must pass avoidExitIps to switchConfig for live verification
 *  - "terminated" (undici mid-body abort) must classify as a connection
 *    failure so the chat loop retries instead of rotating
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.NINEROUTER_ROTATION_LOG = path.join(os.tmpdir(), "9router-test-rotation.log");

const switchConfigMock = vi.fn(async (configId) => ({ pid: 4242, configId }));

vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  getSelectedXrayConfig: vi.fn(async () => ({ id: "active-1", name: "Active", lastExitIp: "1.1.1.1" })),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  getNextHealthyConfigsForModel: vi.fn(async () => [
    { configId: "same-ip", name: "Same IP node", latencyMs: 100, exitIp: "1.1.1.1" },
    { configId: "fresh-ip", name: "Fresh IP node", latencyMs: 150, exitIp: "2.2.2.2" },
    { configId: "unknown-ip", name: "Unknown IP node", latencyMs: 200, exitIp: null },
  ]),
  getModelFilterResult: vi.fn(async () => ({ configId: "active-1", ok: 1, exitIp: "1.1.1.1" })),
}));
vi.mock("../../src/lib/xray/manager.js", () => ({
  switchConfig: switchConfigMock,
}));

const { triggerManagedRotationOnProxyError, _resetManagedRotationState } = await import(
  "../../src/lib/xray/managedRotation.js"
);
const { isConnectionFailure, isProxyRotatableError } = await import(
  "../../src/lib/network/proxyRotation.js"
);

describe("managed rotation exit-IP dedup", () => {
  beforeEach(() => {
    _resetManagedRotationState();
    switchConfigMock.mockClear();
  });

  it("skips the candidate sharing the active exit IP and passes avoidExitIps for live verify", async () => {
    const res = await triggerManagedRotationOnProxyError({
      status: 429,
      error: "FreeUsageLimitError: Rate limit exceeded",
      model: "oc/deepseek-v4-flash-free",
    });
    expect(res.rotated).toBe(true);
    expect(switchConfigMock).toHaveBeenCalledTimes(1);
    const [configId, opts] = switchConfigMock.mock.calls[0];
    expect(configId).toBe("fresh-ip");
    expect(opts.avoidExitIps).toBeInstanceOf(Set);
    expect(opts.avoidExitIps.has("1.1.1.1")).toBe(true);
  });

  it("aborts (no switch) when every candidate shares the active exit IP", async () => {
    const repo = await import("../../src/lib/db/repos/modelFilterResultsRepo.js");
    repo.getNextHealthyConfigsForModel.mockResolvedValueOnce([
      { configId: "dup-a", name: "dup a", latencyMs: 10, exitIp: "1.1.1.1" },
      { configId: "dup-b", name: "dup b", latencyMs: 20, exitIp: "1.1.1.1" },
    ]);
    const res = await triggerManagedRotationOnProxyError({
      status: 429,
      error: "FreeUsageLimitError",
      model: "oc/deepseek-v4-flash-free",
    });
    expect(res.rotated).toBe(false);
    expect(res.reason).toBe("no-distinct-exit-ip-candidate");
    expect(switchConfigMock).not.toHaveBeenCalled();
  });

  it("still attempts unknown-exit-IP candidates (live-verified by switchConfig)", async () => {
    const repo = await import("../../src/lib/db/repos/modelFilterResultsRepo.js");
    repo.getNextHealthyConfigsForModel.mockResolvedValueOnce([
      { configId: "same-ip", name: "same", latencyMs: 10, exitIp: "1.1.1.1" },
      { configId: "unknown-ip", name: "unknown", latencyMs: 20, exitIp: null },
    ]);
    const res = await triggerManagedRotationOnProxyError({
      status: 429,
      error: "Rate limit exceeded",
      model: "oc/deepseek-v4-flash-free",
    });
    expect(res.rotated).toBe(true);
    expect(switchConfigMock.mock.calls[0][0]).toBe("unknown-ip");
  });
});

describe("connection-failure classification", () => {
  it("recognizes undici terminated (mid-stream abort) as a connection failure", () => {
    expect(isConnectionFailure("terminated TypeError: terminated at Fetch.onAborted")).toBe(true);
    expect(isConnectionFailure("ERROR: terminated · 19484ms")).toBe(true);
  });

  it("keeps classifying upstream HTTP errors as non-connection failures", () => {
    expect(isConnectionFailure('429 {"type":"error","error":{"type":"FreeUsageLimitError"}}')).toBe(false);
    expect(isConnectionFailure("Error from provider (Console): Rate limit exceeded")).toBe(false);
  });

  it("still treats 429 as rotatable (unchanged proxy-rotation semantics)", () => {
    expect(isProxyRotatableError(429, "FreeUsageLimitError")).toBe(true);
    expect(isProxyRotatableError(502, "fetch failed")).toBe(true); // by status — caller must combine with isConnectionFailure
  });
});

afterAll(() => {
  try { fs.unlinkSync(process.env.NINEROUTER_ROTATION_LOG); } catch { /* gone */ }
});
