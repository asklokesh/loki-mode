#!/usr/bin/env python3
"""Turn a ci-gate verdict into the next command a human should actually run.

WHY THIS EXISTS. ci-gate.py decides correctly and gate-report.py carries that
decision to the CI run page. Both stop at WHAT happened. Neither says what to
do about it, and the state that most needs saying is the one nobody knows how
to act on:

    cost UNEVALUABLE -- cost is UNMEASURED for /ws, no efficiency record
    carried an observed cost or token count.

An engineer reading that has a blocked merge and no next step. The observed
response to an unactionable blocker is not to fix it, it is to route around it
-- delete the flag, add a `|| true`, lower the ceiling until it passes. A gate
that cannot be acted on gets disabled, and a disabled gate is worse than none
because the workflow file still claims it runs. So this file's whole job is
the third column: what it checked, what it found, and the CONCRETE command.

    python3 tools/ci-gate.py <ws> --max-usd 5 --json \
        | python3 tools/gate-explain.py

THE RULE THAT CONSTRAINS EVERY REMEDY IN THIS FILE:

    NEVER PRINT A COMMAND YOU CANNOT JUSTIFY.

A remedy is a suggestion a tired operator will paste without reading, and then
trust the result of. A guessed command is therefore worse than silence in both
directions: it wastes the fix, and it manufactures confidence that the axis was
addressed. So the remedy table below is keyed on the policy names ci-gate
actually emits, every flag in it was checked against that tool's own --help,
and an unrecognised policy prints exactly

    no known remedy for this policy

rather than a plausible-looking guess assembled from the policy's name.

THE THREE STATES STAY THREE. This repo has paid for collapsing them on fifteen
surfaces. PASS is "we checked and it is fine". FAIL is "we checked and it is
not". UNEVALUABLE is "we could not check", which is neither -- so it is never
worded as a failure (that would send an operator to fix a budget that was never
exceeded) and never worded as a pass (that is the green-leak the whole tool
line exists to stop). Each has its own sentence and its own remedy.

WHY THE EXIT CODE IS RECONCILED, NOT RELAYED. A shell pipe keeps only the last
command's status, so ci-gate's 2 is discarded by the `|` and this file must
re-emit it, exactly as gate-report.py does. Relaying the header's exit_code
alone is not enough: a body claiming exit_code 0 while carrying an UNEVALUABLE
row would make this file PRINT "the gate could not check this" and EXIT 0 in
the same breath -- a green-leak in the one tool whose subject is green-leaks.
The rows are the evidence and the header is a claim, so the code is the weakest
link over both, the same rule ci-gate applies.

Empty or malformed stdin is an error with exit 2, never an empty explanation:
nothing to explain is indistinguishable from a clean run, and an assumed pass
on unreadable input is the same defect wearing different clothes.

Exit: mirrors the reconciled input verdict (0 pass, 1 failed, 2 unevaluable);
2 on input this file could not parse; 64 on a usage error.
"""

import argparse
import json
import sys

sys.dont_write_bytecode = True

PASS, FAIL, UNEVALUABLE = 0, 1, 2
EXIT_USAGE = 64

_EXIT = {"PASS": PASS, "FAIL": FAIL, "UNEVALUABLE": UNEVALUABLE}
_STATE = {v: k for k, v in _EXIT.items()}

# ponytail: no efficiency record reaches this file. The input is a ci-gate
# verdict -- policy rows with prose reasons -- so record_is_measured() from
# autonomy/lib/efficiency_cost.py has nothing here to apply itself to, and
# importing it to look thorough would be a second cost predicate in disguise.
# The measured/unmeasured judgement was already made upstream by cost-guard.py
# and arrives as the row's own words, which this file relays verbatim.

# WHAT EACH STATE MEANS, in one place. Worded so no state can be misread as
# another: "could not check" never contains pass or fail language.
_MEANING = {
    "PASS": "the gate checked this and it passed",
    "FAIL": "the gate checked this and it failed",
    "UNEVALUABLE": "the gate could not check this, so it is neither a pass "
                   "nor a failure -- the axis is unverified",
}

