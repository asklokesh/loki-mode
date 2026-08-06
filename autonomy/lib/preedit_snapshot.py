#!/usr/bin/env python3
"""Pre-edit snapshot: score the AGENT, not the agent-plus-whoever-fixed-it.

WHY THIS EXISTS. 8090 AI's medical-document evaluation framework -- the single
most rigorous engineering artifact in any competitor corpus -- makes an argument
we could not answer:

    "A skilled writer rescues an unusable draft, and the post-edit score looks
     acceptable; a junior writer leaves the model's failures visible, and the
     same model appears to perform worse. In either case, the metric describes
     the writer-plus-AI workflow, not the AI alone."

Every quality number we publish today is measured AFTER a human may have touched
the diff. So a strong reviewer flatters the agent and a weak one maligns it, and
the number moves for reasons that have nothing to do with the agent. That makes
our own headline partly a measurement of our users.

The fix is not analysis, it is ORDER OF OPERATIONS. 8090's own words: the two
scores must be "separated by the workflow itself, not reconstructed afterward
from logs". So this captures an immutable snapshot of the agent's output at the
moment it stops and before any human edit. Anything reconstructed later is a
guess about which lines a human wrote, and a guess is exactly what this replaces.

WHAT IT DELIBERATELY IS NOT. It does not score anything. It records WHAT WAS
THERE, with a hash, so a later comparison is a fact rather than an inference. A
low pre-edit score is a DIAGNOSTIC, not a failure -- 8090 again: "A preedit
composite of twenty percent is not a failure of the eval. It is a diagnostic,
document-by-document, of where the model is weak." Nothing here feeds a gate,
because a gate that punished the agent for needing edits would train the agent to
produce diffs nobody edits, which is not the same as good diffs.

WHAT ALREADY EXISTS AND IS NOT REBUILT. `_compute_headline` in
proof-generator.py already implements the asymmetric-risk half of this idea, in
its own words: "A failed check is a stronger negative signal than a not-run one:
amber means we did not check everything, red means something we checked did not
pass." That is F2-style weighting -- treating a false negative as worse than a
false positive -- already shipped. This module adds only the missing half.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1.0"

UNKNOWN = "UNKNOWN"

# Named refusals, mirroring the outcome ledger's ANCHOR_REASONS. A comparison we
# cannot compute is reported BY NAME, never as zero and never as a pass.
COMPARE_REASONS = {
    "no_snapshot": "no pre-edit snapshot was captured for this run",
    "snapshot_unreadable": "the snapshot exists but could not be parsed",
    "not_a_git_repo": "not a git repository, so the current diff cannot be read",
    "no_current_diff": "there is no current diff to compare the snapshot against",
}


def _git(args, cwd, timeout=60):
    try:
        p = subprocess.run(["git"] + list(args), cwd=cwd,
                           capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout
    except (subprocess.TimeoutExpired, OSError):
        return 1, ""


def _sha256(text):
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def capture(loki_dir, run_id, cwd, base_sha=None):
    """Freeze the agent's output before any human edit.

    Stores the full unified diff plus its sha256. The hash is what makes a later
    comparison evidence rather than an assertion: anyone can recompute it.

    Called by the workflow at the moment the agent stops. Capturing it later --
    after a review, from a log -- would record the human's work as the agent's,
    which is the exact contamination this exists to prevent.
    """
    rc, _ = _git(["rev-parse", "--git-dir"], cwd)
    if rc != 0:
        return {"status": UNKNOWN, "reason": "not_a_git_repo"}

    if base_sha:
        rc, diff = _git(["diff", base_sha, "--"], cwd)
    else:
        # Uncommitted agent work is the normal case at stop time.
        rc, diff = _git(["diff", "HEAD", "--"], cwd)
    if rc != 0:
        return {"status": UNKNOWN, "reason": "no_current_diff"}

    rc2, names = _git(["diff", "--name-only"] + ([base_sha] if base_sha else ["HEAD"]), cwd)
    files = [l.strip() for l in names.splitlines() if l.strip()] if rc2 == 0 else []

    snap = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "base_sha": base_sha or "",
        # The point of the whole file: this is the agent's output, uncontaminated.
        "author": "agent",
        "diff_sha256": _sha256(diff),
        "diff_bytes": len(diff.encode("utf-8", "replace")),
        "files": files,
        "lines_added": sum(1 for l in diff.splitlines()
                           if l.startswith("+") and not l.startswith("+++")),
        "lines_removed": sum(1 for l in diff.splitlines()
                             if l.startswith("-") and not l.startswith("---")),
    }

    out_dir = os.path.join(loki_dir, "preedit")
    try:
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, f"{run_id}.json")
        # Write-once. A snapshot that a later run can overwrite is not a
        # snapshot -- re-capturing after a human edit would silently record the
        # human's work as the agent's, which is the contamination this prevents.
        if os.path.exists(path):
            return {"status": "exists", "path": path}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(snap, fh, indent=2)
            fh.write("\n")
        # The raw diff is kept beside the metadata so the hash is checkable by
        # hand. Evidence nobody can recompute is a claim, not evidence.
        with open(os.path.join(out_dir, f"{run_id}.diff"), "w", encoding="utf-8") as fh:
            fh.write(diff)
    except OSError as exc:
        return {"status": UNKNOWN, "reason": "snapshot_unreadable", "detail": str(exc)}

    return {"status": "captured", "path": path, "diff_sha256": snap["diff_sha256"]}


def compare(loki_dir, run_id, cwd):
    """How much of what shipped was the agent's, and how much was human rescue.

    Reports lines, never a score. The split is the useful fact; a composite
    number invites exactly the ranking behaviour that made post-edit scores
    misleading in the first place.
    """
    path = os.path.join(loki_dir, "preedit", f"{run_id}.json")
    if not os.path.isfile(path):
        return {"status": UNKNOWN, "reason": "no_snapshot",
                "detail": COMPARE_REASONS["no_snapshot"]}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            snap = json.load(fh)
    except (OSError, ValueError):
        return {"status": UNKNOWN, "reason": "snapshot_unreadable",
                "detail": COMPARE_REASONS["snapshot_unreadable"]}

    base = snap.get("base_sha") or "HEAD"
    rc, diff_now = _git(["diff", base, "--"], cwd)
    if rc != 0:
        return {"status": UNKNOWN, "reason": "no_current_diff",
                "detail": COMPARE_REASONS["no_current_diff"]}

    now_hash = _sha256(diff_now)
    added_now = sum(1 for l in diff_now.splitlines()
                    if l.startswith("+") and not l.startswith("+++"))

    untouched = now_hash == snap.get("diff_sha256")
    return {
        "status": "measured",
        "run_id": run_id,
        "agent_lines_added": snap.get("lines_added"),
        "current_lines_added": added_now,
        # A hash match is proof nobody edited it; a mismatch proves somebody did,
        # but NOT how much -- attributing individual lines would be the guess
        # this module exists to avoid.
        "human_edited": (not untouched),
        "preedit_diff_sha256": snap.get("diff_sha256"),
        "current_diff_sha256": now_hash,
        "captured_at": snap.get("captured_at"),
        "note": ("the pre-edit diff is byte-identical to what shipped, so this "
                 "receipt measures the agent alone"
                 if untouched else
                 "what shipped differs from the agent's output, so any score "
                 "taken now measures the agent plus the human who edited it"),
    }


def main(argv):
    if not argv:
        print("usage: preedit_snapshot.py capture|compare <run_id> [--json]",
              file=sys.stderr)
        return 2
    action = argv[0]
    run_id = argv[1] if len(argv) > 1 else ""
    if not run_id:
        print("a run_id is required", file=sys.stderr)
        return 2

    cwd = os.environ.get("LOKI_PREEDIT_CWD") or os.getcwd()
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(cwd, ".loki")

    if action == "capture":
        res = capture(loki_dir, run_id, cwd,
                      base_sha=os.environ.get("LOKI_RUN_START_SHA") or None)
    elif action == "compare":
        res = compare(loki_dir, run_id, cwd)
    else:
        print(f"unknown action: {action}", file=sys.stderr)
        return 2

    print(json.dumps(res, indent=2))
    return 0 if res.get("status") in ("captured", "exists", "measured") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
