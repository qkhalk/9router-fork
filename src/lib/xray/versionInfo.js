/**
 * Xray-core release metadata: stable-latest + release listing for the
 * dashboard's binary-update UI, with a plain 1h server-side TTL cache.
 *
 * Cache design (RT-14): a plain TTL — no ETag/If-None-Match machinery. With
 * a 1h server cache the worst case is ~24 GitHub requests/day against a
 * 60/h (1,440/day) unauthenticated budget; conditional-request layers add
 * state and failure modes without saving anything that was at risk.
 *
 * hasUpdate compares against STABLE /releases/latest only: every newer
 * Xray-core release marked `prerelease: true` must never flip the update
 * badge — prereleases surface only in the picker listing, labeled.
 *
 * Graceful degrade: any upstream failure resolves to the cached value when
 * one exists, else an {error} sentinel — routes translate that into HTTP 200
 * bodies, never 5xx.
 */

import https from "https";

const GITHUB_LATEST_API = "https://api.github.com/repos/XTLS/Xray-core/releases/latest";
const GITHUB_RELEASES_API = "https://api.github.com/repos/XTLS/Xray-core/releases?per_page=30";
const TTL_MS = 3600000; // 1h

// Survive Next.js dev hot reload; one cache per process.
const cache = (global.__xrayVersionCache ??= {
  latest: { value: null, fetchedAt: 0 },
  releases: { value: null, fetchedAt: 0 },
});

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        timeout: 4000,
        headers: {
          "User-Agent": "9router-xray-version",
          "Accept": "application/vnd.github+json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ ok: res.statusCode === 200, body: JSON.parse(data) });
          } catch {
            resolve({ ok: false, body: null });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false, body: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: null });
    });
  });
}

/** 3-segment numeric compare ("v" prefix tolerated). Copies the tiny helper
 *  from api/version/route.js (not exported there; route-to-route import is
 *  worse than one 10-line duplicate). */
export function compareVersions(a, b) {
  const norm = (s) => String(s || "").replace(/^v/i, "");
  const pa = norm(a).split(".").map(Number);
  const pb = norm(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function fresh(entry) {
  return entry.value && Date.now() - entry.fetchedAt < TTL_MS;
}

/**
 * Stable-latest release. Returns { latest, prerelease, publishedAt, checkedAt }
 * or { error } when GitHub is unreachable and no cache exists.
 */
export async function getLatestReleaseCached() {
  const entry = cache.latest;
  if (fresh(entry)) return { ...entry.value, cached: true };

  const res = await fetchJson(GITHUB_LATEST_API);
  const tag = res.ok && res.body && !res.body.draft ? String(res.body.tag_name || "").trim() : null;
  if (tag) {
    entry.value = {
      latest: tag,
      prerelease: res.body.prerelease === true,
      publishedAt: res.body.published_at || null,
    };
    entry.fetchedAt = Date.now();
    return { ...entry.value, checkedAt: new Date().toISOString() };
  }
  if (entry.value) {
    // Degrade to stale cache rather than "unknown".
    return { ...entry.value, stale: true, checkedAt: new Date().toISOString() };
  }
  return { error: "GitHub unreachable — could not determine the latest stable release" };
}

/**
 * Release listing for the version picker (up to 30 most recent). Drafts are
 * filtered server-side; prereleases are present and flagged. Returns
 * { releases, checkedAt } or { error }.
 */
export async function listReleasesCached() {
  const entry = cache.releases;
  if (fresh(entry)) return { ...entry.value, cached: true };

  const res = await fetchJson(GITHUB_RELEASES_API);
  const releases = res.ok && Array.isArray(res.body)
    ? res.body
        .filter((r) => r && r.draft !== true && r.tag_name)
        .map((r) => ({
          version: String(r.tag_name).trim(),
          publishedAt: r.published_at || null,
          prerelease: r.prerelease === true,
          draft: false,
        }))
    : null;
  if (releases) {
    entry.value = { releases };
    entry.fetchedAt = Date.now();
    return { ...entry.value, checkedAt: new Date().toISOString() };
  }
  if (entry.value) {
    return { ...entry.value, stale: true, checkedAt: new Date().toISOString() };
  }
  return { error: "GitHub unreachable — could not list releases" };
}
