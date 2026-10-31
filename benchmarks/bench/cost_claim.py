#!/usr/bin/env python3
"""Cost claim verdict: PROVEN_AT(target), NOT PROVEN or INVALID.

INVALID means the run cannot be read at all (retro 3.8.7): the environment
record shows an identity variable (USER, LOGNAME, HOME) unset, or the positive
control task was not accepted on every row. The CLI never prints PROVEN_AT
without both an --env-record and a --control-task.

Pure function over per-row results for a Loki arm and a floor arm. The claim is
about the cost-per-accepted ratio (loki / floor). A paired bootstrap over tasks
(fixed seed) gives the 95% CI; the claim is gated on the CI upper bound, never
the point estimate.

Row shape (dict): task_id, accepted (bool), cost_usd (finite float >= 0; anything else blocks the verdict), and optionally
cost_partial (bool), unmeasured (bool), cost_profile (str), engine (str), loki_version (str), model_used (str), cost_source (str; required, one per arm).
Rows may also carry elapsed_s; the verdict adds an informational paired time
ratio (floor / loki, above 1 means loki is faster) with the same bootstrap CI.
Rows without a usable elapsed_s are excluded from it and counted. The time
ratio never changes the verdict.
Unmeasured rows are excluded from acceptance and every gate except cost (their
spend still counts); their count is reported and, when the verdict is NOT
PROVEN, listed among the reasons.

Scoreboard cost fields, per arm (both arms of a cost claim run on Claude, so
both are claude arms): metered_share is the share of the arm's rows, unmeasured
ones included, carrying a provider-reported usd cost (finite cost_usd, a
cost_source, not cost_partial); cost_per_accepted_usd is total spend over every
attempt, failed and unmeasured ones included, divided by accepted measured
tasks. The cost ratio and its CI use the same numerator. Below a metered share
of 1.0 the verdict is INVALID, the ratio, CI and ci reason are withheld and the
arm reports only
cost_per_accepted_lower_bound_usd, never a point estimate. reconciliation_error
compares the run's summed cost_usd with an Anthropic console usage CSV export
for the run window (--usage-csv); without one it is "not measured", never 0.

No emojis. No em dashes.
"""

import argparse
import json
import math
import random
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_schema as _schema  # noqa: E402

MIN_N_PER_TASK = 3
BOOTSTRAP_ITERS = 2000
DEFAULT_SEED = 20261016


def _good_cost(r):
    """True when cost_usd is a finite number >= 0 (bool, None, NaN, negative are not)."""
    v = r.get("cost_usd")
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v) and v >= 0)


def _cpa(rows):
    """Cost per accepted task over rows; None when nothing was accepted.

    Every row's spend counts, unmeasured ones included; only measured rows can
    be accepted. Rows with an unusable cost_usd add nothing here; the verdict is
    INVALID on them.
    """
    accepted = sum(1 for r in rows if r.get("accepted") and not r.get("unmeasured"))
    if accepted == 0:
        return None
    return sum(r["cost_usd"] for r in rows if _good_cost(r)) / accepted


def _metered(r):
    """True when the row carries a full provider-reported usd cost."""
    return _good_cost(r) and bool(r.get("cost_source")) and not r.get("cost_partial")


def _arm_cost(rows):
    """Scoreboard cost fields for one arm; a point cost only when fully metered."""
    share = (sum(1 for r in rows if _metered(r)) / len(rows)) if rows else None
    cpa = _cpa(rows)
    full = share == 1.0
    return {
        "metered_share": share,
        "cost_per_accepted_usd": cpa if full else None,
        "cost_per_accepted_lower_bound_usd": cpa if not full else None,
    }


CONSOLE_COST_COLUMNS = ("cost_usd", "cost (usd)", "total_cost_usd",
                        "amount_usd")
_TOTAL_ROW = re.compile(r"\s*(sub)?total\b", re.IGNORECASE)
_CURRENCY_HEAD = re.compile(r"currency|ccy", re.IGNORECASE)
_USD_CELL = re.compile(r"-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?")


