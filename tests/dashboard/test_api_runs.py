"""dashboard/api_runs.py must never turn "we did not measure" into "it was free".

This is the same defect audited across six other surfaces (v8.51.0 codex
dispatch, v8.52.0 the receipt, v8.53.0 the prompt, v8.54.0 the verifier,
v8.69.0 the cost summary, v8.72.0/v8.74.0 kpis.ts) and on both dashboard cost
readers. A new run-facing reader is exactly where it comes back, so it is
asserted here before the module has any callers.

TWO UNMEASURED SHAPES ARE TESTED, because only one of them is obvious:

  1. no efficiency directory at all         -> cost_usd is None
  2. records PRESENT with every field 0     -> cost_usd is None

Shape 2 is the real one. It is what a pre-v8.51.0 codex run wrote (measured on
the FireLater run: four records, every token field 0), and a test that covers
only shape 1 passes against an implementation that still renders all-zero
records as $0.00. A third case asserts the opposite direction -- a genuine
measured value must survive -- because a guard so strict it blanked real data
would also pass a one-directional test.

EVERY assertion about content is preceded by a VACUITY GUARD. A fixture that
silently wrote nothing makes `for row in rows:` pass with zero iterations, and
a substring check over an empty listing reports nothing missing. An empty
result is not evidence; it is an absent measurement.

Fixtures are built in tmp_path. Nothing here reads or writes the real .loki/.
"""

from __future__ import annotations

import importlib.util
import json
import os
import time

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))


