"""Auth-gating tests for the dashboard's native WebSocket endpoints.

The dashboard registers two native WebSocket routes directly on its FastAPI app:

  1. ``@app.websocket("/ws")`` (dashboard/server.py websocket_endpoint) -- the
     real-time updates feed. It self-guards in-route: when enterprise auth or
     OIDC is enabled it requires a valid ``?token=`` query parameter and
     accepts-then-closes 1008 on a missing/invalid token; it is a pass-through
     when auth is off.
  2. ``@app.websocket("/ws/collab")`` (collab/api.py, registered via
     create_collab_routes(app)) -- the real-time collaboration feed. The collab
     route itself performs NO auth, so server.py wraps the app in
     _CollabWsAuthMiddleware to validate the handshake before the route runs:
     auth-on + no/invalid token -> accept-then-close 1008; auth-off ->
     pass-through. This regression test pins that gate.

Browsers cannot set an Authorization header on a WS upgrade, so query-parameter
token auth is the established approach (mirrored from the native /ws gate and the
_MountAuthGuard mount logic in test_lab_mount_auth.py, which covers the mounted
/lab sub-app WebSockets).

The /ws route is a FastAPI WebSocket-object route, so it is driven by calling the
endpoint coroutine with a fake WebSocket. The /ws/collab gate lives in ASGI
middleware, so it is driven with a raw ASGI websocket scope.

HERMETICITY: LOKI_ENTERPRISE_AUTH is read at import time, so each assertion runs
in a subprocess with the env set there (parent sys.modules/os.environ untouched).
Real tokens are created with a unique name and deleted in finally, so the live
token store is left untouched.
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


# Shared harness: a fake FastAPI WebSocket that records accept()/close() and
# whether the endpoint passed the auth gate into the connection loop. receive_text
# raises WebSocketDisconnect so the post-gate loop exits immediately (the test
# only cares about the auth decision, not the message loop).
_HARNESS = """
from dashboard import server as S
from dashboard import auth
from fastapi import WebSocketDisconnect


class FakeClient:
    host = "127.0.0.1"


class FakeWS:
    def __init__(self, query):
        self.client = FakeClient()
        self.query_params = query  # dict with .get()
        self.accepted = False
        self.closed_code = None
        self.connected_msg = False

    async def accept(self):
        self.accepted = True

    async def close(self, code=1000, reason=None):
        self.closed_code = code

    async def send_json(self, message):
        if message.get("type") == "connected":
            self.connected_msg = True

    async def receive_text(self):
        # Past the gate: end the loop cleanly so the test does not block.
        raise WebSocketDisconnect()


def drive(query):
    ws = FakeWS(query)
    asyncio.run(S.websocket_endpoint(ws))
    # "passed the gate" == reached manager.connect + sent the connected message
    # and was NOT closed with the policy-violation code.
    passed = ws.connected_msg and ws.closed_code != 1008
    return ws, passed
"""


# Auth ON, no token: accepted then closed 1008, gate NOT passed.
_BODY_AUTH_ON_NO_TOKEN_CLOSED = _HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
ws, passed = drive({})
assert passed is False, "BYPASS: unauthenticated WS reached the connection loop"
assert ws.closed_code == 1008, "expected 1008 policy-violation close, got %r" % (ws.closed_code,)
print("OK")
"""


# Auth ON, bad token: accepted then closed 1008, gate NOT passed.
_BODY_AUTH_ON_BAD_TOKEN_CLOSED = _HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
ws, passed = drive({"token": "not-a-real-token"})
assert passed is False, "BYPASS: invalid-token WS reached the connection loop"
assert ws.closed_code == 1008, "expected 1008 policy-violation close, got %r" % (ws.closed_code,)
print("OK")
"""


# Auth ON, valid loki_ token: gate passed (connection established).
_BODY_AUTH_ON_VALID_TOKEN_PASSES = _HARNESS + """
import uuid
assert auth.is_enterprise_mode(), "expected enterprise mode on"
name = "native-ws-test-" + uuid.uuid4().hex[:12]
info = auth.generate_token(name, scopes=["read"])
raw = info["token"] if "token" in info else info.get("raw_token") or info.get("key")
assert raw and raw.startswith("loki_"), "expected a real loki_ token, got %r" % (info,)
try:
    ws, passed = drive({"token": raw})
    assert passed is True, "valid token should pass the gate, closed_code=%r" % (ws.closed_code,)
    assert ws.closed_code != 1008, "valid token must not be closed 1008"
    print("OK")