def console_usd_from_csv(path):
    """Sum the usd cost column of an Anthropic console usage CSV export.

    The column is the first header (case-insensitive) in CONSOLE_COST_COLUMNS.
    Only usd-named columns count, and any currency column must read USD on every
    row. No such column, a total or subtotal word at the start of any non-cost
    cell, a non-USD currency, or a blank, non-numeric or badly comma-grouped
    cost cell raises ValueError: an
    unreadable export is never read as 0 and never summed twice.
    """
    import csv
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        heads = {(h or "").strip().lower(): h for h in (reader.fieldnames or [])}
        col = next((heads[c] for c in CONSOLE_COST_COLUMNS if c in heads), None)
        if col is None:
            raise ValueError("usage csv %s has no cost column (headers: %s)"
                             % (path, ",".join(heads)))
        total = 0.0
        others = [h for h in reader.fieldnames if h != col]
        for i, rec in enumerate(reader, start=2):
            if any(isinstance(rec.get(h), str) and _TOTAL_ROW.match(rec[h])
                   for h in others):
                raise ValueError("usage csv %s line %d: total or subtotal row; "
                                 "export the itemised rows only" % (path, i))
            for h in others:
                if _CURRENCY_HEAD.search(h or "") and \
                        (rec.get(h) or "").strip().upper() != "USD":
                    raise ValueError("usage csv %s line %d: currency %r is not "
                                     "USD" % (path, i, rec.get(h)))
            cell = (rec.get(col) or "").strip().replace("$", "", 1)
            if not _USD_CELL.fullmatch(cell):
                raise ValueError("usage csv %s line %d: cost %r is not a number"
                                 % (path, i, rec.get(col)))
            v = float(cell.replace(",", ""))
            if not math.isfinite(v):
                raise ValueError("usage csv %s line %d: cost is not finite"
                                 % (path, i))
            total += v
    return total


def reconcile(run_rows, console_usd):
    """The run's summed cost_usd against the console usage total.

    Returns (error, detail). error is (run - console) / console as a float, or
    the string "not measured" when there is no export, the console total is not
    above 0, or any row lacks a usable cost (the run sum would be a lower bound).
    """
    rows = list(run_rows)
    if console_usd is None:
        return "not measured", {"reason": "no console usage csv given"}
    if not rows:
        return "not measured", {"reason": "no run rows", "console_usd": console_usd}
    missing = sum(1 for r in rows if not _good_cost(r) or r.get("cost_partial"))
    if missing:
        return "not measured", {"reason": "%d run row(s) without a usable "
                                "cost_usd" % missing, "console_usd": console_usd}
    if console_usd <= 0:
        return "not measured", {"reason": "console usage total is not above 0",
                                "console_usd": console_usd}
    run = sum(r["cost_usd"] for r in rows)
    return ((run - console_usd) / console_usd,
            {"run_usd": run, "console_usd": console_usd})


def _group(rows):
    by_task = {}
    for r in rows:
        by_task.setdefault(r.get("task_id"), []).append(r)
    return by_task


def _percentile(sorted_vals, q):
    idx = q * (len(sorted_vals) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


def bootstrap_ratio_ci(loki_rows, floor_rows, seed=DEFAULT_SEED,
                       iters=BOOTSTRAP_ITERS):
    """Paired bootstrap over tasks. Returns (point, lo, hi) or None."""
    lg, fg = _group(loki_rows), _group(floor_rows)
    tasks = sorted((t for t in lg if t in fg), key=str)
    point_l, point_f = _cpa(loki_rows), _cpa(floor_rows)
    if not tasks or point_l is None or not point_f:
        return None
    rng = random.Random(seed)
    ratios = []
    for _ in range(iters):
        pick = [tasks[rng.randrange(len(tasks))] for _ in tasks]
        a = _cpa([r for t in pick for r in lg[t]])
        b = _cpa([r for t in pick for r in fg[t]])
        if a is None or not b:
            continue
        ratios.append(a / b)
    if not ratios:
        return None
    ratios.sort()
    return (point_l / point_f, _percentile(ratios, 0.025),
            _percentile(ratios, 0.975))


def _has_elapsed(r):
    v = r.get("elapsed_s")
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v) and v >= 0)


