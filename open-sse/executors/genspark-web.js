/**
 * Genspark Web Executor — calls https://www.genspark.ai Agent (AI Chat) backend
 * through the Python curl_cffi TLS sidecar.
 *
 * Why the sidecar: genspark's Cloudflare edge blocks vanilla Node `fetch` by
 * TLS/JA3 fingerprint (same WAN IP: Node → 403 "Just a moment", curl_cffi
 * chrome124 → 200). The proven bypass from the MIT `curlgenspark-py` project is a
 * real Chrome TLS impersonation, ported here as `open-sse/services/gensparkTlsSidecar.py`
 * (spawned/streamed by `open-sse/services/gensparkTlsSidecar.js`).
 *
 *   Endpoint: POST https://www.genspark.ai/api/agent/ask_proxy  (body type "ai_chat")
 *   Auth:     FULL browser cookie jar passed to the sidecar (curl_cffi Session sets
 *             them on www.genspark.ai). The pasted jar (chrome-json / netscape /
 *             kv pairs) is parsed by `open-sse/services/gensparkWebCookie.js`, and
 *             `extractGensparkWebCredentials` recovers the jar object from
 *             providerSpecificData.cookies / the pasted credential string.
 *   Body:     ai_chat shape (ported from genspark-py `chat()`):
 *             { ai_chat_model, ai_chat_enable_search, ai_chat_disable_personalization,
 *               use_moa_proxy:false, moa_models:[], writingContent:null,
 *               type:"ai_chat", project_id:null, messages:[{role,id,content}],
 *               user_s_input, g_recaptcha_token:"", is_private:true, push_token:"",
 *               session_state:{steps:[], messages} }
 *   Response: SSE `data:` frames: project_start | agent_notification (keepalive) |
 *             message_start | project_field | message_field | message_field_delta |
 *             message_result.
 *
 * Field routing:
 *   - Answer text = message_field_delta / message_field with `field_name === "content"`
 *     (incremental `delta` channel, full `field_value` on message_field).
 *   - Reasoning = message_field with `field_name=reasoning_id` +
 *     `reasoning_encrypted_content` — client-side encrypted, cannot be rendered
 *     server-side → dropped silently (answer still streams normally).
 *   - message_result.message.content carries the final full answer (used for the
 *     non-stream response / empty-stream fallback).
 *
 * Image models: genspark's current API (ask_proxy) has NO image generation flow —
 * feeding an image model id just returns a plain text chat. Image-model seeds are
 * removed from the registry and a requested image model here returns an honest 400.
 *
 * Reference: github.com/SharpWizard/genspark-py (audited CLEAN, MIT) + genspark2api.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { extractGensparkWebCredentials, serializeGensparkWebCookieHeader } from "../services/gensparkWebCookie.js";
import { gensparkSidecarFetch } from "../services/gensparkTlsSidecar.js";
import { isGensparkImageModel } from "../providers/gensparkCatalog.js";

const GENSPARK_BASE = "https://www.genspark.ai";
// /api/agent/ask_proxy is the live AI Chat endpoint (type:"ai_chat"). The older
// /api/copilot/ask (COPILOT_MOA_CHAT) is retired ("This feature has been retired…").
const GENSPARK_ASK_API = PROVIDERS["genspark-web"]?.baseUrl || `${GENSPARK_BASE}/api/agent/ask_proxy`;

// ── Model catalogue ───────────────────────────────────────────────────────────
// Model ids are sent verbatim as `ai_chat_model` — the live catalog
// (providers/gensparkCatalog.js) only decides whether an id is a known image
// model (honest 400; the image flow was retired with /api/copilot/ask) and
// feeds the dashboard suggestion list. Unknown text ids are forwarded as-is:
// genspark accepts its current selector lineup verbatim, so brand-new models
// work before the catalog even refreshes.

const CHAT_TYPE = "ai_chat";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise the user-supplied credential into a full `Cookie:` header value.
 * Retained for backward compatibility and for the dashboard probe paths that still
 * exercise a Cookie header; the executor itself now hands the parsed jar object to
 * the sidecar instead.
 */
