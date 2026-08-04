"""A deleted working directory must not 500 the entire dashboard API.

WHAT HAPPENED, observed in a browser console rather than a test. Every one of
~60 dashboard endpoints returned 500 simultaneously -- including /api/status,
whose handler touches almost nothing. Sixty failures, one cause.

The dashboard had been started inside a temp workspace
(/private/var/folders/.../tmp.TAj6wdzOUy/pair-sonnet) that was later cleaned
up. The process kept running with a working directory that no longer existed.

`os.getcwd()` RAISES FileNotFoundError in that state. It is not a stale-but-
usable path; it is an error at every call site. Four independent layers all
assumed it could not fail:

    dashboard/control.py   Path.cwd() in find_skill_dir()      import time
    dashboard/control.py   STATE_DIR.mkdir()                   import time
    dashboard/server.py    _Path.cwd() in _get_loki_dir()      EVERY request
    collab/presence.py     _presence_dir.mkdir()               import time
    collab/sync.py         _sync_dir.mkdir()                   import time

The relative default is what makes this reachable: LOKI_DIR is ".loki", so
every one of those paths resolves against the cwd.

WHY A LONG-LIVED SERVER MUST SURVIVE IT. A dashboard outlives the workspace it
was launched from -- that is normal for a tool you leave open. Losing the cwd
should degrade the features that need a directory, not turn the whole API into
a wall of 500s that says nothing about what broke.

The vacuity guard matters here as much as the assertion: if the fixture failed
to actually delete the directory, every check below would pass while testing
nothing.
"""

import os
import pathlib
import subprocess
import sys
import textwrap
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]

# Endpoints taken from the real console log, spanning the routers that were
# failing: status, memory, council, checklist, learning, cost, collab.
_ENDPOINTS = [
    "/api/status",
    "/api/usage",
    "/api/context",
    "/api/tasks",
    "/api/cost",
    "/api/memory/economics",
    "/api/memory/stats",
    "/api/memory/summary",
    "/api/checklist",
    "/api/checklist/summary",
    "/api/checklist/waivers",
    "/api/agents",
    "/api/council/gate",
    "/api/council/state",
    "/api/wiki",
    "/api/spec",
    "/api/escalations",
    "/api/pricing",
    "/api/app-runner/status",
    "/api/notifications",
]

# Run in a subprocess: the cwd has to be deleted out from under a LIVE process,
# and doing that in-process would break every later test in the session.
_PROBE = textwrap.dedent(
    """
    import json, os, subprocess, sys
    sys.path.insert(0, {root!r})
    sys.dont_write_bytecode = True

    subprocess.run(["rm", "-rf", {victim!r}], check=False)

    # VACUITY GUARD. If the directory survived, the run proves nothing --
    # report it rather than emitting a clean result nobody can trust.
    try:
        os.getcwd()
        print(json.dumps({{"error": "cwd still exists; fixture did not delete it"}}))
        raise SystemExit(0)
    except OSError:
        pass

    try:
        from dashboard import server
    except Exception as exc:
        print(json.dumps({{"error": "import failed: %s: %s" % (type(exc).__name__, exc)}}))
        raise SystemExit(0)

    from fastapi.testclient import TestClient
    client = TestClient(server.app, raise_server_exceptions=False)

    failures = {{}}
    for endpoint in {endpoints!r}:
        try:
            failures[endpoint] = client.get(endpoint).status_code
        except Exception as exc:
            failures[endpoint] = "raised %s" % type(exc).__name__
    print(json.dumps({{"results": failures}}))
    """
)


def _probe_with_deleted_cwd(tmp_root):
    victim = os.path.join(tmp_root, "workspace")
    os.makedirs(victim, exist_ok=True)
    code = _PROBE.format(root=str(_ROOT), victim=victim, endpoints=_ENDPOINTS)
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=victim, capture_output=True, text=True, timeout=300,
    )
    import json
    for line in reversed(proc.stdout.strip().splitlines()):
        try:
            return json.loads(line), proc
        except ValueError:
            continue
    return None, proc


class ADeletedCwdMustNotBreakTheApi(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        try:
            import fastapi  # noqa: F401
            from fastapi.testclient import TestClient  # noqa: F401
        except Exception as exc:  # pragma: no cover
            raise unittest.SkipTest("fastapi not available: %s" % exc)

        import tempfile
        cls._tmp = tempfile.mkdtemp()
        cls.payload, cls.proc = _probe_with_deleted_cwd(cls._tmp)

    def test_the_probe_actually_ran_with_a_deleted_cwd(self):
        """Vacuity guard: a probe that never reached the deleted state would
        make every assertion below pass for the wrong reason."""
        self.assertIsNotNone(
            self.payload,
            "probe emitted no JSON.\nstdout:\n%s\nstderr:\n%s"
            % (self.proc.stdout[-2000:], self.proc.stderr[-2000:]))
        self.assertNotIn(
            "error", self.payload,
            "probe could not establish the test condition: %s"
            % self.payload.get("error"))

    def test_the_module_imports_without_a_working_directory(self):
        """Import-time mkdir on a relative .loki path took the whole app down:
        one optional feature's directory killed every endpoint."""
        self.assertIsNotNone(self.payload)
        self.assertNotIn(
            "error", self.payload,
            "dashboard.server failed to import with a deleted cwd: %s"
            % self.payload.get("error"))

    def test_no_endpoint_returns_500(self):
        self.assertIsNotNone(self.payload)
        results = self.payload.get("results", {})
        self.assertTrue(results, "probe returned no endpoint results")

        broken = {ep: code for ep, code in results.items()
                  if not isinstance(code, int) or code >= 500}
        self.assertEqual(
            broken, {},
            "a deleted working directory still 500s these endpoints, which is "
            "the failure mode that produced ~60 simultaneous console errors:\n"
            + "\n".join("  %s -> %s" % (ep, code)
                        for ep, code in sorted(broken.items())))


class TheNormalCaseStillWorks(unittest.TestCase):
    """The inverse error: degrading so eagerly that a healthy server stops
    reporting real data would make the fix worse than the bug."""

    def test_status_is_served_normally(self):
        try:
            sys.path.insert(0, str(_ROOT))
            from dashboard import server
            from fastapi.testclient import TestClient
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard not importable: %s" % exc)
        client = TestClient(server.app, raise_server_exceptions=False)
        response = client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        self.assertIn("version", response.json())


if __name__ == "__main__":
    unittest.main()
