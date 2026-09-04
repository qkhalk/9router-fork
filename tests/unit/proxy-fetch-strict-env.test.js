// Phase 01 (P5/P1): proxyAwareFetch strict-proxy policy — an env-var proxy is
// never a substitute for a missing connection proxy under strictProxy, an
// enabled-but-unresolvable connection proxy refuses outright, and dispatcher
// usage is tracked (fetch receives the dispatcher when a proxy is used).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// proxyFetch captures globalThis.fetch at import time — install the mock
// BEFORE the dynamic import below.
// socksDispatcher/undici are mocked so no real agents are built (undici is
// not resolvable from src/** in this environment, and no sockets are touched).
vi.mock("@/lib/network/socksDispatcher.js", () => ({
  isSocksProxyUrl: (u) => /^socks/i.test(u),
  createSocksDispatcher: () => ({ close: async () => {} }),
}), { virtual: true });
vi.mock("undici", () => ({
  ProxyAgent: class FakeProxyAgent {
    constructor() { this.uri = "fake"; }
    close() { return Promise.resolve(); }
  },
}), { virtual: true });

const fetchMock = vi.fn(async () => new Response("ok"));
const originalGlobalFetch = globalThis.fetch;
globalThis.fetch = fetchMock;

let proxyAwareFetch;
let proxyFetchModule;

beforeAll(async () => {
  proxyFetchModule = await import("open-sse/utils/proxyFetch.js");
  proxyAwareFetch = proxyFetchModule.proxyAwareFetch;
});

afterAll(() => {
  globalThis.fetch = originalGlobalFetch;
});

const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

beforeEach(() => {
  fetchMock.mockClear();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("strict env-proxy policy (P1/P5)", () => {
  it("strict + enabled + empty URL → refuses (never direct, never env)", async () => {
    await expect(
      proxyAwareFetch("https://api.example.com/v1", {}, {
        connectionProxyEnabled: true,
        connectionProxyUrl: "",
        strictProxy: true,
      })
    ).rejects.toThrow(/strictProxy=true/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strict + no connection proxy + env proxy set → env proxy IGNORED, no dispatcher", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const res = await proxyAwareFetch("https://api.example.com/v1", {}, {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      strictProxy: true,
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Direct call — env proxy must NOT have contributed a dispatcher.
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeUndefined();
  });

  it("strict + healthy connection proxy → fetch goes through the dispatcher", async () => {
    const res = await proxyAwareFetch("https://api.example.com/v1", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://conn-proxy:8080",
      strictProxy: true,
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });

  it("strict + proxy fetch failure → throws (no direct fallback)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("proxy tunnel collapsed"));
    await expect(
      proxyAwareFetch("https://api.example.com/v1", {}, {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://conn-proxy:8081",
        strictProxy: true,
      })
    ).rejects.toThrow(/strictProxy=true/);
  });

  it("non-strict + env proxy set → env proxy dispatcher IS used", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    await proxyAwareFetch("https://api.example.com/v1", {}, null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });

  it("noProxy bypass is honored even under strict (explicit per-host direct)", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    const res = await proxyAwareFetch("https://intranet.example.com/v1", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://conn-proxy:8080",
      connectionNoProxy: "intranet.example.com",
      strictProxy: true,
    });
    expect(res.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.dispatcher).toBeUndefined();
  });
});
