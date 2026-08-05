#!/usr/bin/env python3
"""Would this policy have blocked my last N runs? Ask before adopting it.

WHY THIS EXISTS. Lowering a ceiling is a code change (tools/policy-load.py
exists to make it one), but a reviewed diff still tells you nothing about its
CONSEQUENCE. `max_usd: 2.00` looks reasonable in a pull request and is
indistinguishable, on the page, from a ceiling that would have blocked eleven
of the last twelve merges. Teams find out by merging it and watching CI go red,
which is the most expensive possible way to learn a number.

So: replay the recorded history against a CANDIDATE policy and report which
runs it would have blocked. Nothing is enforced, nothing is written, no
provider is contacted. Simulation is free.

    tools/gate-simulate.py [workspace] --policy candidate.json

THE ONE PROPERTY THAT MAKES THE ANSWER WORTH ANYTHING:

    A RUN THAT CANNOT BE SIMULATED IS UNEVALUABLE, AND IS EXCLUDED FROM THE
    BLOCK COUNT. NEVER COUNTED AS PASSING.

A run whose cost was never measured carries ZERO information about whether it
would clear a cost ceiling. Sliding it into the "would not have blocked" pile
produces the single most dangerous output this tool could emit: "0 of 5 runs
would have been blocked" when three of the five were unmeasurable. That reads
as a green light to adopt the policy, it is derived from two data points, and
it is loudest exactly when the instrumentation is broken and it is least
entitled to speak. It is the same lie -- absence rendered as compliance -- that
this repo has now paid for across seventeen surfaces.

Hence every count in the output states its BASIS: "2 of 5 evaluable". A bare
count is a number without a denominator, and a denominator is the only thing
that distinguishes a clean history from a blind one.

WHY THIS IS A GATE and not an advisor, despite only ever reporting. The name
says gate-*, so tests/test_tool_exit_contract.py holds it to the strictest rule
in the file: it must never exit 0 while its own output says it could not
evaluate. That is the right rule for it. This tool's whole purpose is to be the
input to an adoption decision, and an adoption decision made from a partly
blind simulation is worse than one made from no simulation, because it comes
with a number attached. So any unevaluable run exits 2, and the per-run table
still shows every verdict it did manage to reach.

PRECEDENCE, inherited from ci-gate.py's own docstring: BLIND OUTRANKS BLOCKED.
When the history holds both an unevaluable run and one the policy would block,
this exits 2, not 1. With 1 the operator lowers the ceiling, re-runs, sees the
block clear, and is still blind on the runs that were never measured.

NOTHING HERE RE-IMPLEMENTS A VALIDATOR OR A PREDICATE:

  the policy schema   tools/policy-load.py, by SUBPROCESS. Its docstring is
                      explicit that a loader shrugging at bad input yields a
                      gate with nothing to enforce. A candidate policy this
                      tool blesses is one an operator is about to hand to a
                      real gate, so it must clear the SAME bar, decided by the
                      same code. Refusing here names the file.
  measured vs not     record_is_measured() in autonomy/lib/efficiency_cost.py,
                      imported directly. row_usd() below maps a HISTORY ROW
                      onto it -- see that docstring for why the mapping is a
                      key mapping and not a second copy of the rule.
  reading the history load() in tools/cost-history.py, which owns the file
                      format and already counts corrupt lines rather than
                      dropping them.
  receipt integrity   verify() in autonomy/lib/proof-verify.py.
  the newest receipt  the same glob convention as ci-gate.py/baseline-pin.py.

A MEASURED $0.00 IS DATA AND IS SIMULATED AS 0. Zero is falsy, so every guard
here is an explicit `is None`. A truthiness guard would silently reclassify the
cheapest real runs as unmeasurable, which is this same lie pointed the other
way and would make a free-tier history look entirely blind.

BOTH POLICY AXES ARE SIMULATED, because simulating one and ignoring the other
is the vacuously-green shape one level up: a report headed "0 would be blocked"
for a policy whose require_receipt axis was never looked at. The receipt axis
resolves the row's recorded workspace to its newest receipt and asks verify().
A workspace that no longer exists, or holds no receipt, is UNEVALUABLE on that
axis -- the run may well have had one at the time; a deleted directory is an
absent measurement, not a failure. If policy-load ever grows a key this tool
cannot simulate, the run is refused NAMING THE KEY rather than quietly scored
on the axes it does understand.

Usage:
  tools/gate-simulate.py [workspace] --policy <file> [--json]
  tools/gate-simulate.py [workspace] --policy <file> --file <history.jsonl>

Exit: 0 every run evaluable and none blocked, 1 a run would be BLOCKED,
2 a run could not be evaluated (or the history is unreadable), 3 no history to
simulate against, 64 usage error, 66 the policy or history file is missing.
"""

