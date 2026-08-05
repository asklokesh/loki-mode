"""dashboard/api_tests.py must never turn "we did not run it" into "it passed".

This is the fake-green defect, aimed at the one surface where it does the most
damage: the gate readout itself. A gate that did not run is not a gate that
passed, and there are three distinct ways the engine's own artifacts destroy
that distinction if a reader is naive.

THE THREE UNMEASURED SHAPES, all tested, because only the first is obvious:

  1. no artifact on disk at all            -> passed is None
  2. pass is the STRING "inconclusive"     -> passed is None
  3. status is not_run / no_tests_run      -> passed is None

Shape 2 is the real one. Both writers can emit `pass` as bool true, bool false,
or the string "inconclusive" (autonomy/run.sh:11563 for a project with no test
runner, run.sh:11642 for the #82 downgrade when a runner exits 0 having
executed zero tests). A reader that writes `if rec.get("pass")` renders that
string as PASSED, because a non-empty string is truthy -- so a test covering
only shape 1 passes against an implementation that still green-washes a project
whose tests never ran. Shape 3 is the same hazard reached through `status`.

Two cases assert the OPPOSITE direction -- a genuine green suite must read
True, a genuine red suite must read False -- because a guard so strict it
blanked every real result would also pass a one-directional test.

FIXTURES ARE BUILT FROM THE WRITERS. The artifacts do not exist on disk in this
worktree, so every fixture below is the literal JSON emitted by the heredoc /
printf at the run.sh line named in its docstring. No field is invented; a
schema guess would make green here mean nothing.

EVERY assertion about content is preceded by a VACUITY GUARD. A fixture that
silently wrote nothing makes `for row in rows:` pass with zero iterations, and
"no suite reads passed" is trivially true over an empty list. An empty result is
not evidence; it is an absent measurement.

Fixtures are built in tmp_path. Nothing here reads or writes the real .loki/.
"""

from __future__ import annotations

import importlib.util
import json
import os

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))


