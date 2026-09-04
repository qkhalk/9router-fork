// TOTU AI account auto-fetch ("Lấy acc"): create disposable mail.tm mailboxes,
// register fresh TOTU accounts, mint an API token, and save each as a 9router
// provider connection. Runs either once (API route) or on a schedule.

import { getSettings, getProviderConnections, createProviderConnection } from "@/lib/localDb";
import { createMailbox, getMailTmToken, listDomains, waitForVerificationCode } from "./mailtm.js";
import {
  login,
  requestVerification,
  register,
  createTokenAndGetKey,
} from "./newapi.js";

const TOTU_BASE_URL = process.env.TOTU_API_BASE_URL || "https://totu-ai.com";
const DEFAULT_MAX_ACCOUNTS = 3;

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomString(length) {
  let out = "";
  const bytes = new Uint32Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 0x100000000);
  }
  for (let i = 0; i < length; i += 1) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

function makeCredentials() {
  // username: "u" + base36(timestamp + jitter), short enough for NewAPI.
  const username = `u${(Date.now() + Math.floor(Math.random() * 1000)).toString(36)}`;
  const password = randomString(16);
  return { username, password };
}

// Known-good mail.tm domain used only when the live domain list can't be
// fetched (fail-open fallback). The active list rotates, so this is a last
// resort, never the primary source.
const FALLBACK_MAIL_TM_DOMAIN = "emalupe.com";

// Fetch the live mail.tm domain list and pick the first active domain, falling
// back to FALLBACK_MAIL_TM_DOMAIN when the query fails or returns nothing.
async function resolveMailTmDomain(fetchImpl) {
  try {
    const domains = await listDomains({ fetchImpl });
    const active = (Array.isArray(domains) ? domains : []).find((d) => d && d.isActive && d.domain);
    if (active?.domain) return active.domain;
  } catch {
    // fall through to the fallback
  }
  return FALLBACK_MAIL_TM_DOMAIN;
}

function makeMailboxAddress(domain) {
  const local = `tu${(Date.now() + Math.floor(Math.random() * 10000)).toString(36)}${randomString(6)}`;
  return `${local}@${domain}`;
}

// One explicit entry point: fetch the domain, then compose the address.
async function fetchMailboxAddress(fetchImpl) {
  const domain = await resolveMailTmDomain(fetchImpl);
  return makeMailboxAddress(domain);
}

function getErrorText(error) {
  if (!error) return "unknown error";
  return typeof error === "string" ? error : error.message || "unknown error";
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    createProviderConnection,
  };
}

// Fetch one account end-to-end. Returns the new connection or null. Never
// throws — the caller records failures per-account.
async function fetchOneAccount(deps) {
  const base = deps.baseUrl || TOTU_BASE_URL;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  // 1. Disposable mailbox — address domain comes from the live mail.tm list.
  const creds = makeCredentials();
  const mailboxAddress = await fetchMailboxAddress(fetchImpl);
  const mailbox = await createMailbox({
    address: mailboxAddress,
    password: randomString(16),
    fetchImpl,
  });
  if (!mailbox) {
    throw new Error("Failed to create mail.tm mailbox");
  }
  const mailToken = await getMailTmToken(mailbox, { fetchImpl });
  if (!mailToken) {
    throw new Error("Failed to obtain mail.tm access token");
  }

  // 2. Ask TOTU to send the email OTP
  await requestVerification(base, mailbox.address, { fetchImpl });

  // 3. Poll the inbox for the code
  const codeResult = await waitForVerificationCode(mailbox, {
    timeoutMs: deps.codeTimeoutMs ?? 90000,
    pollMs: deps.codePollMs ?? 5000,
    fetchImpl,
  });
  if (!codeResult) {
    throw new Error("Timed out waiting for TOTU verification email");
  }

  // 4. Register
  await register(
    base,
    {
      username: creds.username,
      password: creds.password,
      email: mailbox.address,
      verification_code: codeResult.code,
    },
    { fetchImpl }
  );

  // 5. Login — capture the session token (what queries balance).
  const sessionToken = await login(base, creds.username, creds.password, { fetchImpl });

  // 6. Create a token, locate its id, fetch the plaintext sk- key.
  const tokenName = `9router ${creds.username}`;
  const { id: tokenId, key: skKey } = await createTokenAndGetKey(base, sessionToken, tokenName, {
    fetchImpl,
  });

  // 7. Dedup: skip if this email is already a TOTU connection.
  const existing = await deps.getProviderConnections({ provider: "totu-ai" });
  const emailExists = existing.some((c) => c.email === mailbox.address);
  if (emailExists) {
    return { skipped: true, email: mailbox.address };
  }

  // 8. Save as a 9router provider connection.
  await deps.createProviderConnection({
    provider: "totu-ai",
    authType: "apikey",
    name: `TOTU ${creds.username}`,
    email: mailbox.address,
    apiKey: skKey,
    testStatus: "active",
    isActive: true,
    providerSpecificData: {
      loginToken: sessionToken,
      totuUsername: creds.username,
      totuTokenId: tokenId,
    },
  });

  return {
    email: mailbox.address,
    username: creds.username,
    tokenId,
  };
}

