#!/usr/bin/env python3
"""Project agent spend forward from recorded history, with an honest basis.

cost-history.py answers "is our spend trending up?" over runs already made.
The question that follows immediately, and the one a budget owner actually
asks, is forward-looking: we are about to do N more runs, what will they cost?
That is a PROJECTION, and a projection is the easiest place in this repo to
launder an absent measurement into a confident number.

THE FAILURE MODE THIS TOOL IS SHAPED AROUND. A forecast is arithmetic over a
sample, and arithmetic is happy to run on an empty sample: sum([]) is 0, and
0 * N is 0. So the naive implementation answers "$0.00" for a project with no
recorded history at all, which is not a cautious estimate -- it is the single
most confident claim the tool can make ("these runs are free"), produced at the
exact moment it knows nothing. An earlier attempt at this tool did precisely
that, projecting $0.00 from zero measured runs.

So the rule, and it is the whole tool:

    NO MEASURED HISTORY MEANS NO FORECAST. Not a zero, not a cautious low
    estimate, not a wide range around zero. No number at all.

Absent is not zero. A forecast is a claim about the future built from a sample
of the past, and with an empty sample there is no claim to make. Exit 3
(nothing to check), print the absence in words, and emit no dollar figure
anywhere -- including in --json, where `projected_usd` is null.

FOUR MORE PROPERTIES, each the honest half of a shortcut that would read better:

1. A TREND FROM ONE POINT IS NOT A TREND, but it is still a measurement. With
   exactly one measured run this DOES forecast -- refusing would throw away
   real data, which is the over-strict mirror of the same dishonesty -- and it
   labels the projection SINGLE OBSERVATION, stating in words that it assumes
   a flat rate from one point. The reader gets the number AND the reason to
   distrust it. Silently presenting it like a 40-run mean is the lie.

2. THE BASIS IS PRINTED ON EVERY PROJECTION, never on request. "M measured of
   N recorded" is what makes the number auditable: $4.20 from 40 measured runs
   and $4.20 from 1 measured run of 39 are different facts, and the number
   alone cannot tell them apart. A basis available behind a --verbose flag is a
   basis nobody reads.

3. AN UNMEASURED ROW IS EXCLUDED, NEVER READ AS 0. cost-history.py records an
   unmeasured run as usd=null on purpose, so the measurement gap stays
   countable. Averaging those nulls as 0 would drag the mean down and understate
   the forecast -- and it would do so worst when instrumentation is broken, i.e.
   when the estimate matters most. Excluded rows are COUNTED and reported.

4. A MEASURED ZERO IS NOT AN UNMEASURED ROW. A run that genuinely cost $0.0000
   (cached, free tier) is data and stays in the mean as 0. This is why every
   test here is `is None` and never a truthiness check: `if usd:` would drop a
   real zero and silently bias the forecast upward. record_is_measured() is
   imported for the legacy row that carries no `measured` flag, and is
   deliberately NOT applied to the flagged rows -- it is a truthiness predicate
   over token fields, so it answers False for a measured $0.00, which is
   correct for its own question and wrong for this one.

5. A CORRUPT LINE IS COUNTED AND REPORTED, never silently skipped. A history
   that quietly drops rows forecasts from a cleaner sample than reality.

WHY THE MEAN AND NOT THE MEDIAN. cost-history.py trends on the median, because
a trend must not be named by one outlier. A forecast of TOTAL spend over N runs
is a different question: the expensive runs are real money and the total has to
include them. mean * N is the unbiased estimator of that total; median * N
systematically under-forecasts any right-skewed cost distribution, which agent
spend always is. Both numbers are printed so the skew is visible.

NOT A GATE. This advises a budget owner; no CI job branches on its exit code,
and it never blocks a merge. Exit 3 on an absent basis says "nothing to check",
which is the honest answer to "what will N runs cost" when nothing was measured.

Usage:
  tools/cost-forecast.py --runs N [--file .loki/cost-history.jsonl] [--json]

Exit: 0 forecast produced, 2 history unreadable, 3 nothing to forecast from,
64 usage error, 66 history file does not exist.
"""

import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "autonomy", "lib"))

