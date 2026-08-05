#!/usr/bin/env python3
"""Cross-tier benchmark receipt: what is VERIFIED, and what is merely planned.

WHAT THIS IS FOR. A cross-tier comparison is only worth reading if the oracle
that decides pass/fail is trustworthy. This emits a machine-readable receipt
about the ORACLES themselves -- one representative task per complexity tier --
and it does so WITHOUT running an agent, so it costs nothing.

WHAT IT DELIBERATELY DOES NOT DO. It does not run the benchmark, and it never
reports a completion-quality, cost, or time figure for a run that did not
happen. Those fields are emitted with status "planned_experiment" and a value
of null. An unmeasured quantity is never rendered as 0, and never omitted in a
way that lets a reader assume it was measured.

THE PROPERTY IT ACTUALLY MEASURES, at zero cost: does each tier's held-out
grader DISCRIMINATE? A grader is only evidence if it fails an absent artifact
AND passes a correct one. A grader that always fails is as useless as one that
always passes, and both look identical in a results table that only records
"the grader ran".

  negative probe: run the grader in an EMPTY workdir      -> must exit non-zero
  positive probe: run it against a known-good artifact    -> must exit zero

Only the simple tier ships a positive probe here, because a known-good artifact
for the medium and hard tiers is a full solution to those tasks. Writing one to
satisfy this script would be writing the answer key into the repo, which is
precisely the contamination the held-out design exists to prevent. Those tiers
therefore report positive_probe as "not_attempted" with that reason, rather than
quietly reporting only the half that was cheap.

TIER IS NOT RECORDED IN THE TASK DATA. benchmarks/bench/tasks/*.json carries no
tier or complexity field, so tier is inferred from the filename prefix here and
that inference is stamped into the receipt as `tier_source: "filename_prefix"`.
A reader can then see that the tier axis rests on a naming convention rather
than on data, instead of trusting a column that looks authoritative.

Exit codes follow the repo convention:
    0  receipt emitted
    1  a grader failed to discriminate (a real defect in the evidence chain)
    2  could not check (graders missing)
    3  nothing to check
   64  usage error
   66  input path missing
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))

# One representative scenario per tier, chosen from the fixtures that ALREADY
# exist. No new fixture was authored for this receipt.
TIERS = [
    ("small", "simple-1-contact-form"),
    ("medium", "multifail-1-two-modules"),
    ("high", "hard-1-order-api"),
]

# A known-good artifact for the small tier only. See the module docstring: the
# medium and hard equivalents would be answer keys.
# NON-REPRODUCIBLE OBSERVATIONS. NOT verification, NOT a receipt.
#
# These were seen by hand and CANNOT BE REPLAYED: the artifacts were built
# in a temp directory and destroyed, no hash binds them to the run, and
# nothing in this repo reproduces them. Calling that VERIFIED would fail
# the same standard this codebase applies to every other claim, and an
# earlier draft of this file did exactly that.
#
# They are kept as a prior for whoever builds the real probes. The tier
# status stays NOT ATTEMPTED regardless of what is recorded here.
#
# WHAT WAS OBSERVED (by hand, 2026-08-03, unreplayable):
#
#   hard-1-order-api          positive -> 0, near-miss omitting the
#                             subtotal>=100 discount -> 1
#   multifail-1-two-modules   positive -> 0, near-miss fixing only
#                             cluster A -> 1
#
# WHAT WOULD MAKE THIS A RECEIPT: artifacts stored OUTSIDE this repository
# (so the held-out design stays uncontaminated), content-hashed, with the
# hash and both exit codes recorded so a later run can be checked against
# it. None of that exists, so medium and high remain UNVERIFIED and must
# not be spent against.
_NON_REPRODUCIBLE_NOTE = {
    "hard-1-order-api": {
        "date": "2026-08-03",
        "positive_exit": 0,
        "adversarial_exit": 1,
        "adversarial_shape": "omits the subtotal>=100 discount",
    },
    "multifail-1-two-modules": {
        "date": "2026-08-03",
        "positive_exit": 0,
        "adversarial_exit": 1,
        "adversarial_shape": "fixes only cluster A, leaves cluster B absent",
    },
}

_POSITIVE_FIXTURE = {
    "simple-1-contact-form": (
        "index.html",
        '<!doctype html><html><body>\n'
        '<form action="/contact" method="post">\n'
        '<label for="name">Name</label>'
        '<input type="text" id="name" name="name" required>\n'
        '<label for="email">Email</label>'
        '<input type="email" id="email" name="email" required>\n'
        '<label for="message">Message</label>'
        '<textarea id="message" name="message" required></textarea>\n'
        '<button type="submit">Send</button></form></body></html>\n'
    ),
}

# ADVERSARIAL probe: an artifact that LOOKS right and is subtly wrong.
#
# Positive and negative probes together only prove a grader can tell "something"
# from "nothing". That is a low bar: a grader checking merely that index.html
# exists passes both. The question that decides whether a benchmark is worth
# paying for is whether the grader rejects a PLAUSIBLE WRONG ANSWER, which is
# the only kind an agent actually produces.
#
# This one is a real contact page that is missing the required email and
# message fields. It renders, it is valid HTML, and it does not satisfy the
# spec. A grader that passes it is measuring "did the model emit a form",
# not "did the model do the task".
_ADVERSARIAL_FIXTURE = {
    "simple-1-contact-form": (
        "index.html",
        '<!doctype html><html><body>\n'
        '<h1>Contact us</h1>\n'
        '<form action="/contact" method="post">\n'
        '<label for="name">Name</label>'
        '<input type="text" id="name" name="name" required>\n'
        '<button type="submit">Send</button></form></body></html>\n'
    ),
}

# Metrics the steering brief asks for. Each is emitted for every tier with an
# explicit status, so a reader never has to guess whether a blank means zero.
_PLANNED = (
    "completion_quality", "intervention_count", "intervention_rate",
    "wall_time_s", "cost_usd", "tokens", "recovery_behavior",
    "maintainability_proxy", "novelty_usefulness", "user_value",
)


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64. argparse defaults to 2, which here means
    "could not check" -- a claim about the subject rather than about the
    command line."""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _grader_path(task):
    return os.path.join(_ROOT, "benchmarks", "bench", "fixtures",
                        task + "-overlay", "check_acceptance.py")


