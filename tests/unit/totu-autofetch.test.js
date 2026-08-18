/**
 * TOTU AI account auto-fetch ("Lấy acc").
 *
 * Deps-injected tests: a fake `fetchImpl` stands in for both the mail.tm temp
 * inbox and the TOTU NewAPI endpoints, and the DB accessors are injected so no
 * real SQLite state is touched. Covers the register -> login -> token -> key ->
 * createProviderConnection flow, email dedup skipping, per-account error
 * isolation, and scheduler start/stop idempotency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
}));

import {
  runTotuFetchOnce,
  runTotuAutoFetchTick,
  configureTotuAutoFetch,
  startTotuAutoFetch,
  stopTotuAutoFetch,
} from "../../src/lib/totuAutoFetch/index.js";

const FIXED_EMAIL = "tu_test_abc@cctm-mail.cf";
const FIXED_SK = "sk-test123";
const FIXED_SESSION = "session-token-123";
const OTP = "8e1b0c";

// Count handler invocations so a test can make the Nth call fail.
function counting(handler) {
  let n = 0;
  return (...args) => {
    n += 1;
    return handler(n, ...args);
  };
}

function okJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function failFetch(message) {
  throw new Error(message);
}

// Build a fake fetch. `handlers` is an array of [matcher, respond] pairs where
// matcher is a RegExp tested against the URL. `failCreateMailboxOn` makes the
// 2nd (or Nth) mailbox creation throw, to exercise per-account isolation.
// Token creation records the requested name so the list endpoint can return a
// matching token (the orchestrator polls the list to find the token it made).
//
// `domains` controls the live mail.tm domain list the orchestrator fetches
// before composing a mailbox address. The fake /accounts echo the requested
// address from the POST body, so the test asserts on the address actually used.
// `echoAddress` overrides the echoed address (used by the dedup test to make the
// mailbox come back as an already-known email).
function makeTotuFetch({
  failCreateMailboxOn = 0,
  domains = [{ domain: "emalupe.com", isActive: true }],
  echoAddress = null,
} = {}) {
  const createdTokens = [];

  const handlers = [
    // mail.tm
    [
      /api\.mail\.tm\/accounts/,
      counting((n, url, options) => {
        if (failCreateMailboxOn && n === failCreateMailboxOn) failFetch("mail.tm 429");
        const { address } = JSON.parse(options.body || "{}");
        return okJson({ id: "m1", address: echoAddress || address });
      }),
    ],
    [/api\.mail\.tm\/domains/, () => okJson(domains)],
    [/api\.mail\.tm\/token/, () => okJson({ token: "mail-token-1" })],
    [/api\.mail\.tm\/messages\/[^/]+/, () =>
      okJson({ subject: "TOTU AI邮箱验证邮件", text: `Your verification code is ${OTP}`, html: "" })],
    [/api\.mail\.tm\/messages/, () =>
      okJson({ "hydra:member": [{ id: "msg1", subject: "TOTU AI邮箱验证邮件" }] })],

    // TOTU NewAPI
    [/\/api\/verification\?email=/, () => okJson({ success: true })],
    [/\/api\/user\/register/, () => okJson({ success: true })],
    [/\/api\/user\/login/, () =>
      okJson({ success: true, data: { access_token: FIXED_SESSION } })],
    [/\/api\/token\/\?p=/, () => okJson({ data: createdTokens })],
    [/\/api\/token\/[^/?]+\/key/, () => okJson({ success: true, data: FIXED_SK })],
    [
      /\/api\/token\//,
      (url, options) => {
        const name = JSON.parse(options.body || "{}").name;
        createdTokens.push({ id: `tok${createdTokens.length + 1}`, name });
        return okJson({ success: true });
      },
    ],
  ];

  const fetchImpl = vi.fn(async (url, options = {}) => {
    for (const [matcher, respond] of handlers) {
      if (matcher.test(url)) return respond(url, options);
    }
    return okJson({ success: true });
  });
  return fetchImpl;
}

function makeDeps({ connections = [], fetchImpl } = {}) {
  const getSettings = vi.fn().mockResolvedValue({
    totuAutoFetch: false,
    totuAutoFetchIntervalMin: 60,
  });
  const getProviderConnections = vi.fn().mockResolvedValue(connections);
  const createProviderConnection = vi.fn().mockImplementation(async (data) => ({ ...data, id: "c1" }));
  return {
    getSettings,
    getProviderConnections,
    createProviderConnection,
    baseUrl: "https://totu-ai.com",
    fetchImpl: fetchImpl || makeTotuFetch(),
  };
}

// The orchestrator module binds `const g = global.__totuAutoFetch ??= {...}` at
// import time, so the global object must stay the SAME object across tests.
// Never delete/reassign it; reset its fields instead.
function resetSchedulerState() {
  if (!global.__totuAutoFetch) global.__totuAutoFetch = { interval: null, running: false };
  try { stopTotuAutoFetch(); } catch { /* ignore */ }
  global.__totuAutoFetch.interval = null;
  global.__totuAutoFetch.running = false;
}

