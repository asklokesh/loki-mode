"""The session timeline must render MEASURED phases, and must never invent one.

WHAT THIS GUARDS. dashboard-ui/components/loki-session-timeline.js used to
SYNTHESIZE its timeline: a hardcoded phase rotation, randomized segment
durations, rendered as history with a NOW marker and per-segment times. Its own
comment said so ("Simulate a multi-phase timeline based on iteration count").
A second fabricator, _buildDemoPhases(), painted a complete fake 4-phase
2-hour history whenever the API call FAILED, so an unreachable dashboard looked
like a healthy build.

The runtime records the real thing -- autonomy/run.sh:6562 emits phase_change
into .loki/events.jsonl -- and nothing exposed it. dashboard/api_phases.py now
does.

THE TWO HALVES BELOW.
  1. The reader, against a REAL temporary .loki tree with real event lines:
     segment boundaries must equal the fixture timestamps exactly, because an
     implementation that fabricates also renders "some segments" and only exact
     endpoints separate the two. The distinct-reason cases are asserted because
     "no data" and "could not read" rendering identically is the specific
     failure this codebase treats as worse than an error.
  2. The component source, asserting the simulation is GONE. This half is a
     source scan, so it guards its own vacuity: an unreadable or truncated file
     would otherwise pass every "does not contain" assertion silently.

WHY PYTHON AND NOT JEST. dashboard-ui declares a jest config whose testMatch is
**/tests/**/*.test.js, but jest is not installed (no node_modules/.bin/jest)
and `npm test` runs only check-parity.js. A new .test.js there would never
execute, which would leave this fix with no runnable check at all.
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

_COMPONENT = _ROOT / "dashboard-ui" / "components" / "loki-session-timeline.js"

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


class TheSimulationIsGoneFromTheComponent(unittest.TestCase):
    """Half 2: a source scan, with its own vacuity guard.

    A 'does not contain' assertion over an unreadable or truncated file passes
    while proving nothing. test_the_file_is_actually_readable is the anchor
    that makes the rest of this class non-vacuous.
    """

    @classmethod
    def setUpClass(cls):
        cls.raw = _COMPONENT.read_text(encoding="utf-8")
        # Scan CODE, not prose. The file's header documents the simulation it
        # replaced -- naming `Math.random` and `_buildPhasesFromStatus` to
        # explain the bug -- and a raw substring scan would read that
        # explanation as the defect itself. Stripping comments is what makes
        # these assertions about behavior. (Crude but sufficient: this file has
        # no regex literal or string containing '//' or '/*'.)
        no_block = re.sub(r"/\*.*?\*/", "", cls.raw, flags=re.S)
        cls.src = re.sub(r"^\s*//.*$", "", no_block, flags=re.M)

    def test_the_file_is_actually_readable_and_is_the_right_file(self):
        """VACUITY GUARD. Runs before any absence assertion means anything.

        Also asserts the comment-stripped text is still substantial: a regex
        that over-matched and blanked the file would make every 'does not
        contain' assertion below pass while proving nothing.
        """
        self.assertTrue(_COMPONENT.exists(), "%s is missing" % _COMPONENT)
        self.assertGreater(len(self.raw), 2000,
                           "component source is implausibly short; an absence "
                           "scan over it would pass vacuously")
        self.assertGreater(len(self.src), 2000,
                           "comment stripping consumed the file; the absence "
                           "assertions below would be vacuous")
        self.assertIn("loki-session-timeline", self.src,
                      "this is not the session timeline component")
        self.assertIn("class LokiSessionTimeline", self.src)

    def test_no_randomized_durations(self):
        """The clearest tell: `segmentDuration * (0.8 + Math.random() * 0.4)`."""
        self.assertNotIn(
            "Math.random", self.src,
            "the component still randomizes something; a timeline segment "
            "whose length comes from Math.random is fabricated, not measured")

    def test_no_hardcoded_phase_rotation(self):
        self.assertNotIn(
            "phaseOrder", self.src,
            "the fixed phase rotation is still present; phase names must come "
            "from the recorded phase_change events, not a literal array")

    def test_both_fabricators_are_deleted(self):
        for gone in ("_buildPhasesFromStatus", "_buildDemoPhases"):
            self.assertNotIn(
                gone, self.src,
                "%s still exists; it renders invented phases as history"
                % gone)

    def test_it_reads_the_measured_endpoint(self):
        self.assertIn(
            "/api/operator/phases", self.src,
            "the component does not read the measured phase history endpoint")

    def test_the_failure_path_does_not_fall_back_to_a_fake_timeline(self):
        """The catch branch used to call _buildDemoPhases(). It must now report
        a failure the operator can see."""
        self.assertIn("could not read phase history", self.src)

    def test_no_attribute_injects_phases_around_the_measured_path(self):
        """A third fabrication path, easy to miss because it is not a method.

        `observedAttributes` used to list 'phases', and the callback assigned
        the parsed attribute straight into this._phases -- bypassing
        _applyPhaseHistory, so caller-supplied segments rendered as measured
        history on a real time axis, unconverted and unanchored. Deleting the
        two fabricator METHODS does not close this; only removing the
        attribute does.
        """
        self.assertNotIn(
            "'phases'", self.src,
            "the 'phases' attribute is still observed; JSON assigned through "
            "it lands in this._phases without passing _applyPhaseHistory and "
            "renders as measured history")
        self.assertIn("'api-url'", self.src,
                      "sanity: the api-url attribute should still be observed")

    def test_an_unknown_phase_keeps_its_own_name(self):
        """The old lookup substituted PHASE_COLORS.idle, LABEL included, so a
        real BUILDING phase rendered as 'Idle'."""
        self.assertNotIn(
            "PHASE_COLORS.idle", self.src,
            "an unrecognized phase still falls back to the 'Idle' entry, "
            "which substitutes the label and misreports the phase")
        self.assertIn("_phaseStyle", self.src)


class TheClientRendersTheMeasuredEnvelope(unittest.TestCase):
    """Half 3: the component's own _applyPhaseHistory, EXECUTED.

    The source scan above proves the fabricators are deleted; it cannot prove
    what replaced them is right. This extracts the real method from the real
    file and runs it on a real envelope, so a unit-conversion or anchoring bug
    is caught rather than assumed absent.

    Skipped when node is unavailable. dashboard-ui has no node_modules (jest
    and jsdom are both uninstalled), so this deliberately touches no DOM: it
    exercises the pure data transform, which is where the arithmetic lives.
    """

    _PROBE = r"""
