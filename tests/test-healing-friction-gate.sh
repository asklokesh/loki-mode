#!/usr/bin/env bash
#===============================================================================
# Healing Friction Gate Tests (wave-4)
#
# Targeted regression coverage for two fail-open bugs in the friction safety
# gate of hook_pre_healing_modify (autonomy/hooks/migration-hooks.sh, the inline
# python classification block).
#
#   BUG A (type-coercion fail-open): the old gate computed
#     `safe = friction.get('safe_to_remove', False)` and blocked on `not safe`.
#     A JSON string "false" deserializes to the Python string "false", which is
#     TRUTHY, so `not "false"` == False -> the block was SKIPPED. A business_rule
#     friction the operator declined to remove (safe_to_remove: "false") was
#     therefore ALLOWED. The fix computes `safe = (safe_to_remove is True)`:
#     only a real boolean True clears; the string "false"/"true", int 1, and
#     None are all NOT safe.
#
#   BUG B (blacklist fails open): the old gate blocked only when
#     `cls in ('business_rule', 'unknown')`. The archaeology prompt defines no
#     closed classification taxonomy, so the LLM invents labels freely
#     (workaround, performance_hack, magic_value, ...). Any label OTHER than the
#     two hardcoded ones, with safe_to_remove: false, sailed through. The fix
#     replaces the blacklist with a whitelist: removal is BLOCKED unless the
#     friction is EXPLICITLY marked safe (real boolean True), regardless of
#     classification label.
#
# NON-VACUITY (how these tests FAIL against the OLD buggy behavior):
#   Test A: business_rule + safe_to_remove: "false" (string). Old: the string is
#     truthy, so `not safe` == False, the block is skipped, hook returns 0
#     (ALLOWED). New: `"false" is True` == False -> not safe -> BLOCK (rc 1).
#     This test asserts BLOCK, so the old behavior fails it.
#   Test B: workaround + safe_to_remove: false (real bool). Old: "workaround" is
#     not in ('business_rule','unknown'), so the block is skipped, hook returns 0
#     (ALLOWED). New: not safe -> BLOCK (rc 1) regardless of label. This test
#     asserts BLOCK, so the old behavior fails it.
#   Test C: any friction + safe_to_remove: true (real bool). Both old and new
#     ALLOW (rc 0) -- this is the preserved pass path; unchanged.
#   Test D: heal mode OFF. Both old and new early-return 0 (byte-identical
#     no-op); unchanged.
#
# The test proves A+B by running the CURRENT (fixed) hook and asserting BLOCK,
# and additionally proves the OLD behavior would have passed by re-running the
# same friction-map against a reconstructed OLD gate inline (so the non-vacuity
# is demonstrated live, not just asserted in a comment).
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOOKS_FILE="$PROJECT_DIR/autonomy/hooks/migration-hooks.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [[ -n "${2:-}" ]] && echo "         $2"
}

skip_all() {
    echo "  [SKIP] $1"
    exit 0
}

# Dependency self-skip: python3 is required by the inline gate; bash is required
# to source the hook. If either is absent, skip rather than fail.
command -v python3 >/dev/null 2>&1 || skip_all "python3 not available"
[[ -f "$HOOKS_FILE" ]] || skip_all "migration-hooks.sh not found at $HOOKS_FILE"

# Single mktemp workspace for the whole run; trap-cleaned on any exit.
WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-frictiongate.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Healing Friction Gate Tests (wave-4)"
echo "===================================="
echo ""

# Source the hooks the same way the sibling safety test does. The file uses
# `set -euo pipefail`; disable errexit locally so a non-zero return from a
# BLOCKED/failing hook does not abort this script.
# shellcheck disable=SC1090
source "$HOOKS_FILE"
set +e

# Helper: build a per-test codebase dir with a friction-map whose single
# friction matches the target file (basename match), and echo the dir.
make_case() {
    local name="$1" classification="$2" safe_json="$3"
    local dir="$WORKROOT/$name"
    mkdir -p "$dir/.loki/healing"
    # safe_json is inserted verbatim so callers control JSON type (true, false,
    # "false", "true", 1, null).
    cat > "$dir/.loki/healing/friction-map.json" <<EOF
{"frictions":[{"id":"F_${name}","location":"target.py:10","classification":"${classification}","safe_to_remove":${safe_json}}]}
EOF
    printf 'x\n' > "$dir/target.py"
    echo "$dir"
}

run_pre_hook() {
    # Run hook_pre_healing_modify against target.py inside the given codebase dir
    # in healing mode. Echo nothing; return the hook's exit code.
    local dir="$1"
    LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$dir" LOKI_HEAL_STRICT=false \
        hook_pre_healing_modify "target.py" >/dev/null 2>&1
    return $?
}

# Reconstruct the OLD (buggy) gate decision purely from the friction record, to
# prove non-vacuity: demonstrate the old logic would have ALLOWED (exit 0) the
# exact cases the fix now BLOCKS. This mirrors the pre-fix source:
#   safe = friction.get('safe_to_remove', False)
#   if cls in ('business_rule','unknown') and not safe: BLOCK
old_gate_allows() {
    local classification="$1" safe_json="$2"
    python3 - "$classification" "$safe_json" <<'PY'
import json, sys
cls = sys.argv[1]
# Parse the raw JSON token the same way json.load would inside the map.
raw = sys.argv[2]
try:
    safe_val = json.loads(raw)
except Exception:
    safe_val = raw
# OLD buggy logic, verbatim:
safe = safe_val if safe_val is not None else False
# .get default was False; here safe_val is always present. Reproduce truthiness.
blocked = (cls in ('business_rule', 'unknown')) and (not safe)
# OLD had no whitelist for other classes and used truthiness for safe.
print("BLOCK" if blocked else "ALLOW")
PY
}

