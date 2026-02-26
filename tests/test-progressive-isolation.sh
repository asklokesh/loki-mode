#!/usr/bin/env bash
# Test: Progressive Isolation flags (v6.2.0)
# Verifies --worktree, --pr, --ship, --detach flags in loki run help output.
# Pure unit test -- does not execute any actual loki run commands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0; FAIL=0; TOTAL=0
pass() { ((PASS++)); ((TOTAL++)); echo "PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "FAIL: $1"; }

# Capture help outputs once
RUN_HELP=$(bash "$LOKI" run --help 2>&1) || true
MAIN_HELP=$(bash "$LOKI" --help 2>&1) || true

# --- Tests ---

# 1. --worktree flag in loki run --help
if echo "$RUN_HELP" | grep -q -- "--worktree"; then
    pass "--worktree flag appears in 'loki run --help'"
else
    fail "--worktree flag missing from 'loki run --help'"
fi

# 2. --pr flag in loki run --help
if echo "$RUN_HELP" | grep -q -- "--pr"; then
    pass "--pr flag appears in 'loki run --help'"
else
    fail "--pr flag missing from 'loki run --help'"
fi

# 3. --ship flag in loki run --help
if echo "$RUN_HELP" | grep -q -- "--ship"; then
    pass "--ship flag appears in 'loki run --help'"
else
    fail "--ship flag missing from 'loki run --help'"
fi

# 4. --detach flag in loki run --help
if echo "$RUN_HELP" | grep -q -- "--detach"; then
    pass "--detach flag appears in 'loki run --help'"
else
    fail "--detach flag missing from 'loki run --help'"
fi

# 5. Progressive Isolation section in main help
if echo "$MAIN_HELP" | grep -qi "Progressive Isolation"; then
    pass "Progressive Isolation section appears in main help"
else
    fail "Progressive Isolation section missing from main help"
fi

# 6. Cascade documentation (implies keyword)
if echo "$RUN_HELP" | grep -q "implies"; then
    pass "Cascade documentation (implies) appears in run help"
else
    fail "Cascade documentation (implies) missing from run help"
fi

# 7. -w alias for --worktree
if echo "$RUN_HELP" | grep -q -- "-w"; then
    pass "-w alias listed for --worktree"
else
    fail "-w alias missing for --worktree"
fi

# 8. -d alias for --detach
if echo "$RUN_HELP" | grep -q -- "-d"; then
    pass "-d alias listed for --detach"
else
    fail "-d alias missing for --detach"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
