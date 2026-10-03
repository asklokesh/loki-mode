"""The session timeline must render MEASURED phases, and must never invent one.

WHAT THIS GUARDS. The legacy dashboard session timeline (removed in CPE-24)
used to SYNTHESIZE its timeline: a hardcoded phase rotation and randomized
segment durations, rendered as history. A second fabricator painted a fake
4-phase history whenever the API call FAILED.

The runtime records the real thing -- autonomy/run.sh:6562 emits phase_change
into .loki/events.jsonl -- and nothing exposed it. dashboard/api_phases.py now
does.

THE READER is tested against a REAL temporary .loki tree with real event
lines: segment boundaries must equal the fixture timestamps exactly, because an
implementation that fabricates also renders "some segments" and only exact
endpoints separate the two. The distinct-reason cases are asserted because
"no data" and "could not read" rendering identically is the specific failure
this codebase treats as worse than an error.
"""

import json
import os
import pathlib
import re
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Real timestamps, real spacing. BOOTSTRAP -> BUILDING at T0, BUILDING ->
# VERIFYING 5 minutes later, VERIFYING -> COMPLETED 3 minutes after that.
# UPPERCASE on purpose: these are the values _advance_current_phase actually
# writes (autonomy/run.sh:6229, :25537, :25645), and the old lowercase-keyed
# color lookup rendered every one of them as "Idle".
_T0 = "2026-08-03T10:00:00Z"
_T1 = "2026-08-03T10:05:00Z"
_T2 = "2026-08-03T10:08:00Z"

# Computed independently of the module under test (stdlib datetime, not
# api_phases._parse_ts) so a bug in the parser cannot agree with itself.
_EPOCH = {
    _T0: 1785751200.0,
    _T1: 1785751500.0,
    _T2: 1785751680.0,
}


def _event(ts, frm, to, iteration):
    return json.dumps({
        "timestamp": ts,
        "type": "phase_change",
        "data": {"from": frm, "to": to, "iteration": iteration},
    })


def _workspace(lines=None, write_events=True):
    """A real .loki tree. `lines` are written verbatim to events.jsonl."""
    d = tempfile.mkdtemp()
    loki = os.path.join(d, ".loki")
    os.makedirs(loki, exist_ok=True)
    if write_events:
        with open(os.path.join(loki, "events.jsonl"), "w") as fh:
            for line in (lines or []):
                fh.write(line + "\n")
    return loki


def _real_history(loki):
    from dashboard import api_phases
    return api_phases.phase_history(loki)