_NO_REMEDY = "no known remedy for this policy"

# THE REMEDY TABLE. Keyed on the policy names ci-gate.py emits (grep `_run("`
# there: "cost" and "receipt"). Every flag below was verified against that
# tool's own --help output before being written down. Adding a row here without
# running the command it prints is how this file starts lying.
_REMEDY = {
    ("cost", "FAIL"):
        "the run cost more than the ceiling. Inspect the spend, then either "
        "reduce it or raise the ceiling deliberately:\n"
        "    python3 tools/cost-guard.py <workspace> --max-usd <ceiling> --json",
    ("cost", "UNEVALUABLE"):
        "no iteration recorded an observed cost or token count, so the budget "
        "question has no data to answer it. Re-run the work so the provider "
        "writes usage, then confirm a record now carries real numbers:\n"
        "    ls <workspace>/.loki/metrics/efficiency/iteration-*.json\n"
        "    python3 tools/cost-guard.py <workspace> --max-usd <ceiling> --json",
    ("receipt", "FAIL"):
        "attestation was required and did not hold. Read the attestation's own "
        "per-axis states before changing anything:\n"
        "    python3 tools/receipt-attest.py "
        "<workspace>/.loki/proofs/*/proof.json --json",
    ("receipt", "UNEVALUABLE"):
        "the receipt exists but at least one axis could not be checked here. "
        "The attestation names which axis and why:\n"
        "    python3 tools/receipt-attest.py "
        "<workspace>/.loki/proofs/*/proof.json --json",
}

_PASS_REMEDY = "nothing to do"

# ci-gate's "no policy configured" verdict: an empty policies list. It is a
# real, actionable finding, not an empty report, so it gets its own row.
_NO_POLICY = (
    "the gate ran with no policy configured, so it enforced nothing. A gate "
    "that checked nothing has no pass to report. Give it at least one policy:\n"
    "    python3 tools/ci-gate.py <workspace> --max-usd <ceiling> "
    "--require-receipt --json")


def _remedy(policy, state):
    """The command for this policy, or a refusal. Never a guess."""
    if state == "PASS":
        return _PASS_REMEDY
    return _REMEDY.get((policy, state), _NO_REMEDY)


def explain_row(row):
    """One policy row as (policy, state, found, remedy). Never defaults PASS."""
    if not isinstance(row, dict):
        return ("?", "UNEVALUABLE", "malformed policy entry: %r" % (row,),
                _NO_REMEDY)
    policy = str(row.get("policy") or "?")
    state = row.get("state")
    state = state.upper() if isinstance(state, str) \
        and state.upper() in _EXIT else None
    reason = row.get("reason")
    found = reason.strip() if isinstance(reason, str) and reason.strip() \
        else "no detail reported"
    if state is None:
        # The input carried no verdict this file recognises. Filling that gap
        # with PASS would be manufacturing evidence.
        return (policy, "UNEVALUABLE",
                "the gate reported no recognised state for this policy "
                "(was %r), so it has not been checked" % (row.get("state"),),
                _NO_REMEDY)
    return (policy, state, found, _remedy(policy, state))


def explain_rows(verdict):
    policies = verdict.get("policies")
    rows = []
    if isinstance(policies, list):
        rows = [explain_row(r) for r in policies]
    if rows:
        return rows
    # No policy results arrived. Whatever the header claims, nothing was
    # checked -- so this is UNEVALUABLE unconditionally, and a top-level PASS
    # here must not be believed.
    return [("(none)", "UNEVALUABLE", _overall_reason(verdict), _NO_POLICY)]


def _overall_reason(verdict):
    reason = verdict.get("reason")
    if isinstance(reason, str) and reason.strip():
        return reason.strip()
    return "the gate reported no policy results and no reason"


