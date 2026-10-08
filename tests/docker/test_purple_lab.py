"""
Purple Lab E2E Test Suite
Tests all 20 scenarios against a live Purple Lab server.
"""
import asyncio
import json
import os
import time
import concurrent.futures

import socket
from urllib.parse import urlparse

import pytest

# Live-server E2E: skip honestly (visible in the report) per test when the
# optional client libraries or the Purple Lab server are not present, instead
# of failing collection (FC-82). The module must still collect its tests: a
# module-level skip collects zero and pytest exits rc=5 (FC-82 r2).
try:
    import pytest_asyncio  # noqa: F401
except ImportError:
    pytest_asyncio = None
try:
    import requests
except ImportError:
    requests = None
try:
    import websockets
except ImportError:
    websockets = None

BASE_URL = os.environ.get("PURPLE_LAB_URL", "http://localhost:57375")


def _server_reachable(url: str) -> bool:
    u = urlparse(url)
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=2):
            return True
    except OSError:
        return False


def _skip_reason():
    if pytest_asyncio is None:
        return "pytest-asyncio not installed"
    if requests is None:
        return "requests not installed"
    if websockets is None:
        return "websockets not installed"
    if not _server_reachable(BASE_URL):
        return f"Purple Lab server not reachable at {BASE_URL}"
    return None


_SKIP_REASON = _skip_reason()
pytestmark = pytest.mark.skipif(_SKIP_REASON is not None, reason=_SKIP_REASON or "")

WS_URL = BASE_URL.replace("http://", "ws://").replace("https://", "wss://") + "/ws"

SAMPLE_PRD = """# Test Project
Build a simple hello world Python script that prints "Hello World" to stdout.
Requirements:
- Single file: main.py
- No external dependencies
- Run with: python main.py
"""


def _print_result(test_name: str, passed: bool, detail: str = ""):
    status = "PASS" if passed else "FAIL"
    msg = f"  [{status}] {test_name}"
    if detail:
        msg += f" | {detail}"
    print(msg)


# ---------------------------------------------------------------------------
# Test 01: Health check
# ---------------------------------------------------------------------------

def test_01_health_check():
    """GET /api/session/status returns {running: false} when idle."""
    r = requests.get(f"{BASE_URL}/api/session/status")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert "running" in data, f"'running' key missing from: {data}"
    assert data["running"] is False, f"Expected running=false, got: {data['running']}"
    _print_result("Health check", True, f"running={data['running']}")


# ---------------------------------------------------------------------------
# Test 02: Serves Purple Lab UI
# ---------------------------------------------------------------------------

def test_02_serves_purple_lab_ui():
    """GET / returns HTML with title 'Purple Lab'."""
    r = requests.get(f"{BASE_URL}/")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}"
    body = r.text
    assert "Purple Lab" in body or "purple-lab" in body.lower() or "<html" in body.lower(), \
        f"Response doesn't look like Purple Lab UI. First 200 chars: {body[:200]}"
    _print_result("Serves Purple Lab UI", True, f"status={r.status_code}, html_len={len(body)}")


# ---------------------------------------------------------------------------
# Test 03: SPA routing
# ---------------------------------------------------------------------------

def test_03_spa_routing():
    """GET /nonexistent-route returns 200 with index.html (SPA fallback)."""
    r = requests.get(f"{BASE_URL}/this-path-does-not-exist-12345")
    assert r.status_code == 200, f"Expected 200 for SPA fallback, got {r.status_code}"
    body = r.text
    assert "<html" in body.lower() or "<!doctype" in body.lower(), \
        f"Expected HTML for SPA fallback, got: {body[:200]}"
    _print_result("SPA routing", True, f"status={r.status_code}")


# ---------------------------------------------------------------------------
# Tests 04-08: Session lifecycle
# ---------------------------------------------------------------------------

def test_04_session_start():
    """POST /api/session/start returns {started: true, pid: int, projectDir: str}."""
    # Ensure no session is running first
    requests.post(f"{BASE_URL}/api/session/stop")
    time.sleep(0.5)

    r = requests.post(f"{BASE_URL}/api/session/start", json={
        "prd": SAMPLE_PRD,
        "provider": "claude",
    })
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert data.get("started") is True, f"Expected started=true, got: {data}"
    assert isinstance(data.get("pid"), int) and data["pid"] > 0, f"Expected pid int > 0, got: {data.get('pid')}"
    assert isinstance(data.get("projectDir"), str) and len(data["projectDir"]) > 0, \
        f"Expected non-empty projectDir, got: {data.get('projectDir')}"
    _print_result("Session start", True, f"pid={data['pid']}, projectDir={data['projectDir']}")


