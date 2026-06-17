#!/usr/bin/env bash
#
# test-ratelimit-debug-clean.sh -- B9 regression guard.
#
# WHAT THIS GUARDS
#   detect_rate_limit() (autonomy/run.sh) is consumed via command substitution:
#       local rate_limit_wait=$(detect_rate_limit "$iter_output")
#   detect_rate_limit calls log_debug in its calculated-backoff branch. If
#   log_debug ever writes to STDOUT (the pre-v7.41.5 behavior), then under
#   LOKI_DEBUG=true the captured value becomes "[DEBUG] ...\n<number>" instead
#   of "<number>", the subsequent `[ $rate_limit_wait -gt 0 ]` integer test
#   errors, and the rate-limit reset wait is silently skipped. The fix routes
#   log_debug to STDERR so no captured stdout stream can ever be contaminated.
#
# WHY THIS TEST IS NOT A DUPLICATE OF test-log-debug-stderr.sh
#   That sibling test asserts an INLINE REPLICA of log_debug behaves. This test
#   awk-extracts the REAL functions from autonomy/run.sh (mirroring the
#   single-function extraction pattern in tests/test-approval-phase-gate.sh) and
#   drives the actual detect_rate_limit end-to-end. It therefore catches a
#   regression of the live run.sh log_debug definition back to stdout, which the
#   inline-replica test cannot.
#
# NON-VACUITY (see also the empirical proof at the bottom of this file)
#   The sample must route through the ONE log_debug call inside detect_rate_limit
#   (the calculated-backoff branch). That branch fires only when wait_secs is
#   still 0 after provider-specific parsing AND retry-after parsing. The sample
#   "HTTP 429: too many requests" satisfies all of:
#     - is_rate_limited -> true (429 / "too many requests")
#     - no "resets [0-9]+[ap]m"   -> parse_claude_reset_time returns 0
#     - no "retry-after: <num>"   -> parse_retry_after returns 0
#   so detect_rate_limit falls to calculate_rate_limit_backoff and fires
#   log_debug. Under OLD (stdout) log_debug this pollutes the capture; under the
#   fixed (stderr) log_debug it does not. A sample carrying "Retry-After: 60" or
#   "resets 4am" would NEVER reach log_debug and would pass even against the old
#   code -- that is the trap this comment exists to flag.
#
#   To PROVE non-vacuity empirically (self-reports are not evidence), set
#   LOKI_RATELIMIT_TEST_OLD_LOGDEBUG=1: the harness rewrites the extracted
#   log_debug to the pre-fix stdout form, and this test then FAILS. With the
#   variable unset it uses the real run.sh definition and PASSES.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

# Extract a single top-level function (name() { ... }) from run.sh by name.
extract_fn() {
    awk -v fn="$1" '
        $0 ~ "^"fn"\\(\\) \\{" {f=1}
        f {print}
        f && /^}$/ {exit}
    ' "$RUN_SH" 2>/dev/null || true
}

# detect_rate_limit's full dependency set (else set -u trips on unbound funcs).
FNS=(log_debug is_rate_limited parse_claude_reset_time parse_retry_after calculate_rate_limit_backoff detect_rate_limit)
for fn in "${FNS[@]}"; do
    body="$(extract_fn "$fn")"
    if [ -z "$body" ]; then
        echo "SKIP: $fn not found in run.sh. (Not a fail.)"; exit 0
    fi
    # Non-vacuity lever: optionally regress log_debug to the OLD stdout form so
    # we can demonstrate this test FAILS against the pre-fix behavior.
    if [ "$fn" = "log_debug" ] && [ "${LOKI_RATELIMIT_TEST_OLD_LOGDEBUG:-0}" = "1" ]; then
        body='log_debug() { [[ "${LOKI_DEBUG:-}" == "true" ]] && echo -e "${CYAN}[DEBUG]${NC} $*" || true; }'
        echo "NOTE: using OLD (stdout) log_debug -- expecting this run to FAIL (non-vacuity check)"
    fi
    # shellcheck disable=SC1090
    eval "$body"
done

# Color vars referenced by log_debug's body (kept empty for the test).
CYAN=""
NC=""

for fn in "${FNS[@]}"; do
    type "$fn" >/dev/null 2>&1 || { echo "SKIP: $fn did not eval cleanly. (Not a fail.)"; exit 0; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-ratelimit-debug-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Fixed sample that routes through the calculated-backoff branch (fires
# log_debug). 429 + "too many requests"; NO reset time, NO retry-after number.
SAMPLE="$WORK/iter_output.log"
{
    printf 'some normal provider output line\n'
    printf 'HTTP 429: too many requests\n'
    printf 'trailing line\n'
} > "$SAMPLE"

# PROVIDER_NAME / PROVIDER_RATE_LIMIT_RPM are intentionally left unset: the real
# functions use ${PROVIDER_NAME:-claude} / ${PROVIDER_RATE_LIMIT_RPM:-50}, so
# this also confirms unset-under-set-u is safe (no eval/run errors).

# ---------------------------------------------------------------------------
# Assertion 1 (CORE): detect_rate_limit yields the SAME captured value with
# LOKI_DEBUG=true and with LOKI_DEBUG unset. Capture is stdout-only (the way the
# real caller consumes it via command substitution).
# ---------------------------------------------------------------------------
out_nodebug="$( unset LOKI_DEBUG 2>/dev/null || true; detect_rate_limit "$SAMPLE" 2>/dev/null )"
out_debug="$(   LOKI_DEBUG=true detect_rate_limit "$SAMPLE" 2>/dev/null )"

if [ "$out_debug" = "$out_nodebug" ]; then
    ok "detect_rate_limit identical with vs without LOKI_DEBUG (got '$out_nodebug')"
else
    bad "detect_rate_limit differs under LOKI_DEBUG" \
        "no-debug='$(printf '%q' "$out_nodebug")' debug='$(printf '%q' "$out_debug")'"
fi

# Sanity: the captured value must be a clean positive integer (the comparison
# the real code performs). This is exactly what the OLD stdout log_debug broke.
if [ "$out_debug" -gt 0 ] 2>/dev/null; then
    ok "captured value under LOKI_DEBUG is a clean positive integer ('$out_debug')"
else
    bad "captured value under LOKI_DEBUG is not a clean integer" "got '$(printf '%q' "$out_debug")'"
fi

# ---------------------------------------------------------------------------
# Assertion 2: with LOKI_DEBUG=true, the [DEBUG] line does NOT appear on stdout.
# (It is allowed -- and expected -- on stderr; we only forbid stdout.)
# ---------------------------------------------------------------------------
stdout_only="$( LOKI_DEBUG=true detect_rate_limit "$SAMPLE" 2>/dev/null )"
case "$stdout_only" in
    *"[DEBUG]"*) bad "log_debug leaked onto stdout under LOKI_DEBUG" "stdout='$(printf '%q' "$stdout_only")'" ;;
    *)           ok "no [DEBUG] text on stdout under LOKI_DEBUG" ;;
esac

# Positive control: prove the sample actually exercises the log_debug branch, so
# Assertion 2 is not vacuously true (the [DEBUG] line IS emitted, on stderr).
stderr_only="$( LOKI_DEBUG=true detect_rate_limit "$SAMPLE" 2>&1 1>/dev/null )"
case "$stderr_only" in
    *"[DEBUG]"*) ok "log_debug branch exercised: [DEBUG] present on stderr (test non-vacuous)" ;;
    *)           bad "sample never fired log_debug -- assertion 2 would be vacuous" "stderr='$(printf '%q' "$stderr_only")'" ;;
esac

echo
echo "ratelimit-debug-clean: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