def _load_module():
    """Import dashboard/api_tests.py by path.

    Loaded directly rather than as `dashboard.api_tests` so this test never
    drags in dashboard/__init__.py, server.py or the SQLAlchemy models. The
    module under test is pure functions over a directory; the test should fail
    for its own reasons, not for a FastAPI import error. Same loader as
    tests/dashboard/test_api_runs.py.
    """
    path = os.path.join(_REPO, "dashboard", "api_tests.py")
    assert os.path.isfile(path), "module under test missing at %s" % path
    spec = importlib.util.spec_from_file_location("loki_api_tests_undertest", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


api_tests = _load_module()


# ---------------------------------------------------------------------------
# fixture builders -- each mirrors ONE writer in autonomy/run.sh
# ---------------------------------------------------------------------------

def _quality_dir(tmp_path):
    """(loki_dir_str, quality_path). parents=True so callers can pass a
    subdirectory of tmp_path and get two independent fixtures in one test."""
    loki = tmp_path / ".loki"
    (loki / "quality").mkdir(parents=True, exist_ok=True)
    return str(loki), loki / "quality"


def _write(path, payload):
    path.write_text(json.dumps(payload), encoding="utf-8")


def _tests_green():
    """The real-runner writer, green. autonomy/run.sh:11642.

    pass is the BOOL true here; _tr_pass_json interpolates $test_passed
    unquoted, so a passing run emits a JSON bool, not a string.
    """
    return {
        "timestamp": "2026-08-02T10:00:00Z",
        "runner": "pytest",
        "pass": True,
        "min_coverage": 70,
        "summary": "12 passed in 0.42s",
        "command": "pytest",
        "exit_code": 0,
        "status": "verified",
        "passed_count": 12,
        "failed_count": None,
        "verification_gap": "none",
    }


def _tests_red():
    """The real-runner writer, red. autonomy/run.sh:11642, test_passed=false."""
    return {
        "timestamp": "2026-08-02T10:00:00Z",
        "runner": "pytest",
        "pass": False,
        "min_coverage": 70,
        "summary": "3 failed, 9 passed in 0.51s",
        "command": "pytest",
        "exit_code": 1,
        "status": "failed",
        "passed_count": 9,
        "failed_count": 3,
        "verification_gap": "none",
    }


def _tests_no_runner():
    """The no-runner writer. autonomy/run.sh:11563.

    THE case this module exists for: pass is the literal STRING
    "inconclusive", not a bool. Counts are null, never 0.
    """
    return {
        "timestamp": "2026-08-02T10:00:00Z",
        "runner": "none",
        "pass": "inconclusive",
        "summary": "Source present but no runnable tests detected (unverified logic)",
        "command": None,
        "exit_code": None,
        "status": "not_run",
        "passed_count": None,
        "failed_count": None,
        "verification_gap": "source_without_tests",
    }


def _tests_zero_executed():
    """The #82 zero-tests-executed downgrade. autonomy/run.sh:11642.

    A runner EXITED 0 but ran no real tests, so the writer replaces pass:true
    with the string "inconclusive" and status with no_tests_run. exit_code
    stays 0, which is precisely why exit code alone cannot be trusted.
    """
    return {
        "timestamp": "2026-08-02T10:00:00Z",
        "runner": "jest",
        "pass": "inconclusive",
        "min_coverage": 70,
        "summary": "No tests found, exiting with code 0",
        "command": "jest",
        "exit_code": 0,
        "status": "no_tests_run",
        "passed_count": None,
        "failed_count": None,
        "verification_gap": "source_without_runnable_tests",
    }


def _static_analysis(findings=0):
    """autonomy/run.sh:10442."""
    return {
        "timestamp": "2026-08-02T10:00:00Z",
        "files_checked": 24,
        "findings": findings,
        "summary": "eslint: clean. " if not findings else "eslint: 2 errors. ",
        "pass": findings == 0,
    }


def _build(status="verified"):
    """autonomy/run.sh:9811. No `pass` key at all -- outcome is `status`."""
    return {
        "timestamp": "2026-08-02T10:00:00Z",
        "command": "npm run build" if status != "not_applicable" else "",
        "ran": status in ("verified", "failed"),
        "applicable": status != "not_applicable",
        "exit_code": 0 if status == "verified" else (1 if status == "failed" else None),
        "duration_sec": None,
        "status": status,
    }


def _coverage(measured=False):
    """autonomy/run.sh:11706 / 11734 (the default-off writer)."""
    if measured:
        return {
            "measured": True, "pct": 87.5, "tool": "pytest-cov", "runner": "pytest",
            "threshold": 70, "enforced": False, "blocked": False, "reason": "",
            "timestamp": "2026-08-02T10:00:00Z",
        }
    return {
        "measured": False, "pct": None, "tool": "none", "runner": "pytest",
        "threshold": 70, "enforced": False, "blocked": False,
        "reason": "not requested (set LOKI_COVERAGE_GATE=1 to measure)",
        "timestamp": "2026-08-02T10:00:00Z",
    }


def _rows_by_suite(envelope):
    """Rows keyed by suite name, with the VACUITY GUARD applied.

    Every content assertion in this file goes through here, so no assertion can
    be trivially satisfied by an envelope that produced no rows at all.
    """
    items = envelope.get("items")
    assert isinstance(items, list), "envelope has no items list: %r" % (envelope,)
    assert items, "VACUITY: fixture produced ZERO rows; every later assertion would be vacuous"
    by_name = {r["suite"]: r for r in items}
    assert "tests" in by_name, "VACUITY: no tests row in %r" % (sorted(by_name),)
    return by_name


# ---------------------------------------------------------------------------
# shape 1: nothing on disk
# ---------------------------------------------------------------------------

def test_absent_artifacts_read_unknown_never_passed(tmp_path):
    """No quality artifacts at all: every suite UNKNOWN, with a reason.

    The rows must still be RETURNED -- a dashboard that drops the row cannot
    show the operator that a gate is missing, which is the fact that matters.
    """
    loki, _q = _quality_dir(tmp_path)
    env = api_tests.list_test_results(loki)
    rows = _rows_by_suite(env)

    for name, row in rows.items():
        assert row["passed"] is None, "%s read %r with no artifact on disk" % (name, row["passed"])
        assert row["passed"] is not False, "%s must be UNKNOWN, not a recorded failure" % name
        assert row["recorded"] is False
        assert row["reason"], "%s is UNKNOWN with no reason given" % name

    assert env["reason"], "empty result carries no reason"
    assert env["freshness_s"] is None, "nothing contributed, so freshness must be None not 0"


def test_no_loki_dir_reports_reason(tmp_path):
    env = api_tests.list_test_results(str(tmp_path / "does-not-exist"))
    assert env["items"] == []
    assert env["latest"] is None
    assert env["reason"] and "no .loki directory" in env["reason"]


# ---------------------------------------------------------------------------
# shape 2: pass is the STRING "inconclusive" -- the discriminating case
# ---------------------------------------------------------------------------

def test_inconclusive_string_is_not_a_pass(tmp_path):
    """pass="inconclusive" must read UNKNOWN, not True.

    THE test that discriminates a correct reader. "inconclusive" is a truthy
    non-empty string, so `if rec.get("pass")` renders a project whose tests
    NEVER RAN as passing. The writer at run.sh:11563 emits exactly this.
    """
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_no_runner())

    env = api_tests.list_test_results(loki)
    row = _rows_by_suite(env)["tests"]

    assert row["recorded"] is True, "VACUITY: fixture was not read back at all"
    assert row["passed"] is not True, "pass='inconclusive' was green-washed into a PASS"
    assert row["passed"] is None, "expected UNKNOWN, got %r" % (row["passed"],)
    assert row["status"] == "not_run"
    assert row["reason"], "an inconclusive suite must say why it is UNKNOWN"
    assert row["runner"] == "none"
    assert row["trustworthy"] is False


