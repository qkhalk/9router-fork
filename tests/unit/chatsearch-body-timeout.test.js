import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

const REQUEST_TIMEOUT_MS = 15000;

const ARGS = {
  provider: "openai",
  query: "what is the weather on saturn",
  model: "gpt-4o-search-preview",
  credentials: { apiKey: "sk-test" },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// C10: the abort timer used to be cleared the moment HEADERS arrived, so an
// upstream that sent 200 + headers and then went silent held the request open
// forever during resp.json(). The timer must stay armed through the body read.
describe("chatSearch body-read timeout (C10)", () => {
  it("returns a 504-shape error when the body stalls past REQUEST_TIMEOUT_MS", async () => {
    global.fetch = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    }));

    const pending = handleChatSearch(ARGS);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toBe("Upstream timeout (body)");
  });

  it("aborts the upstream request (signal fired) on body stall", async () => {
    let aborted = false;
    global.fetch = vi.fn(async (_url, init) => {
      init.signal.addEventListener("abort", () => { aborted = true; });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
      };
    });

    const pending = handleChatSearch(ARGS);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    await pending;
    expect(aborted).toBe(true);
  });

  it("keeps the 504 shape for a timeout BEFORE headers (fetch rejects on abort)", async () => {
    global.fetch = vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));

    const pending = handleChatSearch(ARGS);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toBe("Upstream timeout");
  });

  it("clears the timer after a successful body read (no dangling handle)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: "It rains diamonds.", annotations: [] } }],
        usage: { total_tokens: 12 },
      }),
    }));

    const result = await handleChatSearch(ARGS);
    expect(result.success).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the body is unparseable garbage (502 path)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
    }));

    const result = await handleChatSearch(ARGS);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(vi.getTimerCount()).toBe(0);
  });
});
