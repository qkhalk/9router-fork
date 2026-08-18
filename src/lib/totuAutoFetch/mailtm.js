// mail.tm temp-inbox adapter used by the TOTU AI account auto-fetch feature.
//
// mail.tm API (https://docs.mail.tm): create a disposable mailbox, poll its
// inbox, and extract a verification code. Fail-open: every function here
// returns null / empty results rather than throwing so a transient mail.tm
// outage never aborts a fetch batch.

const MAIL_TM_API_BASE = "https://api.mail.tm";

const POLL_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonOrNull(res) {
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// GET /domains — active domains mail.tm will accept for new mailboxes.
// Returns an array of { domain, isActive, _id }. Fail-open: [] on error.
export async function listDomains({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${MAIL_TM_API_BASE}/domains`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const json = await jsonOrNull(res);
    if (!Array.isArray(json)) return [];
    return json;
  } catch {
    return [];
  }
}

// POST /accounts { address, password } -> { id, address, ... }
export async function createMailbox({
  address,
  password,
  fetchImpl = globalThis.fetch,
}) {
  const res = await fetchImpl(`${MAIL_TM_API_BASE}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password }),
  });
  if (!res.ok) return null;
  const json = await jsonOrNull(res);
  if (!json?.id || !json?.address) return null;
  return { id: json.id, address: json.address, password };
}

// POST /token { address, password } -> { token } (Bearer for /messages)
export async function getMailTmToken(
  mailbox,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (!mailbox?.address || !mailbox?.password) return null;
  const res = await fetchImpl(`${MAIL_TM_API_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: mailbox.address,
      password: mailbox.password,
    }),
  });
  if (!res.ok) return null;
  const json = await jsonOrNull(res);
  return json?.token || json?.access_token || null;
}

// GET /messages (Bearer) -> { hydra:member: [...] }
export async function listMessages(
  token,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (!token) return [];
  const res = await fetchImpl(`${MAIL_TM_API_BASE}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = await jsonOrNull(res);
  const rows = json?.["hydra:member"] || json?.member || json?.messages;
  if (!Array.isArray(rows)) return [];
  return rows.map((m) => ({ id: m.id, subject: m.subject || "" }));
}

// GET /messages/{id} (Bearer) -> { subject, text, html, ... }
export async function getMessage(
  token,
  id,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (!token || !id) return null;
  const res = await fetchImpl(`${MAIL_TM_API_BASE}/messages/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await jsonOrNull(res);
}

// NewAPI OTP is 6-char alphanumeric (e.g. "8e1b0c"). Match per-block with a
// word-boundary regex and prefer values found in the subject (mail.tm truncates
// long subjects) or plain-text body over the raw HTML dump.
const OTP_RE = /\b([A-Za-z0-9]{6})\b/g;

export function extractVerificationCode(message) {
  if (!message) return null;

  const html = typeof message.html === "string" ? message.html : "";
  const text = typeof message.text === "string" ? message.text : "";
  const subject = typeof message.subject === "string" ? message.subject : "";

  if (subject) {
    const m = subject.match(OTP_RE);
    if (m) return m[0];
  }
  if (text) {
    const m = text.match(OTP_RE);
    if (m) return m[0];
  }
  // HTML often wraps the code in tags or entities; strip tags first so the
  // word-boundary match still finds it.
  const strippedHtml = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
  if (strippedHtml) {
    const m = strippedHtml.match(OTP_RE);
    if (m) return m[0];
  }
  return null;
}

// Poll for a NewAPI verification email until the timeout, returning the code.
// Returns null on timeout (never throws).
export async function waitForVerificationCode(
  mailbox,
  { timeoutMs = 90000, pollMs = 5000, fetchImpl = globalThis.fetch } = {}
) {
  const started = Date.now();
  let token = null;

  while (Date.now() - started < timeoutMs) {
    try {
      if (!token) {
        token = await getMailTmToken(mailbox, { fetchImpl });
      }
      const messages = await listMessages(token, { fetchImpl });
      // mail.tm lists newest first; bail early on the first that yields a code.
      for (const msg of messages) {
        const full = await getMessage(token, msg.id, { fetchImpl });
        const code = extractVerificationCode(full);
        if (code) return { code, messageId: msg.id };
      }
    } catch {
      // Transient failure — retry on the next poll cycle.
    }
    await sleep(pollMs);
  }

  return null;
}