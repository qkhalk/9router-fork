"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

/**
 * Live status + controls card for a proxyxoay.org pool. Shown inline under a
 * proxyxoay pool row on the proxy-pools page. Polls /status every 5s and offers
 * per-key manual rotation plus pool-level forwarding start/stop.
 */
function maskKey(label) {
  // Labels already look like "key …XXXXX" — show as-is.
  return label || "key";
}

function fmtCountdown(sec) {
  if (sec == null) return "—";
  if (sec <= 0) return "expired";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function ProxyXoayPoolCard({ pool }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null); // "all" | entryId | "forward"
  const notify = useNotificationStore();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}/status`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data.status);
      }
    } catch {
      /* ignore transient poll errors */
    }
  }, [pool.id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const rotate = async (entryId = null) => {
    setBusy(entryId || "all");
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entryId ? { entryId } : {}),
      });
      const data = await res.json();
      if (res.ok) {
        notify.success(entryId ? "Proxy rotated" : "Rotated all keys");
      } else {
        const retry = data?.results?.find((r) => r.retryIn)?.retryIn;
        notify.error(
          data?.error || (retry ? `Rate-limited — retry in ${retry}s` : "Rotation failed")
        );
      }
      await load();
    } catch (e) {
      notify.error("Rotation request failed");
    } finally {
      setBusy(null);
    }
  };

  const toggleForward = async () => {
    const next = !(status?.forwardEnabled);
    setBusy("forward");
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (res.ok) notify.success(next ? "Forwarding enabled" : "Forwarding stopped");
      else notify.error("Failed to toggle forwarding");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const copy = (text) => {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    notify.success("Copied");
  };

  const keys = status?.keys || [];

  return (
    <div className="mt-3 rounded-lg border border-border/50 bg-surface-2/40 p-3">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="primary" size="sm">
            proxyxoay · {status?.protocol?.toUpperCase() || "HTTP"} · {status?.liveMinutes || 5}m
          </Badge>
          <Badge variant={status?.autoRotate ? "success" : "default"} size="sm">
            {status?.autoRotate ? "auto-rotate" : "manual"}
          </Badge>
          <Badge variant={status?.forwardEnabled ? "success" : "default"} size="sm">
            {status?.forwardEnabled ? "forwarding on" : "forwarding off"}
          </Badge>
          <Badge variant="default" size="sm">{keys.length} key(s)</Badge>
          <Badge variant="default" size="sm">
            {keys.filter((k) => k.exitIp).length} live IP(s)
          </Badge>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon="sync"
            disabled={busy === "all"}
            onClick={() => rotate(null)}
          >
            Rotate all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy === "forward"}
            onClick={toggleForward}
          >
            {status?.forwardEnabled ? "Stop forwarding" : "Start forwarding"}
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted text-left border-b border-border/50">
              <th className="py-1.5 pr-3 font-medium">Key</th>
              <th className="py-1.5 pr-3 font-medium">Exit IP</th>
              <th className="py-1.5 pr-3 font-medium">Carrier</th>
              <th className="py-1.5 pr-3 font-medium">Location</th>
              <th className="py-1.5 pr-3 font-medium">Expires</th>
              <th className="py-1.5 pr-3 font-medium">Forward port</th>
              <th className="py-1.5 pr-3 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-text-muted italic">
                  No keys. Edit the pool to add API keys.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k.entryId} className="border-b border-border/30">
                <td className="py-1.5 pr-3 font-mono">{maskKey(k.label)}</td>
                <td className="py-1.5 pr-3 font-mono">
                  {k.exitIp || (k.lastError ? <span className="text-error">error</span> : "—")}
                </td>
                <td className="py-1.5 pr-3">{k.nha_mang || "—"}</td>
                <td className="py-1.5 pr-3">{k.vi_tri || "—"}</td>
                <td className="py-1.5 pr-3">{fmtCountdown(k.expiresIn)}</td>
                <td className="py-1.5 pr-3 font-mono">
                  {k.forwardRunning && k.forwardPort ? (
                    <button
                      className="text-primary hover:underline"
                      onClick={() => copy(`127.0.0.1:${k.forwardPort}`)}
                      title="Copy"
                    >
                      127.0.0.1:{k.forwardPort}
                    </button>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="sync"
                    disabled={busy === k.entryId}
                    onClick={() => rotate(k.entryId)}
                  >
                    Rotate
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {keys.some((k) => k.lastError) && (
        <p className="text-[11px] text-error mt-2 truncate">
          {keys.find((k) => k.lastError)?.lastError}
        </p>
      )}
    </div>
  );
}
