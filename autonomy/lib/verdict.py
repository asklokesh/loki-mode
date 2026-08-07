#!/usr/bin/env python3
"""One verdict a reviewer can read in ten seconds, assembled from measured parts.

WHY THIS EXISTS. We now measure five things nobody else does -- did the work
survive (outcome ledger), does the spec still match the intent (intent ledger),
was this the agent's own output or a human rescue (pre-edit snapshot), does the
completion claim name real work (claim grounding), and which model decided
(decision record). Each is correct and each lives in its own file. A reviewer
looking at a pull request reads none of them.

A moat nobody sees is not a moat. The Evidence Receipt is already attached to
PRs by default (LOKI_PROVEN_PR, autonomy/run.sh:3849), so the surface exists and
this fills it: one block, five lines, each of which is either a measured fact or
an explicit UNKNOWN.

WHAT IT REFUSES, AND WHY THAT MATTERS MORE HERE THAN ANYWHERE. This is the only
place where all five signals meet, which makes it the one place a composite score
would be tempting: a single "trust: 87" would fit a PR comment beautifully. It is
not offered. Averaging a revert count, a hash comparison, a diff hash, a path
match and a model id produces a number whose movement nobody can explain, and a
number nobody can explain is the thing our competitors already ship. Five honest
lines beat one confident one.

UNKNOWN IS PRINTED, NOT HIDDEN. A reviewer must be able to tell "we checked and
it is fine" from "we could not check". Suppressing the unmeasured lines would
make a receipt with one real signal look identical to one with five, which is
exactly the false confidence the whole product exists to refuse.
"""

from __future__ import annotations

import json
import os
import sys

SCHEMA_VERSION = "1.0"

UNKNOWN = "UNKNOWN"

# Each signal: where it lives, and the one-line question it answers for a human
# scanning a PR. The question text is load-bearing -- a reviewer who cannot tell
# what a line MEANS will skip the block, and a skipped block is worth nothing.
SIGNALS = (
    ("outcome", "did previous work survive, or get reverted"),
    ("intent", "does the spec still say what was actually wanted"),
    ("authorship", "is this the agent's output, or a human rescue"),
    ("grounding", "does the completion claim name work that exists in the diff"),
    ("model", "which model decided, at what temperature"),
)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _outcome_line(loki_dir):
    p = os.path.join(loki_dir, "proofs")
    if not os.path.isdir(p):
        return UNKNOWN, "no receipts yet, so nothing has an outcome to follow"
    # Deliberately does not recompute: the outcome ledger owns that logic and two
    # implementations of one number eventually disagree.
    return UNKNOWN, "run `loki outcomes` for the measured post-merge result"


def _intent_line(loki_dir):
    p = os.path.join(loki_dir, "intent", "intent.json")
    if not os.path.isfile(p):
        return UNKNOWN, "no intent recorded, so spec-vs-intent drift is not measurable"
    doc = _read_json(p)
    if doc is None:
        return UNKNOWN, "the intent record could not be read"
    stmts = doc.get("statements") or []
    if not stmts:
        return UNKNOWN, "no intent statements recorded"
    linked = sum(1 for s in stmts if s.get("links"))
    return "measured", f"{len(stmts)} intent statement(s), {linked} linked to the spec"


def _authorship_line(loki_dir, run_id=None):
    d = os.path.join(loki_dir, "preedit")
    if not os.path.isdir(d):
        return UNKNOWN, "no pre-edit snapshot, so agent output cannot be told from human edits"
    snaps = [f for f in os.listdir(d) if f.endswith(".json")]
    if not snaps:
        return UNKNOWN, "no pre-edit snapshot captured"
    return "measured", f"{len(snaps)} run(s) have an immutable pre-edit snapshot"


