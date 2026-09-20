// Unit tests for the genspark-web cookie-jar parsing/serialization service.
//
// Genspark's edge needs the FULL cookie jar (`session_id`, `__cf_bm` Cloudflare
// bot token, `c1`/`c2`, `gslogin`), not just the session id. These tests lock
// the parse → validate → serialize pipeline used by the executor and the
// dashboard validation/test probes.

import { describe, it, expect } from "vitest";
import {
  parseGensparkWebCookies,
  validateGensparkWebCookies,
  serializeGensparkWebCookieHeader,
  extractGensparkWebCredentials,
  maskGensparkWebCookies,
  GENSPARK_WEB_REQUIRED_COOKIE,
} from "../../open-sse/services/gensparkWebCookie.js";

const FULL_JAR = [
  { name: "gk_dogfood", value: "0", domain: ".genspark.ai", path: "/" },
  { name: "sidebar_expanded", value: "1", domain: "www.genspark.ai", path: "/" },
  { name: "ai_user", value: "u=abc123", domain: ".genspark.ai", path: "/" },
  { name: "session_id", value: "sess-xyz", domain: ".genspark.ai", path: "/", httpOnly: true, secure: true },
  { name: "gslogin", value: "1", domain: "www.genspark.ai", path: "/" },
  { name: "__cf_bm", value: "cf-9b1d2", domain: ".genspark.ai", path: "/", httpOnly: true },
  { name: "agree_terms", value: "1", domain: "www.genspark.ai", path: "/" },
  { name: "ai_session", value: "x=1", domain: ".genspark.ai", path: "/" },
  { name: "c1", value: "c1-token", domain: ".genspark.ai", path: "/", httpOnly: true, secure: true },
  { name: "c2", value: "c2-token", domain: ".genspark.ai", path: "/", httpOnly: true, secure: true },
  { name: "from_auth", value: "1", domain: "www.genspark.ai", path: "/" },
  { name: "g_state", value: "{}", domain: ".genspark.ai", path: "/" },
  { name: "i18n_set", value: "en", domain: ".genspark.ai", path: "/" },
];

describe("parseGensparkWebCookies", () => {
  it("parses a chrome-json cookie array", () => {
    const { cookies, sourceFormat, warnings } = parseGensparkWebCookies(FULL_JAR);
    expect(sourceFormat).toBe("chrome-json");
    expect(cookies.session_id).toBe("sess-xyz");
    expect(cookies.__cf_bm).toBe("cf-9b1d2");
    expect(cookies.c1).toBe("c1-token");
    expect(cookies.c2).toBe("c2-token");
    expect(cookies.gslogin).toBe("1");
    expect(warnings).toEqual([]);
  });

  it("parses a JSON string of the same array", () => {
    const { cookies, sourceFormat } = parseGensparkWebCookies(JSON.stringify(FULL_JAR));
    expect(sourceFormat).toBe("chrome-json");
    expect(cookies.session_id).toBe("sess-xyz");
  });

  it("parses a plain json object of name→value pairs", () => {
    const { cookies, sourceFormat } = parseGensparkWebCookies({ session_id: "abc", __cf_bm: "cf", c1: "x" });
    expect(sourceFormat).toBe("json-object");
    expect(cookies).toEqual({ session_id: "abc", __cf_bm: "cf", c1: "x" });
  });

  it("parses a Cookie header string (name=value; name2=value2)", () => {
    const { cookies, sourceFormat } = parseGensparkWebCookies("session_id=s1; __cf_bm=cf1; gslogin=1");
    expect(sourceFormat).toBe("header");
    expect(cookies).toEqual({ session_id: "s1", __cf_bm: "cf1", gslogin: "1" });
  });

  it("parses a bare session_id=... string", () => {
    const { cookies } = parseGensparkWebCookies("session_id=solo");
    expect(cookies.session_id).toBe("solo");
  });

  it("drops expired cookies (expirationDate in the past)", () => {
    const jar = [
      { name: "session_id", value: "sess", domain: ".genspark.ai", expirationDate: 1000 },
      { name: "__cf_bm", value: "cf", domain: ".genspark.ai" },
    ];
    const { cookies } = parseGensparkWebCookies(jar);
    expect(cookies.session_id).toBeUndefined();
    expect(cookies.__cf_bm).toBe("cf");
  });

  it("drops cookies from non-genspark.ai domains", () => {
    const jar = [
      { name: "session_id", value: "sess", domain: ".genspark.ai" },
      { name: "leak", value: "secret", domain: "evil.com" },
    ];
    const { cookies, warnings } = parseGensparkWebCookies(jar);
    expect(cookies.session_id).toBe("sess");
    expect(cookies.leak).toBeUndefined();
    expect(warnings.some((w) => w.includes("non-genspark.ai domain"))).toBe(true);
  });

  it("handles empty / null input without throwing", () => {
    expect(parseGensparkWebCookies(null).cookies).toEqual({});
    expect(parseGensparkWebCookies("").cookies).toEqual({});
    expect(parseGensparkWebCookies(undefined).cookies).toEqual({});
  });

  it("decodes percent-encoded values from a Cookie Editor export", () => {
    // Cookie Editor stores cookie values percent-encoded; a browser sends them raw.
    const jar = [
      { name: "gk_dogfood", value: "%220%22", domain: ".genspark.ai" },
      { name: "session_id", value: "sess%2Bxyz%20abc", domain: ".genspark.ai" },
      { name: "c1", value: "a%2Fb", domain: ".genspark.ai" },
    ];
    const { cookies } = parseGensparkWebCookies(jar);
    expect(cookies.gk_dogfood).toBe('"0"');
    expect(cookies.session_id).toBe("sess+xyz abc");
    expect(cookies.c1).toBe("a/b");
  });

  it("leaves non-encoded values untouched (round-trip guard)", () => {
    // A value with a literal % that isn't a valid double-hex escape stays raw.
    const jar = [
      { name: "session_id", value: "50%discount", domain: ".genspark.ai" },
      { name: "__cf_bm", value: "cf-token", domain: ".genspark.ai" },
    ];
    const { cookies } = parseGensparkWebCookies(jar);
    expect(cookies.session_id).toBe("50%discount");
    expect(cookies.__cf_bm).toBe("cf-token");
  });

  it("does not double-decode or mangle ambiguous values", () => {
    // "%41" decodes to "A", but re-encoding "A" gives "A" (≠ "%41"), so the round-trip
    // guard treats it as an ambiguous literal and keeps it raw rather than mangling a
    // plain value that happens to contain "%41".
    const jar = [
      { name: "session_id", value: "%41", domain: ".genspark.ai" },
      { name: "g_state", value: "%7B%7D", domain: ".genspark.ai" },
    ];
    const { cookies } = parseGensparkWebCookies(jar);
    expect(cookies.session_id).toBe("%41");
    expect(cookies.g_state).toBe("{}");
  });
});

