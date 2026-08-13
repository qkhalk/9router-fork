// v0.6.19 — multi-format proxy URL parser.
// Covers standard order, REVERSED order (the main gap), bare colon forms,
// missing scheme, IPv6, and a spread of error cases.
import { describe, it, expect } from "vitest";
import {
  normalizeProxyInput,
  canonicalizeProxyUrl,
  parseProxyParts,
} from "@/lib/proxy/parseProxy.js";

describe("normalizeProxyInput — standard order (already valid URLs)", () => {
  it("scheme://user:pass@host:port", () => {
    const r = normalizeProxyInput("http://alice:secret@1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("http://alice:secret@1.2.3.4:8080");
    expect(r.parsed).toMatchObject({
      scheme: "http",
      host: "1.2.3.4",
      port: 8080,
      username: "alice",
      password: "secret",
    });
  });

  it("scheme://host:port (no auth)", () => {
    const r = normalizeProxyInput("http://1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("http://1.2.3.4:8080");
    expect(r.parsed.username).toBe("");
  });

  it("socks5://user:pass@host:port", () => {
    const r = normalizeProxyInput("socks5://u:p@example.com:1080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("socks5://u:p@example.com:1080");
    expect(r.parsed.scheme).toBe("socks5");
  });

  it("user with no password", () => {
    const r = normalizeProxyInput("http://alice@1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("http://alice@1.2.3.4:8080");
    expect(r.parsed.password).toBe("");
  });

  it("fills default port when omitted (http → 80)", () => {
    const r = normalizeProxyInput("http://alice:secret@1.2.3.4");
    expect(r.ok).toBe(true);
    expect(r.parsed.port).toBe(80);
    expect(r.canonicalUrl).toBe("http://alice:secret@1.2.3.4:80");
  });
});

describe("normalizeProxyInput — REVERSED order (the main gap)", () => {
  it("scheme://host:port@user:pass → standard", () => {
    // This is what `new URL()` gets wrong — host:port ends up as userinfo.
    const r = normalizeProxyInput("http://1.2.3.4:8080@alice:secret");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({
      scheme: "http",
      host: "1.2.3.4",
      port: 8080,
      username: "alice",
      password: "secret",
    });
    expect(r.canonicalUrl).toBe("http://alice:secret@1.2.3.4:8080");
  });

  it("reversed with socks5", () => {
    const r = normalizeProxyInput("socks5://10.0.0.5:1080@proxyuser:proxypass");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("socks5://proxyuser:proxypass@10.0.0.5:1080");
  });

  it("reversed where password is numeric (disambiguates via looksLikeHost)", () => {
    // host:port@user:1234 — both sides *parse* as hostport, but only the left
    // host is an IP, so it must be treated as the real host.
    const r = normalizeProxyInput("http://1.2.3.4:8080@alice:1234");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ host: "1.2.3.4", port: 8080, username: "alice", password: "1234" });
  });
});

describe("normalizeProxyInput — bare colon forms (no scheme / no @)", () => {
  it("host:port:user:pass → http default scheme", () => {
    // This is exactly proxyxoay.org's `proxyhttp` field shape.
    const r = normalizeProxyInput("116.110.111.224:57939:tmproxyWCSd2:sQiTPi4DYn");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({
      scheme: "http",
      host: "116.110.111.224",
      port: 57939,
      username: "tmproxyWCSd2",
      password: "sQiTPi4DYn",
    });
    expect(r.canonicalUrl).toBe("http://tmproxyWCSd2:sQiTPi4DYn@116.110.111.224:57939");
  });

  it("user:pass:host:port → http default scheme", () => {
    const r = normalizeProxyInput("alice:secret:1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ host: "1.2.3.4", port: 8080, username: "alice", password: "secret" });
  });

  it("host:port (no auth)", () => {
    const r = normalizeProxyInput("1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("http://1.2.3.4:8080");
  });

  it("honours defaultScheme opt for bare host:port", () => {
    const r = normalizeProxyInput("1.2.3.4:1080", { defaultScheme: "socks5" });
    expect(r.ok).toBe(true);
    expect(r.parsed.scheme).toBe("socks5");
    expect(r.canonicalUrl).toBe("socks5://1.2.3.4:1080");
  });

  it("user:pass@host:port without scheme", () => {
    const r = normalizeProxyInput("alice:secret@1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("http://alice:secret@1.2.3.4:8080");
  });

  it("password containing a colon (host:port:user:pass:extra)", () => {
    const r = normalizeProxyInput("1.2.3.4:8080:alice:p:a:s:s");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ username: "alice", password: "p:a:s:s" });
  });
});

describe("normalizeProxyInput — IPv6", () => {
  it("bracketed [::1]:port with auth, standard order", () => {
    const r = normalizeProxyInput("http://alice:secret@[::1]:8080");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ host: "::1", port: 8080 });
    expect(r.canonicalUrl).toBe("http://alice:secret@[::1]:8080");
  });

  it("bracketed IPv6 colon form [::1]:port:user:pass", () => {
    const r = normalizeProxyInput("[::1]:8080:alice:secret");
    expect(r.ok).toBe(true);
    expect(r.parsed).toMatchObject({ host: "::1", port: 8080, username: "alice", password: "secret" });
    expect(r.canonicalUrl).toBe("http://alice:secret@[::1]:8080");
  });

  it("bracketed IPv6 host only (no port)", () => {
    const r = normalizeProxyInput("http://alice:secret@[::1]");
    expect(r.ok).toBe(true);
    expect(r.parsed.port).toBe(80);
    expect(r.canonicalUrl).toBe("http://alice:secret@[::1]:80");
  });
});

describe("normalizeProxyInput — encoding & aliases", () => {
  it("aliases bare 'socks' scheme to socks5", () => {
    const r = normalizeProxyInput("socks://1.2.3.4:1080");
    expect(r.ok).toBe(true);
    expect(r.parsed.scheme).toBe("socks5");
  });

  it("percent-encodes special chars in credentials", () => {
    // "/" in username via colon form (no scheme, no @):
    const a = normalizeProxyInput("1.2.3.4:8080:al/ice:pass");
    expect(a.ok).toBe(true);
    expect(a.canonicalUrl).toBe("http://al%2Fice:pass@1.2.3.4:8080");

    // "@" inside a password via standard order (last "@" splits userinfo/host):
    const b = normalizeProxyInput("al/ice:p@ss@1.2.3.4:8080");
    expect(b.ok).toBe(true);
    expect(b.canonicalUrl).toBe("http://al%2Fice:p%40ss@1.2.3.4:8080");
  });

  it("accepts already-encoded credentials without double-encoding", () => {
    const r = normalizeProxyInput("http://al%2Fice:p%40ss@1.2.3.4:8080");
    expect(r.ok).toBe(true);
    expect(r.canonicalUrl).toBe("http://al%2Fice:p%40ss@1.2.3.4:8080");
  });
});

describe("normalizeProxyInput — errors", () => {
  it("rejects empty string", () => {
    expect(normalizeProxyInput("").ok).toBe(false);
    expect(normalizeProxyInput("   ").ok).toBe(false);
  });

  it("rejects unknown scheme", () => {
    const r = normalizeProxyInput("ftp://1.2.3.4:21");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unsupported scheme/);
  });

  it("rejects out-of-range port", () => {
    expect(normalizeProxyInput("1.2.3.4:99999").ok).toBe(false);
  });

  it("rejects unparseable gibberish", () => {
    expect(normalizeProxyInput("::::").ok).toBe(false);
  });

  it("rejects 2-token form that isn't host:port (ambiguous)", () => {
    expect(normalizeProxyInput("alice:secret").ok).toBe(false);
  });
});

describe("convenience helpers", () => {
  it("canonicalizeProxyUrl returns string or null", () => {
    expect(canonicalizeProxyUrl("1.2.3.4:8080:u:p")).toBe("http://u:p@1.2.3.4:8080");
    expect(canonicalizeProxyUrl("::::")).toBeNull();
  });

  it("parseProxyParts returns parts or null", () => {
    expect(parseProxyParts("http://1.2.3.4:8080")).toMatchObject({ host: "1.2.3.4", port: 8080 });
    expect(parseProxyParts("not a proxy")).toBeNull();
  });

  it("round-trips: canonical output is re-parseable and stable", () => {
    const inputs = [
      "http://1.2.3.4:8080@alice:secret",
      "116.110.111.224:57939:tmproxyWCSd2:sQiTPi4DYn",
      "socks5://u:p@example.com:1080",
    ];
    for (const input of inputs) {
      const once = normalizeProxyInput(input);
      expect(once.ok).toBe(true);
      const twice = normalizeProxyInput(once.canonicalUrl);
      expect(twice.ok).toBe(true);
      expect(twice.canonicalUrl).toBe(once.canonicalUrl);
    }
  });
});
