#!/usr/bin/env python3
"""Per-stage wall-clock profile for engine10 (v10) runs. S41-19, D43 item 3.

Given one or more "run dirs" (each a preserved engine copy: a directory
holding one subdirectory per task, each with a `.loki/runs/<id>/events.jsonl`
event journal written by the engine), this derives how many seconds of the
run's measured wall-clock went to each named stage (intake, plan, wall,
implement, verify, fix rounds, seal, commit, ...), with anything the journal
does not cover -- harness launch/setup before the engine's first event, a
push-confirmation tail after its last event, or an internal gap where no
stage was open -- landing in "unattributed". Per run, stage seconds sum with
unattributed to exactly the measured total (see `profile_run`).

The measured total is `time_to_pr_s` from the matching harness eval row when
one can be found (the sibling, non "-engine", results.jsonl next to the run
dir; see `sibling_results_file`); otherwise it falls back to the journal's
own run.completed-minus-run.started span, which local evidence shows differs
from time_to_pr_s by well under a second (harness launch + push-confirm
overhead is small; see docs/v10/METRICS.md "Stage wall-clock profile").

Event schema relied on (verified against 9 preserved E-98f run copies under
~/loki-ci-logs/eval/e98f-engine/{default,nocascade,nowall}-r{1,2,3}/*/.loki/
runs/*/events.jsonl): each line is one JSON object with `seq` (int, event
order within the run), `ts` (ISO8601 UTC, millisecond precision), `type`,
and `stage` (the stage name, or null). `run.started` and `run.completed`
bound the run. `stage.started` opens a named stage; `stage.completed`,
`stage.failed`, or `stage.skipped` closes the most recently opened stage of
that name (observed: LOKI_E10_WALL=0 opens "wall" with stage.started, then
immediately closes it with stage.skipped rather than stage.completed/
failed; a stage can also be stage.skipped with no matching open, e.g. plan
on the small-task path, which is a no-op here). Stages
can nest (plan and wall run concurrently under cascade; observed: wall
opens before plan closes), so this uses stack (self-time) attribution: at
any instant, elapsed time is charged to whichever open stage was opened
most recently, matching how a profiler charges a caller's time to a callee
while the callee is on top of the stack. A stage name that opens more than
once in one run (fix rounds, verify after each fix) is summed into one
bucket for that run; the task list floor here treats "fix rounds" as one
category, not one row per round.

Usage:
    stage-profile.py --self-test
    stage-profile.py RUN_DIR [RUN_DIR ...]
    stage-profile.py --json RUN_DIR [RUN_DIR ...]   # raw per-run rows
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta


# ---------------------------------------------------------------------------
# Event-journal parsing and stack (self-time) stage attribution.
# ---------------------------------------------------------------------------

def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_events(events_path):
    events = []
    with open(events_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            events.append(json.loads(line))
    events.sort(key=lambda e: e.get("seq", 0))
    return events


def stage_self_time(events):
    """Stack-based self-time attribution over one run's events.

    Returns (stage_seconds, internal_unattributed_s, run_started, run_completed).
    stage_seconds is a dict of stage-name -> seconds; internal_unattributed_s
    is time inside [run_started, run_completed] when no stage was open (a
    gap the engine did not cover with a stage.started/completed pair, e.g.
    the point events pr.opened/deep.started carry no duration). By
    construction sum(stage_seconds.values()) + internal_unattributed_s ==
    (run_completed - run_started) exactly.
    """
    run_started = None
    run_completed = None
    for e in events:
        if e["type"] == "run.started":
            run_started = parse_ts(e["ts"])
        elif e["type"] == "run.completed":
            run_completed = parse_ts(e["ts"])
    if run_started is None:
        raise ValueError("no run.started event in journal")
    if run_completed is None:
        # An interrupted/incomplete run: close out at the last recorded event
        # rather than guessing a value.
        run_completed = parse_ts(events[-1]["ts"])

    stage_seconds = {}
    unattributed = 0.0
    open_stack = []
    prev_ts = run_started
    for e in events:
        ts = parse_ts(e["ts"])
        if ts < run_started or ts > run_completed:
            continue
        dt = (ts - prev_ts).total_seconds()
        if dt > 0:
            if open_stack:
                name = open_stack[-1]
                stage_seconds[name] = stage_seconds.get(name, 0.0) + dt
            else:
                unattributed += dt
        prev_ts = ts
        etype = e["type"]
        if etype == "stage.started":
            open_stack.append(e["stage"])
        elif etype in ("stage.completed", "stage.failed", "stage.skipped"):
            # stage.skipped closes a stage that was opened then bypassed by a
            # knob (observed: nowall's wall opens, then is immediately
            # skipped via stage.skipped, never stage.completed/failed). A
            # stage.skipped with no matching open entry (a stage skipped
            # before ever opening, e.g. plan on the small-task path) is a
            # no-op here, same as any close event with nothing to close.
            name = e.get("stage")
            for i in range(len(open_stack) - 1, -1, -1):
                if open_stack[i] == name:
                    del open_stack[i]
                    break
    return stage_seconds, unattributed, run_started, run_completed


def profile_run(events_path, row=None):
    """Profile one run: per-stage seconds plus an unattributed breakdown.

    `row` is the matching harness eval row (a dict with at least `started`
    and `time_to_pr_s`), or None. When given and usable, the measured total
    is `time_to_pr_s` and unattributed splits into pre (harness launch,
    before the journal's run.started), internal (gaps inside the journal),
    and post (push-confirmation tail, after run.completed). Without a row,
    the total falls back to the journal's own run.completed - run.started,
    and pre/post are 0.
    """
    events = load_events(events_path)
    stage_seconds, internal, run_started, run_completed = stage_self_time(events)
    engine_total = (run_completed - run_started).total_seconds()

    pre = 0.0
    post = 0.0
    total = engine_total
    source = "journal (run.completed - run.started)"
    if row is not None and row.get("started") and row.get("time_to_pr_s") is not None:
        harness_started = parse_ts(row["started"])
        end_target = harness_started + timedelta(seconds=row["time_to_pr_s"])
        total = (end_target - harness_started).total_seconds()
        pre = (run_started - harness_started).total_seconds()
        post = (end_target - run_completed).total_seconds()
        source = "time_to_pr_s"

    unattributed = pre + internal + post
    pre_model = None  # D61-1: run.completed data.pre_model = {span_s, stages}, argv to first provider byte
    for e in events:
        if e["type"] == "run.completed" and isinstance(e.get("data", {}).get("pre_model"), dict):
            pre_model = e["data"]["pre_model"]
    return {
        "pre_model": pre_model,
        "stages": stage_seconds,
        "unattributed": unattributed,
        "unattributed_pre_launch": pre,
        "unattributed_internal_gap": internal,
        "unattributed_post_push": post,
        "total": total,
        "source": source,
    }


# ---------------------------------------------------------------------------
# Run-dir discovery and harness-row matching.
# ---------------------------------------------------------------------------

def discover_task_events(run_dir):
    """Yield (task_id, events_path) for each task subdir under a run dir.

    A task subdir is named "<task-id>.<arm>.<sha>" (observed); the task id
    is everything before the first '.'. Each holds exactly one
    .loki/runs/<run-id>/events.jsonl in every preserved E-98f copy checked.
    """
    for name in sorted(os.listdir(run_dir)):
        full = os.path.join(run_dir, name)
        if not os.path.isdir(full):
            continue
        matches = sorted(glob.glob(os.path.join(full, ".loki", "runs", "*", "events.jsonl")))
        if not matches:
            continue
        if len(matches) > 1:
            print("WARN: %s has %d run journals, using the first" % (full, len(matches)),
                  file=sys.stderr)
        yield name.split(".")[0], matches[0]


def sibling_results_file(run_dir):
    """The harness --out dir's results.jsonl next to an "-engine" copy dir.

    Preserved layout: engine copies live under ".../e98f-engine/<arm>-r<n>/";
    the harness's own --out (results.jsonl, one row per task attempt) lives
    at the sibling ".../e98f-<arm>-r<n>/results.jsonl" (no "-engine"). Returns
    None if that convention does not hold or the file is absent, so callers
    fall back to journal-only totals rather than guessing.
    """
    parent = os.path.dirname(run_dir)
    pname = os.path.basename(parent)
    if not pname.endswith("-engine"):
        return None
    prefix = pname[: -len("-engine")]
    grandparent = os.path.dirname(parent)
    cand = os.path.join(grandparent, prefix + "-" + os.path.basename(run_dir), "results.jsonl")
    return cand if os.path.isfile(cand) else None


def load_dedup_rows(results_file):
    """One harness row per task: the documented E-98f dedupe rule.

    MEDIUM-ANALYSIS.md "After (E-98f)": "Rows are deduped to exactly one per
    (arm, run-file, task): the latest status: ok attempt if one exists in
    that run-file, else its latest attempt overall (by started, falling
    back to file order)." Applied here per results.jsonl file (one run-file).
    """
    rows_by_task = {}
    with open(results_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            rows_by_task.setdefault(r["task"], []).append(r)
    out = {}
    for task, rs in rows_by_task.items():
        ok = [r for r in rs if r.get("status") == "ok"]
        pool = ok if ok else rs
        pool_sorted = sorted(enumerate(pool), key=lambda ir: (ir[1].get("started") or "", ir[0]))
        out[task] = pool_sorted[-1][1]
    return out


ARM_REP_RE = re.compile(r"^(?P<arm>.+)-r(?P<rep>\d+)$")


def profile_run_dir(run_dir):
    """Profile every task under one run dir. Returns a list of per-run dicts."""
    run_dir = os.path.abspath(os.path.expanduser(run_dir))
    base = os.path.basename(run_dir)
    m = ARM_REP_RE.match(base)
    arm = m.group("arm") if m else base
    rep = m.group("rep") if m else "?"

    results_file = sibling_results_file(run_dir)
    rows = load_dedup_rows(results_file) if results_file else {}

    out = []
    for task, events_path in discover_task_events(run_dir):
        row = rows.get(task)
        try:
            prof = profile_run(events_path, row)
        except ValueError as e:
            print("WARN: skipping %s: %s" % (events_path, e), file=sys.stderr)
            continue
        prof.update(task=task, arm=arm, rep=rep, run_dir=run_dir)
        out.append(prof)
    return out


# ---------------------------------------------------------------------------
# Aggregation and reporting.
# ---------------------------------------------------------------------------

def nearest_rank(values, pct):
    """Nearest-rank percentile; None for an empty list. Matches harness.py."""
    if not values:
        return None
    v = sorted(values)
    k = max(1, -(-pct * len(v) // 100))  # ceil(pct/100 * n)
    return v[int(k) - 1]


def print_table(per_arm):
    for arm in sorted(per_arm):
        runs = per_arm[arm]
        totals = [r["total"] for r in runs]
        p50_total = nearest_rank(totals, 50)
        sum_total = sum(totals)
        stage_names = sorted({name for r in runs for name in r["stages"]})
        rows = []
        pm_runs = [r["pre_model"] for r in runs if r.get("pre_model")]
        for name in stage_names + ["unattributed"]:
            vals = [r["stages"].get(name, 0.0) if name != "unattributed" else r["unattributed"]
                    for r in runs]
            p50 = nearest_rank(vals, 50)
            p90 = nearest_rank(vals, 90)
            # Aggregate share: sum of this stage's seconds over sum of every
            # run's total, across the arm's runs. Sums to 100% by
            # construction (unlike a p50-over-p50 ratio, which does not,
            # since p50s of different stages do not fall on the same run).
            share = (sum(vals) / sum_total * 100.0) if sum_total else None
            pm = nearest_rank([m.get("stages", {}).get(name, 0.0) for m in pm_runs], 50) if pm_runs and name != "unattributed" else None
            rows.append((name, p50, p90, share, pm))
        print("\n== %s (n=%d, total p50=%.1fs p90=%.1fs) ==" %
              (arm, len(runs), p50_total or 0.0, nearest_rank(totals, 90) or 0.0))
        print("%-14s %10s %10s %10s %14s" % ("stage", "p50 (s)", "p90 (s)", "share %", "pre_model p50"))
        for name, p50, p90, share, pm in rows:
            print("%-14s %10.1f %10.1f %9.1f%% %14s" % (name, p50, p90, share if share else 0.0,
                                                       "-" if pm is None else "%.2f" % pm))
        if pm_runs:
            print("  pre_model span p50=%.2fs (n=%d, argv to first provider byte)"
                  % (nearest_rank([m.get("span_s", 0.0) for m in pm_runs], 50) or 0.0, len(pm_runs)))
        unattr_vals = [r["unattributed"] for r in runs]
        pre_vals = [r["unattributed_pre_launch"] for r in runs]
        internal_vals = [r["unattributed_internal_gap"] for r in runs]
        post_vals = [r["unattributed_post_push"] for r in runs]
        print("  unattributed breakdown p50: pre-launch=%.2fs internal-gap=%.2fs post-push=%.2fs"
              % (nearest_rank(pre_vals, 50) or 0.0, nearest_rank(internal_vals, 50) or 0.0,
                 nearest_rank(post_vals, 50) or 0.0))


# ---------------------------------------------------------------------------
# Self-test.
# ---------------------------------------------------------------------------

def _ev(seq, t_offset, etype, stage, base):
    return {"seq": seq, "ts": (base + timedelta(seconds=t_offset)).isoformat().replace("+00:00", "Z"),
            "type": etype, "stage": stage}


def _write_synthetic_journal(path):
    """A tiny journal covering: sequential intake, plan/wall overlap (cascade),
    sequential implement, two fix rounds each followed by verify, commit,
    seal, then an untracked pr/deep gap before run.completed."""
    base = datetime(2026, 1, 1, 0, 0, 0)
    events = [
        _ev(0, 0.0, "run.started", None, base),
        _ev(1, 0.0, "stage.started", "intake", base),
        _ev(2, 2.0, "stage.completed", "intake", base),
        _ev(3, 2.0, "stage.started", "plan", base),
        _ev(4, 2.1, "stage.started", "wall", base),   # wall opens while plan is open
        _ev(5, 10.0, "stage.completed", "plan", base),  # plan closes; wall still open
        _ev(6, 20.0, "stage.failed", "wall", base),
        _ev(7, 20.0, "stage.started", "implement", base),
        _ev(8, 40.0, "stage.completed", "implement", base),
        _ev(9, 40.0, "stage.started", "verify", base),
        _ev(10, 41.0, "stage.completed", "verify", base),
        _ev(11, 41.0, "stage.started", "fix", base),
        _ev(12, 45.0, "stage.completed", "fix", base),
        _ev(13, 45.0, "stage.started", "verify", base),
        _ev(14, 45.5, "stage.completed", "verify", base),
        _ev(15, 45.5, "stage.started", "fix", base),
        _ev(16, 50.0, "stage.completed", "fix", base),
        _ev(17, 50.0, "stage.started", "verify", base),
        _ev(18, 50.2, "stage.completed", "verify", base),
        _ev(19, 50.2, "stage.started", "commit", base),
        _ev(20, 50.3, "stage.completed", "commit", base),
        _ev(21, 50.3, "stage.started", "seal", base),
        _ev(22, 50.4, "stage.completed", "seal", base),
        # 50.4 -> 51.0: pr.opened/deep.started point events, no stage open
        _ev(23, 50.5, "pr.opened", "pr", base),
        _ev(24, 50.6, "deep.started", "deep", base),
        _ev(25, 51.0, "run.completed", None, base),
    ]
    with open(path, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


def run_self_test():
    import math
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        journal = os.path.join(tmp, "events.jsonl")
        _write_synthetic_journal(journal)
        events = load_events(journal)
        stage_seconds, internal, run_started, run_completed = stage_self_time(events)

        # Plan gets only the 0.1s before wall opens; wall gets the rest of the
        # overlap plus its own remaining run (self-time / top-of-stack rule).
        assert math.isclose(stage_seconds["intake"], 2.0, abs_tol=1e-9), stage_seconds
        assert math.isclose(stage_seconds["plan"], 0.1, abs_tol=1e-9), stage_seconds
        assert math.isclose(stage_seconds["wall"], 17.9, abs_tol=1e-9), stage_seconds
        assert math.isclose(stage_seconds["implement"], 20.0, abs_tol=1e-9), stage_seconds
        assert math.isclose(stage_seconds["verify"], 1.7, abs_tol=1e-9), stage_seconds  # 1.0+0.5+0.2
        assert math.isclose(stage_seconds["fix"], 8.5, abs_tol=1e-9), stage_seconds       # 4.0+4.5
        assert math.isclose(stage_seconds["commit"], 0.1, abs_tol=1e-9), stage_seconds
        assert math.isclose(stage_seconds["seal"], 0.1, abs_tol=1e-9), stage_seconds
        assert math.isclose(internal, 0.6, abs_tol=1e-9), internal  # 50.4 -> 51.0
        assert (run_completed - run_started).total_seconds() == 51.0

        # Invariant: stage sum + internal unattributed == engine total exactly.
        engine_total = (run_completed - run_started).total_seconds()
        assert math.isclose(sum(stage_seconds.values()) + internal, engine_total, abs_tol=1e-9)

        # Journal-only profile (no harness row): total falls back to engine span.
        prof = profile_run(journal, row=None)
        assert math.isclose(prof["total"], 51.0, abs_tol=1e-9), prof
        assert math.isclose(prof["unattributed"], 0.6, abs_tol=1e-9), prof
        assert math.isclose(sum(prof["stages"].values()) + prof["unattributed"], prof["total"],
                             abs_tol=1e-9)

        # With a harness row: total is time_to_pr_s, pre/post overhead attributed.
        base = datetime(2026, 1, 1, 0, 0, 0)
        row = {"started": (base - timedelta(seconds=0.5)).isoformat().replace("+00:00", "Z"),
               "time_to_pr_s": 52}
        prof2 = profile_run(journal, row=row)
        assert math.isclose(prof2["total"], 52.0, abs_tol=1e-9), prof2
        assert math.isclose(prof2["unattributed_pre_launch"], 0.5, abs_tol=1e-9), prof2
        assert math.isclose(prof2["unattributed_post_push"], 0.5, abs_tol=1e-9), prof2
        assert math.isclose(prof2["unattributed_internal_gap"], 0.6, abs_tol=1e-9), prof2
        assert math.isclose(prof2["unattributed"], 1.6, abs_tol=1e-9), prof2
        assert math.isclose(sum(prof2["stages"].values()) + prof2["unattributed"], prof2["total"],
                             abs_tol=1e-9)

        # A run with no run.started event is refused, not guessed.
        bad = os.path.join(tmp, "bad.jsonl")
        with open(bad, "w", encoding="utf-8") as f:
            f.write(json.dumps({"seq": 0, "ts": "2026-01-01T00:00:00Z",
                                 "type": "stage.started", "stage": "intake"}) + "\n")
        try:
            stage_self_time(load_events(bad))
            raise AssertionError("expected ValueError for a journal with no run.started")
        except ValueError:
            pass

        # stage.skipped closes an opened stage without ever completing/
        # failing it (LOKI_E10_WALL=0's real behavior: wall opens, then is
        # skipped). Must not leak the rest of the run's time into "wall".
        skip_journal = os.path.join(tmp, "skip-events.jsonl")
        skip_base = datetime(2026, 1, 1, 0, 0, 0)
        skip_events = [
            _ev(0, 0.0, "run.started", None, skip_base),
            _ev(1, 0.0, "stage.started", "wall", skip_base),
            _ev(2, 0.05, "stage.skipped", "wall", skip_base),
            _ev(3, 0.05, "stage.started", "implement", skip_base),
            _ev(4, 10.0, "stage.completed", "implement", skip_base),
            _ev(5, 10.0, "run.completed", None, skip_base),
        ]
        with open(skip_journal, "w", encoding="utf-8") as f:
            for e in skip_events:
                f.write(json.dumps(e) + "\n")
        skip_stages, skip_internal, _, _ = stage_self_time(load_events(skip_journal))
        assert math.isclose(skip_stages["wall"], 0.05, abs_tol=1e-9), skip_stages
        assert math.isclose(skip_stages["implement"], 9.95, abs_tol=1e-9), skip_stages
        assert math.isclose(skip_internal, 0.0, abs_tol=1e-9), skip_internal

        # nearest_rank sanity (matches harness.py's ceil-based nearest rank).
        assert nearest_rank([10, 20, 30, 40], 50) == 20
        assert nearest_rank([10, 20, 30, 40], 90) == 40
        assert nearest_rank([], 50) is None

        # sibling_results_file: matches the "-engine" convention, else None.
        eng_dir = os.path.join(tmp, "e98f-engine", "default-r1")
        os.makedirs(eng_dir)
        assert sibling_results_file(eng_dir) is None  # no sibling present
        sib_dir = os.path.join(tmp, "e98f-default-r1")
        os.makedirs(sib_dir)
        with open(os.path.join(sib_dir, "results.jsonl"), "w") as f:
            pass
        assert sibling_results_file(eng_dir) == os.path.join(sib_dir, "results.jsonl")

        # load_dedup_rows: latest ok wins; else latest overall.
        rf = os.path.join(tmp, "results.jsonl")
        with open(rf, "w", encoding="utf-8") as f:
            f.write(json.dumps({"task": "t1", "status": "auth_unavailable", "started": None}) + "\n")
            f.write(json.dumps({"task": "t1", "status": "ok", "started": "2026-01-01T00:00:00Z",
                                 "time_to_pr_s": 10}) + "\n")
            f.write(json.dumps({"task": "t2", "status": "harness_error",
                                 "started": "2026-01-01T00:00:01Z"}) + "\n")
        rows = load_dedup_rows(rf)
        assert rows["t1"]["status"] == "ok" and rows["t1"]["time_to_pr_s"] == 10
        assert rows["t2"]["status"] == "harness_error"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run_dirs", nargs="*", help="preserved engine run-copy dirs to profile")
    ap.add_argument("--self-test", action="store_true", help="run built-in assert-based checks")
    ap.add_argument("--json", action="store_true", help="dump raw per-run profiles as JSON")
    args = ap.parse_args()

    if args.self_test:
        run_self_test()
        print("self-test OK")
        return 0

    if not args.run_dirs:
        ap.error("at least one run dir is required (or use --self-test)")

    per_arm = {}
    for run_dir in args.run_dirs:
        for prof in profile_run_dir(run_dir):
            per_arm.setdefault(prof["arm"], []).append(prof)

    if not any(per_arm.values()):
        print("no runs found under the given dirs", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(per_arm, indent=2, default=str))
        return 0

    print_table(per_arm)
    return 0


if __name__ == "__main__":
    sys.exit(main())
