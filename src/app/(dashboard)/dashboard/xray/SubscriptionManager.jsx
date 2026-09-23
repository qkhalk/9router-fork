"use client";

// Subscription manager card (multi-subscription, Phase 4). Extracted from
// page.js when it outgrew ~1500 lines. Self-contained UI: per-sub rows
// (enable toggle, interval, retention, last-sync, traffic/expiry, Sync Now,
// Delete), the aggregate last-sync line, and the add-subscription form.
// All mutations go through the callbacks the page passes in.

import { useState } from "react";
import { Badge, Button, Card, Input, Toggle } from "@/shared/components";

// Presets + helpers mirror page.js (kept in sync by the shared page bundle;
// duplicated rather than exported from a client page module, which Next
// forbids importing into another page tree cleanly).
const SYNC_INTERVAL_PRESETS = [
  { value: "60", label: "Every hour" },
  { value: "360", label: "Every 6 hours" },
  { value: "720", label: "Every 12 hours" },
  { value: "1440", label: "Every day" },
  { value: "0", label: "Never" },
];

function formatInterval(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "manual only";
  if (m < 60) return `every ${m} min`;
  if (m % 10080 === 0 && m >= 10080) {
    const w = m / 10080;
    return `every ${w} week${w > 1 ? "s" : ""}`;
  }
  if (m % 1440 === 0 && m >= 1440) {
    const d = m / 1440;
    return `every ${d} day${d > 1 ? "s" : ""}`;
  }
  if (m % 60 === 0) {
    const h = m / 60;
    return `every ${h} h`;
  }
  return `every ${m} min`;
}

function intervalToPresetValue(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "0";
  return SYNC_INTERVAL_PRESETS.some((p) => p.value === String(m)) ? String(m) : "custom";
}

