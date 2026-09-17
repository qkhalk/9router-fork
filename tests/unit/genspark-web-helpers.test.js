// Comprehensive unit tests for the genspark-web provider (ask_proxy / ai_chat flow).
//
// Covers:
//   1. Provider registration in the WEB_COOKIE_PROVIDERS map (parallel to
//      gemini-web-provider-registration.test.js).
//   2. Cookie header normalization (bare session_id vs full session_id=abc).
//   3. Message transformation (developer→system, deep-seek-r1 system→user,
//      empty content filtering, multipart content preservation).
//   4. Chat request body construction (ai_chat shape: ai_chat_model, search
//      flag, per-message ids, session_state mirror, user_s_input, deepseek rename).
//   5. Field event classification (answer = field_name "content" → delta /
//      field_value; encrypted reasoning dropped).
//   6. Error signature classification (rate-limit / free-limit / not-login
//      "bad request cf" / Cloudflare / server-error / service-unavailable).
//   7. Image model detection → honest 400 (no image flow on the current API).

import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  buildCookieHeader,
  transformMessages,
  buildChatRequestBody,
  classifyFieldEvent,
  classifyError,
} from "../../open-sse/executors/genspark-web.js";
import {
  getGensparkTextModels,
  isGensparkImageModel,
  getGensparkSuggestedModels,
  getGensparkCatalogSnapshot,
} from "../../open-sse/providers/gensparkCatalog.js";

// Replicate the WEB_COOKIE_PROVIDERS filter from src/shared/constants/providers.js
// locally so the test doesn't depend on the broken `open-sse/providers/registry/index.js`
// package-subpath import (vitest doesn't resolve it; the gemini-web-provider-registration
// test has the same pre-existing failure). The filter logic is identical — category="webCookie".
const WEB_COOKIE_PROVIDERS = Object.fromEntries(
  REGISTRY.filter((r) => r.category === "webCookie").map((r) => {
    const display = { ...(r.display || {}) };
    return [r.id, { ...display, id: r.id, alias: r.uiAlias || r.alias, authType: r.authType, authHint: r.authHint, passthroughModels: r.passthroughModels }];
  }),
);

// ─── 1. Provider registration ──────────────────────────────────────────────

describe("genspark-web provider registration", () => {
  it("is registered in WEB_COOKIE_PROVIDERS", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"]).toBeDefined();
  });

  it("has correct id", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].id).toBe("genspark-web");
  });

  it("has correct display name", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].name).toBe("Genspark Web (Subscription)");
  });

  it("has uiAlias", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].alias).toBe("gspark");
  });

  it("has cookie authType", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].authType).toBe("cookie");
  });

  it("has authHint", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].authHint).toBeTruthy();
    expect(typeof WEB_COOKIE_PROVIDERS["genspark-web"].authHint).toBe("string");
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].authHint).toContain("session_id");
  });

  it("has passthroughModels enabled", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].passthroughModels).toBe(true);
  });

  it("has website URL", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].website).toBe("https://www.genspark.ai");
  });

  it("has textIcon fallback", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].textIcon).toBe("GS");
  });

  it("has color", () => {
    expect(WEB_COOKIE_PROVIDERS["genspark-web"].color).toBe("#FF6B35");
  });

  it("ships no hardcoded model list — discovery is live via modelsFetcher", () => {
    const raw = REGISTRY.find((r) => r.id === "genspark-web");
    expect(raw.models).toBeUndefined();
    expect(raw.modelsFetcher).toMatchObject({ type: "genspark-web" });
    expect(raw.modelsFetcher.url).toContain("moa_models_config");
  });
});

// ─── 2. Cookie header normalization ────────────────────────────────────────

