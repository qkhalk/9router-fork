// Phase 01 (P1): getProviderCredentials surfaces strict-proxy failures as
// explicit markers — allRateLimited for no-auth (no fallback candidate) and
// proxyExhausted for authed accounts (chat loop skips to the next account).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  isStrictProxyFailure: (r) =>
    !!r && (r.source === "exhausted" || (r.source === "error" && r.strictProxy === true)),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: vi.fn(() => null),
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn((k) => k),
}));

import { getProviderConnections, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getProviderCredentials } from "@/sse/services/auth.js";

// A provider whose FREE_PROVIDERS entry is noAuth (drives the noauth branch).
const NOAUTH_PROVIDER = "opencode";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue({});
  vi.mocked(getProxyPools).mockResolvedValue([]);
});

describe("no-auth providers (single pick — no fallback candidate)", () => {
  it("strict pool exhausted → allRateLimited marker with 503 code", async () => {
    vi.mocked(resolveConnectionProxyConfig).mockResolvedValue({
      source: "exhausted", strictProxy: true, proxyPoolId: "pool-x",
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    });
    const creds = await getProviderCredentials(NOAUTH_PROVIDER, null, null);
    expect(creds.allRateLimited).toBe(true);
    expect(Number(creds.lastErrorCode)).toBe(503);
    expect(creds.retryAfter).toBeTruthy();
    expect(creds.lastError).toContain("pool-x");
    // Critical: no connection shape that a caller could mistake for "use direct".
    expect(creds.connectionProxyUrl).toBeUndefined();
  });

  it("strict pool resolution error → same allRateLimited marker", async () => {
    vi.mocked(resolveConnectionProxyConfig).mockResolvedValue({
      source: "error", strictProxy: true, proxyPoolId: "pool-x",
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    });
    const creds = await getProviderCredentials(NOAUTH_PROVIDER, null, null);
    expect(creds.allRateLimited).toBe(true);
  });

  it("healthy pool → normal noauth virtual connection (unchanged)", async () => {
    vi.mocked(resolveConnectionProxyConfig).mockResolvedValue({
      source: "group", strictProxy: true, proxyPoolId: "pool-x", proxyEntryId: "e1",
      connectionProxyEnabled: true, connectionProxyUrl: "http://e1:8080", connectionNoProxy: "",
    });
    const creds = await getProviderCredentials(NOAUTH_PROVIDER, null, null);
    expect(creds.id).toBe("noauth");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("http://e1:8080");
  });
});

describe("authed accounts (chat loop skips to the next account)", () => {
  it("strict pool exhausted → proxyExhausted marker, connectionId included, no tokens", async () => {
    vi.mocked(getProviderConnections).mockResolvedValue([
      { id: "conn-1", provider: "kilocode", authType: "oauth", isActive: 1, name: "A", providerSpecificData: { proxyPoolId: "pool-x" } },
    ]);
    vi.mocked(resolveConnectionProxyConfig).mockResolvedValue({
      source: "exhausted", strictProxy: true, proxyPoolId: "pool-x",
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    });
    const creds = await getProviderCredentials("kilocode", null, null);
    expect(creds.proxyExhausted).toBe(true);
    expect(creds.connectionId).toBe("conn-1");
    expect(creds.poolId).toBe("pool-x");
    // No proxy-bearing credentials a caller could accidentally fetch direct with.
    expect(creds.accessToken).toBeUndefined();
    expect(creds.providerSpecificData).toBeUndefined();
  });

  it("healthy resolution → full credentials with proxy fields (unchanged)", async () => {
    vi.mocked(getProviderConnections).mockResolvedValue([
      { id: "conn-1", provider: "kilocode", authType: "oauth", isActive: 1, name: "A", accessToken: "t", providerSpecificData: { proxyPoolId: "pool-x" } },
    ]);
    vi.mocked(resolveConnectionProxyConfig).mockResolvedValue({
      source: "pool", strictProxy: false, proxyPoolId: "pool-x",
      connectionProxyEnabled: true, connectionProxyUrl: "http://p:8080", connectionNoProxy: "",
    });
    const creds = await getProviderCredentials("kilocode", null, null);
    expect(creds.connectionId).toBe("conn-1");
    expect(creds.accessToken).toBe("t");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("http://p:8080");
    expect(creds.proxyExhausted).toBeUndefined();
  });
});
