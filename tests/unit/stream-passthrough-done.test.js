import { describe, it, expect, vi } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();

function feed(transform, chunks) {
  const input = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return input.pipeThrough(transform);
}

async function readAll(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const OPENAI_CHUNK = 'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const OPENAI_FINISH = 'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n';
const DONE_FRAME = "data: [DONE]\n\n";

// C7/C9: the passthrough branch forwarded [DONE] but never called
// finalizeStream() — a client closing right after the sentinel lost usage
// logging (flush never runs on a cancelled reader) — and flush then emitted a
// SECOND [DONE] frame because streamDoneSent was translate-mode-only.
describe("passthrough [DONE] finalization (C7/C9)", () => {
  it("records usage exactly once when the client closes right after [DONE]", async () => {
    const onStreamComplete = vi.fn();
    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4o", "conn-1", { messages: [] }, onStreamComplete, "key");
    const readable = feed(transform, [OPENAI_CHUNK, OPENAI_FINISH, DONE_FRAME]);

    // Client reads until it has seen the sentinel, then cancels — flush() will
    // never run for this stream.
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      text += decoder.decode(value || new Uint8Array(), { stream: true });
      if (text.includes("[DONE]")) break;
      if (done) break;
    }
    await reader.cancel("client closed");
    expect(text).toContain("[DONE]");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("emits exactly one [DONE] frame when the stream runs to natural end", async () => {
    const onStreamComplete = vi.fn();
    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4o", "conn-1", { messages: [] }, onStreamComplete, "key");
    const text = await readAll(feed(transform, [OPENAI_CHUNK, OPENAI_FINISH, DONE_FRAME]));

    const doneCount = text.split("[DONE]").length - 1;
    expect(doneCount).toBe(1);
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("still appends a [DONE] frame when upstream ends without one", async () => {
    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4o", "conn-1", { messages: [] }, vi.fn(), "key");
    const text = await readAll(feed(transform, [OPENAI_CHUNK, OPENAI_FINISH]));
    expect(text).toContain("[DONE]");
  });
});