function buildCookieHeader(credentials) {
  const extracted = extractGensparkWebCredentials(credentials || {});
  const header = serializeGensparkWebCookieHeader(extracted.cookies || {});
  if (header) return header;

  const raw = (credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  if (raw.includes("session_id=")) return raw;
  return `session_id=${raw}`;
}

/**
 * Parse the OpenAI-style `messages` array into the shape Genspark expects.
 *
 * Genspark's /api/agent/ask_proxy accepts the same {role, content} objects as OpenAI,
 * where content may be a string or an array of {type, text/image_url} parts. We keep the
 * structure intact so multimodal requests round-trip, but we strip empty messages and
 * convert the `developer` role (OpenAI alias) to `system`.
 *
 * For deep-seek-r1 (which Genspark exposes via MOA), genspark2api demotes `system` → `user`
 * because the underlying DeepSeek model rejects system messages. We mirror that here.
 */
function transformMessages(messages, modelName) {
  const out = [];
  for (const msg of messages || []) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    if (modelName === "deep-seek-r1" && role === "system") role = "user";

    let content = msg.content;
    if (content == null) content = "";
    if (typeof content === "string") {
      if (!content.trim()) continue;
    } else if (Array.isArray(content)) {
      const filtered = content.filter((c) => {
        if (!c || typeof c !== "object") return false;
        if (c.type === "text") return String(c.text || "").trim().length > 0;
        return true; // keep image_url / private_file parts
      });
      if (filtered.length === 0) continue;
      content = filtered;
    }
    out.push({ role, content });
  }
  return out;
}

/** Last user turn as plain text (string content, or joined text parts for arrays). */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c) => c && typeof c === "object" && c.type === "text")
        .map((c) => String(c.text || ""));
      if (texts.some(Boolean)) return texts.join("\n");
    }
  }
  return "";
}

/**
 * Build the Genspark /api/agent/ask_proxy body for an AI Chat request.
 *
 * Ported from genspark-py `chat()` (audited clean) with the exact live-verified shape.
 * Every message gets a fresh `id` (genspark tracks message ids); `session_state.messages`
 * mirrors the full history so a stateless 9router request still reconstructs a coherent
 * conversation. `user_s_input` carries the last user turn text (search uses it too).
 */
function buildChatRequestBody(modelName, messages, isSearch) {
  // Strip "-search" suffix for the upstream model id; genspark2api does the same.
  let upstreamModel = modelName;
  if (isSearch) upstreamModel = upstreamModel.replace(/-search$/, "");

  // deepseek → deep-seek (Genspark's internal naming).
  if (upstreamModel.startsWith("deepseek")) {
    upstreamModel = upstreamModel.replace(/^deepseek/, "deep-seek");
  }

  const withIds = (messages || []).map((m) => ({ ...m, id: m.id || crypto.randomUUID() }));
  const userInput = lastUserText(withIds);

  return {
    ai_chat_model: upstreamModel,
    ai_chat_enable_search: isSearch,
    ai_chat_disable_personalization: false,
    use_moa_proxy: false,
    moa_models: [],
    writingContent: null,
    type: CHAT_TYPE,
    project_id: null,
    messages: withIds,
    user_s_input: userInput,
    g_recaptcha_token: "",
    is_private: true,
    push_token: "",
    session_state: { steps: [], messages: withIds },
  };
}

/**
 * Read an SSE stream from a Response body / ReadableStream and yield parsed JSON event
 * objects. Mirrors readPplxSseEvents in perplexity-web.js but treats each
 * `data: <json>` line as a frame. Lines without a `data:` prefix are ignored
 * (comments, event: tags, keepalives). The sidecar harness re-prefixes its stdout so
 * this parser works unchanged.
 */