describe("buildCookieHeader", () => {
  it("wraps a bare session id in session_id=", () => {
    expect(buildCookieHeader({ apiKey: "abc123" })).toBe("session_id=abc123");
  });

  it("preserves a full session_id=... string", () => {
    expect(buildCookieHeader({ apiKey: "session_id=abc123" })).toBe("session_id=abc123");
  });

  it("prefers apiKey over accessToken", () => {
    expect(buildCookieHeader({ apiKey: "from-apikey", accessToken: "from-token" })).toBe("session_id=from-apikey");
  });

  it("falls back to accessToken when apiKey is missing", () => {
    expect(buildCookieHeader({ accessToken: "from-token" })).toBe("session_id=from-token");
  });

  it("trims whitespace", () => {
    expect(buildCookieHeader({ apiKey: "  abc123  " })).toBe("session_id=abc123");
  });

  it("returns empty string when no credentials", () => {
    expect(buildCookieHeader({})).toBe("");
    expect(buildCookieHeader(null)).toBe("");
    expect(buildCookieHeader(undefined)).toBe("");
  });

  it("serializes a full chrome-json cookie jar (incl. __cf_bm, c1/c2, gslogin)", () => {
    const jar = [
      { name: "session_id", value: "sess-xyz", domain: "www.genspark.ai" },
      { name: "__cf_bm", value: "cf-token-123", domain: ".genspark.ai" },
      { name: "c1", value: "c1-val", domain: "www.genspark.ai" },
      { name: "c2", value: "c2-val", domain: "www.genspark.ai" },
      { name: "gslogin", value: "1", domain: "www.genspark.ai" },
    ];
    const header = buildCookieHeader({ apiKey: JSON.stringify(jar) });
    expect(header).toContain("session_id=sess-xyz");
    expect(header).toContain("__cf_bm=cf-token-123");
    expect(header).toContain("c1=c1-val");
    expect(header).toContain("c2=c2-val");
    expect(header).toContain("gslogin=1");
    // No commas inside the header (pairs joined by "; ")
    expect(header.includes(",")).toBe(false);
  });

  it("prefers providerSpecificData.cookies over the raw apiKey jar", () => {
    const header = buildCookieHeader({
      apiKey: "session_id=old",
      providerSpecificData: {
        cookies: { session_id: "new-sess", __cf_bm: "cf" },
      },
    });
    expect(header).toBe("session_id=new-sess; __cf_bm=cf");
  });

  it("drops cookies from non-genspark.ai domains", () => {
    const jar = [
      { name: "session_id", value: "sess", domain: "www.genspark.ai" },
      { name: "evil", value: "leak", domain: "google.com" },
    ];
    const header = buildCookieHeader({ apiKey: JSON.stringify(jar) });
    expect(header).toContain("session_id=sess");
    expect(header).not.toContain("evil");
  });
});

// ─── 3. Message transformation ─────────────────────────────────────────────

describe("transformMessages", () => {
  it("passes through standard OpenAI messages", () => {
    const input = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "Bye" },
    ];
    const out = transformMessages(input, "gpt-5-pro");
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(out[3]).toEqual({ role: "user", content: "Bye" });
  });

  it("converts developer role to system", () => {
    const out = transformMessages([{ role: "developer", content: "instructions" }], "gpt-5-pro");
    expect(out[0].role).toBe("system");
  });

  it("demotes system to user for deep-seek-r1 (DeepSeek rejects system messages)", () => {
    const out = transformMessages(
      [{ role: "system", content: "be concise" }, { role: "user", content: "hi" }],
      "deep-seek-r1",
    );
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("user");
  });

  it("preserves system role for non-deep-seek models", () => {
    const out = transformMessages(
      [{ role: "system", content: "be concise" }, { role: "user", content: "hi" }],
      "claude-sonnet-4-5",
    );
    expect(out[0].role).toBe("system");
  });

  it("filters out messages with empty string content", () => {
    const out = transformMessages(
      [{ role: "user", content: "" }, { role: "user", content: "   " }, { role: "user", content: "real" }],
      "gpt-5-pro",
    );
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("real");
  });

  it("preserves multipart content arrays (image_url + text)", () => {
    const content = [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ];
    const out = transformMessages([{ role: "user", content }], "gpt-5-pro");
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual(content);
  });

  it("filters out empty text parts inside multipart content", () => {
    const content = [
      { type: "text", text: "" },
      { type: "text", text: "real text" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    ];
    const out = transformMessages([{ role: "user", content }], "gpt-5-pro");
    expect(out[0].content).toHaveLength(2);
    expect(out[0].content[0].text).toBe("real text");
  });

  it("treats null content as empty (filtered out)", () => {
    const out = transformMessages([{ role: "user", content: null }], "gpt-5-pro");
    expect(out).toHaveLength(0);
  });

  it("defaults missing role to user", () => {
    const out = transformMessages([{ content: "hi" }], "gpt-5-pro");
    expect(out[0].role).toBe("user");
  });

  it("handles an empty messages array", () => {
    expect(transformMessages([], "gpt-5-pro")).toEqual([]);
    expect(transformMessages(null, "gpt-5-pro")).toEqual([]);
    expect(transformMessages(undefined, "gpt-5-pro")).toEqual([]);
  });
});

// ─── 4. Chat request body construction (ai_chat / ask_proxy) ──────────────

