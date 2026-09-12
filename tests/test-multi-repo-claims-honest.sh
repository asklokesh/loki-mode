#!/usr/bin/env bash
# `--multi-repo` must not claim to migrate repositories it never touches.
#
# THE DEFECT, reproduced: `loki migrate <alpha> --multi-repo './services/*'`
# printed "Multi-repo migration (3 repositories)" and listed all three, then
# created a single migration scoped to alpha. beta and gamma were never
# touched. `repos[]` is populated at the discovery block and NEVER REFERENCED
# AGAIN -- everything downstream uses the single "$codebase_path".
#
# A user reading "Multi-repo migration (3 repositories)" reasonably believes
# three repositories were migrated. That is a false claim in shipped output,
# the same class as a resume hint promising an iteration the runtime discards.
#
# WHAT IS LOAD-BEARING: this suite does NOT assert that multi-repo
# orchestration works -- it does not exist yet, and asserting it would be
# fiction. It asserts the OUTPUT IS HONEST about what actually ran. If real
# orchestration is built later, these assertions should be REPLACED by ones
# that verify every repo was migrated, not deleted to make room.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() {
    find "$WORK" -type f -delete 2>/dev/null || true
    find "$WORK" -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-multi-repo-claims-honest"

# The source-level fact the runtime behaviour follows from. Asserted directly so
# the suite stays meaningful even where the CLI cannot be driven end to end.
# If someone wires repos[] into a real loop, THIS assertion should be the one
# that fails first and prompts replacing this suite.
BLOCK_START="$(grep -n 'Handle multi-repo' "$LOKI_BIN" | head -1 | cut -d: -f1)"
if [ -n "$BLOCK_START" ]; then
    pass "the multi-repo discovery block exists (line $BLOCK_START)"
else
    fail "cannot locate the multi-repo block; this suite is measuring nothing"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# 1. The headline must not assert a multi-repo MIGRATION happened.
#    Matched on an ECHO, not on the bare string: the comment that explains this
#    fix necessarily QUOTES the old wording, and a naive `grep -q` fired on that
#    comment while the live output was already correct. A text guard that reads
#    its own documentation as the defect is a known trap in this repo.
if grep -nE '^[^#]*echo.*Multi-repo migration' "$LOKI_BIN" >/dev/null 2>&1; then
    fail "an echo still prints 'Multi-repo migration' while migrating one repo"
else
    pass "no echo claims a multi-repo migration (comments may quote the old text)"
fi

# 2. It must say plainly that discovery is not orchestration.
if grep -q 'does not migrate them together' "$LOKI_BIN"; then
    pass "the output states that --multi-repo does not migrate together"
else
    fail "nothing tells the user the other repos are not migrated"
fi

# 3. It must name the ONE repo that actually runs.
if grep -q 'This run migrates only' "$LOKI_BIN"; then
    pass "the output names the single repo that actually migrates"
else
    fail "the output does not say which repo actually runs"
fi

# 4. It must hand over runnable commands for the rest, not just a warning.
if grep -q 'To cover the others, run each one' "$LOKI_BIN"; then
    pass "the user is given commands covering the remaining repos"
else
    fail "no follow-up commands: the user is told no and left there"
fi

# 5. END-TO-END. The strings above could all sit in dead code. Drive the real
#    CLI and assert on what a user actually sees.
if command -v timeout >/dev/null 2>&1; then
    mkdir -p "$WORK/services/alpha" "$WORK/services/beta" "$WORK/services/gamma"
    for d in alpha beta gamma; do printf 'x\n' > "$WORK/services/$d/main.py"; done
    OUT="$( cd "$WORK" && LOKI_LEGACY_BASH=1 timeout 60 bash "$LOKI_BIN" migrate \
            "$WORK/services/alpha" --target typescript \
            --multi-repo "$WORK/services/*" --plan-only 2>&1 )" || true

    # Vacuity guard: an empty capture would pass every negative assertion below.
    if [ -n "${OUT//[[:space:]]/}" ]; then
        pass "the CLI produced output to assert on"
    else
        fail "the CLI produced NO output; the assertions below would be vacuous"
    fi

    case "$OUT" in
        *"Multi-repo migration"*)
            fail "live output still claims 'Multi-repo migration'" ;;
        *)
            pass "live output does not claim a multi-repo migration" ;;
    esac

    case "$OUT" in
        *"does not migrate them together"*)
            pass "live output is explicit that the others are not migrated" ;;
        *)
            fail "live output omits the honesty line" ;;
    esac

    # The follow-up commands must name the repos NOT being migrated.
    if printf '%s' "$OUT" | grep -q 'services/beta' && \
       printf '%s' "$OUT" | grep -q 'services/gamma'; then
        pass "live output names the uncovered repos in follow-up commands"
    else
        fail "live output does not hand over commands for beta and gamma"
    fi
else
    echo "  SKIP: timeout(1) unavailable -- end-to-end behaviour was NOT measured"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
