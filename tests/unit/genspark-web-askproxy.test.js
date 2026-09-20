// Unit tests for the genspark-web executor (ask_proxy / ai_chat flow), with the
// Python TLS sidecar harness mocked at the module boundary.
//
// Covers the executor's control flow that the helpers test can't reach:
//   1. Missing image flow → honest 400 for an image model id.
//   2. Missing cookie jar → 401.
//   3. Sidecar unavailable → 502 with the bootstrap message.
//   4. Challenge first-chunk → 502 Cloudflare classification.
//   5. `data:`-prefixed SSE stream from the sidecar → streamed answer back.
//   6. Builds the ai_chat payload from body.messages (role delta streamed).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("open-sse/services/gensparkTlsSidecar.js", () => ({
  gensparkSidecarFetch: vi.fn(),
}));

import { gensparkSidecarFetch } from "open-sse/services/gensparkTlsSidecar.js";
import { GensparkWebExecutor } from "open-sse/executors/genspark-web.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };


// The model catalog also uses the sidecar (background GETs with a `url` arg);
// transport assertions care only about chat POSTs (no `url`).
const chatTransportCalls = () =>
  gensparkSidecarFetch.mock.calls.filter(([arg]) => !arg?.url);

function makeCookies() {
  return {
    session_id: "sess-xyz",
    __cf_bm: "cf-token",
    c1: "c1-val",
    c2: "c2-val",
    gslogin: "1",
  };
}