describe("buildChatRequestBody", () => {
  it("builds an ai_chat body for a known text model", () => {
    const body = buildChatRequestBody("gpt-5-pro", [{ role: "user", content: "hi" }], false);
    expect(body.type).toBe("ai_chat");
    expect(body.ai_chat_model).toBe("gpt-5-pro");
    expect(body.ai_chat_enable_search).toBe(false);
    expect(body.ai_chat_disable_personalization).toBe(false);
    expect(body.use_moa_proxy).toBe(false);
    expect(body.moa_models).toEqual([]);
    expect(body.writingContent).toBeNull();
    expect(body.project_id).toBeNull();
    expect(body.g_recaptcha_token).toBe("");
    expect(body.is_private).toBe(true);
    expect(body.push_token).toBe("");
    expect(body.session_state.steps).toEqual([]);
  });

  it("does not split on TEXT_MODEL_LIST membership — genspark routes any id via MOA", () => {
    const known = buildChatRequestBody("gpt-5-pro", [{ role: "user", content: "hi" }], false);
    const unknown = buildChatRequestBody("some-custom-model", [{ role: "user", content: "hi" }], false);
    expect(known.ai_chat_model).toBe("gpt-5-pro");
    expect(unknown.ai_chat_model).toBe("some-custom-model");
  });

  it("gives each message an id and mirrors them into session_state.messages / messages", () => {
    const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
    const body = buildChatRequestBody("gpt-5-pro", msgs, false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(body.messages[0].id).toBeTruthy();
    expect(body.messages[1]).toMatchObject({ role: "assistant", content: "yo" });
    expect(body.messages[1].id).toBeTruthy();
    expect(body.session_state.messages).toEqual(body.messages);
  });

  it("preserves an existing message id", () => {
    const body = buildChatRequestBody("gpt-5-pro", [{ role: "user", id: "keep-me", content: "hi" }], false);
    expect(body.messages[0].id).toBe("keep-me");
  });

  it("sets user_s_input to the last user turn text", () => {
    const body = buildChatRequestBody("gpt-5-pro", [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ], false);
    expect(body.user_s_input).toBe("second");
  });

  it("strips -search suffix and sets ai_chat_enable_search=true for search mode", () => {
    const body = buildChatRequestBody("gpt-5-pro-search", [{ role: "user", content: "hi" }], true);
    expect(body.ai_chat_model).toBe("gpt-5-pro");
    expect(body.ai_chat_enable_search).toBe(true);
  });

  it("renames deepseek → deep-seek in ai_chat_model", () => {
    const body = buildChatRequestBody("deepseek-v3", [{ role: "user", content: "hi" }], false);
    expect(body.ai_chat_model).toBe("deep-seek-v3");
  });

  it("renames deepseek → deep-seek with -search suffix", () => {
    const body = buildChatRequestBody("deepseek-v3-search", [{ role: "user", content: "hi" }], true);
    expect(body.ai_chat_model).toBe("deep-seek-v3");
    expect(body.ai_chat_enable_search).toBe(true);
  });

  it("every fallback catalog id round-trips as its own ai_chat_model", () => {
    for (const model of getGensparkTextModels()) {
      const body = buildChatRequestBody(model, [{ role: "user", content: "hi" }], false);
      expect(body.ai_chat_model).toBe(model);
    }
  });
});

// ─── 5. Field event classification ─────────────────────────────────────────

describe("classifyFieldEvent", () => {
  it("classifies message_field_delta content as answer delta", () => {
    const result = classifyFieldEvent(
      { type: "message_field_delta", field_name: "content", delta: "Hello" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "Hello" });
  });

  it("classifies message_field content using field_value", () => {
    const result = classifyFieldEvent(
      { type: "message_field", field_name: "content", field_value: "full answer" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "full answer" });
  });

  it("prefers delta over field_value when both present", () => {
    const result = classifyFieldEvent(
      { type: "message_field_delta", field_name: "content", field_value: "full", delta: "inc" },
      "gpt-5-pro", false, false,
    );
    expect(result).toEqual({ kind: "answer", delta: "inc" });
  });

  it("returns null for empty content delta", () => {
    expect(classifyFieldEvent(
      { type: "message_field_delta", field_name: "content", delta: "" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("drops encrypted reasoning fields regardless of hideReasoning", () => {
    expect(classifyFieldEvent(
      { type: "message_field", field_name: "reasoning_id", field_value: "rid" },
      "gpt-5-pro", false, false,
    )).toBeNull();
    expect(classifyFieldEvent(
      { type: "message_field", field_name: "reasoning_encrypted_content", delta: "xyz" },
      "gpt-5-pro", false, true,
    )).toBeNull();
  });

  it("returns null for other known field names (steps, markmap, …)", () => {
    expect(classifyFieldEvent(
      { type: "message_field", field_name: "steps", field_value: "[]" },
      "gpt-5-pro", false, false,
    )).toBeNull();
    expect(classifyFieldEvent(
      { type: "message_field_delta", field_name: "session_state.answer", delta: "x" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("returns null for unknown field names", () => {
    expect(classifyFieldEvent(
      { type: "message_field", field_name: "session_state.unknown_field", delta: "x" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("returns null when field_name is missing", () => {
    expect(classifyFieldEvent(
      { type: "message_field_delta", delta: "x" },
      "gpt-5-pro", false, false,
    )).toBeNull();
  });

  it("answer still streams when hideReasoning=true", () => {
    const result = classifyFieldEvent(
      { type: "message_field_delta", field_name: "content", delta: "Hello" },
      "gpt-5-pro", false, true,
    );
    expect(result).toEqual({ kind: "answer", delta: "Hello" });
  });
});

// ─── 6. Error signature classification ─────────────────────────────────────

describe("classifyError", () => {
  it("detects rate limit cf1", () => {
    expect(classifyError("Rate limit exceeded cf1")).toBe("rate_limit");
  });

  it("detects rate limit cf2", () => {
    expect(classifyError("Rate limit exceeded cf2")).toBe("rate_limit");
  });

  it("detects not-login via bare 'bad request cf' (ask_proxy not-logged-in signal)", () => {
    expect(classifyError("bad request cf")).toBe("not_login");
  });

  it("detects not-login embedded in a streamed body", () => {
    expect(classifyError('{"message":"bad request cf","type":"error"}')).toBe("not_login");
  });

  it("detects not-login via legacy copilot JSON", () => {
    expect(classifyError('{"status":-5,"message":"not login","data":{}}')).toBe("not_login");
  });

  it("detects internal server error", () => {
    expect(classifyError("Internal Server Error")).toBe("server_error");
  });

  it("detects free usage limit", () => {
    const body = `data: {"content":"You've reached your free usage limit today","type":"message_result"}`;
    expect(classifyError(body)).toBe("free_limit");
  });

  it("detects server overloaded", () => {
    const body = `data: {"content":"Server overloaded, please try again later.","type":"message_result"}`;
    expect(classifyError(body)).toBe("service_unavailable");
  });

  it("detects Cloudflare challenge page", () => {
    const body = '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>';
    expect(classifyError(body)).toBe("cloudflare");
  });

  it("detects Cloudflare challenge-platform CDN path", () => {
    const body = '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>';
    expect(classifyError(body)).toBe("cloudflare");
  });

  it("returns null for a normal SSE frame", () => {
    expect(classifyError('data: {"type":"project_start","id":"abc"}')).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(classifyError("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(classifyError(null)).toBeNull();
    expect(classifyError(undefined)).toBeNull();
    expect(classifyError(123)).toBeNull();
    expect(classifyError({})).toBeNull();
  });
});

// ─── 7. Model catalogue (live catalog + verbatim passthrough) ──────────────

describe("model catalogue", () => {
  it("fallback set still contains the classic lineup before any sync", () => {
    const models = getGensparkTextModels();
    for (const id of ["gpt-5-pro", "claude-sonnet-4-6", "gemini-3-pro-preview", "grok-4-0709"]) {
      expect(models.has(id)).toBe(true);
    }
  });

  it("detects image ids for the honest 400 path (fallback set)", () => {
    for (const id of ["nano-banana-pro", "nano-banana-2", "fal-ai/flux-2", "recraft-v3", "qwen-image"]) {
      expect(isGensparkImageModel(id)).toBe(true);
    }
    expect(isGensparkImageModel("claude-sonnet-4-6")).toBe(false);
    expect(isGensparkImageModel("auto")).toBe(false);
  });

  it("forwards arbitrary ids verbatim as ai_chat_model (no list gating)", () => {
    for (const id of ["glm-5p3", "gpt-5.6-luna,claude-sonnet-5,gemini-3.7-flash", "brand-new-model-xyz"]) {
      const body = buildChatRequestBody(id, [{ role: "user", content: "hi" }], false);
      expect(body.ai_chat_model).toBe(id);
    }
  });

  it("suggested list shapes selector entries and drops hidden/auto", () => {
    const suggestions = getGensparkSuggestedModels();
    // Before first sync the suggestion list is empty (fail-open); after a sync
    // it must be shaped {id, name} with no hidden entries. Either way the
    // shape contract holds.
    for (const s of suggestions) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(s.id).not.toBe("auto");
    }
    expect(getGensparkCatalogSnapshot()).toHaveProperty("synced");
  });
});

