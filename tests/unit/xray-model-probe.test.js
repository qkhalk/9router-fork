import { describe, it, expect } from "vitest";
import { buildModelProbeBody, withProbeTimeout } from "../../src/lib/xray/modelProbe.js";

// Regression guard for the model proxy filter probe payload. The original
// probe hardcoded max_tokens: 1, which upstreams enforcing a minimum cap
// rejected with HTTP 400 (opencode muse-spark-1.2-contributor-free requires
// >= 16), failing every xray config regardless of proxy quality.
describe("xray model probe payload", () => {
  it("omits token caps so upstreams with minimum caps accept the probe", () => {
    const body = buildModelProbeBody({ provider: "opencode", model: "muse-spark-1.2-contributor-free" });
    expect("max_tokens" in body).toBe(false);
    expect("max_completion_tokens" in body).toBe(false);
  });

  it("is a minimal non-streaming chat request", () => {
    const body = buildModelProbeBody({ provider: "openai-compatible-chat-abc", model: "some-model" });
    expect(body).toEqual({
      model: "openai-compatible-chat-abc/some-model",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
  });
});

describe("xray model probe timeout", () => {
  it("resolves with the probe result when the probe is fast", async () => {
    const result = await withProbeTimeout(Promise.resolve({ ok: true }), 500, "spawn");
    expect(result).toEqual({ ok: true });
  });

  it("rejects with a TimeoutError when the probe hangs past timeoutMs", async () => {
    const hanging = new Promise(() => {});
    await expect(withProbeTimeout(hanging, 15, "api")).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("Probe timed out after 15ms (api)"),
    });
  });

  it("does not surface an unhandled rejection when the loser rejects after the race settled", async () => {
    // Times out at 10ms; the probe rejects later at 60ms. The late rejection
    // must be swallowed (it would otherwise fail the test run as unhandled).
    let rejectLate;
    const slowReject = new Promise((_, reject) => { rejectLate = reject; });
    await expect(withProbeTimeout(slowReject, 10)).rejects.toMatchObject({ name: "TimeoutError" });
    await new Promise((r) => setTimeout(r, 60));
    rejectLate(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 5));
  });

  it("propagates the probe's own rejection when it fails before the timeout", async () => {
    const failing = Promise.reject(new Error("upstream 503"));
    // silence vitest's sync-rejection surfacing of the bare literal
    failing.catch(() => {});
    await expect(withProbeTimeout(failing, 500, "spawn")).rejects.toThrow("upstream 503");
  });

  it("passes the promise through untouched when timeoutMs is not positive", async () => {
    const p = Promise.resolve("value");
    await expect(withProbeTimeout(p, 0)).resolves.toBe("value");
  });
});
