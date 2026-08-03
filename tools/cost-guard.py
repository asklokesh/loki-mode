#!/usr/bin/env python3
"""Fail a build when a run's cost regressed. A cost gate for CI.

Teams gate merges on tests. This lets them gate merges on cost the same way:
point it at a workspace, give it a ceiling or a baseline receipt, and it exits
non-zero when the run got more expensive than the policy allows.

THE RULE THAT MAKES IT A GATE RATHER THAN DECORATION:

    UNMEASURED IS NOT WITHIN BUDGET. Exit 2, never 0.

A gate's exit code is a merge decision, and "we did not measure" carries zero
information about budget compliance. Mapping absence to 0 would make this gate
loudest -- a confident green -- at exactly the moment instrumentation broke and
it is least entitled to speak. That is the failure this repo spent thirteen
surfaces fixing: an unmeasured run rendered as "$0.00", which reads as free.
Free and unmeasured are different claims and only one of them is honest. Exit 2
keeps "no evidence" distinguishable from "evidence of compliance".

Exit 0 is reachable from exactly ONE place in this file (the end of evaluate()),
and only after a measurement was read. Everything else -- no policy given, an
unreadable baseline, an unmeasured run, an unmeasured baseline -- is 2.

Whether a number counts as measured is record_is_measured() in
autonomy/lib/efficiency_cost.py, imported and never restated: a second copy of
that predicate is precisely how the honesty rule drifts. Receipts store the
figure under cost.usd while the predicate reads cost_usd, so the KEY is mapped
here. Mapping a key name is not restating the rule.

A genuinely measured $0.00 under budget PASSES. Zero is falsy, so every guard
here is an explicit `is None` check. A falsy guard would blank a real
observation, which is the same lie pointed the other way (hit for real in
v8.72.0).

Usage:
  tools/cost-guard.py [workspace] --max-usd 5.00
  tools/cost-guard.py [workspace] --baseline old/proof.json --max-increase-pct 10
  tools/cost-guard.py [workspace] --max-usd 5.00 --json

Exit: 0 within budget, 1 over budget / regressed, 2 cannot evaluate.

NON-GOAL: the baseline receipt's integrity hash is not verified. A tampered
baseline that inflates the allowed ceiling is out of scope; use
tools/receipt-diff.py, which does verify. A baseline whose cost block is absent
or unmeasured still exits 2 here, via the same predicate as everything else.

INHERITED LIMIT, stated rather than silently owned. record_is_measured() is
satisfied by tokens OR cost, so a record carrying real token counts but no
cost_usd field sums to usd=0.0 with available=True, and this gate reports
"WITHIN BUDGET: $0.0000" for a run that did cost money. Verified, not
theoretical. It is not fixable here: requirement 3 demands that cost_usd=0.0
WITH tokens passes, so the two shapes are identical downstream of the sum. The
fix belongs in the pricing layer (price_from_tokens() in the same module exists
because tools do report tokens without a native cost), not in a second copy of
the honesty predicate. This gate is exactly as honest as its measurement
source, which is the correct coupling.
"""

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "autonomy", "lib"))

from efficiency_cost import collect_efficiency, record_is_measured  # noqa: E402

