// Phase 3 — xray version endpoints: cache discipline + graceful degrade
// (GitHub failures are HTTP 200 with an error field, never 5xx).
//
// node:https is mocked with a per-test responder. The module-level cache is
// reset by MUTATING global.__xrayVersionCache's entries — versionInfo holds
// a reference to the top object at import time, so replacing it would no-op.
import { describe, it, expect, beforeEach, vi } from "vitest";

const httpsState = vi.hoisted(() => ({ respond: null, calls: 0 }));

vi.mock("https", () => {
  const get = vi.fn((url, opts, cb) => {
      httpsState.calls += 1;
      const respond = httpsState.respond;
      const req = { on: vi.fn(), destroy: vi.fn() };
      setImmediate(() => {
        if (!respond) {
          // connection-level failure
          req.on.mock.calls
            .filter(([ev]) => ev === "error")
            .forEach(([, fn]) => fn(new Error("ECONNREFUSED")));
          return;
        }
        cb({
          statusCode: 200,
          on(ev, fn) {
            if (ev === "data") fn(JSON.stringify(respond(url)));
            if (ev === "end") setImmediate(fn);
            return this;
          },
        });
      });
      return req;
    });
  return { default: { get }, get };
});
vi.mock("@/lib/xray/installer", () => ({
  getInstalledVersion: vi.fn(() => "v26.3.27"),
  isXrayInstalled: vi.fn(() => true),
}));

const { GET: GET_LATEST } = await import("@/app/api/xray/version/latest/route.js");
const { GET: GET_RELEASES } = await import("@/app/api/xray/version/releases/route.js");
const { compareVersions } = await import("@/lib/xray/versionInfo.js");
const https = await import("https");

function respondWithJson(payload) {
  httpsState.respond = () => payload;
}
function respondWithFailure() {
  httpsState.respond = null;
}

beforeEach(() => {
  httpsState.respond = null;
  httpsState.calls = 0;
  https.get.mockClear();
  const cache = global.__xrayVersionCache;
  if (cache) {
    cache.latest = { value: null, fetchedAt: 0 };
    cache.releases = { value: null, fetchedAt: 0 };
  }
});

describe("compareVersions", () => {
  it("orders numeric segments, tolerating the v prefix", () => {
    expect(compareVersions("v26.4.1", "v26.3.27")).toBe(1);
    expect(compareVersions("26.3.27", "v26.3.27")).toBe(0);
    expect(compareVersions("v1.2", "v1.10.0")).toBe(-1);
  });
});

describe("GET /api/xray/version/latest", () => {
  it("returns installed/latest/hasUpdate on GitHub success", async () => {
    respondWithJson({ tag_name: "v27.1.1", prerelease: false, published_at: "2026-09-01T00:00:00Z" });

    const res = await GET_LATEST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.installed).toBe("v26.3.27");
    expect(body.latest).toBe("v27.1.1");
    expect(body.hasUpdate).toBe(true);
    expect(body.prerelease).toBe(false);
  });

  it("degrades on GitHub failure with no cache: installed echoed, hasUpdate false, error set, HTTP 200", async () => {
    respondWithFailure();

    const res = await GET_LATEST();
    const body = await res.json();
    expect(res.status).toBe(200); // graceful — never 5xx
    expect(body.latest).toBe("v26.3.27"); // installed echoed, no hardcoded tag
    expect(body.hasUpdate).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("falls back to a stale cache when GitHub fails after a successful check", async () => {
    respondWithJson({ tag_name: "v27.0.0", prerelease: false });
    await GET_LATEST(); // primes cache
    // Age the cache past the 1h TTL so the next call must re-fetch (and fail).
    global.__xrayVersionCache.latest.fetchedAt = Date.now() - 2 * 3600000;

    respondWithFailure();
    const res = await GET_LATEST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.latest).toBe("v27.0.0"); // stale cache, not "unknown"
    expect(body.hasUpdate).toBe(true);
    expect(body.stale).toBe(true);
  });

  it("serves from cache within the TTL window (one GitHub call across two requests)", async () => {
    respondWithJson({ tag_name: "v27.1.1", prerelease: false });
    await GET_LATEST();
    await GET_LATEST();
    expect(https.get).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/xray/version/releases", () => {
  it("filters drafts, flags prereleases, honors per_page clamp", async () => {
    respondWithJson([
      { tag_name: "v27.2.0", prerelease: true, published_at: "2026-09-20T00:00:00Z" },
      { tag_name: "v27.1.0", prerelease: false, published_at: "2026-09-10T00:00:00Z" },
      { tag_name: "v26.9.9", prerelease: false, draft: true, published_at: "2026-09-05T00:00:00Z" },
      { tag_name: "v26.3.27", prerelease: false, published_at: "2026-03-27T00:00:00Z" },
    ]);

    const req = new Request("http://localhost/api/xray/version/releases?per_page=2");
    const res = await GET_RELEASES(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.releases).toHaveLength(2); // clamped
    expect(body.releases[0]).toMatchObject({ version: "v27.2.0", prerelease: true, draft: false });
    expect(body.releases.find((r) => r.version === "v26.9.9")).toBeUndefined(); // draft filtered
  });

  it("degrades to an empty list + error on GitHub failure with no cache", async () => {
    respondWithFailure();
    const req = new Request("http://localhost/api/xray/version/releases");
    const res = await GET_RELEASES(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.releases).toEqual([]);
    expect(body.error).toBeTruthy();
  });

  it("caches: repeated calls hit GitHub once within the TTL window", async () => {
    respondWithJson([{ tag_name: "v27.1.0", prerelease: false }]);
    await GET_RELEASES(new Request("http://localhost/api/xray/version/releases"));
    await GET_RELEASES(new Request("http://localhost/api/xray/version/releases"));
    expect(https.get).toHaveBeenCalledTimes(1);
  });
});
