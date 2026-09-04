"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/shared/components";

// Circuit-breaker health panel (phase 06). State lives in memory in the
// server process (restart = clean slate), so this polls the connections GET
// which piggybacks breakerStates + strikeBlocks. Only interesting rows are
// shown: open/half-open breakers, closed ones with recent failures, and
// antigravity upstream strike-blocks (R9 — shown alongside, not merged).
const STATE_STYLES = {
  open: { color: "#e74c3c", label: "Open" },
  "half-open": { color: "#e67e22", label: "Half-open (probing)" },
  closed: { color: "#2ecc71", label: "Closed" },
};

function fmtRemaining(ms) {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function BreakerPanel() {
  const [rows, setRows] = useState(null); // null = loading
  const [names, setNames] = useState({}); // connectionId → account name
  const [resetting, setResetting] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) return;
      const data = await res.json();
      const nameMap = {};
      for (const c of data.connections || []) {
        if (c.id) nameMap[c.id] = c.name || c.provider || c.id;
      }
      setNames(nameMap);
      const interesting = (data.breakerStates || []).filter(
        (b) => b.state !== "closed" || b.failures > 0
      );
      const strikes = data.strikeBlocks || [];
      setRows({ breakers: interesting, strikes, total: (data.breakerStates || []).length });
    } catch {
      // keep last known state; panel is best-effort
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function handleReset(connectionId) {
    setResetting(connectionId);
    try {
      await fetch(`/api/providers/${encodeURIComponent(connectionId)}/breaker`, { method: "POST" });
      await load();
    } catch {
      // best-effort
    } finally {
      setResetting(null);
    }
  }

  const accountLabel = (id) => {
    const name = names[id];
    return name ? `${name} (${id.slice(0, 8)})` : id.slice(0, 12);
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold">Account Circuit Breakers</h2>
        <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
      </div>

      {rows === null ? (
        <p className="text-sm opacity-60">Loading breaker state…</p>
      ) : rows.breakers.length === 0 && rows.strikes.length === 0 ? (
        <p className="text-sm opacity-60">
          All {rows.total} tracked accounts healthy — no open breakers or strike-blocks.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-60">
                <th className="py-1 pr-3 font-medium">Account</th>
                <th className="py-1 pr-3 font-medium">Breaker</th>
                <th className="py-1 pr-3 font-medium">Failures (60s)</th>
                <th className="py-1 pr-3 font-medium">Cooldown / note</th>
                <th className="py-1 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.breakers.map((b) => {
                const style = STATE_STYLES[b.state] || STATE_STYLES.closed;
                return (
                  <tr key={`b-${b.connectionId}`} className="border-t border-[color:var(--border)]">
                    <td className="py-1.5 pr-3">
                      {accountLabel(b.connectionId)}
                      {b.provider ? <span className="opacity-50"> · {b.provider}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3" style={{ color: style.color }}>{style.label}</td>
                    <td className="py-1.5 pr-3">{b.state === "closed" ? b.failures : "—"}</td>
                    <td className="py-1.5 pr-3 opacity-80">
                      {b.state === "open"
                        ? `re-opens in ${fmtRemaining(b.remainingMs)} (streak ${b.consecutiveOpens})`
                        : b.state === "half-open"
                          ? (b.probeInFlight ? "probe in flight" : "awaiting probe")
                          : (b.lastRecoveredAt ? "recovered" : "healthy")}
                    </td>
                    <td className="py-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={resetting === b.connectionId}
                        onClick={() => handleReset(b.connectionId)}
                      >
                        {resetting === b.connectionId ? "…" : "Reset"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {rows.strikes.map((s) => (
                <tr key={`s-${s.connectionId}-${s.model}`} className="border-t border-[color:var(--border)]">
                  <td className="py-1.5 pr-3">
                    {accountLabel(s.connectionId)}
                    <span className="opacity-50"> · antigravity strike-block</span>
                  </td>
                  <td className="py-1.5 pr-3" style={{ color: "#e74c3c" }}>Blocked</td>
                  <td className="py-1.5 pr-3">—</td>
                  <td className="py-1.5 pr-3 opacity-80">
                    {s.model}: unblocked in {fmtRemaining(s.remainingMs)}
                  </td>
                  <td className="py-1.5 opacity-50">auto</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs opacity-50">
        In-memory state — restarts clear all breakers (they re-learn within one failure window).
        Tuning: breakerEnabled / breakerFailureThreshold / breakerWindowSec / breakerBaseCooldownSec settings.
      </p>
    </Card>
  );
}