def _load_module():
    """Import dashboard/api_runs.py by path.

    Loaded directly rather than as `dashboard.api_runs` so this test never
    drags in dashboard/__init__.py, server.py or the SQLAlchemy models. The
    module under test is pure functions over a directory; the test should fail
    for its own reasons, not for a FastAPI import error.
    """
    path = os.path.join(_REPO, "dashboard", "api_runs.py")
    assert os.path.isfile(path), "module under test missing at %s" % path
    spec = importlib.util.spec_from_file_location("loki_api_runs_undertest", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


api_runs = _load_module()


# ---------------------------------------------------------------------------
# fixture builders
# ---------------------------------------------------------------------------

RUN_ID = "run-20260803120000-4242-7"
OLD_RUN_ID = "run-20260801090000-1111-3"


def _mkloki(tmp_path, run_id=RUN_ID, events=True):
    """A .loki/ with a minted run id and (optionally) trust events."""
    loki = tmp_path / ".loki"
    (loki / "state").mkdir(parents=True)
    (loki / "state" / "trust-run-id").write_text(run_id)
    if events:
        (loki / "metrics").mkdir(parents=True, exist_ok=True)
        lines = [
            {"type": "run_start", "run_id": OLD_RUN_ID, "iteration": 0,
             "ts": "2026-08-01T09:00:00Z"},
            {"type": "gate_fail", "run_id": OLD_RUN_ID, "iteration": 2,
             "ts": "2026-08-01T09:30:00Z"},
            {"type": "run_start", "run_id": run_id, "iteration": 0,
             "ts": "2026-08-03T12:00:00Z"},
            {"type": "gate_pass", "run_id": run_id, "iteration": 3,
             "ts": "2026-08-03T12:40:00Z"},
        ]
        with (loki / "metrics" / "trust-events.jsonl").open("w") as fh:
            for rec in lines:
                fh.write(json.dumps(rec, sort_keys=True) + "\n")
    return loki


def _write_efficiency(loki, records):
    """Write iteration-N.json records. Returns the directory."""
    eff = loki / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    for rec in records:
        (eff / ("iteration-%d.json" % rec["iteration"])).write_text(
            json.dumps(rec, indent=2))
    return eff


def _zero_record(n):
    """The FireLater shape: a record that exists and measured nothing."""
    return {
        "iteration": n, "model": "gpt-5.3-codex", "phase": "BUILDING",
        "duration_ms": 41000, "provider": "codex", "status": "success",
        "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
        "cache_creation_tokens": 0, "cost_usd": 0,
        "timestamp": "2026-08-03T12:0%d:00Z" % n,
    }


def _measured_record(n):
    return {
        "iteration": n, "model": "claude-sonnet-4-6", "phase": "BUILDING",
        "duration_ms": 52000, "provider": "claude", "status": "success",
        "input_tokens": 18422, "output_tokens": 3110, "cache_read_tokens": 90210,
        "cache_creation_tokens": 4096, "cost_usd": 0.1734,
        "timestamp": "2026-08-03T12:1%d:00Z" % n,
    }


# ---------------------------------------------------------------------------
# the canonical predicate must be the one that is actually used
# ---------------------------------------------------------------------------

def test_uses_canonical_efficiency_module_not_a_local_copy():
    """The honesty rule must come from autonomy/lib, not a third restatement.

    If this fails, the module is computing measured-ness on its own and the
    rule can drift -- which is precisely how the same defect reached six
    surfaces with six slightly different ideas of "measured".
    """
    mod = api_runs._efficiency_module()
    assert mod is not None, "canonical efficiency_cost module did not load"
    assert hasattr(mod, "record_is_measured")
    assert hasattr(mod, "collect_efficiency")
    src = os.path.join(_REPO, "dashboard", "api_runs.py")
    body = open(src, encoding="utf-8").read()
    assert "_MEASURED_FIELDS" not in body, \
        "api_runs.py restates the measured-field list instead of importing it"


# ---------------------------------------------------------------------------
# shape 1: no efficiency records at all
# ---------------------------------------------------------------------------

def test_no_efficiency_dir_reads_unknown_not_zero(tmp_path):
    loki = _mkloki(tmp_path)
    assert not (loki / "metrics" / "efficiency").exists()

    env = api_runs.list_runs(str(loki))
    rows = env["runs"]

    # VACUITY GUARD: without rows, every assertion below is vacuously true.
    assert rows, "fixture produced no run rows; the assertions below prove nothing"

    current = [r for r in rows if r["current"]]
    assert len(current) == 1, "expected exactly one current run, got %d" % len(current)
    row = current[0]
    assert row["id"] == RUN_ID
    assert row["cost_usd"] is None, \
        "unmeasured cost must be None, got %r" % (row["cost_usd"],)
    assert row["measured"] is False
    assert row["cost_note"], "an unmeasured row must say why"


# ---------------------------------------------------------------------------
# shape 2: records PRESENT, every field zero -- the one that hides
# ---------------------------------------------------------------------------

def test_all_zero_records_read_unknown_not_zero(tmp_path):
    """A present file is not a measurement.

    Four records exist and parse. An implementation that trusted file presence
    would report cost_usd 0.0 with measured True -- asserting the run was FREE,
    which is the fabricated fact this whole arc removed.
    """
    loki = _mkloki(tmp_path)
    eff = _write_efficiency(loki, [_zero_record(n) for n in (1, 2, 3, 4)])

    # VACUITY GUARD: prove the fixture actually wrote the records. Without
    # this, a typo'd path makes the test degenerate into shape 1 and pass for
    # the wrong reason.
    written = sorted(p.name for p in eff.glob("iteration-*.json"))
    assert len(written) == 4, "fixture wrote %r, expected 4 records" % (written,)

    env = api_runs.list_runs(str(loki))
    rows = [r for r in env["runs"] if r["current"]]
    assert rows, "fixture produced no current run row"
    row = rows[0]

    assert row["cost_usd"] is None, \
        "all-zero records must read UNKNOWN, got %r" % (row["cost_usd"],)
    assert row["measured"] is False
    # Asserted with `is None` above, never `assert not row["cost_usd"]`: the
    # falsy form passes on 0 and 0.0 and is the exact bug under test.

    # The records still prove the run DID four iterations. Unmeasured cost must
    # not blank the evidence that does exist.
    assert row["iterations"] == 4, \
        "iteration count lost: %r" % (row["iterations"],)

    detail = api_runs.get_run(str(loki), RUN_ID)
    iters = detail["iterations"]
    assert len(iters) == 4, "expected 4 per-iteration rows, got %d" % len(iters)
    for it in iters:
        assert it["measured"] is False
        assert it["cost_usd"] is None, \
            "iteration %s reported %r" % (it["iteration"], it["cost_usd"])
        assert it["input_tokens"] is None
    # Numeric sort, not lexical: iteration-10 must not precede iteration-2.
    assert [it["iteration"] for it in iters] == [1, 2, 3, 4]


def test_zero_iteration_count_reads_unknown_not_zero(tmp_path):
    """The honesty rule covers `iterations`, not only `cost_usd`.

    A run whose sole record is iteration-0 has not demonstrated that any
    iteration completed. Rendering "0 iterations" would be the same fabricated
    plausible-looking value that "$0.00" is for an unmeasured cost, in the
    other field of the same row.
    """
    loki = _mkloki(tmp_path, events=False)
    eff = _write_efficiency(loki, [_zero_record(0)])
    assert len(list(eff.glob("iteration-*.json"))) == 1, "fixture underwrote"

    env = api_runs.list_runs(str(loki))
    rows = env["runs"]
    assert rows, "fixture produced no run rows"
    assert rows[0]["iterations"] is None, \
        "unmeasured iteration count must be None, got %r" % (rows[0]["iterations"],)


def test_iterations_sort_numerically_past_nine(tmp_path):
    loki = _mkloki(tmp_path)
    eff = _write_efficiency(loki, [_measured_record(n) for n in (1, 2, 10, 11)])
    assert len(list(eff.glob("iteration-*.json"))) == 4, "fixture underwrote"

    detail = api_runs.get_run(str(loki), RUN_ID)
    assert detail["iterations"], "no iteration rows produced"
    assert [it["iteration"] for it in detail["iterations"]] == [1, 2, 10, 11]


# ---------------------------------------------------------------------------
# the other direction: a real measurement must survive
# ---------------------------------------------------------------------------

def test_measured_records_report_a_real_cost(tmp_path):
    """A guard so strict it blanked genuine data would pass the tests above."""
    loki = _mkloki(tmp_path)
    eff = _write_efficiency(loki, [_measured_record(n) for n in (1, 2)])
    assert len(list(eff.glob("iteration-*.json"))) == 2, "fixture underwrote"

    env = api_runs.list_runs(str(loki))
    rows = [r for r in env["runs"] if r["current"]]
    assert rows, "fixture produced no current run row"
    row = rows[0]

    assert row["measured"] is True
    assert row["cost_usd"] == pytest.approx(0.3468), \
        "two records at 0.1734 must sum to 0.3468, got %r" % (row["cost_usd"],)

    detail = api_runs.get_run(str(loki), RUN_ID)
    assert len(detail["iterations"]) == 2
    for it in detail["iterations"]:
        assert it["measured"] is True
        assert it["cost_usd"] == pytest.approx(0.1734)
        assert it["input_tokens"] == 18422


# ---------------------------------------------------------------------------
# empty results carry a reason, never a fabricated row
# ---------------------------------------------------------------------------

def test_missing_loki_dir_is_empty_with_a_reason(tmp_path):
    env = api_runs.list_runs(str(tmp_path / "nope" / ".loki"))
    assert env["runs"] == []
    assert env["reason"], "an empty result must state why"
    assert "no .loki" in env["reason"]
    assert env["freshness_s"] is None, \
        "freshness must be None when nothing was read, not 0"


def test_loki_with_no_run_id_is_empty_with_a_reason(tmp_path):
    loki = tmp_path / ".loki"
    (loki / "state").mkdir(parents=True)
    env = api_runs.list_runs(str(loki))
    assert env["runs"] == [], "invented %d rows from no evidence" % len(env["runs"])
    assert env["reason"] and "no run id" in env["reason"]


def test_unknown_run_id_is_an_explicit_error_state(tmp_path):
    loki = _mkloki(tmp_path)
    env = api_runs.get_run(str(loki), "run-does-not-exist")
    assert env["run"] is None
    assert env["iterations"] == []
    assert env["reason"] and "not found" in env["reason"]


def test_empty_run_id_is_an_explicit_error_state(tmp_path):
    loki = _mkloki(tmp_path)
    env = api_runs.get_run(str(loki), "")
    assert env["run"] is None
    assert env["reason"] == "no run_id given"


# ---------------------------------------------------------------------------
# historical runs: present, but honest about what was deleted
# ---------------------------------------------------------------------------

def test_historical_run_is_listed_but_reports_cost_unknown(tmp_path):
    """The efficiency dir is wiped at run start (autonomy/run.sh:6212).

    So the current run's records must NOT be attributed to an older run. That
    would be a fabricated fact -- the older run's cost evidence was deleted.
    """
    loki = _mkloki(tmp_path)
    eff = _write_efficiency(loki, [_measured_record(n) for n in (1, 2)])
    assert len(list(eff.glob("iteration-*.json"))) == 2, "fixture underwrote"

    env = api_runs.list_runs(str(loki))
    ids = [r["id"] for r in env["runs"]]
    assert len(ids) == 2, "expected 2 runs from trust-events, got %r" % (ids,)
    assert OLD_RUN_ID in ids and RUN_ID in ids

    old = [r for r in env["runs"] if r["id"] == OLD_RUN_ID][0]
    assert old["current"] is False
    assert old["cost_usd"] is None, \
        "current-run cost leaked onto a historical run: %r" % (old["cost_usd"],)
    assert old["measured"] is False
    assert "wiped" in old["cost_note"]
    # Iteration evidence DOES survive in the append-only event log.
    assert old["iterations"] == 2
    assert old["started_at"] == "2026-08-01T09:00:00Z"

    detail = api_runs.get_run(str(loki), OLD_RUN_ID)
    assert detail["run"] is not None
    assert detail["iterations"] == [], \
        "invented per-iteration detail for a run whose records were wiped"
    assert detail["reason"] and "wiped" in detail["reason"]


def test_runs_are_newest_first(tmp_path):
    loki = _mkloki(tmp_path)
    env = api_runs.list_runs(str(loki))
    assert len(env["runs"]) == 2, "fixture produced %d runs" % len(env["runs"])
    assert env["runs"][0]["id"] == RUN_ID, "newest run must sort first"


def test_run_with_no_recorded_start_sorts_last_and_reads_none(tmp_path):
    """A run id with no events has no start time. Report None, do not date it."""
    loki = _mkloki(tmp_path)
    env = api_runs.list_runs(str(loki))
    assert env["runs"], "fixture produced no rows"
    # The current run has events here, so add a bare id with none.
    (loki / "state" / "trust-run-id").write_text("run-bare-0-0")
    env2 = api_runs.list_runs(str(loki))
    bare = [r for r in env2["runs"] if r["id"] == "run-bare-0-0"]
    assert bare, "a minted run id with no events must still be listed"
    assert bare[0]["started_at"] is None
    assert env2["runs"][-1]["id"] == "run-bare-0-0", "undated run must sort last"


# ---------------------------------------------------------------------------
# status precedence matches the CLI's own reader (autonomy/loki:4981)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("signal,expected", [
    ("PAUSE", "paused"),
    ("STOP", "stopped"),
])
def test_signal_files_win_over_session_json(tmp_path, signal, expected):
    loki = _mkloki(tmp_path)
    (loki / "session.json").write_text(json.dumps({"status": "running"}))
    (loki / signal).write_text("")
    env = api_runs.list_runs(str(loki))
    rows = [r for r in env["runs"] if r["current"]]
    assert rows, "fixture produced no current row"
    assert rows[0]["status"] == expected


