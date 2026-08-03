#!/usr/bin/env python3
"""One exit code for EVERY merge policy. The gate a CI job actually calls.

WHY THIS EXISTS. The policies already ship, each with its own honest verdict:
cost-guard.py decides budget, receipt-attest.py decides attestation. But CI
jobs do not run verdicts, they run ONE command and branch on ONE exit code.
Without this, every team wires its own `&&` chain, and every chain gets the
aggregation subtly wrong in the same direction: toward green.

THE RULE THAT MAKES IT A GATE RATHER THAN A DASHBOARD:

    WEAKEST LINK. Never an average, never a majority.

One policy failing fails the gate. "3 of 4 passed" is not a gate, it is a
score, and a score cannot stop a merge. There is no threshold here to tune,
because a tunable threshold is the request to let one known-bad policy through.

THE SECOND RULE, WHICH IS THE ONE THAT GETS DROPPED:

    A POLICY THAT COULD NOT BE EVALUATED HAS NOT PASSED.

"We checked and it is fine" and "we could not check" are opposite facts about
the world, and only one of them earns a merge. Collapsing the second into the
first makes this gate loudest -- a confident green -- at exactly the moment its
instrumentation broke and it is least entitled to speak. That is the hole this
repo has now paid for repeatedly: four quality-gate detectors absent from the
shipped package, a dist-freshness check deferred by the tier that justified it,
a tarball assertion that passed on "6 or more" of 6 patterns. Each was a check
reporting a pass without having checked.

So three states, and three exit codes:

    0  every configured policy was evaluated and passed
    1  a policy was evaluated and FAILED
    2  a policy could not be evaluated -- including no policy configured at all

PRECEDENCE. When a run has both a failure and an unevaluable policy, this exits
2, not 1. "Your gate is partly blind" outranks "this run is over budget": with
1, the operator fixes the cost, re-runs, sees green, and is still blind on the
dead axis. The per-policy table shows both regardless.

NO POLICY CONFIGURED IS 2. A gate invoked with nothing to enforce has checked
nothing, so it has no pass to report. Exit 0 there would let a CI job that lost
its flags in a refactor go green forever while enforcing nothing at all -- a
vacuously-green gate, which is worse than no gate, because it is trusted.

NOTHING HERE RE-IMPLEMENTS A POLICY. Each is invoked as a subprocess via
sys.executable and its verdict is mapped, never recomputed. A second copy of a
rule is how the rule drifts, and this repo has proven that five times over with
provider lists alone. The consequence is that a MISSING tool is UNEVALUABLE,
never a pass: an absent policy file means the rule was not applied.

Child exit codes are WHITELISTED to {0,1,2}. Anything else is unevaluable, with
the raw code in the reason. receipt-attest.py returns 64 on a usage error, and
under an `rc != 1 means pass` mapping that malformed call would read as green.
For the same reason rc=1 with unparseable JSON on stdout is unevaluable, not a
failure: an uncaught traceback in a child also exits 1, and is not a verdict.

Usage:
  tools/ci-gate.py [workspace] --max-usd 5.00 --require-receipt [--json]

Exit: 0 all pass, 1 a policy failed, 2 a policy could not be evaluated.
"""

import argparse
import glob
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

# Module-level so a test can point one at a nonexistent path and assert that a
# missing policy tool reads as unevaluable rather than as a pass.
_COST_GUARD = os.path.join(_HERE, "cost-guard.py")
_RECEIPT_ATTEST = os.path.join(_HERE, "receipt-attest.py")

PASS, FAIL, UNEVALUABLE = 0, 1, 2

_STATE = {PASS: "PASS", FAIL: "FAIL", UNEVALUABLE: "UNEVALUABLE"}


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


def _row(policy, code, reason):
    return {"policy": policy, "state": _STATE[code], "exit_code": code,
            "reason": reason}