# -----------------------------------------------------------------------------
# Test A (BUG A, type-coercion fail-open):
#   business_rule + safe_to_remove: "false" (JSON string) -> BLOCKED (rc 1).
#   Non-vacuity: the OLD gate ALLOWED it (string "false" is truthy).
# -----------------------------------------------------------------------------
echo "Test A: business_rule + safe_to_remove:\"false\" (string) -> BLOCKED"
DIR_A="$(make_case a business_rule '"false"')"
run_pre_hook "$DIR_A"
rc_a=$?
old_a="$(old_gate_allows business_rule '"false"')"
if [[ "$rc_a" -ne 0 ]]; then
    pass "string \"false\" no longer clears removal (BLOCKED, rc=$rc_a)"
else
    fail "business_rule + safe_to_remove:\"false\" must BLOCK (rc!=0)" "got rc=$rc_a"
fi
if [[ "$old_a" == "ALLOW" ]]; then
    pass "non-vacuity: OLD gate ALLOWED this (string truthiness fail-open)"
else
    fail "non-vacuity check: OLD gate expected to ALLOW string \"false\"" "old_gate=$old_a"
fi

# -----------------------------------------------------------------------------
# Test B (BUG B, blacklist fails open):
#   workaround + safe_to_remove: false (real bool) -> BLOCKED (rc 1).
#   Non-vacuity: the OLD gate ALLOWED it (label not in the two-item blacklist).
# -----------------------------------------------------------------------------
echo "Test B: workaround (invented label) + safe_to_remove:false -> BLOCKED"
DIR_B="$(make_case b workaround false)"
run_pre_hook "$DIR_B"
rc_b=$?
old_b="$(old_gate_allows workaround false)"
if [[ "$rc_b" -ne 0 ]]; then
    pass "invented classification no longer bypasses the gate (BLOCKED, rc=$rc_b)"
else
    fail "workaround + safe_to_remove:false must BLOCK (rc!=0)" "got rc=$rc_b"
fi
if [[ "$old_b" == "ALLOW" ]]; then
    pass "non-vacuity: OLD gate ALLOWED this (blacklist fail-open)"
else
    fail "non-vacuity check: OLD gate expected to ALLOW 'workaround'" "old_gate=$old_b"
fi

# -----------------------------------------------------------------------------
# Test C (preserved pass path):
#   any friction + safe_to_remove: true (real bool) -> ALLOWED (rc 0).
#   Uses a business_rule label to show even the most-protected class clears when
#   explicitly marked safe with a real boolean. Unchanged between old and new.
# -----------------------------------------------------------------------------
echo "Test C: business_rule + safe_to_remove:true (real bool) -> ALLOWED"
DIR_C="$(make_case c business_rule true)"
run_pre_hook "$DIR_C"
rc_c=$?
if [[ "$rc_c" -eq 0 ]]; then
    pass "explicit boolean true still clears removal (ALLOWED, rc=0)"
else
    fail "safe_to_remove:true (real bool) must ALLOW (rc=0)" "got rc=$rc_c"
fi

# C2 (control): a friction whose location does NOT match the target still allows
# (no over-block). safe_to_remove:false but non-matching location.
echo "Test C2: non-matching friction location -> ALLOWED (no over-block)"
DIR_C2="$WORKROOT/c2"
mkdir -p "$DIR_C2/.loki/healing"
cat > "$DIR_C2/.loki/healing/friction-map.json" <<'EOF'
{"frictions":[{"id":"F_c2","location":"someother.py:3","classification":"business_rule","safe_to_remove":false}]}
EOF
printf 'x\n' > "$DIR_C2/target.py"
run_pre_hook "$DIR_C2"
rc_c2=$?
if [[ "$rc_c2" -eq 0 ]]; then
    pass "non-matching friction does not block an unrelated edit (rc=0)"
else
    fail "non-matching friction must not over-block (rc=0)" "got rc=$rc_c2"
fi

# -----------------------------------------------------------------------------
# Test D (heal mode OFF): byte-identical no-op.
#   With LOKI_HEAL_MODE unset/false the hook early-returns 0 before touching the
#   friction map. A friction that would BLOCK in heal mode must be a no-op here.
#   This is the "byte-identical no-op" path (the heal-mode-off early return),
#   NOT the heal-mode-ON + absent-map path (which intentionally fails closed and
#   is covered by test-healing-hooks-safety.sh).
# -----------------------------------------------------------------------------
echo "Test D: heal mode OFF -> ALLOWED (byte-identical no-op)"
DIR_D="$(make_case d business_rule false)"   # would BLOCK if heal mode were on
LOKI_HEAL_MODE=false LOKI_CODEBASE_PATH="$DIR_D" LOKI_HEAL_STRICT=false \
    hook_pre_healing_modify "target.py" >/dev/null 2>&1
rc_d=$?
if [[ "$rc_d" -eq 0 ]]; then
    pass "heal mode off is a no-op even for a would-block friction (rc=0)"
else
    fail "heal mode off must be a byte-identical no-op (rc=0)" "got rc=$rc_d"
fi
# no snapshot should be written when heal mode is off (the whole hook body
# is skipped), confirming the no-op is genuine.
if [[ ! -d "$DIR_D/.loki/healing/snapshots" ]]; then
    pass "no snapshot dir created when heal mode is off (genuine no-op)"
else
    fail "heal mode off must not run the snapshot path" "snapshots dir exists"
fi

echo ""
echo "===================================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
exit 0