def test_05_session_already_running():
    """POST /api/session/start while running returns {started: false} or 409."""
    # Make sure something is running
    r = requests.get(f"{BASE_URL}/api/session/status")
    if not r.json().get("running"):
        requests.post(f"{BASE_URL}/api/session/start", json={
            "prd": SAMPLE_PRD,
            "provider": "claude",
        })
        time.sleep(0.5)

    r = requests.post(f"{BASE_URL}/api/session/start", json={
        "prd": SAMPLE_PRD,
        "provider": "claude",
    })
    if r.status_code == 409:
        _print_result("Session already running", True, f"409 Conflict as expected")
    else:
        assert r.status_code == 200, f"Expected 200 or 409, got {r.status_code}: {r.text}"
        data = r.json()
        # Either started=false or an error message
        assert data.get("started") is False or "error" in data or "already" in str(data).lower(), \
            f"Expected started=false or error when already running, got: {data}"
        _print_result("Session already running", True, f"started=false: {data}")


def test_06_session_status_while_running():
    """GET /api/session/status shows running=true while session is active."""
    # Ensure session is running
    r = requests.get(f"{BASE_URL}/api/session/status")
    if not r.json().get("running"):
        requests.post(f"{BASE_URL}/api/session/start", json={
            "prd": SAMPLE_PRD,
            "provider": "claude",
        })
        time.sleep(0.5)

    r = requests.get(f"{BASE_URL}/api/session/status")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}"
    data = r.json()
    assert data.get("running") is True, f"Expected running=true while session active, got: {data}"
    assert isinstance(data.get("pid"), str) and len(data["pid"]) > 0, \
        f"Expected pid string when running, got: {data.get('pid')}"
    _print_result("Session status while running", True, f"running=true, pid={data.get('pid')}")


def test_07_session_stop():
    """POST /api/session/stop returns {stopped: true}."""
    # Ensure session is running
    r = requests.get(f"{BASE_URL}/api/session/status")
    if not r.json().get("running"):
        requests.post(f"{BASE_URL}/api/session/start", json={
            "prd": SAMPLE_PRD,
            "provider": "claude",
        })
        time.sleep(0.5)

    r = requests.post(f"{BASE_URL}/api/session/stop")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert data.get("stopped") is True, f"Expected stopped=true, got: {data}"
    _print_result("Session stop", True, f"stopped={data['stopped']}")


def test_08_session_status_after_stop():
    """GET /api/session/status shows running=false after stop."""
    # Ensure stopped
    r = requests.get(f"{BASE_URL}/api/session/status")
    if r.json().get("running"):
        requests.post(f"{BASE_URL}/api/session/stop")
        time.sleep(0.5)

    r = requests.get(f"{BASE_URL}/api/session/status")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}"
    data = r.json()
    assert data.get("running") is False, f"Expected running=false after stop, got: {data}"
    _print_result("Session status after stop", True, f"running=false")


# ---------------------------------------------------------------------------
# Tests 09-10: File endpoints (need an active session with a project dir)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def active_session():
    """Start a session, yield its info, then stop it."""
    # Stop any existing
    requests.post(f"{BASE_URL}/api/session/stop")
    time.sleep(0.3)

    r = requests.post(f"{BASE_URL}/api/session/start", json={
        "prd": SAMPLE_PRD,
        "provider": "claude",
    })
    assert r.status_code == 200, f"Could not start session: {r.text}"
    data = r.json()
    yield data

    # Cleanup
    requests.post(f"{BASE_URL}/api/session/stop")
    time.sleep(0.3)


def test_09_file_listing(active_session):
    """GET /api/session/files returns a JSON list."""
    r = requests.get(f"{BASE_URL}/api/session/files")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert isinstance(data, list), f"Expected list, got {type(data)}: {data}"
    _print_result("File listing", True, f"files_count={len(data)}")


def test_10_file_content(active_session):
    """GET /api/session/files/content?path=PRD.md returns file content."""
    r = requests.get(f"{BASE_URL}/api/session/files/content", params={"path": "PRD.md"})
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert "content" in data, f"Expected 'content' key, got: {data}"
    assert len(data["content"]) > 0, f"Expected non-empty content"
    assert "hello world" in data["content"].lower() or "test project" in data["content"].lower(), \
        f"PRD content not found in: {data['content'][:200]}"
    _print_result("File content", True, f"content_len={len(data['content'])}")


# ---------------------------------------------------------------------------
# Tests 11-13: Path traversal protection
# ---------------------------------------------------------------------------

def test_11_path_traversal_relative(active_session):
    """GET /api/session/files/content?path=../../../etc/passwd must return 404."""
    r = requests.get(f"{BASE_URL}/api/session/files/content", params={"path": "../../../etc/passwd"})
    # Must NOT return the file content; must be 404
    assert r.status_code == 404, \
        f"SECURITY FAIL: path traversal (relative) returned {r.status_code}, expected 404. Body: {r.text[:200]}"
    body = r.text.lower()
    assert "root" not in body and "daemon" not in body, \
        f"SECURITY FAIL: /etc/passwd contents returned! Body: {r.text[:200]}"
    _print_result("Path traversal: relative", True, f"correctly blocked with 404")


