// Phase 01 (P8): triggerManagedRotationOnProxyError single-flight — the
// cooldown-bypass decision spans an await, so a synchronous guard must prevent
// concurrent callers from starting overlapping rotations in that window.
import { beforeEach, describe, expect, it, vi } from "vitest";

const switchConfigMock = vi.fn(async () => {});
let selectedConfigResolveDelayMs = 0;
let selectedConfig = { id: "active-1", name: "Active", lastExitIp: "1.1.1.1" };

vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  getSelectedXrayConfig: vi.fn(async () => {
    if (selectedConfigResolveDelayMs) await new Promise((r) => setTimeout(r, selectedConfigResolveDelayMs));
    return selectedConfig;
  }),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  getNextHealthyConfigsForModel: vi.fn(async () => [
    { configId: "fresh-ip", name: "Fresh IP node", latencyMs: 150, exitIp: "2.2.2.2" },
    { configId: "fresh-ip-2", name: "Fresh IP node 2", latencyMs: 160, exitIp: "3.3.3.3" },
  ]),
  getModelFilterResult: vi.fn(async () => ({ configId: "active-1", ok: 1, exitIp: "1.1.1.1" })),
}));
vi.mock("../../src/lib/xray/manager.js", () => ({
  switchConfig: switchConfigMock,
}));

const { triggerManagedRotationOnProxyError, _resetManagedRotationState } = await import(
  "../../src/lib/xray/managedRotation.js"
);

beforeEach(() => {
  _resetManagedRotationState();
  switchConfigMock.mockClear();
  selectedConfigResolveDelayMs = 0;
  selectedConfig = { id: "active-1", name: "Active", lastExitIp: "1.1.1.1" };
});

describe("single-flight cooldown-bypass decision (P8)", () => {
  it("a caller arriving mid-decision does not start a second rotation", async () => {
    // 1. Burn a rotation so we land inside the cooldown window.
    const first = await triggerManagedRotationOnProxyError({ status: 429, error: "rate limit", model: "m" });
    expect(first.rotated).toBe(true);
    expect(switchConfigMock).toHaveBeenCalledTimes(1);
    // The active config is now the one we rotated to → bypass would be true.
    selectedConfig = { id: "fresh-ip", name: "Fresh", lastExitIp: "2.2.2.2" };

    // 2. Slow the bypass probe so the decision window is observable.
    selectedConfigResolveDelayMs = 40;

    // 3. Caller A enters the decision window and stays there.
    const a = triggerManagedRotationOnProxyError({ status: 429, error: "rate limit", model: "m" });
    await new Promise((r) => setTimeout(r, 5)); // A is now awaiting shouldBypassCooldown

    // 4. Caller B arrives mid-decision: must be coalesced away, not queued
    //    into a second rotation.
    const b = await triggerManagedRotationOnProxyError({ status: 429, error: "rate limit", model: "m" });
    expect(b).toEqual({ rotated: false, reason: "cooldown" });

    const aRes = await a;
    expect(aRes.rotated).toBe(true);
    // Exactly ONE rotation from the bypass path — not one per concurrent caller.
    expect(switchConfigMock).toHaveBeenCalledTimes(2);
  });

  it("sequential decisions each run their own probe; bypass=false then bypass=true", async () => {
    const first = await triggerManagedRotationOnProxyError({ status: 429, error: "rate limit", model: "m" });
    expect(first.rotated).toBe(true);
    expect(first.toConfigId).toBe("fresh-ip");
    selectedConfigResolveDelayMs = 20;

    // Active config is NOT the last rotated-to → bypass=false → cooldown,
    // and the deciding flag must clear so the next call runs its own probe.
    const duringCooldown = await triggerManagedRotationOnProxyError({ status: 429, error: "rate limit", model: "m" });
    expect(duringCooldown).toEqual({ rotated: false, reason: "cooldown" });

    // Now the active config IS the last rotated-to → bypass fires and the
    // next distinct candidate rotates in (flag was cleared, not stuck).
    selectedConfig = { id: "fresh-ip", name: "Fresh", lastExitIp: "2.2.2.2" };
    const bypassed = await triggerManagedRotationOnProxyError({ status: 429, error: "rate limit", model: "m" });
    expect(bypassed.rotated).toBe(true);
    expect(bypassed.toConfigId).toBe("fresh-ip-2");
  });
});
