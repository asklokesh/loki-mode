#!/usr/bin/env python3
"""Is this repo's merge gate actually set up and working? One screen.

WHY THIS EXISTS. The gate line ships as eight separate tools, each honest on
its own axis: policy-load.py validates the policy file, baseline-pin.py holds
the cost reference, signing-status.py proves the keyring can sign,
cost-history.py holds the measured trend, ci-gate.py enforces the lot. Every
one of them answers a question an operator did not ask. The question they
actually ask, at the moment they need it -- before a release, after inheriting
a repo, when a green check stops being believable -- is one question:

    is the gate ON, and would it do anything right now?

Nobody could answer it without running five commands and knowing how to read
five different exit conventions. So the honest answer to "is the gate working"
was, in practice, "somebody said it was". That is the exact shape this repo has
paid for fifteen times over: an assurance nobody re-derived.

NOTHING HERE RE-IMPLEMENTS A CHECK. Each line is produced by invoking the tool
that owns that rule as a subprocess (sys.executable + the tool path) and
mapping its exit code. A second copy of a rule is how the rule drifts, and this
repo proved that five times over with provider lists alone. Concretely: this
file does NOT know what makes a policy valid, what counts as baseline drift,
what proves a keyring can sign, or what makes a cost record measured. It knows
only which tool owns each question.

THREE STATES, NEVER A BOOLEAN, on every line:

    OK        the owning tool checked, and the answer is yes
    PROBLEM   the owning tool checked, and the answer is no
    UNKNOWN   the owning tool could not check, or is not on disk

UNKNOWN is the state this whole file exists to keep. "We checked and it is
fine" and "we could not check" are opposite facts about the world, and a status
screen is exactly where the second silently becomes the first -- a dash, a
blank cell, a skipped row. Absent is not zero, and unmeasured is not OK.

A MISSING COMPOSED TOOL READS "unavailable" AND POISONS THE VERDICT. If
signing-status.py is not on disk, this cannot report on signing, so it says so
and the overall verdict is not OK. A status screen that drops a line it could
not produce and still says "healthy" is reporting on a smaller repo than the
one it was pointed at. That is the tarball-assertion defect again: a check
reporting a pass without having checked.

THE VERDICT IS WEAKEST-LINK. Never a count, never a percentage, never "4 of 5".
A score cannot answer "is the gate working", because the one axis that is
blind is the one that matters. UNKNOWN outranks PROBLEM in the verdict for the
same reason ci-gate.py ranks them that way: told PROBLEM, an operator fixes the
named thing, re-runs, sees green, and is still blind on the dead axis.

READ-ONLY, AND IT SAYS SO. Every composed tool is invoked in a reporting mode
that starts no run, spends nothing, and contacts no provider: policy-load
reads a file, baseline-pin `show` reads a pin, signing-status round-trips
against the local keyring only, cost-history `report` reads recorded history,
and ci-gate is NOT executed at all -- the "would the gate run" line is answered
from whether a policy implies flags, because running the real gate would be the
one composed call that is not free.

Usage:
  tools/gate-status.py [workspace] [--json] [--policy .loki-policy.json]

Exit: 0 every component checked and healthy, 1 a component checked and is not,
2 a component could not be checked (including a missing tool), 66 the
workspace path does not exist.
"""

import argparse
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

OK, PROBLEM, UNKNOWN = "OK", "PROBLEM", "UNKNOWN"

# Exit codes, per the repo-wide tools/ convention.
EXIT_OK, EXIT_PROBLEM, EXIT_UNKNOWN, EXIT_USAGE, EXIT_MISSING = 0, 1, 2, 64, 66

_VERDICT_EXIT = {OK: EXIT_OK, PROBLEM: EXIT_PROBLEM, UNKNOWN: EXIT_UNKNOWN}

# Module-level so a test can point one at a nonexistent path and assert that a
# missing component reads unavailable AND drags the verdict off OK.
POLICY_LOAD = os.path.join(_HERE, "policy-load.py")
BASELINE_PIN = os.path.join(_HERE, "baseline-pin.py")
SIGNING_STATUS = os.path.join(_HERE, "signing-status.py")
COST_HISTORY = os.path.join(_HERE, "cost-history.py")


class _Usage(argparse.ArgumentParser):
    """argparse defaults a usage error to exit 2, which here means "could not
    be checked" -- a typo in a flag would read as a blind gate rather than as
    the operator error it is. 64 keeps those two facts distinct."""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(EXIT_USAGE)


def _line(component, state, detail):
    return {"component": component, "state": state, "detail": detail}


def _invoke(tool, argv):
    """Run a component tool read-only. Returns (returncode, stdout, stderr) or
    None when the tool is not on disk. Never recomputes the tool's rule."""
    if not os.path.isfile(tool):
        return None
    try:
        proc = subprocess.run([sys.executable, tool] + argv,
                              capture_output=True, text=True)
    except OSError as exc:
        return (None, "", str(exc))
    return (proc.returncode, proc.stdout, proc.stderr)