def test_each_fake_green_guard_is_independently_load_bearing(tmp_path):
    """Isolates the two guards so neither can mask the other's removal.

    FOUND BY MUTATION TESTING, and the reason this test exists. api_tests has
    TWO defenses against a truthy "inconclusive": the identity comparison in
    _passed(), and the _GAP_STATUSES override on `status`. Every fixture drawn
    from a real writer trips BOTH at once (run.sh always pairs
    pass="inconclusive" with status not_run / no_tests_run), so deleting either
    guard alone left all sixteen tests green -- each defense was hiding the
    other's absence, and neither was actually under test.

    These two records are deliberately NOT what run.sh emits today. Each
    isolates one guard by satisfying the other, so a mutant that removes one
    defense fails here. They are the honest answer to "which line is load
    bearing", not a claim about the writer's current output.
    """
    # (a) pass="inconclusive" with an INNOCENT status -> only _passed() can save it.
    loki_a, qa = _quality_dir(tmp_path / "a")
    rec_a = _tests_green()
    rec_a["pass"] = "inconclusive"
    rec_a["status"] = "verified"
    _write(qa / "test-results.json", rec_a)
    row_a = _rows_by_suite(api_tests.list_test_results(loki_a))["tests"]
    assert row_a["recorded"] is True, "VACUITY: fixture (a) was not read back"
    assert row_a["passed"] is None, (
        "the string 'inconclusive' was truth-tested into %r; _passed() must "
        "compare identity against the bools" % (row_a["passed"],)
    )

    # (b) pass=true with a GAP status -> only the _GAP_STATUSES override can save it.
    loki_b, qb = _quality_dir(tmp_path / "b")
    rec_b = _tests_green()
    rec_b["status"] = "no_tests_run"
    _write(qb / "test-results.json", rec_b)
    row_b = _rows_by_suite(api_tests.list_test_results(loki_b))["tests"]
    assert row_b["recorded"] is True, "VACUITY: fixture (b) was not read back"
    assert row_b["passed"] is None, (
        "status 'no_tests_run' read as %r; a gate that ran zero tests is not a "
        "gate that passed" % (row_b["passed"],)
    )


def test_zero_tests_executed_is_not_a_pass(tmp_path):
    """exit_code 0 plus status no_tests_run must still read UNKNOWN.

    The #82 case: a runner exited 0 having executed zero tests. Trusting the
    exit code alone reports a verified suite that proved nothing.
    """
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_zero_executed())

    env = api_tests.list_test_results(loki)
    row = _rows_by_suite(env)["tests"]

    assert row["recorded"] is True, "VACUITY: fixture was not read back at all"
    assert row["exit_code"] == 0, "fixture must carry the misleading green exit code"
    assert row["passed"] is None, "a zero-test run read %r, not UNKNOWN" % (row["passed"],)
    assert row["status"] == "no_tests_run"
    assert row["verification_gap"] == "source_without_runnable_tests"
    assert row["trustworthy"] is False


