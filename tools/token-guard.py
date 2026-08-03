#!/usr/bin/env python3
"""Fail a build when a run's TOKEN usage regressed. A token gate for CI.

tools/cost-guard.py gates on dollars. Dollars are a derived unit: they depend
on a per-provider price table that changes under you, so a fixed dollar
ceiling silently LOOSENS the moment a cheaper model is swapped in and tightens
on a dearer one, without the work having changed at all. Tokens are the
provider-independent unit of work actually done. Nothing gated on them.

THE RULE THAT MAKES IT A GATE RATHER THAN DECORATION:

    UNMEASURED IS NOT WITHIN BUDGET. Exit 2, never 0.

A gate's exit code is a merge decision, and "we did not measure" carries zero
information about budget compliance. Exit 0 is reachable from exactly ONE
place in this file (the end of evaluate()), and only downstream of a real
measurement. No policy, no records, unmeasured tokens: all 2.

WHICH FIELDS COUNT AS MEASURED, and why it is not cost-guard's five.
Whether a number is measured is record_is_measured() in
autonomy/lib/efficiency_cost.py, imported and never restated. But that
predicate is satisfied by cost OR tokens, and this gate is about tokens, so it
is fed the FOUR TOKEN FIELDS ONLY. Feeding it cost_usd as well would be a hole
in this specific gate: a record carrying a real cost and no usage (the exact
shape codex wrote before v8.51.0) makes collect_efficiency return
available=True with integer-zero token counts, and this gate would report
"WITHIN BUDGET: 0 output tokens" for a run whose tokens were never recorded.
Verified, not theoretical. Choosing which fields to ask about is not a second
copy of the rule; the rule itself stays in one place.

CACHED READS ARE NOT FRESH INPUT, and conflating them is the defect to avoid.
This repo measured a single call at 10,651,759 cache-read tokens against
34,729 output tokens: a ratio near 300 to 1. A "total" dominated by cache
reads is a CONTEXT signal, and it moves when the prompt prefix or the cache
hit rate changes, not when the agent does more work. So:

  --max-output-tokens  the WORK signal. Output tokens alone: what the model
                       actually generated. Reach for this by default.
  --max-total-tokens   the CONTEXT+work signal. Sums the four fields named in
                       TOTAL_FIELDS, cache reads included, which is what makes
                       it big. The exact field list is PRINTED with the
                       verdict, on pass, on fail and in JSON, because a total
                       whose definition is not stated is not evidence.

Both may be given; each is judged on its own number and either can breach.

A genuinely measured ZERO under budget PASSES. Zero is falsy, so every guard
here is an explicit `is None` check -- on the measurement AND on the policy
arguments, since `--max-output-tokens 0` is a legitimate (harsh) policy and a
falsy check would read it as no policy at all.

Usage:
  tools/token-guard.py [workspace] --max-output-tokens 200000
  tools/token-guard.py [workspace] --max-total-tokens 5000000
  tools/token-guard.py [workspace] --max-output-tokens 200000 --json

Exit: 0 within budget, 1 over budget, 2 cannot evaluate.
"""

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "autonomy", "lib"))

from efficiency_cost import collect_efficiency, record_is_measured  # noqa: E402

OK, OVER, CANNOT = 0, 1, 2

# The four fields --max-total-tokens sums, and the SAME tuple the printed
# definition is built from. One constant so the number and its stated meaning
# cannot drift apart: a total that sums something other than what it claims is
# the dishonesty this flag is most exposed to.
TOTAL_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens",
                "cache_creation_tokens")

# Measured-ness for a TOKEN gate. cost_usd is deliberately absent; see the
# module docstring.
MEASURED_FIELDS = TOTAL_FIELDS