finally:
    try:
        auth.delete_token(name)
    except Exception:
        pass
"""


# Auth OFF: pass through (no token required), no local regression.
_BODY_AUTH_OFF_PASSTHROUGH = _HARNESS + """
assert not auth.is_enterprise_mode(), "expected auth off"
ws, passed = drive({})
assert passed is True, "REGRESSION: auth-off WS should pass through, closed_code=%r" % (ws.closed_code,)
assert ws.closed_code != 1008, "auth-off WS must not be closed 1008"
print("OK")
"""


# A raw ASGI harness for the /ws/collab gate, which lives in
# _CollabWsAuthMiddleware (not in the route). It drives the middleware directly
# around a fake sub-app that records whether the collab route was reached.
_COLLAB_HARNESS = """
from dashboard import server as S
from dashboard import auth

reached = {"v": False}
async def fake_app(scope, receive, send):
    reached["v"] = True
    if scope.get("type") == "websocket":
        await send({"type": "websocket.accept"})

mw = S._CollabWsAuthMiddleware(fake_app)
sent = []
async def send(msg): sent.append(msg)
async def receive(): return {"type": "websocket.connect"}

def drive(scope):
    reached["v"] = False
    sent.clear()
    asyncio.run(mw(scope, receive, send))
    closed_1008 = any(m.get("type") == "websocket.close" and m.get("code") == 1008 for m in sent)
    return reached["v"], closed_1008, sent
"""


# /ws/collab, auth ON, no token: closed 1008, collab route NOT reached.
_BODY_COLLAB_AUTH_ON_NO_TOKEN_CLOSED = _COLLAB_HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
reached, closed_1008, sent = drive({"type": "websocket", "path": "/ws/collab", "headers": [], "query_string": b""})
assert reached is False, "BYPASS: unauthenticated /ws/collab reached the collab route"
assert closed_1008, "expected 1008 policy-violation close, got %r" % (sent,)
print("OK")
"""


# /ws/collab, auth ON, bad token: closed 1008, collab route NOT reached.
_BODY_COLLAB_AUTH_ON_BAD_TOKEN_CLOSED = _COLLAB_HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
reached, closed_1008, sent = drive({
    "type": "websocket", "path": "/ws/collab", "headers": [], "query_string": b"token=not-a-real-token",
})
assert reached is False, "BYPASS: invalid-token /ws/collab reached the collab route"
assert closed_1008, "expected 1008 policy-violation close, got %r" % (sent,)
print("OK")
"""


# /ws/collab, auth ON, control token: passes through to the collab route.
# The collab WS path performs state writes (apply_operation), so it requires the
# "control" scope; a control token must be admitted.
_BODY_COLLAB_AUTH_ON_VALID_TOKEN_PASSES = _COLLAB_HARNESS + """
import uuid
assert auth.is_enterprise_mode(), "expected enterprise mode on"
name = "collab-ws-test-" + uuid.uuid4().hex[:12]
info = auth.generate_token(name, scopes=["control"])
raw = info["token"] if "token" in info else info.get("raw_token") or info.get("key")
assert raw and raw.startswith("loki_"), "expected a real loki_ token, got %r" % (info,)
try:
    reached, closed_1008, sent = drive({
        "type": "websocket", "path": "/ws/collab", "headers": [],
        "query_string": ("token=" + raw).encode("latin-1"),
    })
    assert reached is True, "control token should pass through to /ws/collab, sent=%r" % (sent,)
    assert not closed_1008, "control token must not be closed 1008"
    print("OK")
finally:
    try:
        auth.delete_token(name)
    except Exception:
        pass
"""


# /ws/collab, auth ON, valid READ-ONLY token: closed 1008 (M3 scope fix).
# A read-only token authenticates but lacks "control", and the collab WS path
# can mutate shared state, so it must be rejected.
_BODY_COLLAB_AUTH_ON_READ_TOKEN_CLOSED = _COLLAB_HARNESS + """
import uuid
assert auth.is_enterprise_mode(), "expected enterprise mode on"
name = "collab-ws-read-" + uuid.uuid4().hex[:12]
info = auth.generate_token(name, scopes=["read"])
raw = info["token"] if "token" in info else info.get("raw_token") or info.get("key")
assert raw and raw.startswith("loki_"), "expected a real loki_ token, got %r" % (info,)
try:
    reached, closed_1008, sent = drive({
        "type": "websocket", "path": "/ws/collab", "headers": [],
        "query_string": ("token=" + raw).encode("latin-1"),
    })
    assert reached is False, "BYPASS: read-only token reached the collab write route, sent=%r" % (sent,)
    assert closed_1008, "read-only token must be closed 1008, got %r" % (sent,)
    print("OK")
