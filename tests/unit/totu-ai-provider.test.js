import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { PROVIDER_MODELS_CONFIG } from "../../src/app/api/providers/[id]/models/route.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

describe("TOTU AI provider", () => {
  const totu = REGISTRY.find((e) => e.id === "totu-ai");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(totu).toBeDefined();
    expect(totu.category).toBe("apikey");
    expect(totu.alias).toBe("totu-ai");
    expect(totu.display.name).toBe("TOTU AI");
    expect(totu.display.website).toBe("https://totu-ai.com");
    expect(totu.display.notice.apiKeyUrl).toBe("https://totu-ai.com");
  });

  it("builds into the runtime PROVIDERS map with the openai format default", () => {
    expect(PROVIDERS["totu-ai"]).toBeDefined();
    expect(PROVIDERS["totu-ai"].format).toBe("openai");
    expect(PROVIDERS["totu-ai"].baseUrl).toBe("https://totu-ai.com/v1/chat/completions");
    expect(PROVIDERS["totu-ai"].validateUrl).toBe("https://totu-ai.com/v1/models");
  });

  it("exposes a small example seed list (full catalog comes live via modelsFetcher)", () => {
    const ids = (PROVIDER_MODELS["totu-ai"] || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(6);
    expect(ids).toContain("openai/gpt-5");
  });

  it("uses the public pricing endpoint for suggested free models", () => {
    expect(totu.modelsFetcher).toEqual({
      url: "https://totu-ai.com/api/pricing",
      type: "pricing",
    });
  });

  it("declares media kinds and passthrough", () => {
    expect(totu.serviceKinds).toEqual(["llm", "embedding", "image"]);
    expect(totu.passthroughModels).toBe(true);
    expect(totu.embeddingConfig).toMatchObject({
      baseUrl: "https://totu-ai.com/v1/embeddings",
      authType: "apikey",
      authHeader: "bearer",
    });
    expect(totu.imageConfig).toMatchObject({
      baseUrl: "https://totu-ai.com/v1/images/generations",
    });
  });

  it("is configured in PROVIDER_MODELS_CONFIG for live model listing", () => {
    expect(PROVIDER_MODELS_CONFIG["totu-ai"]).toBeDefined();
  });

  it("is listed in the usage-supported provider sets", () => {
    expect(totu.features).toMatchObject({ usage: true, usageApikey: true });
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("totu-ai");
    expect(USAGE_APIKEY_PROVIDERS).toContain("totu-ai");
  });

  it("keeps every registry id and alias unique", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const aliases = REGISTRY.map((e) => e.alias).filter(Boolean);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});