def verdict_state(verdict):
    """Weakest link over the header's claim and every row's evidence."""
    claimed = verdict.get("state")
    claimed = claimed.upper() if isinstance(claimed, str) \
        and claimed.upper() in _EXIT else "UNEVALUABLE"
    worst = max([_EXIT[claimed]] + [_EXIT[r[1]] for r in explain_rows(verdict)])
    return _STATE[worst]


def exit_code(verdict):
    """The input's own exit semantics, reconciled. A pipe drops them.

    A header exit_code of 0 sitting above an UNEVALUABLE row is not a pass, so
    the code is raised to match the explanation actually printed. The number a
    CI job branches on can never disagree with the sentences a human just read.
    """
    code = verdict.get("exit_code")
    if isinstance(code, bool) or not isinstance(code, int) \
            or code not in _STATE:
        code = UNEVALUABLE
    return max(code, _EXIT[verdict_state(verdict)])


def render_text(verdict):
    out = []
    for policy, state, found, remedy in explain_rows(verdict):
        out.append("POLICY: %s [%s]" % (policy, state))
        out.append("  CHECKED: %s" % _MEANING[state])
        out.append("  FOUND:   %s" % _one_line(found))
        out.append("  NEXT:    %s" % _indent(remedy))
        out.append("")
    state = verdict_state(verdict)
    out.append("GATE: %s -- %s" % (_headline(state), _overall_reason(verdict)))
    return "\n".join(out)


def render_json(verdict):
    state = verdict_state(verdict)
    return json.dumps({
        "state": state,
        "exit_code": exit_code(verdict),
        "reason": _overall_reason(verdict),
        "policies": [
            {"policy": p, "state": s, "checked": _MEANING[s],
             "found": _one_line(f), "next_command": r}
            for p, s, f, r in explain_rows(verdict)],
    }, indent=2)


def _headline(state):
    if state in ("PASS", "FAIL"):
        return state
    # Spelled out on the summary line too: a bare word gets skimmed, and this
    # is the state a skimming reader most often files under "fine".
    return "UNEVALUABLE (the gate could not check this -- not a pass)"


def _one_line(text):
    return " ".join(text.split())


def _indent(text):
    return text.replace("\n", "\n           ")


class _Parser(argparse.ArgumentParser):
    # argparse exits 2 on a usage error, and 2 means "could not be checked"
    # here -- a mistyped flag would read as a blind gate. Overriding error()
    # rather than parse_args() leaves --help exiting 0.
    def error(self, message):
        self.print_usage(sys.stderr)
        print("%s: error: %s" % (self.prog, message), file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def main(argv=None):
    # No positional argument, deliberately: this reads a verdict on stdin, so a
    # bare path on the command line is a mistake, and treating it as input
    # would judge the wrong thing. It is rejected as a usage error.
    ap = _Parser(
        description="Explain a ci-gate verdict and give the next command.")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the explanation as JSON")
    args = ap.parse_args(argv)

    # Parse args BEFORE touching stdin, so --help and a usage error answer
    # immediately instead of blocking on a terminal that will never send EOF.
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stderr.write("gate-explain: empty stdin -- expected ci-gate JSON. "
                         "Nothing to explain is not a pass.\n")
        return UNEVALUABLE
    try:
        verdict = json.loads(raw)
    except ValueError as exc:
        sys.stderr.write("gate-explain: could not parse the gate verdict: %s "
                         "-- unreadable input is an error, not a pass.\n" % exc)
        return UNEVALUABLE
    if not isinstance(verdict, dict):
        sys.stderr.write("gate-explain: expected a JSON object from ci-gate, "
                         "got %s\n" % type(verdict).__name__)
        return UNEVALUABLE

    # Render fully before printing: a partial explanation reads as the whole
    # verdict.
    out = render_json(verdict) if args.as_json else render_text(verdict)
    code = exit_code(verdict)
    print(out)
    return code


if __name__ == "__main__":
    sys.exit(main())