import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import glob  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_LIB = os.path.join(_ROOT, "autonomy", "lib")
sys.path.insert(0, _LIB)


def _load(name, path):
    """Import a hyphenated file as a module. Hyphens block a plain import."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", os.path.join(_LIB, "proof-verify.py"))
_ch = _load("cost_history", os.path.join(_HERE, "cost-history.py"))

from efficiency_cost import record_is_measured  # noqa: E402

_POLICY_LOAD = os.path.join(_HERE, "policy-load.py")

PASS, BLOCKED, CANNOT, NOTHING = 0, 1, 2, 3
USAGE, NO_INPUT = 64, 66

_STATE = {PASS: "WOULD PASS", BLOCKED: "WOULD BLOCK",
          CANNOT: "UNEVALUABLE", NOTHING: "NOTHING TO CHECK"}

DEFAULT_HISTORY = os.path.join(".loki", "cost-history.jsonl")

# Every policy key this tool knows how to replay. Cross-checked against the
# policy actually loaded: a key policy-load accepts and this cannot simulate is
# a REFUSAL naming the key, never a silent omission from the score. Scoring a
# run on the axes we happen to understand, under a headline that names the
# whole policy, is how a partial simulation passes for a complete one.
SIMULATABLE_KEYS = ("max_usd", "require_receipt")


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error; here 2 means "could not check".

    An unknown flag and a blind instrument are opposite facts and must not
    share an exit code. Left at the default, a typo'd flag reads to a CI job as
    a gate that went blind, and the operator goes hunting for missing
    instrumentation that was never missing.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        print("%s: error: %s" % (self.prog, message), file=sys.stderr)
        raise SystemExit(USAGE)


def load_policy(path):
    """The validated policy, via policy-load.py as a SUBPROCESS.

    Returns (policy_dict, None) or (None, reason). The validation itself is
    never restated: policy-load.py owns the schema, the value checks (negative,
    NaN, bool-as-int) and the enforces-nothing rule, and a candidate blessed
    here is one an operator is about to hand to a real gate. Two validators
    drift, and the drift shows up as a policy this tool approved and the gate
    then rejected.

    policy-load exits 1 for BOTH "file missing" and "file invalid", so the
    missing case is settled by stat() here BEFORE the subprocess runs. They
    need different exit codes (66 vs the refusal) because they are different
    operator actions: create the file, or fix the file.
    """
    if not os.path.exists(path):
        return None, ("no policy file at %s -- there is no candidate to "
                      "simulate." % path)
    proc = subprocess.run(
        [sys.executable, _POLICY_LOAD, "--file", path, "--json"],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip() or "no detail reported"
        return None, ("policy %s was REFUSED by tools/policy-load.py, so it "
                      "must not be simulated: a simulation of an invalid "
                      "policy answers a question about a policy no gate would "
                      "accept.\n  %s" % (path, detail))
    try:
        policy = json.loads(proc.stdout)
    except ValueError as exc:
        return None, ("could not read the validated policy back from "
                      "tools/policy-load.py --json for %s: %s" % (path, exc))
    if not isinstance(policy, dict):
        return None, ("tools/policy-load.py returned a %s for %s, not a policy "
                      "object" % (type(policy).__name__, path))
    return policy, None


def _num(v):
    """A number as itself; None, "", or a bool as None. A real 0 survives as 0."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def row_usd(row):
    """The measured USD for one HISTORY ROW, or None when it was not measured.

    THE ONE PLACE the measured/unmeasured distinction is decided for a row, so
    it cannot drift between the loader and the reporter.

    WHY THIS IS NOT cost-history.measured_usd(), which is right there and which
    a reviewer will reasonably ask about. That function reads a RECEIPT COST
    BLOCK -- {usd, input_tokens, output_tokens, ...} -- and funnels every field
    through record_is_measured(). A history ROW has no token fields at all, so
    record_is_measured() answers False for every row, including one carrying a
    perfectly good `usd`. Pointing it at a row does not reuse the rule, it
    misapplies it, and it would report an entire measured history as blind.

    What IS reused is the root predicate itself, imported from
    autonomy/lib/efficiency_cost.py and never restated. cost-history.py writes
    the `measured` flag at record time BY CALLING record_is_measured(), so
    trusting that flag reuses the rule at one remove, which is the whole point
    of it being recorded.

    THE ORDER OF THE LEGACY BRANCH IS LOAD-BEARING. record_is_measured() is a
    truthiness predicate, so it answers False for a measured $0.0000 --
    correct for its own question ("did this record observe anything?"), wrong
    for this one ("is this dollar figure present?"). So `usd is None` is tested
    FIRST and short-circuits; record_is_measured() only ever adjudicates a
    legacy row whose usd is already absent. Asking it first would drop a real
    zero from a flag-less row while keeping the identical flagged row, so the
    same fact would get two answers depending on which version of
    cost-history.py wrote it.

    The final test is `is not None`, never truthiness: a genuinely measured
    $0.0000 run (cached, free tier) is a real observation and must be
    simulated as 0.0 against the ceiling, not filed under "cannot evaluate".
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


def newest_receipt(workspace):
    """The most recent proof.json under a workspace, or None.

    Same glob convention as ci-gate.py and baseline-pin.py.
    """
    root = os.path.normpath(workspace)
    if os.path.basename(root) == ".loki":
        root = os.path.dirname(root) or "."
    found = glob.glob(os.path.join(root, ".loki", "proofs", "*", "proof.json"))
    return max(found, key=os.path.getmtime) if found else None


def simulate_cost(row, max_usd):
    """(verdict, detail) for one run against a cost ceiling.

    THE FUNCTION THE WHOLE FILE PROTECTS. Its unmeasured branch is the one
    place absence could become compliance, so it is written once, here, and has
    nowhere to hide.

    `is None`, never truthiness: a genuinely measured $0.0000 run (cached, free
    tier) is a real observation and must be simulated as 0.0. A falsy guard
    would file every cheap run under "cannot evaluate" and report a blind
    history to a team whose instrumentation is perfect.
    """
    usd = row_usd(row)
    if usd is None:
        return CANNOT, ("cost was never measured for this run, so whether it "
                        "clears a $%.4f ceiling is unknown. Unmeasured is not "
                        "$0.00 and is not a pass." % max_usd)
    if usd > max_usd:
        return BLOCKED, ("$%.4f exceeds the $%.4f ceiling" % (usd, max_usd))
    return PASS, "$%.4f is within the $%.4f ceiling" % (usd, max_usd)


def simulate_receipt(row):
    """(verdict, detail) for one run against require_receipt.

    A row records the workspace it came from. The receipt axis therefore needs
    that directory to still be on disk, which for older history it often is
    not. THAT IS UNEVALUABLE, NOT A FAILURE: the run may well have produced a
    perfectly good receipt, and a deleted directory is an absent measurement
    rather than evidence of a missing receipt. Scoring it as a block would
    manufacture an adoption objection out of nothing, which is the same
    dishonesty as manufacturing a pass.

    Verification itself is verify() in autonomy/lib/proof-verify.py, never
    re-implemented here. But its VERDICT is not consumed whole, and the reason
    is the same rule one level down.

    verify() answers "is this receipt verified?", and for that question it is
    correct that diff_drift=None (could not re-check against the repo) collapses
    into ok=False -- its own docstring says so by design, because a receipt
    whose central fact cannot be re-checked is not a verified receipt. This tool
    asks a DIFFERENT question: "would the policy have blocked this run?" A
    historical run whose workspace is no longer a resolvable git repo -- branch
    deleted, refs gone, never a repo -- comes back hash_ok=True with
    diff_drift=None. Reporting that as WOULD BLOCK manufactures an adoption
    objection out of a missing measurement, which is exactly the dishonesty the
    paragraph above disclaims, pointed the other way. So the two are split here:
    a receipt that FAILED a check blocks, a receipt that could not BE checked is
    unevaluable.

    That deliberately makes this axis NARROWER than verify()'s verdict, and
    narrower still than what ci-gate.py enforces (it routes the receipt axis
    through receipt-attest.py, which uses verify_integrity() rather than
    verify()). A simulator stricter than the gate it simulates answers a
    question nobody asked; one that reports blindness as blindness does not.
    """
    workspace = row.get("workspace")
    if not isinstance(workspace, str) or not workspace:
        return CANNOT, ("this history row records no workspace, so its "
                        "receipt cannot be located")
    if not os.path.isdir(workspace):
        return CANNOT, ("workspace %s no longer exists, so whether it carried "
                        "a receipt cannot be established now" % workspace)
    receipt = newest_receipt(workspace)
    if receipt is None:
        return BLOCKED, ("no receipt under %s/.loki/proofs/*/proof.json -- "
                         "checked, and the answer is no" % workspace)
    try:
        result = _pv.verify(receipt)
    except Exception as exc:
        return CANNOT, ("receipt %s could not be verified: %s" % (receipt, exc))
    if result.get("ok"):
        return PASS, "receipt %s verifies" % receipt
    # Intact receipt, unresolvable repo: checked the receipt, could not check it
    # AGAINST anything. Not a failure, and not a pass.
    if result.get("hash_ok") and result.get("diff_drift") is None:
        return CANNOT, ("receipt %s is intact but could not be re-checked "
                        "against its repo (the recorded git state is no longer "
                        "resolvable), so whether it would have satisfied "
                        "require_receipt is unknown" % receipt)
    return BLOCKED, ("receipt %s FAILS verification: %s"
                     % (receipt, result.get("reason") or "no reason recorded"))


def simulate_run(row, policy):
    """The worst verdict across every configured axis, for ONE run.

    WEAKEST LINK, with CANNOT outranking BLOCKED -- the same precedence
    ci-gate.py applies to a live merge, for the same reason. A run that is
    blocked on cost AND blind on receipts is reported blind: fixing the cost
    would otherwise clear the verdict and leave the blindness in place.
    """
    axes = []
    if "max_usd" in policy:
        verdict, detail = simulate_cost(row, policy["max_usd"])
        axes.append({"axis": "max_usd", "verdict": verdict, "detail": detail})
    if policy.get("require_receipt"):
        verdict, detail = simulate_receipt(row)
        axes.append({"axis": "require_receipt", "verdict": verdict,
                     "detail": detail})

    if not axes:
        # policy-load already refuses an enforces-nothing policy, so this is
        # unreachable through the CLI. Kept because it is the correct answer if
        # it ever becomes reachable: no axis checked is no pass earned.
        return {"verdict": CANNOT, "axes": [],
                "detail": "no axis of this policy applies to this run"}

    codes = [a["verdict"] for a in axes]
    worst = CANNOT if CANNOT in codes else (
        BLOCKED if BLOCKED in codes else PASS)
    detail = "; ".join(a["detail"] for a in axes if a["verdict"] == worst)
    return {"verdict": worst, "axes": axes, "detail": detail}


def simulate(policy_path, history_path):
    """Replay the history against a candidate policy. Returns a verdict dict.

    Every count carries its denominator. There is no branch here that reports a
    block count without also reporting how many runs were evaluable of how
    many, because a bare "0 blocked" over a blind history is the exact output
    this file exists to make impossible.
    """
    base = {
        "policy_file": policy_path,
        "history_file": history_path,
        "policy": None,
        "runs": 0,
        "evaluable": 0,
        "unevaluable": 0,
        "blocked": 0,
        "would_pass": 0,
        "corrupt_lines": 0,
        "results": [],
        "basis": None,
        "why": None,
    }

    policy, refusal = load_policy(policy_path)
    if policy is None:
        base["status"] = "policy_refused"
        # A missing file is a different operator action from an invalid one.
        base["exit_code"] = (NO_INPUT if not os.path.exists(policy_path)
                             else CANNOT)
        base["why"] = refusal
        return base
    base["policy"] = policy

    unsupported = sorted(k for k in policy if k not in SIMULATABLE_KEYS)
    if unsupported:
        base["status"] = "policy_unsimulatable"
        base["exit_code"] = CANNOT
        base["why"] = (
            "policy %s uses key(s) this tool cannot replay: %s. Reporting a "
            "block count over the remaining axes would headline the whole "
            "policy while silently ignoring part of it." % (
                policy_path, ", ".join(unsupported)))
        return base

    if not os.path.exists(history_path):
        base["status"] = "no_history"
        base["exit_code"] = NO_INPUT
        base["why"] = (
            "no history file at %s -- record runs with "
            "tools/cost-history.py record first. Simulating against nothing "
            "is not a clean result." % history_path)
        return base

    rows, corrupt = _ch.load(history_path)
    if rows is None:
        base["status"] = "unreadable"
        base["exit_code"] = CANNOT
        base["why"] = ("history at %s exists but could not be read; the "
                       "instrument is blind, which is not the same as a "
                       "policy that blocks nothing." % history_path)
        return base

    base["corrupt_lines"] = corrupt
    base["runs"] = len(rows)

    if not rows:
        base["status"] = "empty_history"
        base["exit_code"] = NOTHING
        base["why"] = (
            "history %s holds no runs (%d corrupt line(s)); a policy simulated "
            "against zero runs blocks nothing, and that is not evidence it is "
            "safe to adopt." % (history_path, corrupt))
        return base

    for index, row in enumerate(rows):
        outcome = simulate_run(row, policy)
        base["results"].append({
            "index": index,
            "workspace": row.get("workspace"),
            "usd": row_usd(row),   # None stays None. Never 0 as a stand-in.
            "verdict": outcome["verdict"],
            "state": _STATE[outcome["verdict"]],
            "detail": outcome["detail"],
            "axes": outcome["axes"],
        })

    verdicts = [r["verdict"] for r in base["results"]]
    base["unevaluable"] = verdicts.count(CANNOT)
    base["blocked"] = verdicts.count(BLOCKED)
    base["would_pass"] = verdicts.count(PASS)
    base["evaluable"] = base["blocked"] + base["would_pass"]

    # THE BASIS, on every count and never behind a flag. "1 of 5 would have
    # been blocked" is a different fact depending on whether 5, 2 or 0 runs
    # could be evaluated, and the reader cannot recover the difference.
    base["basis"] = ("%d of %d run(s) were evaluable against this policy; "
                     "%d could not be simulated and are excluded from the "
                     "block count." % (base["evaluable"], base["runs"],
                                       base["unevaluable"]))

    if base["unevaluable"]:
        # BLIND OUTRANKS BLOCKED. Fixing a ceiling clears a block and leaves
        # the blindness exactly where it was.
        base["status"] = "partly_unevaluable"
        base["exit_code"] = CANNOT
        base["why"] = (
            "%d of %d run(s) could NOT be simulated against this policy, so "
            "this simulation cannot tell you whether adopting it is safe. An "
            "unevaluable run is not a run that would have passed."
            % (base["unevaluable"], base["runs"]))
    elif base["blocked"]:
        base["status"] = "would_block"
        base["exit_code"] = BLOCKED
        base["why"] = ("%d of %d evaluable run(s) would have been BLOCKED by "
                       "this policy." % (base["blocked"], base["evaluable"]))
    else:
        base["status"] = "would_pass"
        base["exit_code"] = PASS
        base["why"] = None

    return base


def render(d):
    if d["status"] == "policy_refused":
        return "CANNOT SIMULATE: %s" % d["why"]
    if d["status"] == "policy_unsimulatable":
        return "CANNOT SIMULATE: %s" % d["why"]
    if d["status"] in ("no_history", "empty_history", "unreadable"):
        return "NOTHING TO SIMULATE: %s" % d["why"]

    policy = ", ".join("%s=%s" % (k, json.dumps(d["policy"][k]))
                       for k in sorted(d["policy"]))
    lines = ["policy: %s" % policy,
             "history: %s" % d["history_file"],
             ""]
    # THE COST COLUMN IS ONLY PRINTED WHEN THE POLICY HAS A COST AXIS, and the
    # reason is not cosmetic. An unmeasured cost renders as UNKNOWN, which is a
    # cannot-evaluate token; under a receipt-only policy that column is not part
    # of the verdict at all, so printing UNKNOWN there would put "I could not
    # evaluate" in the output of a run that WAS fully evaluated on every axis
    # the policy configures -- a gate saying it is blind while honestly exiting
    # 0. The rule this tool is held to reads exit code against output text, so
    # an irrelevant column must not speak in that vocabulary.
    costed = "max_usd" in d["policy"]
    header = ("%-5s %-12s %-12s %s" % ("RUN", "COST", "VERDICT", "DETAIL")
              if costed else "%-5s %-12s %s" % ("RUN", "VERDICT", "DETAIL"))
    lines.append(header)
    for row in d["results"]:
        if not costed:
            lines.append("%-5d %-12s %s" % (
                row["index"], row["state"], row["detail"]))
            continue
        # UNKNOWN, never $0.00. Absent is not zero, and a measured zero is not
        # absent -- so this is `is None` and prints a real 0 as $0.0000.
        cost = "UNKNOWN" if row["usd"] is None else "$%.4f" % row["usd"]
        lines.append("%-5d %-12s %-12s %s" % (
            row["index"], cost, row["state"], row["detail"]))
    lines.append("")
    if d["corrupt_lines"]:
        lines.append("%d CORRUPT line(s) in the history -- counted, not "
                     "skipped." % d["corrupt_lines"])
    lines.append("%d of %d evaluable run(s) WOULD HAVE BEEN BLOCKED"
                 % (d["blocked"], d["evaluable"]))
    lines.append("basis: %s" % d["basis"])
    if d["why"]:
        lines.append(d["why"])
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Replay recorded cost history against a candidate policy.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root (or its .loki dir); default .")
    ap.add_argument("--policy", required=True,
                    help="candidate policy file to simulate")
    ap.add_argument("--file", dest="history",
                    help="history JSONL; default <workspace>/%s"
                         % DEFAULT_HISTORY)
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the simulation as JSON")
    args = ap.parse_args(argv)

    root = os.path.normpath(args.workspace)
    if os.path.basename(root) == ".loki":
        root = os.path.dirname(root) or "."
    history = args.history or os.path.join(root, DEFAULT_HISTORY)

    d = simulate(args.policy, history)
    # --json stays JSON on EVERY path, refusals included: a caller that parses
    # stdout must not have to special-case the failure branch (fixed once
    # already in 9b879986). Diagnostics go to stderr.
    print(json.dumps(d, indent=2, sort_keys=True) if args.as_json
          else render(d))
    return d["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
