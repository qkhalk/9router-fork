#!/usr/bin/env python3
"""Unit test for gensparkTlsSidecar.emit_cookie_refresh.

The sidecar's cookie jar is curl_cffi's RequestsCookieJar. A regression was
found where the function iterated the jar expecting Morsel objects with
`.name`/`.domain` attributes — but curl_cffi's jar iterates as plain **cookie
name strings** and `.get(name)` returns the **value string** directly. That
assumption made the function capture nothing, so no cookie refresh was ever
emitted. This test locks the correct shape using a lightweight fake jar with
the same iteration + .get() contract.

Run: python3 tests/unit/genspark-emit-cookie-refresh.test.py
"""
import importlib.util
import json
import os
import sys

# Import the sidecar module from the repo (it has a `main()` guarded by __main__,
# so importing it as a module is safe and doesn't spawn anything).
SCRIPT = os.path.join(
    os.path.dirname(__file__), "..", "..", "open-sse", "services", "gensparkTlsSidecar.py"
)
spec = importlib.util.spec_from_file_location("gensparkTlsSidecar", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class FakeJar:
    """Mimics curl_cffi's RequestsCookieJar: iterable of name strings, .get(name)
    returns the value string."""

    def __init__(self, data):
        self._data = data

    def __iter__(self):
        return iter(self._data)

    def get(self, name, default=None):
        return self._data.get(name, default)


def make_session(jar_data):
    class FakeSession:
        cookies = FakeJar(jar_data)
    return FakeSession()


def run(incoming, jar):
    """Return the parsed refresh JSON (None if nothing emitted)."""
    captured = {}

    class CapStderr:
        def write(self, msg):
            if msg.startswith(mod.COOKIE_REFRESH_PREFIX):
                captured["line"] = msg
            return len(msg)

        def flush(self):
            pass

    old_stderr = sys.stderr
    sys.stderr = CapStderr()
    try:
        diff = mod.emit_cookie_refresh(make_session(jar), incoming)
    finally:
        sys.stderr = old_stderr
    if "line" in captured:
        return json.loads(captured["line"][len(mod.COOKIE_REFRESH_PREFIX):].strip())
    return None if not diff else diff


def test_emits_diff_when_cookie_changed():
    incoming = {"session_id": "s1", "__cf_bm": "OLD"}
    jar = {"session_id": "s1", "__cf_bm": "NEW_FRESH"}
    out = run(incoming, jar)
    assert out == {"__cf_bm": "NEW_FRESH"}, out


def test_emits_nothing_when_unchanged():
    incoming = {"session_id": "s1", "__cf_bm": "SAME", "c1": "c1v"}
    jar = {"session_id": "s1", "__cf_bm": "SAME", "c1": "c1v"}
    assert run(incoming, jar) is None


def test_only_refreshable_names_considered():
    # A non-refreshable cookie changed — must NOT be emitted.
    incoming = {"session_id": "s1"}
    jar = {"session_id": "s1", "ai_user": "changed-but-ignored"}
    assert run(incoming, jar) is None


def test_skips_missing_name_in_jar():
    # Requested a refreshable name but the jar doesn't carry it.
    incoming = {"session_id": "s1", "__cf_bm": "x"}
    jar = {"session_id": "s1"}
    assert run(incoming, jar) is None


if __name__ == "__main__":
    for fn in (test_emits_diff_when_cookie_changed, test_emits_nothing_when_unchanged,
               test_only_refreshable_names_considered, test_skips_missing_name_in_jar):
        fn()
        print("PASS", fn.__name__)
    print("ALL PASS")
