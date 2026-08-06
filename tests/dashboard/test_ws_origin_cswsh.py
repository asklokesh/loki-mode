"""Cross-Site WebSocket Hijacking on the dashboard's WebSocket boundary.

WHY THIS EXISTS. WebSocketBoundaryMiddleware already refuses a REMOTE peer, and
that closed the measured hole where /ws and /ws/collab accepted connections from
a routable address with auth off. But an address check answers "where did the
packet come from", not "who decided to send it". Those differ in exactly one
case, and it is the common one:

    A user has the dashboard running on 127.0.0.1:57374 (the default, with auth
    off by default). They browse to any other page. That page opens
    ws://127.0.0.1:57374/ws. The upgrade arrives FROM the loopback interface,
    so the peer check passes -- and CORS does not apply to WebSocket upgrades,
    so nothing else looks at it either. /ws/collab is writable.

The defense is the Origin header, which browsers always attach to a WebSocket
upgrade and which page JavaScript cannot forge. Non-browser clients (the CLI,
these tests, health probes) send no Origin at all, so absence must stay allowed
or every scripted client breaks -- and absence is safe precisely because a page
cannot produce it.

These tests assert the distinction directly: forged origin refused, allowed
origin accepted, absent origin accepted.
"""

import os
import subprocess
import sys
import textwrap

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _run_ws_case(origin_header, expect):
    """Run one WS connection attempt in a subprocess.

    Subprocess, not an in-process fixture, because dashboard/auth.py reads
    LOKI_ENTERPRISE_AUTH at import time -- the same reason the existing
    dashboard auth tests (test_control_app_auth.py, test_lab_mount_auth.py)
    isolate each case this way. importlib.reload rebinds function objects that
    already-registered routes still hold, which silently breaks the assertion.
    """
    origin_literal = repr(origin_header) if origin_header is not None else "None"
    script = textwrap.dedent(
        f"""
        import sys
        sys.path.insert(0, {REPO_ROOT!r})
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        import dashboard.server as srv

        client = TestClient(srv.app)
        headers = {{}}
        origin = {origin_literal}
        if origin is not None:
            headers["origin"] = origin

        try:
            with client.websocket_connect("/ws", headers=headers):
                print("CONNECTED")
        except WebSocketDisconnect as exc:
            print("REFUSED", exc.code)
        except Exception as exc:  # noqa: BLE001
            # A refusal may surface as a generic error depending on the
            # transport; report it rather than masking it as a pass.
            print("ERROR", type(exc).__name__, exc)
        """
    )
    env = dict(os.environ)
    env.pop("LOKI_ENTERPRISE_AUTH", None)  # the default, auth-off, is the case under test
    env.pop("LOKI_OIDC_ISSUER", None)
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, cwd=REPO_ROOT, env=env, timeout=120,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if "ModuleNotFoundError" in out or "ImportError" in out:
        pytest.skip("dashboard deps unavailable in this interpreter")
    return out


def test_forged_origin_is_refused():
    """ATTACK: a page on another origin must not open the dashboard socket."""
    out = _run_ws_case("https://evil.example.com", expect="REFUSED")
    assert "CONNECTED" not in out, (
        "CSWSH: a cross-origin browser page opened the dashboard WebSocket. "
        f"Output: {out}"
    )
    assert "REFUSED" in out or "ERROR" in out, f"Expected a refusal, got: {out}"


def test_allowed_origin_still_connects():
    """The real dashboard SPA must keep working -- a refusal that breaks the
    product is not a fix."""
    out = _run_ws_case("http://127.0.0.1:57374", expect="CONNECTED")
    assert "CONNECTED" in out, (
        f"The dashboard's own origin was refused; this would break the SPA. Output: {out}"
    )


def test_absent_origin_still_connects():
    """Non-browser clients send no Origin. Absence cannot be forged by a page,
    so it stays allowed -- otherwise the CLI, health probes and these very
    tests would all break."""
    out = _run_ws_case(None, expect="CONNECTED")
    assert "CONNECTED" in out, (
        f"A client sending no Origin was refused; this breaks scripted clients. Output: {out}"
    )
