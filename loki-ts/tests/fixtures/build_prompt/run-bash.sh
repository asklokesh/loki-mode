#!/bin/bash
#
# run-bash.sh -- Phase 4 prompt-parity bash harness.
#
# Invokes the bash build_prompt() function (autonomy/run.sh:8912) inside a
# fixture's working directory, captures stdout to expected.txt, and computes
# expected.sha256.
#
# Usage:
#   run-bash.sh <fixture-dir>
#
# A fixture-dir contains:
#   env.sh           - exported env vars (RETRY, PRD, ITERATION, PHASE_*, ...)
#   .loki/           - state directory used by the function
#   <prd file>       - optional PRD anchor target
#
# After invocation, the directory will additionally contain:
#   expected.txt      - byte-exact bash output (gold standard)
#   expected.sha256   - sha256(expected.txt)
#   env.txt           - rendered env (resolved values, for the index)
#
# The script is deliberately deterministic:
#   * Defaults all phase flags to false and clears optional sentinels so a
#     fixture only sees the env vars it explicitly sets in env.sh.
#   * cd's into the fixture dir so relative .loki/ paths resolve correctly.
#   * Sources autonomy/run.sh in a subshell -- the parent shell is untouched.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "usage: run-bash.sh <fixture-dir>" >&2
    exit 2
fi

FIXTURE_DIR="$1"
if [ ! -d "$FIXTURE_DIR" ]; then
    echo "fixture dir not found: $FIXTURE_DIR" >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

if [ ! -f "$RUN_SH" ]; then
    echo "run.sh not found at $RUN_SH" >&2
    exit 2
fi

FIXTURE_ABS="$(cd "$FIXTURE_DIR" && pwd)"

# Run in a subshell so env vars do not leak across fixtures.
(
    cd "$FIXTURE_ABS"

    # Pre-source defaults (run.sh re-derives some of these via ${LOKI_X:-...}).
    # We override LOKI_PHASE_* so the engine cannot quietly turn every phase on.
    export LOKI_PHASE_UNIT_TESTS="false"
    export LOKI_PHASE_API_TESTS="false"
    export LOKI_PHASE_E2E_TESTS="false"
    export LOKI_PHASE_SECURITY="false"
    export LOKI_PHASE_INTEGRATION="false"
    export LOKI_PHASE_CODE_REVIEW="false"
    export LOKI_PHASE_WEB_RESEARCH="false"
    export LOKI_PHASE_PERFORMANCE="false"
    export LOKI_PHASE_ACCESSIBILITY="false"
    export LOKI_PHASE_REGRESSION="false"
    export LOKI_PHASE_UAT="false"

    # Source the engine (must be inside the subshell so cwd is the fixture dir).
    # shellcheck disable=SC1090
    source "$RUN_SH"

    # Force-clear PHASE_* and other globals AFTER sourcing because run.sh
    # unconditionally re-assigns them (PHASE_X=${LOKI_PHASE_X:-true}). With
    # LOKI_PHASE_X=false above, they will already be false here -- this block
    # is defensive belt-and-suspenders + sets the non-LOKI globals.
    export PHASE_UNIT_TESTS="false"
    export PHASE_API_TESTS="false"
    export PHASE_E2E_TESTS="false"
    export PHASE_SECURITY="false"
    export PHASE_INTEGRATION="false"
    export PHASE_CODE_REVIEW="false"
    export PHASE_WEB_RESEARCH="false"
    export PHASE_PERFORMANCE="false"
    export PHASE_ACCESSIBILITY="false"
    export PHASE_REGRESSION="false"
    export PHASE_UAT="false"
    export MAX_PARALLEL_AGENTS=10
    export MAX_ITERATIONS=1000
    export TARGET_DIR="."
    export AUTONOMY_MODE=""
    export PERPETUAL_MODE="false"
    export LOKI_LEGACY_PROMPT_ORDERING="false"
    export PROVIDER_DEGRADED="false"
    export COMPLETION_PROMISE=""
    export LOKI_HUMAN_INPUT=""
    export RETRY=0
    export PRD=""
    export ITERATION=1

    # Apply fixture-specific env (env.sh wins over the cleared defaults).
    if [ -f env.sh ]; then
        # shellcheck disable=SC1091
        source env.sh
    fi

    # Refresh mtimes on memory state files. load_handoff_context() and the
    # learnings loader use `find -mtime -1`, which would silently skip
    # checked-in fixture files because their mtime is whatever git restored.
    # Touch them so the handoff/ledger code path is exercised deterministically.
    if [ -d .loki/memory ]; then
        find .loki/memory -type f -exec touch {} + 2>/dev/null || true
    fi

    # Render the env that the bash function will see, for the index/manifest.
    {
        printf 'RETRY=%s\n' "${RETRY}"
        printf 'PRD=%s\n' "${PRD}"
        printf 'ITERATION=%s\n' "${ITERATION}"
        printf 'MAX_PARALLEL_AGENTS=%s\n' "${MAX_PARALLEL_AGENTS}"
        printf 'MAX_ITERATIONS=%s\n' "${MAX_ITERATIONS}"
        printf 'AUTONOMY_MODE=%s\n' "${AUTONOMY_MODE}"
        printf 'PERPETUAL_MODE=%s\n' "${PERPETUAL_MODE}"
        printf 'PROVIDER_DEGRADED=%s\n' "${PROVIDER_DEGRADED}"
        printf 'LOKI_LEGACY_PROMPT_ORDERING=%s\n' "${LOKI_LEGACY_PROMPT_ORDERING}"
        printf 'COMPLETION_PROMISE=%s\n' "${COMPLETION_PROMISE}"
        printf 'LOKI_HUMAN_INPUT=%s\n' "${LOKI_HUMAN_INPUT}"
        for p in UNIT_TESTS API_TESTS E2E_TESTS SECURITY INTEGRATION CODE_REVIEW \
                 WEB_RESEARCH PERFORMANCE ACCESSIBILITY REGRESSION UAT; do
            var="PHASE_${p}"
            printf '%s=%s\n' "$var" "${!var}"
        done
    } > env.txt

    # Invoke build_prompt and capture byte-exact output.
    build_prompt "$RETRY" "$PRD" "$ITERATION" > expected.txt 2>/dev/null

    # SHA-256 of the captured prompt.
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 expected.txt | awk '{print $1}' > expected.sha256
    else
        sha256sum expected.txt | awk '{print $1}' > expected.sha256
    fi
)
