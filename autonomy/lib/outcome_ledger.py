#!/usr/bin/env python3
"""Outcome Ledger: did the change turn out to be RIGHT, not merely that it happened.

WHY THIS EXISTS. Every competing agent reports VOLUME. Measured against their own
published docs: Factory AI's analytics expose files_created, files_edited,
lines_modified, git_commits, git_prs_created, tokens and DAU -- and no defect
rate, no rework rate, no revert rate, no change-failure rate. Their telemetry doc
states outright that correlating usage with delivery outcomes is left to the
customer's own stack. Devin's security page concedes the agent "can still
experience hallucinations, introduce bugs into code" and points you at your own
code review and branch protection. So an engineering leader using either can
prove the agent was BUSY. Neither can show it was RIGHT.

This module answers the other question, from local git history alone: after the
receipt was written, did the change survive?

WHAT MAKES A SIGNAL DEFENSIBLE HERE. The temptation is to count "the file was
touched again" as rework. That is a misleading signal -- an unrelated feature
landing in the same file would inflate it, and a leader acting on that number
would be acting on noise. So each signal below is either a deterministic fact or
it reports UNKNOWN:

  reverted      FACT. `git revert` writes "This reverts commit <sha>" into the
                message. That is a machine-parseable link, not an inference.
  line_survival FACT. `git blame --porcelain` attributes every surviving line to
                the commit that introduced it. Counting lines still attributed to
                head_sha is a measurement, not an estimate.
  reworked      MEASURED, line-scoped. Only lines this change INTRODUCED and that
                a LATER commit replaced count as rework. A file touched elsewhere
                does not.
  UNKNOWN       Any case we cannot compute: absent head_sha, unreachable commit
                (never merged, shallow clone, pruned), or a file since deleted.
                Never reported as zero, never as a pass.

The last rule is the whole point. A change-failure rate that silently scores
unmeasurable cases as successes is the exact false-green this product exists to
refuse. `loki proof` already sets the house convention -- its help says
"version_is_ahead reads UNKNOWN when it cannot be computed" -- and this inherits it.

READ-ONLY. Never writes to the repo under analysis. Every number it prints comes
from a git command the reader can rerun by hand; --json emits those commands.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1.0"

# A status that is not a number. Kept as a module constant so a caller can never
# accidentally coerce it to 0 in a tally.
UNKNOWN = "UNKNOWN"

# git's empty-tree object. proof-generator falls back to it for a greenfield run,
# so a receipt carrying it has no real baseline to diff against.
EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# THE ANCHOR GATE, and the reason this module is not a metrics generator.
#
# `facts.git.head_sha` is `git rev-parse HEAD` AT RECEIPT-GENERATION TIME. When
# the agent's work is still uncommitted -- the normal case -- that is the run's
# STARTING commit, not the commit the change became. Measured on this repo's own
# 9 receipts:
#
#   8 of 9 carry base_sha="" and head_sha=1385e71c. That commit touches TWO files
#   (providers/codex.sh, tests/test-provider-degraded-mode.sh) while the receipts
#   attest to EIGHT including autonomy/telemetry.sh. They are not the same change.
#   The 9th carries base_sha=4b825dc6 (empty tree) and 4017 files.
#
# Following head_sha regardless would have attributed one commit's fate to eight
# unrelated runs and reported it as a change-failure rate. That is precisely the
# fabricated metric this product exists to refuse, and it would have been
# invisible in the output.
#
# File-overlap was tested as a fallback discriminator and REJECTED: the bad
# receipts overlap that commit by 2 files, so any overlap>0 rule marks all eight
# as anchored. Overlap is not evidence of identity.
#
# So: a receipt yields numbers only when sha algebra proves the range is the
# change. Everything else is UNKNOWN with a named reason.
ANCHOR_REASONS = {
    "no_git": "not a git repository",
    "head_sha_empty": "receipt records no head_sha",
    "base_sha_empty": "run baseline was not recorded at generation",
    "greenfield_no_baseline": "base_sha is the empty tree, so there is no baseline",
    "change_not_committed": "base_sha == head_sha, so the work was never committed",
    "sha_not_in_history": "a sha is not resolvable in this clone",
    "not_reachable_from_head": "head_sha is not an ancestor of HEAD (never merged)",
    "diff_range_mismatch": "the base..head diff does not match the receipt's file set",
}


def _git(args, cwd, timeout=30):
    """Run a git command read-only. Returns (rc, stdout). Never raises.

    Failure is data here, not an exception: an unreachable sha and a shallow
    clone both surface as a non-zero rc, and each caller turns that into an
    explicit UNKNOWN with a reason rather than a silent zero.
    """
    try:
        p = subprocess.run(
            ["git"] + list(args),
            cwd=cwd, capture_output=True, text=True, timeout=timeout,
        )
        return p.returncode, p.stdout
    except (subprocess.TimeoutExpired, OSError) as exc:
        return 1, f"__error__ {type(exc).__name__}: {exc}"


def _commit_exists(sha, cwd):
    """True only if the object is present AND is a commit."""
    if not sha:
        return False
    rc, _ = _git(["cat-file", "-e", f"{sha}^{{commit}}"], cwd)
    return rc == 0


def resolve_anchor(base_sha, head_sha, files, cwd):
    """Decide whether this receipt can be followed at all. Returns (state, reason).

    Cheap sha algebra, run BEFORE any metric. Only "anchored" produces numbers;
    every other outcome is UNKNOWN with a named reason from ANCHOR_REASONS. See
    the ANCHOR_REASONS comment for the measured evidence that makes this gate
    mandatory rather than defensive.
    """
    rc, _ = _git(["rev-parse", "--git-dir"], cwd)
    if rc != 0:
        return "unanchored", "no_git"
    if not head_sha:
        return "unanchored", "head_sha_empty"
    if not base_sha:
        return "unanchored", "base_sha_empty"
    if base_sha == EMPTY_TREE_SHA or base_sha.startswith(EMPTY_TREE_SHA[:12]):
        return "unanchored", "greenfield_no_baseline"
    if base_sha == head_sha:
        return "unanchored", "change_not_committed"
    if not _commit_exists(base_sha, cwd) or not _commit_exists(head_sha, cwd):
        return "unanchored", "sha_not_in_history"

    # Unreachable is NOT the same as reverted, and conflating them would invent
    # failures out of unmerged branches. merge-base separates the two.
    rc, _ = _git(["merge-base", "--is-ancestor", head_sha, "HEAD"], cwd)
    if rc != 0:
        return "unanchored", "not_reachable_from_head"

    # Final identity check: the range must actually produce the receipt's files.
    # This is what overlap-matching cannot do -- it demands the SET match, so a
    # coincidental 2-file overlap can never masquerade as the same change.
    rc, out = _git(["diff", "--name-only", f"{base_sha}..{head_sha}"], cwd)
    if rc != 0:
        return "unanchored", "sha_not_in_history"
    range_files = {l.strip() for l in out.splitlines() if l.strip()}
    receipt_files = {f.get("path") for f in files
                     if isinstance(f, dict) and f.get("path")}
    if receipt_files and range_files != receipt_files:
        return "unanchored", "diff_range_mismatch"

    return "anchored", None


def detect_revert(head_sha, cwd):
    """Was head_sha reverted? Returns (status, evidence).

    FACT, not inference. `git revert` writes the canonical trailer
    "This reverts commit <full-sha>." into the message body. We search for that
    exact trailer, so a commit that merely mentions the sha in prose -- a
    follow-up, a doc reference, a changelog entry -- does not count.
    """
    if not _commit_exists(head_sha, cwd):
        return UNKNOWN, "head_sha is not a reachable commit in this clone"

    # --fixed-strings so a sha can never be read as a regex; --all so a revert
    # on any branch counts, not only the current one.
    rc, out = _git(
        ["log", "--all", "--fixed-strings",
         f"--grep=This reverts commit {head_sha}",
         "--format=%H %s"],
        cwd,
    )
    if rc != 0:
        return UNKNOWN, "git log failed while searching for a revert trailer"
    hits = [l for l in out.splitlines() if l.strip()]
    if hits:
        return True, hits
    return False, []


def line_survival(head_sha, files, cwd):
    """How many lines introduced by head_sha still survive at HEAD.

    FACT via `git blame --porcelain`: every line in the current file carries the
    sha of the commit that last touched it. Lines still attributed to head_sha
    are lines this change introduced that nothing has since replaced.

    Returns a dict. Files that cannot be blamed (deleted, renamed away, binary)
    are counted in `unknown_files` rather than being scored as zero survival --
    a deleted file is not evidence that the work was wrong.
    """
    if not _commit_exists(head_sha, cwd):
        return {"status": UNKNOWN,
                "reason": "head_sha is not a reachable commit in this clone"}

    surviving = 0
    unknown_files = []
    checked = 0

    for f in files:
        path = f.get("path") if isinstance(f, dict) else f
        if not path:
            continue
        # A file removed after the fact cannot be blamed. That is UNKNOWN, not 0.
        if not os.path.exists(os.path.join(cwd, path)):
            unknown_files.append({"path": path, "reason": "not present at HEAD"})
            continue
        rc, out = _git(["blame", "--porcelain", "--", path], cwd, timeout=60)
        if rc != 0:
            unknown_files.append({"path": path, "reason": "blame failed"})
            continue
        checked += 1
        # In porcelain output a line beginning with a 40-hex sha starts a block;
        # the sha is the commit that introduced that line.
        for line in out.splitlines():
            parts = line.split(" ", 1)
            token = parts[0]
            if len(token) == 40 and all(c in "0123456789abcdef" for c in token):
                if token == head_sha:
                    surviving += 1

    return {
        "status": "measured" if checked else UNKNOWN,
        "reason": None if checked else "no file from this change could be blamed",
        "surviving_lines": surviving if checked else UNKNOWN,
        "files_checked": checked,
        "files_unknown": unknown_files,
    }


def detect_rework(head_sha, files, cwd, since_days=None):
    """Lines this change introduced that a LATER commit replaced.

    This is the signal most easily faked. "The file was touched again" is NOT
    rework -- an unrelated feature in the same file would inflate it, and a
    leader acting on that number would be acting on noise. So this is scoped to
    LINES: a later commit counts only where it replaced a line that head_sha
    introduced, which `git blame` establishes by attribution.

    Derived, deliberately, from the same blame data as line_survival: lines
    introduced minus lines still attributed. That keeps the two numbers
    arithmetically consistent instead of two estimates that can disagree.
    """
    if not _commit_exists(head_sha, cwd):
        return {"status": UNKNOWN,
                "reason": "head_sha is not a reachable commit in this clone"}

    introduced = 0
    for f in files:
        if isinstance(f, dict):
            ins = f.get("insertions")
            if isinstance(ins, int):
                introduced += ins

    if introduced == 0:
        return {"status": UNKNOWN,
                "reason": "receipt records no insertion counts to compare against"}

    surv = line_survival(head_sha, files, cwd)
    if surv.get("status") != "measured":
        return {"status": UNKNOWN, "reason": surv.get("reason") or "survival unmeasurable"}

    survived = surv["surviving_lines"]
    # Clamp: blame can attribute MORE lines than the receipt counted when a file
    # was reformatted, so a negative would be an artifact, not a measurement.
    replaced = max(0, introduced - survived)
    return {
        "status": "measured",
        "lines_introduced": introduced,
        "lines_surviving": survived,
        "lines_replaced": replaced,
        "rework_ratio": round(replaced / introduced, 4) if introduced else UNKNOWN,
    }


def outcome_for_receipt(proof_path, cwd):
    """Compute the full outcome record for one receipt."""
    try:
        with open(proof_path, "r", encoding="utf-8") as fh:
            proof = json.load(fh)
    except (OSError, ValueError) as exc:
        return {"status": UNKNOWN, "reason": f"receipt unreadable: {exc}",
                "proof_path": proof_path}

    run_id = proof.get("run_id") or os.path.basename(os.path.dirname(proof_path))
    git_facts = (proof.get("facts") or {}).get("git") or {}
    head_sha = git_facts.get("head_sha")
    base_sha = git_facts.get("base_sha")
    files = ((git_facts.get("diff") or {}).get("files")) or []

    rec = {
        "run_id": run_id,
        "generated_at": proof.get("generated_at"),
        "headline": (proof.get("verification") or {}).get("headline")
                    or proof.get("headline"),
        "base_sha": base_sha,
        "head_sha": head_sha,
        "files_changed": len(files),
    }

    # THE GATE. No metric runs unless sha algebra proves base..head IS this
    # change. Without it, 8 of this repo's 9 receipts would have been scored
    # against an unrelated 2-file commit and reported as a change-failure rate.
    state, reason = resolve_anchor(base_sha, head_sha, files, cwd)
    rec["anchor"] = {"state": state, "reason": reason}
    if state != "anchored":
        rec["outcome"] = UNKNOWN
        rec["reason"] = ANCHOR_REASONS.get(reason, reason or "not anchored")
        rec["commands"] = [
            f"git merge-base --is-ancestor {head_sha or '<head_sha>'} HEAD",
            f"git diff --name-only {base_sha or '<base_sha>'}..{head_sha or '<head_sha>'}",
        ]
        return rec

    reverted, revert_evidence = detect_revert(head_sha, cwd)
    rec["reverted"] = reverted
    if revert_evidence:
        rec["revert_evidence"] = revert_evidence
    rec["survival"] = line_survival(head_sha, files, cwd)
    rec["rework"] = detect_rework(head_sha, files, cwd)

    # The verdict is deliberately coarse and refuses to guess.
    if reverted is True:
        rec["outcome"] = "REVERTED"
    elif reverted is UNKNOWN:
        rec["outcome"] = UNKNOWN
        rec["reason"] = "could not determine whether the change was reverted"
    elif rec["rework"].get("status") == "measured":
        rec["outcome"] = "SURVIVED"
    else:
        rec["outcome"] = UNKNOWN
        rec["reason"] = rec["rework"].get("reason") or "outcome unmeasurable"
    return rec


def collect(loki_dir, cwd, run_id=None):
    """Compute outcomes for every receipt under <loki_dir>/proofs."""
    proofs_dir = os.path.join(loki_dir, "proofs")
    records = []
    if not os.path.isdir(proofs_dir):
        return records, "no .loki/proofs directory in this project"

    for entry in sorted(os.listdir(proofs_dir)):
        if run_id and entry != run_id:
            continue
        p = os.path.join(proofs_dir, entry, "proof.json")
        if os.path.isfile(p):
            records.append(outcome_for_receipt(p, cwd))
    if not records:
        return records, "no receipts found (run a build first, then re-run this)"
    return records, None


def summarize(records):
    """Aggregate. UNKNOWN is carried, never folded into a pass.

    change_failure_rate is computed over MEASURED receipts only, and the count of
    unmeasured ones is reported alongside it. A rate that quietly treated
    unmeasurable changes as successes would be precisely the false-green this
    tool exists to refuse -- so if nothing is measurable the rate is UNKNOWN, not
    0.0, no matter how good that would look.
    """
    total = len(records)
    measured = [r for r in records if r.get("outcome") in ("SURVIVED", "REVERTED")]
    reverted = [r for r in measured if r.get("outcome") == "REVERTED"]
    unknown = [r for r in records if r.get("outcome") == UNKNOWN]

    # Why receipts could not be measured is the most useful thing this tool
    # prints when nothing is anchored. Without the distribution the report reads
    # as "no data" instead of "your receipts are not recording a landed sha",
    # which is an actionable defect.
    reasons = {}
    for r in records:
        a = r.get("anchor") or {}
        if a.get("state") and a["state"] != "anchored":
            key = a.get("reason") or "unknown"
            reasons[key] = reasons.get(key, 0) + 1

    summary = {
        "receipts_total": total,
        "receipts_measured": len(measured),
        "receipts_unknown": len(unknown),
        "reverted": len(reverted),
        "unanchored_reasons": reasons,
    }
    if measured:
        summary["change_failure_rate"] = round(len(reverted) / len(measured), 4)
    else:
        summary["change_failure_rate"] = UNKNOWN
        summary["change_failure_rate_reason"] = (
            "no receipt could be measured, so a rate would be fabricated")

    ratios = [r["rework"]["rework_ratio"] for r in records
              if isinstance(r.get("rework"), dict)
              and r["rework"].get("status") == "measured"
              and isinstance(r["rework"].get("rework_ratio"), (int, float))]
    if ratios:
        summary["rework_ratio_avg"] = round(sum(ratios) / len(ratios), 4)
    else:
        summary["rework_ratio_avg"] = UNKNOWN
    return summary


def render_text(records, summary, note=None):
    out = []
    out.append("Outcome Ledger -- what happened to the work AFTER the receipt")
    out.append("")
    if note:
        out.append(f"  {note}")
        out.append("")
        return "\n".join(out)

    for r in records:
        line = f"  {r.get('run_id', '?')[:34]:36}"
        oc = r.get("outcome", UNKNOWN)
        line += f"{oc:10}"
        rw = r.get("rework")
        if isinstance(rw, dict) and rw.get("status") == "measured":
            line += (f"  lines {rw['lines_surviving']}/{rw['lines_introduced']} survive"
                     f"  rework {rw['rework_ratio']}")
        elif oc == UNKNOWN and r.get("reason"):
            line += f"  ({r['reason']})"
        out.append(line)

    out.append("")
    out.append(f"  ANCHORED {summary['receipts_measured']} of "
               f"{summary['receipts_total']} receipts.")
    reasons = summary.get("unanchored_reasons") or {}
    if reasons:
        out.append("")
        out.append("  Why not anchored (a receipt must prove base..head IS the change):")
        for k, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
            out.append(f"    {k:24} {n:3}   {ANCHOR_REASONS.get(k, '')}")
    out.append("")
    cfr = summary.get("change_failure_rate")
    if cfr == UNKNOWN:
        out.append(f"  change-failure rate: UNKNOWN"
                   f" ({summary.get('change_failure_rate_reason', '')})")
    else:
        out.append(f"  change-failure rate: {cfr}"
                   f"  (over {summary['receipts_measured']} measured receipts)")
    out.append(f"  average rework ratio: {summary.get('rework_ratio_avg')}")
    out.append("")
    out.append("  Every number above is derivable from git. Check any of them:")
    out.append("    git log --all --fixed-strings --grep='This reverts commit <head_sha>'")
    out.append("    git blame --porcelain -- <path>")
    return "\n".join(out)


def main(argv):
    as_json = "--json" in argv
    run_id = None
    if "--run-id" in argv:
        i = argv.index("--run-id")
        if i + 1 < len(argv):
            run_id = argv[i + 1]

    cwd = os.environ.get("LOKI_OUTCOMES_CWD") or os.getcwd()
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(cwd, ".loki")

    records, note = collect(loki_dir, cwd, run_id=run_id)
    summary = summarize(records)

    if as_json:
        print(json.dumps({
            "schema_version": SCHEMA_VERSION,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "note": note,
            "summary": summary,
            "receipts": records,
            "how_to_verify": [
                "git log --all --fixed-strings --grep='This reverts commit <head_sha>'",
                "git blame --porcelain -- <path>",
            ],
        }, indent=2))
    else:
        print(render_text(records, summary, note=note))

    # Exit 3 when there is nothing to measure, mirroring `loki proof releases`:
    # an empty result is a real answer, distinct from a failure.
    if note:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
