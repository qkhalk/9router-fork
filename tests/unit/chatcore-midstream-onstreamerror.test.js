// Mid-stream aborts (undici `TypeError: terminated`) happen AFTER handleChatCore
// resolved success — the 200 already went out — so the only channel the caller
// has to learn about them is the onStreamError callback wired into the stream
// controller. These tests pin that contract against the real chatCore +
// streamHandler: a stream that dies mid-body must invoke onStreamError with the
// original error while the client read still completes with terminal bytes.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({ compressWithPxpipe: vi.fn(async (body) => ({ summary: { applied: false, imageCount: 0 } })) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const STREAM_BODY = {
  model: "gpt-3.5-turbo",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
};

// A provider response whose SSE body delivers one chunk, then dies the way a
// dropped TLS stream through a flaky SOCKS node does.
function flakySSEBody() {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"id":"cmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      setTimeout(() => controller.error(new TypeError("terminated")), 5);
    }
  });
}

function streamingArgs(overrides = {}) {
  return {
    body: STREAM_BODY,
    modelInfo: { provider: "openai", model: "gpt-3.5-turbo" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "text/event-stream" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  });
});

describe("handleChatCore onStreamError (mid-stream abort contract)", () => {
  it("resolves success at 200-headers time, then reports the mid-body death via onStreamError", async () => {
    executeMock.mockResolvedValueOnce({
      response: new Response(flakySSEBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      url: "https://upstream.test/v1/chat/completions",
      headers: {},
    });

    const onStreamError = vi.fn();
    const result = await handleChatCore(streamingArgs({ onStreamError }));

    // The premise of the bug: chatCore has ALREADY returned success — the
    // caller's failure handling (retry loop, rotation) can never re-run.
    expect(result.success).toBe(true);

    // Drive the pump: read the client-facing body to completion. The
    // disconnect-aware stream converts the abort into terminal bytes, so this
    // must resolve (never reject) even though the upstream died mid-body.
    const text = await result.response.text();
    expect(text).toContain("data:"); // the chunk that made it out before the death

    // The death itself surfaces only through the callback.
    expect(onStreamError).toHaveBeenCalledTimes(1);
    expect(String(onStreamError.mock.calls[0][0]?.message)).toMatch(/terminated/i);
  });

  it("does not call onStreamError when the callback is omitted (no throw)", async () => {
    executeMock.mockResolvedValueOnce({
      response: new Response(flakySSEBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      url: "https://upstream.test/v1/chat/completions",
      headers: {},
    });

    const result = await handleChatCore(streamingArgs());
    expect(result.success).toBe(true);
    await expect(result.response.text()).resolves.toContain("data:");
  });
});