class MeasuredPhasesComeFromRealEvents(unittest.TestCase):
    """Half 1a: the happy path, asserted on EXACT boundaries."""

    def setUp(self):
        self.loki = _workspace([
            _event(_T0, "BOOTSTRAP", "BUILDING", 1),
            _event(_T1, "BUILDING", "VERIFYING", 2),
            _event(_T2, "VERIFYING", "COMPLETED", 3),
            # An unrelated event type on the same log must not become a phase.
            json.dumps({"timestamp": _T1, "type": "iteration_complete",
                        "data": {"iteration": 2}}),
        ])

    def test_one_segment_per_event_no_more_no_less(self):
        """A fabricator produces a segment count driven by iteration count
        rather than by the record. Three events must give exactly three."""
        out = _real_history(self.loki)
        self.assertEqual(
            len(out["segments"]), 3,
            "expected exactly one segment per phase_change event; got %d: %r"
            % (len(out["segments"]), out["segments"]))
        self.assertIsNone(out["reason"],
                          "a populated history must carry no empty-reason")

    def test_phase_names_are_verbatim_from_the_event(self):
        out = _real_history(self.loki)
        self.assertEqual([s["phase"] for s in out["segments"]],
                         ["BUILDING", "VERIFYING", "COMPLETED"])

    def test_segment_boundaries_equal_the_fixture_timestamps_exactly(self):
        """The load-bearing assertion. Endpoints must be the event instants and
        nothing else -- no duration model, no randomization, no uptime
        arithmetic. Exactness is what a fabricating implementation cannot
        reproduce."""
        out = _real_history(self.loki)
        seg = out["segments"]
        self.assertEqual(seg[0]["start"], _EPOCH[_T0])
        self.assertEqual(seg[0]["end"], _EPOCH[_T1])
        self.assertEqual(seg[1]["start"], _EPOCH[_T1])
        self.assertEqual(seg[1]["end"], _EPOCH[_T2])
        self.assertEqual(seg[2]["start"], _EPOCH[_T2])
        # Measured 5 minutes and 3 minutes, from the record.
        self.assertEqual(seg[0]["end"] - seg[0]["start"], 300.0)
        self.assertEqual(seg[1]["end"] - seg[1]["start"], 180.0)

    def test_the_final_phase_has_no_invented_end(self):
        """The run's last phase is still going; its end was never emitted.
        Reporting a number here would be the fabrication in miniature."""
        out = _real_history(self.loki)
        last = out["segments"][-1]
        self.assertIsNone(last["end"], "the ongoing phase must not carry an end")
        self.assertTrue(last["ongoing"])
        self.assertIsNotNone(out["checked_at"],
                             "the caller needs a server anchor for the "
                             "ongoing phase instead of a browser clock")

    def test_the_opening_phase_is_named_but_has_no_invented_start(self):
        """BOOTSTRAP demonstrably ran, but the emitter fires only on a CHANGE,
        so its start is unmeasured. It must be reported, with start None."""
        out = _real_history(self.loki)
        self.assertIsNotNone(out["leading_phase"])
        self.assertEqual(out["leading_phase"]["phase"], "BOOTSTRAP")
        self.assertIsNone(out["leading_phase"]["start"],
                          "an unrecorded start must read unknown, never a "
                          "back-computed number")
        self.assertNotIn("BOOTSTRAP", [s["phase"] for s in out["segments"]],
                         "the leading phase must not be drawn as a segment "
                         "with a manufactured start")

    def test_iteration_absent_reads_unknown_never_zero(self):
        loki = _workspace([
            json.dumps({"timestamp": _T0, "type": "phase_change",
                        "data": {"from": "BOOTSTRAP", "to": "BUILDING"}}),
        ])
        out = _real_history(loki)
        self.assertIsNone(out["segments"][0]["iteration"],
                          "an absent iteration must be None, not 0")


class EmptyStatesStateTheirReason(unittest.TestCase):
    """Half 1b: 'no data' and 'could not read' must never be the same."""

    def test_missing_file_says_the_file_does_not_exist(self):
        loki = _workspace(write_events=False)
        out = _real_history(loki)
        self.assertEqual(out["segments"], [])
        self.assertIsNotNone(out["reason"])
        self.assertIn("does not exist", out["reason"])

    def test_file_without_phase_changes_says_not_recorded(self):
        loki = _workspace([
            json.dumps({"timestamp": _T0, "type": "iteration_start",
                        "data": {"iteration": 1}}),
        ])
        out = _real_history(loki)
        self.assertEqual(out["segments"], [])
        self.assertIn("no phase_change events", out["reason"])

    def test_the_two_empty_reasons_are_distinguishable(self):
        """The project rule, asserted directly: a UI given these two envelopes
        must be able to say WHY, so the strings cannot coincide."""
        absent = _real_history(_workspace(write_events=False))["reason"]
        empty = _real_history(_workspace([]))["reason"]
        self.assertNotEqual(
            absent, empty,
            "a missing log and an empty log produced identical reasons; the "
            "UI cannot then distinguish 'no data' from 'could not read'")

    def test_an_unreadable_log_is_not_reported_as_an_empty_one(self):
        """The `except OSError` branch, actually EXECUTED.

        This is the branch whose entire reason for existing is that a broken
        read must not render as a healthy empty workspace, and it is the
        easiest one to leave permanently untested. Triggered portably by
        making events.jsonl a DIRECTORY: os.path.exists is True, so the
        'missing file' branch is skipped, and open() raises IsADirectoryError.
        """
        loki = _workspace(write_events=False)
        os.makedirs(os.path.join(loki, "events.jsonl"))
        out = _real_history(loki)
        self.assertEqual(out["segments"], [])
        self.assertIn("could not read", out["reason"])
        # And it must differ from BOTH other empty reasons, or the UI is back
        # to one indistinguishable blank state for three different causes.
        self.assertNotIn("does not exist", out["reason"])
        self.assertNotIn("no phase_change events", out["reason"])

    def test_a_torn_final_line_does_not_erase_the_history_behind_it(self):
        """events.jsonl has concurrent shell appenders, so a partial last line
        is normal. It must not blank the measured phases before it."""
        loki = _workspace([
            _event(_T0, "BOOTSTRAP", "BUILDING", 1),
            '{"timestamp":"2026-08-03T10:05:00Z","type":"phase_ch',
        ])
        out = _real_history(loki)
        self.assertEqual(len(out["segments"]), 1)
        self.assertEqual(out["segments"][0]["phase"], "BUILDING")


