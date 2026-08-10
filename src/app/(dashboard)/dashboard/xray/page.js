"use client";

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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [filter, setFilter] = useState({ protocol: "", country: "", healthyOnly: false });
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState({ runtime: "", install: "" });
  const [settings, setSettings] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const notify = useNotificationStore();
  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/xray/status", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setStatus(data);
        setSettings((prev) => ({ ...prev, xraySubscriptionUrl: data.sync?.sourceUrl }));
      }
    } catch (e) {
      console.log("status fetch error:", e.message);
    }
  }, []);

  const fetchConfigs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter.protocol) params.set("protocol", filter.protocol);
      if (filter.country) params.set("country", filter.country);
      if (filter.healthyOnly) params.set("healthy", "1");
      const res = await fetch(`/api/xray/configs?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setConfigs(data.configs || []);
        setFacets(data.facets || { countries: [], protocols: [] });
      }
    } catch (e) {
      console.log("configs fetch error:", e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchStatus();
    fetchConfigs();
  }, [fetchStatus, fetchConfigs]);

  // Poll status while running so health/latency stay fresh.
  useEffect(() => {
    if (status?.status === "running") {
      pollRef.current = setInterval(fetchStatus, 15000);
      return () => clearInterval(pollRef.current);
    }
  }, [status?.status, fetchStatus]);

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
      notify.success(`Synced ${result.count} configs`);
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

  const handleSaveSetting = async (key, value) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      notify.success("Setting saved");
      await fetchStatus();
    } catch (e) {
      notify.error(`Save failed: ${e.message}`);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch("/api/xray/logs?lines=200", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setLogs(data);
    } catch {}
  };

  useEffect(() => {
    if (showLogs) {
      fetchLogs();
      const t = setInterval(fetchLogs, 3000);
      return () => clearInterval(t);
    }
  }, [showLogs]);

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

      {/* Server list */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold">Servers ({configs.length})</h2>
          <div className="flex gap-2 flex-wrap">
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
                <tr key={c.id} className="border-b last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      {c.isSelected && <span className="w-2 h-2 rounded-full bg-green-500" title="active" />}
                      <span className="truncate max-w-xs">{c.name || c.host}</span>
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
                      {!c.isSelected && (
                        <Button size="sm" variant="ghost" onClick={() => handleSwitch(c.id, c.name)} disabled={busy}>
                          Select
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleTest(c.id)}
                        disabled={testingId === c.id || busy}
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
              No configs yet. Click <strong>Sync Now</strong> to fetch from v2go.
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