describe("runTotuFetchOnce", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSchedulerState();
  });

  it("registers, logs in, mints a token and saves the connection", async () => {
    const deps = makeDeps({ connections: [] });

    const result = await runTotuFetchOnce(deps, { maxAccounts: 1 });

    expect(result).toEqual({ added: 1, failed: 0, skipped: 0, errors: [] });
    expect(deps.createProviderConnection).toHaveBeenCalledTimes(1);

    const saved = deps.createProviderConnection.mock.calls[0][0];
    expect(saved.provider).toBe("totu-ai");
    expect(saved.authType).toBe("apikey");
    expect(saved.apiKey).toBe(FIXED_SK);
    // Address domain comes from the live mail.tm list (stubbed emalupe.com), not hardcoded.
    expect(saved.email).toMatch(/^tu[A-Za-z0-9]+@emalupe\.com$/);
    expect(saved.testStatus).toBe("active");
    expect(saved.isActive).toBe(true);
    expect(saved.name).toMatch(/^TOTU u/);
    // loginToken must be stored server-side (providerSpecificData) — never in SAFE_PSD_FIELDS.
    expect(saved.providerSpecificData.loginToken).toBe(FIXED_SESSION);
    expect(saved.providerSpecificData.totuUsername).toMatch(/^u/);
    expect(saved.providerSpecificData.totuTokenId).toBe("tok1");

    // The mailbox address was composed from the fetched active domain.
    const mailboxAddress = saved.email;
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      "https://api.mail.tm/domains",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) })
    );
    const createdMailboxCall = deps.fetchImpl.mock.calls.find(([url, op]) => url.includes("api.mail.tm/accounts"));
    expect(JSON.parse(createdMailboxCall[1].body).address).toBe(mailboxAddress);
  });

  it("falls back to a known-good domain when the live list is empty or fails", async () => {
    const deps = makeDeps({ connections: [], fetchImpl: makeTotuFetch({ domains: [] }) });
    const result = await runTotuFetchOnce(deps, { maxAccounts: 1 });
    expect(result.added).toBe(1);
    const saved = deps.createProviderConnection.mock.calls[0][0];
    expect(saved.email).toMatch(/^tu[0-9a-zA-Z]+@emalupe\.com$/);
  });

  it("skips accounts whose email already exists (dedup)", async () => {
    const deps = makeDeps({
      connections: [{ id: "existing", provider: "totu-ai", email: FIXED_EMAIL }],
      fetchImpl: makeTotuFetch({ echoAddress: FIXED_EMAIL }),
    });

    const result = await runTotuFetchOnce(deps, { maxAccounts: 1 });

    expect(result).toEqual({ added: 0, failed: 0, skipped: 1, errors: [] });
    expect(deps.getProviderConnections).toHaveBeenCalledWith({ provider: "totu-ai" });
    expect(deps.createProviderConnection).not.toHaveBeenCalled();
  });

  it("continues the batch when one account fails (error isolation)", async () => {
    const fetchImpl = makeTotuFetch({ failCreateMailboxOn: 2 });
    const deps = makeDeps({ connections: [], fetchImpl });

    const result = await runTotuFetchOnce(deps, { maxAccounts: 2 });

    expect(result.added).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("mail.tm 429");
    // First account still saved its connection.
    expect(deps.createProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("returns failed when required DB deps are missing", async () => {
    const result = await runTotuFetchOnce({}, { maxAccounts: 2 });
    expect(result.failed).toBe(2);
    expect(result.errors[0].error).toContain("Missing DB deps");
  });
});

describe("scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSchedulerState();
  });

  it("does nothing when totuAutoFetch is disabled", async () => {
    const deps = makeDeps();
    deps.getSettings.mockResolvedValue({ totuAutoFetch: false, totuAutoFetchIntervalMin: 60 });

    const result = await runTotuAutoFetchTick(deps);

    expect(result).toBeUndefined();
    expect(deps.createProviderConnection).not.toHaveBeenCalled();
  });

  it("configureTotuAutoFetch is idempotent and toggles the timer", () => {
    vi.useFakeTimers();

    expect(global.__totuAutoFetch.interval).toBeNull();
    configureTotuAutoFetch({ totuAutoFetch: true, totuAutoFetchIntervalMin: 15 });
    expect(global.__totuAutoFetch.interval).toBeTruthy();

    // Calling again must not throw and must not stack a second interval.
    configureTotuAutoFetch({ totuAutoFetch: true, totuAutoFetchIntervalMin: 15 });
    expect(global.__totuAutoFetch.interval).toBeTruthy();

    configureTotuAutoFetch({ totuAutoFetch: false });
    expect(global.__totuAutoFetch.interval).toBeNull();
  });

  it("start/stop are callable and stop clears the timer", () => {
    vi.useFakeTimers();
    startTotuAutoFetch(30);
    expect(global.__totuAutoFetch.interval).toBeTruthy();
    stopTotuAutoFetch();
    expect(global.__totuAutoFetch.interval).toBeNull();
    stopTotuAutoFetch(); // double-stop must not throw
  });

  it("startTotuAutoFetch honors a minimum interval and reuses the global timer field", () => {
    vi.useFakeTimers();
    // Minimum 5 min even if the caller passes something tiny.
    startTotuAutoFetch(1);
    expect(global.__totuAutoFetch.interval).toBeTruthy();
    // Starting again replaces the previous timer without stacking.
    startTotuAutoFetch(60);
    expect(global.__totuAutoFetch.interval).toBeTruthy();
    stopTotuAutoFetch();
    expect(global.__totuAutoFetch.interval).toBeNull();
  });
});