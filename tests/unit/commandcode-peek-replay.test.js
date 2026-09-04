import { describe, it, expect, vi, afterEach } from "vitest";

// tests/node_modules is incomplete — shim packages that exist in the repo's
// root package.json but not under tests/. Virtual so no real file is needed.
vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

import { inspectAndWrapCommandCodeResponse } from "../../open-sse/executors/commandcode.js";

// Build an NDJSON body whose chunks are given verbatim — lets tests control
// TCP-read boundaries precisely (the C1 bug only manifests when the sentinel
// and following deltas land in the SAME chunk).
function chunkedNdjsonStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const ndjson = (obj) => JSON.stringify(obj);

// Feed an upstream NDJSON response through the peek wrapper and collect the
// forwarded SSE events (parsed `data:` payloads).
async function collectWrappedSse(response) {
  const text = await response.text();
  const events = [];
  let sawDone = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") { sawDone = true; continue; }
    try { events.push(JSON.parse(payload)); } catch { /* skip */ }
  }
  return { text, events, sawDone };
}

// Concatenate the content deltas of a wrapped OpenAI SSE stream, in order.
const contentOf = (events) => events
  .map((e) => e?.choices?.[0]?.delta?.content)
  .filter((c) => typeof c === "string")
  .join("");

const MODEL = "commandcode/poolside/laguna-s-2.1-free";

// Canonical happy-path event sequence: preamble, first real delta (sentinel),
// more deltas, finish.
const EVENT_LINES = [
  ndjson({ type: "start" }),
  ndjson({ type: "text-start", id: "t0" }),
  ndjson({ type: "text-delta", id: "t0", text: "A" }),
  ndjson({ type: "text-delta", id: "t0", text: "B" }),
  ndjson({ type: "text-delta", id: "t0", text: "C" }),
  ndjson({ type: "text-end", id: "t0" }),
  ndjson({ type: "finish", finishReason: "stop" }),
];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["9R_CC_PEEK_LEGACY"];
  delete process.env.NINEROUTER_CC_PEEK_LEGACY;
});

describe("C1: sentinel + post-sentinel lines in the SAME chunk", () => {
  it("delivers every event in order when the whole response arrives as one chunk", async () => {
    // Regression shape: providers flush sentinel + first deltas in ONE write.
    // The old peek `break`-discarded every complete line after the sentinel.
    const oneChunk = EVENT_LINES.join("\n") + "\n";
    const resp = await inspectAndWrapCommandCodeResponse(
      new Response(chunkedNdjsonStream([oneChunk]), { status: 200, headers: { "content-type": "application/x-ndjson" } }),
      MODEL
    );
    expect(resp.status).toBe(200);
    const { events, sawDone } = await collectWrappedSse(resp);
    expect(sawDone).toBe(true);
    expect(contentOf(events)).toBe("ABC");
  });

  it("delivers every event in order when the sentinel shares a chunk with exactly one follower", async () => {
    const chunks = [
      EVENT_LINES[0] + "\n" + EVENT_LINES[1] + "\n",
      EVENT_LINES[2] + "\n" + EVENT_LINES[3] + "\n",   // sentinel + 1 delta
      EVENT_LINES[4] + "\n" + EVENT_LINES[5] + "\n" + EVENT_LINES[6] + "\n",
    ];
    const resp = await inspectAndWrapCommandCodeResponse(
      new Response(chunkedNdjsonStream(chunks), { status: 200 }),
      MODEL
    );
    const { events } = await collectWrappedSse(resp);
    expect(contentOf(events)).toBe("ABC");
  });

  it("property: any random chunk split preserves the full ordered stream (1000 iterations)", async () => {
    // Deterministic PRNG so a failure is reproducible from the seed.
    const seed = 0xC0FFEE;
    const rand = mulberry32(seed);
    for (let iter = 0; iter < 1000; iter++) {
      const chunks = randomSplit(EVENT_LINES.join("\n") + "\n", rand);
      const resp = await inspectAndWrapCommandCodeResponse(
        new Response(chunkedNdjsonStream(chunks), { status: 200 }),
        MODEL
      );
      const { events, sawDone } = await collectWrappedSse(resp);
      expect(sawDone, `iter ${iter} missing [DONE]`).toBe(true);
      expect(contentOf(events), `iter ${iter} content mangled`).toBe("ABC");
    }
  });
});

