---
description: Run Loki's fast deterministic verifier on the current diff and print the compact summary.
argument-hint: "[base-ref] (default: HEAD, i.e. uncommitted changes)"
allowed-tools: Bash(loki verify:*), Bash(command -v:*)
---

Run the verifier on the working tree and report only the compact result.

1. `command -v loki`; if missing, say so and stop.
2. Run `loki verify --fast --diff-base ${ARGUMENTS:-HEAD}`. It makes no model
   call and no network call. Exit codes: 0 PASS, 1 FAIL, 3 INCONCLUSIVE.
3. Print the verdict line and each finding as `severity rule path:line`.
   Say which findings block (severity high). Never describe INCONCLUSIVE as
   a pass. For the deeper PR-style gates use `/loki-mode:loki-verify`.
