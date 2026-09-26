#!/usr/bin/env bash
# tests/council/test_managed_completion_flag.sh
# v7.0.0 Phase 4: flag matrix for LOKI_EXPERIMENTAL_MANAGED_COUNCIL.
#
# Invariants:
#   1. Default is OFF (false).
#   2. council=true with umbrella=false -> warn and force council=false.
#   3. council=true with parent=false  -> warn and force council=false.
#   4. umbrella=true with parent=false -> warn (umbrella alone is meaningless).
#   5. parent+umbrella+council all true -> no warnings, council stays true.
#
# The fail-fast logic lives in autonomy/run.sh. We exercise the exact block
# in a bash subshell so we don't have to source the entire runner.

set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1

PASS=0
FAIL=0

# Harness: replicates the LOKI_EXPERIMENTAL_MANAGED_COUNCIL block in run.sh.
# Prints final effective council value on stdout and any warnings on stderr.
HARNESS='
LOKI_MANAGED_AGENTS="${LOKI_MANAGED_AGENTS:-false}"
LOKI_MANAGED_MEMORY="${LOKI_MANAGED_MEMORY:-false}"
LOKI_EXPERIMENTAL_MANAGED_AGENTS="${LOKI_EXPERIMENTAL_MANAGED_AGENTS:-false}"
LOKI_EXPERIMENTAL_MANAGED_COUNCIL="${LOKI_EXPERIMENTAL_MANAGED_COUNCIL:-false}"