def _mean_elapsed(rows):
    """Mean elapsed_s over rows; None when there are no rows."""
    return sum(r["elapsed_s"] for r in rows) / len(rows) if rows else None


def bootstrap_time_ratio_ci(loki_rows, floor_rows, seed=DEFAULT_SEED,
                            iters=BOOTSTRAP_ITERS):
    """Paired bootstrap of mean elapsed_s, floor / loki. (point, lo, hi) or None.

    Only rows with a usable elapsed_s count, and only tasks timed in both arms.
    """
    lg = _group([r for r in loki_rows if _has_elapsed(r)])
    fg = _group([r for r in floor_rows if _has_elapsed(r)])
    tasks = sorted((t for t in lg if t in fg), key=str)
    if not tasks:
        return None
    point_l = _mean_elapsed([r for t in tasks for r in lg[t]])
    point_f = _mean_elapsed([r for t in tasks for r in fg[t]])
    if not point_l or point_f is None:
        return None
    rng = random.Random(seed)
    ratios = []
    for _ in range(iters):
        pick = [tasks[rng.randrange(len(tasks))] for _ in tasks]
        a = _mean_elapsed([r for t in pick for r in lg[t]])
        b = _mean_elapsed([r for t in pick for r in fg[t]])
        if not a:
            continue
        ratios.append(b / a)
    if not ratios:
        return None
    ratios.sort()
    return (point_f / point_l, _percentile(ratios, 0.025),
            _percentile(ratios, 0.975))


def _acc_rate(rows):
    return sum(1 for r in rows if r.get("accepted")) / len(rows) if rows else 0.0


def _loki_cost_profile(loki):
    """The loki arm's single cost_profile, "mixed", or None if no row names one."""
    profiles = {r.get("cost_profile") for r in loki}
    if profiles <= {None}:
        return None
    if len(profiles) > 1:
        return "mixed"
    return next(iter(profiles))


def _control_problems(control_rows):
    rows = list(control_rows)
    if not rows:
        return ["control: positive control has no rows"]
    bad = sum(1 for r in rows if r.get("unmeasured") or r.get("accepted") is not True)
    if bad:
        return ["control: positive control not accepted on %d of %d row(s)"
                % (bad, len(rows))]
    return []