def _run_grader(grader, workdir):
    """Run a grader in workdir and return (rc, first_line)."""
    proc = subprocess.run(
        [sys.executable, grader],
        cwd=workdir, capture_output=True, text=True, timeout=120)
    out = (proc.stdout or proc.stderr or "").strip().splitlines()
    return proc.returncode, (out[0][:80] if out else "")


def probe_tier(tier, task):
    """Both probes for one tier. Neither runs an agent; neither costs money."""
    rec = {
        "tier": tier,
        "tier_source": "filename_prefix",
        "task": task,
        "grader": os.path.relpath(_grader_path(task), _ROOT),
    }
    grader = _grader_path(task)
    if not os.path.isfile(grader):
        rec["oracle_status"] = "missing"
        rec["discriminates"] = None
        return rec

    with tempfile.TemporaryDirectory() as empty:
        rc, msg = _run_grader(grader, empty)
    rec["negative_probe"] = {
        "description": "grader run in an EMPTY workdir",
        "exit_code": rc,
        "message": msg,
        "expected": "non-zero",
        "ok": rc != 0,
        "status": "measured",
    }

    fixture = _POSITIVE_FIXTURE.get(task)
    if fixture is None:
        rec["positive_probe"] = {
            "status": "not_attempted",
            "reason": ("a known-good artifact for this tier would be a full "
                       "solution to the task; committing one would put the "
                       "answer key in the repo and contaminate the held-out "
                       "design"),
            "ok": None,
        }
    else:
        name, body = fixture
        with tempfile.TemporaryDirectory() as good:
            with open(os.path.join(good, name), "w", encoding="utf-8") as fh:
                fh.write(body)
            rc2, msg2 = _run_grader(grader, good)
        rec["positive_probe"] = {
            "description": "grader run against a hand-built correct artifact",
            "exit_code": rc2,
            "message": msg2,
            "expected": "zero",
            "ok": rc2 == 0,
            "status": "measured",
        }

    adv_fixture = _ADVERSARIAL_FIXTURE.get(task)
    if adv_fixture is None:
        rec["adversarial_probe"] = {
            "status": "not_attempted",
            "reason": ("no plausible-wrong-answer fixture authored for this "
                       "tier yet; a grader unverified against a near-miss has "
                       "NOT been shown to measure the task"),
            "ok": None,
        }
    else:
        name, body = adv_fixture
        with tempfile.TemporaryDirectory() as near:
            with open(os.path.join(near, name), "w", encoding="utf-8") as fh:
                fh.write(body)
            rc3, msg3 = _run_grader(grader, near)
        rec["adversarial_probe"] = {
            "description": ("grader run against a PLAUSIBLE WRONG artifact "
                            "(renders, valid, missing required fields)"),
            "exit_code": rc3,
            "message": msg3,
            "expected": "non-zero",
            "ok": rc3 != 0,
            "status": "measured",
        }

    neg = rec["negative_probe"]["ok"]
    pos = rec["positive_probe"].get("ok")
    adv = rec["adversarial_probe"].get("ok")
    if neg and pos and adv:
        # The only status that licenses a PAID benchmark: the grader rejects
        # nothing, accepts a correct artifact, AND rejects a plausible wrong
        # one. Without the third, a green cell may only mean "output existed".
        rec["oracle_status"] = "discriminates"
        rec["discriminates"] = True
    elif neg and pos and adv is False:
        rec["oracle_status"] = "accepts_a_wrong_answer"
        rec["discriminates"] = False
    elif neg and pos and adv is None:
        # UNREACHABLE TODAY, and kept deliberately. It fires only for a task
        # that has a positive fixture but no adversarial one, and right now
        # every task with the first has the second. A future task that gets a
        # positive fixture without a near-miss would otherwise fall through to
        # `discriminates` on two probes -- claiming the strongest status while
        # skipping the probe that actually decides whether the grader measures
        # the task. Verified unreachable by comparing the two fixture tables,
        # not assumed.
        rec["oracle_status"] = "adversarially_unverified"
        rec["discriminates"] = None
    elif neg and pos is None:
        # Half-verified, and labelled as such rather than promoted to a pass.
        rec["oracle_status"] = "rejects_absent_artifact_only"
        rec["discriminates"] = None
    else:
        rec["oracle_status"] = "does_not_discriminate"
        rec["discriminates"] = False

    rec["metrics"] = {
        m: {"value": None, "status": "planned_experiment",
            "why": "no agent was run; running one costs money and is "
                   "founder-gated"}
        for m in _PLANNED
    }
    return rec