finally:
    try:
        auth.delete_token(name)
    except Exception:
        pass
"""


# /ws/collab, auth OFF: pass through (no token required), no local regression.
_BODY_COLLAB_AUTH_OFF_PASSTHROUGH = _COLLAB_HARNESS + """
assert not auth.is_enterprise_mode(), "expected auth off"
reached, closed_1008, sent = drive({"type": "websocket", "path": "/ws/collab", "headers": [], "query_string": b""})
assert reached is True, "REGRESSION: auth-off /ws/collab should pass through, sent=%r" % (sent,)
assert not closed_1008, "auth-off /ws/collab must not be closed 1008"
print("OK")
"""


# The middleware must NOT interfere with other websocket paths or HTTP scopes.
_BODY_COLLAB_MW_OTHER_PATHS_PASSTHROUGH = _COLLAB_HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
# A different WS path (e.g. /ws) must pass through the collab middleware untouched
# even with no token; /ws guards itself in-route, not here.
hit_ws, closed_ws, sent_ws = drive({"type": "websocket", "path": "/ws", "headers": [], "query_string": b""})
assert hit_ws is True, "collab middleware must not gate /ws, sent=%r" % (sent_ws,)
assert not closed_ws, "collab middleware must not close /ws"
# An HTTP scope must pass through untouched.
hit_http, closed_http, sent_http = drive({"type": "http", "path": "/ws/collab", "headers": [], "query_string": b""})
assert hit_http is True, "collab middleware must not gate HTTP scopes"
print("OK")
"""


# A TestClient harness for the /api/collab/* REST routes (M3b). The collab REST
# routes were unauthenticated; they now carry require_scope dependencies (reads
# -> "read", state-changing -> "control"). This drives the real ASGI app through
# starlette's TestClient so the dependency chain runs exactly as in production.
_COLLAB_REST_HARNESS = """
from dashboard import server as S
from dashboard import auth
from starlette.testclient import TestClient

client = TestClient(S.app)
"""


# /api/collab REST, auth ON, no token: unauth read + write both rejected (M3b).
_BODY_COLLAB_REST_AUTH_ON_NO_TOKEN = _COLLAB_REST_HARNESS + """
assert auth.is_enterprise_mode(), "expected enterprise mode on"
# Read route (GET /api/collab/users) -> 401 (no credentials).
r = client.get("/api/collab/users")
assert r.status_code in (401, 403), "BYPASS: unauth read on /api/collab/users, got %r" % (r.status_code,)
# State-changing route (POST /api/collab/join) -> 401/403.
r = client.post("/api/collab/join", json={"name": "attacker"})
assert r.status_code in (401, 403), "BYPASS: unauth join on /api/collab/join, got %r" % (r.status_code,)
print("OK")
"""


# /api/collab REST, auth ON, read-only token: read OK, write (join) rejected 403.
_BODY_COLLAB_REST_READ_TOKEN_SCOPE = _COLLAB_REST_HARNESS + """
import uuid
assert auth.is_enterprise_mode(), "expected enterprise mode on"
name = "collab-rest-read-" + uuid.uuid4().hex[:12]
info = auth.generate_token(name, scopes=["read"])
raw = info["token"] if "token" in info else info.get("raw_token") or info.get("key")
assert raw and raw.startswith("loki_"), "expected a real loki_ token, got %r" % (info,)
hdr = {"Authorization": "Bearer " + raw}
try:
    # Read route allowed for a read token.
    r = client.get("/api/collab/users", headers=hdr)
    assert r.status_code == 200, "read token should read /api/collab/users, got %r %r" % (r.status_code, r.text)
    # Write route (join) requires control -> 403 for a read token.
    r = client.post("/api/collab/join", json={"name": "x"}, headers=hdr)
    assert r.status_code == 403, "read token must NOT join (control), got %r %r" % (r.status_code, r.text)
    print("OK")
finally:
    try:
        auth.delete_token(name)
    except Exception:
        pass
"""