const fs = require('node:fs');
// argv[2]: argv[0] is node, argv[1] is this script.
const src = fs.readFileSync(process.argv[2], 'utf8');
// Slice the method by its indentation, not by counting braces: the body
// contains a template literal whose ${...} makes naive brace counting cut
// mid-string. A class method starts at 2-space indent and ends at the first
// line that is exactly '  }'.
const lines = src.split('\n');
const at = lines.findIndex(l => l.includes('_applyPhaseHistory(data) {'));
if (at < 0) { console.log('NOMETHOD'); process.exit(0); }
let close = -1;
for (let i = at + 1; i < lines.length; i++) {
  if (lines[i] === '  }') { close = i; break; }
}
if (close < 0) { console.log('NOMETHOD'); process.exit(0); }
const bodySrc = lines.slice(at + 1, close).join('\n');
const apply = new Function('data', bodySrc);

const T0 = 1785751200, T1 = 1785751500, T2 = 1785751680;
const ctx = {};
apply.call(ctx, {
  segments: [
    { phase: 'BUILDING',  start: T0, end: T1,   ongoing: false, iteration: 1 },
    { phase: 'VERIFYING', start: T1, end: T2,   ongoing: false, iteration: 2 },
    { phase: 'COMPLETED', start: T2, end: null, ongoing: true,  iteration: 3 },
  ],
  leading_phase: { phase: 'BOOTSTRAP', start: null, end: T0, iteration: 1 },
  reason: null, checked_at: T2 + 60, sampled: true,
});
const p = ctx._phases;
const out = {
  count: p.length,
  names: p.map(x => x.phase).join(','),
  // epoch SECONDS on the wire must become milliseconds exactly once.
  ms: p[0].start === T0 * 1000 && p[0].end === T1 * 1000,
  durations: (p[0].end - p[0].start) === 300000 && (p[1].end - p[1].start) === 180000,
  // the ongoing phase must ride the server clock, not this process's.
  anchored: p[2].end === (T2 + 60) * 1000 && p[2].ongoing === true,
  leading: ctx._leadingPhase && ctx._leadingPhase.phase,
  reasonWhenPopulated: ctx._reason,
};
const c2 = {};
apply.call(c2, { segments: [], reason: 'phase history not recorded: nothing', checked_at: T0, sampled: true });
out.emptyKeepsServerReason = c2._phases.length === 0 && /not recorded/.test(c2._reason || '');
const c3 = {};
apply.call(c3, null);
out.malformedIsReadFailure = /could not read/.test(c3._reason || '');
console.log(JSON.stringify(out));
"""

    def _run_probe(self):
        import shutil
        import subprocess
        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        probe = os.path.join(tempfile.mkdtemp(), "probe.cjs")
        with open(probe, "w") as fh:
            fh.write(self._PROBE)
        res = subprocess.run([node, probe, str(_COMPONENT)],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0,
                         "probe failed: %s" % (res.stderr or res.stdout))
        text = res.stdout.strip()
        self.assertNotEqual(
            text, "NOMETHOD",
            "_applyPhaseHistory is gone from the component; the client no "
            "longer adopts the measured envelope")
        return json.loads(text)

    def test_measured_segments_survive_the_client_transform(self):
        out = self._run_probe()
        self.assertEqual(out["count"], 3)
        self.assertEqual(out["names"], "BUILDING,VERIFYING,COMPLETED",
                         "phase names must reach the renderer verbatim; "
                         "lowercasing or relabelling is how BUILDING became "
                         "'Idle'")
        self.assertTrue(out["ms"], "epoch seconds were not converted to ms "
                                   "exactly once")
        self.assertTrue(out["durations"],
                        "segment durations no longer equal the measured "
                        "300s / 180s from the events")
        self.assertIsNone(out["reasonWhenPopulated"])

    def test_the_ongoing_phase_rides_the_server_clock(self):
        """Anchoring the running phase to Date.now() would draw a duration
        measured against a clock that never stamped the events."""
        out = self._run_probe()
        self.assertTrue(
            out["anchored"],
            "the ongoing phase is not anchored to the server's checked_at")

    def test_the_leading_phase_is_carried_but_not_drawn(self):
        out = self._run_probe()
        self.assertEqual(out["leading"], "BOOTSTRAP")

    def test_client_empty_states_stay_distinct(self):
        out = self._run_probe()
        self.assertTrue(out["emptyKeepsServerReason"],
                        "the client discarded the server's reason and would "
                        "render one generic empty state")
        self.assertTrue(out["malformedIsReadFailure"],
                        "a malformed response must read as a failed read, "
                        "not as an empty history")


if __name__ == "__main__":
    unittest.main(verbosity=2)
