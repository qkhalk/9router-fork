import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

import { getModelTargetFormat, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { ensureOpencodeCatalog, getOpencodeCliUserAgent, isResponsesServed } from "../providers/opencodeCatalog.js";

// opencode.ai validates the free-tier fingerprint server-side: session/request
// ids must match the official identifier format from @opencode-ai/schema
// (ses_/msg_ prefix + 12 lowercase-hex chars + 14 alphanumeric chars, 26
// total) and the User-Agent must carry a currently-released version. Anything
// else answers 403 FreeTierError ("free tier can only be used from within
// OpenCode"). Mirrors the identifier charset of @opencode-ai/schema.
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OFFICIAL_ID_RE = /^(?:ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// A genuine opencode client UA always carries a version: opencode/1.18.31 …
const VERSIONED_OPENCODE_UA_RE = /^opencode\/(\d+)\.(\d+)\.(\d+)/;
// x-opencode-client values verified as accepted by the zen free tier
const KNOWN_CLIENTS = new Set(["cli", "desktop"]);

function officialStyleId() {
  const time = crypto.randomBytes(6).toString("hex");
  const rand = Array.from(crypto.randomBytes(14), (b) => ID_CHARS[b % 62]).join("");
  return `${time}${rand}`;
}

function generateRequestId() {
  return `msg_${officialStyleId()}`;
}

function generateSessionId() {
  return `ses_${officialStyleId()}`;
}

function isOfficialId(value) {
  return typeof value === "string" && OFFICIAL_ID_RE.test(value);
}

function uaVersion(ua) {
  const m = VERSIONED_OPENCODE_UA_RE.exec(ua || "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// Normalize any resolved id into opencode's official 26-char identifier format
// (stable per-conversation: the seed is hashed deterministically, while ids
// already in official format — e.g. from a downstream opencode client — pass
// through unchanged).
function toOpencodeSession(id) {
  const value = String(id || "");
  if (isOfficialId(value)) return value;
  const stripped = value.replace(/^ses_/, "");
  if (!stripped) return null;
  const h = crypto.createHash("sha256").update(stripped).digest();
  const time = h.subarray(0, 6).toString("hex");
  const rand = Array.from(h.subarray(6, 20), (b) => ID_CHARS[b % 62]).join("");
  return `ses_${time}${rand}`;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

// Models served by /zen/v1/responses declare targetFormat:"openai-responses" in
// the registry — the same source the translator uses, so URL routing and body
// format can never drift apart. Models the registry doesn't declare fall back
// to the live api.json catalog (same metadata the official CLI reads), which
// picks up newly released responses-only models without a code change.
function isResponsesModel(model) {
  const base = baseModelId(model);
  // muse-spark family is always served by /zen/v1/responses (upstream pattern
  // check catches future releases even before the registry/catalog knows them).
  if (isMuseSparkModel(base)) return true;
  ensureOpencodeCatalog();
  const declared = getModelTargetFormat(PROVIDER_ID_TO_ALIAS.opencode, base);
  if (declared) return declared === "openai-responses";
  return isResponsesServed(base);

}

function resolveOpencodeSession(body, credentials) {
  return toOpencodeSession(resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  }));
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// The free tier requires the request to carry the coding-agent tool surface —
// verified empirically: a body whose `tools` array does not contain function
// tools named "bash" AND "read" is rejected with 403 FreeTierError, regardless
// of every other header (the official client always sends its 11 coding tools,
// and injects a `_noop` tool itself when a session has none — same pattern).
// Tool-calling clients that already send bash/read pass through untouched;
// everyone else gets invisible no-op stubs so the model has nothing to call.
const REQUIRED_TOOL_NAMES = ["bash", "read"];
const NOOP_TOOL_DESCRIPTION =
  "Do not call this tool. It exists only for API compatibility and must never be invoked.";

// Both upstream formats gate on the same tool surface, but spell tools
// differently: Chat Completions nests them under `function`, the Responses API
// uses the flat {type, name, description, parameters} shape. Verified live on
// muse-spark via /zen/v1/responses: no tools → 403, flat bash+read → streams.
function toolName(tool) {
  return tool?.name || tool?.function?.name;
}

function noopTool(name, flat) {
  const fn = { name, description: NOOP_TOOL_DESCRIPTION, parameters: { type: "object", properties: {}, additionalProperties: false } };
  return flat ? { type: "function", ...fn } : { type: "function", function: fn };
}

function ensureAgentToolSurface(body, flat = false) {
  if (!Array.isArray(body.tools)) body.tools = [];
  const present = new Set(body.tools.map(toolName).filter(Boolean));
  for (const name of REQUIRED_TOOL_NAMES) {
    if (!present.has(name)) body.tools.push(noopTool(name, flat));
  }
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);
    // zen's free tier is stream-only — a body carrying stream:false gets the
    // same 403 FreeTierError as a bad fingerprint, even with valid headers.
    // chatCore's nonStreamingHandler aggregates the SSE for non-stream clients.
    body.stream = true;
    const responsesModel = isResponsesModel(model);
    ensureAgentToolSurface(body, responsesModel);
    if (responsesModel) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/zen/v1/responses`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    // zen fingerprints the official CLI via UA: downstream opencode clients
    // pass theirs through; everyone else is cloaked with the live CLI UA
    // (version resolved from npm in opencodeCatalog, no stale hardcode). The
    // free tier only accepts currently-released versions, so a downstream
    // opencode UA is kept only when its version is at least our resolved
    // latest — a stale one is cloaked too instead of relayed into a 403.
    const downstreamUa = lower["user-agent"] || "";
    const cliUa = getOpencodeCliUserAgent();
    const downstreamVersion = uaVersion(downstreamUa);
    const cliVersion = uaVersion(cliUa);
    const keepDownstreamUa = downstreamVersion && cliVersion && versionAtLeast(downstreamVersion, cliVersion);
    const userAgent = keepDownstreamUa ? downstreamUa : cliUa;

    // Same reasoning for the id headers: only relay downstream values that
    // already satisfy the official identifier format — anything else (random
    // junk from other clients) would fail zen's format validation.
    const downstreamSession = isOfficialId(lower["x-opencode-session"]) ? lower["x-opencode-session"] : null;
    const downstreamRequest = isOfficialId(lower["x-opencode-request"]) ? lower["x-opencode-request"] : null;
    const downstreamClient = lower["x-opencode-client"] || "";

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": userAgent,
      "x-opencode-client": KNOWN_CLIENTS.has(downstreamClient) ? downstreamClient : "cli",
      "x-opencode-session": downstreamSession || this._currentSessionId || generateSessionId(),
      "x-opencode-request": downstreamRequest || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
  }
}
