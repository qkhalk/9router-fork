// Unit tests for the genspark TLS sidecar harness's cookie write-back contract.
//
// The harness (gensparkTlsSidecar.js) must:
//   - parse a `[genspark-cookie-refresh] <json>` line on the child's stderr into
//     a `refreshedCookies` promise (resolved with the parsed diff, or null),
//   - export the same sentinel prefix the Python sidecar emits.
//
// We mock `node:child_process` `spawn` so no real Python process runs, and force
// `findSidecarPython` onto the "venv present" fast-path so the harness actually
// spawns (and registers its stderr/close handlers) instead of bootstrapping.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: vi.fn((cmd, args, opts, cb) => cb && cb(null, "", "")),
}));

import { spawn } from "node:child_process";
import * as harness from "open-sse/services/gensparkTlsSidecar.js";

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Force the python-resolution fast path (skip the venv bootstrap probe) so spawn
// is actually invoked with our fake child.
vi.spyOn(harness, "findSidecarPython").mockReturnValue({ command: "python", isVenv: true });

/** A fake child that records the harness's event handlers so the test can drive them. */
function fakeChild() {
  const handlers = { stderr: {}, close: [], error: [] };
  const child = {
    stdin: { write() {}, end() {} },
    stdout: { setEncoding() {}, on() {} },
    stderr: { on(ev, cb) { if (ev === "data") handlers.stderrData = cb; } },
    on(ev, cb) {
      if (ev === "close") handlers.close.push(cb);
      else if (ev === "error") handlers.error.push(cb);
    },
    kill() {},
  };
  child._triggerStderr = (text) => handlers.stderrData && handlers.stderrData(text);
  child._triggerClose = (code) => handlers.close.forEach((cb) => cb(code));
  spawn.mockReturnValue(child);
  return child;
}

beforeEach(() => {
  spawn.mockClear();
});

describe("genspark sidecar harness — cookie write-back", () => {
  it("exports the same COOKIE_REFRESH_PREFIX the Python sidecar emits", () => {
    // Must match gensparkTlsSidecar.py COOKIE_REFRESH_PREFIX.
    expect(harness.COOKIE_REFRESH_PREFIX).toBe("[genspark-cookie-refresh]");
  });

  it("resolves refreshedCookies from a sentinel line on stderr", async () => {
    fakeChild();
    const result = await harness.gensparkSidecarFetch({
      cookies: { session_id: "x" },
      payload: { type: "ai_chat" },
      log,
    });
    // Emit the sentinel on stderr, then close the child.
    // (handlers registered synchronously inside gensparkSidecarFetch before it returns)
    spawn.mock.results[0].value._triggerStderr(
      Buffer.from(`${harness.COOKIE_REFRESH_PREFIX} {"__cf_bm":"new","cf_clearance":"clr"}\n`),
    );
    spawn.mock.results[0].value._triggerClose(0);

    const refreshed = await result.refreshedCookies;
    expect(refreshed).toEqual({ __cf_bm: "new", cf_clearance: "clr" });
  });

  it("resolves refreshedCookies to null when no sentinel is emitted", async () => {
    fakeChild();
    const result = await harness.gensparkSidecarFetch({
      cookies: { session_id: "x" },
      payload: { type: "ai_chat" },
      log,
    });
    spawn.mock.results[0].value._triggerStderr(Buffer.from("[genspark-sidecar] note: streamed ok\n"));
    spawn.mock.results[0].value._triggerClose(0);

    const refreshed = await result.refreshedCookies;
    expect(refreshed).toBeNull();
  });

  it("ignores a malformed sentinel line and stays null", async () => {
    fakeChild();
    const result = await harness.gensparkSidecarFetch({
      cookies: { session_id: "x" },
      payload: { type: "ai_chat" },
      log,
    });
    spawn.mock.results[0].value._triggerStderr(Buffer.from(`${harness.COOKIE_REFRESH_PREFIX} not-json{\n`));
    spawn.mock.results[0].value._triggerClose(0);

    const refreshed = await result.refreshedCookies;
    expect(refreshed).toBeNull();
  });
});
