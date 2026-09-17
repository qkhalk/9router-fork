#!/usr/bin/env python3
"""
gensparkTlsSidecar.py — a tiny per-request TLS sidecar for the 9router genspark-web
executor.

Why: 9router's Node `fetch` sends a vanilla TLS/JA3 fingerprint, and genspark's
Cloudflare edge blocks that with a "Just a moment" challenge (403) regardless of IP
or cookies. Proven fix from the SharpWizard/genspark-py project (audited CLEAN, MIT):
`curl_cffi` reproduces a real Chrome TLS + HTTP/2 fingerprint, and the request passes.

Contract (stdin JSON → stdout lines):
    stdin : one JSON object:
              {
                "cookies":  {name: value, ...},      // full browser jar
                "payload":  {ai_chat ...},           // /api/agent/ask_proxy body
                "proxy":    null | "http://user:pass@host:port",
                "timeoutSec": 90
              }
    stdout: the raw upstream response stream, one line per write, each terminated
            with \\n and flushed immediately (each line is a full `data: <json>` SSE
            frame or comment line). The Node harness re-prefixes lines with `data: `
            so the existing readGensparkSseEvents parser keeps working unchanged.
    stderr: human diagnostics + ONE machine line (see below).
    exit 0: upstream returned a 2xx stream (or non-stream 2xx body) — obey stream.

Cookie refresh (write-back): Cloudflare re-issues `__cf_bm` / `cf_clearance` on every
authenticated upstream response, so a successful ask_proxy call yields a *fresher* jar
than the one we were handed. The Node harness wants those cookies back (so the user
doesn't have to re-paste every ~30 min when the datacenter IP gets challenged). We emit
exactly one machine-parseable line on stderr:

    [genspark-cookie-refresh] {"<name>": "<value>", ...}

only when at least one tracked cookie changed. The harness matches the prefix, parses
the JSON, and writes it back into the connection. Everything else on stderr stays
free-form human diagnostics.
    exit 3: Cloudflare challenge / 403 (content-type text/html or challenge markers).
    exit 4: upstream returned a JSON/SSE error payload (not-login, rate-limit, model
            gone, "retired", ...) — the response body has already been streamed so the
            executor can classify it exactly like today.
    exit 5: exception / timeout / transport error (nothing usable streamed).
    exit 2: bad arguments (unparseable stdin).

The exit code lets the Node harness distinguish "challenge" from "app-level error"
instantly, but the executor's existing `classifyError()` on the streamed body remains
the primary signal — exit codes are a fast-path hint, not authoritative.
"""

from __future__ import annotations

import json
import sys
import time


# chrome124 is the impersonation genspark-py verifies; a current Chrome UA keeps the
# HTTP/2 + Alt-Svc + sec-ch-* picture coherent for the edge heuristics.
IMPERSONATE = "chrome124"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
ASK_PROXY = "https://www.genspark.ai/api/agent/ask_proxy"
BASE = "https://www.genspark.ai"

CHALLENGE_MARKERS = (
    "Just a moment",
    "cf_chl",
    "Enable JavaScript",
    "cdn-cgi/challenge-platform",
    "Sorry, you have been blocked",
)

# Exit codes (see module docstring).
EXIT_OK = 0
EXIT_BAD_ARGS = 2
EXIT_CHALLENGE = 3
EXIT_APP_ERROR = 4
EXIT_TRANSPORT = 5

# One-line machine signal the Node harness parses for cookie write-back. The prefix
# is unique enough to not collide with the human "[genspark-sidecar]" diagnostics.
COOKIE_REFRESH_PREFIX = "[genspark-cookie-refresh]"

# Cookies we want to capture when they change. session_id is the login token and is
# (rarely) re-issued too; the anti-bot tokens are what actually expire on a datacenter
# IP and must be refreshed so the user doesn't re-paste every ~30 min.
REFRESHABLE_COOKIE_NAMES = ("session_id", "__cf_bm", "cf_clearance", "c1", "c2", "gslogin")


def log(msg: str) -> None:
    # stderr only — stdout is the data channel.
    print(f"[genspark-sidecar] {msg}", file=sys.stderr, flush=True)


def emit_cookie_refresh(session, incoming: dict) -> dict:
    """Emit a `[genspark-cookie-refresh] <json>` line on stderr for cookies that
    changed vs. what the caller passed in.

    `session.cookies` is curl_cffi's jar. Iterating it yields **cookie name
    strings** (not Morsel objects), and `jar.get(name)` returns the **value
    string** directly — so we match by name and read the value via `.get()`.
    On a successful authenticated response the jar already holds the upstream's
    reissued Set-Cookie values (we set them all on www.genspark.ai, and the jar
    rejects cross-domain Set-Cookie, so no domain filtering is needed). We emit
    only the diff, so the harness writes back exactly what changed.

    Returns the emitted dict (empty if nothing changed — caller skips emission).
    """
    diff = {}
    try:
        jar = session.cookies
        names = list(jar)
    except Exception:  # noqa: BLE001
        return diff
    for name in REFRESHABLE_COOKIE_NAMES:
        if name not in names:
            continue
        found_value = jar.get(name)
        if not found_value:
            continue
        if str(incoming.get(name, "")) != str(found_value):
            diff[name] = found_value
    if not diff:
        return diff
    # Single machine line on stderr; the harness matches COOKIE_REFRESH_PREFIX.
    print(f"{COOKIE_REFRESH_PREFIX} {json.dumps(diff, ensure_ascii=False)}", file=sys.stderr, flush=True)
    return diff


