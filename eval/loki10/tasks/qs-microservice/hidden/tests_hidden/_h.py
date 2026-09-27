"""Shared helper for quickstart HTTP hidden tests (stdlib only).

Starts `sh start.sh` with PORT set, in its own process group, and stops only
that recorded group. Never kills by name.
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)
BASE = None


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


def req(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"} if data is not None else {}
    h.update(headers or {})
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        resp = OPENER.open(r, timeout=10)
        return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except (urllib.error.URLError, OSError) as e:
        fail("%s %s failed: %s" % (method, path, e))


def jbody(raw):
    try:
        return json.loads(raw.decode() or "null")
    except ValueError:
        fail("response is not JSON: %r" % raw[:200])


def expect(cond, msg):
    if not cond:
        fail(msg)


def _stop(p):
    for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try:
            os.killpg(p.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            p.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def run(check):
    global BASE
    if not os.path.exists("start.sh"):
        fail("start.sh not found at repo root")
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    env = dict(os.environ, PORT=str(port))
    p = subprocess.Popen(["sh", "start.sh"], env=env, start_new_session=True)
    BASE = "http://127.0.0.1:%d" % port
    try:
        deadline = time.time() + 45
        while True:
            if p.poll() is not None:
                fail("server exited early with code %s" % p.returncode)
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                if time.time() > deadline:
                    fail("server did not listen on PORT %d within 45s" % port)
                time.sleep(0.3)
        check()
    finally:
        _stop(p)
    print("PASS")
