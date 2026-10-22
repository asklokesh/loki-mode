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
when the run verdict is not VERIFIED. The refusal names the gate. `loki start
--ship` auto-merge uses this command, so it cannot bypass red, pending or draft
PRs or a non-VERIFIED run.

    loki merge watch <pr|branch> [--require-verified] [--delete-branch]

CI repair loop. Waits for checks; when they are red it passes the failed-run log
tail to a bounded repair session on the PR branch (LOKI_PR_REPAIR_CMD, default a
`loki start` of a generated brief; it gets the evidence file path as its last
argument), pushes, and re-checks, up to LOKI_PR_REPAIR_MAX attempts (default 2).
Green goes through the same merge gate as `loki merge pr`. When attempts run out
the PR is returned to draft, nothing merges, and the last failure log is printed.
`loki start --ship --engine legacy` calls this after it opens the PR; `/merge watch <pr>` runs it
from `loki chat`.
