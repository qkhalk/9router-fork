// Minimal NewAPI (OneAPI-family) HTTP client for the TOTU AI account auto-fetch.
//
// Handles the exact endpoints the TOTU register flow touches:
//   GET  /api/verification?email=...  -> sends an email OTP
//   POST /api/user/register           -> creates the account
//   POST /api/user/login              -> returns a session token
//   POST /api/token/                  -> creates a token (returns success, NOT the key)
//   GET  /api/token/?p=1&size=100     -> list tokens to find the created id
//   POST /api/token/:id/key           -> returns the plaintext sk- key
//   GET  /api/user/self               -> current user quota/balance info

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared request helper. Throws on !res.ok or json.success === false.
// When a `token` is provided it is sent as `Authorization: Bearer <token>`.
export async function req(
  base,
  path,
  { method = "GET", body, token, headers = {}, fetchImpl = globalThis.fetch } = {}
) {
  const url = `${base}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok || (json && json.success === false)) {
    const message = json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return { res, json: json || {} };
}

// NewAPI login response shapes vary between deployments. Try the observed
// TOTU shape first (data.access_token), then the common OneAPI/NewAPI fallbacks.
export function extractAccessToken(json, headers) {
  const candidates = [
    json?.data?.access_token,
    json?.data?.token,
    json?.data?.session,
    json?.access_token,
    json?.token,
    json?.session,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  // Last resort: session cookie from the Set-Cookie header.
  const setCookie = Array.isArray(headers)
    ? headers.join("\n")
    : typeof headers === "string"
      ? headers
      : headers?.get?.("set-cookie") || "";
  const m = setCookie.match(/session=([^;]+)/);
  return m ? m[1] : null;
}

export async function login(
  base,
  username,
  password,
  { fetchImpl = globalThis.fetch } = {}
) {
  const { res, json } = await req(base, "/api/user/login", {
    method: "POST",
    body: { username, password },
    fetchImpl,
  });
  const token = extractAccessToken(json, res?.headers);
  if (!token) {
    const err = new Error("Login succeeded but no access token in response");
    err.status = 500;
    throw err;
  }
  return token;
}

// GET /api/verification?email=... — no token needed.
export async function requestVerification(
  base,
  email,
  { fetchImpl = globalThis.fetch } = {}
) {
  await req(base, `/api/verification?email=${encodeURIComponent(email)}`, {
    fetchImpl,
  });
}

// POST /api/user/register
export async function register(
  base,
  user,
  { fetchImpl = globalThis.fetch } = {}
) {
  const { json } = await req(base, "/api/user/register", {
    method: "POST",
    body: {
      username: user.username,
      password: user.password,
      email: user.email,
      verification_code: user.verification_code,
      ...(user.aff_code ? { aff_code: user.aff_code } : {}),
    },
    fetchImpl,
  });
  return json;
}

// POST /api/token/ — creates a token but does NOT return its key.
export async function createToken(
  base,
  loginToken,
  name,
  { fetchImpl = globalThis.fetch } = {}
) {
  const { json } = await req(base, "/api/token/", {
    method: "POST",
    token: loginToken,
    body: {
      name,
      unlimited_quota: true,
      expired_time: -1,
      remain_quota: -1,
      model_limit_enabled: false,
      model_limit: 0,
    },
    fetchImpl,
  });
  return json;
}

// GET /api/token/?p=1&size=100 — list tokens to find one by name.
export async function listTokens(
  base,
  loginToken,
  { fetchImpl = globalThis.fetch } = {}
) {
  const { json } = await req(base, "/api/token/?p=1&size=100", {
    token: loginToken,
    fetchImpl,
  });
  const items = json?.data || json?.items || [];
  return Array.isArray(items) ? items : [];
}

// POST /api/token/:id/key — returns { success: true, data: "sk-..." }.
export async function getTokenKey(
  base,
  loginToken,
  tokenId,
  { fetchImpl = globalThis.fetch } = {}
) {
  const { json } = await req(base, `/api/token/${encodeURIComponent(tokenId)}/key`, {
    method: "POST",
    token: loginToken,
    fetchImpl,
  });
  return typeof json?.data === "string" ? json.data : null;
}

// GET /api/user/self — current user quota/balance.
export async function getSelf(
  base,
  loginToken,
  { fetchImpl = globalThis.fetch } = {}
) {
  const { json } = await req(base, "/api/user/self", {
    token: loginToken,
    fetchImpl,
  });
  return json?.data || json;
}

// Create a token, locate its id by name in the list, then fetch the key.
// Returns { id, key } or throws.
export async function createTokenAndGetKey(
  base,
  loginToken,
  name,
  { fetchImpl = globalThis.fetch } = {}
) {
  await createToken(base, loginToken, name, { fetchImpl });

  // NewAPI can take a moment to reflect the new token in the list.
  let token = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tokens = await listTokens(base, loginToken, { fetchImpl });
    token = tokens.find((t) => t?.name === name) || null;
    if (token?.id) break;
    await sleep(1000);
  }
  if (!token?.id) {
    const err = new Error(`Created token "${name}" not found in token list`);
    err.status = 404;
    throw err;
  }

  const key = await getTokenKey(base, loginToken, token.id, { fetchImpl });
  if (!key) {
    const err = new Error(`Token key fetch returned no key for "${name}"`);
    err.status = 502;
    throw err;
  }
  return { id: token.id, key };
}