OK, OVER, CANNOT = 0, 1, 2


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _num(v):
    """A number as itself; None, "", or a bool as None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def measured_usd(cost):
    """The USD figure from a cost block, or None when it was never measured.

    `available` is NOT trusted on its own: a real receipt shipped
    available=true with every field zero (v8.52.0), so the flag is a claim and
    the VALUES are the evidence. record_is_measured reads per-iteration key
    names, hence usd -> cost_usd.
    """
    if not isinstance(cost, dict):
        return None
    rec = {
        "cost_usd": _num(cost.get("usd")),
        "input_tokens": _num(cost.get("input_tokens")),
        "output_tokens": _num(cost.get("output_tokens")),
        "cache_read_tokens": _num(cost.get("cache_read_tokens")),
        "cache_creation_tokens": _num(cost.get("cache_creation_tokens")),
    }
    if not record_is_measured(rec):
        return None
    return _num(rec["cost_usd"])


def _loki_dir(workspace):
    """Accept either a workspace root or a .loki dir; collect_ wants .loki."""
    if os.path.basename(os.path.normpath(workspace)) == ".loki":
        return workspace
    return os.path.join(workspace, ".loki")


def _cannot(why):
    return {"status": "cannot_evaluate", "exit_code": CANNOT, "why": why,
            "actual_usd": None, "baseline_usd": None, "reason": None}


def evaluate(workspace, max_usd=None, baseline_path=None,
             max_increase_pct=None):
    """Decide the gate. Returns a dict carrying exit_code and the numbers.

    Every early return is CANNOT (2). The single exit-0 return is at the very
    bottom, downstream of a measurement.
    """
    if max_usd is None and max_increase_pct is None:
        return _cannot(
            "no budget policy given: pass --max-usd and/or --baseline with "
            "--max-increase-pct. A gate with no policy checks nothing, and "
            "must not report a pass for it.")

    if baseline_path and max_increase_pct is None:
        # A HALF-HONORED policy must not report a full pass. Without this,
        # `--max-usd 5 --baseline old.json` never opens the baseline and can
        # exit 0 having silently ignored half of what the operator asked for.
        return _cannot(
            "--baseline %s was given without --max-increase-pct, so the "
            "baseline would be silently ignored. Refusing to report a pass "
            "for a policy only half applied." % baseline_path)

    cost, _model = collect_efficiency(_loki_dir(workspace))
    actual = measured_usd(cost)
    if actual is None:
        # THE POINT OF THIS FILE. Absence is not compliance.
        return _cannot(
            "cost is UNMEASURED for %s -- no efficiency record carried an "
            "observed cost or token count. Unmeasured is not within budget: "
            "this gate cannot say whether the run complied, so it reports no "
            "verdict rather than a green one." % workspace)

    breaches = []

    if max_usd is not None:
        # Compared at the precision this gate REPORTS (4dp), not at binary
        # float precision. Summed per-iteration costs land a few ulps over a
        # round ceiling ($0.1+$0.2 > $0.30 is True in binary), which fails a
        # run that is exactly at its budget and prints "$0.3000 exceeds the
        # ceiling $0.3000 by $0.0000" -- a breach of nothing.
        if round(actual - max_usd, 4) > 0:
            breaches.append(
                "cost $%.4f exceeds the ceiling $%.4f by $%.4f (%.1f%% over)"
                % (actual, max_usd, actual - max_usd,
                   ((actual - max_usd) / max_usd * 100.0) if max_usd else 0.0))

    baseline = None
    if max_increase_pct is not None:
        if not baseline_path:
            return _cannot(
                "--max-increase-pct needs --baseline <proof.json>: a "
                "percentage increase has nothing to increase from.")
        try:
            with open(baseline_path, "r", encoding="utf-8") as handle:
                proof = json.load(handle)
        except Exception as exc:
            return _cannot("baseline unreadable (%s): %s"
                           % (baseline_path, exc))
        baseline = measured_usd(
            proof.get("cost") if isinstance(proof, dict) else None)
        if baseline is None:
            return _cannot(
                "baseline receipt %s records no measured cost, so no increase "
                "against it is a real number." % baseline_path)

        rise = actual - baseline
        if baseline == 0:
            # Evaluable -- both sides ARE measured -- so not a 2. A percentage
            # of zero is undefined, so the absolute rise is what gets named.
            if rise > 0:
                breaches.append(
                    "cost rose from a measured $0.0000 baseline to $%.4f "
                    "(+$%.4f); percent increase is undefined against zero, so "
                    "any rise breaches" % (actual, rise))
        else:
            # Rounded to the precision this gate REPORTS. Binary floats put
            # $1.00 -> $1.10 at 10.000000000000009%, so an exact `>` fails a
            # run that is exactly at its allowance and then prints "10.0% over
            # the allowed 10.0%" -- a verdict its own message contradicts.
            pct = round(rise / baseline * 100.0, 6)
            if pct > max_increase_pct:
                breaches.append(
                    "cost rose %.1f%% ($%.4f -> $%.4f, +$%.4f), over the "
                    "allowed %.1f%%"
                    % (pct, baseline, actual, rise, max_increase_pct))

    if breaches:
        return {"status": "over_budget", "exit_code": OVER,
                "actual_usd": actual, "baseline_usd": baseline,
                "reason": "; ".join(breaches), "why": None}

    return {"status": "within_budget", "exit_code": OK, "actual_usd": actual,
            "baseline_usd": baseline, "reason": None, "why": None}


def render(d):
    if d["status"] == "cannot_evaluate":
        return "CANNOT EVALUATE: %s" % d["why"]
    if d["status"] == "over_budget":
        return "OVER BUDGET: %s" % d["reason"]
    return "WITHIN BUDGET: measured cost $%.4f" % d["actual_usd"]


def main(argv=None):
    ap = _Parser(
        description="Fail CI when a run's cost regressed past a budget policy.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root (or its .loki dir); default .")
    ap.add_argument("--max-usd", type=float, help="absolute USD ceiling")
    ap.add_argument("--baseline", help="baseline proof.json to compare against")
    ap.add_argument("--max-increase-pct", type=float,
                    help="allowed %% increase over the baseline's cost")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the verdict as JSON")
    args = ap.parse_args(argv)

    d = evaluate(args.workspace, args.max_usd, args.baseline,
                 args.max_increase_pct)
    print(json.dumps(d, indent=2) if args.as_json else render(d))
    return d["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
