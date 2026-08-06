#!/usr/bin/env python3
"""Claim grounding: a completion claim must name work that exists in the diff.

WHY THIS EXISTS. 8090 AI's evaluation framework blocks ungrounded output AT
GENERATION rather than catching it at review, and states the payoff plainly:

    "Ungrounded claims are blocked at generation. The rubric measures the quality
     of what survives the architectural filter, which is a much smaller and more
     interesting space."

Our evidence gate already has six axes -- diff non-empty, tests green, runtime
boot, no-mock, authorization, secret leak. Every one is a REPO-LEVEL fact. None
reads what the agent actually CLAIMED. So an agent can finish by asserting "added
retry logic to the payment client and covered it with tests" while the diff shows
a README edit, and every axis passes: the diff is non-empty, the tests are green,
the app boots. The claim itself is the one artifact nobody checks.

WHAT THIS CHECKS, AND WHAT IT REFUSES TO CHECK. It resolves file-path-shaped
tokens in the claim against the actual changed-file set. That is a deterministic
string-to-set comparison, and it is the only part of a natural-language claim
that can be checked without a model.

It does NOT judge whether the claim is semantically true. "Added retry logic" vs
"added a retry constant" is a judgement, and asking an LLM to grade it would be
the same LLM-judge-as-measurement this codebase refuses everywhere else. A claim
naming no paths is UNGROUNDABLE, reported by name -- never scored, never failed.

THE FAIL-OPEN DIRECTION IS DELIBERATE. Only a claim that names a path which is
demonstrably NOT in the diff is a finding. A claim with no paths, a claim naming
a path that exists but was not touched by this run, and an empty claim are all
reported and none of them blocks. A grounding check that blocked on ambiguity
would fire constantly on ordinary prose and be disabled within a week, which is
worse than not having it.
"""

from __future__ import annotations

import json
import os
import re
import sys

SCHEMA_VERSION = "1.0"

UNKNOWN = "UNKNOWN"

GROUNDING_REASONS = {
    "no_claim": "no completion claim text was provided",
    "no_diff": "no changed-file set was provided to check against",
    "ungroundable": "the claim names no file paths, so it cannot be checked mechanically",
}

# A path-shaped token: at least one slash or a known source extension, and no
# spaces. Deliberately conservative -- a false "this is a path" produces a false
# finding, and a check that cries wolf gets turned off.
_PATH_RE = re.compile(
    r"(?<![\w/.-])"
    r"(?:[\w.-]+/)+[\w.-]+\.[A-Za-z0-9]{1,6}"
    r"|(?<![\w/.-])[\w.-]+\.(?:py|ts|tsx|js|jsx|sh|go|rs|rb|java|c|h|cpp|md|json|ya?ml|toml)"
    r"(?![\w/.-])"
)


def extract_paths(claim):
    """Path-shaped tokens in a claim, deduped, order preserved."""
    if not claim:
        return []
    seen, out = set(), []
    for m in _PATH_RE.finditer(claim):
        tok = m.group(0).strip(".,;:)(\"'`")
        if tok and tok not in seen:
            seen.add(tok)
            out.append(tok)
    return out


def check(claim, changed_files):
    """Are the paths a claim names present in the diff?

    Matching is suffix-based on purpose: an agent writes `run.sh` or
    `autonomy/run.sh` for the same file, and demanding an exact repo-relative
    string would make every informal mention a false finding.
    """
    if not claim or not claim.strip():
        return {"status": UNKNOWN, "reason": "no_claim",
                "detail": GROUNDING_REASONS["no_claim"]}
    if changed_files is None:
        return {"status": UNKNOWN, "reason": "no_diff",
                "detail": GROUNDING_REASONS["no_diff"]}

    named = extract_paths(claim)
    if not named:
        # The common, benign case: "fixed the login bug". Nothing to check, and
        # that is not a defect -- reported so the number of unverifiable claims
        # is visible, rather than silently counted as grounded.
        return {"status": UNKNOWN, "reason": "ungroundable",
                "detail": GROUNDING_REASONS["ungroundable"],
                "paths_named": []}

    changed = list(changed_files)
    grounded, ungrounded = [], []
    for p in named:
        norm = p.lstrip("./")
        # Basename fallback is load-bearing, not laxity. An agent writes `run.sh`
        # for `autonomy/run.sh`, and requiring the full repo-relative string made
        # every informal mention a false finding -- measured: "patched run.sh"
        # against a changed autonomy/run.sh was reported UNGROUNDED. A grounding
        # check that flags correct claims is worse than none, because it gets
        # disabled and takes the real detections with it.
        base = os.path.basename(norm)
        hit = any(
            c == norm
            or c.endswith("/" + norm)
            or norm.endswith("/" + c)
            or os.path.basename(c) == base
            for c in changed
        )
        (grounded if hit else ungrounded).append(p)

    return {
        "status": "measured",
        "paths_named": named,
        "grounded": grounded,
        "ungrounded": ungrounded,
        # The single actionable signal. A claim that names a file the run never
        # touched is the "agent says done, diff says otherwise" failure, caught
        # from the claim side instead of the repo side.
        "has_ungrounded_claim": bool(ungrounded),
    }


def main(argv):
    claim = ""
    files_arg = ""
    files_from = ""
    i = 0
    while i < len(argv):
        if argv[i] == "--claim" and i + 1 < len(argv):
            claim = argv[i + 1]; i += 2; continue
        if argv[i] == "--files" and i + 1 < len(argv):
            files_arg = argv[i + 1]; i += 2; continue
        if argv[i] == "--files-from" and i + 1 < len(argv):
            files_from = argv[i + 1]; i += 2; continue
        i += 1

    # --files is ALWAYS a comma-separated list; --files-from is always a file to
    # read. The first version overloaded one flag for both and picked with
    # os.path.isfile(), which silently misread `--files autonomy/run.sh` -- a
    # perfectly ordinary changed-file list -- as "open that file and treat its
    # 20,000 lines as filenames". The result was a correct claim reported
    # UNGROUNDED, i.e. the exact false positive this check must never produce.
    # An ambiguous flag whose meaning depends on the filesystem is a bug, not a
    # convenience.
    if files_from and os.path.isfile(files_from):
        with open(files_from, "r", encoding="utf-8") as fh:
            changed = [l.strip() for l in fh if l.strip()]
    elif files_arg:
        changed = [c.strip() for c in files_arg.split(",") if c.strip()]
    else:
        changed = None

    res = check(claim, changed)
    res["schema_version"] = SCHEMA_VERSION
    print(json.dumps(res, indent=2))
    # Exit 1 ONLY on a demonstrably ungrounded path. Every UNKNOWN exits 0: a
    # check that failed on ambiguity would fire on ordinary prose and be disabled.
    return 1 if res.get("has_ungrounded_claim") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