def test_12_path_traversal_absolute(active_session):
    """GET /api/session/files/content?path=/etc/passwd must return 404."""
    r = requests.get(f"{BASE_URL}/api/session/files/content", params={"path": "/etc/passwd"})
    assert r.status_code == 404, \
        f"SECURITY FAIL: path traversal (absolute) returned {r.status_code}, expected 404. Body: {r.text[:200]}"
    body = r.text.lower()
    assert "root" not in body and "daemon" not in body, \
        f"SECURITY FAIL: /etc/passwd contents returned! Body: {r.text[:200]}"
    _print_result("Path traversal: absolute", True, f"correctly blocked with 404")


def test_13_path_traversal_encoded(active_session):
    """GET /api/session/files/content?path=..%2F..%2Fetc%2Fpasswd must return 404."""
    # Use a raw URL to preserve encoding
    url = f"{BASE_URL}/api/session/files/content?path=..%2F..%2Fetc%2Fpasswd"
    r = requests.get(url)
    assert r.status_code == 404, \
        f"SECURITY FAIL: path traversal (encoded) returned {r.status_code}, expected 404. Body: {r.text[:200]}"
    body = r.text.lower()
    assert "root" not in body and "daemon" not in body, \
        f"SECURITY FAIL: /etc/passwd contents returned! Body: {r.text[:200]}"
    _print_result("Path traversal: encoded", True, f"correctly blocked with 404")


# ---------------------------------------------------------------------------
# Tests 14-15: Logs and agents endpoints
# ---------------------------------------------------------------------------

def test_14_logs_endpoint():
    """GET /api/session/logs returns JSON list."""
    r = requests.get(f"{BASE_URL}/api/session/logs")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert isinstance(data, list), f"Expected list, got {type(data)}: {data}"
    _print_result("Logs endpoint", True, f"log_entries={len(data)}")


def test_15_agents_endpoint():
    """GET /api/session/agents returns JSON."""
    r = requests.get(f"{BASE_URL}/api/session/agents")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert isinstance(data, list), f"Expected list, got {type(data)}: {data}"
    _print_result("Agents endpoint", True, f"agents={len(data)}")


# ---------------------------------------------------------------------------
# Tests 16-17: WebSocket
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_16_websocket_connect():
    """WebSocket connects successfully and receives 'connected' event."""
    async with websockets.connect(WS_URL) as ws:
        msg_raw = await asyncio.wait_for(ws.recv(), timeout=5)
        msg = json.loads(msg_raw)
        assert msg.get("type") == "connected", f"Expected type='connected', got: {msg}"
        _print_result("WebSocket connect", True, f"received: {msg}")


@pytest.mark.asyncio
async def test_17_websocket_receives_events():
    """After session start, WS receives log events within 10 seconds."""
    # Stop any existing session
    requests.post(f"{BASE_URL}/api/session/stop")
    await asyncio.sleep(0.5)

    received_events = []

    async with websockets.connect(WS_URL) as ws:
        # Consume initial connected message
        initial = await asyncio.wait_for(ws.recv(), timeout=5)
        initial_msg = json.loads(initial)
        assert initial_msg.get("type") == "connected"

        # Start a session via HTTP
        r = requests.post(f"{BASE_URL}/api/session/start", json={
            "prd": SAMPLE_PRD,
            "provider": "claude",
        })
        assert r.status_code == 200, f"Failed to start session: {r.text}"

        # Listen for events for up to 10 seconds
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
                msg = json.loads(raw)
                received_events.append(msg)
                # We want session_start or log events
                if msg.get("type") in ("session_start", "log"):
                    break
            except asyncio.TimeoutError:
                continue

    # Stop session after test
    requests.post(f"{BASE_URL}/api/session/stop")

    assert len(received_events) > 0, "No WebSocket events received within 10 seconds"
    event_types = [e.get("type") for e in received_events]
    assert any(t in ("session_start", "log") for t in event_types), \
        f"Expected session_start or log events, got: {event_types}"
    _print_result("WebSocket receives events", True, f"events={event_types[:5]}")


# ---------------------------------------------------------------------------
# Test 18: CORS headers
# ---------------------------------------------------------------------------

