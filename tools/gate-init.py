#!/usr/bin/env python3
"""Generate the policy file and CI snippet that turn the cost gate on.

WHY THIS EXISTS. The chain already works: policy-load.py validates a policy
file, ci-gate.py enforces it, gate-report.py renders the verdict where an
engineer will see it. Adopting it does not. A team has to hand-write a JSON
file against a schema documented only in a validator's source, work out that
`--as-args` is the flag that joins the first tool to the second, and compose
three commands in the right order. That is several required steps before any
value, which is the highest-severity adoption defect this project recognises:
a gate nobody turns on enforces exactly as much as no gate at all.

So: one command that writes the file and prints the snippet.

    python3 tools/gate-init.py . --out .loki-policy.json --print-workflow

THE RULE THIS FILE EXISTS TO HOLD, and the reason it is not a template dump:

    NEVER INVENT A CEILING.

A generator's whole appeal is that it fills in the blanks, and a cost ceiling
is the one blank it must refuse to fill from nothing. A plausible-looking
$5.00 in a generated file is worse than an empty one: the operator commits it,
CI goes green, and the number enforced is one nobody chose and nobody can
defend when it starts blocking merges. The green is the problem -- it reads as
"reviewed and within budget" when it means "arbitrary". This repo has paid for
that shape repeatedly, most recently a tarball assertion that passed on "6 or
more" of 6 patterns: a check reporting a pass without having checked.

So a ceiling is emitted ONLY when measured runs exist to derive it from, and
the derivation is stated in the output. With no measured history the `max_usd`
key is ABSENT and the operator is told, on stderr, that they must choose one.

WHY ABSENT AND NOT null, WHICH IS WHAT YOU WOULD REACH FOR FIRST. Verified by
running policy-load.py on all four candidates:

    {"max_usd": null, ...}          rejected: "max_usd must be a number"
    {"_note": "...", ...}           rejected: unknown policy key
    {"require_receipt": false}      rejected: "enforces nothing"
    {"require_receipt": true}       loads, exit 0

JSON has no comments and policy-load rejects unknown keys, so the "you must
choose a ceiling" note CANNOT live in the file. It goes to stderr and into the
printed snippet, where it is at least as visible and cannot break the loader.
The receipt requirement carries the file on its own so the emitted policy still
enforces something rather than tripping policy-load's own vacuity check.

WHY IT RUNS policy-load ON ITS OWN OUTPUT. A generator that emits a file the
loader rejects is worse than one that emits nothing: the operator has a
committed artifact, a passing generator, and a broken gate. Self-validation is
a subprocess call to the real validator, never a re-implementation of its rules
here -- a second copy of the schema is how the two drift apart, and the copy
that drifts is always the one nobody runs.

WHAT IT REFUSES TO DO. It never overwrites an existing policy without --force:
that file is reviewed, committed, and possibly a LOWER ceiling than this tool
would derive, so silently replacing it is a destructive act that reads as a
routine re-run. It never writes into .github/ -- that directory is live, and a
snippet this tool has never executed has no business landing in a real
workflow. The snippet is labelled as a starting point for that reason.

Exit: 0 policy written and validated; 1 refused (existing file, or the
generated policy failed its own validation); 2 cannot write.
"""

import argparse
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

OK, REFUSED, CANNOT = 0, 1, 2

DEFAULT_OUT = ".loki-policy.json"

# Headroom over observed spend. A ceiling at the median blocks half of all
# normal runs, which trains the team to bypass the gate -- the failure mode a
# too-tight budget shares with a too-loose one is that it stops being obeyed.
HEADROOM = 2.0

# ponytail: reuse cost-history's loader and median rather than re-reading
# JSONL here. Its honesty rules (unmeasured is null and excluded, corrupt lines
# are counted) are the ones this derivation needs, and a second reader is how
# they drift.
sys.path.insert(0, _HERE)


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


