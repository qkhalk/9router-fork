import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { isAuthenticated } from "@/dashboardGuard";

export const dynamic = "force-dynamic";

// Internal example-runner proxy for the dashboard's media-provider Example
// cards. The cards' Run button used to fetch the gateway's public /v1/*
// endpoints straight from the browser, which requireApiKey gates behind a
// client API key — and since S7 the dashboard can no longer prefill one
// (apiKeys.key is the MASKED display value; raw keys exist only as hashes).
// The provider-page Test button never had this problem because it pings
// server-side with the x-9r-cli-token. This route gives the Example cards the
// same trusted path: the browser POSTs here (dashboard session, enforced by
// the proxy for non-public /api paths), the server replays the request
// against its own loopback listener with the CLI token, and the upstream
// response (JSON / binary / SSE) streams back untouched.
//
// Deliberately NOT a general proxy: only the fixed media-kind endpoint paths
// are reachable, only POST, and the target is always this process's own
// origin — never a caller-supplied URL.

const CLI_TOKEN_SALT = "9r-cli-auth";
const BASE_URL = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

// Exact path whitelist from MEDIA_PROVIDER_KINDS (query strings allowed — the
// /v1 handlers validate their own params).
const ALLOWED_PATHS = new Set(
  MEDIA_PROVIDER_KINDS.map((k) => k.endpoint?.path).filter(Boolean)
);

export async function POST(request) {
  // The proxy already rejects unauthenticated callers on this path; keep an
  // explicit check so the route stays safe even if mounted elsewhere.
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawPath = request.headers.get("x-example-path") || "";
  let parsed;
  try { parsed = new URL(rawPath, "http://internal.invalid"); } catch {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!ALLOWED_PATHS.has(parsed.pathname)) {
    return Response.json(
      { error: `Path not allowed: ${parsed.pathname}` },
      { status: 400 }
    );
  }

  const headers = {
    "Content-Type": request.headers.get("content-type") || "application/json",
    "x-9r-cli-token": await getConsistentMachineId(CLI_TOKEN_SALT),
  };

  let upstream;
  try {
    upstream = await fetch(`${BASE_URL}/api${parsed.pathname}${parsed.search}`, {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
      // No AbortSignal: image/video SSE streams can legitimately run for
      // minutes; the direct browser fetch these cards used had no cap either.
      redirect: "manual",
    });
  } catch (e) {
    return Response.json(
      { error: `Example run failed: ${e?.message || e}` },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}