function intervalToCustomParts(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return { value: 30, unit: "minutes" };
  if (m >= 10080 && m % 10080 === 0) return { value: m / 10080, unit: "days" };
  if (m >= 1440 && m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m >= 60 && m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

function customPartsToMinutes(value, unit) {
  const v = Number(value) || 0;
  if (unit === "hours") return v * 60;
  if (unit === "days") return v * 1440;
  return v;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatExpiry(expireAt) {
  if (!expireAt) return "N/A";
  const ms = Date.parse(expireAt) - Date.now();
  if (!Number.isFinite(ms)) return "N/A";
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} day${days > 1 ? "s" : ""} left`;
  const hours = Math.floor(ms / 3600000);
  return `${Math.max(1, hours)}h left`;
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export default function SubscriptionManager({
  subscriptions,
  status,
  busy,
  onSyncAll,
  onSyncSub,
  onToggleSub,
  onPatchSub,
  onDeleteSub,
  onAddSub,
}) {
  const [newSub, setNewSub] = useState({ name: "", url: "" });
  // Custom-interval editor state keyed by subscription id (never global —
  // editing row A must not leak into row B).
  const [rowIntervalEditor, setRowIntervalEditor] = useState(null); // {subId, value, unit}

  const submitAdd = () => {
    onAddSub(newSub, () => setNewSub({ name: "", url: "" }));
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Subscriptions</h2>
        <div className="flex items-center gap-2">
          <Badge>{subscriptions.length} sub{subscriptions.length === 1 ? "" : "s"}</Badge>
          <Button size="sm" onClick={onSyncAll} disabled={busy}>Sync All</Button>
        </div>
      </div>
      {/* Sub-AGNOSTIC aggregate — never attribute one sub's state to the whole feature (RT-15). */}
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-text-muted mb-1">Last sync</div>
          <div>{formatDateTime(status?.sync?.lastSyncAt)}</div>
        </div>
        <div>
          <div className="text-text-muted mb-1">Subscriptions</div>
          <div>{status?.sync?.totalSubs ?? 0}</div>
        </div>
        <div>
          <div className="text-text-muted mb-1">Failing</div>
          <div>{status?.sync?.failingSubs ?? 0}</div>
        </div>
      </div>

      {subscriptions.length === 0 && (
        <div className="text-sm text-text-muted bg-surface-2 rounded-lg p-3">
          No subscriptions yet — add one below. Your previous subscription URL was migrated automatically on upgrade.
        </div>
      )}

      <div className="space-y-2">
        {subscriptions.map((sub) => {
          const usedBytes = (sub.uploadBytes || 0) + (sub.downloadBytes || 0);
          const pct = sub.totalBytes > 0 ? Math.min(100, Math.round((usedBytes / sub.totalBytes) * 100)) : null;
          const editorActive = rowIntervalEditor?.subId === sub.id;
          return (
            <div key={sub.id} className="border border-border rounded-lg p-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <Toggle
                    checked={sub.enabled}
                    onChange={(v) => onToggleSub(sub, v)}
                  />
                  <span className="font-medium truncate">{sub.name}</span>
                  <span className="text-xs text-text-muted truncate max-w-xs" title={sub.url}>{sub.url}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onSyncSub(sub)} disabled={busy}>Sync Now</Button>
                  <Button size="sm" variant="ghost" onClick={() => onDeleteSub(sub)} disabled={busy}>Delete</Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                <span>Last sync: {formatDateTime(sub.lastSyncAt)}{sub.lastSyncCount != null ? ` · ${sub.lastSyncCount} configs` : ""}</span>
                <span>
                  Traffic:{" "}
                  {sub.totalBytes > 0
                    ? `${formatBytes(usedBytes)} / ${formatBytes(sub.totalBytes)} used${pct != null ? ` (${pct}%)` : ""}`
                    : "N/A"}
                </span>
                <span>Expiry: {formatExpiry(sub.expireAt)}</span>
                <span>Retention: {sub.effectiveRetentionDays === -1 ? "forever" : sub.effectiveRetentionDays === 0 ? "delete after sync" : `${sub.effectiveRetentionDays} days`}</span>
                <span>Auto-sync: {formatInterval(sub.effectiveIntervalMin)}</span>
              </div>
              {sub.lastSyncError && (
                <div className="text-xs text-amber-600 dark:text-amber-400">Last error: {sub.lastSyncError}</div>
              )}
              <div className="flex gap-2 items-end flex-wrap">
                <div>
                  <label className="text-xs text-text-muted block mb-1">Auto-sync</label>
                  <select
                    className="text-sm border border-border rounded px-2 py-1.5 bg-transparent"
                    value={
                      editorActive
                        ? "custom-editor"
                        : sub.intervalMin === 0 || sub.effectiveIntervalMin === 0
                          ? "0"
                          : intervalToPresetValue(sub.intervalMin ?? sub.effectiveIntervalMin) === "custom"
                            ? "custom"
                            : String(sub.intervalMin ?? sub.effectiveIntervalMin)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "custom") {
                        const parts = intervalToCustomParts(sub.effectiveIntervalMin || 30);
                        setRowIntervalEditor({ subId: sub.id, value: parts.value, unit: parts.unit });
                      } else if (v !== "custom-editor") {
                        setRowIntervalEditor(null);
                        onPatchSub(sub, { intervalMin: Number(v) }, "Interval saved");
                      }
                    }}
                  >
                    {SYNC_INTERVAL_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                    <option value="custom">Custom…{sub.intervalMin != null && intervalToPresetValue(sub.intervalMin) === "custom" ? ` (${formatInterval(sub.intervalMin)})` : ""}</option>
                    {editorActive && <option value="custom-editor">Custom…</option>}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-muted block mb-1">Keep dropped servers</label>
                  <select
                    className="text-sm border border-border rounded px-2 py-1.5 bg-transparent"
                    value={sub.retentionDays == null ? "" : String(sub.retentionDays)}
                    onChange={(e) => onPatchSub(sub, { retentionDays: e.target.value === "" ? null : Number(e.target.value) }, "Retention saved")}
                  >
                    <option value="7">7 days</option>
                    <option value="1">24 hours</option>
                    <option value="0">Delete after sync</option>
                    <option value="-1">Forever</option>
                    <option value="">Default (7 days)</option>
                  </select>
                </div>
                {editorActive && (
                  <div className="flex gap-2 items-end">
                    <div>
                      <label className="text-xs text-text-muted block mb-1">Value</label>
                      <Input
                        type="number"
                        min={1}
                        className="w-24"
                        value={rowIntervalEditor.value}
                        onChange={(e) => setRowIntervalEditor((c) => ({ ...c, value: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-text-muted block mb-1">Unit</label>
                      <select
                        className="text-sm border border-border rounded px-2 py-1.5 bg-transparent"
                        value={rowIntervalEditor.unit}
                        onChange={(e) => setRowIntervalEditor((c) => ({ ...c, unit: e.target.value }))}
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </select>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        const minutes = customPartsToMinutes(rowIntervalEditor.value, rowIntervalEditor.unit);
                        setRowIntervalEditor(null);
                        onPatchSub(sub, { intervalMin: minutes }, `Interval saved (${formatInterval(minutes)})`);
                      }}
                    >
                      Save
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add-subscription form (prominent when no subs exist) */}
      <div className="border border-dashed border-border rounded-lg p-3 space-y-2">
        <div className="text-sm font-medium">Add subscription</div>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="w-40">
            <label className="text-xs text-text-muted block mb-1">Name (optional)</label>
            <Input
              value={newSub.name}
              onChange={(e) => setNewSub((s) => ({ ...s, name: e.target.value }))}
              placeholder="Airport B"
            />
          </div>
          <div className="flex-1 min-w-60">
            <label className="text-xs text-text-muted block mb-1">Subscription URL</label>
            <Input
              value={newSub.url}
              onChange={(e) => setNewSub((s) => ({ ...s, url: e.target.value }))}
              placeholder="https://…"
            />
          </div>
          <Button onClick={submitAdd} disabled={busy}>Add</Button>
        </div>
      </div>
    </Card>
  );
}
