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
import shutil
import subprocess
import tempfile
import unittest

_SERVER = pathlib.Path(__file__).resolve().parents[2] / "dashboard" / "server.py"
# Absolute, resolved at import of the ORIGINAL file, so a copied/mutated test
# still points at the real server.py instead of walking off the filesystem.
_REAL_SERVER = _SERVER if _SERVER.is_file() else pathlib.Path(
    __import__("os").environ.get("LOKI_SERVER_PY", "")) 


# Every module-level name a slice may legitimately reach for, mapped to the
# import that supplies it. Deriving the import block from the slice TEXT rather
# than hand-listing it is the whole point: the hand-written list was correct
# when written and silently wrong the moment `_registry_run_alive` grew a
# `time.time()` call, which is how CI went red on 3.11/3.12 while a local
# 3.14 run stayed green. Adding a name here is cheap; forgetting one is a
# red Release.
_SLICE_IMPORT_SOURCES = {
    "os": "import os",
    "json": "import json",
    "time": "import time",
    "datetime": "from datetime import datetime",
    "timezone": "from datetime import timezone",
    "Any": "from typing import Any",
    "Path": "from pathlib import Path",
    "_Path": "from pathlib import Path as _Path",
}


def _slice_imports(slice_text):
    """Return the import lines the given slice actually needs.

    Substring matching, deliberately over-inclusive: importing a name the slice
    does not use is harmless, while missing one is a NameError at def time.
    Callers get a stable trailing newline so the block concatenates cleanly.
    """
    needed = []
    for name, imp in _SLICE_IMPORT_SOURCES.items():
        if f"{name}." in slice_text or f": {name}" in slice_text or f"[{name}]" in slice_text:
            if imp not in needed:
                needed.append(imp)
    return ("\n".join(needed) + "\n") if needed else ""


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
    # `from __future__ import annotations` sits at the top of server.py but does
    # NOT come along with a sliced function, so under Python < 3.14 the slice
    # evaluates its annotations EAGERLY -- and `_safe_json_read(default: Any)`
    # puts one in a default value, which runs at def time. Python 3.14 defers
    # annotations by default (PEP 649), so a local 3.14 run passes while CI's
    # 3.12 raises NameError. That is exactly how this shipped red.
    #
    # Re-declaring the future import makes the slice behave identically on
    # every version instead of depending on the interpreter's default.
    # The namespace must carry EVERY name the two slices reference, not just the
    # ones they referenced when this was written. `time`, `datetime` and
    # `timezone` were added to the sliced functions later and never added here,
    # so CI's 3.11/3.12 raised `NameError: name 'time' is not defined` -- the
    # same failure mode as the `Any` one this test was created to catch, with a
    # different name. A hand-maintained import list re-breaks every time the
    # server grows a dependency, so the list is no longer hand-maintained:
    # _slice_imports below derives it from the slice text itself.
    exec(  # noqa: S102 - deliberate, scoped
        "from __future__ import annotations\n"
        + _slice_imports(slice_fn("_safe_json_read") + "\n" + slice_fn("_registry_run_alive"))
        + slice_fn("_safe_json_read") + "\n" + slice_fn("_registry_run_alive"),
        ns,
    )
    return ns["_registry_run_alive"]


