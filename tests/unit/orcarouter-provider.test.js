import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("OrcaRouter provider", () => {
  const orcarouter = REGISTRY.find((e) => e.id === "orcarouter");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(orcarouter).toBeDefined();
    expect(orcarouter.category).toBe("apikey");
    expect(orcarouter.alias).toBe("orcarouter");
    expect(orcarouter.transport.baseUrl).toBe("https://api.orcarouter.ai/v1/chat/completions");
    expect(orcarouter.transport.validateUrl).toBe("https://api.orcarouter.ai/v1/models");
  });

  it("enables dynamic model discovery and passthrough (modelsFetcher at top level)", () => {
    expect(orcarouter.passthroughModels).toBe(true);
    expect(orcarouter.modelsFetcher).toMatchObject({
      url: "https://api.orcarouter.ai/v1/models",
      type: "openai",
    });
  });

  it("builds into the runtime PROVIDERS map with the openai format default", () => {
    expect(PROVIDERS.orcarouter).toBeDefined();
    expect(PROVIDERS.orcarouter.format).toBe("openai");
    expect(PROVIDERS.orcarouter.baseUrl).toBe("https://api.orcarouter.ai/v1/chat/completions");
    expect(PROVIDERS.orcarouter.validateUrl).toBe("https://api.orcarouter.ai/v1/models");
  });

  it("exposes a small example seed list (full catalog comes live via modelsFetcher)", () => {
    const ids = (PROVIDER_MODELS.orcarouter || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(6); // small hint, not a hardcoded catalog
    expect(ids).toContain("openai/gpt-5");
    expect(ids).toContain("anthropic/claude-fable-5");
    expect(ids).toContain("google/gemini-3.6-flash");
  });

  it("is listed in the usage-supported provider sets", () => {
    expect(orcarouter.features).toMatchObject({ usage: true, usageApikey: true });
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("orcarouter");
    expect(USAGE_APIKEY_PROVIDERS).toContain("orcarouter");
  });

  it("keeps every registry id unique after adding orcarouter", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("OrcaRouterExecutor Retry-After handling", () => {
    const exec = getExecutor("orcarouter");

    it("resolves to a specialized OrcaRouterExecutor", () => {
      expect(exec.constructor.name).toBe("OrcaRouterExecutor");
    });

    it("maps a 429 with Retry-After (seconds) to a precise resetsAtMs", () => {
      const res = new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "42" },
      });
      const parsed = exec.parseError(res, "rate limited");
      expect(parsed.status).toBe(429);
      expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 40000);
      expect(parsed.resetsAtMs).toBeLessThan(Date.now() + 44000);
    });

    it("maps a 429 with x-ratelimit-reset-after to a precise resetsAtMs", () => {
      const res = new Response("rate limited", {
        status: 429,
        headers: { "x-ratelimit-reset-after": "15" },
      });
      const parsed = exec.parseError(res, "rate limited");
      expect(parsed.status).toBe(429);
      expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 13000);
      expect(parsed.resetsAtMs).toBeLessThan(Date.now() + 17000);
    });

    it("falls through to the default parseError when no Retry-After header is present", () => {
      const res = new Response("rate limited", { status: 429 });
      const parsed = exec.parseError(res, "rate limited");
      expect(parsed.status).toBe(429);
      expect(parsed.resetsAtMs).toBeUndefined();
    });

    it("falls through to the default parseError for non-429 errors", () => {
      const res = new Response("boom", { status: 500 });
      const parsed = exec.parseError(res, "boom");
      expect(parsed.status).toBe(500);
      expect(parsed.resetsAtMs).toBeUndefined();
    });
  });

  describe('generic "openai" suggested-models filter', () => {
    it("maps an OpenAI {data:[...]} envelope to {id, name}", () => {
      const out = FILTERS.openai([
        { id: "openai/gpt-4o-mini", name: "GPT 4O Mini" },
        { id: "anthropic/claude-opus-5" },
      ]);
      expect(out).toEqual([
        { id: "openai/gpt-4o-mini", name: "GPT 4O Mini" },
        { id: "anthropic/claude-opus-5", name: "anthropic/claude-opus-5" },
      ]);
    });

    it("tolerates a non-array input and drops empty ids", () => {
      expect(FILTERS.openai(null)).toEqual([]);
      expect(FILTERS.openai([{ id: "" }, { id: "grok/grok-4.6" }])).toEqual([
        { id: "grok/grok-4.6", name: "grok/grok-4.6" },
      ]);
    });
  });
});