def _grounding_line(loki_dir):
    # The completion route now persists the per-claim result here
    # (run.sh:_loki_check_claim_grounding, written at the non-destructive claim
    # peek). Absent file means the run never reached a completion claim, which
    # is UNKNOWN -- not a pass, and not a failure.
    d = _read_json(os.path.join(loki_dir, "state", "claim-grounding.json"))
    if not isinstance(d, dict) or d.get("status") != "measured":
        return UNKNOWN, "no completion claim was checked against the diff"
    named = d.get("paths_named") or []
    if not named:
        # Reported by name rather than scored: a claim naming no path is
        # UNGROUNDABLE, which is a different fact from a claim that checked out.
        return UNKNOWN, "the completion claim named no file path, so it cannot be grounded"
    ungrounded = d.get("ungrounded") or []
    if d.get("has_ungrounded_claim"):
        return "finding", (
            f"the completion claim names {len(ungrounded)} path(s) absent from the diff: "
            + ", ".join(str(p) for p in ungrounded[:3])
        )
    return "measured", f"all {len(named)} path(s) named in the completion claim are in the diff"


def _model_line(loki_dir):
    p = os.path.join(loki_dir, "decisions", "decisions.jsonl")
    if not os.path.isfile(p):
        return UNKNOWN, "no decision records, so a model swap would be undetectable"
    models = set()
    n = 0
    try:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                n += 1
                if r.get("model_id"):
                    models.add(r["model_id"])
    except OSError:
        return UNKNOWN, "the decision record could not be read"
    if not n:
        return UNKNOWN, "no decision records"
    if len(models) > 1:
        # The single most audit-relevant thing this block can say.
        return "measured", f"{n} decisions across {len(models)} DIFFERENT models: {', '.join(sorted(models))}"
    return "measured", f"{n} decisions, one model: {', '.join(models) or 'unnamed'}"


def build(loki_dir, run_id=None):
    rows = []
    for key, question in SIGNALS:
        if key == "outcome":
            status, detail = _outcome_line(loki_dir)
        elif key == "intent":
            status, detail = _intent_line(loki_dir)
        elif key == "authorship":
            status, detail = _authorship_line(loki_dir, run_id)
        elif key == "grounding":
            status, detail = _grounding_line(loki_dir)
        else:
            status, detail = _model_line(loki_dir)
        rows.append({"signal": key, "question": question,
                     "status": status, "detail": detail})

    measured = sum(1 for r in rows if r["status"] == "measured")
    return {
        "schema_version": SCHEMA_VERSION,
        "signals": rows,
        "measured": measured,
        "total": len(rows),
        # No composite. See the module docstring: averaging a revert count, a
        # hash comparison and a model id yields a number nobody can explain.
    }


def render_markdown(v):
    """A PR comment block. Terse on purpose: a reviewer gives this ten seconds."""
    out = ["### Loki verification signals", ""]
    out.append(f"{v['measured']} of {v['total']} signals measured. "
               "UNKNOWN means we could not check, not that it passed.")
    out.append("")
    out.append("| Signal | Status | Detail |")
    out.append("|---|---|---|")
    for r in v["signals"]:
        # Three states, not two. Collapsing everything non-measured to UNKNOWN
        # would render a real finding ("the claim names a file absent from the
        # diff") identically to "we could not check" -- the false equivalence
        # this whole module exists to refuse. Anything unrecognised still
        # degrades to UNKNOWN, so an unmeasured signal can never read as a pass.
        status = r["status"] if r["status"] in ("measured", "finding") else UNKNOWN
        out.append(f"| {r['signal']} | {status} | {r['detail']} |")
    out.append("")
    out.append("Every line is derived from a file in `.loki/` that you can read "
               "yourself. No score is offered: five honest lines beat one "
               "confident number.")
    return "\n".join(out)


def main(argv):
    as_json = "--json" in argv
    cwd = os.environ.get("LOKI_VERDICT_CWD") or os.getcwd()
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(cwd, ".loki")
    v = build(loki_dir)
    print(json.dumps(v, indent=2) if as_json else render_markdown(v))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
