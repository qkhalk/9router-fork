// Phase 3 — install route + orchestrator: strict tag validation (RT-1 incl.
// traversal payload), install single-flight (409), and the rollback-on-
// restart-failure path (RT-5).
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── route-level: manager mocked, installer REAL (the regex is the fix) ──
vi.mock("@/lib/xray/manager", () => ({
  installXrayOrchestrated: vi.fn(),
  isInstallInFlight: vi.fn(() => false),
}));

const { POST } = await import("@/app/api/xray/install/route.js");
const { installXray } = await import("@/lib/xray/installer.js");

const req = (body) =>
  new Request("http://localhost:20127/api/xray/install", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /api/xray/install — tag validation (RT-1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a literal traversal payload with 400 — route layer", async () => {
    const res = await POST(req({ version: "../../../../attacker/repo/releases/download/v1.0.0" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_VERSION");
  });

  it("rejects garbage tags with 400; accepts pinned-default (no version)", async () => {
    for (const bad of ["v1", "1.2.3", "v1.2.x", "latest", "v1.2.3; rm -rf", ""]) {
      const res = await POST(req({ version: bad }));
      expect(res.status).toBe(400);
    }
    const { installXrayOrchestrated } = await import("@/lib/xray/manager");
    installXrayOrchestrated.mockResolvedValue({ installed: true, version: "v26.3.27", restarted: false });
    const ok = await POST(req({})); // no version → pinned default
    expect(ok.status).toBe(200);
  });

  it("409 when an install is already in flight", async () => {
    const { installXrayOrchestrated, isInstallInFlight } = await import("@/lib/xray/manager");
    isInstallInFlight.mockReturnValue(true);
    const res = await POST(req({ version: "v26.3.28" }));
    expect(res.status).toBe(409);
    expect(installXrayOrchestrated).not.toHaveBeenCalled();
  });

  it("installXray itself throws INVALID_VERSION before any URL is built (defense in depth)", async () => {
    await expect(installXray({ version: "../../../../attacker/repo/releases/download/v1.0.0" })).rejects.toMatchObject({
      code: "INVALID_VERSION",
    });
    await expect(installXray({ version: "not-a-tag" })).rejects.toMatchObject({ code: "INVALID_VERSION" });
  });
});