def _unavailable(component, tool):
    return _line(component, UNKNOWN,
                 "unavailable: %s is not on disk, so this axis was never "
                 "checked -- absent is not OK" % os.path.basename(tool))


def _first_line(*texts):
    for text in texts:
        for raw in (text or "").splitlines():
            if raw.strip():
                return raw.strip()
    return "no detail reported"


def check_policy(policy_file):
    """Is a merge policy file present and valid? policy-load.py owns the rule."""
    got = _invoke(POLICY_LOAD, ["--file", policy_file, "--as-args"])
    if got is None:
        return _unavailable("policy", POLICY_LOAD)
    rc, out, err = got
    if rc is None:
        return _line("policy", UNKNOWN, "could not run policy-load.py: %s" % err)
    if rc == 0:
        return _line("policy", OK,
                     "%s is valid and enforces: %s" % (policy_file, out.strip()))
    if rc == 1:
        # policy-load's own words: missing file, unknown key, bad value, or a
        # policy that enforces nothing. All are "checked, and it is not set up".
        return _line("policy", PROBLEM, _first_line(err, out))
    return _line("policy", UNKNOWN,
                 "policy-load.py exited %d, which is not a verdict: %s"
                 % (rc, _first_line(err, out)))


def check_baseline(pin_file):
    """Is a cost baseline pinned and undrifted? baseline-pin.py owns the rule,
    including what counts as drift (raw-bytes sha256, not the receipt's own
    canonical digest). That distinction is not restated here."""
    got = _invoke(BASELINE_PIN, ["show", "--file", pin_file, "--json"])
    if got is None:
        return _unavailable("baseline", BASELINE_PIN)
    rc, out, err = got
    if rc is None:
        return _line("baseline", UNKNOWN,
                     "could not run baseline-pin.py: %s" % err)
    if rc == 0:
        return _line("baseline", OK, _first_line(err))
    if rc == 1:
        # No pin at all, or a pin whose receipt drifted since. Both are
        # "checked, and there is no trustworthy baseline".
        return _line("baseline", PROBLEM, _first_line(err, out))
    return _line("baseline", UNKNOWN,
                 "baseline-pin.py exited %d, which is not a verdict: %s"
                 % (rc, _first_line(err, out)))


def check_signing():
    """Can this machine sign receipts? signing-status.py owns the rule, and it
    already refuses to collapse its four states into a boolean. Its
    not_configured (2) and gpg_absent (3) are NOT problems -- signing is opt-in
    and nothing is broken -- but neither are they proof of origin, so they read
    UNKNOWN here rather than OK. Only a completed sign+verify round trip is OK."""
    got = _invoke(SIGNING_STATUS, ["--json"])
    if got is None:
        return _unavailable("signing", SIGNING_STATUS)
    rc, out, err = got
    if rc is None:
        return _line("signing", UNKNOWN,
                     "could not run signing-status.py: %s" % err)
    try:
        detail = json.loads(out)
    except ValueError:
        detail = None
    status = detail.get("status") if isinstance(detail, dict) else None
    reason = (detail or {}).get("reason") if isinstance(detail, dict) else None

    if rc == 0 and status == "ok":
        return _line("signing", OK,
                     "sign+verify round trip completed: receipts carry origin")
    if rc == 1 and status == "broken":
        return _line("signing", PROBLEM,
                     "a key is configured but cannot sign, so receipts emit "
                     "UNSIGNED silently: %s" % (reason or "no reason reported"))
    if rc == 2 and status == "not_configured":
        return _line("signing", UNKNOWN,
                     "signing is opt-in and off (LOKI_PROOF_GPG_KEY unset): "
                     "receipts prove integrity but NOT origin")
    if rc == 3 and status == "gpg_absent":
        return _line("signing", UNKNOWN,
                     "no gpg on PATH, so origin cannot be proven here")
    return _line("signing", UNKNOWN,
                 "signing-status.py exited %d with status %r, which is not a "
                 "verdict: %s" % (rc, status, _first_line(err, out)))


