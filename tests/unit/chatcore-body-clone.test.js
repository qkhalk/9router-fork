import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

const { executeMock, pxpipeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  pxpipeMock: vi.fn(async (body) => ({ summary: { applied: false, imageCount: 0 } })),
}));

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
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({ compressWithPxpipe: pxpipeMock }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const IMAGE_BLOCK = {
  type: "image_url",
  image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg" },
};

// gpt-3.5-turbo resolves to caps without vision → the strip path runs.
const MULTIMODAL_BODY = {
  model: "gpt-3.5-turbo",
  stream: false,
  messages: [
    { role: "user", content: [{ type: "text", text: "what is this" }, IMAGE_BLOCK] },
    { role: "user", content: [{ type: "text", text: "and this" }, IMAGE_BLOCK] },
  ],
};

function baseArgs(overrides = {}) {
  return {
    body: MULTIMODAL_BODY,
    modelInfo: { provider: "openai", model: "gpt-3.5-turbo" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "test-conn",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  });
  executeMock.mockResolvedValue({
    response: new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });
});

// C2: stripUnsupportedModalities + image prefetch used to mutate the CALLER's
// body object. Combo-fusion panel members and fallback attempts share that
// object — after a first attempt stripped the images, the next member saw a
// different request than the client sent.
describe("per-attempt body isolation (C2)", () => {
  it("never mutates the caller's body when the strip path runs", async () => {
    const snapshot = structuredClone(MULTIMODAL_BODY);
    const args = baseArgs();
    const result = await handleChatCore(args);
    expect(result.success).toBe(true);
    // Prove the strip path actually executed (otherwise the assert is vacuous).
    expect(args.log.debug).toHaveBeenCalledWith("MODALITY", expect.stringContaining("stripped"));
    expect(args.body).toEqual(snapshot);
  });

  it("keeps the second attempt pristine (failed-then-fallback shape)", async () => {
    const snapshot = structuredClone(MULTIMODAL_BODY);
    // First attempt fails with a deterministic 400 → caller retries with the
    // SAME body object (combo/fallback contract).
    executeMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { message: "bad request", code: 400 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    const args = baseArgs();
    const first = await handleChatCore(args);
    expect(first.success).toBe(false);
    const second = await handleChatCore(args);
    expect(second.success).toBe(true);
    expect(args.body).toEqual(snapshot);
  });
});

// C3: PXPIPE used to run even when the client disabled token savers via
// X-9Router-Token-Saver: off — every other saver honored the header.
describe("PXPIPE token-saver gate (C3)", () => {
  it("skips PXPIPE when X-9Router-Token-Saver is off", async () => {
    const args = baseArgs({
      pxpipeEnabled: true,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { "x-9router-token-saver": "off" } },
    });
    await handleChatCore(args);
    expect(pxpipeMock).not.toHaveBeenCalled();
  });

  it("runs PXPIPE when savers are enabled (header absent)", async () => {
    const args = baseArgs({ pxpipeEnabled: true });
    await handleChatCore(args);
    expect(pxpipeMock).toHaveBeenCalled();
  });
});