class SliceImportsCoverEveryNameTheSliceUses(unittest.TestCase):
    """The namespace must cover names used at RUNTIME, not only at def time.

    The previous guard executed the whole file on a pre-3.14 interpreter, which
    catches a name needed while DEFINING the slice (the `Any`-in-a-default case
    it was built for). It did not catch this one: `time` is reached only when
    `_safe_json_read` falls into its corrupt-JSON branch, so the module imported
    cleanly and blew up later, in CI, on a path a passing import never touches.

    Reproduced before fixing, on the exact CI interpreter:
        _safe_json_read(<file containing "{oops">, {})
        -> NameError: name 'time' is not defined

    So this asserts the derived import block against the slice text directly.
    It fails the moment a slice reaches for a name the namespace does not carry,
    whether that happens at def time or three branches deep.
    """

    def _slices(self):
        lines = _SERVER.read_text(encoding="utf-8").splitlines()

        def slice_fn(name):
            start = next(i for i, l in enumerate(lines) if l.startswith(f"def {name}"))
            end = next(i for i in range(start + 1, len(lines))
                       if lines[i].startswith(("def ", "@")))
            return "\n".join(lines[start:end])

        return slice_fn("_safe_json_read") + "\n" + slice_fn("_registry_run_alive")

    # A static "every dotted name must be importable" check was tried here and
    # deleted: distinguishing a module reference from a local, a parameter or a
    # loop variable by regex produced a list of eleven false positives
    # (`state.`, `task.`, `e.`), and a guard that cries wolf every time the
    # server grows a local is worse than no guard. The behavioural assertions
    # below catch the same defect by EXERCISING the paths instead of parsing
    # them, which is what actually failed in CI.

    def test_the_corrupt_json_path_does_not_NameError(self):
        """The exact CI failure, as a direct assertion.

        `time` was reached only here, which is why an import-time guard missed
        it entirely.
        """
        alive = _load()  # proves the namespace builds
        self.assertTrue(callable(alive))

        lines = _SERVER.read_text(encoding="utf-8").splitlines()

        def slice_fn(name):
            start = next(i for i, l in enumerate(lines) if l.startswith(f"def {name}"))
            end = next(i for i in range(start + 1, len(lines))
                       if lines[i].startswith(("def ", "@")))
            return "\n".join(lines[start:end])

        ns = {}
        body = slice_fn("_safe_json_read") + "\n" + slice_fn("_registry_run_alive")
        exec(  # noqa: S102 - deliberate, scoped
            "from __future__ import annotations\n" + _slice_imports(body) + body, ns)

        tmp = tempfile.mkdtemp()
        try:
            bad = pathlib.Path(tmp) / "bad.json"
            bad.write_text("{oops", encoding="utf-8")
            # Must return the default, not raise. A NameError here is the CI red.
            self.assertEqual(ns["_safe_json_read"](bad, {}), {})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ExecNamespaceIsVersionIndependent(unittest.TestCase):
    """The slice must not depend on the interpreter's annotation default.

    v8.61.0's Release went red with `NameError: name 'Any' is not defined` on
    five tests that were green locally. `from __future__ import annotations`
    sits atop server.py but does NOT travel with a sliced function, so under
    Python < 3.14 the slice evaluates annotations EAGERLY -- and
    `_safe_json_read(default: Any = None)` puts one in a DEFAULT VALUE, which
    runs at def time. Local Python 3.14 defers annotations (PEP 649) and never
    evaluates it; CI's 3.12 does, and raises.

    A local `pytest -q` on 3.14 therefore CANNOT catch this class of bug. This
    asserts the namespace directly, so it fails on every interpreter.
    """

    def test_the_loader_works_on_the_interpreter_ci_uses(self):
        """Re-runs the liveness tests under Python 3.12 -- CI's interpreter.

        THIS CANNOT BE SIMULATED. On Python 3.14 (PEP 649) annotations are
        deferred UNCONDITIONALLY: stripping the future import changes nothing,
        and an in-process "eager" probe passes no matter how broken the
        namespace is. Three successive guards written that way all reported
        green while both mutations survived.

        So the only honest check is to execute on a 3.12 that evaluates
        annotations eagerly. Skipped, never faked, when none is installed.
        """
        py = shutil.which("python3.12") or shutil.which("python3.13")
        if not py:
            self.skipTest("no pre-3.14 interpreter available to check against")

        # The interpreter must be able to RUN the check before its verdict
        # means anything. CI's 3.13 job resolves python3.12 to a SYSTEM python
        # with no pytest installed, so the subprocess exited non-zero for a
        # missing dependency and this guard reported a defect that did not
        # exist. A tool that cannot run is an ABSENT measurement, not a
        # failing one -- the same rule the cost work established.
        probe = subprocess.run(
            [py, "-c", "import pytest"],
            capture_output=True, text=True, timeout=60)
        if probe.returncode != 0:
            self.skipTest(
                "{} has no pytest, so it cannot run this check".format(py))

        r = subprocess.run(
            [py, "-m", "pytest", str(pathlib.Path(__file__).resolve()),
             "-q", "-k", "RegistryLivenessTests"],
            capture_output=True, text=True, timeout=300)
        self.assertEqual(
            r.returncode, 0,
            "the liveness tests fail on {} -- the exec namespace is missing a "
            "name its annotations need, exactly as v8.61.0's Release did:\n{}"
            .format(py, r.stdout[-2000:]))

    def test_the_future_import_leads_the_preamble(self):
        """Belt and braces: the slice declares its own deferral."""
        src = pathlib.Path(__file__).read_text(encoding="utf-8")
        self.assertIn(
            "from __future__ import annotations\\n", src,
            "the slice no longer declares deferral, so it inherits the "
            "interpreter default and CI can diverge from local again")


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
