import { describe, it, expect } from "vitest";
import { checkFallbackError, NO_FALLBACK_STATUSES } from "../../open-sse/services/accountFallback.js";

// C4: deterministic client errors must not lock accounts or trigger fallback.
// The old default (`shouldFallback: true` for ANY unmatched status) made a
// single bad request lock every account of a provider for 30s each.
describe("NO_FALLBACK_STATUSES (C4)", () => {
  it("exports the documented deterministic client-error set", () => {
    expect([...NO_FALLBACK_STATUSES].sort()).toEqual([400, 401, 402, 404, 405, 413, 422]);
  });

  it.each([400, 401, 402, 404, 405, 413, 422])(
    "status %d → no fallback, no cooldown",
    (status) => {
      const { shouldFallback, cooldownMs } = checkFallbackError(status, "Invalid request body");
      expect(shouldFallback).toBe(false);
      expect(cooldownMs).toBe(0);
    }
  );

  it("keeps fallback when TEXT evidence makes the error account-specific", () => {
    // Text rules outrank the no-fallback set: a 402 "quota exceeded" is THIS
    // account running out — the next account may still have credits.
    expect(checkFallbackError(402, "quota exceeded").shouldFallback).toBe(true);
    expect(checkFallbackError(400, "rate limit hit").shouldFallback).toBe(true);
  });

  it("keeps fallback for transient/server statuses", () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      const { shouldFallback } = checkFallbackError(status, "server overloaded");
      expect(shouldFallback, `status ${status}`).toBe(true);
    }
  });

  it("keeps fallback for unmatched odd statuses (e.g. 403 without a rule)", () => {
    // 403 has no ERROR_RULES entry in all providers; conservative default.
    const { shouldFallback } = checkFallbackError(403, "forbidden");
    expect(shouldFallback).toBe(true);
  });
});
