import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { markProxyEntryCooldown } from "@/models";
import {
  isProxyRotatableError,
  proxyCooldownForError,
  groupHasAvailableEntry,
  isConnectionFailure,
} from "@/lib/network/proxyRotation.js";
import { getProxyPoolById } from "@/models";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { beginLiveModelTraffic, wrapLiveModelResponse } from "@/lib/xray/modelFilterTraffic.js";
import { triggerManagedRotationOnProxyError, waitForManagedRotationSettle } from "@/lib/xray/managedRotation.js";
import { MANAGED_POOL_ID } from "@/lib/xray/manager.js";
import { waitForSocksPortOpen } from "@/lib/xray/tester.js";

// Max times a single request will retry after a managed-pool *connection*
// failure (SOCKS port down during a rotation's teardown/respawn window). These
// are transient infra errors, not account errors — we wait for the port to come
// back and retry the same account rather than burning it.
const MAX_MANAGED_CONN_RETRIES = 2;

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const internalProbe = request?.headers?.get("x-9r-internal") === "xray-model-filter"
    || clientRawRequest?.headers?.["x-9r-internal"] === "xray-model-filter";
  const finishLiveTraffic = internalProbe ? null : beginLiveModelTraffic();
  const completeLiveTraffic = (response) => finishLiveTraffic
    ? wrapLiveModelResponse(response, finishLiveTraffic)
    : response;

  try {

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return completeLiveTraffic(bypassResponse.response || bypassResponse);

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return completeLiveTraffic(await handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      }));
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return completeLiveTraffic(await handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    }));
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return completeLiveTraffic(await handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    }));
  }

  return completeLiveTraffic(await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey));
  } catch (error) {
    finishLiveTraffic?.();
    throw error;
  }
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  // Proxy-group entries already tried this request (cleared per request, not
  // per account) — prevents re-picking a cooled-down entry within one rotation.
  const excludedProxyEntryIds = new Set();
  let lastError = null;
  let lastStatus = null;
  // Retries used so far for managed-pool connection failures (port-down during
  // rotation). Bounded by MAX_MANAGED_CONN_RETRIES per request.
  let managedConnRetries = 0;
  // Last known state of the SOCKS port during those retries. null = no retry
  // ran; true = port kept accepting connections (so the failure is NOT
  // teardown noise); false = port never came back.
  let managedConnPortOpen = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    const psd = refreshedCredentials?.providerSpecificData || {};
    const usedPoolId = psd.connectionProxyPoolId || null;
    const usedEntryId = psd.connectionProxyEntryId || null;

    // --- Managed-pool connection-failure retry (rotation teardown window) ---
    // When a request through the managed pool fails with a CONNECTION-level
    // error (SOCKS port down during a switchConfig kill+respawn), the failure
    // is transient infra noise — NOT an account problem. Wait for any in-flight
    // rotation to settle, for the SOCKS port to come back, then retry the SAME
    // account without marking it unavailable. Bounded by MAX_MANAGED_CONN_RETRIES.
    if (
      usedPoolId === MANAGED_POOL_ID &&
      result.status === HTTP_STATUS.BAD_GATEWAY &&
      isConnectionFailure(result.error) &&
      managedConnRetries < MAX_MANAGED_CONN_RETRIES
    ) {
      managedConnRetries += 1;
      // Derive the SOCKS port this request actually used: parse it from the
      // resolved proxy URL (authoritative — a blue-green switch may have moved
      // the active instance off the configured settings port).
      const portMatch = /:\/\/127\.0\.0\.1:(\d+)/.exec(psd.connectionProxyUrl || "");
      const connSocksPort = Number(portMatch?.[1]) || Number(psd.connectionSocksPort) || Number((await getSettings().catch(() => ({})))?.xraySocksPort) || 10808;
      log.warn("PROXY", `Managed-pool connection failure (likely mid-rotation); waiting for SOCKS port ${connSocksPort} then retry ${managedConnRetries}/${MAX_MANAGED_CONN_RETRIES}`);
      // 1. Let any in-flight rotation finish (it may be the one that tore the port down).
      await waitForManagedRotationSettle({ maxWaitMs: 6000 });
      // 2. Wait for the port to accept connections again (≤6s).
      const up = await waitForSocksPortOpen(connSocksPort, 6000);
      managedConnPortOpen = up;
      if (up) {
        // Port is back — retry the same account + body. Do NOT mark the
        // account unavailable or exclude it; this was an infra blip.
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }
      // Port didn't come back in time — fall through to normal error handling.
      log.warn("PROXY", `Managed-pool SOCKS port ${connSocksPort} did not come back within 6s; falling through to error handling`);
    }

    const rotatable = isProxyRotatableError(result.status, result.error);

    // --- Proxy-group / managed-pool rotation on rotatable errors (429/rate-limit/5xx) ---
    // When a request fails through a proxy-group entry with an error that's
    // often IP-specific, cool down that entry and retry the SAME account with a
    // different proxy from the group — rather than burning the whole account.
    // Only fall back to the next account once the group has no entries left.
    //
    // Managed pool (v2go-xray-managed) is a single-URL pool backed by one
    // running xray instance. It has no per-entry rotation, so on a rotatable
    // error (e.g. 429 rate-limit on the current egress IP) kick off a
    // background switchConfig() to a different healthy outbound for this
    // model. Fire-and-forget: switchConfig is blue-green (new instance on a
    // fresh port, pool repointed after health verification), so in-flight
    // requests are unaffected — the next request resolves the pool and hits
    // the new IP.
    if (rotatable && usedPoolId === MANAGED_POOL_ID) {
      // Connection-level failures (SOCKS port down, terminated streams) are
      // usually infra noise — often self-inflicted by a rotation's teardown —
      // NOT an IP-rate-limit signal. Rotating on them amplifies the outage:
      // each switch tears down more streams, which fail as 502s, which trigger
      // yet another rotation. They are handled by the retry path above…
      if (isConnectionFailure(result.error)) {
        // …EXCEPT when the retries already ran and the SOCKS port kept
        // accepting connections the whole time (or never came back with no
        // rotation in flight to blame). Then the teardown-noise theory is
        // dead: the xray process is up but its outbound can't reach anything
        // (dead node). Without this, a node that dies outside a rotation is
        // stuck forever — health checks only run manually, so real traffic is
        // the only signal. triggerManagedRotationOnProxyError has its own
        // in-flight + cooldown guards, so this is safe to call per request.
        if (managedConnRetries >= MAX_MANAGED_CONN_RETRIES || managedConnPortOpen === false) {
          log.warn(
            "PROXY",
            `Managed-pool SOCKS port ${managedConnPortOpen === false ? "down without an in-flight rotation" : "up but outbound dead"}; triggering managed rotation to a healthy node`
          );
          triggerManagedRotationOnProxyError({
            status: result.status,
            error: typeof result.error === "string" ? result.error : "",
            model: `${provider}/${model}`,
          }).catch(() => {});
        } else {
          log.warn("PROXY", "Managed-pool connection failure classified as non-rotatable (infra noise, not IP-specific)");
        }
      } else {
        triggerManagedRotationOnProxyError({
          status: result.status,
          error: typeof result.error === "string" ? result.error : "",
          model: `${provider}/${model}`,
        }).catch(() => {});
      }
    }

    if (rotatable && usedPoolId && usedEntryId) {
      // Cool down the entry that just failed.
      const cdMs = proxyCooldownForError(result.status, result.error);
      await markProxyEntryCooldown(usedPoolId, usedEntryId, cdMs, result.error).catch(() => {});
      log.warn("PROXY", `Entry ${usedEntryId} in group ${usedPoolId} cooled down ${cdMs}ms (${result.status})`);

      // Track which entries we've already tried this request so re-resolve
      // skips them even before their cooldown timestamp lands in the DB.
      excludedProxyEntryIds.add(usedEntryId);

      // Is there still a usable entry in the group? If so, retry the SAME
      // account without excluding it — the next loop iteration will re-resolve
      // (getProviderCredentials picks a fresh entry) and we also override the
      // proxy fields directly to be safe for the no-auth path.
      const pool = await getProxyPoolById(usedPoolId).catch(() => null);
      if (pool && groupHasAvailableEntry(pool, excludedProxyEntryIds)) {
        lastError = result.error;
        lastStatus = result.status;
        // Don't exclude the connection — keep the account, switch the proxy.
        // Re-resolve will pick the next available entry from the group.
        continue;
      }
      // Group exhausted → fall through to account fallback below.
      log.warn("PROXY", `Group ${usedPoolId} exhausted, falling back to next account`);
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
