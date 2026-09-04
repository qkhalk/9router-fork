// Phase 02 (X4): createSerialized — overlapping callers queue, results and
// errors stay per-caller, a rejection never poisons the chain.
import { describe, expect, it, vi } from "vitest";
import { createSerialized } from "@/lib/serialize.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createSerialized (X4 mutex)", () => {
  it("runs concurrent callers strictly one at a time", async () => {
    const events = [];
    const gate1 = deferred();
    const fn = vi.fn(async (label, gate) => {
      events.push(`start:${label}`);
      if (gate) await gate.promise;
      events.push(`end:${label}`);
      return label;
    });
    const serialized = createSerialized(fn);

    const a = serialized("a", gate1);
    const b = serialized("b"); // must not start until a finishes
    await Promise.resolve(); // let the first call actually begin (microtask)
    expect(events).toEqual(["start:a"]);
    gate1.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("preserves each caller's own result and error", async () => {
    let call = 0;
    const serialized = createSerialized(async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return "ok";
    });
    await expect(serialized()).rejects.toThrow("boom");
    await expect(serialized()).resolves.toBe("ok");
  });

  it("a rejected call never blocks later callers", async () => {
    const serialized = createSerialized(async (v) => {
      if (v === "bad") throw new Error("nope");
      return v;
    });
    const bad = serialized("bad");
    const good = serialized("good");
    await expect(bad).rejects.toThrow("nope");
    await expect(good).resolves.toBe("good");
  });
});