# Acceptance commands that CANNOT FAIL. A task scored by one of these records
# success unconditionally, so a timed-out run producing nothing is written down
# as a pass.
#
# FOUND LIVE, not hypothesised. `loki bench run demo-pass` produced three
# trials, every one `exit_status: "timeout"` at 60s with `iterations: 0` and no
# tokens recorded -- and every one `success: True`. runner.py:242 computes
# `success = (exit_code == 0)` from the acceptance command ALONE; the adapter's
# timeout status and zero iteration count are recorded in the same file and
# never consulted.
#
# demo-pass is a CLI smoke test, so an always-true acceptance is defensible
# THERE. The hazard is that nothing distinguishes it from a real task in the
# results, and a reader aggregating result rows sees success=True either way.
_TRIVIAL_ACCEPTANCE = ("true", "/bin/true", ":", "exit 0")


def scan_trivial_acceptance():
    """Tasks whose acceptance command cannot fail. Reported, never silenced."""
    tasks_dir = os.path.join(_ROOT, "benchmarks", "bench", "tasks")
    out = []
    if not os.path.isdir(tasks_dir):
        return out
    for name in sorted(os.listdir(tasks_dir)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(tasks_dir, name), encoding="utf-8") as fh:
                spec = json.load(fh)
        except (OSError, ValueError):
            continue
        cmd = ((spec.get("acceptance") or {}).get("cmd") or "").strip()
        if cmd in _TRIVIAL_ACCEPTANCE:
            out.append({
                "task": spec.get("id") or name[:-5],
                "acceptance_cmd": cmd,
                "why": ("this command exits 0 unconditionally, so runner.py's "
                        "`success = (exit_code == 0)` records a pass even when "
                        "the run timed out and produced nothing"),
            })
    return out


def build_receipt():
    rows = [probe_tier(t, task) for t, task in TIERS]
    measured = sum(1 for r in rows if r.get("discriminates") is True)
    half = sum(1 for r in rows if r.get("oracle_status")
               == "rejects_absent_artifact_only")
    broken = [r["task"] for r in rows if r.get("discriminates") is False]
    return {
        "schema_version": "1.0",
        "receipt_type": "cross_tier_oracle_verification",
        "what_this_is": ("verification that each tier's held-out grader "
                         "discriminates. NOT a benchmark result."),
        "agent_runs": 0,
        "spend_usd": 0,
        "tiers": rows,
        "trivial_acceptance_tasks": scan_trivial_acceptance(),
        "summary": {
            "tiers_probed": len(rows),
            "oracles_fully_discriminating": measured,
            "oracles_negative_only": half,
            "oracles_broken": broken,
        },
    }