async function* readGensparkSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Skip malformed JSON frames — Genspark occasionally emits partial keepalives.
        }
      }
    }
    // Flush any trailing line.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trimStart();
      if (payload && payload !== "[DONE]") {
        try { yield JSON.parse(payload); } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Classify a response body text for known error signatures.
 * Returns one of: "rate_limit" | "free_limit" | "not_login" | "cloudflare" |
 * "server_error" | "service_unavailable" | null.
 *
 * New signatures on the ask_proxy endpoint (verified live):
 *   - not-logged-in session → HTTP 400 `text/plain;charset=UTF-8` body "bad request cf"
 *   - Cloudflare challenge   → 403 (or 200) with an HTML page
 * Old copilot signatures are kept for tolerance.
 */
function classifyError(data) {
  if (typeof data !== "string") return null;
  if (data === "Rate limit exceeded cf1" || data === "Rate limit exceeded cf2") return "rate_limit";
  if (data.includes("Rate limit exceeded")) return "rate_limit";
  if (data === "bad request cf" || data.includes("bad request cf")) return "not_login";
  if (data.includes('"status":-5,"message":"not login"')) return "not_login";
  if (data === "Internal Server Error" || data.includes("Internal Server Error")) return "server_error";
  if (data.includes("'You've reached your free usage limit today'") || data.includes("reached your free usage limit")) return "free_limit";
  if (data.includes("Server overloaded, please try again later.")) return "service_unavailable";
  if (data.includes("<title>Just a moment...") || data.includes("Just a moment") || data.includes("cdn-cgi/challenge-platform") || data.includes("cf_chl")) {
    return "cloudflare";
  }
  return null;
}

/**
 * Decide whether a `message_field` / `message_field_delta` event carries answer text.
 *
 * Returns { kind: "answer", delta: <string> } or null (ignore).
 *
 * Routing (verified on the live ask_proxy stream):
 *   - `field_name === "content"` is the answer channel. On message_field_delta it is an
 *     incremental delta; on message_field it carries the full field value (used by some
 *     flows / the non-stream path).
 *   - `field_name === "reasoning_id"` / `"reasoning_encrypted_content"` → encrypted
 *     reasoning; the web client decrypts it, we cannot → dropped silently.
 *
 * `modelName` / `isSearch` / `hideReasoning` are accepted for signature compatibility
 * with the prior copilot-era routing — the answer channel no longer branches on them.
 */
function classifyFieldEvent(event, modelName, isSearch, hideReasoning) {
  const fieldName = event.field_name;
  if (!fieldName) return null;
  if (fieldName === "reasoning_id" || fieldName === "reasoning_encrypted_content") return null;
  if (fieldName !== "content") return null;
  const delta = String(event.delta != null ? event.delta : (event.field_value ?? ""));
  return delta ? { kind: "answer", delta } : null;
}

/**
 * Central generator over the whole SSE event stream, accumulating answer deltas and
 * signalling completion with the final `message_result` content (used for non-stream).
 *
 * Yields { type: "answer_delta"|"done"|"error", delta?, message?, projectId? }
 */
async function* extractContent(responseBody, modelName, isSearch, hideReasoning, signal) {
  let projectId = "";
  let accumulated = "";
  for await (const event of readGensparkSseEvents(responseBody, signal)) {
    if (!event || typeof event !== "object") continue;
    const eventType = event.type;

    if (eventType === "project_start") {
      projectId = String(event.id || "");
      continue;
    }

    if (eventType === "message_field" || eventType === "message_field_delta") {
      const classified = classifyFieldEvent(event, modelName, isSearch, hideReasoning);
      if (!classified || classified.kind !== "answer") continue;
      const delta = classified.delta;
      // A message_field can carry the full accumulated value after the deltas streamed —
      // skip exact repeats so the answer isn't doubled downstream.
      if (delta === accumulated) continue;
      accumulated += delta;
      yield { type: "answer_delta", delta };
      continue;
    }

    if (eventType === "message_result") {
      // Terminal frame — `message.message.content` (nested) or `content` carries the final
      // full answer. For streaming we've already emitted every delta; for non-stream this
      // is the authoritative final text when no deltas arrived.
      const finalContent =
        typeof event.message?.content === "string" ? event.message.content
        : typeof event.content === "string" ? event.content
        : "";
      yield { type: "done", message: finalContent, projectId };
      return;
    }
  }
  // Stream ended without an explicit message_result — treat as done with whatever we have.
  yield { type: "done", message: "", projectId };
}

/**
 * Build a streaming Response that emits OpenAI chat.completion.chunk frames from the
 * Genspark SSE event stream.
 */
function buildStreamingResponse(responseBody, model, cid, created, modelName, isSearch, hideReasoning, signal) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        // Initial role chunk.
        controller.enqueue(encoder.encode(sseChunk({
          id: cid,
          object: "chat.completion.chunk",
          created,
          model,
          system_fingerprint: null,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
        })));

        for await (const ev of extractContent(responseBody, modelName, isSearch, hideReasoning, signal)) {
          if (ev.type === "answer_delta") {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null, logprobs: null }],
            })));
          } else if (ev.type === "done") {
            // message_result.content repeats what we've already streamed via deltas.
            // Avoid emitting it here to prevent duplicate assistant content.
            break;
          }
        }

        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Build a non-streaming Response by consuming the full event stream and assembling the
 * final chat.completion JSON.
 */