def check_cost_history(history_file):
    """Is there measured cost history? cost-history.py owns the rule, including
    what counts as measured (it imports record_is_measured; this file does not
    restate that predicate, and must not)."""
    got = _invoke(COST_HISTORY, ["report", "--file", history_file, "--json"])
    if got is None:
        return _unavailable("cost_history", COST_HISTORY)
    rc, out, err = got
    if rc is None:
        return _line("cost_history", UNKNOWN,
                     "could not run cost-history.py: %s" % err)
    try:
        detail = json.loads(out)
    except ValueError:
        detail = None
    if rc == 0 and isinstance(detail, dict):
        runs = detail.get("measured")
        median = detail.get("median_usd")
        # A measured ZERO must survive as 0, so both of these ask `is None`,
        # never falsy. `if not runs` would report a real count of zero as an
        # absent count, and `median or "unknown"` would render a genuine,
        # measured $0.00 median as unknown -- the exact collapse this repo has
        # paid for on fifteen surfaces, run in the opposite direction.
        if runs is None:
            return _line("cost_history", UNKNOWN,
                         "cost-history reported no measured-run count")
        return _line("cost_history", OK,
                     "%d measured run(s) in %s; median $%s; direction: %s"
                     % (runs, history_file,
                        "UNKNOWN" if median is None else "%.4f" % median,
                        detail.get("direction", "UNKNOWN")))
    if rc == 1:
        # Empty history, or history with no measured run. Zero runs is an
        # absent measurement, which is a blind axis, not a healthy one.
        why = detail.get("why") if isinstance(detail, dict) else None
        return _line("cost_history", UNKNOWN,
                     "no measured cost history: %s"
                     % (why or _first_line(err) or history_file))
    return _line("cost_history", UNKNOWN,
                 "cost-history.py exited %d, which is not a verdict: %s"
                 % (rc, _first_line(err, out)))


def check_would_run(policy_line):
    """Would the gate do anything right now?

    Answered from the policy line, NOT by executing ci-gate.py: running the
    real gate is the one composed call that is not free, and this tool promises
    to spend nothing. A gate invoked with no flags enforces nothing while
    looking configured -- ci-gate.py's own docstring calls that vacuously
    green -- so an unusable policy means the gate would not run.
    """
    if policy_line["state"] == OK:
        return _line("would_run", OK,
                     "yes: ci-gate would enforce the loaded policy on the next "
                     "run (not executed here -- this tool spends nothing)")
    if policy_line["state"] == PROBLEM:
        return _line("would_run", PROBLEM,
                     "no: the policy does not load, so ci-gate would run with "
                     "nothing to enforce, which is green without checking")
    return _line("would_run", UNKNOWN,
                 "cannot say: the policy itself could not be checked")


def evaluate(workspace=".", policy_file=None, history_file=None):
    """Every component, then the weakest-link verdict."""
    root = os.path.normpath(workspace)
    if os.path.basename(root) == ".loki":
        root = os.path.dirname(root) or "."
    if policy_file is None:
        policy_file = os.path.join(root, ".loki-policy.json")
    if history_file is None:
        history_file = os.path.join(root, ".loki", "cost-history.jsonl")
    pin_file = os.path.join(root, ".loki", "baseline.json")

    policy = check_policy(policy_file)
    lines = [policy,
             check_baseline(pin_file),
             check_signing(),
             check_cost_history(history_file),
             check_would_run(policy)]

    # THE DECISION. Weakest link, UNKNOWN outranking PROBLEM. Written once,
    # here, so a mutation of it has nowhere to hide. Never a count: "4 of 5
    # healthy" cannot answer "is the gate working", because the blind axis is
    # exactly the one that matters.
    states = [line["state"] for line in lines]
    verdict = UNKNOWN if UNKNOWN in states else (
        PROBLEM if PROBLEM in states else OK)

    return {
        "workspace": root,
        "components": lines,
        "verdict": verdict,
        "exit_code": _VERDICT_EXIT[verdict],
        "read_only": True,
        "headline": _HEADLINE[verdict],
    }


_HEADLINE = {
    OK: "the merge gate is configured and would enforce the policy",
    PROBLEM: "the merge gate is configured but something it checked is wrong",
    UNKNOWN: "the merge gate cannot be fully verified from here, so it is not "
             "known to be working",
}


def render(result):
    lines = ["Merge gate status for %s" % result["workspace"],
             "  (read-only: starts nothing, spends nothing, contacts no "
             "provider)", ""]
    lines.append("%-14s %-9s %s" % ("COMPONENT", "STATE", "DETAIL"))
    for row in result["components"]:
        lines.append("%-14s %-9s %s"
                     % (row["component"], row["state"], row["detail"]))
    lines += ["", "GATE: %s -- %s" % (result["verdict"], result["headline"])]
    return "\n".join(lines)


def main(argv=None):
    ap = _Usage(
        description="One-screen answer to whether this repo's merge gate is "
                    "set up and working. Read-only: starts nothing, spends "
                    "nothing, contacts no provider.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root (or its .loki dir); default .")
    ap.add_argument("--policy", default=None,
                    help="policy file; default <workspace>/.loki-policy.json")
    ap.add_argument("--history", default=None,
                    help="cost history JSONL; default "
                         "<workspace>/.loki/cost-history.jsonl")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the status as JSON")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.workspace):
        sys.stderr.write("gate-status: workspace does not exist: %s\n"
                         % args.workspace)
        return EXIT_MISSING

    result = evaluate(args.workspace, args.policy, args.history)
    print(json.dumps(result, indent=2, sort_keys=True) if args.as_json
          else render(result))
    return result["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