if [ "$LOKI_MANAGED_MEMORY" = "true" ] && [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
    echo "ERROR: LOKI_MANAGED_MEMORY=true requires LOKI_MANAGED_AGENTS=true" >&2
    exit 2
fi

if [ "$LOKI_EXPERIMENTAL_MANAGED_COUNCIL" = "true" ] && \
   [ "$LOKI_EXPERIMENTAL_MANAGED_AGENTS" != "true" ]; then
    echo "WARNING: LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true requires LOKI_EXPERIMENTAL_MANAGED_AGENTS=true; disabling managed council for this run" >&2
    LOKI_EXPERIMENTAL_MANAGED_COUNCIL="false"
fi
if [ "$LOKI_EXPERIMENTAL_MANAGED_COUNCIL" = "true" ] && \
   [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
    echo "WARNING: LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true requires LOKI_MANAGED_AGENTS=true; disabling managed council for this run" >&2
    LOKI_EXPERIMENTAL_MANAGED_COUNCIL="false"
fi
if [ "$LOKI_EXPERIMENTAL_MANAGED_AGENTS" = "true" ] && \
   [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
    echo "WARNING: LOKI_EXPERIMENTAL_MANAGED_AGENTS=true has no effect without LOKI_MANAGED_AGENTS=true" >&2
fi

echo "council=$LOKI_EXPERIMENTAL_MANAGED_COUNCIL"
'

run_case() {
    local label="$1"
    local parent="$2"
    local umbrella="$3"
    local council_in="$4"
    local expected_council="$5"
    local expect_warning="$6"  # "yes" or "no"

    stdout=$(LOKI_MANAGED_AGENTS="$parent" \
             LOKI_EXPERIMENTAL_MANAGED_AGENTS="$umbrella" \
             LOKI_EXPERIMENTAL_MANAGED_COUNCIL="$council_in" \
             bash -c "$HARNESS" 2>/tmp/loki-test-err-$$)
    stderr=$(cat /tmp/loki-test-err-$$ 2>/dev/null || true)
    rm -f /tmp/loki-test-err-$$

    local ok=true
    if ! echo "$stdout" | grep -qx "council=$expected_council"; then
        ok=false
        echo "FAIL [$label] stdout expected 'council=$expected_council', got: $stdout"
    fi

    if [ "$expect_warning" = "yes" ]; then
        if ! echo "$stderr" | grep -qi "warning"; then
            ok=false
            echo "FAIL [$label] expected a WARNING, stderr=$stderr"
        fi
    fi

    if $ok; then
        echo "PASS [$label] parent=$parent umbrella=$umbrella council_in=$council_in -> council=$expected_council warn=$expect_warning"
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1))
    fi
}

# Case 1: all off (default) -> silent, council=false
run_case "default_all_off" "false" "false" "false" "false" "no"

# Case 2: parent+umbrella+council all true -> council stays true, no warning
run_case "fully_enabled"   "true"  "true"  "true"  "true"  "no"

# Case 3: council=true umbrella=false -> warn + force council=false
run_case "council_no_umbrella" "true" "false" "true" "false" "yes"

# Case 4: council=true parent=false (umbrella=true) -> warn + force council=false
run_case "council_no_parent"   "false" "true" "true" "false" "yes"

# Case 5: council=true both parent+umbrella=false -> warn + force council=false
run_case "council_no_parent_no_umbrella" "false" "false" "true" "false" "yes"

# Case 6: umbrella only -> warn (umbrella alone), council=false
run_case "umbrella_only" "false" "true" "false" "false" "yes"

# Also assert the canonical flag block lives in autonomy/run.sh.
if grep -q "LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true requires LOKI_EXPERIMENTAL_MANAGED_AGENTS=true" autonomy/run.sh; then
    echo "PASS [embedded_umbrella_check] warn line lives in autonomy/run.sh"
    PASS=$((PASS+1))
else
    echo "FAIL [embedded_umbrella_check] warn line NOT in autonomy/run.sh"
    FAIL=$((FAIL+1))
fi
if grep -q "LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true requires LOKI_MANAGED_AGENTS=true" autonomy/run.sh; then
    echo "PASS [embedded_parent_check] parent-warn line lives in autonomy/run.sh"
    PASS=$((PASS+1))
else
    echo "FAIL [embedded_parent_check] parent-warn line NOT in autonomy/run.sh"
    FAIL=$((FAIL+1))
fi

# Verify loki version still boots with the flag on but parent off.
bootout=$(LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true ./autonomy/loki version 2>&1 || true)
if echo "$bootout" | grep -q "Loki Mode v"; then
    echo "PASS [boot_with_flag_no_parent] loki version still boots"
    PASS=$((PASS+1))
else
    echo "FAIL [boot_with_flag_no_parent] loki version did not boot cleanly; output=$bootout"
    FAIL=$((FAIL+1))
fi

# D7 (backlog 54): with all three flags on, council_managed_should_stop imports
# providers.managed only from an explicit PROJECT_DIR, never from the cwd (the
# agent's repo). The fixture cwd ships a fake providers.managed that votes
# APPROVE and writes a marker; it is the only module either run can import, so
# this is hermetic (no SDK, no network).
MC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loki-managed-cwd.XXXXXX")"
MC_DIR="$(cd "$MC_DIR" && pwd -P)"
mkdir -p "$MC_DIR/providers" "$MC_DIR/memory/managed_memory"
: > "$MC_DIR/providers/__init__.py"; : > "$MC_DIR/memory/__init__.py"; : > "$MC_DIR/memory/managed_memory/__init__.py"
cat > "$MC_DIR/providers/managed.py" <<'EOF'
import os
open(os.environ["MC_MARK"], "a").write("providers.managed\n")
class ManagedUnavailable(Exception):
    pass
def is_enabled():
    return True
class _Vote:
    def __init__(self, role):
        self.pool_name, self.agent_id, self.verdict, self.rationale, self.severity = role, role, "STOP", "fake", None
class _Result:
    session_id, elapsed_ms, partial, majority = "fake", 1, False, "STOP"
    votes = [_Vote("requirements_verifier"), _Vote("test_auditor"), _Vote("devils_advocate")]
def run_completion_council(**kw):
    return _Result()
EOF
printf '%s\n' 'def emit_managed_event(*a, **k):' '    pass' > "$MC_DIR/memory/managed_memory/events.py"
mc_run() { # <PROJECT_DIR value, or "" for unset> -> "<rc>/<verdict files>/<marker lines>"
    rm -rf "$MC_DIR/.loki" "$MC_DIR/mark"
    (
        cd "$MC_DIR" || exit 99
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_debug() { :; }
        log_header() { :; }; log_step() { :; }; log_success() { :; }
        # shellcheck source=/dev/null
        source "$REPO/autonomy/completion-council.sh" >/dev/null 2>&1 || exit 98
        unset PROJECT_DIR
        [ -n "$1" ] && export PROJECT_DIR="$1"
        export LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true LOKI_EXPERIMENTAL_MANAGED_AGENTS=true LOKI_MANAGED_AGENTS=true
        export COUNCIL_STATE_DIR="$MC_DIR/.loki/council" TARGET_DIR="$MC_DIR" ITERATION_COUNT=3 MC_MARK="$MC_DIR/mark"
        council_managed_should_stop >/dev/null 2>&1
    )
    local rc=$? marks=0
    [ -s "$MC_DIR/mark" ] && marks="$(wc -l < "$MC_DIR/mark" | tr -d ' ')"
    printf '%s/%s/%s\n' "$rc" "$(find "$MC_DIR/.loki/council/verdicts" -name '*.txt' 2>/dev/null | wc -l | tr -d ' ')" "$marks"
}
# Control: an explicit PROJECT_DIR is honored, so the harness does reach the
# import and a non-zero rc below is not a sourcing or flag failure.
got="$(mc_run "$MC_DIR")"
if [ "$got" = "0/3/1" ]; then
    echo "PASS [managed_explicit_project_dir] explicit PROJECT_DIR is imported (control: rc/verdicts/marker=$got)"
    PASS=$((PASS+1))
else
    echo "FAIL [managed_explicit_project_dir] control broken: rc/verdicts/marker=$got, want 0/3/1"
    FAIL=$((FAIL+1))
fi
got="$(mc_run "")"
if [ "$got" = "1/0/0" ]; then
    echo "PASS [managed_no_cwd_import] PROJECT_DIR unset: no import from the cwd, falls back to Bash voting ($got)"
    PASS=$((PASS+1))
else
    echo "FAIL [managed_no_cwd_import] PROJECT_DIR unset imported the cwd's providers.managed: rc/verdicts/marker=$got, want 1/0/0"
    FAIL=$((FAIL+1))
fi
rm -rf "$MC_DIR"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
