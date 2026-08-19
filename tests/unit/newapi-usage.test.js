import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getNewApiBalanceUsage } from "../../open-sse/services/usage/newapi.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BALANCE_BODY = { data: { quota: 3500000, used_quota: 100000 } };

describe("getNewApiBalanceUsage (NewAPI gateways)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no login token → honest message, no network call", async () => {
    const usage = await getNewApiBalanceUsage({
      baseUrl: "https://api.tokenrouter.com",
      price: 7,
      providerName: "TokenRouter",
      loginToken: null,
      proxyOptions: null,
    });

    expect(usage.plan).toBe("TokenRouter");
    expect(usage.message).toMatch(/no dashboard login token stored/i);
    expect(usage.message).toMatch(/cannot query balance/i);
    expect(usage.quotas).toBeUndefined();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("converts quota units → USD: tokenrouter 3500000→49, totu 3500000→3.5", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(BALANCE_BODY));

    const tokenrouter = await getNewApiBalanceUsage({
      baseUrl: "https://api.tokenrouter.com",
      price: 7,
      providerName: "TokenRouter",
      loginToken: "session-token",
      proxyOptions: null,
    });
    expect(tokenrouter.plan).toBe("TokenRouter");
    expect(tokenrouter.quotas["Remaining ($)"]).toMatchObject({
      used: 0,
      total: 49,
      remainingPercentage: 100,
      resetAt: null,
      unlimited: false,
    });
    expect(tokenrouter.quotas["Used ($)"]).toMatchObject({
      used: 1.4, // 100000 / 500000 * 7
      total: 0,
      remainingPercentage: 100,
      unlimited: true,
    });
    // never an absolute remaining — QuotaTable treats it as a 0-100 percentage
    expect(tokenrouter.quotas["Remaining ($)"].remaining).toBeUndefined();
    expect(tokenrouter.quotas["Used ($)"].remaining).toBeUndefined();

    proxyAwareFetch.mockResolvedValue(jsonResponse(BALANCE_BODY));

    const totu = await getNewApiBalanceUsage({
      baseUrl: "https://totu-ai.com",
      price: 0.5,
      providerName: "TOTU AI",
      loginToken: "session-token",
      proxyOptions: null,
    });
    expect(totu.plan).toBe("TOTU AI");
    expect(totu.quotas["Remaining ($)"].total).toBe(3.5);
    expect(totu.quotas["Used ($)"].used).toBe(0.1); // 100000 / 500000 * 0.5
  });

  it("requests /api/user/self with Bearer login token, not the sk- key", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(BALANCE_BODY));

    await getNewApiBalanceUsage({
      baseUrl: "https://api.tokenrouter.com",
      price: 7,
      providerName: "TokenRouter",
      loginToken: "session-abc",
      proxyOptions: { enabled: true },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts, proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.tokenrouter.com/api/user/self");
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer session-abc");
    expect(proxyOptions).toEqual({ enabled: true });
  });

  it("401/403 → expired-or-invalid message", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ data: {} }, 401));

    const usage = await getNewApiBalanceUsage({
      baseUrl: "https://totu-ai.com",
      price: 0.5,
      providerName: "TOTU AI",
      loginToken: "stale-token",
      proxyOptions: null,
    });

    expect(usage.plan).toBe("TOTU AI");
    expect(usage.message).toMatch(/login token expired or invalid/i);
    expect(usage.quotas).toBeUndefined();
  });

  it("non-ok status → balance API error message", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const usage = await getNewApiBalanceUsage({
      baseUrl: "https://api.tokenrouter.com",
      price: 7,
      providerName: "TokenRouter",
      loginToken: "session-token",
      proxyOptions: null,
    });

    expect(usage.message).toMatch(/balance API error \(500\)/);
  });
});

describe("getUsageForProvider dispatch (tokenrouter / totu-ai)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes tokenrouter to the NewAPI balance handler", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(BALANCE_BODY));

    const usage = await getUsageForProvider({
      provider: "tokenrouter",
      providerSpecificData: { loginToken: "session-token" },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("TokenRouter");
    expect(usage.quotas["Remaining ($)"].total).toBe(49);
  });

  it("routes totu-ai to the NewAPI balance handler", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse(BALANCE_BODY));

    const usage = await getUsageForProvider({
      provider: "totu-ai",
      providerSpecificData: { loginToken: "session-token" },
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("TOTU AI");
    expect(usage.quotas["Remaining ($)"].total).toBe(3.5);
  });
});