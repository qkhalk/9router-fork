import { describe, it, expect, vi } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

import { inspectAndWrapCommandCodeResponse } from "../../open-sse/executors/commandcode.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

// Shared stream-parser fuzz harness (phase-04 quality infra): deterministic
// seeded random chunk-splits through the two stream rewriters whose bugs were
// chunk-boundary dependent (C1 peek replay, C7/C9 passthrough finalize).
// A failure is reproducible from the seed printed in the assertion message.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSplit(text, rand) {
  const nChunks = 1 + Math.floor(rand() * 8);
  const cuts = Array.from({ length: nChunks - 1 }, () => Math.floor(rand() * text.length)).sort((a, b) => a - b);
  const chunks = [];
  let prev = 0;
  for (const c of [...cuts, text.length]) {
    chunks.push(text.slice(prev, c));
    prev = c;
  }
  return chunks.filter((c) => c.length > 0);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunkedStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function readAll(readable) {
  const reader = readable.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const ITERATIONS = 1000;

const CC_EVENTS = [
  JSON.stringify({ type: "start" }),
  JSON.stringify({ type: "reasoning-start", id: "r0" }),
  JSON.stringify({ type: "reasoning-delta", id: "r0", text: "think" }),
  JSON.stringify({ type: "text-start", id: "t0" }),
  JSON.stringify({ type: "text-delta", id: "t0", text: "A" }),
  JSON.stringify({ type: "text-delta", id: "t0", text: "B" }),
  JSON.stringify({ type: "tool-input-start", id: "ti0", toolName: "get_weather" }),
  JSON.stringify({ type: "tool-input-delta", id: "ti0", delta: '{"ci' }),
  JSON.stringify({ type: "tool-input-end", id: "ti0" }),
  JSON.stringify({ type: "text-delta", id: "t0", text: "C" }),
  JSON.stringify({ type: "text-end", id: "t0" }),
  JSON.stringify({ type: "finish-step", finishReason: "stop" }),
  JSON.stringify({ type: "finish" }),
];

describe("fuzz: commandcode peek under random chunk boundaries", () => {
  it("never loses or reorders events across random splits", async () => {
    const rand = mulberry32(0x9E3779B9);
    for (let i = 0; i < ITERATIONS; i++) {
      const wire = CC_EVENTS.map((l) => l + "\n").join("");
      const resp = await inspectAndWrapCommandCodeResponse(
        new Response(chunkedStream(randomSplit(wire, rand)), { status: 200 }),
        "commandcode/fuzz-model"
      );
      const text = await resp.text();
      const events = [];
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        events.push(JSON.parse(payload));
      }
      const content = events
        .map((e) => e?.choices?.[0]?.delta?.content)
        .filter((c) => typeof c === "string")
        .join("");
      expect(content, `iter ${i}: content mangled`).toBe("ABC");
      expect(text, `iter ${i}: missing DONE`).toContain("data: [DONE]");
    }
  });
});

// C7/C9: usage finalization + single [DONE] under arbitrary split points.
const SSE_WIRE = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
  "data: [DONE]\n\n",
].join("");

describe("fuzz: passthrough stream under random chunk boundaries", () => {
  it("emits exactly one [DONE] and finalizes once, for every split", async () => {
    const rand = mulberry32(0x1234ABCDEF);
    for (let i = 0; i < ITERATIONS; i++) {
      const onStreamComplete = vi.fn();
      const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4o", "conn-fuzz", { messages: [] }, onStreamComplete, "key");
      const out = chunkedStream(randomSplit(SSE_WIRE, rand)).pipeThrough(transform);
      const text = await readAll(out);

      expect((text.match(/\[DONE\]/g) || []).length, `iter ${i}: duplicate/missing DONE`).toBe(1);
      expect(onStreamComplete, `iter ${i}: finalize ran ${onStreamComplete.mock.calls.length}x`).toHaveBeenCalledTimes(1);
      expect(text, `iter ${i}: content lost`).toContain("hel");
      expect(text, `iter ${i}: content lost`).toContain("lo");
    }
  });
});
