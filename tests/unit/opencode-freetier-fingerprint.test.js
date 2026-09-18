import { beforeEach, describe, expect, it, vi } from "vitest";

// The zen free tier fingerprints the client server-side: 403 FreeTierError
// unless the UA carries a currently-released version and the id headers match
// the official identifier format. The catalog module resolves its UA from the
// network — pin it so the header tests are deterministic and offline.

const CLI_UA = "opencode/1.18.31 ai-sdk/provider-utils/4.0.38 runtime/bun/1.3.14";

vi.mock("../../open-sse/providers/opencodeCatalog.js", () => ({
  ensureOpencodeCatalog: () => {},
  getOpencodeCliUserAgent: () => CLI_UA,
  isResponsesServed: () => false,
  isDeprecatedModel: () => false,
}));

const { PROVIDERS } = await import("../../open-sse/config/providers.js");

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

// ses_/msg_ + 12 lowercase-hex chars + 14 alphanumeric chars = 26 after prefix
const OFFICIAL_ID = /^[a-z]{3}_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const body = (text = "Reply with exactly: pong") => ({
  model: "big-pickle",
  messages: [{ role: "user", content: text }],
  stream: true,
  max_tokens: 300,
});

const claudeCredentials = { rawHeaders: { "user-agent": "claude-cli/2.0.0" }, connectionId: "conn-test-1" };

function buildHeaders(exec, credentials) {
  return exec.buildHeaders(credentials, true);
}

describe("opencode free-tier fingerprint headers", () => {
  let exec;

  beforeEach(() => {
    exec = new OpenCodeExecutor();
  });

  it("generates session/request ids in the official 26-char identifier format", () => {
    exec.transformRequest("big-pickle", body(), true, claudeCredentials);
    const headers = buildHeaders(exec, claudeCredentials);
    expect(headers["x-opencode-session"]).toMatch(OFFICIAL_ID);
    expect(headers["x-opencode-request"]).toMatch(OFFICIAL_ID);
    expect(headers["x-opencode-session"]).toMatch(/^ses_/);
    expect(headers["x-opencode-request"]).toMatch(/^msg_/);
  });

  it("forces stream:true on the upstream body — zen free tier is stream-only", () => {
    const nonStream = body();
    nonStream.stream = false;
    const transformed = exec.transformRequest("big-pickle", nonStream, false, claudeCredentials);
    expect(transformed.stream).toBe(true);
  });

  it("injects the agent tool surface (bash+read) when the client sends no tools", () => {
    const transformed = exec.transformRequest("big-pickle", body(), true, claudeCredentials);
    const names = transformed.tools.map((t) => t.function?.name);
    expect(names).toContain("bash");
    expect(names).toContain("read");
  });

  it("keeps client tools and only fills the missing required names", () => {
    const withTools = body();
    withTools.tools = [{ type: "function", function: { name: "my_own_tool", parameters: { type: "object", properties: {} } } }];
    const transformed = exec.transformRequest("big-pickle", withTools, true, claudeCredentials);
    const names = transformed.tools.map((t) => t.function?.name);
    expect(names).toContain("my_own_tool");
    expect(names).toContain("bash");
    expect(names).toContain("read");
  });

  it("does not duplicate bash/read when the client already sends them", () => {
    const withTools = body();
    withTools.tools = [
      { type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } },
    ];
    const transformed = exec.transformRequest("big-pickle", withTools, true, claudeCredentials);
    expect(transformed.tools.filter((t) => t.function?.name === "bash")).toHaveLength(1);
    expect(transformed.tools.filter((t) => t.function?.name === "read")).toHaveLength(1);
  });

  it("cloaks non-opencode downstream clients with the live CLI UA", () => {
    exec.transformRequest("big-pickle", body(), true, claudeCredentials);
    expect(buildHeaders(exec, claudeCredentials)["User-Agent"]).toBe(CLI_UA);
  });

  it("keeps a conversation-stable session id across requests", () => {
    exec.transformRequest("big-pickle", body("first turn"), true, claudeCredentials);
    const first = buildHeaders(exec, claudeCredentials);
    exec.transformRequest("big-pickle", body("second turn"), true, claudeCredentials);
    const second = buildHeaders(exec, claudeCredentials);
    expect(second["x-opencode-session"]).toBe(first["x-opencode-session"]);
    expect(second["x-opencode-request"]).not.toBe(first["x-opencode-request"]);
  });

  it("relays genuine downstream opencode fingerprints unchanged", () => {
    const genuine = {
      rawHeaders: {
        "user-agent": "opencode/1.18.31",
        "x-opencode-client": "cli",
        "x-opencode-session": "ses_0123456789abABCDEFGHIJKLMN",
        "x-opencode-request": "msg_0123456789abOPQRSTUVWXYZMN",
        "x-opencode-project": "/home/user/proj",
      },
    };
    exec.transformRequest("big-pickle", body(), true, genuine);
    const headers = buildHeaders(exec, genuine);
    expect(headers["User-Agent"]).toBe("opencode/1.18.31");
    expect(headers["x-opencode-session"]).toBe(genuine.rawHeaders["x-opencode-session"]);
    expect(headers["x-opencode-request"]).toBe(genuine.rawHeaders["x-opencode-request"]);
    expect(headers["x-opencode-project"]).toBe("/home/user/proj");
  });

  it("cloaks a stale downstream opencode UA instead of relaying it into a 403", () => {
    const stale = { rawHeaders: { "user-agent": "opencode/1.18.22" } };
    exec.transformRequest("big-pickle", body(), true, stale);
    expect(buildHeaders(exec, stale)["User-Agent"]).toBe(CLI_UA);
  });

  it("replaces junk downstream id/client values that would fail format validation", () => {
    const junk = {
      rawHeaders: {
        "x-opencode-session": "ses_definitely_not_official_format",
        "x-opencode-request": "req_junk",
        "x-opencode-client": "some-unknown-gui",
      },
    };
    exec.transformRequest("big-pickle", body(), true, junk);
    const headers = buildHeaders(exec, junk);
    expect(headers["x-opencode-session"]).toMatch(OFFICIAL_ID);
    expect(headers["x-opencode-session"]).not.toBe(junk.rawHeaders["x-opencode-session"]);
    expect(headers["x-opencode-request"]).toMatch(OFFICIAL_ID);
    expect(["cli", "desktop"]).toContain(headers["x-opencode-client"]);
  });

  it("declares forceStream on the provider registry (zen free tier rejects stream:false)", () => {
    expect(PROVIDERS.opencode.forceStream).toBe(true);
  });
});