def test_missing_status_reads_unknown_never_completed(tmp_path):
    loki = _mkloki(tmp_path)
    env = api_runs.list_runs(str(loki))
    rows = [r for r in env["runs"] if r["current"]]
    assert rows, "fixture produced no current row"
    assert rows[0]["status"] == "unknown", \
        "absence of a signal must not be read as success"


def test_completion_outcome_is_the_terminal_status(tmp_path):
    loki = _mkloki(tmp_path)
    (loki / "state" / "completion.json").write_text(
        json.dumps({"outcome": "max_iterations", "iterations": 4}))
    env = api_runs.list_runs(str(loki))
    rows = [r for r in env["runs"] if r["current"]]
    assert rows, "fixture produced no current row"
    assert rows[0]["status"] == "max_iterations"

    old = [r for r in env["runs"] if r["id"] == OLD_RUN_ID]
    assert old and old[0]["status"] == "unknown", \
        "the current run's outcome must not label a historical run"


# ---------------------------------------------------------------------------
# source + freshness are stated on every result
# ---------------------------------------------------------------------------

def test_every_row_states_source_and_freshness(tmp_path):
    loki = _mkloki(tmp_path)
    _write_efficiency(loki, [_measured_record(1)])
    env = api_runs.list_runs(str(loki))
    assert env["runs"], "fixture produced no rows"
    for row in env["runs"]:
        assert row["source"], "row %s states no source" % row["id"]
        assert any(".loki/" in s for s in row["source"])
        assert isinstance(row["freshness_s"], int), \
            "row %s freshness %r" % (row["id"], row["freshness_s"])
        assert row["freshness_s"] >= 0


