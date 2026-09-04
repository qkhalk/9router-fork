import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { applyDs2apiUrl } from "@/lib/ds2api/resolve";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    // S5: mitmSudoEncrypted is an AES-GCM blob under a per-install key — it has
    // no business crossing the API surface at all.
    const { password, oidcClientSecret, mitmSudoEncrypted, ...safeSettings } = settings;
    // Alert channel values are credentials (bot token, webhook URLs) — send
    // configured-booleans, never the values (risk table: token leak via GET).
    safeSettings.alertsTelegramConfigured = Boolean(safeSettings.alertsTelegramBotToken && safeSettings.alertsTelegramChatId);
    safeSettings.alertsDiscordConfigured = Boolean(safeSettings.alertsDiscordWebhookUrl);
    safeSettings.alertsWebhookConfigured = Boolean(safeSettings.alertsWebhookUrl);
    delete safeSettings.alertsTelegramBotToken;
    delete safeSettings.alertsDiscordWebhookUrl;
    delete safeSettings.alertsWebhookUrl;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // xraySyncIntervalMin: 0 = manual-only mode, otherwise clamp to >= 5 min
    // so users can't accidentally hammer an upstream subscription. Non-numeric
    // or negative values fall back to manual-only.
    if (Object.prototype.hasOwnProperty.call(body, "xraySyncIntervalMin")) {
      const raw = Number(body.xraySyncIntervalMin);
      if (!Number.isFinite(raw) || raw <= 0) {
        body.xraySyncIntervalMin = 0;
      } else {
        body.xraySyncIntervalMin = Math.max(5, Math.floor(raw));
      }
    }

    // totuAutoFetchIntervalMin: 0 = manual-only mode, otherwise clamp to >= 5 min
    // (mirrors xraySyncIntervalMin above).
    if (Object.prototype.hasOwnProperty.call(body, "totuAutoFetchIntervalMin")) {
      const raw = Number(body.totuAutoFetchIntervalMin);
      if (!Number.isFinite(raw) || raw <= 0) {
        body.totuAutoFetchIntervalMin = 0;
      } else {
        body.totuAutoFetchIntervalMin = Math.max(5, Math.floor(raw));
      }
    }

    // Alerts (phase 05): trim channel fields, validate URL shapes, clamp
    // numeric knobs. Credential fields follow the oidcClientSecret
    // convention: absent/empty means "keep the stored value" (the GET
    // response masks them), invalid non-empty URLs clear themselves.
    for (const field of ["alertsTelegramBotToken", "alertsTelegramChatId"]) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const trimmed = typeof body[field] === "string" ? body[field].trim() : "";
      if (!trimmed) delete body[field];
      else body[field] = trimmed;
    }
    for (const field of ["alertsDiscordWebhookUrl", "alertsWebhookUrl"]) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const trimmed = typeof body[field] === "string" ? body[field].trim() : "";
      if (!trimmed) { delete body[field]; continue; }
      body[field] = /^https:\/\/\S+$/.test(trimmed) ? trimmed : "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "alertsDedupMin")) {
      const raw = Number(body.alertsDedupMin);
      body.alertsDedupMin = Number.isFinite(raw) ? Math.min(1440, Math.max(1, Math.floor(raw))) : 10;
    }
    if (Object.prototype.hasOwnProperty.call(body, "alertsQuotaThresholdPct")) {
      const raw = Number(body.alertsQuotaThresholdPct);
      body.alertsQuotaThresholdPct = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.floor(raw))) : 20;
    }
    if (body.alertsEvents && typeof body.alertsEvents === "object" && !Array.isArray(body.alertsEvents)) {
      const allowed = new Set([
        "all-accounts-locked", "breaker-open", "breaker-recovered", "proxy-pool-exhausted",
        "strictproxy-violation", "quota-near-limit", "budget-threshold", "xray-node-down",
        "xray-rotation-failed", "totu-fetch-failed",
      ]);
      const events = {};
      for (const key of allowed) {
        if (key in body.alertsEvents) events[key] = body.alertsEvents[key] !== false;
      }
      body.alertsEvents = events;
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    // Repoint the ds2api provider at the newly configured service URL (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "ds2apiUrl") ||
      Object.prototype.hasOwnProperty.call(body, "ds2apiEnabled")
    ) {
      applyDs2apiUrl(settings.ds2apiUrl);
    }

    // Restart the xray subscription sync scheduler when its interval changes.
    // startSyncScheduler is idempotent (clears the previous timer first) and
    // honors interval = 0 by stopping the scheduler entirely (manual mode).
    if (Object.prototype.hasOwnProperty.call(body, "xraySyncIntervalMin")) {
      import("@/lib/xray/sync.js")
        .then(({ startSyncScheduler }) => startSyncScheduler())
        .catch((error) => console.warn("[XraySync] restart failed:", error.message));
    }

    // Reconfigure the TOTU account auto-fetch scheduler when toggled or its
    // interval changes. configureTotuAutoFetch stops the timer for interval 0
    // or when totuAutoFetch is disabled (manual mode).
    if (
      Object.prototype.hasOwnProperty.call(body, "totuAutoFetch") ||
      Object.prototype.hasOwnProperty.call(body, "totuAutoFetchIntervalMin")
    ) {
      import("@/lib/totuAutoFetch")
        .then(({ configureTotuAutoFetch }) => configureTotuAutoFetch(settings))
        .catch((error) => console.warn("[TotuAutoFetch] settings update failed:", error.message));
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "xrayModelFilterPauseOnTraffic") ||
      Object.prototype.hasOwnProperty.call(body, "xrayModelFilterQuietMs")
    ) {
      try {
        const { updateRunningModelFilterOptions } = await import("@/lib/xray/manager.js");
        updateRunningModelFilterOptions({
          pauseOnTraffic: settings.xrayModelFilterPauseOnTraffic === true,
          quietMs: settings.xrayModelFilterQuietMs,
        });
      } catch (error) {
        console.warn("[XrayModelFilter] live settings update failed:", error.message);
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, mitmSudoEncrypted, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    safeSettings.alertsTelegramConfigured = Boolean(safeSettings.alertsTelegramBotToken && safeSettings.alertsTelegramChatId);
    safeSettings.alertsDiscordConfigured = Boolean(safeSettings.alertsDiscordWebhookUrl);
    safeSettings.alertsWebhookConfigured = Boolean(safeSettings.alertsWebhookUrl);
    delete safeSettings.alertsTelegramBotToken;
    delete safeSettings.alertsDiscordWebhookUrl;
    delete safeSettings.alertsWebhookUrl;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
