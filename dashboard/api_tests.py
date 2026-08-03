"""Read-only "test / CI results" view over the filesystem .loki/quality/ dir.

WHY THIS EXISTS. The dashboard had zero API surface over test and CI results,
so it could not answer the one question an operator asks first: did the last
run's tests pass? These are pure functions taking a loki_dir, so they are
testable without FastAPI and can be mounted by whoever owns server.py. Shape
and honesty discipline are copied from dashboard/api_runs.py; this module adds
no second envelope shape.

THE SOURCES, and what each can and cannot tell us. Every one is written by
autonomy/run.sh, and each is ONE flat record for the whole project:

  .loki/quality/test-results.json    the test axis. TWO writers, one schema.
      run.sh:11563 is the no-runner writer (runner "none", pass the STRING
      "inconclusive", status "not_run"); run.sh:11642 is the real-runner
      writer (pass bool, status verified|failed|no_tests_run). Keys:
      timestamp, runner, pass, summary, command, exit_code, status,
      passed_count, failed_count, verification_gap, and min_coverage which is
      present ONLY on the real-runner writer -- always read with .get().
  .loki/quality/static-analysis.json  run.sh:10442. Keys: timestamp,
      files_checked, findings, summary, pass (bool).
  .loki/quality/build-results.json    run.sh:9811. Keys: timestamp, command,
      ran, applicable, exit_code, duration_sec, status
      (verified|failed|not_run|not_applicable).
  .loki/quality/coverage.json         run.sh:11706. Keys: measured, pct, tool,
      runner, threshold, enforced, blocked, reason, timestamp.
  .loki/quality/.test-results.iter    the engine's own freshness marker: the
      iteration number the test results belong to (run.sh:11570). Reported as
      `iteration`; this module does NOT derive a staleness verdict from it.

WHAT "PER-SUITE" MEANS HERE, and the one place the writers are ambiguous. No
writer emits per-suite records -- pytest's individual suites are collapsed into
a single flat result before it is persisted, and passed_count / failed_count
are best-effort regex parses of the runner's summary line (null, never 0, when
unparseable). The only decomposition that exists on disk is the four sibling
AXES above, so a "suite" row here is one axis. A suite-parsing layer would have
to invent data no writer produces.

THE HONESTY RULE, which is the entire point of this module. A gate that did
not run is not a gate that passed. Three ways that fact gets destroyed, all
guarded:

  1. `pass` is a UNION: bool true, bool false, or the string "inconclusive".
     `if rec.get("pass")` renders "inconclusive" as passing, because a
     non-empty string is truthy. Compared with `is True` / `is False`; anything
     else is UNKNOWN.
  2. An ABSENT artifact reads UNKNOWN with a stated reason, never "passed".
     Absence of a signal is not evidence of success.
  3. `status` carries not_run and no_tests_run, which are gaps, not passes.
     A runner that exited 0 having executed zero tests (run.sh:11632) proves
     nothing and must not read verified.

WHY record_is_measured() IS NOT USED HERE. autonomy/lib/efficiency_cost.py
holds the canonical measured-ness predicate for COST, and api_runs.py imports
it rather than restating it. It is the wrong rule for this domain: it inspects
only _MEASURED_FIELDS (cost_usd, input_tokens, output_tokens, cache_read_
tokens, cache_creation_tokens), which a test-results record does not have, so
it returns False for a genuinely green measured suite -- verified by calling
it against one. Routing test rows through it would silently mark every suite
UNKNOWN. The codebase's real definition of trustworthy test evidence is the
predicate at autonomy/run.sh:20846 (runner not in {"", "none"} AND pass is True
AND command a non-empty str AND exit_code an int == 0). It lives inside a shell
heredoc, so it cannot be imported; _test_evidence_is_trustworthy() below
mirrors it and names that line as its source.

.loki/quality/ is NOT wiped at run start -- the run-start clear at
autonomy/run.sh:6212 covers metrics/efficiency/iteration-*.json only. These
files are last-write-wins per iteration, so they describe the most recent
iteration that ran each gate, which is why this reader is singular: there is no
history on disk to make it plural.

Every returned envelope states `source` (the real paths read) and
`freshness_s` (age in seconds of the newest file that actually contributed,
None when nothing did), and carries an explicit `reason` when empty. Each row
carries its own `source` and `freshness_s` too, matching api_runs.py.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

__all__ = ["list_test_results", "UNKNOWN"]

# What an unmeasured value reads as. Kept as a name so callers can render it
# without hardcoding None-means-unknown at each call site.
UNKNOWN = None

_QUALITY = "quality"
_TEST_RESULTS = (_QUALITY, "test-results.json")
_STATIC_ANALYSIS = (_QUALITY, "static-analysis.json")
_BUILD_RESULTS = (_QUALITY, "build-results.json")
_COVERAGE = (_QUALITY, "coverage.json")
_ITER_MARKER = (_QUALITY, ".test-results.iter")

# Declared for the envelope so a caller can see exactly what was read, in the
# style already used by api_runs.py (real paths, not labels).
_SOURCE_PATHS = (
    ".loki/quality/test-results.json",
    ".loki/quality/static-analysis.json",
    ".loki/quality/build-results.json",
    ".loki/quality/coverage.json",
    ".loki/quality/.test-results.iter",
)

# status values the writers emit that are POSITIVELY not a pass. Everything
# outside this set and outside "verified" is UNKNOWN rather than assumed good.
_GAP_STATUSES = ("not_run", "no_tests_run", "not_applicable")


# ---------------------------------------------------------------------------
# tiny io helpers -- every one returns a default rather than raising, because a
# dashboard read must degrade, never 500 on a missing file.
# ---------------------------------------------------------------------------

def _p(loki_dir: str, *parts: str) -> str:
    return os.path.join(loki_dir, *parts)


def _read_json(path: str, default: Any = None) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _mtime(path: str) -> Optional[float]:
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _freshness(mtimes: list, now: Optional[float] = None) -> Optional[int]:
    """Age in seconds of the NEWEST file that contributed. None if none did.

    None is load-bearing: "no file contributed" is not "contributed zero
    seconds ago". Clamped at 0 so a file written during this call (or a clock
    that stepped) never reports a negative age.
    """
    real = [m for m in mtimes if m is not None]
    if not real:
        return None
    return max(0, int((now if now is not None else time.time()) - max(real)))


def _iteration(loki_dir: str) -> Optional[int]:
    """Iteration the test results belong to, from the engine's own marker.

    Reported as a fact, never turned into a staleness verdict here. Absent or
    unparseable reads None -- not 0, which is a real iteration number.
    """
    try:
        with open(_p(loki_dir, *_ITER_MARKER), "r", encoding="utf-8") as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# the honesty predicates
# ---------------------------------------------------------------------------

def _passed(value: Any) -> Optional[bool]:
    """Map a writer's `pass` field to True / False / UNKNOWN.

    THE load-bearing function. `pass` is a union across the two writers: bool
    true, bool false, or the string "inconclusive" (run.sh:11563 no-runner,
    run.sh:11642 zero-tests-executed). A truth test would render that string as
    a pass, which is the exact fake-green this module exists to prevent, so the
    comparison is identity against the bools and everything else is UNKNOWN.
    """
    if value is True:
        return True
    if value is False:
        return False
    return UNKNOWN


def _test_evidence_is_trustworthy(rec: Any) -> bool:
    """Mirror of the engine's own "real, passing test evidence" predicate.

    Source of truth: autonomy/run.sh:20846, inside
    _loki_supervised_completion_gates_pass. It is embedded in a shell heredoc
    and therefore not importable, so it is mirrored here rather than imported;
    if that predicate changes, this must follow. It is NOT the same rule as
    efficiency_cost.record_is_measured(), which answers a cost question and
    returns False for every test record (see the module docstring).

    True only when a REAL runner ran, reported pass, and left a command and an
    exit code of 0 behind. A record that says "tests passed" with no command
    and no exit code is the "trust me" transcript the receipt replaces.
    """
    if not isinstance(rec, dict):
        return False
    runner = str(rec.get("runner") or "").strip().lower()
    command = rec.get("command")
    exit_code = rec.get("exit_code")
    return (
        runner not in ("", "none")
        and rec.get("pass") is True
        and isinstance(command, str)
        and bool(command.strip())
        and isinstance(exit_code, int)
        and not isinstance(exit_code, bool)
        and exit_code == 0
    )


def _status_of(rec: Any, passed: Optional[bool]) -> Any:
    """The writer's own status string, or a fallback derived from `pass`.

    Never invents "verified". A record with no status and no usable pass reads
    UNKNOWN, because a gate whose outcome was not recorded did not pass.
    """
    if isinstance(rec, dict):
        status = rec.get("status")
        if isinstance(status, str) and status.strip():
            return status
    if passed is True:
        return "verified"
    if passed is False:
        return "failed"
    return UNKNOWN


def _row(name: str, path_label: str, path: str, rec: Any,
         passed: Optional[bool], now: Optional[float],
         extra: Optional[dict] = None) -> dict:
    """One axis row. Carries its own source and freshness, like api_runs rows.

    `reason` is non-null whenever the outcome is UNKNOWN, so a caller never has
    to guess whether a blank cell means "not run", "not recorded" or "we could
    not read the file".
    """
    present = isinstance(rec, dict)
    if not present:
        reason: Any = "no %s on disk; outcome was never recorded" % (path_label,)
    elif passed is UNKNOWN:
        reason = "%s recorded no pass/fail outcome (pass=%r)" % (
            path_label, rec.get("pass"),
        )
    else:
        reason = None

    row = {
        "suite": name,
        "passed": passed,
        "status": _status_of(rec, passed),
        "recorded": present,
        "timestamp": (rec.get("timestamp") or UNKNOWN) if present else UNKNOWN,
        "summary": (rec.get("summary") or UNKNOWN) if present else UNKNOWN,
        "reason": reason,
        "source": path_label,
        "freshness_s": _freshness([_mtime(path)], now=now),
    }
    if extra:
        row.update(extra)
    return row


# ---------------------------------------------------------------------------
# per-axis readers
# ---------------------------------------------------------------------------

def _tests_row(loki_dir: str, now: Optional[float]) -> tuple:
    """(row, record, path). The test axis, the reason this module exists."""
    path = _p(loki_dir, *_TEST_RESULTS)
    rec = _read_json(path)
    present = isinstance(rec, dict)
    passed = _passed(rec.get("pass")) if present else UNKNOWN

    # A status the writers use for a POSITIVE gap (not_run / no_tests_run)
    # overrides a stray pass value: a runner that exited 0 having executed zero
    # tests proved nothing, so it must not read as passed.
    if present and str(rec.get("status") or "") in _GAP_STATUSES:
        passed = UNKNOWN

    extra = {
        "runner": (rec.get("runner") or UNKNOWN) if present else UNKNOWN,
        "command": (rec.get("command") or UNKNOWN) if present else UNKNOWN,
        # exit_code 0 is meaningful, so it is read with a presence check rather
        # than an `or`, which would turn a real 0 into UNKNOWN.
        "exit_code": rec.get("exit_code") if present else UNKNOWN,
        # null, never 0, when the runner summary was unparseable -- the writer
        # already emits null for this and the distinction must survive.
        "passed_count": rec.get("passed_count") if present else UNKNOWN,
        "failed_count": rec.get("failed_count") if present else UNKNOWN,
        "verification_gap": (rec.get("verification_gap") or UNKNOWN) if present else UNKNOWN,
        # Present only on the real-runner writer; .get() never assumes it.
        "min_coverage": rec.get("min_coverage") if present else UNKNOWN,
        "trustworthy": _test_evidence_is_trustworthy(rec),
    }
    row = _row("tests", ".loki/quality/test-results.json", path, rec, passed, now, extra)
    if present and passed is UNKNOWN and row["reason"] is None:
        row["reason"] = "test status %r is not an outcome" % (rec.get("status"),)
    return row, rec, path


def _static_analysis_row(loki_dir: str, now: Optional[float]) -> tuple:
    path = _p(loki_dir, *_STATIC_ANALYSIS)
    rec = _read_json(path)
    present = isinstance(rec, dict)
    passed = _passed(rec.get("pass")) if present else UNKNOWN
    extra = {
        "findings": rec.get("findings") if present else UNKNOWN,
        "files_checked": rec.get("files_checked") if present else UNKNOWN,
    }
    return _row("static_analysis", ".loki/quality/static-analysis.json",
                path, rec, passed, now, extra), rec, path


def _build_row(loki_dir: str, now: Optional[float]) -> tuple:
    """The build axis. It has no `pass` key -- outcome comes from `status`.

    The writer's three-way classification is deliberate (run.sh:9690): verified
    and failed are outcomes, while not_run is an honest gap and not_applicable
    means the stack positively has no build phase. Neither gap is a pass.
    """
    path = _p(loki_dir, *_BUILD_RESULTS)
    rec = _read_json(path)
    present = isinstance(rec, dict)
    status = str(rec.get("status") or "") if present else ""
    if status == "verified":
        passed: Optional[bool] = True
    elif status == "failed":
        passed = False
    else:
        passed = UNKNOWN
    extra = {
        "command": (rec.get("command") or UNKNOWN) if present else UNKNOWN,
        "exit_code": rec.get("exit_code") if present else UNKNOWN,
        "ran": rec.get("ran") if present else UNKNOWN,
        "applicable": rec.get("applicable") if present else UNKNOWN,
    }
    row = _row("build", ".loki/quality/build-results.json", path, rec, passed, now, extra)
    if present and passed is UNKNOWN:
        row["reason"] = "build status %r is not an outcome" % (rec.get("status"),)
    return row, rec, path


def _coverage(loki_dir: str, now: Optional[float]) -> tuple:
    """Coverage facts. NOT a suite row: coverage has no pass/fail outcome.

    Measurement is opt-in (run.sh:11734), so the default-off record carries
    measured=false with a reason. pct is None when unmeasured and stays None
    here; an unmeasured coverage is never rendered as 0 percent.
    """
    path = _p(loki_dir, *_COVERAGE)
    rec = _read_json(path)
    if not isinstance(rec, dict):
        return {
            "measured": False,
            "pct": UNKNOWN,
            "tool": UNKNOWN,
            "threshold": UNKNOWN,
            "enforced": UNKNOWN,
            "blocked": UNKNOWN,
            "reason": "no .loki/quality/coverage.json on disk; coverage was never recorded",
            "source": ".loki/quality/coverage.json",
            "freshness_s": None,
        }, rec, path
    measured = rec.get("measured") is True
    return {
        "measured": measured,
        "pct": rec.get("pct") if measured else UNKNOWN,
        "tool": rec.get("tool") or UNKNOWN,
        "threshold": rec.get("threshold"),
        "enforced": rec.get("enforced"),
        "blocked": rec.get("blocked"),
        "reason": None if measured else (rec.get("reason") or "coverage not measured"),
        "source": ".loki/quality/coverage.json",
        "freshness_s": _freshness([_mtime(path)], now=now),
    }, rec, path


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def list_test_results(loki_dir: str, now: Optional[float] = None) -> dict:
    """Latest test / CI results from .loki/quality/, one row per axis.

    Returns an ENVELOPE, not a bare list, because the contract requires an
    explicit reason when the result is empty and a list cannot carry one:

        {"items": [...], "latest": {...}, "coverage": {...}, "iteration": int|None,
         "source": [...], "freshness_s": int|None, "reason": None|str}

    `items` is one row per axis (tests, static_analysis, build) -- see the
    module docstring on why an axis is the finest decomposition any writer
    produces. `latest` is the headline: the test axis, the answer to "did the
    last run's tests pass".

    THE PROPERTY THAT MATTERS: a suite whose outcome was never recorded reads
    passed=UNKNOWN, never True and never False, and its `reason` says why. A
    gate that did not run is not a gate that passed. This holds for an absent
    file, for pass="inconclusive", and for status not_run / no_tests_run.

    `reason` is None when at least one axis recorded an outcome. When nothing
    on disk recorded anything it states so; rows are still returned (all
    UNKNOWN) rather than padded with placeholders or dropped.
    """
    envelope: dict = {
        "items": [],
        "latest": None,
        "coverage": None,
        "iteration": None,
        "source": list(_SOURCE_PATHS),
        "freshness_s": None,
        "reason": None,
    }
    if not loki_dir or not os.path.isdir(loki_dir):
        envelope["reason"] = "no .loki directory at %s" % (loki_dir,)
        return envelope

    tests_row, _tr, tests_path = _tests_row(loki_dir, now)
    sa_row, _sa, sa_path = _static_analysis_row(loki_dir, now)
    build_row, _br, build_path = _build_row(loki_dir, now)
    coverage, _cv, cov_path = _coverage(loki_dir, now)

    rows = [tests_row, sa_row, build_row]
    envelope["items"] = rows
    envelope["latest"] = tests_row
    envelope["coverage"] = coverage
    envelope["iteration"] = _iteration(loki_dir)
    envelope["freshness_s"] = _freshness(
        [_mtime(tests_path), _mtime(sa_path), _mtime(build_path), _mtime(cov_path)],
        now=now,
    )

    if not any(r["recorded"] for r in rows):
        envelope["reason"] = (
            "no quality artifacts under .loki/quality/: no gate has recorded a "
            "result, so every suite reads UNKNOWN (not passed)"
        )
    elif all(r["passed"] is UNKNOWN for r in rows):
        envelope["reason"] = (
            "artifacts present but no suite recorded a pass/fail outcome"
        )
    return envelope
