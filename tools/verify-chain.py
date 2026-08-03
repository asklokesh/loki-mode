#!/usr/bin/env python3
"""Run the whole verification chain end to end and report ONE verdict.

WHY THIS EXISTS. The chain already ships, one tool per link: receipt-bundle.py
rolls every receipt into a bundle verdict, receipt-stats.py censuses the
archive, cost-guard.py decides budget. Each is honest on its own axis. Nobody
runs one. An operator asking "is this workspace's evidence sound" runs all of
them and folds the answers by hand, and every hand-fold gets the aggregation
wrong in the same direction: toward green. `&&` stops at the first non-zero and
never reports the rest; `;` reports everything and returns only the last one.

So this composes them. It re-implements NOTHING. Every stage is a subprocess,
every state is that child's own exit code mapped, and every reason is that
child's own words. A second copy of a rule is how the rule drifts -- this repo
has watched that happen five separate times with provider lists -- so the only
logic here is the fold, and the fold is one function.

THE FIVE RULES, each a specific way a chain report can claim more than it ran.

1. COMPOSE, NEVER REIMPLEMENT. This file contains no verification, no cost
   predicate, no receipt parsing. record_is_measured() and verify() are applied
   by the children, once, where they already live. Reaching in to re-derive a
   cost figure here would create the second copy that drifts. The one honesty
   rule that does bite at THIS layer is the render: a passed-through total of a
   genuinely measured $0.0000 must survive as 0.0000, so every guard is
   `is None` and never truthiness.

2. A STAGE WHOSE TOOL IS MISSING READS UNAVAILABLE, AND THE ROLLUP IS NOT OK.
   An absent tool means the link was never run, which is the absence of
   evidence, not evidence of soundness. Silently skipping it and still
   reporting health is the exact defect this whole tool line exists to
   prevent -- and it is the one that hides best, because a skipped stage
   leaves no row to notice. So it leaves a row, named, with a reason.

3. THE ROLLUP IS THE WEAKEST LINK, NEVER A COUNT OR A PERCENTAGE. One failed
   stage fails the chain. "2 of 3 stages passed" is a score, and a score cannot
   stop anything: it gets EASIER to pass as stages are added, which is exactly
   backwards. See rollup(), which is three lines and is the product.

4. THREE STATES, NEVER A BOOLEAN. PASSED, FAILED, and UNAVAILABLE are three
   different facts. "We checked and it is sound" and "we could not check" are
   opposite claims about the world and only one earns a green. Collapsing them
   makes this loudest at exactly the moment its instrumentation broke.

   UNAVAILABLE outranks FAILED in the rollup, following ci-gate.py: with a
   FAILED verdict the operator fixes the named failure, re-runs, sees green,
   and is still blind on the dead link. The stage table shows both regardless.

5. AN EMPTY WORKSPACE IS NOT A PASSING CHAIN, and it is not a blind one
   either. EMPTY (exit 3) requires that EVERY stage reported nothing to check.
   One blind stage among empty ones is UNAVAILABLE, never 3 -- otherwise a
   broken link launders itself as "nothing to do here".

COST-GUARD IS CONDITIONAL, AND THAT IS NOT THE SAME AS UNAVAILABLE. Budget is
enforced only when a policy exists (.loki-policy.json, read through
policy-load.py so the filename and the schema are not restated). No policy
means the budget stage was never CONFIGURED, which is a different fact from a
budget tool that is missing from disk. A never-configured stage is reported as
a named note and does not sink the chain; a missing TOOL does. Merging those
two would make this tool exit non-zero on every workspace that has no policy,
which is most of them, and a gate that is always red is a gate nobody reads.

READ-ONLY. This starts nothing, spends nothing, and contacts no provider. It
runs three local subprocesses that only read files. The output says so, because
an operator deciding whether to run this against a live workspace should not
have to read the source to find out.

Usage:
    tools/verify-chain.py [workspace] [--json]

Exit: 0 every stage checked and passed, 1 a stage FAILED, 2 a stage could not
be evaluated, 3 nothing to check anywhere, 64 usage error, 66 workspace absent.
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys

# Set before any spec_from_file_location below. Loading policy-load.py through
# the loader otherwise drops a __pycache__/ into tools/ as a side effect of
# merely REPORTING on a workspace, and this tool's whole claim is that it is
# read-only. A tool that writes while saying it does not is the same category
# of untrue as a gate that greens while saying it could not check.
sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))

# Module-level so a test can point one at a nonexistent path and assert that a
# missing stage tool reads UNAVAILABLE rather than being skipped into a green
# rollup. Same reason ci-gate.py holds its policy tools this way.
_RECEIPT_BUNDLE = os.path.join(_HERE, "receipt-bundle.py")
_RECEIPT_STATS = os.path.join(_HERE, "receipt-stats.py")
_COST_GUARD = os.path.join(_HERE, "cost-guard.py")
_POLICY_LOAD = os.path.join(_HERE, "policy-load.py")

PASSED = "PASSED"
FAILED = "FAILED"
UNAVAILABLE = "UNAVAILABLE"
NOTHING = "NOTHING"

# Ordered worst-first; rollup() takes the min index. UNAVAILABLE outranks
# FAILED deliberately: see rule 4. NOTHING is last because a chain is only
# EMPTY when there is nothing anywhere.
_ORDER = (UNAVAILABLE, FAILED, PASSED, NOTHING)

EXIT = {PASSED: 0, FAILED: 1, UNAVAILABLE: 2, NOTHING: 3}

# The children's exit codes, mapped. 0/1/2/3 is the repo-wide convention; ANY
# other code (64 usage, 66 missing input, a signal, an import blowup) is not a
# verdict this chain recognises and therefore is not a pass.
_FROM_CHILD = {0: PASSED, 1: FAILED, 2: UNAVAILABLE, 3: NOTHING}


def _policy_load():
    """policy-load.py, loaded lazily so an import blowup cannot break --help.

    A module-level load that raised would make this tool exit non-zero on
    `--help`, which fails the repo-wide exit contract for every tool at once.
    """
    spec = importlib.util.spec_from_file_location("policy_load", _POLICY_LOAD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _workspace_root(workspace):
    """Accept either a workspace root or its .loki dir, as ci-gate.py does."""
    normalised = os.path.normpath(workspace)
    if os.path.basename(normalised) == ".loki":
        return os.path.dirname(normalised) or "."
    return workspace


def _stage(name, state, reason, exit_code=None):
    return {"stage": name, "state": state, "reason": reason,
            "child_exit_code": exit_code}


def _run(name, argv):
    """Invoke one stage tool and map its exit code. Never recompute its rule."""
    tool = argv[0]
    if not os.path.isfile(tool):
        # Rule 2. The link was never run, so there is no result to report and
        # certainly no pass. A skipped stage leaves a row precisely because a
        # skipped stage is what nobody notices.
        return _stage(name, UNAVAILABLE,
                      "stage tool is missing from disk: %s -- this link of "
                      "the chain never ran, so it is not a pass" % tool)
    try:
        proc = subprocess.run([sys.executable] + argv, capture_output=True,
                              text=True)
    except OSError as exc:
        return _stage(name, UNAVAILABLE, "could not run %s: %s" % (tool, exc))

    rc = proc.returncode
    if rc not in _FROM_CHILD:
        return _stage(name, UNAVAILABLE,
                      "%s exited %d, which is not a verdict this chain "
                      "recognises: %s"
                      % (os.path.basename(tool), rc,
                         (proc.stderr or proc.stdout).strip() or "no output"),
                      rc)
    return _stage(name, _FROM_CHILD[rc], _reason(proc), rc)


def _reason(proc):
    """The child's own words, never this file's paraphrase of its rule.

    `status`/`state` are last on purpose. They are single tokens like
    "within_budget" -- true, but a cell that reports a machine enum where the
    child had a whole sentence ("WITHIN BUDGET: measured cost $0.4200") throws
    away the only figure an operator wanted to read.
    """
    try:
        detail = json.loads(proc.stdout)
    except (ValueError, TypeError):
        detail = None
    if isinstance(detail, dict):
        for key in ("summary", "reason", "why", "verdict", "status", "state"):
            value = detail.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    text = (proc.stdout or proc.stderr or "").strip()
    if text.startswith(("{", "[")):
        text = (proc.stderr or "").strip()
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return "no detail reported"


def rollup(states):
    """The chain verdict: the WEAKEST state present, never a count.

    This is the whole product. One FAILED stage among any number of PASSED ones
    makes the chain FAILED, and one UNAVAILABLE stage outranks even that,
    because a blind link means the operator does not know what they shipped.

    Any scoring rule -- "2 of 3", a mean, a majority -- makes a bad stage
    cheaper to hide the more good stages surround it, and gets easier to pass
    as the chain grows longer. Exactly backwards.

    NOTHING sorts last, so a chain is EMPTY only when EVERY stage found nothing
    to check. One blind stage beside empty ones is UNAVAILABLE, never 3.
    """
    if not states:
        return UNAVAILABLE
    return min(states, key=_ORDER.index)


def _budget_stage(root, workspace):
    """Run cost-guard only when a policy configures a ceiling.

    Three distinct outcomes, kept apart on purpose:

      - no policy file, or a policy with no max_usd: the budget stage was never
        CONFIGURED. Reported as a note, absent from the rollup. A gate that
        went red on every workspace without a policy would be a gate nobody
        reads, and "not configured" is a different fact from "not checked".
      - a policy file that exists and is invalid: that IS a blind stage. The
        operator asked for budget enforcement and did not get it.
      - a valid ceiling: cost-guard decides, and its exit code is the state.
    """
    try:
        policy_module = _policy_load()
    except Exception as exc:
        # Consistent with _run()'s missing-tool branch. Letting this raise
        # would exit 1 through main(), reporting FAILED for what is actually a
        # blind stage -- the wrong one of the three states.
        return _stage("budget", UNAVAILABLE,
                      "could not load the policy reader %s, so no ceiling "
                      "could be enforced: %s" % (_POLICY_LOAD, exc)), None

    path = os.path.join(root, policy_module.DEFAULT_FILE)
    if not os.path.isfile(path):
        return None, ("budget: not configured -- no %s in %s, so no cost "
                      "ceiling was enforced. Not a failure and not a blind "
                      "spot: the rule was never requested."
                      % (policy_module.DEFAULT_FILE, root))
    try:
        policy = policy_module.load(path)
    except policy_module.PolicyError as exc:
        return _stage("budget", UNAVAILABLE,
                      "policy file exists but could not be read, so the "
                      "ceiling it asks for was never enforced: %s" % exc), None

    max_usd = policy.get("max_usd")
    if max_usd is None:
        return None, ("budget: not configured -- %s sets no max_usd, so no "
                      "cost ceiling was enforced." % path)

    # No --json here, deliberately. cost-guard's JSON pass carries only
    # status="within_budget", while its render() prints the measured figure the
    # operator actually wants. _reason() reads whichever the child emits.
    return _run("budget", [_COST_GUARD, workspace,
                           "--max-usd", str(max_usd)]), None


def chain(workspace=".", repo_dir="."):
    """Run every stage and fold them into one verdict. Returns the record."""
    root = _workspace_root(workspace)
    stages = [
        _run("bundle", [_RECEIPT_BUNDLE, workspace, "--repo-dir", repo_dir,
                        "--json"]),
        _run("stats", [_RECEIPT_STATS, workspace, "--repo-dir", repo_dir,
                       "--json"]),
    ]
    notes = []
    budget, note = _budget_stage(root, workspace)
    if budget is not None:
        stages.append(budget)
    if note is not None:
        notes.append(note)

    verdict = rollup([s["state"] for s in stages])
    return {
        "workspace": workspace,
        "read_only": True,
        "stages": stages,
        "notes": notes,
        "verdict": verdict,
        "exit_code": EXIT[verdict],
        "summary": _summary(verdict, stages),
    }


def _summary(verdict, stages):
    total = len(stages)
    blind = [s["stage"] for s in stages if s["state"] == UNAVAILABLE]
    bad = [s["stage"] for s in stages if s["state"] == FAILED]
    if verdict == NOTHING:
        return ("NOTHING TO CHECK -- all %d stages found no evidence under "
                "this workspace. Zero receipts is not a passing chain; it is "
                "most often the wrong directory." % total)
    if verdict == UNAVAILABLE:
        return ("UNAVAILABLE -- %d of %d stages could not be evaluated (%s). "
                "The chain is not proven: an unrun link is the absence of "
                "evidence, not evidence of soundness."
                % (len(blind), total, ", ".join(blind)))
    if verdict == FAILED:
        return ("FAILED -- %d of %d stages FAILED (%s). The chain is only as "
                "good as its weakest link." % (len(bad), total, ", ".join(bad)))
    return ("OK -- all %d stages were evaluated and passed. This is the "
            "weakest link, not a score." % total)


def _render(report):
    lines = ["Verification chain: %s" % report["workspace"],
             "Read-only: starts nothing, spends nothing, contacts no provider.",
             ""]
    for s in report["stages"]:
        lines.append("  %-12s %-12s %s" % (s["stage"], s["state"], s["reason"]))
    for note in report["notes"]:
        lines.append("  %s" % note)
    lines.append("")
    lines.append(report["summary"])
    return "\n".join(lines)


class _Parser(argparse.ArgumentParser):
    """Exit 64 on a usage error, never argparse's default 2.

    In this repo 2 means "could not check", so a mistyped flag falling through
    as 2 would be indistinguishable from an honest blind spot -- a typo
    masquerading as a gate that ran and came back uncertain.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def main(argv=None):
    ap = _Parser(
        description="Run the whole verification chain and report one verdict.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace to verify (or its .loki dir); default .")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are re-checked against")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the full record as JSON")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.workspace):
        # 66, not 3. "You pointed me at nothing" and "this workspace holds no
        # evidence" are different facts, and only one is about the workspace.
        sys.stderr.write(
            "verify-chain: workspace does not exist: %s\n" % args.workspace)
        return 66

    report = chain(args.workspace, args.repo_dir)
    print(json.dumps(report, indent=2) if args.as_json else _render(report))
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