# /api/collab REST, auth ON, control token: read + write both allowed.
_BODY_COLLAB_REST_CONTROL_TOKEN = _COLLAB_REST_HARNESS + """
import uuid
assert auth.is_enterprise_mode(), "expected enterprise mode on"
name = "collab-rest-ctrl-" + uuid.uuid4().hex[:12]
info = auth.generate_token(name, scopes=["control"])
raw = info["token"] if "token" in info else info.get("raw_token") or info.get("key")
assert raw and raw.startswith("loki_"), "expected a real loki_ token, got %r" % (info,)
hdr = {"Authorization": "Bearer " + raw}
try:
    r = client.get("/api/collab/users", headers=hdr)
    assert r.status_code == 200, "control token should read, got %r %r" % (r.status_code, r.text)
    r = client.post("/api/collab/join", json={"name": "x"}, headers=hdr)
    assert r.status_code == 200, "control token should join, got %r %r" % (r.status_code, r.text)
    print("OK")
finally:
    try:
        auth.delete_token(name)
    except Exception:
        pass
"""


# /api/collab REST, auth OFF: pass-through (no token required), no regression.
_BODY_COLLAB_REST_AUTH_OFF = _COLLAB_REST_HARNESS + """
assert not auth.is_enterprise_mode(), "expected auth off"
r = client.get("/api/collab/users")
assert r.status_code == 200, "REGRESSION: auth-off read should pass, got %r %r" % (r.status_code, r.text)
r = client.post("/api/collab/join", json={"name": "anon"})
assert r.status_code == 200, "REGRESSION: auth-off join should pass, got %r %r" % (r.status_code, r.text)
print("OK")
"""


# Coverage assertion: pin the set of native @app.websocket routes on the
# dashboard app. Both must be covered by this test. If a new native WS route is
# added without auth, this fails so it cannot ship silently unguarded. (Mounted
# /lab WS endpoints are covered by test_lab_mount_auth.py.)
_BODY_NATIVE_WS_ROUTES = _HARNESS + """
from starlette.routing import WebSocketRoute
ws_paths = sorted(r.path for r in S.app.router.routes if isinstance(r, WebSocketRoute))
assert ws_paths == ["/ws", "/ws/collab"], (
    "native WebSocket routes changed: expected ['/ws', '/ws/collab'], got %r. "
    "A new native WS route must validate auth and be added to this regression "
    "test." % (ws_paths,)
)
print("OK")
"""


class NativeWsAuthTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_auth_on_no_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_AUTH_ON_NO_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_auth_on_bad_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_AUTH_ON_BAD_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_auth_on_valid_token_passes(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_AUTH_ON_VALID_TOKEN_PASSES, enterprise_auth=True)
        )

    def test_auth_off_passes_through(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_AUTH_OFF_PASSTHROUGH, enterprise_auth=False)
        )

    def test_collab_auth_on_no_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_AUTH_ON_NO_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_collab_auth_on_bad_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_AUTH_ON_BAD_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_collab_auth_on_valid_token_passes(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_AUTH_ON_VALID_TOKEN_PASSES, enterprise_auth=True)
        )

    def test_collab_auth_on_read_token_is_closed(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_AUTH_ON_READ_TOKEN_CLOSED, enterprise_auth=True)
        )

    def test_collab_auth_off_passes_through(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_AUTH_OFF_PASSTHROUGH, enterprise_auth=False)
        )

    def test_collab_rest_auth_on_no_token_rejected(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_REST_AUTH_ON_NO_TOKEN, enterprise_auth=True)
        )

    def test_collab_rest_read_token_scope(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_REST_READ_TOKEN_SCOPE, enterprise_auth=True)
        )

    def test_collab_rest_control_token(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_REST_CONTROL_TOKEN, enterprise_auth=True)
        )

    def test_collab_rest_auth_off_passes_through(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_REST_AUTH_OFF, enterprise_auth=False)
        )

    def test_collab_mw_other_paths_pass_through(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_COLLAB_MW_OTHER_PATHS_PASSTHROUGH, enterprise_auth=True)
        )

    def test_native_ws_routes(self):
        self._assert_child_passed(
            _run_in_subprocess(_BODY_NATIVE_WS_ROUTES, enterprise_auth=False)
        )


if __name__ == "__main__":
    unittest.main()