def detect_challenge(text: str, content_type: str) -> bool:
    if "html" in (content_type or "").lower() or "text/html" in (content_type or "").lower():
        return True  # an HTML body from genspark is never legitimate
    return any(m in (text or "") for m in CHALLENGE_MARKERS)


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            log("empty stdin")
            return EXIT_BAD_ARGS
        req = json.loads(raw)
    except Exception as e:  # noqa: BLE001 - let the harness see the message
        log(f"bad request JSON: {e}")
        return EXIT_BAD_ARGS

    cookies = req.get("cookies") or {}
    payload = req.get("payload")
    proxy = req.get("proxy") or None
    timeout_sec = float(req.get("timeoutSec", 90) or 90)
    # Optional generic-GET mode (used by the model catalog to read genspark's
    # public selector endpoints through the same curl_cffi fingerprint).
    # Absent/None keeps the historical POST ASK_PROXY behaviour.
    req_url = req.get("url") or None
    req_method = (req.get("method") or "POST").upper()

    is_get = req_method == "GET" and req_url
    if not isinstance(cookies, dict) or (not is_get and (not payload or not isinstance(payload, dict))):
        log("missing cookies or payload")
        return EXIT_BAD_ARGS

    try:
        from curl_cffi import requests as cf_requests
    except Exception as e:  # noqa: BLE001
        log(f"curl_cffi unavailable: {e} (install into the sidecar venv)")
        return EXIT_TRANSPORT

    try:
        s = cf_requests.Session(impersonate=IMPERSONATE)
        s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        if proxy:
            s.proxies = {"http": proxy, "https": proxy}
        for name, value in cookies.items():
            if name and value is not None:
                s.cookies.set(name, str(value), domain="www.genspark.ai", path="/")

        if req_method == "GET" and req_url:
            r = s.get(
                req_url,
                headers={
                    "Referer": f"{BASE}/",
                    "Accept": "application/json",
                },
                stream=True,
                timeout=timeout_sec,
            )
        else:
            r = s.post(
                ASK_PROXY,
                headers={
                    "Origin": BASE,
                    "Referer": f"{BASE}/agents?type=ai_chat",
                    "Content-Type": "application/json",
                    "Accept": "*/*",
                },
                json=payload,
                stream=True,
                timeout=timeout_sec,
            )

        content_type = r.headers.get("content-type", "")

        # Fast-path challenge: 403 with an HTML body is always Cloudflare.
        if r.status_code == 403 and "html" in content_type.lower():
            log(f"Cloudflare challenge (status=403, ct={content_type})")
            # Stream whatever tiny body we have (harmless) then exit 3.
            try:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
            except Exception:  # noqa: BLE001
                pass
            return EXIT_CHALLENGE

        # Stream the body line-by-line so the Node harness can consume it and re-prefix
        # each line with `data: ` exactly once (readGensparkSseEvents expects that shape).
        # Genspark's SSE frames already start with `data: ` — curl_cffi's iter_lines()
        # yields them verbatim — so we STRIP that prefix here; the harness adds it back.
        # Iterating lines keeps us aligned with SSE frames; we flush each line promptly
        # for a live stream UX.
        exit_code = EXIT_OK
        first_bytes = b""
        for raw_line in r.iter_lines():
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", "replace") if isinstance(raw_line, (bytes, bytearray)) else str(raw_line)
            # Normalize: handle both `data: {...}` (what curl_cffi yields) and bare JSON.
            stripped = line[5:].strip() if line.startswith("data:") else line.strip()
            if not stripped:
                continue
            if len(first_bytes) < 4096:
                first_bytes += (stripped + "\n").encode("utf-8", "replace")[:4096 - len(first_bytes)]
            if r.status_code >= 400:
                # Non-2xx that isn't the fast-pathed HTML challenge: stream it but
                # let the executor classify the body (not-login JSON / rate-limit, ...).
                exit_code = EXIT_APP_ERROR
            sys.stdout.write(stripped + "\n")
            sys.stdout.flush()

        text_so_far = first_bytes.decode("utf-8", "replace").lower()
        if detect_challenge(text_so_far, content_type):
            log("Cloudflare challenge detected in body")
            return EXIT_CHALLENGE

        # A 2xx with zero streamed lines and an empty HTML body is still a challenge page.
        if r.status_code == 200 and not first_bytes:
            log("empty 200 body — treating as challenge/block")
            return EXIT_CHALLENGE

        # Emit refreshed cookies (write-back) — see module docstring. Only meaningful
        # when the upstream call actually authenticated (2xx). Skip on app/challenge
        # exits so we never hand back a jar from an error payload (which could carry a
        # stale or challenge cookie).
        if exit_code == EXIT_OK:
            try:
                refreshed = emit_cookie_refresh(s, cookies)
                if refreshed:
                    log(f"cookie refresh: {len(refreshed)} cookie(s) updated")
            except Exception as e:  # noqa: BLE001
                log(f"cookie refresh skipped: {e}")

        return exit_code
    except Exception as e:  # noqa: BLE001
        log(f"transport error: {type(e).__name__}: {e}")
        return EXIT_TRANSPORT
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())