def cost_claim_verdict(loki_rows, floor_rows, target, seed=DEFAULT_SEED,
                       iters=BOOTSTRAP_ITERS, environment=None,
                       control_rows=None, run_rows=None, console_usd=None):
    """Return {verdict, target, ratio, ci_low, ci_high, unmeasured, cost_profile,
    reasons, ...}. cost_profile is the loki arm's profile (lean, default, off),
    "mixed" when the arm mixes or partly lacks it, null when no row names one.
    run_rows (default: both arms) is every row billed in the run window; it is
    reconciled against console_usd, the console usage export total."""
    if run_rows is None:
        run_rows = list(loki_rows) + list(floor_rows)
    reasons = []
    invalid = []
    if environment is not None:
        invalid += ["env: %s" % p for p in _schema.identity_env_problems(environment)]
    if control_rows is not None:
        invalid += _control_problems(control_rows)
    loki_rows, floor_rows = _schema.without_retired(list(loki_rows)), _schema.without_retired(list(floor_rows))  # a retired task never feeds a claim
    unmeasured = sum(1 for r in list(loki_rows) + list(floor_rows)
                     if r.get("unmeasured"))
    loki = [r for r in loki_rows if not r.get("unmeasured")]
    floor = [r for r in floor_rows if not r.get("unmeasured")]
    rows = loki + floor
    arm_cost = {"loki": _arm_cost(loki_rows), "floor": _arm_cost(floor_rows)}
    unmetered = [n for n in ("loki", "floor")
                 if arm_cost[n]["metered_share"] is not None
                 and arm_cost[n]["metered_share"] < 1.0]
    for name in unmetered:
        invalid.append("metered: %s metered share %.3f below 1.0"
                       % (name, arm_cost[name]["metered_share"]))

    if not loki or not floor:
        reasons.append("no_data: an arm has no measured rows")
    if any(r.get("cost_partial") for r in rows):
        reasons.append("partial: cost_partial row present")
    bad_cost = sum(1 for r in rows if not _good_cost(r))
    if bad_cost:
        reasons.append("cost: %d row(s) with missing, non-finite or negative "
                       "cost_usd" % bad_cost)

    engines = {r.get("engine") for r in rows}
    versions = {r.get("loki_version") for r in rows}
    if None in engines or len(engines) > 1:
        reasons.append("engine: missing or mixed engine")
    if None in versions or len(versions) > 1:
        reasons.append("version: missing or mixed loki_version")

    def _model(r):
        return r.get("model_used") or r.get("model")

    if rows and any(not _model(r) for r in rows):
        reasons.append("model: missing model on a row")
    else:
        lm = {_model(r) for r in loki}
        fm = {_model(r) for r in floor}
        if len(lm) > 1 or len(fm) > 1:
            reasons.append("model: mixed models within an arm")
        elif lm and fm and lm != fm:
            reasons.append("model: arms differ (loki %s, floor %s)"
                           % (",".join(sorted(lm)), ",".join(sorted(fm))))

    for name, arm in (("loki", loki), ("floor", floor)):
        small = sorted(str(t) for t, g in _group(arm).items()
                       if len(g) < MIN_N_PER_TASK)
        if small:
            reasons.append("n: %s has fewer than %d runs for %s"
                           % (name, MIN_N_PER_TASK, ",".join(small)))

    if loki and floor and _acc_rate(loki) < _acc_rate(floor):
        reasons.append("acceptance: loki %.3f below floor %.3f"
                       % (_acc_rate(loki), _acc_rate(floor)))

    if loki and floor:
        lt, ft = set(_group(loki)), set(_group(floor))
        if lt != ft:
            only = sorted(str(t) for t in lt ^ ft)
            reasons.append("tasks: arms cover different task sets (%s)"
                           % ",".join(only))

    if rows and any(not r.get("cost_source") for r in rows):
        reasons.append("cost_source: missing cost_source on a row")
    else:
        for name, arm in (("loki", loki), ("floor", floor)):
            srcs = {r.get("cost_source") for r in arm}
            if len(srcs) > 1:
                reasons.append("cost_source: %s mixes sources (%s)"
                               % (name, ",".join(sorted(srcs))))

    cost_profile = _loki_cost_profile(loki)
    if cost_profile == "mixed":
        reasons.append("cost_profile: loki arm mixes profiles or lacks "
                       "cost_profile on some rows")

    # Unmeasured spend is real spend: the ratio reads every row's cost.
    ci = (bootstrap_ratio_ci(loki_rows, floor_rows, seed, iters)
          if loki and floor and not unmetered else None)
    ratio = lo = hi = None
    if unmetered:
        pass  # INVALID; a ratio of lower bounds is no estimate, so no ci line
    elif ci:
        ratio, lo, hi = ci
        if hi > target:
            reasons.append("ci: upper bound %.4f exceeds target %s"
                           % (hi, target))
    elif loki and floor:
        reasons.append("ci: not computable (no accepted work or no paired tasks)")

    time_excluded = sum(1 for r in rows if not _has_elapsed(r))
    tci = bootstrap_time_ratio_ci(loki, floor, seed, iters)

    if reasons and unmeasured:
        reasons.append("unmeasured: %d row(s) excluded" % unmeasured)

    recon_err, recon_detail = reconcile(run_rows, console_usd)
    reasons = invalid + reasons
    if invalid:
        verdict = "INVALID"
    else:
        verdict = ("PROVEN_AT(%s)" % target) if not reasons else "NOT PROVEN"
    return {
        "verdict": verdict,
        "identity_checked": environment is not None,
        "control_checked": control_rows is not None,
        "target": target,
        "ratio": ratio,
        "ci_low": lo,
        "ci_high": hi,
        "unmeasured": unmeasured,
        "cost_profile": cost_profile,
        "reasons": reasons,
        "time_ratio": tci[0] if tci else None,
        "time_ci": [tci[1], tci[2]] if tci else None,
        "time_rows_excluded": time_excluded,
        "arm_cost": arm_cost,
        "reconciliation_error": recon_err,
        "reconciliation": recon_detail,
    }


