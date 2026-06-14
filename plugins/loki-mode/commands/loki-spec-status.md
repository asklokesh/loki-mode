---
description: Check whether the spec has drifted from its lock using Loki's living-spec drift detection, and summarize the report.
argument-hint: "[spec-path] (default: prd.md / .loki/generated-prd.md)"
allowed-tools: Bash(loki spec:*), Read
---

Check whether the spec is still true: the spec is the contract; Loki keeps it
true. This runs deterministic drift detection (no LLM cost) comparing the
current spec against its lock.

Steps:

1. If there is no lock yet, the status command will say so. In that case, offer
   to create one:

   ```
   loki spec lock $ARGUMENTS
   ```

   The lock (`.loki/spec/spec.lock`) is a deterministic map of spec
   requirements (checklist items and headings) to content hashes, plus repo
   HEAD at lock time.

2. Run the drift check:

   ```
   loki spec status $ARGUMENTS
   ```

   Exit 0 means in sync (SPEC-TRUE); exit 1 means drift detected
   (SPEC-DRIFTED). It writes `.loki/spec/drift-report.json`.

3. Read `.loki/spec/drift-report.json` and summarize for the user:
   - The verdict: SPEC-TRUE or SPEC-DRIFTED.
   - Counts of ADDED, REMOVED, and CHANGED requirements, then list each one.
   - Whether code changed since the locked HEAD (files, insertions, deletions).

4. If drifted, explain the choice clearly:
   - If the code is the source of truth and the spec should follow, the human
     updates the spec, then runs `loki spec sync $ARGUMENTS` to re-lock.
   - If the spec is correct and the code lags, the change set is incomplete.

   This MVP never auto-rewrites the spec. Re-locking via `loki spec sync` is an
   explicit human action after review. Do not run `sync` automatically; ask
   first.

Report only what the drift report shows. Do not infer requirements that are not
in the spec.