def _load_cost_history():
    """cost-history.py as a module, despite the hyphen in its name."""
    import importlib.util

    sys.dont_write_bytecode = True
    path = os.path.join(_HERE, "cost-history.py")
    spec = importlib.util.spec_from_file_location("cost_history", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def measured_costs(workspace, history_file=None):
    """Every measured USD figure in this workspace's history, oldest first.

    Rows recorded as unmeasured carry usd=null and are EXCLUDED, never read as
    0. A workspace whose every run failed to measure has no basis for a
    ceiling, and averaging zeros into one would produce a $0.00 ceiling that
    blocks every future run while looking like a real budget.
    """
    ch = _load_cost_history()
    path = history_file or os.path.join(workspace, ch.DEFAULT_FILE)
    entries, corrupt = ch.load(path)
    if entries is None:
        return [], 0, path
    costs = [e["usd"] for e in entries
             if e.get("measured") and ch._num(e.get("usd")) is not None]
    return costs, corrupt, path


def derive(costs):
    """(ceiling, basis) from measured runs, or (None, why-not).

    Returns None for the ceiling whenever there is nothing to derive it from.
    That None is the product: it is what stops a number with no basis being
    written into a file someone will commit.
    """
    if not costs:
        return None, ("no measured runs in this workspace's cost history")
    ch = _load_cost_history()
    med = ch.median(costs)
    if med <= 0:
        # Every measured run summed to zero. Present records, no spend: that is
        # a measurement gap wearing a number's clothes, and a $0.00 ceiling
        # derived from it would block every run that ever does real work.
        return None, ("%d measured run(s) but their median is $%.4f; a ceiling "
                      "of zero would block every run that does real work"
                      % (len(costs), med))
    ceiling = round(med * HEADROOM, 2)
    basis = ("median of %d measured run(s) = $%.4f, times %.1fx headroom"
             % (len(costs), med, HEADROOM))
    return ceiling, basis


def build_policy(ceiling):
    """The policy dict. max_usd is ABSENT, never null, when unset.

    require_receipt is always true: it is the one policy that needs no measured
    history to justify, and without it a ceiling-less policy would imply no
    ci-gate flags at all -- which policy-load correctly rejects as a gate with
    nothing to check.
    """
    policy = {"require_receipt": True}
    if ceiling is not None:
        policy["max_usd"] = ceiling
    return policy


def validate(path):
    """Run the REAL loader on the generated file. Returns (ok, message)."""
    proc = subprocess.run(
        [sys.executable, os.path.join(_HERE, "policy-load.py"),
         "--file", path, "--as-args"],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or
                       "policy-load exited %d with no message" % proc.returncode)
    return True, proc.stdout.strip()


def workflow_snippet(out_path):
    """A starting point, NOT a tested workflow. Labelled as such in the text.

    This tool has never run this YAML. Calling it verified would be the same
    manufactured confidence the gate itself exists to prevent, one layer up.
    """
    return """# STARTING POINT -- NOT TESTED. This tool generated this snippet but has
# never executed it. Review it, adapt the checkout/setup steps to your repo,
# and run it once on a branch before trusting it to block a merge.
#
# Add to a job in .github/workflows/<your-workflow>.yml:

      - name: Cost gate
        run: |
          python3 tools/ci-gate.py . --json \\
              $(python3 tools/policy-load.py --file {out} --as-args) \\
            | python3 tools/gate-report.py --format github
""".format(out=out_path)


def generate(workspace, out_path, force=False, history_file=None):
    """Write the policy. Returns a verdict dict; never overwrites silently."""
    if os.path.exists(out_path) and not force:
        return {"status": "exists", "exit_code": REFUSED,
                "why": ("refusing to overwrite existing policy file %s -- it is "
                        "reviewed and committed, and may hold a lower ceiling "
                        "than this tool would derive. Re-run with --force to "
                        "replace it." % out_path),
                "policy": None, "ceiling": None, "basis": None,
                "out": out_path}

    costs, corrupt, hist_path = measured_costs(workspace, history_file)
    ceiling, basis = derive(costs)
    policy = build_policy(ceiling)

    try:
        parent = os.path.dirname(os.path.abspath(out_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(policy, indent=2, sort_keys=True) + "\n")
    except OSError as exc:
        return {"status": "cannot_write", "exit_code": CANNOT,
                "why": "could not write %s: %s" % (out_path, exc),
                "policy": policy, "ceiling": ceiling, "basis": basis,
                "out": out_path}

    ok, message = validate(out_path)
    if not ok:
        # Generated and rejected by the real loader. Non-zero, loudly: a
        # committed file the gate cannot load is a gate that never runs.
        return {"status": "invalid", "exit_code": REFUSED,
                "why": ("the generated policy failed policy-load.py: %s" % message),
                "policy": policy, "ceiling": ceiling, "basis": basis,
                "out": out_path}

    return {"status": "written", "exit_code": OK, "why": None,
            "policy": policy, "ceiling": ceiling, "basis": basis,
            "out": out_path, "ci_gate_args": message,
            "history_file": hist_path, "measured_runs": len(costs),
            "corrupt_lines": corrupt}


def main(argv=None):
    ap = _Parser(
        description="Generate a ci-gate policy file and the CI snippet that "
                    "enforces it.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace to derive a ceiling from; default .")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="policy file to write; default %s" % DEFAULT_OUT)
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing policy file")
    ap.add_argument("--print-workflow", action="store_true",
                    dest="print_workflow",
                    help="also print a starting-point CI snippet")
    ap.add_argument("--history-file", default=None,
                    help="cost history JSONL; default <workspace>/.loki/cost-history.jsonl")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the verdict as JSON")
    args = ap.parse_args(argv)

    verdict = generate(args.workspace, args.out, force=args.force,
                       history_file=args.history_file)

    if args.as_json:
        print(json.dumps(verdict, indent=2, sort_keys=True))
    elif verdict["exit_code"] != OK:
        print("gate-init: %s" % verdict["why"], file=sys.stderr)
    else:
        print("wrote %s" % verdict["out"])
        print(json.dumps(verdict["policy"], indent=2, sort_keys=True))
        if verdict["ceiling"] is not None:
            print("\nmax_usd = %s, derived from: %s"
                  % (verdict["ceiling"], verdict["basis"]))
        print("\nvalidated by policy-load.py; ci-gate args: %s"
              % verdict.get("ci_gate_args", ""))

    # OUTSIDE the format branch, deliberately. Under --json this note used to
    # vanish entirely: the operator got "ceiling": null and a basis string that
    # reads as a diagnostic field rather than an instruction, and a policy
    # enforcing less than it appears to. A machine-readable format is a reason
    # to render the warning differently, never a reason to drop it -- that is
    # the same "looks configured, enforces nothing" shape the whole chain
    # exists to prevent. stderr keeps stdout valid JSON for a pipe.
    if verdict["exit_code"] == OK and verdict["ceiling"] is None:
        print("\nNO CEILING WAS SET: %s." % verdict["basis"], file=sys.stderr)
        print("The max_usd key is ABSENT rather than guessed. You must "
              "choose a ceiling and add it, for example:\n"
              '    "max_usd": 5.00\n'
              "Record some runs first (python3 tools/cost-history.py "
              "record <workspace>) and re-run with --force to derive one "
              "from measured spend.", file=sys.stderr)

    if args.print_workflow and verdict["exit_code"] == OK:
        print()
        print(workflow_snippet(verdict["out"]))

    return verdict["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
