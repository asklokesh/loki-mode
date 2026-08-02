"""The dashboard must not report a live build as STOPPED.

REPORTED FROM A REAL RUN (v8.54.0). A build launched with
`loki start <github issue>` was progressing normally -- prerequisites passed,
PRD parsed, 6 tasks extracted -- while the dashboard showed:

    SESSION: STOPPED     PHASE: BUILDING     UPTIME: 1m 14s

"STOPPED" alongside "BUILDING" and a live uptime counter is self-contradictory
on its face, and it is the first thing a user sees about their own run.

ROOT CAUSE: `server.py` computed liveness TWICE, independently -- once for the
WebSocket stream and once for REST `/api/status` (which is what the UI renders).
A prior fix added `.loki/pids/` as a third liveness source and was applied to
the WebSocket path ONLY. `/api/status` still decided from just `loki.pid` and
`session.json`, and a CLI-started run writes NEITHER (run.sh only UPDATES
session.json when it already exists). So both checks missed and the status was
hard-set to "stopped".

Two decisive symptoms, both observed:
  - ONE response contradicted itself: status "stopped" WITH active_sessions 1.
    The live session PID was found later in the same handler; `running` had been
    frozen ~120 lines earlier and never reconsidered.
  - The two live surfaces disagreed about the same run in the same second:
    the WebSocket broadcast "running" while REST returned "stopped".

THE FIX: one shared `_registry_run_alive()` called by both surfaces, so they
cannot diverge again.

THE `kind` FILTER IS LOAD-BEARING, and this file exists mostly to protect it.
`.loki/pids/` also registers the dashboard itself, the status monitor and the
resource monitor -- none of which carry a `kind`. Accepting any live pid would
let the dashboard's OWN pid prove the run alive, trading a false STOPPED for a
permanent false RUNNING. That is the worse failure: a stuck run would look
healthy forever.
"""

import json
import os
import pathlib
import tempfile
import unittest

_SERVER = pathlib.Path(__file__).resolve().parents[2] / "dashboard" / "server.py"


def _load():
    """Exec just the liveness helper and its one dependency.

    Importing server.py would pull the whole FastAPI dependency tree; the
    liveness decision is what is under test.
    """
    lines = _SERVER.read_text(encoding="utf-8").splitlines()

    def slice_fn(name):
        start = next(i for i, l in enumerate(lines) if l.startswith(f"def {name}"))
        end = next(i for i in range(start + 1, len(lines))
                   if lines[i].startswith(("def ", "@")))
        return "\n".join(lines[start:end])

    ns = {}
    exec(  # noqa: S102 - deliberate, scoped
        "import os, json\nfrom pathlib import Path as _Path\n"
        + slice_fn("_safe_json_read") + "\n" + slice_fn("_registry_run_alive"),
        ns,
    )
    return ns["_registry_run_alive"]


class RegistryLivenessTests(unittest.TestCase):
    def setUp(self):
        self.alive = _load()

    def test_live_wrapper_is_alive(self):
        """The case that was broken: a CLI run registers a wrapper pid."""
        with tempfile.TemporaryDirectory() as d:
            pids = pathlib.Path(d) / "pids"
            pids.mkdir()
            (pids / "1.json").write_text(
                json.dumps({"pid": os.getpid(), "kind": "wrapper"}))
            self.assertTrue(
                self.alive(pathlib.Path(d)),
                "a live wrapper pid was not recognised -- the dashboard would "
                "show STOPPED for a running build")

    def test_pid_without_kind_is_not_alive(self):
        """THE GUARD. The dashboard's own pid must not prove the run alive.

        `.loki/pids/` also holds the dashboard, status monitor and resource
        monitor, none carrying `kind`. Accepting them would make the status
        permanently RUNNING -- worse than the bug being fixed, because a dead or
        stuck run would look healthy forever.
        """
        with tempfile.TemporaryDirectory() as d:
            pids = pathlib.Path(d) / "pids"
            pids.mkdir()
            (pids / "dash.json").write_text(json.dumps({"pid": os.getpid()}))
            self.assertFalse(
                self.alive(pathlib.Path(d)),
                "a live pid with no 'kind' counted as the run -- the dashboard "
                "would report RUNNING forever")

    def test_dead_wrapper_is_not_alive(self):
        with tempfile.TemporaryDirectory() as d:
            pids = pathlib.Path(d) / "pids"
            pids.mkdir()
            (pids / "1.json").write_text(
                json.dumps({"pid": 999999, "kind": "wrapper"}))
            self.assertFalse(self.alive(pathlib.Path(d)))

    def test_no_registry_is_not_alive(self):
        """Absence must read as not-running, never as running."""
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(self.alive(pathlib.Path(d)))

    def test_corrupt_record_does_not_crash(self):
        """A truncated pid file must not take down the status endpoint."""
        with tempfile.TemporaryDirectory() as d:
            pids = pathlib.Path(d) / "pids"
            pids.mkdir()
            (pids / "bad.json").write_text("{not json")
            (pids / "ok.json").write_text(
                json.dumps({"pid": os.getpid(), "kind": "runner"}))
            self.assertTrue(
                self.alive(pathlib.Path(d)),
                "a corrupt sibling record suppressed a live runner")


class BothSurfacesShareOneHelperTests(unittest.TestCase):
    """WIRING. The two surfaces must not compute liveness independently again.

    The bug existed precisely because they did, and a fix applied to one.
    """

    def setUp(self):
        self.src = _SERVER.read_text(encoding="utf-8")

    def test_rest_status_consults_the_registry(self):
        self.assertGreaterEqual(
            self.src.count("_registry_run_alive("), 3,
            "expected the helper definition plus BOTH call sites; the REST and "
            "WebSocket paths must share it or they will diverge again")

    def test_the_kind_filter_is_present(self):
        self.assertIn(
            '("wrapper", "runner")', self.src,
            "the kind filter is gone -- the dashboard's own pid would prove the "
            "run alive and status would be permanently RUNNING")


if __name__ == "__main__":
    unittest.main()