# ---------------------------------------------------------------------------
# the opposite direction: real outcomes must survive
# ---------------------------------------------------------------------------

def test_green_suite_reads_passed(tmp_path):
    """A genuinely green suite must read True. Guards over-strictness."""
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())

    env = api_tests.list_test_results(loki)
    row = _rows_by_suite(env)["tests"]

    assert row["recorded"] is True, "VACUITY: fixture was not read back at all"
    assert row["passed"] is True, "a real green suite was blanked to %r" % (row["passed"],)
    assert row["status"] == "verified"
    assert row["reason"] is None, "a decided outcome must not carry a reason"
    assert row["trustworthy"] is True, "runner+command+exit_code 0 is the engine's own evidence bar"
    assert row["passed_count"] == 12
    assert row["min_coverage"] == 70
    assert env["latest"]["suite"] == "tests", "latest must be the test axis"
    assert env["reason"] is None


def test_red_suite_reads_failed(tmp_path):
    """A red suite must read False -- not UNKNOWN, which would hide a failure."""
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_red())

    env = api_tests.list_test_results(loki)
    row = _rows_by_suite(env)["tests"]

    assert row["recorded"] is True, "VACUITY: fixture was not read back at all"
    assert row["passed"] is False, "a red suite read %r instead of False" % (row["passed"],)
    assert row["status"] == "failed"
    assert row["failed_count"] == 3
    assert row["trustworthy"] is False, "a failing suite is not passing evidence"


def test_unparseable_counts_stay_none_never_zero(tmp_path):
    """passed_count/failed_count null must survive as None, not become 0.

    The writer emits null when the runner's summary line could not be parsed.
    Rendering that as 0 claims "zero failures", which is a measurement we did
    not take.
    """
    loki, q = _quality_dir(tmp_path)
    rec = _tests_green()
    rec["passed_count"] = None
    rec["failed_count"] = None
    _write(q / "test-results.json", rec)

    row = _rows_by_suite(api_tests.list_test_results(loki))["tests"]
    assert row["recorded"] is True, "VACUITY: fixture was not read back at all"
    assert row["passed_count"] is None, "unparseable count became %r" % (row["passed_count"],)
    assert row["failed_count"] is None, "unparseable count became %r" % (row["failed_count"],)


# ---------------------------------------------------------------------------
# shape 3: the sibling axes
# ---------------------------------------------------------------------------

def test_build_not_run_is_not_a_pass(tmp_path):
    """build status not_run is an honest gap, not a pass.

    The build writer has no `pass` key, so a reader that looks only for one
    would treat every build row as absent -- or worse, default it to green.
    """
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    _write(q / "build-results.json", _build(status="not_run"))

    rows = _rows_by_suite(api_tests.list_test_results(loki))
    build = rows["build"]
    assert build["recorded"] is True, "VACUITY: build fixture was not read back"
    assert build["passed"] is None, "build not_run read %r" % (build["passed"],)
    assert build["reason"]


def test_build_and_static_analysis_outcomes_survive(tmp_path):
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    _write(q / "static-analysis.json", _static_analysis(findings=0))
    _write(q / "build-results.json", _build(status="verified"))

    rows = _rows_by_suite(api_tests.list_test_results(loki))
    assert len(rows) == 3, "expected one row per axis, got %r" % (sorted(rows),)
    assert rows["static_analysis"]["passed"] is True
    assert rows["static_analysis"]["findings"] == 0
    assert rows["build"]["passed"] is True

    failing = _static_analysis(findings=2)
    _write(q / "static-analysis.json", failing)
    rows = _rows_by_suite(api_tests.list_test_results(loki))
    assert rows["static_analysis"]["passed"] is False
    assert rows["static_analysis"]["findings"] == 2


# ---------------------------------------------------------------------------
# coverage: unmeasured is never zero percent
# ---------------------------------------------------------------------------