def _run(policy, argv):
    """Invoke a policy tool and map its exit code. Never recompute its rule."""
    tool = argv[0]
    if not os.path.isfile(tool):
        # An absent policy file means the rule was never applied. That is the
        # absence of evidence, not evidence of compliance.
        return _row(policy, UNEVALUABLE,
                    "policy tool is missing from disk: %s -- the rule was "
                    "never applied, so this is not a pass" % tool)
    try:
        proc = subprocess.run([sys.executable] + argv, capture_output=True,
                              text=True)
    except OSError as exc:
        return _row(policy, UNEVALUABLE, "could not run %s: %s" % (tool, exc))

    rc = proc.returncode
    detail = None
    try:
        detail = json.loads(proc.stdout)
    except (ValueError, TypeError):
        detail = None

    if rc not in _STATE:
        # 64 (usage error), 2xx signals, an import blowup: not a verdict.
        return _row(policy, UNEVALUABLE,
                    "%s exited %d, which is not a verdict this gate "
                    "recognises: %s" % (os.path.basename(tool), rc,
                                        (proc.stderr or proc.stdout).strip()
                                        or "no output"))
    if rc == FAIL and detail is None:
        # An uncaught traceback also exits 1. A failure this gate reports must
        # be one the policy actually rendered.
        return _row(policy, UNEVALUABLE,
                    "%s exited 1 but emitted no JSON verdict, so the failure "
                    "cannot be attributed to the policy: %s"
                    % (os.path.basename(tool),
                       (proc.stderr or "no output").strip()))
    return _row(policy, rc, _reason(detail, proc))


def _reason(detail, proc):
    """The child's own words. Never this file's paraphrase of its rule."""
    if isinstance(detail, dict):
        # reason/why are null on a clean pass, so status/verdict carry it there.
        for key in ("reason", "why", "headline", "verdict", "status", "state"):
            value = detail.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    # Falling back to raw stdout, a pretty-printed JSON body would put a bare
    # "{" in the table -- a cell that reports nothing while looking filled in.
    text = (proc.stdout or proc.stderr or "").strip()
    if text.startswith(("{", "[")):
        text = (proc.stderr or "").strip()
    return text.splitlines()[0] if text else "no detail reported"


def _newest_receipt(workspace):
    root = workspace
    if os.path.basename(os.path.normpath(workspace)) == ".loki":
        root = os.path.dirname(os.path.normpath(workspace)) or "."
    found = glob.glob(os.path.join(root, ".loki", "proofs", "*", "proof.json"))
    return max(found, key=os.path.getmtime) if found else None


def evaluate(workspace=".", max_usd=None, require_receipt=False):
    """Run every configured policy. Returns the verdict dict with exit_code."""
    rows = []

    if max_usd is not None:
        rows.append(_run("cost", [_COST_GUARD, workspace,
                                  "--max-usd", str(max_usd), "--json"]))

    if require_receipt:
        receipt = _newest_receipt(workspace)
        if receipt is None:
            # Checked, and the answer is no. That is a FAIL, not a blind spot:
            # 2 is reserved for a receipt that exists and could not be checked.
            rows.append(_row("receipt", FAIL,
                             "--require-receipt was given but no receipt "
                             "exists under %s/.loki/proofs/*/proof.json"
                             % workspace))
        else:
            rows.append(_run("receipt", [_RECEIPT_ATTEST, receipt, "--json"]))

    if not rows:
        # A gate with nothing to enforce has checked nothing, so it has no pass
        # to report.
        return {"exit_code": UNEVALUABLE, "state": _STATE[UNEVALUABLE],
                "policies": [],
                "reason": "no policy configured: pass --max-usd and/or "
                          "--require-receipt. A gate with nothing to enforce "
                          "checked nothing, and must not report a pass for it."}

    # THE DECISION. Weakest link, with unevaluable outranking failure. Written
    # once, here, so a mutation of it has nowhere to hide.
    codes = [r["exit_code"] for r in rows]
    worst = UNEVALUABLE if UNEVALUABLE in codes else (
        FAIL if FAIL in codes else PASS)

    return {"exit_code": worst, "state": _STATE[worst], "policies": rows,
            "reason": "%d of %d policies passed" % (codes.count(PASS),
                                                    len(codes))}


def render(d):
    lines = ["%-10s %-12s %s" % ("POLICY", "STATE", "DETAIL")]
    for row in d["policies"]:
        lines.append("%-10s %-12s %s" % (row["policy"], row["state"],
                                         row["reason"]))
    lines.append("")
    lines.append("GATE: %s -- %s" % (d["state"], d["reason"]))
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="One exit code over every configured merge policy.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root (or its .loki dir); default .")
    ap.add_argument("--max-usd", type=float,
                    help="enforce a cost ceiling via cost-guard.py")
    ap.add_argument("--require-receipt", action="store_true",
                    help="enforce receipt attestation via receipt-attest.py")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the verdict as JSON")
    args = ap.parse_args(argv)

    d = evaluate(args.workspace, args.max_usd, args.require_receipt)
    print(json.dumps(d, indent=2) if args.as_json else render(d))
    return d["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
