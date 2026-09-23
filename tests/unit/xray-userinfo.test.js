// Table-driven tests for the pure subscription-userinfo parser (Phase 2).
import { describe, expect, it } from "vitest";
import { parseSubscriptionUserinfo } from "../../src/lib/xray/userinfo.js";

describe("parseSubscriptionUserinfo", () => {
  it("parses the canonical header", () => {
    expect(
      parseSubscriptionUserinfo({
        "subscription-userinfo": "upload=1073741824; download=2147483648; total=5368709120; expire=1798761600",
      })
    ).toEqual({
      uploadBytes: 1073741824,
      downloadBytes: 2147483648,
      totalBytes: 5368709120,
      expireAt: new Date(1798761600 * 1000).toISOString(),
    });
  });

  it("matches the header name case-insensitively and tolerates vendor prefixes", () => {
    const viaHeaders = new Headers({
      "Subscription-Userinfo": "upload=1; download=2; total=3; expire=1798761600",
    });
    expect(parseSubscriptionUserinfo(viaHeaders).totalBytes).toBe(3);

    const prefixed = parseSubscriptionUserinfo({
      "x-amz-meta-subscription-userinfo": "upload=4; download=5; total=6",
    });
    expect(prefixed).toMatchObject({ uploadBytes: 4, downloadBytes: 5, totalBytes: 6 });
  });

  it("returns zeros + null expiry for missing header / null headers", () => {
    expect(parseSubscriptionUserinfo({})).toEqual({ uploadBytes: 0, downloadBytes: 0, totalBytes: 0, expireAt: null });
    expect(parseSubscriptionUserinfo(null)).toEqual({ uploadBytes: 0, downloadBytes: 0, totalBytes: 0, expireAt: null });
    expect(parseSubscriptionUserinfo(new Headers())).toEqual({ uploadBytes: 0, downloadBytes: 0, totalBytes: 0, expireAt: null });
  });

  it("ignores garbage pairs and unparseable numbers without throwing", () => {
    expect(
      parseSubscriptionUserinfo({
        "subscription-userinfo": "garbage; upload=abc; download=;; total=-5; expire=notanumber",
      })
    ).toEqual({ uploadBytes: 0, downloadBytes: 0, totalBytes: 0, expireAt: null });
  });

  it("treats total=0 as unlimited (kept 0) and expire=0 as never (null)", () => {
    expect(
      parseSubscriptionUserinfo({ "subscription-userinfo": "upload=1; download=2; total=0; expire=0" })
    ).toEqual({ uploadBytes: 1, downloadBytes: 2, totalBytes: 0, expireAt: null });
  });

  it("defaults missing keys to 0 and floors fractional bytes", () => {
    expect(
      parseSubscriptionUserinfo({ "subscription-userinfo": "total=99.9" })
    ).toEqual({ uploadBytes: 0, downloadBytes: 0, totalBytes: 99, expireAt: null });
  });
});