def test_unmeasured_coverage_is_none_not_zero(tmp_path):
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    _write(q / "coverage.json", _coverage(measured=False))

    cov = api_tests.list_test_results(loki)["coverage"]
    assert cov is not None, "VACUITY: coverage was not read at all"
    assert cov["measured"] is False
    assert cov["pct"] is None, "unmeasured coverage rendered as %r" % (cov["pct"],)
    assert cov["pct"] != 0, "unmeasured coverage must never read as 0 percent"
    assert cov["reason"]


def test_measured_coverage_survives(tmp_path):
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    _write(q / "coverage.json", _coverage(measured=True))

    cov = api_tests.list_test_results(loki)["coverage"]
    assert cov["measured"] is True
    assert cov["pct"] == 87.5, "measured coverage was blanked to %r" % (cov["pct"],)
    assert cov["reason"] is None


# ---------------------------------------------------------------------------
# envelope shape parity with dashboard/api_runs.py
# ---------------------------------------------------------------------------

def test_envelope_shape_matches_api_runs(tmp_path):
    """source / freshness_s / reason on the envelope AND on each row.

    api_runs.py puts source and freshness_s on both levels; two envelope shapes
    in one dashboard is the divergence this asserts against.
    """
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())

    env = api_tests.list_test_results(loki)
    for key in ("items", "source", "freshness_s", "reason"):
        assert key in env, "envelope missing %s" % key
    assert isinstance(env["source"], list) and env["source"], "source must list real paths"
    assert all(s.startswith(".loki/") for s in env["source"]), env["source"]
    assert isinstance(env["freshness_s"], int) and env["freshness_s"] >= 0

    for row in _rows_by_suite(env).values():
        assert "source" in row and row["source"].startswith(".loki/")
        assert "freshness_s" in row
        assert "reason" in row


def test_freshness_is_clamped_and_iteration_is_reported(tmp_path):
    """freshness never negative; the engine's own iteration marker is surfaced."""
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    (q / ".test-results.iter").write_text("7\n", encoding="utf-8")

    # `now` in the past would yield a negative age if unclamped.
    env = api_tests.list_test_results(loki, now=0.0)
    assert env["freshness_s"] == 0, "negative age leaked: %r" % (env["freshness_s"],)
    assert env["iteration"] == 7, "iteration marker read as %r" % (env["iteration"],)


def test_missing_iteration_marker_is_none_not_zero(tmp_path):
    """No marker means unknown iteration. 0 is a real iteration number."""
    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    assert api_tests.list_test_results(loki)["iteration"] is None


def test_malformed_json_degrades_to_unknown(tmp_path):
    """A torn/partial write must read UNKNOWN, never crash and never pass."""
    loki, q = _quality_dir(tmp_path)
    (q / "test-results.json").write_text('{"runner":"pytest","pass":tr', encoding="utf-8")

    row = _rows_by_suite(api_tests.list_test_results(loki))["tests"]
    assert row["passed"] is None
    assert row["recorded"] is False
    assert row["reason"]


# ---------------------------------------------------------------------------
# the canonical cost predicate is deliberately NOT the rule here
# ---------------------------------------------------------------------------

def test_efficiency_predicate_would_blank_every_suite(tmp_path):
    """Documents WHY record_is_measured() is not used on a test record.

    It inspects only cost/token fields, so it returns False for a genuinely
    green suite. If a later edit routes test rows through it, every suite would
    read UNKNOWN and no other test here would notice, because the rows still
    exist. This pins the reason in an executable form.
    """
    path = os.path.join(_REPO, "autonomy", "lib", "efficiency_cost.py")
    if not os.path.isfile(path):
        pytest.skip("autonomy/lib/efficiency_cost.py not present")
    spec = importlib.util.spec_from_file_location("loki_eff_undertest", path)
    eff = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(eff)

    assert eff.record_is_measured(_tests_green()) is False, (
        "record_is_measured now accepts a test record; re-check whether "
        "api_tests should use it"
    )

    loki, q = _quality_dir(tmp_path)
    _write(q / "test-results.json", _tests_green())
    row = _rows_by_suite(api_tests.list_test_results(loki))["tests"]
    assert row["passed"] is True, "the green suite was blanked -- cost predicate leaked in?"
