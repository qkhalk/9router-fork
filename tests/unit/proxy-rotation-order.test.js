// Phase 01 (P4/P7): proxy-group entry selection — empty-URL entries are
// unselectable, rotation order is deterministic, round-robin is per-pool.
import { beforeEach, describe, expect, it } from "vitest";
import {
  pickProxyGroupEntry,
  groupHasAvailableEntry,
  _resetGroupRrCursors,
} from "@/lib/network/proxyRotation.js";

function entry(id, overrides = {}) {
  return {
    id,
    name: id,
    type: "http",
    proxyUrl: `http://${id}:8080`,
    isActive: true,
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function pool(entries, rotationMode = "on-error") {
  return { id: "pool-a", isGroup: true, rotationMode, entries };
}

beforeEach(() => {
  _resetGroupRrCursors();
});

describe("empty-URL entries are never selected (P4)", () => {
  it("all entries empty-URL → no pick, group reports unavailable", () => {
    const p = pool([entry("e1", { proxyUrl: "" }), entry("e2", { proxyUrl: "" })]);
    expect(pickProxyGroupEntry(p)).toBeNull();
    expect(groupHasAvailableEntry(p)).toBe(false);
  });

  it("empty-URL placeholder is skipped; populated entry picked", () => {
    const p = pool([entry("placeholder", { proxyUrl: "" }), entry("real")]);
    const picked = pickProxyGroupEntry(p);
    expect(picked.entry.id).toBe("real");
    expect(groupHasAvailableEntry(p)).toBe(true);
  });

  it("'direct' entries need no URL and stay selectable", () => {
    const p = pool([entry("d1", { type: "direct", proxyUrl: "" })]);
    const picked = pickProxyGroupEntry(p);
    expect(picked.entry.id).toBe("d1");
  });
});

describe("rotation order is deterministic (P7)", () => {
  it("round-robin cycles entries in stable order across 100 picks", () => {
    const p = pool([entry("e1"), entry("e2"), entry("e3")], "round-robin");
    const picks = [];
    for (let i = 0; i < 100; i++) {
      // Fresh pool object each pick (as the resolver re-reads from DB) — the
      // cursor must live outside the pool snapshot.
      const picked = pickProxyGroupEntry({ ...p, entries: [...p.entries] });
      picks.push(picked.entry.id);
    }
    const expected = [];
    for (let i = 0; i < 100; i++) expected.push(`e${(i % 3) + 1}`);
    expect(picks).toEqual(expected);
  });

  it("round-robin cursors are per-pool", () => {
    const a = pool([entry("a1"), entry("a2")], "round-robin");
    const b = { ...pool([entry("b1"), entry("b2")], "round-robin"), id: "pool-b" };
    expect(pickProxyGroupEntry(a).entry.id).toBe("a1");
    expect(pickProxyGroupEntry(b).entry.id).toBe("b1");
    expect(pickProxyGroupEntry(a).entry.id).toBe("a2");
    expect(pickProxyGroupEntry(b).entry.id).toBe("b2");
  });

  it("on-error mode picks least-recently-used deterministically", () => {
    const p = pool([
      entry("e1", { lastUsedAt: new Date(Date.now() - 1000).toISOString() }),
      entry("e2", { lastUsedAt: new Date(Date.now() - 60000).toISOString() }),
      entry("e3", { lastUsedAt: null }),
    ]);
    // Never-used sorts first; then oldest.
    expect(pickProxyGroupEntry(p).entry.id).toBe("e3");
    const stamped = pool([
      entry("e1", { lastUsedAt: new Date(Date.now() - 1000).toISOString() }),
      entry("e2", { lastUsedAt: new Date(Date.now() - 60000).toISOString() }),
    ]);
    expect(pickProxyGroupEntry(stamped).entry.id).toBe("e2");
  });

  it("excluded entries are skipped this turn", () => {
    const p = pool([entry("e1"), entry("e2")]);
    const picked = pickProxyGroupEntry(p, new Set(["e1"]));
    expect(picked.entry.id).toBe("e2");
  });

  it("picked entry carries a fresh lastUsedAt stamp for delta persistence", () => {
    const picked = pickProxyGroupEntry(pool([entry("e1")]));
    expect(typeof picked.entry.lastUsedAt).toBe("string");
    expect(Number.isFinite(new Date(picked.entry.lastUsedAt).getTime())).toBe(true);
  });
});