def render(receipt):
    lines = ["CROSS-TIER ORACLE RECEIPT",
             "  verifies the graders, NOT the agent. 0 runs, $0 spent.",
             ""]
    for r in receipt["tiers"]:
        lines.append("  %-7s %-26s %s" % (r["tier"], r["task"],
                                          r.get("oracle_status", "unknown")))
        neg = r.get("negative_probe")
        if neg:
            lines.append("      empty workdir   -> rc=%s  %s"
                         % (neg["exit_code"], neg["message"]))
        pos = r.get("positive_probe", {})
        if pos.get("status") == "measured":
            lines.append("      correct artifact-> rc=%s  %s"
                         % (pos["exit_code"], pos["message"]))
        else:
            lines.append("      correct artifact-> NOT ATTEMPTED (%s)"
                         % "would be an answer key in the repo")
        adv = r.get("adversarial_probe", {})
        if adv.get("status") == "measured":
            lines.append("      near-miss       -> rc=%s  %s"
                         % (adv["exit_code"], adv["message"]))
        else:
            oob = _NON_REPRODUCIBLE_NOTE.get(r["task"])
            if oob:
                lines.append("      near-miss       -> NOT ATTEMPTED by this receipt.")
                lines.append("                         NON-REPRODUCIBLE NOTE (%s), NOT a receipt:"
                             % oob["date"])
                lines.append("                         a by-hand run observed positive exit=%s, "
                             "adversarial exit=%s"
                             % (oob["positive_exit"], oob["adversarial_exit"]))
                lines.append("                         (%s). The artifacts were temporary and are"
                             % oob["adversarial_shape"])
                lines.append("                         destroyed; no hash binds them, nothing can")
                lines.append("                         replay it. Treat this tier as UNVERIFIED.")
            else:
                lines.append("      near-miss       -> NOT ATTEMPTED "
                             "(no plausible-wrong fixture yet)")
    s = receipt["summary"]
    lines += [
        "",
        "  %d tier(s) probed: %d fully discriminating, %d negative-probe only."
        % (s["tiers_probed"], s["oracles_fully_discriminating"],
           s["oracles_negative_only"]),
        "",
        "  PLANNED EXPERIMENT, not measured here: completion quality,",
        "  intervention count/rate, wall time, cost, tokens, recovery,",
        "  maintainability, novelty, user value. Each is null with status",
        "  planned_experiment. None is reported as 0.",
        "",
        "  TIER AXIS is inferred from the filename prefix; the task JSON",
        "  records no tier field. Stamped as tier_source in the receipt.",
        "",
        "  PAID-BENCHMARK PRECONDITION: only a tier reading `discriminates`",
        "  has passed all THREE probes (rejects nothing, accepts a correct",
        "  artifact, rejects a plausible wrong one). A tier that is only",
        "  negative-probe verified may be measuring 'output existed' rather",
        "  than 'the task was done', and paying to run it buys a number whose",
        "  meaning is unestablished.",
    ]
    trivial = receipt.get("trivial_acceptance_tasks") or []
    if trivial:
        lines += [
            "",
            "  ACCEPTANCE COMMANDS THAT CANNOT FAIL (%d):" % len(trivial),
        ]
        for t in trivial:
            lines.append("    %-22s cmd=%r" % (t["task"], t["acceptance_cmd"]))
        lines += [
            "    runner.py:242 sets success from the acceptance exit code",
            "    ALONE. Observed live: demo-pass recorded success=True on 3",
            "    trials that each TIMED OUT at 60s with 0 iterations.",
        ]
    if s["oracles_broken"]:
        lines.append("")
        lines.append("  BROKEN ORACLES: %s" % ", ".join(s["oracles_broken"]))
    return "\n".join(lines)


def main(argv=None):
    p = _Parser(description="Verify each tier's held-out grader "
                            "discriminates. Runs no agent, spends nothing.")
    p.add_argument("--json", action="store_true", help="emit the receipt as JSON")
    p.add_argument("--out", help="also write the JSON receipt to this path")
    args = p.parse_args(argv)

    if not os.path.isdir(os.path.join(_ROOT, "benchmarks", "bench", "fixtures")):
        sys.stderr.write("tier-receipt: fixtures directory not found\n")
        return 66

    receipt = build_receipt()
    if not receipt["tiers"]:
        sys.stderr.write("tier-receipt: NOTHING TO CHECK -- no tiers\n")
        return 3
    if all(r.get("oracle_status") == "missing" for r in receipt["tiers"]):
        sys.stderr.write("tier-receipt: COULD NOT CHECK -- no graders found\n")
        return 2

    if args.json:
        sys.stdout.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write(render(receipt) + "\n")
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")

    # A grader that does not discriminate is a defect in the evidence chain,
    # not a neutral observation: every future result scored by it is unsound.
    return 1 if receipt["summary"]["oracles_broken"] else 0


if __name__ == "__main__":
    sys.exit(main())
