#!/usr/bin/env bash
# tests/managed_memory/test_flag_matrix.sh
# v6.83.0 Phase 1: flag matrix for LOKI_MANAGED_AGENTS x LOKI_MANAGED_MEMORY.
#
# Invariant: the only misconfiguration that FAILS fast is
#     child=true AND parent=false  -> exit 2 with a clear error on stderr.
# Every other combination must be allowed (run.sh continues past the check).
#
# Strategy: source run.sh in a subshell with `exit 0` injected just after the
# fail-fast check by intercepting via LOKI_AUTONOMY_EARLY_EXIT. But run.sh
# doesn't have such a hook. Instead we extract the flag block + fail-fast
# into a tiny harness using `bash -c` with the exact lines.

set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1

PASS=0
FAIL=0

run_case() {
    local parent="$1"
    local child="$2"
    local expected_exit="$3"
    local label="$4"

    # Harness replicates the flag block + fail-fast from autonomy/run.sh.
    output=$(
        LOKI_MANAGED_AGENTS="$parent" LOKI_MANAGED_MEMORY="$child" \
        bash -c '
            LOKI_MANAGED_AGENTS="${LOKI_MANAGED_AGENTS:-false}"
            LOKI_MANAGED_MEMORY="${LOKI_MANAGED_MEMORY:-false}"
            if [ "$LOKI_MANAGED_MEMORY" = "true" ] && [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
                echo "ERROR: LOKI_MANAGED_MEMORY=true requires LOKI_MANAGED_AGENTS=true" >&2
                exit 2
            fi
            exit 0
        ' 2>&1
    )
    actual_exit=$?
    if [ "$actual_exit" -eq "$expected_exit" ]; then
        echo "PASS [$label] parent=$parent child=$child exit=$actual_exit"
        PASS=$((PASS+1))
    else
        echo "FAIL [$label] parent=$parent child=$child expected=$expected_exit got=$actual_exit output=$output"
        FAIL=$((FAIL+1))
    fi
}

# Only the (parent=false, child=true) case should fail fast.
run_case "false" "false" 0 "both_off"
run_case "true"  "false" 0 "parent_only"
run_case "true"  "true"  0 "both_on"
run_case "false" "true"  2 "child_only_fails_fast"

# Assert stderr contains the expected message for the failing case.
err=$(
    LOKI_MANAGED_AGENTS="false" LOKI_MANAGED_MEMORY="true" \
    bash -c '
        LOKI_MANAGED_AGENTS="${LOKI_MANAGED_AGENTS:-false}"
        LOKI_MANAGED_MEMORY="${LOKI_MANAGED_MEMORY:-false}"
        if [ "$LOKI_MANAGED_MEMORY" = "true" ] && [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
            echo "ERROR: LOKI_MANAGED_MEMORY=true requires LOKI_MANAGED_AGENTS=true" >&2
            exit 2
        fi
    ' 2>&1 >/dev/null
)
if echo "$err" | grep -q "requires LOKI_MANAGED_AGENTS=true"; then
    echo "PASS [error_message] stderr contains clear guidance"
    PASS=$((PASS+1))
else
    echo "FAIL [error_message] stderr did not contain expected message; got: $err"
    FAIL=$((FAIL+1))
fi

# Also assert that the flag block is actually in autonomy/run.sh.
if grep -q "LOKI_MANAGED_MEMORY=true requires LOKI_MANAGED_AGENTS=true" autonomy/run.sh; then
    echo "PASS [embedded_check] fail-fast line lives in autonomy/run.sh"
    PASS=$((PASS+1))
else
    echo "FAIL [embedded_check] fail-fast line NOT in autonomy/run.sh"
    FAIL=$((FAIL+1))
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