TOTAL_DEFINITION = "total = " + " + ".join(TOTAL_FIELDS)


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
    """A number as itself; None, "", or a bool as None.

    The bool exclusion is defence in depth ONLY, and does not reach the CLI
    path: collect_efficiency() runs _to_int() over every field first, so a
    JSON `true` is already an int 1 by the time it arrives here. Stated
    because an untrue claim of bool-safety is worse than a known gap; the fix
    belongs in _to_int(), upstream. This guard still holds for a cost block
    handed to measured_tokens() directly.
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def measured_tokens(cost):
    """{field: value} for the four token fields, or None when unmeasured.

    None means the run's tokens were never observed. It is NOT zero, and the
    caller must not treat it as zero.
    """
    if not isinstance(cost, dict):
        return None
    rec = {field: _num(cost.get(field)) for field in MEASURED_FIELDS}
    if not record_is_measured(rec):
        return None
    # Measured, so a None from a partially-written record is a real absence in
    # a real measurement; count it as 0 for summing rather than poisoning the
    # arithmetic.
    return {field: (0 if rec[field] is None else rec[field])
            for field in MEASURED_FIELDS}


def _loki_dir(workspace):
    """Accept either a workspace root or a .loki dir; collect_ wants .loki."""
    if os.path.basename(os.path.normpath(workspace)) == ".loki":
        return workspace
    return os.path.join(workspace, ".loki")


def _cannot(why):
    return {"status": "cannot_evaluate", "exit_code": CANNOT, "why": why,
            "output_tokens": None, "total_tokens": None, "tokens": None,
            "total_definition": TOTAL_DEFINITION, "reason": None}


def evaluate(workspace, max_output_tokens=None, max_total_tokens=None):
    """Decide the gate. Returns a dict carrying exit_code and the numbers.

    Every early return is CANNOT (2). The single exit-0 return is at the very
    bottom, downstream of a measurement.
    """
    # `is None`, not falsy: --max-output-tokens 0 is a real policy.
    if max_output_tokens is None and max_total_tokens is None:
        return _cannot(
            "no token policy given: pass --max-output-tokens and/or "
            "--max-total-tokens. A gate with no policy checks nothing, and "
            "must not report a pass for it.")

    cost, _model = collect_efficiency(_loki_dir(workspace))
    tokens = measured_tokens(cost)
    if tokens is None:
        # THE POINT OF THIS FILE. Absence is not compliance.
        return _cannot(
            "tokens are UNMEASURED for %s -- no efficiency record carried an "
            "observed token count. Unmeasured is not within budget: this gate "
            "cannot say whether the run complied, so it reports no verdict "
            "rather than a green one." % workspace)

    output = tokens["output_tokens"]
    total = sum(tokens[field] for field in TOTAL_FIELDS)

    breaches = []
    # Tokens are integers, so a strict `>` is exact. No float tolerance: there
    # is no binary-representation slop to absorb, and a tolerance here would
    # silently widen the ceiling the operator asked for.
    if max_output_tokens is not None and output > max_output_tokens:
        breaches.append(
            "output tokens %d exceed the ceiling %d by %d (%.1f%% over)"
            % (output, max_output_tokens, output - max_output_tokens,
               ((output - max_output_tokens) / max_output_tokens * 100.0)
               if max_output_tokens else 0.0))

    if max_total_tokens is not None and total > max_total_tokens:
        breaches.append(
            "total tokens %d exceed the ceiling %d by %d (%.1f%% over) [%s]"
            % (total, max_total_tokens, total - max_total_tokens,
               ((total - max_total_tokens) / max_total_tokens * 100.0)
               if max_total_tokens else 0.0, TOTAL_DEFINITION))

    verdict = {"output_tokens": output, "total_tokens": total,
               "tokens": dict(tokens), "total_definition": TOTAL_DEFINITION,
               "why": None}
    if breaches:
        verdict.update({"status": "over_budget", "exit_code": OVER,
                        "reason": "; ".join(breaches)})
        return verdict
    verdict.update({"status": "within_budget", "exit_code": OK,
                    "reason": None})
    return verdict


def render(d):
    if d["status"] == "cannot_evaluate":
        return "CANNOT EVALUATE: %s" % d["why"]
    if d["status"] == "over_budget":
        return "OVER BUDGET: %s" % d["reason"]
    return ("WITHIN BUDGET: measured %d output tokens, %d total tokens [%s]"
            % (d["output_tokens"], d["total_tokens"], d["total_definition"]))


def main(argv=None):
    ap = _Parser(
        description="Fail CI when a run's token usage regressed past a "
                    "budget policy.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root (or its .loki dir); default .")
    ap.add_argument("--max-output-tokens", type=int,
                    help="ceiling on output tokens alone (the work signal)")
    ap.add_argument("--max-total-tokens", type=int,
                    help="ceiling on %s (cache reads dominate this)"
                         % TOTAL_DEFINITION)
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the verdict as JSON")
    args = ap.parse_args(argv)

    d = evaluate(args.workspace, args.max_output_tokens, args.max_total_tokens)
    print(json.dumps(d, indent=2) if args.as_json else render(d))
    return d["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
