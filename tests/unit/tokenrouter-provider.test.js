import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { PROVIDER_MODELS_CONFIG } from "../../src/app/api/providers/[id]/models/route.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const REAL_FREE_IDS = [
  "deepseek/deepseek-v4-pro-0813-free",
  "qwen/qwen3.8-max-free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

describe("TokenRouter provider", () => {
  const tokenrouter = REGISTRY.find((e) => e.id === "tokenrouter");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(tokenrouter).toBeDefined();
    expect(tokenrouter.category).toBe("apikey");
    expect(tokenrouter.alias).toBe("tokenrouter");
    expect(tokenrouter.transport.baseUrl).toBe("https://api.tokenrouter.com/v1/chat/completions");
    expect(tokenrouter.transport.validateUrl).toBe("https://api.tokenrouter.com/v1/models");
  });

  it("keeps a small example seed list (full catalog comes live via modelsFetcher)", () => {
    const ids = (PROVIDER_MODELS.tokenrouter || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(6);
    expect(ids).toContain("openai/gpt-5");
    for (const freeId of REAL_FREE_IDS) {
      expect(ids).toContain(freeId);
    }
  });

  it("removes the stale fake-free seed (moonshotai/kimi-k3-free)", () => {
    const ids = (PROVIDER_MODELS.tokenrouter || []).map((m) => m.id);
    expect(ids).not.toContain("moonshotai/kimi-k3-free");
  });

  it("uses the public pricing endpoint for suggested free models", () => {
    expect(tokenrouter.modelsFetcher).toEqual({
      url: "https://api.tokenrouter.com/api/pricing",
      type: "pricing",
    });
  });

  it("keeps transport/serviceKinds/passthrough untouched", () => {
    expect(tokenrouter.serviceKinds).toEqual(["llm", "embedding", "image"]);
    expect(tokenrouter.passthroughModels).toBe(true);
    expect(tokenrouter.transport.validateUrl).toBe("https://api.tokenrouter.com/v1/models");
  });

  it("builds into the runtime PROVIDERS map with the openai format default", () => {
    expect(PROVIDERS.tokenrouter).toBeDefined();
    expect(PROVIDERS.tokenrouter.format).toBe("openai");
    expect(PROVIDERS.tokenrouter.baseUrl).toBe("https://api.tokenrouter.com/v1/chat/completions");
    expect(PROVIDERS.tokenrouter.validateUrl).toBe("https://api.tokenrouter.com/v1/models");
  });

  it("is configured in PROVIDER_MODELS_CONFIG for live model listing", () => {
    expect(PROVIDER_MODELS_CONFIG.tokenrouter).toBeDefined();
  });

  it("is listed in the usage-supported provider sets", () => {
    expect(tokenrouter.features).toMatchObject({ usage: true, usageApikey: true });
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("tokenrouter");
    expect(USAGE_APIKEY_PROVIDERS).toContain("tokenrouter");
  });

  it("keeps every registry id unique", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('generic "pricing" suggested-models filter', () => {
    it("keeps only free models (model_ratio === 0)", () => {
      const out = FILTERS.pricing([
        { model_name: "qwen/qwen3.8-max-free", model_ratio: 0 },
        { model_name: "openai/gpt-5", model_ratio: 0.5 },
        { model_name: "deepseek/deepseek-v4-pro-0813-free", model_ratio: 0 },
      ]);
      expect(out).toEqual([
        { id: "deepseek/deepseek-v4-pro-0813-free", name: "deepseek/deepseek-v4-pro-0813-free" },
        { id: "qwen/qwen3.8-max-free", name: "qwen/qwen3.8-max-free" },
      ]);
    });

    it("tolerates a keyed {data:[...]} envelope and non-array input", () => {
      const out = FILTERS.pricing({ data: [{ model_name: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", model_ratio: 0 }] });
      expect(out).toEqual([
        { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
      ]);
      expect(FILTERS.pricing(null)).toEqual([]);
    });
  });
});
