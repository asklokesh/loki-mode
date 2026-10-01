#!/usr/bin/env bash
# The machine exit-code contract must be visible from --help, not only in docs.
#
# docs/exit-codes.md documents a genuinely strong tiered contract for
# `loki start`: with LOKI_DURABLE_STATE=1, code 20 means "deterministic terminal
# failure, retrying cannot help", which Helm wires into a Kubernetes
# podFailurePolicy. `loki start --help` mentioned it ZERO times, so a CI author
# read the help, saw only "0 on success", and built the coarse gate. A contract
# nobody can discover might as well not have shipped.
#
# This asserts the help STATES the contract, and that what it states matches
# docs/exit-codes.md -- a help text that drifts from the doc is worse than none.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-exit-codes-discoverable"

HELP="$(bash autonomy/loki start --help 2>&1)"

# 1. The help must name the durable-state env var. Without it the tiered
#    contract is unreachable: it only applies when that var is set.
if printf '%s' "$HELP" | grep -q 'LOKI_DURABLE_STATE'; then
    pass "start --help names LOKI_DURABLE_STATE"
else
    fail "start --help does not mention LOKI_DURABLE_STATE (the contract is unreachable)"
fi

# 2. It must name code 20 specifically. "nonzero means failure" is the coarse
#    gate this exists to replace; 20 is the value Helm's podFailurePolicy reads.
if printf '%s' "$HELP" | grep -qE '(^|[^0-9])20([^0-9]|$)'; then
    pass "start --help states the terminal-failure code 20"
else
    fail "start --help never states code 20"
fi

# 3. It must say retrying does not help, which is the whole point of the code.
if printf '%s' "$HELP" | grep -qi 'do not retry'; then
    pass "start --help states the retry semantics"
else
    fail "start --help states a code but not what a platform should do with it"
fi

# 4. It must point at the full table rather than duplicating it and drifting.
if printf '%s' "$HELP" | grep -q 'docs/exit-codes.md'; then
    pass "start --help points to the full table"
else
    fail "start --help does not reference docs/exit-codes.md"
fi

# 5. NO DRIFT: the code the help states must be the code the doc states. If
#    someone changes the contract in one place, this fails rather than leaving
#    two documents disagreeing about a value a Job is configured on.
DOC_20="$(grep -cE '^\| 20 \|' docs/exit-codes.md 2>/dev/null || echo 0)"
if [ "$DOC_20" -ge 1 ]; then
    pass "docs/exit-codes.md still documents code 20 (help and doc agree)"
else
    fail "docs/exit-codes.md no longer documents code 20 while --help claims it"
fi

# 6. loki verify already documented its own codes before this change; assert it
#    still does, so a future edit cannot quietly drop it.
VHELP="$(bash autonomy/verify.sh --help 2>&1)"
if printf '%s' "$VHELP" | grep -q '^EXIT CODES:'; then
    pass "verify --help still documents its exit codes"
else
    fail "verify --help lost its exit-code section"
fi

# 7. Exactly ONE exit-codes section in verify --help. Adding a second is an easy
#    mistake (it happened while writing this) and duplicated help that can drift
#    apart is worse than a single statement.
VCOUNT="$(printf '%s' "$VHELP" | grep -c '^EXIT CODES:')"
if [ "$VCOUNT" -eq 1 ]; then
    pass "verify --help has exactly one exit-codes section"
else
    fail "verify --help has $VCOUNT exit-codes sections (expected 1)"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
