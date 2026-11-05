# loki merge

Serial PR merge queue (requires the `gh` CLI, authenticated).

    loki merge add 101 102 103   # queue PRs (stored in .loki/merge-queue)
    loki merge run --dry-run     # list what would happen, change nothing
    loki merge run               # merge one at a time

Rules: a PR merges (squash) only when `gh pr checks` exits 0. Pending checks are
polled (LOKI_MERGE_POLL_S, default 20s; LOKI_MERGE_MAX_POLLS, default 90). After
each merge the next PR is rebased onto the new base and must pass checks again.
PRs that are red, time out, or fail to rebase stay in the queue; the command
exits nonzero. Nothing is force-pushed and no check is bypassed.

    loki merge pr <pr|branch> [--require-verified] [--delete-branch]

One PR through the same gate. It is refused (PR left open) when it is a draft,
when `gh pr checks` is not green after polling, or, with --require-verified,
when the run is not VERIFIED for the PR's head commit. The refusal names the gate.
--require-verified accepts either a legacy proof in `.loki/proofs` whose head
commit is the PR head, or a Loki 10 receipt in `.loki/runs` whose `head_sha` is the
PR head and which `loki verify <run-id>` reports VERIFIED (a run outcome that is
not VERIFIED, or a receipt that does not verify, refuses with `gate: verdict`; no
receipt for that head refuses with `gate: head`). It reads local runs, so run it on
the machine that ran `loki start`. The merge passes `--match-head-commit`, so a
push after the gate cannot land unjudged.

    loki merge watch <pr|branch> [--require-verified] [--delete-branch]

CI repair loop. Waits for checks; when they are red it passes the failed-run log
tail to a bounded repair session on the PR branch (LOKI_PR_REPAIR_CMD, default a
`loki start` of a generated brief; it gets the evidence file path as its last
argument), pushes, and re-checks, up to LOKI_PR_REPAIR_MAX attempts (default 2).
Green goes through the same merge gate as `loki merge pr`. When attempts run out
the PR is returned to draft, nothing merges, and the last failure log is printed.
`loki start --ship --engine legacy` calls this after it opens the PR; `/merge watch <pr>` runs it
from `loki chat`.

## Review queue

    loki review queue [--repo owner/repo] [--pubkey FILE] [--limit N] [--json] [--mark]

One list of every open Loki PR (head branch `loki/*`), ranked by risk. Read-only
unless `--mark` is given. It needs the Bun runtime and an authenticated `gh`.

A PR is READY only when all of these hold:

- it is not a draft;
- `gh pr checks` is green (no checks reported counts as not green);
- the risk tier is low. The tier is recomputed from the PR's live diff with the
  same classifier the run used (`classifyRisk`); `LOKI_RISK_TIER` is ignored, so
  nothing can lower it. This is not the `loki review --risk` score, which stays a
  separate advisory view. Critical-path rules (CODEOWNERS, `.loki/config.json`)
  are read at the PR's base commit when it is in the local clone, else from the
  working tree;
- its proof passport (see `docs/PROOF-PASSPORT.md`) verifies against `--pubkey FILE`
  or, without it, the local receipt key, and names the PR's exact head commit.
  A teammate without the author's key sees every PR as unchecked until they pass
  the author's public key (`loki keys export`).

Every other PR is listed as `NEEDS REVIEW` with each reason in plain words. Order:
READY rows first (fewest changed lines first), then needs-review rows by tier
(high, medium, low), then by lines changed. A READY row prints a short summary: the
changed files, the proof card (cost, time, checks run outside the model, fail-to-pass
line, receipt hash), what is not proven, the risk line, and the next step
`gh pr review N --approve && loki merge pr N --require-verified`.

`--json` prints one object per PR: number, url, title, head, branch, ready, rank,
reasons, risk, passport (status, outcome, receipt_sha256, kid), checks, lines, files.
`--mark` creates the `loki-ready` label, adds it to READY PRs and removes it from Loki
PRs that carry it but are not READY; a label failure is reported and never changes
the result. The command makes three `gh` calls per PR; `--limit` defaults to 50.

