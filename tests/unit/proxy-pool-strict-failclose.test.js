// Phase 01 (P1/N3/P4): strict-proxy fail-closed contract of
// resolveConnectionProxyConfig — a strict pool with no usable entry must
// surface an explicit failure signal, never an empty/direct proxy config.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  stampProxyEntryUsed: vi.fn(async () => null),
  getProxyPools: vi.fn(async () => []),
  updateProxyPool: vi.fn(async () => null),
}));

import { getProxyPoolById } from "@/models";
import {
  resolveConnectionProxyConfig,
  isStrictProxyFailure,
} from "@/lib/network/connectionProxy";

const NOW = Date.now();

function groupPool({ strictProxy = true, entries = [], isActive = true } = {}) {
  return {
    id: "pool-1",
    name: "strict group",
    isGroup: true,
    isActive,
    strictProxy,
    proxyUrl: "",
    noProxy: "",
    entries,
  };
}

function entry(id, overrides = {}) {
  return {
    id,
    name: id,
    type: "http",
    proxyUrl: `http://${id}:8080`,
    isActive: true,
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getProxyPoolById).mockReset();
});

describe("strict pool failures are explicit (fail-closed)", () => {
  it("inactive strict pool → source exhausted, no proxy URL, strictProxy true", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(groupPool({ isActive: false }));
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("exhausted");
    expect(res.strictProxy).toBe(true);
    expect(res.connectionProxyUrl).toBe("");
    expect(res.connectionProxyEnabled).toBe(false);
    expect(isStrictProxyFailure(res)).toBe(true);
  });

  it("strict group with all entries on cooldown → exhausted", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(
      groupPool({ entries: [entry("e1", { cooldownUntil: NOW + 60_000 }), entry("e2", { cooldownUntil: NOW + 60_000 })] })
    );
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("exhausted");
    expect(isStrictProxyFailure(res)).toBe(true);
  });

  it("strict group whose entries all have empty URLs → exhausted (P4 feeds P1)", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(
      groupPool({ entries: [entry("e1", { proxyUrl: "" }), entry("e2", { proxyUrl: "  " })] })
    );
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("exhausted");
    expect(isStrictProxyFailure(res)).toBe(true);
  });

  it("standard strict pool with empty proxyUrl → exhausted", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue({
      id: "pool-1",
      isActive: true,
      strictProxy: true,
      proxyUrl: "",
      noProxy: "",
    });
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("exhausted");
    expect(isStrictProxyFailure(res)).toBe(true);
  });

  it("failure AFTER the strict flag was read → source error with strictProxy propagated (N3)", async () => {
    // Simulate a read/parse failure after getProxyPoolById resolved a strict
    // standard pool: property access past the initial reads throws.
    const pool = {
      id: "pool-1",
      isActive: true,
      strictProxy: true,
      isGroup: false,
      entries: [],
      proxyUrl: "http://ok:8080",
      noProxy: "",
      get type() {
        throw new Error("data corrupted");
      },
    };
    vi.mocked(getProxyPoolById).mockResolvedValue(pool);
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("error");
    expect(res.strictProxy).toBe(true);
    expect(isStrictProxyFailure(res)).toBe(true);
  });

  it("read failure before the flag is knowable → source error, strictProxy false (graceful legacy shape)", async () => {
    vi.mocked(getProxyPoolById).mockRejectedValue(new Error("db down"));
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("error");
    expect(res.strictProxy).toBe(false);
    expect(isStrictProxyFailure(res)).toBe(false);
  });
});

describe("non-strict pools keep today's graceful behavior (byte-identical)", () => {
  it("inactive non-strict pool → falls through to none (direct allowed)", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(groupPool({ strictProxy: false, isActive: false }));
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("none");
    expect(isStrictProxyFailure(res)).toBe(false);
  });

  it("non-strict group with all entries cooling → legacy fall-through with empty URL (direct allowed)", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(
      groupPool({ strictProxy: false, entries: [entry("e1", { cooldownUntil: NOW + 60_000 })] })
    );
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    // Pre-existing graceful shape: falls through to the standard-pool branch
    // with an empty proxyUrl (callers treat empty as direct). Unchanged by P1.
    expect(res.source).toBe("pool");
    expect(res.connectionProxyUrl).toBe("");
    expect(res.strictProxy).toBe(false);
    expect(isStrictProxyFailure(res)).toBe(false);
  });

  it("read failure on non-strict pool → source error, strictProxy false", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(groupPool({ strictProxy: false }));
    vi.mocked(getProxyPoolById).mockRejectedValue(new Error("db down"));
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("error");
    expect(res.strictProxy).toBe(false);
  });
});

describe("healthy pools resolve normally", () => {
  it("strict group with a usable entry → source group with entry URL", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(
      groupPool({ entries: [entry("e1"), entry("e2")] })
    );
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("group");
    expect(res.connectionProxyEnabled).toBe(true);
    expect(res.connectionProxyUrl).toMatch(/^http:\/\/e[12]:8080$/);
    expect(res.strictProxy).toBe(true);
    expect(isStrictProxyFailure(res)).toBe(false);
  });

  it("strict group with a 'direct' entry → group-direct (deliberate direct slot)", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue(
      groupPool({ entries: [{ id: "d1", name: "direct", type: "direct", proxyUrl: "", isActive: true, cooldownUntil: null, lastError: null, lastUsedAt: null }] })
    );
    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-1" });
    expect(res.source).toBe("group-direct");
    expect(res.connectionProxyEnabled).toBe(false);
    expect(isStrictProxyFailure(res)).toBe(false);
  });
});
