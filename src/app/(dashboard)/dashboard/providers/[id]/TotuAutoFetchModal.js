"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";

// Interval presets in minutes. 0 = manual-only (scheduler stopped).
const INTERVAL_PRESETS = [
  { value: "0", label: "Never (manual only)" },
  { value: "15", label: "Every 15 min" },
  { value: "30", label: "Every 30 min" },
  { value: "60", label: "Every hour" },
];

export default function TotuAutoFetchModal({ isOpen, onClose, onSuccess }) {
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(60);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // Reset transient state and load the current scheduler settings each time
  // the modal opens, so the toggle/interval always reflect the saved config.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => {
        if (cancelled) return;
        setError("");
        setResult(null);
        setEnabled(data.totuAutoFetch === true);
        setIntervalMin(data.totuAutoFetchIntervalMin ?? 60);
      })
      .catch(() => {
        // Non-fatal: keep last known values.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleSaveSettings = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          totuAutoFetch: enabled,
          totuAutoFetchIntervalMin: enabled ? intervalMin : 0,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || `${translate("Request failed")}: ${res.status}`);
        return;
      }
      if (typeof onSuccess === "function") onSuccess();
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleFetchNow = async () => {
    setFetching(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/providers/totu-ai/fetch-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAccounts: 3 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `${translate("Request failed")}: ${res.status}`);
        return;
      }
      setResult(data);
      if ((data.added || 0) > 0 && typeof onSuccess === "function") {
        onSuccess();
      }
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setFetching(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={translate("Get TOTU AI accounts")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          {translate(
            "Automatically register fresh TOTU AI accounts (disposable mail.tm mailbox) and add them as API-key connections, or fetch a batch now."
          )}
        </p>

        <div className="flex items-center justify-between gap-3 rounded border border-accent/20 bg-sidebar/50 px-3 py-2">
          <span className="text-sm">{translate("Auto-fetch accounts")}</span>
          <Toggle checked={enabled} onChange={(v) => setEnabled(v)} />
        </div>

        {enabled && (
          <div className="grid gap-3">
            <div>
              <label className="mb-1 block text-xs text-text-muted">{translate("Fetch interval")}</label>
              <select
                className="w-full rounded border border-accent/30 bg-sidebar px-2 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                value={String(intervalMin)}
                onChange={(e) => setIntervalMin(Number(e.target.value))}
              >
                {INTERVAL_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {translate(p.label)}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={handleSaveSettings} fullWidth disabled={saving}>
              {saving ? translate("Saving...") : translate("Save auto-fetch settings")}
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {result && (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-green-400">
              +{result.added || 0} {translate("added")}
              {result.failed > 0 ? `, ${result.failed} ${translate("failed")}` : ""}
              {result.skipped > 0 ? `, ${result.skipped} ${translate("skipped")}` : ""}
            </div>
            {result.errors?.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono">
                {result.errors.map((item, i) => (
                  <li key={i} className="text-red-400">
                    {item.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleFetchNow}
            fullWidth
            disabled={fetching}
            icon="bolt"
          >
            {fetching ? translate("Fetching...") : translate("Fetch now")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth disabled={fetching}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

TotuAutoFetchModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
