import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  },
}), { virtual: true });

const db = vi.hoisted(() => ({
  combos: new Map(),
  getComboByName: vi.fn(async (name) => db.combos.get(name) || null),
  getCombos: vi.fn(async () => [...db.combos.values()]),
  createCombo: vi.fn(async ({ name, models }) => {
    const combo = { id: `id-${name}`, name, models, kind: null };
    db.combos.set(name, combo);
    return combo;
  }),
  getComboById: vi.fn(async (id) => [...db.combos.values()].find((c) => c.id === id) || null),
  updateCombo: vi.fn(async (id, patch) => {
    const combo = [...db.combos.values()].find((c) => c.id === id);
    if (!combo) return null;
    if (patch.name && patch.name !== combo.name) {
      db.combos.delete(combo.name);
      combo.name = patch.name;
      db.combos.set(combo.name, combo);
    }
    if (Array.isArray(patch.models)) combo.models = patch.models;
    return combo;
  }),
  deleteCombo: vi.fn(),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

import { findComboCycle } from "../../src/sse/services/model.js";
import { POST as createComboRoute } from "../../src/app/api/combos/route.js";
import { PUT as updateComboRoute } from "../../src/app/api/combos/[id]/route.js";

function jsonRequest(body) {
  return new Request("http://localhost/api/combos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.combos.clear();
  vi.clearAllMocks();
});

describe("findComboCycle (C6)", () => {
  it("returns null for a plain acyclic expansion", async () => {
    db.combos.set("b", { id: "id-b", name: "b", models: ["openai/gpt-4o"] });
    expect(await findComboCycle("a", ["b", "anthropic/claude-opus-4.6"])).toBeNull();
  });

  it("detects self-reference", async () => {
    expect(await findComboCycle("a", ["a", "openai/gpt-4o"])).toBe("a");
  });

  it("detects a→b→a through an existing combo", async () => {
    db.combos.set("b", { id: "id-b", name: "b", models: ["openai/gpt-4o", "a"] });
    expect(await findComboCycle("a", ["b"])).toBe("a");
  });

  it("detects longer cycles a→b→c→b", async () => {
    db.combos.set("b", { id: "id-b", name: "b", models: ["c"] });
    db.combos.set("c", { id: "id-c", name: "c", models: ["openai/gpt-4o", "b"] });
    expect(await findComboCycle("a", ["b"])).toBe("b");
  });
});

describe("POST /api/combos cycle rejection (C6)", () => {
  it("rejects a combo whose expansion reaches itself (a→b→a) with 400", async () => {
    db.combos.set("b", { id: "id-b", name: "b", models: ["openai/gpt-4o", "looped"] });
    const res = await createComboRoute(jsonRequest({ name: "looped", models: ["b"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cyclic");
    expect(db.createCombo).not.toHaveBeenCalled();
  });

  it("rejects direct self-reference with 400", async () => {
    const res = await createComboRoute(jsonRequest({ name: "ouroboros", models: ["ouroboros"] }));
    expect(res.status).toBe(400);
  });

  it("still creates an acyclic combo", async () => {
    db.combos.set("b", { id: "id-b", name: "b", models: ["openai/gpt-4o"] });
    const res = await createComboRoute(jsonRequest({ name: "ok", models: ["b"] }));
    expect(res.status).toBe(201);
  });
});

describe("PUT /api/combos/[id] cycle rejection (C6)", () => {
  it("rejects an update that introduces a cycle via rename", async () => {
    db.combos.set("wrapper", { id: "id-wrapper", name: "wrapper", models: ["target"] });
    db.combos.set("other", { id: "id-other", name: "other", models: ["openai/gpt-4o"] });

    // Rename "other" to "target" and point it at "wrapper": post-update,
    // wrapper → target (the renamed combo) → wrapper → … never terminates.
    const req = new Request("http://localhost/api/combos/id-other", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "target", models: ["wrapper"] }),
    });
    const res = await updateComboRoute(req, { params: Promise.resolve({ id: "id-other" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cyclic");
    expect(db.updateCombo).not.toHaveBeenCalled();
  });

  it("accepts an acyclic update", async () => {
    db.combos.set("plain", { id: "id-plain", name: "plain", models: ["openai/gpt-4o"] });
    const req = new Request("http://localhost/api/combos/id-plain", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["anthropic/claude-opus-4.6"] }),
    });
    const res = await updateComboRoute(req, { params: Promise.resolve({ id: "id-plain" }) });
    expect(res.status).toBe(200);
  });
});