def _map_row(r):
    """Attribution row to verdict row."""
    out = dict(r)
    out["task_id"] = r.get("task")
    if r.get("status") in ("unmeasured", "harness_error"):
        out["unmeasured"] = True
    return out


def _load_rows(paths):
    """Return (object rows, count of non-object rows skipped)."""
    rows = []
    skipped = 0
    for p in paths:
        with open(p) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    if isinstance(r, dict):
                        rows.append(r)
                    else:
                        skipped += 1
    return rows, skipped


def _finite_positive(text):
    try:
        v = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("not a number: %r" % text)
    if not math.isfinite(v) or v <= 0:
        raise argparse.ArgumentTypeError(
            "must be a finite number greater than 0: %r" % text)
    return v


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Cost claim verdict over attribution rows")
    ap.add_argument("--rows", nargs="+", required=True)
    ap.add_argument("--loki-arm", required=True)
    ap.add_argument("--floor-arm", required=True)
    ap.add_argument("--target", type=_finite_positive, required=True)
    ap.add_argument("--exclude-task", action="append", default=[])
    ap.add_argument("--env-record", help="attribution JSON (or its environment object); required for PROVEN_AT")
    ap.add_argument("--control-task", help="known-solvable task id; every row must be accepted; required for PROVEN_AT")
    ap.add_argument("--usage-csv", help="Anthropic console usage CSV export for the run window; without it reconciliation is not measured")
    try:
        a = ap.parse_args(argv)
        rows, skipped = _load_rows(a.rows)
        environment = None
        if a.env_record:
            with open(a.env_record) as f:
                rec = json.load(f)
            environment = rec.get("environment", rec) if isinstance(rec, dict) else {}
        console_usd = console_usd_from_csv(a.usage_csv) if a.usage_csv else None
    except SystemExit as e:
        return 2 if e.code else 0
    except (OSError, ValueError) as e:
        print("usage error: %s" % e, file=sys.stderr)
        return 2
    if a.loki_arm == a.floor_arm:
        print("usage error: --loki-arm and --floor-arm must differ: %r"
              % a.loki_arm, file=sys.stderr)
        return 2
    if skipped:
        print("warning: skipped %d non-object row(s)" % skipped,
              file=sys.stderr)
    excl = set(a.exclude_task)
    seen_tasks = {r.get("task") for r in rows}
    unmatched = sorted(t for t in excl if t not in seen_tasks)
    for t in unmatched:
        print("warning: --exclude-task %r matches no row" % t,
              file=sys.stderr)
    run_rows = [_map_row(r) for r in rows]  # everything billed in the window
    rows = [_map_row(r) for r in rows if r.get("task") not in excl]
    arm_rows = [r for r in rows if r.get("arm") in (a.loki_arm, a.floor_arm)]
    control = None
    if a.control_task:
        control = [r for r in arm_rows if r.get("task") == a.control_task]
        arm_rows = [r for r in arm_rows if r.get("task") != a.control_task]
    loki = [r for r in arm_rows if r.get("arm") == a.loki_arm]
    floor = [r for r in arm_rows if r.get("arm") == a.floor_arm]
    v = cost_claim_verdict(loki, floor, a.target, environment=environment,
                           control_rows=control, run_rows=run_rows,
                           console_usd=console_usd)
    if v["verdict"].startswith("PROVEN_AT"):
        missing = []
        if environment is None:
            missing.append("env: no identity record (pass --env-record)")
        if control is None:
            missing.append("control: no positive control (pass --control-task)")
        if missing:
            v["verdict"] = "NOT PROVEN"
            v["reasons"] = missing + v["reasons"]
    v["excluded_tasks"] = sorted(excl)
    v["unmatched_exclusions"] = unmatched
    v["skipped_non_object_rows"] = skipped
    print(json.dumps(v, indent=2, sort_keys=True))
    if v["verdict"] == "INVALID":
        return 3
    return 0 if v["verdict"].startswith("PROVEN_AT") else 1


if __name__ == "__main__":
    sys.exit(main())
