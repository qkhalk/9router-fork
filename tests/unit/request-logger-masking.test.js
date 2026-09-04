import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

// S3: with request logs opted IN, bearer/api-key/cookie values must still be
// masked before they touch disk.
process.env.ENABLE_REQUEST_LOGS = "true";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");

let sessionPath;

beforeAll(async () => {
  const logger = await createRequestLogger("openai", "openai", "mask-test");
  expect(logger.sessionPath).toBeTruthy();
  sessionPath = logger.sessionPath;

  logger.logClientRawRequest("/v1/chat/completions", { model: "x" }, {
    authorization: "Bearer sk-live-abcdef1234567890abcdef",
    "x-api-key": "sk-live-abcdef1234567890abcdef",
    cookie: "auth_token=eyJhbGciOiJIUzI1NiJ9.session.sig",
    "content-type": "application/json",
  });

  logger.logProviderResponse(200, "OK", new Headers({
    authorization: "Bearer sk-live-provider-token-987654321",
    "x-request-id": "req-1",
  }), { ok: true });
});

function readLog(filename) {
  return JSON.parse(fs.readFileSync(path.join(sessionPath, filename), "utf8"));
}

describe("requestLogger masking (S3)", () => {
  it("masks authorization / x-api-key / cookie in the client request log", () => {
    const log = readLog("1_req_client.json");
    expect(log.headers.authorization).not.toContain("sk-live-abcdef1234567890");
    expect(log.headers.authorization).toContain("...");
    expect(log.headers["x-api-key"]).not.toContain("sk-live");
    expect(log.headers.cookie).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(log.headers["content-type"]).toBe("application/json");
  });

  it("masks headers in the provider response log too", () => {
    const log = readLog("5_res_provider.json");
    expect(log.headers.authorization).not.toContain("sk-live-provider-token");
    expect(log.headers["x-request-id"]).toBe("req-1");
  });

  it("never writes the raw secret anywhere in the session directory", () => {
    const files = fs.readdirSync(sessionPath);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(sessionPath, f), "utf8");
      expect(raw, `${f} contains a raw secret`).not.toContain("sk-live-abcdef1234567890");
    }
  });
});