class TheRouteIsMountedAndScoped(unittest.TestCase):
    """A reader nothing can reach is the bug api_operator.py exists to fix."""

    def test_route_is_reachable_on_the_real_app_and_carries_a_dependency(self):
        """Reachability, NOT membership of app.routes.

        app.routes is a FastAPI implementation detail that CHANGED: through
        0.128 include_router copied each route in, from 0.141 it appends ONE
        lazy _IncludedRouter wrapper and resolves at request time. CI installs
        0.141.1, so enumerating app.routes reports a perfectly working mount as
        missing -- which is exactly how this test failed on all four Python
        versions at 8c994558, hours after the same trap had already been fixed
        in the sibling route tests.

        The auth dependency is checked on the ROUTER, which holds the
        declaration regardless of how the app chooses to store it.
        """
        try:
            from dashboard import server
            from starlette.testclient import TestClient
        except Exception as exc:
            self.skipTest("dashboard.server/starlette not importable: %s" % exc)

        os.environ["LOKI_ENTERPRISE_AUTH"] = "false"
        try:
            from dashboard import auth as _auth
            _auth.ENTERPRISE_AUTH_ENABLED = False
            _auth.OIDC_ENABLED = False
        except Exception:
            pass

        r = TestClient(server.app, raise_server_exceptions=False).get(
            "/api/operator/phases")
        self.assertNotEqual(
            r.status_code, 404,
            "/api/operator/phases returned 404 on the real app; the reader "
            "behind it is unreachable by any user")

        from dashboard.api_operator import router as _router
        declared = [x for x in _router.routes
                    if getattr(x, "path", "") == "/api/operator/phases"]
        self.assertTrue(declared, "the route is not declared on the router")
        self.assertTrue(
            getattr(declared[0], "dependencies", None),
            "/api/operator/phases carries no auth dependency; "
            "test_all_data_gets_scoped.py exists for exactly this")

    def test_envelope_survives_the_http_layer(self):
        try:
            from fastapi import FastAPI
            from starlette.testclient import TestClient
        except Exception as exc:
            self.skipTest("fastapi/starlette unavailable: %s" % exc)
        loki = _workspace([_event(_T0, "BOOTSTRAP", "BUILDING", 1)])
        os.environ["LOKI_DIR"] = loki
        from dashboard.api_operator import router
        app = FastAPI()
        app.include_router(router)
        body = TestClient(app).get("/api/operator/phases").json()
        # reason/source/freshness_s must not be unwrapped away for convenience.
        for key in ("segments", "reason", "source", "freshness_s",
                    "checked_at", "leading_phase", "sampled"):
            self.assertIn(key, body,
                          "%s was dropped crossing the HTTP layer" % key)
        self.assertEqual(body["segments"][0]["phase"], "BUILDING")


if __name__ == "__main__":
    unittest.main(verbosity=2)