async function buildNonStreamingResponse(responseBody, model, cid, created, modelName, isSearch, hideReasoning, signal) {
  let answer = "";

  for await (const ev of extractContent(responseBody, modelName, isSearch, hideReasoning, signal)) {
    if (ev.type === "answer_delta") {
      answer += ev.delta;
    } else if (ev.type === "done") {
      if (!answer && ev.message) answer = ev.message;
      break;
    }
  }

  const message = { role: "assistant", content: answer };

  // Rough token estimate (4 chars/token) — Genspark doesn't return usage info.
  const promptTokens = Math.ceil(JSON.stringify(model).length / 4);
  const completionTokens = Math.ceil(answer.length / 4);

  return new Response(JSON.stringify({
    id: cid,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: null,
    choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Map a classifyError() kind to an honest { message, code, status }. */
function errorForKind(kind) {
  switch (kind) {
    case "rate_limit":
      return { message: "Genspark rate limit exceeded. Rotate session cookies or wait a moment.", code: "RATE_LIMIT", status: 429 };
    case "free_limit":
      return { message: "Genspark free usage limit reached for this session. Use a Plus session or another cookie jar.", code: "FREE_LIMIT", status: 402 };
    case "not_login":
      return { message: "Genspark session is not logged in. The cookie jar is invalid or expired — re-export from genspark.ai.", code: "NOT_LOGIN", status: 401 };
    case "cloudflare":
      return { message: "Genspark returned a Cloudflare challenge. The TLS sidecar normally bypasses this — if it persists, verify the Python sidecar venv or use a residential proxy.", code: "CLOUDFLARE", status: 502 };
    case "server_error":
      return { message: "Genspark internal server error. Try again later.", code: "SERVER_ERROR", status: 502 };
    case "service_unavailable":
      return { message: "Genspark service is overloaded. Try again later.", code: "SERVICE_UNAVAILABLE", status: 503 };
    default:
      return { message: `Genspark upstream error (${kind}).`, code: "UPSTREAM_ERROR", status: 502 };
  }
}

/**
 * Read the first chunk of a Genspark sidecar body stream and check it against the known
 * error signatures. If detected, return { error, code, status } and discard the body.
 * Otherwise return { stream } — a ReadableStream that replays the buffered first chunk
 * followed by the remaining body, so downstream consumers see the full stream.
 *
 * Necessary because ask_proxy can stream an error frame/body (not-login "bad request cf",
 * HTML challenge, JSON error) even though the exposed transport path is a live stream.
 */
async function inspectFirstChunk(body, log) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunk;
  try {
    while (buffer.length < 2048) {
      const { value, done } = await reader.read();
      if (done) break;
      firstChunk = firstChunk || [];
      firstChunk.push(value);
      buffer += decoder.decode(value, { stream: true });
      // Quick exit: classify as soon as we have a complete error signature.
      const errKind = classifyError(buffer);
      if (errKind) {
        const { message, code, status } = errorForKind(errKind);
        log?.warn?.("GENSPARK-WEB", `${code}: ${message}`);
        return { error: message, code, status };
      }
      // Past the error window once a real event frame begins streaming.
      // Genspark serializes SSE frames with a space after the colon
      // (`"type": "project_start"`); match regardless of whitespace so first-token
      // latency isn't inflated by buffering a full 2 KB looking for a byte-exact hit.
      if (/"type"\s*:\s*"(project_start|message_start|message_field)"/.test(buffer)) {
        break;
      }
    }
  } finally {
    if (!firstChunk) {
      // We never read anything (body was empty). Release and let downstream handle the empty stream.
      reader.releaseLock();
      return { stream: new ReadableStream({ start(c) { c.close(); } }) };
    }
  }

  // Reconstruct a stream that replays the buffered chunks then continues with the rest of body.
  const buffered = firstChunk;
  const restReader = reader;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of buffered) controller.enqueue(chunk);
        while (true) {
          const { value, done } = await restReader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      try { restReader.cancel(reason); } catch { /* ignore */ }
    },
  });
  return { stream };
}

