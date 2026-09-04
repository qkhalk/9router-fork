import { describe, it, expect, vi } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => {
    throw new Error("adapter not needed for mergeWithDefaults");
  }),
}));

import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// S6: tunnel dashboard access must be opt-in. An absent key resolves to false
// (previously it inherited the permissive default `true`); an explicitly saved
// value — either way — keeps winning.
describe("mergeWithDefaults tunnelDashboardAccess (S6)", () => {
  it("resolves to false when the key was never saved", () => {
    const merged = mergeWithDefaults({});
    expect(merged.tunnelDashboardAccess).toBe(false);
  });

  it("preserves an explicit true from an old install that relied on the default", () => {
    const merged = mergeWithDefaults({ tunnelDashboardAccess: true });
    expect(merged.tunnelDashboardAccess).toBe(true);
  });

  it("preserves an explicit false", () => {
    const merged = mergeWithDefaults({ tunnelDashboardAccess: false });
    expect(merged.tunnelDashboardAccess).toBe(false);
  });

  it("treats an explicitly-undefined stored value as absent (fail-closed)", () => {
    const merged = mergeWithDefaults({ tunnelDashboardAccess: undefined });
    expect(merged.tunnelDashboardAccess).toBe(false);
  });
});
