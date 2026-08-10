import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/lib/auth/tunnelAccess", () => ({
  isKnownTunnelHost: vi.fn((request, settings) => {
    const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
    const urls = [settings?.tunnelUrl, settings?.tailscaleUrl, settings?.externalTunnelUrl].filter(Boolean);
    return urls.some((url) => {
      try {
        return new URL(url).hostname.toLowerCase() === host;
      } catch {
        return false;
      }
    });
  }),
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(request("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(request("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  // --- Tunnel access (incl. cloudflared via systemd → externalTunnelUrl) ---

  it("allows local-only route over tunnel when tunnelDashboardAccess=true and authenticated", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://tunnel.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/ds2api/install", {
      host: "tunnel.example.com",
      origin: "https://tunnel.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route over tunnel when authenticated but tunnelDashboardAccess disabled", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: false,
      tunnelUrl: "https://tunnel.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/ds2api/install", {
      host: "tunnel.example.com",
      origin: "https://tunnel.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route over tunnel when tunnelDashboardAccess=true but not authenticated", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://tunnel.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const response = await proxy(request("/api/ds2api/install", {
      host: "tunnel.example.com",
      origin: "https://tunnel.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("recognizes externalTunnelUrl as a tunnel host (cloudflared via systemd)", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      // App-managed tunnelUrl empty — tunnel runs outside the app.
      tunnelUrl: "",
      externalTunnelUrl: "https://ai.domain.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/ds2api/install", {
      host: "ai.domain.com",
      origin: "https://ai.domain.com",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects strict local-only route (reset-password) over tunnel even when authenticated + access enabled", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://tunnel.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/auth/reset-password", {
      host: "tunnel.example.com",
      origin: "https://tunnel.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects strict local-only route (cowork-settings) over tunnel — leaks CLI token", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://tunnel.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/cli-tools/cowork-settings", {
      host: "tunnel.example.com",
      origin: "https://tunnel.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows non-strict local-only route from authenticated private LAN dashboard", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/xray/start", {
      host: "192.168.1.107:20128",
      origin: "http://192.168.1.107:20128",
      "x-9r-real-ip": "192.168.1.55",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects private LAN local-only route when dashboard is not authenticated", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const response = await proxy(request("/api/xray/start", {
      host: "192.168.1.107:20128",
      origin: "http://192.168.1.107:20128",
      "x-9r-real-ip": "192.168.1.55",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects strict local-only route from private LAN even when authenticated", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/cli-tools/cowork-settings", {
      host: "192.168.1.107:20128",
      origin: "http://192.168.1.107:20128",
      "x-9r-real-ip": "192.168.1.55",
    }));

    expect(response.status).toBe(403);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});
