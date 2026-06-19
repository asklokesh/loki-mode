"""Auth-gating tests for the /lab mount guard (dashboard/server.py _MountAuthGuard).

The Purple Lab sub-app is mounted at /lab. Starlette does NOT propagate the
parent app's route dependencies to a mounted sub-app, so the dashboard wraps the
mount in _MountAuthGuard to enforce the same scoped token as the dashboard's own
endpoints when enterprise auth is on.

WAVE13-TAIL regression guard: an earlier version of the guard passed ALL non-HTTP
ASGI scopes (including websocket) straight through. The Purple Lab sub-app exposes
WebSocket endpoints (a PTY terminal and an HMR proxy), so with enterprise auth ON,
/lab/ws/* was reachable UNAUTHENTICATED (a PTY login shell with no auth). The guard
now authenticates websocket scopes too: no/invalid token -> close 1008 before the
sub-app runs; valid scoped token -> pass through. Lifespan still passes through
(no client request to authenticate). With auth OFF the guard is a pass-through.

HERMETICITY: LOKI_ENTERPRISE_AUTH is read at import time, so each assertion runs
in a subprocess with the env set there (parent sys.modules/os.environ untouched).
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run_in_subprocess(body: str, enterprise_auth):
    env = dict(os.environ)
    if enterprise_auth is True:
        env["LOKI_ENTERPRISE_AUTH"] = "true"
    elif enterprise_auth is False:
        env.pop("LOKI_ENTERPRISE_AUTH", None)
    preamble = (
        "import sys, asyncio\n"
        f"sys.path.insert(0, {_REPO_ROOT!r})\n"
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


# Shared harness: build a _MountAuthGuard around a fake sub-app that records
# whether it was reached, then drive a websocket scope through it.
_HARNESS = """
from dashboard import server as S
from dashboard import auth

reached = {"v": False}
async def fake_subapp(scope, receive, send):
    reached["v"] = True
    if scope["type"] == "websocket":
        await send({"type": "websocket.accept"})

guard = S._MountAuthGuard(fake_subapp, "read")
sent = []
async def send(msg): sent.append(msg)
async def receive(): return {"type": "websocket.connect"}

def drive(scope):
    reached["v"] = False
    sent.clear()
    asyncio.run(guard(scope, receive, send))
    return reached["v"], [m.get("type") for m in sent], sent
"""


# Auth ON, websocket, NO token: must be closed 1008 and the sub-app must NOT be
# reached (this is the bypass that exposed the PTY shell).
_BODY_WS_AUTH_ON_NO_TOKEN_CLOSED = _HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
reached, types, sent = drive({"type": "websocket", "headers": [], "query_string": b""})
assert reached is False, "BYPASS: sub-app reached on an unauthenticated websocket"
assert any(m.get("type") == "websocket.close" and m.get("code") == 1008 for m in sent), (
    "expected a 1008 policy-violation close, got: %r" % (sent,)
)
print("OK")
"""


# Auth ON, websocket, BAD token (in a query param): must also be closed 1008.
_BODY_WS_AUTH_ON_BAD_TOKEN_CLOSED = _HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
reached, types, sent = drive({
    "type": "websocket", "headers": [], "query_string": b"token=not-a-real-token",
})
assert reached is False, "BYPASS: sub-app reached with an invalid websocket token"
assert any(m.get("type") == "websocket.close" and m.get("code") == 1008 for m in sent)
print("OK")
"""


# Auth OFF, websocket: pass through unchanged (no local regression).
_BODY_WS_AUTH_OFF_PASSTHROUGH = _HARNESS + """
assert not auth.is_enterprise_mode(), "expected auth off"
reached, types, sent = drive({"type": "websocket", "headers": [], "query_string": b""})
assert reached is True, "REGRESSION: auth-off websocket should pass through"
print("OK")
"""


# Auth ON, websocket, VALID read-scoped token: must pass through to the sub-app
# (via both ?token= query and Authorization: Bearer header).
_BODY_WS_AUTH_ON_VALID_TOKEN_PASSES = _HARNESS + """
import uuid
assert auth.is_enterprise_mode(), "expected enterprise mode on"
# Unique name so reruns never collide; deleted in finally so the real token
# store is left untouched.
name = "ws-guard-test-" + uuid.uuid4().hex[:12]
info = auth.generate_token(name, scopes=["read"])
raw = info["token"] if "token" in info else info.get("raw_token") or info.get("key")
assert raw and raw.startswith("loki_"), "expected a real loki_ token, got %r" % (info,)
try:
    # via query param
    hit_q, types_q, sent_q = drive({
        "type": "websocket", "headers": [],
        "query_string": ("token=" + raw).encode("latin-1"),
    })
    assert hit_q is True, "valid read token (query) should pass through, sent=%r" % (sent_q,)
    # via Authorization: Bearer header
    hit_b, types_b, sent_b = drive({
        "type": "websocket",
        "headers": [(b"authorization", ("Bearer " + raw).encode("latin-1"))],
        "query_string": b"",
    })
    assert hit_b is True, "valid read token (bearer) should pass through, sent=%r" % (sent_b,)
    print("OK")
finally:
    try:
        auth.delete_token(name)
    except Exception:
        pass
"""


# Lifespan always passes through (no client request).
_BODY_LIFESPAN_PASSTHROUGH = _HARNESS + """
reached, types, sent = drive({"type": "lifespan"})
assert reached is True, "lifespan must pass through"
print("OK")
"""


class LabMountAuthTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_ws_auth_on_no_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_WS_AUTH_ON_NO_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_ws_auth_on_bad_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_WS_AUTH_ON_BAD_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_ws_auth_on_valid_token_passes(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_WS_AUTH_ON_VALID_TOKEN_PASSES, enterprise_auth=True)
        )

    def test_ws_auth_off_passes_through(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_WS_AUTH_OFF_PASSTHROUGH, enterprise_auth=False)
        )

    def test_lifespan_passes_through(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_LIFESPAN_PASSTHROUGH, enterprise_auth=False)
        )


if __name__ == "__main__":
    unittest.main()
