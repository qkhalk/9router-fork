import { describe, it, expect } from "vitest";
import {
  parseSubscription,
  parseConfigName,
  linkToConfigEntry,
} from "../../src/lib/xray/syncParse.js";

describe("parseSubscription", () => {
  it("parses plain-text subscription with comment headers", () => {
    const body = [
      "#profile-title: base64:abc",
      "#profile-update-interval: 1",
      "vless://uuid@host:443?type=tcp#test1",
      "trojan://pass@host:443#test2",
      "",
      "  ",
    ].join("\n");
    const links = parseSubscription(body);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatch(/^vless:\/\//);
    expect(links[1]).toMatch(/^trojan:\/\//);
  });

  it("decodes base64-encoded subscriptions", () => {
    const plain = "vless://uuid@host:443\ntrojan://pass@host:443";
    const b64 = Buffer.from(plain).toString("base64");
    const links = parseSubscription(b64);
    expect(links).toHaveLength(2);
  });

  it("unescapes &amp; the way v2go sanitizes configs", () => {
    const links = parseSubscription("vless://uuid@host:443?path=/a&amp;b#t");
    expect(links[0]).toContain("path=/a&b");
  });

  it("returns [] for empty/garbage", () => {
    expect(parseSubscription("")).toEqual([]);
    expect(parseSubscription("#only comments")).toEqual([]);
  });
});

describe("parseConfigName", () => {
  it("parses the canonical v2go name format", () => {
    const m = parseConfigName("v2go | 🇩🇪 DE | VLESS | 12");
    expect(m).toEqual({ flag: "🇩🇪", country: "DE", protocol: "vless", index: 12 });
  });

  it("parses without a flag emoji", () => {
    const m = parseConfigName("v2go |  US | SS | 7");
    expect(m.country).toBe("US");
    expect(m.protocol).toBe("ss");
    expect(m.index).toBe(7);
  });

  it("returns the raw name for non-v2go fragments", () => {
    expect(parseConfigName("my custom server")).toEqual({ name: "my custom server" });
    expect(parseConfigName("")).toEqual({});
  });
});

describe("linkToConfigEntry", () => {
  it("builds a stable id and extracts metadata for a vless link", () => {
    const link =
      "vless://1cbe9e8a-8e2f-4a1e-9a2f-0e6f9a3b7c11@example.com:443?type=tcp" +
      "&security=reality&sni=x#v2go | 🇩🇪 DE | VLESS | 12";
    const entry = linkToConfigEntry(link);
    expect(entry.id).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
    expect(entry.protocol).toBe("vless");
    expect(entry.country).toBe("DE");
    expect(entry.host).toBe("example.com");
    expect(entry.port).toBe(443);
    expect(entry.name).toContain("VLESS");
  });

  it("produces the same id regardless of the #fragment", () => {
    const a = linkToConfigEntry("trojan://pass@host:443#v2go | 🇫🇷 FR | TROJAN | 1");
    const b = linkToConfigEntry("trojan://pass@host:443#renamed");
    expect(a.id).toBe(b.id);
  });

  it("returns null for an unsupported/unknown protocol", () => {
    expect(linkToConfigEntry("https://example.com")).toBeNull();
    expect(linkToConfigEntry("not a link")).toBeNull();
  });
});