/** Build a `data:`-prefixed SSE ReadableStream the sidecar harness would return. */
function sseStream(lines) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n`));
      controller.close();
    },
  });
}

function consumeSse(response) {
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      },
    }),
  ).text();
}

async function runChat(opts = {}) {
  const executor = new GensparkWebExecutor();
  const mock = gensparkSidecarFetch.mockImplementation(async () =>
    opts.sidecar || { body: null, error: { message: "boom", status: 502, code: "X" } },
  );
  const { response, transformedBody } = await executor.execute({
    model: opts.model || "claude-sonnet-4-6",
    body: {
      messages: opts.messages || [{ role: "user", content: "hi" }],
    },
    stream: opts.stream ?? true,
    credentials: { providerSpecificData: { cookies: opts.cookies ?? makeCookies() } },
    signal: undefined,
    log,
    onCredentialsRefreshed: opts.onCredentialsRefreshed,
  });
  return { response, transformedBody, mock };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetAllMocks();
});

describe("GensparkWebExecutor (ask_proxy via TLS sidecar)", () => {
  it("returns an honest 400 for an image model (no image flow on ask_proxy)", async () => {
    const { response } = await runChat({ model: "nano-banana-pro" });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("IMAGE_RETIRED");
    expect(chatTransportCalls()).toHaveLength(0);
  });

  it("returns 401 when the cookie jar has no session_id", async () => {
    const { response } = await runChat({ cookies: { c1: "x" } });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.code).toBe("COOKIE_MISSING");
    expect(chatTransportCalls()).toHaveLength(0);
  });

  it("returns 502 with the sidecar bootstrap message when the sidecar is unavailable", async () => {
    const { response } = await runChat({
      sidecar: { body: null, error: { message: "No Python runtime found", status: 502, code: "SIDECAR_UNAVAILABLE" } },
    });
    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error.message).toContain("No Python runtime");
  });

  it("classifies a Cloudflare challenge first-chunk as 502 Cloudflare", async () => {
    const challengeHtml = '<html><head><title>Just a moment...</title></head></html>';
    const { response } = await runChat({
      sidecar: { body: sseStream([challengeHtml]), error: null },
    });
    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error.code).toBe("CLOUDFLARE");
  });

  it("classifies 'bad request cf' (not-login) as 401 NOT_LOGIN", async () => {
    const { response } = await runChat({
      sidecar: { body: sseStream(["bad request cf"]), error: null },
    });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.code).toBe("NOT_LOGIN");
  });

  it("accepts real genspark SSE frames serialized with a space after the colon", async () => {
    // Live genspark edge serializes `"type": "project_start"` (space after the
    // colon). A byte-exact `'"type":"project_start"'` match would fail and
    // misreport a perfectly valid jar as "Invalid" — the exact bug that produced
    // "Invalid" in the UI despite a working cookie export.
    const sidecar = {
      body: sseStream([
        '{"id": "p1", "type": "project_start", "_event_index": 0}',
        '{"message_id": "m1", "type": "message_field_delta", "field_name": "content", "delta": "hi", "_event_index": 1}',
        '{"message_id": "m1", "type": "message_result", "message": {"content": "hi"}, "_event_index": 2}',
      ]),
      error: null,
    };
    const { response } = await runChat({ sidecar });
    expect(response.status).toBe(200);
    const chunks = await consumeSse(response);
    expect(chunks).toContain("data: {");
    expect(chunks).toContain('"content":"hi"');
    expect(chunks).toContain("[DONE]");
  });

  it("passes the parsed cookie jar object (not a header) to the sidecar", async () => {
    await runChat({
      sidecar: { body: sseStream(['{"type":"message_result","message":{"content":"ok"}}']), error: null },
    });
    expect(gensparkSidecarFetch).toHaveBeenCalledTimes(1);
    const arg = gensparkSidecarFetch.mock.calls[0][0];
    expect(arg.cookies).toEqual(makeCookies());
    expect(arg.payload.type).toBe("ai_chat");
    expect(arg.payload.ai_chat_model).toBe("claude-sonnet-4-6");
    expect(arg.payload.messages[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("streams the assistant content from message_field_delta content frames", async () => {
    const sidecar = {
      body: sseStream([
        '{"type":"project_start","id":"p1"}',
        '{"type":"message_field_delta","field_name":"content","delta":"Hello"}',
        '{"type":"message_field_delta","field_name":"content","delta":" world"}',
        '{"type":"message_result","message":{"content":"Hello world"}}',
      ]),
      error: null,
    };
    const { response } = await runChat({ sidecar });
    expect(response.status).toBe(200);
    const chunks = await consumeSse(response);
    expect(chunks).toContain("data: {");
    expect(chunks).toContain('"content":"Hello"');
    expect(chunks).toContain('"content":" world"');
    expect(chunks).toContain("[DONE]");
  });

  it("builds a non-streaming chat.completion with the accumulated answer", async () => {
    const sidecar = {
      body: sseStream([
        '{"type":"message_field_delta","field_name":"content","delta":"Full"}',
        '{"type":"message_field_delta","field_name":"content","delta":" answer"}',
        '{"type":"message_result","message":{"content":"Full answer"}}',
      ]),
      error: null,
    };
    const { response } = await runChat({ sidecar, stream: false });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Full answer");
  });

  it("does not send the sidecar when a search-mode model is requested (search flag only)", async () => {
    const { response, mock } = await runChat({
      model: "gpt-5.2-pro-search",
      sidecar: { body: sseStream(['{"type":"message_result","message":{"content":"ok"}}']), error: null },
    });
    expect(response.status).toBe(200);
    const arg = mock.mock.calls[0][0];
    expect(arg.payload.ai_chat_model).toBe("gpt-5.2-pro");
    expect(arg.payload.ai_chat_enable_search).toBe(true);
  });

  it("writes refreshed cookies back via onCredentialsRefreshed on a successful stream", async () => {
    const refreshed = { __cf_bm: "fresh-cf-token", cf_clearance: "fresh-clr" };
    const onCredentialsRefreshed = vi.fn().mockResolvedValue(true);
    const sidecar = {
      body: sseStream([
        '{"type":"message_field_delta","field_name":"content","delta":"ok"}',
        '{"type":"message_result","message":{"content":"ok"}}',
      ]),
      error: null,
      refreshedCookies: Promise.resolve(refreshed),
    };
    const { response } = await runChat({ sidecar, onCredentialsRefreshed });
    expect(response.status).toBe(200);
    // The write-back is detached (fire-and-forget) — give the microtasks a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(onCredentialsRefreshed).toHaveBeenCalledTimes(1);
    const arg = onCredentialsRefreshed.mock.calls[0][0];
    // write-back sends the FULL merged jar (existing session_id/c1/c2/gslogin + the
    // refreshed __cf_bm/cf_clearance), not just the diff — otherwise updateProviderCredentials'
    // one-level providerSpecificData merge would wipe session_id and break the next call.
    expect(arg.providerSpecificData.cookies).toEqual({ ...makeCookies(), ...refreshed });
  });

  it("does NOT call onCredentialsRefreshed when no cookies were refreshed", async () => {
    const onCredentialsRefreshed = vi.fn().mockResolvedValue(true);
    const sidecar = {
      body: sseStream([
        '{"type":"message_field_delta","field_name":"content","delta":"ok"}',
        '{"type":"message_result","message":{"content":"ok"}}',
      ]),
      error: null,
      refreshedCookies: Promise.resolve(null),
    };
    const { response } = await runChat({ sidecar, onCredentialsRefreshed });
    expect(response.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(onCredentialsRefreshed).not.toHaveBeenCalled();
  });

  it("does not block the response on the cookie write-back (TTFT stays immediate)", async () => {
    // A never-resolving refresh promise must not delay the 200 + streamed answer.
    let resolveRefresh;
    const pending = new Promise((res) => { resolveRefresh = res; });
    const onCredentialsRefreshed = vi.fn().mockImplementation(() => pending);
    const sidecar = {
      body: sseStream([
        '{"type":"message_field_delta","field_name":"content","delta":"fast"}',
        '{"type":"message_result","message":{"content":"fast"}}',
      ]),
      error: null,
      refreshedCookies: Promise.resolve({ __cf_bm: "x" }),
    };
    const t0 = Date.now();
    const { response } = await runChat({ sidecar, onCredentialsRefreshed });
    const elapsed = Date.now() - t0;
    expect(response.status).toBe(200);
    // If we awaited the write-back, this would block until the pending promise settles.
    expect(elapsed).toBeLessThan(500);
    resolveRefresh(true); // release the pending promise
  });
});