describe("N8: pre-sentinel buffer cap", () => {
  it("degrades to passthrough (with a warning) when no sentinel arrives within the cap, without losing tail content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // ~1.1 MiB of unknown event types (no sentinel ever), then real content.
    const filler = [];
    let fillerBytes = 0;
    const blob = "x".repeat(512);
    while (fillerBytes < 1024 * 1024 + 64 * 1024) {
      const line = ndjson({ type: "renamed-unknown-event", blob });
      filler.push(line);
      fillerBytes += line.length + 1;
    }
    const chunks = [
      filler.map((l) => l + "\n").join(""),
      EVENT_LINES.slice(2).map((l) => l + "\n").join(""), // deltas + finish AFTER the cap
    ];
    const resp = await inspectAndWrapCommandCodeResponse(
      new Response(chunkedNdjsonStream(chunks), { status: 200 }),
      MODEL
    );
    expect(resp.status).toBe(200);
    const { events, sawDone } = await collectWrappedSse(resp);
    expect(sawDone).toBe(true);
    expect(contentOf(events)).toBe("ABC");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("degrading to streaming passthrough");
  });
});

describe("N9: wrapped Response header whitelist", () => {
  it("drops stale content-length/content-encoding/transfer-encoding and keeps safe headers", async () => {
    const upstream = new Response(chunkedNdjsonStream([EVENT_LINES.join("\n") + "\n"]), {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "content-length": "9999",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        "x-request-id": "req-123",
      },
    });
    const resp = await inspectAndWrapCommandCodeResponse(upstream, MODEL);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    expect(resp.headers.get("content-length")).toBeNull();
    expect(resp.headers.get("content-encoding")).toBeNull();
    expect(resp.headers.get("transfer-encoding")).toBeNull();
    expect(resp.headers.get("x-request-id")).toBe("req-123");
  });
});

describe("C8: peek error mid-body replays buffered prefix", () => {
  it("returns a body that replays complete buffered lines before the error surfaces", async () => {
    // Two chunks are delivered and consumed, THEN the stream errors (error()
    // would discard queued chunks, so the failure must come from pull()).
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(EVENT_LINES[0] + "\n" + EVENT_LINES[1] + "\n"));
        controller.enqueue(encoder.encode(EVENT_LINES[2].slice(0, 10))); // partial line
      },
      pull() {
        throw new Error("upstream connection reset");
      },
    });
    const resp = await inspectAndWrapCommandCodeResponse(
      new Response(upstreamBody, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
      MODEL
    );
    // The catch-path Response hands back the buffered prefix...
    expect(resp.status).toBe(200);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const replayed = decoder.decode(value);
    // ...which still contains every complete line consumed before the error.
    expect(replayed).toContain(EVENT_LINES[0]);
    expect(replayed).toContain(EVENT_LINES[1]);
    await expect(reader.read()).rejects.toThrow();
  });
});

describe("C1 escape hatch", () => {
  it("9R_CC_PEEK_LEGACY=1 bypasses the peek (error event stays a wrapped 200 stream)", async () => {
    process.env["9R_CC_PEEK_LEGACY"] = "1";
    const errorLine = ndjson({ type: "error", error: { type: "server_error", message: "Service temporarily unavailable", statusCode: 503 } });
    const resp = await inspectAndWrapCommandCodeResponse(
      new Response(chunkedNdjsonStream([errorLine + "\n"]), { status: 200 }),
      MODEL
    );
    // No peek → no error pre-scan → streams through as SSE instead of a 503 JSON.
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Split `text` into 1..N chunks at random byte offsets (never losing bytes).
function randomSplit(text, rand) {
  const nChunks = 1 + Math.floor(rand() * 6);
  const cuts = Array.from({ length: nChunks - 1 }, () => Math.floor(rand() * text.length)).sort((a, b) => a - b);
  const chunks = [];
  let prev = 0;
  for (const c of [...cuts, text.length]) {
    chunks.push(text.slice(prev, c));
    prev = c;
  }
  return chunks.filter((c) => c.length > 0);
}
