import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

// ── search/index.js seams ────────────────────────────────────────────────────
vi.mock("../../open-sse/handlers/search/callers.js", () => ({
  buildSearchRequest: () => ({ url: "https://search.example.test/api", init: { method: "GET" } }),
}));
vi.mock("../../open-sse/handlers/search/normalizers.js", () => ({
  normalizeSearchResponse: () => ({ results: [{ title: "t", url: "https://r.test", snippet: "s" }], totalResults: 1 }),
}));
vi.mock("../../open-sse/handlers/search/chatSearch.js", () => ({
  handleChatSearch: vi.fn(),
  CHAT_SEARCH_CONFIG: {},
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  fetchPublic: vi.fn(),
}));

// ── auth.js seams ────────────────────────────────────────────────────────────
const authDb = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => authDb);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => null),
  pickProxyPoolId: vi.fn(async () => null),
  isStrictProxyFailure: () => false,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: vi.fn(() => null),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn(),
}));

import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { fetchPublic } from "@/shared/utils/ssrfGuard.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";
import { markAccountUnavailable, clearAccountError } from "@/sse/services/auth.js";

const okUpstream = () => new Response(JSON.stringify({ results: [] }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const PROVIDER = { id: "kilocode" };
const SEARCH_CONFIG = { authType: "bearer", timeoutMs: 2000 };

beforeEach(() => {
  vi.clearAllMocks();
  fetchPublic.mockResolvedValue(okUpstream());
});

describe("handleSearchCore onRequestSuccess (C5)", () => {
  it("invokes onRequestSuccess when the dedicated provider succeeds", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: PROVIDER,
      providerConfig: SEARCH_CONFIG,
      credentials: { apiKey: "k" },
      log: {},
      onRequestSuccess,
    });
    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("invokes onRequestSuccess when the chat fallback succeeds", async () => {
    fetchPublic.mockResolvedValue(new Response("nope", { status: 500 }));
    handleChatSearch.mockResolvedValue({ success: true, status: 200, data: { results: [] } });
    const onRequestSuccess = vi.fn();
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "somechat", searchViaChat: {} },
      providerConfig: null,
      credentials: { apiKey: "k" },
      log: {},
      onRequestSuccess,
    });
    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke onRequestSuccess when everything fails", async () => {
    fetchPublic.mockResolvedValue(new Response("nope", { status: 500 }));
    handleChatSearch.mockResolvedValue({ success: false, status: 502, error: "boom" });
    const onRequestSuccess = vi.fn();
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "somechat", searchViaChat: {} },
      providerConfig: null,
      credentials: { apiKey: "k" },
      log: {},
      onRequestSuccess,
    });
    expect(result.success).toBe(false);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("survives a throwing onRequestSuccess (unlock is best-effort)", async () => {
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: PROVIDER,
      providerConfig: SEARCH_CONFIG,
      credentials: { apiKey: "k" },
      log: {},
      onRequestSuccess: async () => { throw new Error("db locked"); },
    });
    expect(result.success).toBe(true);
  });
});

describe("markAccountUnavailable scoped search failures (C5)", () => {
  it("locks the scoped key but does NOT stamp account-wide testStatus", async () => {
    authDb.getProviderConnections.mockResolvedValue([
      { id: "conn-1", name: "Acct 1", provider: "kilocode", testStatus: "active" },
    ]);
    const { shouldFallback } = await markAccountUnavailable(
      "conn-1", 502, "search blew up", "kilocode", "websearch", null, { skipStatusStamp: true }
    );
    expect(shouldFallback).toBe(true);
    const patch = authDb.updateProviderConnection.mock.calls[0][1];
    expect(Object.keys(patch).some((k) => k.startsWith("modelLock_"))).toBe(true);
    expect(patch).not.toHaveProperty("testStatus");
    expect(patch).not.toHaveProperty("lastError");
  });

  it("still stamps account-wide status without the opt (unchanged default)", async () => {
    authDb.getProviderConnections.mockResolvedValue([
      { id: "conn-1", name: "Acct 1", provider: "kilocode", testStatus: "active" },
    ]);
    await markAccountUnavailable("conn-1", 502, "search blew up", "kilocode", "websearch");
    const patch = authDb.updateProviderConnection.mock.calls[0][1];
    expect(patch.testStatus).toBe("unavailable");
  });
});

describe("clearAccountError scoped unlock (C5)", () => {
  it("clears the modelLock_websearch key passed as the scoped model", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await clearAccountError("conn-1", {
      id: "conn-1",
      testStatus: "unavailable",
      lastError: "x",
      [`modelLock_${"websearch"}`]: future,
    }, "websearch");
    const patch = authDb.updateProviderConnection.mock.calls[0][1];
    expect(patch.modelLock_websearch).toBeNull();
  });
});