def test_freshness_reflects_file_age_not_a_constant(tmp_path):
    """Freshness must be computed from mtime, not stubbed.

    A hardcoded 0 would satisfy "is an int and >= 0" above, so pin an mtime an
    hour back and read the age against an injected clock.
    """
    loki = _mkloki(tmp_path)
    events = loki / "metrics" / "trust-events.jsonl"
    now = time.time()
    os.utime(events, (now - 3600, now - 3600))
    os.utime(loki / "state" / "trust-run-id", (now - 3600, now - 3600))

    env = api_runs.list_runs(str(loki), now=now)
    assert env["freshness_s"] is not None
    assert 3590 <= env["freshness_s"] <= 3610, \
        "expected ~3600s, got %r" % (env["freshness_s"],)


def test_torn_jsonl_line_does_not_blank_earlier_runs(tmp_path):
    """The trust-event writer is best-effort and can be killed mid-line."""
    loki = _mkloki(tmp_path)
    with (loki / "metrics" / "trust-events.jsonl").open("a") as fh:
        fh.write('{"type": "gate_pass", "run_id": "run-tor')  # no newline
    env = api_runs.list_runs(str(loki))
    ids = [r["id"] for r in env["runs"]]
    assert OLD_RUN_ID in ids and RUN_ID in ids, \
        "a torn tail line erased earlier runs: %r" % (ids,)
