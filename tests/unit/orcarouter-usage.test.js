import { describe, it, expect } from "vitest";

import { getOrcarouterUsage } from "../../open-sse/services/usage/orcarouter.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

const HONEST_MESSAGE =
  "OrcaRouter does not expose an account balance API.";

describe("getOrcarouterUsage", () => {
  it("returns an honest no-balance-API message", async () => {
    const usage = await getOrcarouterUsage("sk-orca", null);

    expect(usage.plan).toBe("OrcaRouter");
    expect(usage.message).toContain(HONEST_MESSAGE);
    expect(usage.message).toMatch(/no credits or remaining-\$ query/i);
    // No fabricated numbers: OrcaRouter has no remaining-$ balance to show.
    expect(usage.quotas).toBeUndefined();
    expect(usage.remaining).toBeUndefined();
  });

  it("dispatch routes orcarouter to the handler", async () => {
    const usage = await getUsageForProvider({
      provider: "orcarouter",
      apiKey: "sk-orca",
    });

    expect(usage.message).toContain(HONEST_MESSAGE);
    expect(usage.message).not.toBe("Usage API not implemented for orcarouter");
  });
});

// NOTE: USAGE_SUPPORTED_PROVIDERS / USAGE_APIKEY_PROVIDERS are derived from
// registry `features.usage` / `features.usageApikey`, which land in a separate
// PR (registry features for tokenrouter / totu-ai / orcarouter). Once that PR
// merges, extend this file with:
//   expect(USAGE_SUPPORTED_PROVIDERS).toContain("orcarouter");
//   expect(USAGE_APIKEY_PROVIDERS).toContain("orcarouter");