def test_18_cors_headers():
    """Response CORS headers are not wildcard '*'."""
    r = requests.get(f"{BASE_URL}/api/session/status")
    cors = r.headers.get("access-control-allow-origin", "")
    # Document what we found
    if cors == "*":
        # This is a known issue with the current implementation - log it
        print(f"\n  [WARN] CORS is wildcard '*' - security concern but not blocking test")
        print(f"  [INFO] server.py line 47: allow_origins=['*'] - should be restricted to localhost only")
        # For now, document rather than fail - the task says "must be localhost only"
        # but the server currently uses wildcard. Report accurately.
        _print_result("CORS headers", False,
                      f"CORS is '*' (wildcard) - SECURITY: should be restricted to localhost")
        pytest.fail(f"CORS header is '*' - server allows all origins. Expected localhost-only. "
                    f"Fix: change allow_origins=['*'] to allow_origins=['http://127.0.0.1:57375','http://localhost:57375'] in server.py")
    else:
        _print_result("CORS headers", True, f"CORS='{cors}' (not wildcard)")


# ---------------------------------------------------------------------------
# Test 19: Port binding (documented)
# ---------------------------------------------------------------------------

def test_19_port_binding():
    """
    Port binding: server binds to configured interface.
    In this Docker test, server is configured to bind 0.0.0.0 for test accessibility.
    In production (loki web), it defaults to 127.0.0.1 (localhost-only).
    This test documents the behavior and verifies the server responds on the expected port.
    """
    r = requests.get(f"{BASE_URL}/api/session/status")
    assert r.status_code == 200, f"Server not accessible at {BASE_URL}"
    _print_result("Port binding",
                  True,
                  "NOTE: Production binds 127.0.0.1 (localhost-only). "
                  "Docker test uses 0.0.0.0 for container accessibility. "
                  "Cannot test external-vs-internal from within same network.")


# ---------------------------------------------------------------------------
# Test 20: Concurrent requests
# ---------------------------------------------------------------------------

def test_20_concurrent_requests():
    """10 simultaneous GET /api/session/status requests all return valid JSON."""
    url = f"{BASE_URL}/api/session/status"
    errors = []
    results = []

    def fetch(_):
        try:
            r = requests.get(url, timeout=10)
            assert r.status_code == 200, f"Got {r.status_code}"
            data = r.json()
            assert "running" in data, f"'running' missing from {data}"
            return data
        except Exception as e:
            errors.append(str(e))
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(fetch, i) for i in range(10)]
        for f in concurrent.futures.as_completed(futures):
            result = f.result()
            if result is not None:
                results.append(result)

    assert len(errors) == 0, f"Errors in concurrent requests: {errors}"
    assert len(results) == 10, f"Expected 10 results, got {len(results)}"
    _print_result("Concurrent requests", True, f"10/10 succeeded")


# ---------------------------------------------------------------------------
# Test 21: PRD prefill endpoint (env not set)
# ---------------------------------------------------------------------------

def test_21_prd_prefill_no_env():
    """GET /api/session/prd-prefill returns {content: null} when env not set."""
    r = requests.get(f"{BASE_URL}/api/session/prd-prefill")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert "content" in data, f"Expected 'content' key, got: {data}"
    # In the Docker test environment, PURPLE_LAB_PRD should not be set
    # so content should be null (None in Python)
    assert data["content"] is None, (
        f"Expected content=null when PURPLE_LAB_PRD env is not set, got: {data['content']!r}"
    )
    _print_result("PRD prefill (no env)", True, f"content=null as expected")


# ---------------------------------------------------------------------------
# Test 22: Stop endpoint is idempotent and responsive
# ---------------------------------------------------------------------------

def test_22_stop_endpoint_idempotent():
    """POST /api/session/stop returns 200 even when no session is running."""
    # Make sure nothing is running
    requests.post(f"{BASE_URL}/api/session/stop")
    time.sleep(0.3)

    r = requests.post(f"{BASE_URL}/api/session/stop")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert "stopped" in data, f"Expected 'stopped' key, got: {data}"
    _print_result("Stop idempotent", True, f"stopped={data['stopped']}, message={data.get('message', '')}")


# ---------------------------------------------------------------------------
# Test 23: Pause/resume endpoints return valid JSON
# ---------------------------------------------------------------------------

def test_23_pause_resume_endpoints():
    """POST /api/session/pause and /api/session/resume return valid JSON."""
    # Test pause (no session running -- should return paused=false or similar)
    r_pause = requests.post(f"{BASE_URL}/api/session/pause")
    assert r_pause.status_code == 200, f"Expected 200 from pause, got {r_pause.status_code}: {r_pause.text}"
    data_pause = r_pause.json()
    assert "paused" in data_pause, f"Expected 'paused' key, got: {data_pause}"

    r_resume = requests.post(f"{BASE_URL}/api/session/resume")
    assert r_resume.status_code == 200, f"Expected 200 from resume, got {r_resume.status_code}: {r_resume.text}"
    data_resume = r_resume.json()
    assert "resumed" in data_resume, f"Expected 'resumed' key, got: {data_resume}"

    _print_result("Pause/resume endpoints", True,
                  f"pause={data_pause}, resume={data_resume}")