/**
 * Resolve the sidecar's cookie-refresh Promise into a plain cookie-name→value map.
 *
 * The harness resolves `refreshedCookies` with either null (nothing changed) or a
 * JSON object of the diff it emitted on stderr. Normalise both shapes so the
 * caller can test `Object.keys(refreshed).length` safely; never throws.
 */
async function sidecarBodyRefreshedCookies(refreshedCookies) {
  if (!refreshedCookies || typeof refreshedCookies.then !== "function") return null;
  try {
    const r = await refreshedCookies;
    if (r && typeof r === "object") return r;
  } catch { /* ignore — refresh is best-effort */ }
  return null;
}

/** Quick JSON error Response helper. */
function jsonError(status, message, type, code) {
  return new Response(JSON.stringify({
    error: { message, type: type || "upstream_error", ...(code ? { code } : {}) },
  }), { status, headers: { "Content-Type": "application/json" } });
}

// ── Executor ──────────────────────────────────────────────────────────────────

export class GensparkWebExecutor extends BaseExecutor {
  constructor() {
    super("genspark-web", PROVIDERS["genspark-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions, onCredentialsRefreshed }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = jsonError(400, "Missing or empty messages array", "invalid_request");
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    // Extract the parsed cookie jar (providerSpecificData.cookies, pasted jar, or bare
    // session id). The jar is handed to the sidecar as an object — never logged/committed.
    const cookieExtraction = extractGensparkWebCredentials(credentials || {});
    if (!cookieExtraction.cookies || !cookieExtraction.valid || !cookieExtraction.cookies.session_id) {
      const errResp = jsonError(
        401,
        "Genspark cookie jar is required. Paste your genspark.ai cookie export (F12 → Application → Cookies → www.genspark.ai → Export) into the provider's cookie field. session_id must be present.",
        "invalid_request",
        "COOKIE_MISSING",
      );
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    // Detect search mode: any text model with a "-search" suffix.
    const isSearch = typeof model === "string" && model.endsWith("-search");
    const baseModel = isSearch ? model.replace(/-search$/, "") : model;
    // Image models no longer have an upstream flow on genspark — honest error.
    if (isGensparkImageModel(baseModel)) {
      const errResp = jsonError(
        400,
        `Image generation is no longer supported by genspark (model "${baseModel}" was routed to the retired image flow). Use a text model instead.`,
        "unsupported_model",
        "IMAGE_RETIRED",
      );
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    // Retained for provider config compat — reasoning is encrypted upstream and dropped,
    // so there is no reasoning content to hide.
    const hideReasoning = credentials?.providerSpecificData?.hideReasoning === true;

    const transformedMessages = transformMessages(messages, baseModel);
    if (transformedMessages.length === 0) {
      const errResp = jsonError(400, "Empty messages after processing", "invalid_request");
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: body };
    }

    const requestBody = buildChatRequestBody(baseModel, transformedMessages, isSearch);

    log?.info?.("GENSPARK-WEB", `Query to ${model} (search=${isSearch}), msg_count=${transformedMessages.length}, via TLS sidecar`);

    // Detect an http(S) outbound proxy from the connection config (proxyOptions) or env.
    // chatCore.js builds proxyOptions as { connectionProxyEnabled, connectionProxyUrl, … };
    // the sidecar wants a plain "http://host:port" (or "http://user:pass@host:port") URL.
    // connectionNoProxy on the connection means "don't proxy this one" — honor it.
    let proxy = process.env.GENSPARK_PROXY_URL || null;
    if (proxyOptions?.connectionProxyEnabled && proxyOptions.connectionProxyUrl && !proxyOptions.connectionNoProxy) {
      proxy = String(proxyOptions.connectionProxyUrl);
    }

    const { body: sidecarBody, error: sidecarError, refreshedCookies: sidecarRefreshedCookies } = await gensparkSidecarFetch({
      cookies: cookieExtraction.cookies,
      payload: requestBody,
      proxy,
      timeoutMs: 90_000,
      log,
      signal,
    });

    if (sidecarError || !sidecarBody) {
      const message = sidecarError?.message || "Genspark TLS sidecar unavailable";
      log?.warn?.("GENSPARK-WEB", message);
      const errResp = jsonError(sidecarError?.status || 502, message, "upstream_error", sidecarError?.code || "SIDECAR_UNAVAILABLE");
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: requestBody };
    }

    // Peek the first chunk for the honest error signatures (not-login, challenge, …).
    let inspected;
    try {
      inspected = await inspectFirstChunk(sidecarBody, log);
    } catch (err) {
      log?.warn?.("GENSPARK-WEB", `sidecar stream failed before body: ${err.message || String(err)}`);
      const errResp = jsonError(502, `Genspark TLS sidecar failed: ${err.message || String(err)}`, "upstream_error", "SIDECAR_STREAM");
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: requestBody };
    }

    if (inspected.error) {
      const errResp = jsonError(inspected.status || 502, inspected.error, "upstream_error", inspected.code);
      return { response: errResp, url: GENSPARK_ASK_API, headers: {}, transformedBody: requestBody };
    }

    const cid = `chatcmpl-genspark-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    // Best-effort cookie write-back: on a successful authenticated call the sidecar
    // returns cookies Cloudflare/anti-bot re-issued (fresher __cf_bm / cf_clearance).
    // Persisting them into the connection means the user doesn't have to re-paste
    // the jar every ~30 min when the datacenter IP gets challenged. Detached (no
    // await before the response): the refresh Promise resolves only when the child
    // closes (after the full answer streams), so awaiting here would delay TTFT.
    // We resolve it inside the detached chain instead, and never block the stream.
    if (onCredentialsRefreshed) {
      sidecarBodyRefreshedCookies(sidecarRefreshedCookies)
        .then((refreshed) => {
          if (!refreshed || !Object.keys(refreshed).length) return;
          // merge the refreshed diff over the jar we actually used for THIS call
          // (cookieExtraction.cookies still holds session_id / c1 / c2 / gslogin),
          // then write back the COMPLETE jar. updateProviderCredentials merges
          // providerSpecificData one level deep, so a partial `cookies` diff would
          // replace the whole map and silently drop session_id — which then makes
          // the next request fail with COOKIE_MISSING. Sending the full merged jar
          // keeps every field intact while still refreshing __cf_bm / cf_clearance.
          const merged = { ...cookieExtraction.cookies, ...refreshed };
          return onCredentialsRefreshed({ providerSpecificData: { cookies: merged } });
        })
        .then(() => log?.info?.("GENSPARK-WEB", "cookie refresh written back"))
        .catch((e) => log?.warn?.("GENSPARK-WEB", `cookie write-back failed: ${e?.message || String(e)}`));
    }

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingResponse(
        inspected.stream, model, cid, created, baseModel, isSearch, hideReasoning, signal,
      );
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: { ...SSE_HEADERS_NO_BUFFER },
      });
    } else {
      finalResponse = await buildNonStreamingResponse(
        inspected.stream, model, cid, created, baseModel, isSearch, hideReasoning, signal,
      );
    }
    return { response: finalResponse, url: GENSPARK_ASK_API, headers: {}, transformedBody: requestBody };
  }
}

export {
  buildCookieHeader,
  transformMessages,
  buildChatRequestBody,
  classifyFieldEvent,
  classifyError,
};

export default GensparkWebExecutor;