export async function runTotuFetchOnce(deps = createDefaultDeps(), { maxAccounts = DEFAULT_MAX_ACCOUNTS } = {}) {
  const result = { added: 0, failed: 0, skipped: 0, errors: [] };
  const batchSize = Math.max(1, Math.floor(maxAccounts));
  if (!deps?.getProviderConnections || !deps?.createProviderConnection) {
    result.errors.push({ email: "(batch)", error: "Missing DB deps" });
    result.failed = batchSize;
    return result;
  }

  for (let i = 0; i < batchSize; i += 1) {
    try {
      const outcome = await fetchOneAccount(deps);
      if (outcome?.skipped) {
        result.skipped += 1;
      } else {
        result.added += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push({ email: "(account)", error: getErrorText(error) });
    }
  }

  return result;
}

// ─── Scheduler (quotaAutoPing pattern) ───────────────────────────────────────

// Survive Next.js hot reload: one interval + running flag per server process.
const g = (global.__totuAutoFetch ??= {
  interval: null,
  running: false,
});

export async function runTotuAutoFetchTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();
    if (settings.totuAutoFetch !== true) return;
    const intervalMin = settings.totuAutoFetchIntervalMin ?? 60;
    await runTotuFetchOnce(deps, { maxAccounts: intervalMin >= 5 ? 3 : 1 });
    console.log("[TotuAutoFetch] scheduled fetch completed");
  } catch (error) {
    console.warn("[TotuAutoFetch] tick error:", getErrorText(error));
  } finally {
    state.running = false;
  }
}

export function startTotuAutoFetch(intervalMin = 60) {
  const n = Number(intervalMin);
  // 0 / negative = manual-only mode (X8/N6): the scheduler must NEVER run —
  // not even a clamped minimum interval.
  if (!Number.isFinite(n) || n <= 0) {
    stopTotuAutoFetch();
    return;
  }
  if (g.interval) clearInterval(g.interval);
  const ms = Math.max(5, Math.floor(n)) * 60_000;
  g.interval = setInterval(() => {
    runTotuAutoFetchTick().catch(() => {});
  }, ms);
  if (g.interval.unref) g.interval.unref();
  console.log(`[TotuAutoFetch] scheduler started (every ${ms / 60_000} min)`);
}

export function stopTotuAutoFetch() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[TotuAutoFetch] scheduler stopped");
}

export function configureTotuAutoFetch(settings) {
  if (settings?.totuAutoFetch !== true) {
    stopTotuAutoFetch();
    return;
  }
  // Explicit 0 = manual-only (stop the timer); null/undefined falls back to 60.
  const raw = Number(settings.totuAutoFetchIntervalMin);
  if (Number.isFinite(raw) && raw <= 0) {
    stopTotuAutoFetch();
    return;
  }
  startTotuAutoFetch(Number.isFinite(raw) ? raw : 60);
}