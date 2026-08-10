/**
 * Integration test: run the parser against the REAL v2go subscription data
 * (~782 configs) cloned to /tmp/v2go-research/v2go/AllConfigsSub.txt.
 *
 * Validates: (1) every supported protocol parses without error,
 * (2) the JSON structure is what Xray expects, (3) performance is acceptable.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { convertLink, getProtocol, extractEndpoint } from "../../src/lib/xray/parser.js";
import { validateLink, buildClientConfig } from "../../src/lib/xray/configBuilder.js";
import { parseSubscription, linkToConfigEntry } from "../../src/lib/xray/syncParse.js";

const V2GO_FILE =
  process.platform === "win32"
    ? "C:/Users/ankha/AppData/Local/Temp/v2go-research/v2go/AllConfigsSub.txt"
    : "/tmp/v2go-research/v2go/AllConfigsSub.txt";

const hasRealData = fs.existsSync(V2GO_FILE);

describe.skipIf(!hasRealData)("parser against real v2go data", () => {
  let links = [];
  it("loads the real subscription file", () => {
    const text = fs.readFileSync(V2GO_FILE, "utf8");
    links = parseSubscription(text);
    console.log(`  loaded ${links.length} links from AllConfigsSub.txt`);
    expect(links.length).toBeGreaterThan(100);
  });

  it("parses every link without throwing", () => {
    const stats = { ok: 0, fail: 0, byProto: {}, errors: {} };
    for (const link of links) {
      try {
        const ob = convertLink(link);
        stats.ok++;
        const p = ob.protocol;
        stats.byProto[p] = (stats.byProto[p] || 0) + 1;
      } catch (e) {
        stats.fail++;
        const key = e.message.substring(0, 50);
        stats.errors[key] = (stats.errors[key] || 0) + 1;
      }
    }
    console.log("  parse results:", stats);
    // Every link should parse — v2go already live-tested them.
    expect(stats.fail).toBe(0);
  });

  it("validates every link produces a runnable client config", () => {
    const results = { ok: 0, badCombo: 0, errors: {} };
    for (const link of links) {
      const v = validateLink(link);
      if (v.ok) {
        results.ok++;
      } else {
        if (v.error.includes("REALITY")) results.badCombo++;
        results.errors[v.error.substring(0, 40)] = (results.errors[v.error.substring(0, 40)] || 0) + 1;
      }
    }
    console.log("  validateLink results:", results);
    expect(results.ok).toBeGreaterThan(links.length * 0.95); // >95% should validate
  });

  it("benchmarks parser performance (< 50ms per config)", () => {
    const start = process.hrtime.bigint();
    const iterations = 3;
    for (let i = 0; i < iterations; i++) {
      for (const link of links) {
        try { convertLink(link); } catch {}
      }
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perConfig = elapsed / (links.length * iterations);
    console.log(`  ${iterations}x over ${links.length} configs: ${elapsed.toFixed(0)}ms total, ${perConfig.toFixed(3)}ms/config`);
    expect(perConfig).toBeLessThan(5); // should be well under 5ms each
  });

  it("extracts endpoints and metadata consistently", () => {
    const sample = links.slice(0, 50);
    for (const link of sample) {
      const entry = linkToConfigEntry(link);
      expect(entry).not.toBeNull();
      expect(entry.id).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.protocol).toBeTruthy();
    }
  });
});
