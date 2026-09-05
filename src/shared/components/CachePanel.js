"use client";

import Card from "./Card";

// Cache analytics panel (phase 09) — renders the additive `cache` block from
// the /api/usage/stats payload the usage page already fetches. Savings are an
// ESTIMATE (cached tokens × prompt-token price); unpriced models show "n/a",
// never $0. Renders nothing until the block exists (backward compatible with
// older payloads).

function fmtTokens(n) {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n) {
  if (n === null || n === undefined) return "n/a";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(p) {
  return p === null || p === undefined ? "—" : `${p}%`;
}

export default function CachePanel({ cache }) {
  if (!cache || !cache.summary) return null;
  const { summary, rows } = cache;
  const interesting = (rows || []).filter((r) => r.cachedTokens > 0);

  if (summary.totalCachedTokens === 0) {
    return (
      <Card>
        <h2 className="text-base font-semibold mb-2">Cache</h2>
        <p className="text-sm opacity-60">No cached-token data in this period.</p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-base font-semibold mb-3">Cache</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border border-[color:var(--border)] p-3">
          <div className="text-xs opacity-60">Cached tokens</div>
          <div className="text-lg font-semibold">{fmtTokens(summary.totalCachedTokens)}</div>
        </div>
        <div className="rounded-lg border border-[color:var(--border)] p-3">
          <div className="text-xs opacity-60">Hit-rate (cached / prompt)</div>
          <div className="text-lg font-semibold">{fmtPct(summary.blendedHitRatePct)}</div>
        </div>
        <div className="rounded-lg border border-[color:var(--border)] p-3">
          <div className="text-xs opacity-60">Est. saved vs uncached prompt</div>
          <div className="text-lg font-semibold">{fmtUsd(summary.savedUsd)}</div>
        </div>
      </div>

      {interesting.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-60">
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="py-1 pr-3 font-medium">Requests</th>
                <th className="py-1 pr-3 font-medium">Cached tokens</th>
                <th className="py-1 pr-3 font-medium">Hit-rate</th>
                <th className="py-1 font-medium">Est. saved</th>
              </tr>
            </thead>
            <tbody>
              {interesting.slice(0, 15).map((r) => (
                <tr key={`${r.provider}|${r.model}`} className="border-t border-[color:var(--border)]">
                  <td className="py-1.5 pr-3">
                    {r.model}
                    {r.provider ? <span className="opacity-50"> · {r.provider}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3">{r.requests.toLocaleString()}</td>
                  <td className="py-1.5 pr-3">{fmtTokens(r.cachedTokens)}</td>
                  <td className="py-1.5 pr-3">{fmtPct(r.hitRatePct)}</td>
                  <td className="py-1.5">{fmtUsd(r.savedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 15 ? (
            <p className="mt-2 text-xs opacity-50">Top 15 of {rows.length} models by cached tokens.</p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs opacity-50">
        Savings are estimates (cached tokens × prompt-token price; actual cache reads bill less).
        {summary.unpricedRows > 0 ? ` ${summary.unpricedRows} model(s) lack pricing and show n/a.` : ""}
        Rows without token data are excluded from ratios.
      </p>
    </Card>
  );
}
