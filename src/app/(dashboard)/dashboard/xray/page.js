"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useRef } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Toggle, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function statusVariant(status) {
  if (status === "running") return "success";
  if (status === "starting") return "warning";
  if (status === "error") return "error";
  return "default";
}

function latencyText(ms) {
  if (ms == null) return "—";
  if (ms < 0) return "failed";
  return `${ms} ms`;
}

function latencyVariant(ms) {
  if (ms == null) return "default";
  if (ms < 0) return "error";
  if (ms < 300) return "success";
  if (ms < 800) return "warning";
  return "default";
}

export default function XrayProxyPage() {
  const [status, setStatus] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [facets, setFacets] = useState({ countries: [], protocols: [] });
  const [configCounts, setConfigCounts] = useState({ active: 0, inactive: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [filter, setFilter] = useState({ protocol: "", country: "", status: "active", healthyOnly: false });
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState({ runtime: "", install: "" });
  const [settings, setSettings] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const [modelFilter, setModelFilter] = useState({
    model: "oc/deepseek-v4-flash-free",
    limit: 50,
    all: false,
    prune: false,
    concurrency: 2,
    pauseOnTraffic: true,
    quietMs: 15000,
  });
  const [modelFilterBusy, setModelFilterBusy] = useState(false);
  const [modelFilterResult, setModelFilterResult] = useState(null);
  const notify = useNotificationStore();
  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/xray/status", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        // Only use sync.sourceUrl as a fallback if the user hasn't set one.
        setSettings((prev) => ({
          ...prev,
          xraySubscriptionUrl: prev.xraySubscriptionUrl || data.sync?.sourceUrl || "",
        }));
      }
    } catch (e) {
      console.log("status fetch error:", e.message);
    }
  }, []);

  // Load the xray-related settings from /api/settings so toggles reflect
  // persisted state (not just in-memory defaults). Without this, a page
  // refresh would always show toggles as off even though the value was saved.
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({
          ...prev,
          xrayAutoStart: data.xrayAutoStart === true,
          xrayAutoRotate: data.xrayAutoRotate === true,
          xraySyncIntervalMin: data.xraySyncIntervalMin ?? prev.xraySyncIntervalMin,
          xrayStaleRetentionDays: data.xrayStaleRetentionDays ?? 7,
          xraySocksPort: data.xraySocksPort ?? prev.xraySocksPort,
          xrayHttpPort: data.xrayHttpPort ?? prev.xrayHttpPort,
          xraySubscriptionUrl: data.xraySubscriptionUrl || prev.xraySubscriptionUrl,
          xrayModelFilterEnabled: data.xrayModelFilterEnabled === true,
          xrayModelFilterModel: data.xrayModelFilterModel || "oc/deepseek-v4-flash-free",
          xrayModelFilterLimit: data.xrayModelFilterLimit ?? 50,
          xrayModelFilterAll: data.xrayModelFilterAll === true,
          xrayModelFilterPrune: data.xrayModelFilterPrune === true,
          xrayModelFilterConcurrency: data.xrayModelFilterConcurrency ?? 2,
          xrayModelFilterPauseOnTraffic: data.xrayModelFilterPauseOnTraffic !== false,
          xrayModelFilterQuietMs: data.xrayModelFilterQuietMs ?? 15000,
        }));
        setModelFilter((prev) => ({
          ...prev,
          model: data.xrayModelFilterModel || prev.model || "oc/deepseek-v4-flash-free",
          limit: data.xrayModelFilterLimit ?? prev.limit ?? 50,
          all: data.xrayModelFilterAll === true,
          prune: data.xrayModelFilterPrune === true,
          concurrency: data.xrayModelFilterConcurrency ?? prev.concurrency ?? 2,
          pauseOnTraffic: data.xrayModelFilterPauseOnTraffic !== false,
          quietMs: data.xrayModelFilterQuietMs ?? prev.quietMs ?? 15000,
        }));
      }
    } catch (e) {
      console.log("settings fetch error:", e.message);
    }
  }, []);

  const fetchConfigs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter.protocol) params.set("protocol", filter.protocol);
      if (filter.country) params.set("country", filter.country);
      if (filter.status === "active") params.set("active", "1");
      if (filter.status === "inactive") params.set("active", "0");
      if (filter.healthyOnly) params.set("healthy", "1");
      const res = await fetch(`/api/xray/configs?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setConfigs(data.configs || []);
        setFacets(data.facets || { countries: [], protocols: [] });
        setConfigCounts(data.counts || { active: 0, inactive: 0, total: 0 });
      }
    } catch (e) {
      console.log("configs fetch error:", e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    const fetchInitialData = async () => {
      await Promise.all([fetchStatus(), fetchConfigs(), fetchSettings()]);
    };
    fetchInitialData();
  }, [fetchStatus, fetchConfigs, fetchSettings]);

  // Poll status while running so health/latency/filter progress stay fresh.
  useEffect(() => {
    if (status?.status === "running" || status?.modelFilter?.status === "running") {
      pollRef.current = setInterval(fetchStatus, 15000);
      return () => clearInterval(pollRef.current);
    }
  }, [status?.status, status?.modelFilter?.status, fetchStatus]);

  const api = async (path, method = "POST", body) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async () => {
    try {
      notify.info("Downloading Xray binary (~20MB)...");
      await api("/api/xray/install", "POST", {});
      notify.success("Xray binary installed");
      await fetchStatus();
    } catch (e) {
      notify.error(`Install failed: ${e.message}`);
    }
  };

  const handleStart = async (configId) => {
    try {
      await api("/api/xray/start", "POST", configId ? { configId } : {});
      notify.success("Proxy started");
      await fetchStatus();
      await fetchConfigs();
    } catch (e) {
      notify.error(`Start failed: ${e.message}`);
    }
  };

  const handleStop = () => {
    setConfirmState({
      message: "Stop the V2Ray proxy? Provider connections using it will fall back to direct.",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await api("/api/xray/stop", "POST");
          notify.success("Proxy stopped");
          await fetchStatus();
        } catch (e) {
          notify.error(`Stop failed: ${e.message}`);
        }
      },
    });
  };

  const handleSwitch = async (configId, name) => {
    try {
      notify.info(`Switching to ${name}...`);
      await api("/api/xray/switch", "POST", { configId });
      notify.success(`Switched to ${name}`);
      await fetchStatus();
      await fetchConfigs();
    } catch (e) {
      notify.error(`Switch failed: ${e.message}`);
    }
  };

  const handleTest = async (configId) => {
    setTestingId(configId);
    try {
      const result = await api(`/api/xray/configs/${configId}/test`, "POST");
      if (result.latencyMs >= 0) {
        notify.success(`Latency: ${result.latencyMs} ms${result.exitIp ? ` · exit ${result.exitIp}` : ""}`);
      } else {
        notify.error("Server did not respond (dead or blocked)");
      }
      await fetchConfigs();
    } catch (e) {
      notify.error(`Test failed: ${e.message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleSync = async () => {
    try {
      notify.info("Syncing subscription from v2go...");
      const result = await api("/api/xray/sync", "POST", {});
      notify.success(`Synced ${result.count} configs${result.stalePruned ? ` · removed ${result.stalePruned} inactive` : ""}${result.autoFilter?.queued ? " · model filter queued" : ""}`);
      await fetchStatus();
      await fetchConfigs();
    } catch (e) {
      notify.error(`Sync failed: ${e.message}`);
    }
  };

  const handleHealthCheck = async () => {
    try {
      const result = await api("/api/xray/health-check", "POST");
      if (result.skipped) {
        notify.info("Proxy not running — nothing to check");
      } else if (result.latencyMs >= 0) {
        notify.success(`Active proxy healthy: ${result.latencyMs} ms`);
      } else {
        notify.error("Active proxy is unreachable");
      }
      await fetchStatus();
    } catch (e) {
      notify.error(`Health check failed: ${e.message}`);
    }
  };

  const runModelFilter = async () => {
    const model = modelFilter.model.trim();
    if (!model) {
      notify.error("Model is required");
      return;
    }

    const execute = async () => {
      setModelFilterBusy(true);
      setModelFilterResult(null);
      try {
        notify.info(`Testing Xray servers with ${model}...`);
        const res = await fetch("/api/xray/configs/model-filter", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            limit: modelFilter.all ? "all" : (Number(modelFilter.limit) || 50),
            all: modelFilter.all === true,
            prune: modelFilter.prune === true,
            concurrency: Number(modelFilter.concurrency) || 2,
            pauseOnTraffic: modelFilter.pauseOnTraffic === true,
            quietMs: Number(modelFilter.quietMs) || 15000,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setModelFilterResult(data);
        notify.success(`Model filter done: ${data.passed}/${data.tested} usable${data.pruned ? ` · removed ${data.pruned}` : ""}`);
        await fetchConfigs();
        await fetchStatus();
      } catch (e) {
        notify.error(`Model filter failed: ${e.message}`);
      } finally {
        setModelFilterBusy(false);
      }
    };

    if (modelFilter.prune) {
      setConfirmState({
        message: `Test ${modelFilter.all ? "all active" : `up to ${modelFilter.limit || 50}`} V2Ray servers with "${model}" and permanently delete every failing config?`,
        onConfirm: async () => {
          setConfirmState(null);
          await execute();
        },
      });
      return;
    }

    await execute();
  };

  const handleSaveSetting = async (key, value) => {
    // Optimistic update: toggle reflects immediately.
    const previousValue = settings[key];
    setSettings((s) => ({ ...s, [key]: value }));
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      notify.success("Setting saved");
      // Re-read from server to confirm persistence.
      await fetchSettings();
    } catch (e) {
      // Revert on failure.
      setSettings((s) => ({ ...s, [key]: previousValue }));
      notify.error(`Save failed: ${e.message}`);
    }
  };

  const saveModelFilterSettings = async (extra = {}) => {
    const { xrayModelFilterEnabled, ...filterExtra } = extra;
    const next = { ...modelFilter, ...filterExtra };
    const payload = {
      xrayModelFilterEnabled: xrayModelFilterEnabled ?? settings.xrayModelFilterEnabled === true,
      xrayModelFilterModel: next.model.trim(),
      xrayModelFilterLimit: Math.max(1, Math.min(Number(next.limit) || 50, 500)),
      xrayModelFilterAll: next.all === true,
      xrayModelFilterPrune: next.prune === true,
      xrayModelFilterConcurrency: Math.max(1, Math.min(Number(next.concurrency) || 2, 16)),
      xrayModelFilterPauseOnTraffic: next.pauseOnTraffic === true,
      xrayModelFilterQuietMs: Math.max(3000, Math.min(Number(next.quietMs) || 15000, 120000)),
    };
    setSettings((s) => ({ ...s, ...payload }));
    setModelFilter(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      notify.success("Model filter settings saved");
      await fetchSettings();
    } catch (e) {
      notify.error(`Save failed: ${e.message}`);
      await fetchSettings();
    }
  };

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/xray/logs?lines=200", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setLogs(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (showLogs) {
      const fetchInitialLogs = async () => {
        await fetchLogs();
      };
      fetchInitialLogs();
      const t = setInterval(fetchLogs, 3000);
      return () => clearInterval(t);
    }
  }, [showLogs, fetchLogs]);

  if (loading || !status) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">V2Ray Proxy</h1>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const activeConfig = configs.find((c) => c.id === status.activeConfigId);
  const runningModelFilter = status.modelFilter?.status === "running";
  const visibleModelFilterResult = modelFilterResult || (
    status.modelFilter?.status && status.modelFilter.status !== "idle"
      ? status.modelFilter
      : null
  );

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">V2Ray Proxy</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Managed local proxy powered by v2go configs + Xray-core
          </p>
        </div>
        <Badge variant={statusVariant(status.status)}>{status.status}</Badge>
      </div>

      {/* Quick-start guide */}
      {!status.binaryInstalled || status.status !== "running" ? (
        <Card className="p-4 border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20">
          <div className="text-sm space-y-1.5">
            <div className="font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">lightbulb</span>
              How to use this proxy
            </div>
            <ol className="list-decimal list-inside space-y-1 text-zinc-600 dark:text-zinc-300 ml-1">
              {!status.binaryInstalled && (
                <li><strong>Install</strong> the Xray binary (one-time, ~20MB download)</li>
              )}
              <li><strong>Sync</strong> configs from v2go (auto-runs hourly after first sync)</li>
              <li><strong>Start</strong> the proxy — a SOCKS5 proxy opens on <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">127.0.0.1:10808</code></li>
              <li>Go to <Link href="/dashboard/providers" className="text-blue-600 hover:underline font-medium">Providers</Link>, pick a connection, and assign the <strong>“V2Ray Proxy (v2go)”</strong> pool — requests to that provider now route through the proxy</li>
            </ol>
            <div className="text-xs text-zinc-500 mt-2">
              The proxy auto-creates a pool in <Link href="/dashboard/proxy-pools" className="text-blue-600 hover:underline">Proxy Pools</Link> when running. Switch servers any time; auto-rotate if enabled.
            </div>
          </div>
        </Card>
      ) : null}

      {/* Status card */}
      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Binary</div>
            {status.binaryInstalled ? (
              <Badge variant="success">Installed v{status.installedVersion}</Badge>
            ) : (
              <Badge variant="error">Not installed</Badge>
            )}
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">SOCKS Port</div>
            <div className="font-mono">{status.socksPort ? `127.0.0.1:${status.socksPort}` : "—"}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">PID</div>
            <div className="font-mono">{status.pid || "—"}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Latency</div>
            {status.lastHealth ? (
              <Badge variant={latencyVariant(status.lastHealth.latencyMs)}>
                {latencyText(status.lastHealth.latencyMs)}
              </Badge>
            ) : (
              <span className="text-zinc-400">—</span>
            )}
          </div>
        </div>

        {activeConfig && (
          <div className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-lg p-3">
            <span className="text-zinc-500 dark:text-zinc-400">Active server: </span>
            <span className="font-medium">{activeConfig.name}</span>
            {status.lastHealth?.exitIp && (
              <span className="text-zinc-500 ml-2">· exit {status.lastHealth.exitIp}</span>
            )}
          </div>
        )}

        {status.lastError && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg p-3">
            {status.lastError}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!status.binaryInstalled ? (
            <Button onClick={handleInstall} disabled={busy}>Install Xray Binary</Button>
          ) : status.status === "running" ? (
            <>
              <Button variant="secondary" onClick={() => handleStart()} disabled={busy}>Restart</Button>
              <Button variant="danger" onClick={handleStop} disabled={busy}>Stop</Button>
              <Button variant="ghost" onClick={handleHealthCheck} disabled={busy}>Health Check</Button>
            </>
          ) : (
            <Button onClick={() => handleStart()} disabled={busy}>Start Proxy</Button>
          )}
          <Button variant="ghost" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? "Hide Logs" : "View Logs"}
          </Button>
          <a href="/dashboard/proxy-pools" className="text-sm text-blue-600 hover:underline self-center ml-auto">
            Manage in Proxy Pools →
          </a>
        </div>
      </Card>

      {/* Log viewer */}
      {showLogs && (
        <Card className="p-4">
          <pre className="text-xs font-mono whitespace-pre-wrap max-h-64 overflow-auto text-zinc-600 dark:text-zinc-300">
            {logs.runtime || "(no logs yet)"}
          </pre>
        </Card>
      )}

      {/* Sync card */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Subscription Sync</h2>
          <Badge>auto-update every {settings.xraySyncIntervalMin || 60} min</Badge>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Last sync</div>
            <div>{formatDateTime(status.sync?.lastSyncAt)}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Configs</div>
            <div>{status.sync?.lastSyncCount ?? 0}</div>
          </div>
          <div>
            <div className="text-zinc-500 dark:text-zinc-400 mb-1">Total syncs</div>
            <div>{status.sync?.totalSyncRuns ?? 0}</div>
          </div>
        </div>
        {status.sync?.lastSyncError && (
          <div className="text-sm text-amber-600 dark:text-amber-400">
            Last error: {status.sync.lastSyncError}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-zinc-500 block mb-1">Subscription URL</label>
            <Input
              value={settings.xraySubscriptionUrl || ""}
              onChange={(e) => setSettings((s) => ({ ...s, xraySubscriptionUrl: e.target.value }))}
              placeholder="https://raw.githubusercontent.com/Danialsamadi/v2go/main/AllConfigsSub.txt"
            />
          </div>
          <Button variant="ghost" onClick={() => handleSaveSetting("xraySubscriptionUrl", settings.xraySubscriptionUrl)} disabled={busy}>
            Save
          </Button>
          <Button onClick={handleSync} disabled={busy}>Sync Now</Button>
        </div>
        <div className="grid sm:grid-cols-[220px_1fr] gap-3 items-end text-sm">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Keep inactive servers</label>
            <select
              className="w-full text-sm border rounded px-2 py-2 bg-transparent"
              value={String(settings.xrayStaleRetentionDays ?? 7)}
              onChange={(e) => {
                const value = Number(e.target.value);
                setSettings((s) => ({ ...s, xrayStaleRetentionDays: value }));
                handleSaveSetting("xrayStaleRetentionDays", value);
              }}
            >
              <option value="7">7 days</option>
              <option value="1">24 hours</option>
              <option value="0">Delete after sync</option>
              <option value="-1">Forever</option>
            </select>
          </div>
          <div className="text-xs text-zinc-500 pb-2">
            Sync marks missing servers inactive first, then this setting decides when inactive rows are deleted.
          </div>
        </div>
      </Card>

      {/* Settings card */}
      <Card className="p-5 space-y-3">
        <h2 className="font-semibold">Settings</h2>
        <div className="space-y-3 text-sm">
          <label className="flex items-center justify-between">
            <span>Auto-start on boot</span>
            <Toggle
              checked={settings.xrayAutoStart === true}
              onChange={(v) => { setSettings((s) => ({ ...s, xrayAutoStart: v })); handleSaveSetting("xrayAutoStart", v); }}
            />
          </label>
          <label className="flex items-center justify-between">
            <span>Auto-rotate when active server dies</span>
            <Toggle
              checked={settings.xrayAutoRotate === true}
              onChange={(v) => { setSettings((s) => ({ ...s, xrayAutoRotate: v })); handleSaveSetting("xrayAutoRotate", v); }}
            />
          </label>
        </div>
      </Card>

      {/* Model-aware filtering */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold">Model Proxy Filter</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Test Xray IPs against a real routed model request, then optionally delete failing configs.
            </p>
          </div>
          {visibleModelFilterResult && (
            <Badge variant={visibleModelFilterResult.status === "running" ? "warning" : visibleModelFilterResult.failed === 0 ? "success" : "warning"}>
              {visibleModelFilterResult.status === "running"
                ? `${visibleModelFilterResult.tested || 0} tested...`
                : `${visibleModelFilterResult.passed}/${visibleModelFilterResult.tested} usable`}
            </Badge>
          )}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm">
          <div>
            <div className="font-medium">Auto-filter after subscription sync</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Off by default. When enabled, each successful v2go sync runs this filter with the saved settings.
            </div>
          </div>
          <Toggle
            checked={settings.xrayModelFilterEnabled === true}
            onChange={(v) => saveModelFilterSettings({ xrayModelFilterEnabled: v })}
          />
        </div>

        <div className="grid md:grid-cols-[1fr_120px_120px_auto] gap-2 items-end">
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Model</label>
            <Input
              value={modelFilter.model}
              onChange={(e) => setModelFilter((s) => ({ ...s, model: e.target.value }))}
              placeholder="oc/deepseek-v4-flash-free"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Limit</label>
            <Input
              type="number"
              min="1"
              max="500"
              value={modelFilter.limit}
              disabled={modelFilter.all}
              onChange={(e) => setModelFilter((s) => ({ ...s, limit: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Threads</label>
            <Input
              type="number"
              min="1"
              max="16"
              value={modelFilter.concurrency}
              onChange={(e) => setModelFilter((s) => ({ ...s, concurrency: e.target.value }))}
            />
          </div>
          <Button variant="ghost" onClick={() => saveModelFilterSettings()} disabled={busy}>
            Save
          </Button>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={modelFilter.all}
              onChange={(e) => setModelFilter((s) => ({ ...s, all: e.target.checked }))}
            />
            Check all active configs
          </label>
          <label className="text-sm flex items-center gap-2 h-10">
            <input
              type="checkbox"
              checked={modelFilter.prune}
              onChange={(e) => setModelFilter((s) => ({ ...s, prune: e.target.checked }))}
            />
            Delete failures
          </label>
          <label className="text-sm flex items-center gap-2 h-10">
            <input
              type="checkbox"
              checked={modelFilter.pauseOnTraffic}
              onChange={(e) => setModelFilter((s) => ({ ...s, pauseOnTraffic: e.target.checked }))}
            />
            Pause while live traffic is active
          </label>
          <span className="text-xs text-zinc-500 self-center">
            Recommended threads: 2. Turn pause off only when you want filtering to run continuously.
          </span>
        </div>

        {modelFilter.pauseOnTraffic && (
          <div className="grid md:grid-cols-[160px_1fr] gap-2 items-end text-sm">
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Quiet window (ms)</label>
              <Input
                type="number"
                min="3000"
                max="120000"
                value={modelFilter.quietMs}
                onChange={(e) => setModelFilter((s) => ({ ...s, quietMs: e.target.value }))}
              />
            </div>
            <div className="text-xs text-zinc-500 pb-2">
              Filtering resumes after live model traffic has been quiet for this long.
            </div>
          </div>
        )}

        {runningModelFilter && (
          <div className="text-sm rounded-lg bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 p-3">
            Filtering {status.modelFilter.all ? "all active configs" : `up to ${status.modelFilter.limit}`} with {status.modelFilter.concurrency || 2} threads:
            {" "}{status.modelFilter.tested || 0} tested, {status.modelFilter.passed || 0} usable, {status.modelFilter.failed || 0} failed.
            {status.modelFilter.pauseOnTraffic ? " Pauses when live traffic is active." : ""}
          </div>
        )}

        <div>
          <Button onClick={runModelFilter} disabled={modelFilterBusy || runningModelFilter || busy || !status.binaryInstalled}>
            {modelFilterBusy || runningModelFilter ? "Testing..." : "Run Filter Now"}
          </Button>
        </div>

        {modelFilterResult?.results?.length > 0 && (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-xs">
              <thead className="text-left text-zinc-500 dark:text-zinc-400 border-b">
                <tr>
                  <th className="py-2 px-3">Server</th>
                  <th className="py-2 px-3">Country</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Latency</th>
                  <th className="py-2 px-3">Error</th>
                </tr>
              </thead>
              <tbody>
                {modelFilterResult.results.slice(0, 25).map((r) => (
                  <tr key={r.configId} className="border-b last:border-0">
                    <td className="py-2 px-3 max-w-xs truncate">{r.name || r.host || r.configId}</td>
                    <td className="py-2 px-3">{r.country || "—"}</td>
                    <td className="py-2 px-3">
                      <Badge variant={r.ok ? "success" : "error"}>{r.ok ? "usable" : "failed"}</Badge>
                    </td>
                    <td className="py-2 px-3">{latencyText(r.latencyMs)}</td>
                    <td className="py-2 px-3 max-w-sm truncate">{r.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {modelFilterResult.results.length > 25 && (
              <div className="text-center py-2 text-xs text-zinc-500">
                Showing first 25 of {modelFilterResult.results.length} results.
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Server list */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-semibold">Servers ({configs.length})</h2>
            <div className="text-xs text-zinc-500 mt-1">
              Active {configCounts.active || 0} · Inactive {configCounts.inactive || 0} · Total {configCounts.total || 0}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <select
              className="text-sm border rounded px-2 py-1 bg-transparent"
              value={filter.status}
              onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value, country: "", protocol: "" }))}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
            <select
              className="text-sm border rounded px-2 py-1 bg-transparent"
              value={filter.protocol}
              onChange={(e) => setFilter((f) => ({ ...f, protocol: e.target.value }))}
            >
              <option value="">All protocols</option>
              {facets.protocols.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
            <select
              className="text-sm border rounded px-2 py-1 bg-transparent"
              value={filter.country}
              onChange={(e) => setFilter((f) => ({ ...f, country: e.target.value }))}
            >
              <option value="">All countries</option>
              {facets.countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="text-sm flex items-center gap-1">
              <input
                type="checkbox"
                checked={filter.healthyOnly}
                onChange={(e) => setFilter((f) => ({ ...f, healthyOnly: e.target.checked }))}
              />
              Healthy only
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500 dark:text-zinc-400 border-b">
              <tr>
                <th className="py-2 pr-3">Server</th>
                <th className="py-2 px-3">Protocol</th>
                <th className="py-2 px-3">Country</th>
                <th className="py-2 px-3">Endpoint</th>
                <th className="py-2 px-3">Latency</th>
                <th className="py-2 pl-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {configs.slice(0, 200).map((c) => (
                <tr key={c.id} className={`border-b last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 ${c.isActive === false ? "opacity-60" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      {c.isSelected && <span className="w-2 h-2 rounded-full bg-green-500" title="active" />}
                      <span className="truncate max-w-xs">{c.name || c.host}</span>
                      {c.isActive === false && <Badge>inactive</Badge>}
                    </div>
                  </td>
                  <td className="py-2 px-3"><Badge>{c.protocol?.toUpperCase()}</Badge></td>
                  <td className="py-2 px-3">{c.country || "—"}</td>
                  <td className="py-2 px-3 font-mono text-xs">{c.host}:{c.port}</td>
                  <td className="py-2 px-3">
                    <Badge variant={latencyVariant(c.lastLatencyMs)}>{latencyText(c.lastLatencyMs)}</Badge>
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <div className="flex gap-1 justify-end">
                      {!c.isSelected && c.isActive !== false && (
                        <Button size="sm" variant="ghost" onClick={() => handleSwitch(c.id, c.name)} disabled={busy}>
                          Select
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleTest(c.id)}
                        disabled={testingId === c.id || busy || c.isActive === false}
                      >
                        {testingId === c.id ? "..." : "Test"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {configs.length === 0 && (
            <div className="text-center py-8 text-zinc-500">
              No {filter.status === "all" ? "" : `${filter.status} `}configs found. Click <strong>Sync Now</strong> to fetch from v2go.
            </div>
          )}
          {configs.length > 200 && (
            <div className="text-center py-3 text-xs text-zinc-500">
              Showing first 200 of {configs.length}. Use filters to narrow down.
            </div>
          )}
        </div>
      </Card>

      <ConfirmModal
        isOpen={!!confirmState}
        message={confirmState?.message}
        onConfirm={confirmState?.onConfirm}
        onClose={() => setConfirmState(null)}
      />
    </div>
  );
}