from efficiency_cost import record_is_measured  # noqa: E402

OK, CANNOT, NOTHING_TO_CHECK, USAGE, NO_INPUT = 0, 2, 3, 64, 66

DEFAULT_FILE = os.path.join(".loki", "cost-history.jsonl")


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, and 2 here means "could not check".

    Those are opposite facts. "You typed the flag wrong" and "the instrument is
    blind" must not share an exit code: a typo would masquerade as a blind
    gate, and the operator would go hunting for missing instrumentation.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        print("%s: error: %s" % (self.prog, message), file=sys.stderr)
        raise SystemExit(USAGE)


def _num(v):
    """A number as itself; None, "", or a bool as None. A real 0 survives as 0."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def row_usd(row):
    """The measured USD for one history row, or None when it was not measured.

    THE ONE PLACE the measured/unmeasured distinction is decided, so it cannot
    drift between the loader and the reporter.

    `measured` is cost-history.py's own flag, written at record time by
    record_is_measured(), so trusting it REUSES that rule rather than restating
    it. A legacy row without the flag falls back to record_is_measured() here.

    The final test is `is not None`, never truthiness: a genuine $0.0000 run is
    a measurement and must survive as 0.0. Dropping it would bias every
    forecast upward, and would do it invisibly.

    THE ORDER OF THE LEGACY BRANCH IS LOAD-BEARING. record_is_measured() is a
    TRUTHINESS predicate over token fields, so it answers False for a measured
    $0.0000 -- correct for its own question ("did this record observe
    anything?"), wrong for this one ("is this dollar figure present?"). Asking
    it first would drop a real zero from a flag-less row while the identical
    flagged row was kept, so the same fact got two answers depending on which
    version of cost-history.py wrote it. `usd is None` is therefore tested
    FIRST and short-circuits; record_is_measured() only ever adjudicates rows
    whose usd is already absent.
    """
    if not isinstance(row, dict):
        return None
    usd = _num(row.get("usd"))
    if "measured" in row:
        if row.get("measured") is not True:
            return None
    elif usd is None and not record_is_measured(row):
        return None
    return usd


def load(path):
    """Read the history. Returns (rows, corrupt_count) or (None, 0) if unreadable.

    A line that is not JSON, or is JSON but not an object carrying `usd`, is
    corrupt and COUNTED. It is never dropped on the floor: a history that
    quietly loses rows forecasts from a tidier sample than the real one, and
    loses them most often when something upstream just broke.
    """
    rows, corrupt = [], 0
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except OSError:
        return None, 0
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            corrupt += 1
            continue
        if not isinstance(obj, dict) or "usd" not in obj:
            corrupt += 1
            continue
        rows.append(obj)
    return rows, corrupt


def median(values):
    """Median of a non-empty list. Even length averages the middle pair."""
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def forecast(path, runs):
    """Project spend over `runs` future runs. Returns a verdict dict.

    Every absence path returns projected_usd=None. There is no branch in this
    function that produces a number from an empty sample, which is the property
    the whole file exists to hold.
    """
    base = {
        "runs": runs,
        "recorded": 0,
        "measured": 0,
        "excluded_unmeasured": 0,
        "corrupt_lines": 0,
        "mean_usd": None,
        "median_usd": None,
        "projected_usd": None,
        "confidence": "NONE",
        "basis": None,
    }

    if not os.path.exists(path):
        base["status"] = "no_history"
        base["exit_code"] = NO_INPUT
        base["why"] = ("no history file at %s -- record runs with "
                       "tools/cost-history.py record first. There is no "
                       "sample to project from, so there is no forecast."
                       % path)
        return base

    rows, corrupt = load(path)
    if rows is None:
        base["status"] = "unreadable"
        base["exit_code"] = CANNOT
        base["why"] = ("history at %s exists but could not be read; the "
                       "instrument is blind, which is not the same as a "
                       "cheap forecast." % path)
        return base

    base["recorded"] = len(rows)
    base["corrupt_lines"] = corrupt

    costs = []
    unmeasured = 0
    for row in rows:
        usd = row_usd(row)
        if usd is None:
            unmeasured += 1
        else:
            costs.append(usd)
    base["measured"] = len(costs)
    base["excluded_unmeasured"] = unmeasured

    if not costs:
        # THE PATH THAT MUST NEVER PRODUCE A NUMBER. Zero measured runs, whether
        # from an empty file, an all-null history, or nothing but corrupt lines.
        # sum([])/0 does not even divide, and the tempting repair -- treat the
        # nulls as 0 -- is the lie itself. projected_usd stays None.
        base["status"] = "no_measured_history"
        base["exit_code"] = NOTHING_TO_CHECK
        base["why"] = (
            # No dollar SIGN anywhere on this path, not even in prose. The
            # tests assert the absence of "$" in the whole output, which is one
            # assertion that catches every number at once -- worth more than
            # the rhetorical flourish of quoting the figure being refused.
            "%d run(s) recorded, 0 measured%s. A forecast is arithmetic over a "
            "sample and there is no sample, so no figure is given: an absent "
            "measurement reads UNKNOWN, never zero."
            % (len(rows),
               " (%d unmeasured, excluded not counted as 0)" % unmeasured
               if unmeasured else ""))
        return base

    mean = sum(costs) / float(len(costs))
    base["mean_usd"] = mean
    base["median_usd"] = median(costs)
    base["projected_usd"] = mean * runs
    base["status"] = "ok"
    base["exit_code"] = OK

    if len(costs) < 2:
        # One point is a measurement but not a trend. Forecast anyway -- the
        # data is real -- and say plainly what the projection assumes, so the
        # number is never mistaken for a 40-run mean.
        base["confidence"] = "SINGLE OBSERVATION"
        base["assumption"] = (
            "flat rate assumed from a SINGLE observation; one point cannot "
            "establish a trend, so this projects that one run's cost forward "
            "unchanged and says nothing about whether spend is rising.")
    else:
        base["confidence"] = "MULTI OBSERVATION"
        base["assumption"] = (
            "flat rate assumed: the mean of %d measured run(s) projected "
            "forward. This does not model a trend; use "
            "tools/cost-history.py report for direction." % len(costs))

    base["basis"] = ("%d measured of %d recorded run(s)"
                     % (len(costs), len(rows)))
    return base


def render(d):
    """Text rendering. Every absence branch returns BEFORE any %-format of a
    dollar figure, so a None projection can never reach a float format."""
    if d["status"] == "no_history":
        return "NO FORECAST: %s" % d["why"]
    if d["status"] == "unreadable":
        return "CANNOT FORECAST: %s" % d["why"]

    lines = []
    if d["corrupt_lines"]:
        lines.append("%d CORRUPT line(s) in the history -- counted, not "
                     "skipped; excluded from the sample below."
                     % d["corrupt_lines"])
    if d["excluded_unmeasured"]:
        lines.append("%d unmeasured run(s) EXCLUDED (recorded as null, never "
                     "averaged as 0)." % d["excluded_unmeasured"])

    if d["status"] == "no_measured_history":
        lines.append("NO FORECAST: %s" % d["why"])
        return "\n".join(lines)

    lines.append("basis: %s" % d["basis"])
    lines.append("mean $%.4f/run, median $%.4f/run"
                 % (d["mean_usd"], d["median_usd"]))
    lines.append("projected over %d run(s): $%.4f"
                 % (d["runs"], d["projected_usd"]))
    lines.append("confidence: %s" % d["confidence"])
    lines.append(d["assumption"])
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Project agent spend forward from recorded cost history.")
    ap.add_argument("--runs", type=int, required=True,
                    help="number of future runs to project over")
    ap.add_argument("--file", default=DEFAULT_FILE,
                    help="history JSONL (default %s)" % DEFAULT_FILE)
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the forecast as JSON")

    args = ap.parse_args(argv)
    if args.runs < 1:
        # Not a forecast question. Refusing beats answering $0.00 for 0 runs,
        # which is a real number that reads like a measurement.
        ap.error("--runs must be 1 or greater (got %d)" % args.runs)

    d = forecast(args.file, args.runs)
    print(json.dumps(d, indent=2, sort_keys=True) if args.as_json
          else render(d))
    return d["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