describe("validateGensparkWebCookies", () => {
  it("requires session_id", () => {
    const result = validateGensparkWebCookies({ __cf_bm: "cf" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain(GENSPARK_WEB_REQUIRED_COOKIE);
  });

  it("accepts a full jar and warns about missing recommended cookies", () => {
    const { cookies } = parseGensparkWebCookies(FULL_JAR);
    const result = validateGensparkWebCookies(cookies);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  it("warns when __cf_bm / c1 / c2 / gslogin are missing", () => {
    const result = validateGensparkWebCookies({ session_id: "s1" });
    expect(result.valid).toBe(true);
    const joined = result.warnings.join(" ");
    expect(joined).toContain("__cf_bm");
    expect(joined).toContain("c1");
    expect(joined).toContain("c2");
    expect(joined).toContain("gslogin");
  });
});

describe("serializeGensparkWebCookieHeader", () => {
  it("joins cookies with '; ' in insertion order", () => {
    const header = serializeGensparkWebCookieHeader({ session_id: "a", __cf_bm: "b", c1: "c" });
    expect(header).toBe("session_id=a; __cf_bm=b; c1=c");
  });

  it("skips empty names/values", () => {
    expect(serializeGensparkWebCookieHeader({ session_id: "a", empty: "", nope: null })).toBe("session_id=a");
  });
});

describe("extractGensparkWebCredentials", () => {
  it("prefers providerSpecificData.cookies", () => {
    const { cookies, source, valid } = extractGensparkWebCredentials({
      apiKey: "session_id=old",
      providerSpecificData: { cookies: { session_id: "new", __cf_bm: "cf" } },
    });
    expect(source).toBe("providerSpecificData.cookies");
    expect(valid).toBe(true);
    expect(cookies.session_id).toBe("new");
  });

  it("parses providerSpecificData.cookieText", () => {
    const { cookies, source } = extractGensparkWebCredentials({
      providerSpecificData: { cookieText: "session_id=from-text" },
    });
    expect(source).toBe("kv");
    expect(cookies.session_id).toBe("from-text");
  });

  it("falls back to apiKey", () => {
    const { cookies, valid } = extractGensparkWebCredentials({ apiKey: JSON.stringify(FULL_JAR) });
    expect(valid).toBe(true);
    expect(cookies.session_id).toBe("sess-xyz");
  });

  it("reports invalid when session_id is absent", () => {
    const { valid, error } = extractGensparkWebCredentials({ apiKey: "__cf_bm=cf" });
    expect(valid).toBe(false);
    expect(error).toContain("session_id");
  });
});

describe("maskGensparkWebCookies", () => {
  it("masks cookie values but keeps names", () => {
    const masked = maskGensparkWebCookies({ session_id: "sess-xyz-abc", __cf_bm: "cf-9b1d2cf" });
    expect(masked.session_id).not.toBe("sess-xyz-abc");
    expect(masked.session_id).toContain("…");
    expect(masked.__cf_bm).not.toBe("cf-9b1d2cf");
    expect(Object.keys(masked)).toEqual(["session_id", "__cf_bm"]);
  });
});
