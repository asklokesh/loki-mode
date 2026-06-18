#!/usr/bin/env bash
#
# test-council-member-timeout-wave10.sh
#
# WAVE10 SAFE-DEFAULT regression: a provider review TIMEOUT in
# council_member_review must default to REJECT, never fall through to the
# APPROVE-leaning council_heuristic_review.
#
# Bug (autonomy/completion-council.sh, council_member_review): the provider
# subcall is timeout-guarded, and on timeout it returns empty output. The old
# code routed that empty output straight into council_heuristic_review, whose
# default is VOTE:APPROVE for benign evidence (PRD present, "test" mentioned,
# <=5 TODO files). On the dashboard force-review route (run.sh:16463) this let a
# 2-of-3 heuristic APPROVE mark the project COMPLETE after every provider voter
# silently timed out -- the exact opposite of the required safe default for a
# completion trust surface.
#
# This test sources the REAL council_member_review, puts a hung `claude` shim on
# PATH that outlasts a 1s LOKI_COUNCIL_REVIEW_TIMEOUT, and asserts:
#   1. timeout -> the returned verdict is a clean canonical REJECT (parsed by the
#      real _council_parse_vote), NOT APPROVE.
#   2. no-provider degraded mode is UNCHANGED: with no claude on PATH the
#      heuristic fallback still runs and returns its (APPROVE) verdict for benign
#      evidence -- proving the fix is scoped to timeouts, not all empty output.
#
# Non-vacuity: assertion (1) fails against the pre-fix code (which returns the
# heuristic APPROVE on timeout).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find $COUNCIL_SH"
    exit 1
fi

# Minimal log stubs so the council script's log_* calls are no-ops when sourced.
log_info() { :; }
log_warn() { :; }
log_error() { :; }
log_header() { :; }
log_debug() { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1 || true

if ! type council_member_review >/dev/null 2>&1; then
    echo "FAIL: council_member_review not defined after sourcing $COUNCIL_SH"
    exit 1
fi
if ! type _council_parse_vote >/dev/null 2>&1; then
    echo "FAIL: _council_parse_vote not defined after sourcing $COUNCIL_SH"
    exit 1
fi

PASS=0
FAIL=0

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-cc-timeout-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Benign evidence that drives council_heuristic_review to APPROVE for the
# requirements_verifier role (PRD present, no pending tasks).
mkdir -p "$WORK/vote"
cat > "$WORK/evidence.md" <<'EOF'
# PRD
Build a simple todo app.

## Tasks
pending: 0

## Tests
test suite present, all spec files passing
EOF

# ---------------------------------------------------------------------------
# Case 1: provider TIMEOUT must yield REJECT (not heuristic APPROVE).
# ---------------------------------------------------------------------------
mkdir -p "$WORK/fakebin"
cat > "$WORK/fakebin/claude" <<'EOF'
#!/usr/bin/env bash
# Hung provider: sleeps well past the 1s council timeout, then would have
# emitted an APPROVE -- but timeout kills it first, yielding empty output.
sleep 30
echo "VOTE: APPROVE"
EOF
chmod +x "$WORK/fakebin/claude"

(
    export PATH="$WORK/fakebin:$PATH"
    export PROVIDER_NAME=claude
    export LOKI_COUNCIL_REVIEW_TIMEOUT=1
    export LOKI_COUNCIL_SEVERITY_THRESHOLD=low
    export LOKI_BLIND_VALIDATION=false
    # Disable the bare/guard helper lookups (not defined here) -- they are
    # type-guarded in the source, so absence is fine.
    verdict="$(council_member_review 1 requirements_verifier "$WORK/evidence.md" "$WORK/vote")"
    parsed="$(_council_parse_vote "$verdict")"
    if [ "$parsed" = "REJECT" ]; then
        echo "PASS  timeout -> REJECT (parsed [$parsed])"
        exit 0
    else
        echo "FAIL  timeout -> expected REJECT, got verdict:"
        printf '%s\n' "$verdict" | sed 's/^/        /'
        echo "        parsed=[$parsed]"
        exit 1
    fi
)
if [ $? -eq 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

# ---------------------------------------------------------------------------
# Case 2: an INSTALLED provider that exits 0 with empty output (genuinely
# returned nothing, NOT a timeout) must still reach the heuristic fallback
# UNCHANGED -- proving the fix is scoped to the timeout exit codes (124/137/143)
# and does not blanket-REJECT every empty verdict. For benign
# requirements_verifier evidence the heuristic returns APPROVE.
#
# (Note: when NO provider CLI is installed at all, council_member_review returns
# early via the command -v guard and never reaches the heuristic; the heuristic
# fallback is only reachable when the provider IS present but returns empty.)
# ---------------------------------------------------------------------------
cat > "$WORK/fakebin/claude-empty" <<'EOF'
#!/usr/bin/env bash
# Installed provider that immediately exits 0 producing no output.
exit 0
EOF
# Re-point the `claude` shim to the immediate-empty variant for this case.
cp "$WORK/fakebin/claude-empty" "$WORK/fakebin/claude"
chmod +x "$WORK/fakebin/claude"
(
    export PATH="$WORK/fakebin:$PATH"
    export PROVIDER_NAME=claude
    export LOKI_COUNCIL_REVIEW_TIMEOUT=30
    export LOKI_COUNCIL_SEVERITY_THRESHOLD=low
    export LOKI_BLIND_VALIDATION=false
    verdict="$(council_member_review 1 requirements_verifier "$WORK/evidence.md" "$WORK/vote")"
    parsed="$(_council_parse_vote "$verdict")"
    if [ "$parsed" = "APPROVE" ]; then
        echo "PASS  provider-empty(rc=0) -> heuristic APPROVE preserved (parsed [$parsed])"
        exit 0
    else
        echo "FAIL  provider-empty(rc=0) -> expected heuristic APPROVE, got verdict:"
        printf '%s\n' "$verdict" | sed 's/^/        /'
        echo "        parsed=[$parsed]"
        exit 1
    fi
)
if [ $? -eq 0 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi

echo
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
echo "ALL TESTS PASSED"
exit 0
