#!/usr/bin/env bash
#===============================================================================
# Proven PR -- advisory check-run tests (Loop 6 / v7.90.0)
#
# Targeted coverage for post_verified_completion_check in
# autonomy/lib/proof-check.sh: the OPT-IN, advisory-only GitHub check-run
# "loki: verified-completion" that maps the deterministic honesty headline 1:1
# to a check-run conclusion. Reference: internal/LOOP6-PROVEN-PR-PLAN.md (SDET
# tests T2, T3, T4 + honesty gates R-HON-5).
#
# SAFETY (NON-NEGOTIABLE -- the v7.72 real-tunnel burn): NO test ever posts a
# real check-run or opens a real PR. We prepend a FAKE `gh` stub to PATH that
# records its full argv to a capture file and returns canned output, then assert
# on the CAPTURED argv string. The real gh is never reached. Tests run against a
# temp HOME + temp dir, never the real one.
#
# THE FAKE-gh CALL SEQUENCE (binding, from the dev fleet review): the function
# calls, in order:
#   1. gh auth status            -> MUST exit 0, else it bails before posting and
#                                   a "nothing captured" T2 would pass vacuously.
#   2. gh repo view ...          -> MUST echo owner/repo (nameWithOwner).
#   3. gh pr view <url> ...      -> only when a pr_url is given; echoes a sha.
#   4. gh api ... repos/.../check-runs -> the actual post.
# The stub dispatches on $1 (auth/repo/pr/api) to satisfy every step so a
# captured check-runs POST is a TRUE positive. ANTI-VACUITY: T2/T4 assert the
# capture file is non-empty BEFORE asserting its contents.
#
# T3 GREP TRAP (binding): the advisory summary text literally contains the prose
# "as a required status check". A naive grep for the word `required` or
# `protection` would FALSE-FIRE. T3 matches ENDPOINT PATHS instead: it asserts
# no captured api arg contains '/protection', '/branches/', or
# 'required_status_checks' (underscores; the prose uses spaces), and that the
# ONLY gh api endpoint touched is 'check-runs'.
#
# ENV GATE PROXY: the LOKI_PROVEN_PR_CHECK=1 opt-in gate lives at the call site
# in run.sh, NOT inside proof-check.sh (the lib has no LOKI_PROVEN_PR_CHECK
# reference; see its header note "the call site guards on LOKI_PROVEN_PR_CHECK").
# T3/T4 model that documented call-site contract with a thin wrapper so we test
# the integrated behavior the integrator will wire.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROOF_CHECK_LIB="$PROJECT_DIR/autonomy/lib/proof-check.sh"

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
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-proven-pr-check.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Proven PR -- advisory check-run tests (Loop 6 / v7.90.0)"
echo "========================================================"
echo ""

if [ ! -f "$PROOF_CHECK_LIB" ]; then
    fail "lib present" "missing $PROOF_CHECK_LIB"
    echo ""
    echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
    exit 1
fi

# shellcheck disable=SC1090
. "$PROOF_CHECK_LIB"

if ! command -v post_verified_completion_check >/dev/null 2>&1; then
    fail "post_verified_completion_check defined" "function not found after sourcing lib"
    echo ""
    echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
    exit 1
fi

# -----------------------------------------------------------------------------
# Fake gh stub. Prepended to PATH. Records every invocation's argv to
# $GH_CAPTURE (one invocation per line, args space-joined) and returns canned
# output for each subcommand so the function reaches the check-runs POST.
# A fixed canned head sha is the tripwire: any other sha in a captured api call
# would mean the stub was bypassed.
# -----------------------------------------------------------------------------
STUBDIR="$WORKROOT/bin"
mkdir -p "$STUBDIR"
GH_CAPTURE="$WORKROOT/gh-argv.log"
: > "$GH_CAPTURE"

cat > "$STUBDIR/gh" <<'STUB'
#!/usr/bin/env bash
# Fake gh stub -- records argv, never touches the network. See test header.
{ printf '%s' "gh"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$GH_CAPTURE"
case "${1:-}" in
    auth)
        # gh auth status -> authenticated
        exit 0
        ;;
    repo)
        # gh repo view --json nameWithOwner -q .nameWithOwner
        printf '%s\n' "fakeowner/fakerepo"
        exit 0
        ;;
    pr)
        # gh pr view <url> --json headRefOid -q .headRefOid
        printf '%s\n' "prheadsha000111"
        exit 0
        ;;
    api)
        # gh api -X POST repos/.../check-runs ...
        printf '%s\n' '{"id":12345}'
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
STUB
chmod +x "$STUBDIR/gh"

# A fixed fake `timeout` is unnecessary: the lib's _proof_check_net wraps gh in
# `timeout 30 gh ...` when timeout exists; that is transparent to argv capture
# (the stub still records its own argv). We leave the host timeout in place.

# Also provide a fake glab guard absent: the function never calls glab, so we do
# not stub it. (The renderer's cmd_github glab branch is out of scope here.)

# Capture file path must be visible to the stub subprocess.
export GH_CAPTURE

# -----------------------------------------------------------------------------
# Proof fixtures for each headline.
# Each carries facts.git.head_sha so the empty-pr_url fallback
# (proof-check.sh:191-192) can resolve a head commit and reach the POST.
# -----------------------------------------------------------------------------
write_proof() {
    # $1 path, $2 headline
    local path="$1" headline="$2"
    cat > "$path" <<JSON
{
  "run_id": "run-check-0001",
  "honesty": { "headline": "$headline" },
  "facts": {
    "git": { "head_sha": "proofhead999888", "base_sha": "proofbase111" }
  }
}
JSON
}

VERIFIED_PROOF="$WORKROOT/verified.json"
GAPS_PROOF="$WORKROOT/gaps.json"
NOTV_PROOF="$WORKROOT/notv.json"
UNKNOWN_PROOF="$WORKROOT/unknown.json"
write_proof "$VERIFIED_PROOF" "VERIFIED"
write_proof "$GAPS_PROOF" "VERIFIED WITH GAPS"
write_proof "$NOTV_PROOF" "NOT VERIFIED"
# Unknown headline -> must post NOTHING.
cat > "$UNKNOWN_PROOF" <<'JSON'
{ "run_id": "run-check-unk", "honesty": { "headline": "WHATEVER" },
  "facts": { "git": { "head_sha": "x", "base_sha": "y" } } }
JSON

# -----------------------------------------------------------------------------
# CALL-SITE GUARD PROXY for the LOKI_PROVEN_PR_CHECK=1 opt-in (lives in run.sh,
# not the lib). Models LOOP6-PROVEN-PR-PLAN.md B1: without the flag, NO check is
# posted; with the flag, the function runs.
# -----------------------------------------------------------------------------
maybe_check() {
    if [ "${LOKI_PROVEN_PR_CHECK:-}" = "1" ]; then
        post_verified_completion_check "$@"
        return 0
    fi
    return 0
}

# Helper: run with the fake gh on PATH front.
run_with_fake_gh() {
    PATH="$STUBDIR:$PATH" "$@"
}

# =============================================================================
# T2 -- check-run conclusion maps 1:1 from headline (success/neutral/failure).
# For each headline, run the function (opt-in modeled via direct call) with the
# fake gh and assert the captured api call carries the EXACT conclusion=<value>.
# We grep the token conclusion=<value>, never a bare word (the summary echoes
# the headline string, so a bare 'success' could appear in prose).
# =============================================================================
echo "T2 -- check-run conclusion maps 1:1 from headline"

assert_conclusion() {
    # $1 proof, $2 expected conclusion, $3 label
    local proof="$1" expected="$2" label="$3"
    : > "$GH_CAPTURE"
    run_with_fake_gh post_verified_completion_check "$proof" "" >/dev/null 2>&1
    if [ ! -s "$GH_CAPTURE" ]; then
        fail "T2 $label: no gh call captured at all" \
            "function bailed before posting (auth/repo/head resolution); cannot be a true positive"
        return
    fi
    local api_line
    api_line="$(grep -E '^gh api ' "$GH_CAPTURE" || true)"
    if [ -z "$api_line" ]; then
        fail "T2 $label: no 'gh api' check-runs POST captured" \
            "captured: $(cat "$GH_CAPTURE")"
        return
    fi
    if printf '%s\n' "$api_line" | grep -q "conclusion=${expected}"; then
        pass "T2 $label: captured api call carries conclusion=${expected}"
    else
        fail "T2 $label: expected conclusion=${expected} not in captured api call" \
            "api line: $api_line"
    fi
    # Cross-guard: the WRONG conclusions must NOT appear in the api flags.
    local w
    for w in success neutral failure; do
        [ "$w" = "$expected" ] && continue
        if printf '%s\n' "$api_line" | grep -q "conclusion=${w}"; then
            fail "T2 $label: a WRONG conclusion=${w} also present" "api line: $api_line"
        fi
    done
}

assert_conclusion "$VERIFIED_PROOF" "success" "VERIFIED -> success"
assert_conclusion "$GAPS_PROOF" "neutral" "VERIFIED WITH GAPS -> neutral"
assert_conclusion "$NOTV_PROOF" "failure" "NOT VERIFIED -> failure"

# Honesty floor: an unknown/missing headline posts NOTHING (no fabricated
# conclusion). Part of the 1:1 mapping contract (R-HON-5).
: > "$GH_CAPTURE"
run_with_fake_gh post_verified_completion_check "$UNKNOWN_PROOF" "" >/dev/null 2>&1
if [ -s "$GH_CAPTURE" ]; then
    fail "T2 unknown headline: a gh call was made despite unknown headline" \
        "captured: $(cat "$GH_CAPTURE")"
else
    pass "T2 unknown headline: NO gh call (no fabricated conclusion)"
fi

# Same for a missing proof file.
: > "$GH_CAPTURE"
run_with_fake_gh post_verified_completion_check "$WORKROOT/nope.json" "" >/dev/null 2>&1
if [ -s "$GH_CAPTURE" ]; then
    fail "T2 missing proof: a gh call was made despite missing proof" \
        "captured: $(cat "$GH_CAPTURE")"
else
    pass "T2 missing proof: NO gh call"
fi
echo ""

# =============================================================================
# T3 -- advisory does not block merge.
# Default path (LOKI_PROVEN_PR_CHECK unset) posts NO check-run, AND Loki never
# calls any branch-protection / required-status API on ANY path.
# =============================================================================
echo "T3 -- advisory does not block merge (no check by default, no protection API ever)"

# Default path: gate unset -> maybe_check is a no-op -> zero gh calls.
: > "$GH_CAPTURE"
unset LOKI_PROVEN_PR_CHECK 2>/dev/null || true
run_with_fake_gh maybe_check "$VERIFIED_PROOF" "" >/dev/null 2>&1
if [ -s "$GH_CAPTURE" ]; then
    fail "T3 default path: a gh call was made with LOKI_PROVEN_PR_CHECK unset" \
        "captured: $(cat "$GH_CAPTURE")"
else
    pass "T3 default path: LOKI_PROVEN_PR_CHECK unset posts NO check-run (zero gh calls)"
fi

# Even when the function DOES run (opt-in), it must never touch a
# branch-protection / required-status endpoint. Run all three headlines and
# inspect EVERY captured api arg for protection-shaped endpoint paths.
: > "$GH_CAPTURE"
run_with_fake_gh post_verified_completion_check "$VERIFIED_PROOF" "" >/dev/null 2>&1
run_with_fake_gh post_verified_completion_check "$GAPS_PROOF" "" >/dev/null 2>&1
run_with_fake_gh post_verified_completion_check "$NOTV_PROOF" "" >/dev/null 2>&1

# Match ENDPOINT PATHS, not prose. The summary text contains "as a required
# status check" (spaces), so we look for the API forms with slashes/underscores.
if grep -Eq '/protection|/branches/|required_status_checks' "$GH_CAPTURE"; then
    fail "T3 protection API: a branch-protection / required-status endpoint was called" \
        "offending: $(grep -E '/protection|/branches/|required_status_checks' "$GH_CAPTURE")"
else
    pass "T3 protection API: no /protection, /branches/, or required_status_checks endpoint ever called"
fi

# Positive cross-check: the ONLY gh api endpoint touched is check-runs.
non_checkruns_api="$(grep -E '^gh api ' "$GH_CAPTURE" | grep -Ev 'check-runs' || true)"
if [ -n "$non_checkruns_api" ]; then
    fail "T3 endpoint scope: a gh api call hit an endpoint other than check-runs" \
        "offending: $non_checkruns_api"
else
    pass "T3 endpoint scope: the only gh api endpoint used is check-runs (advisory write only)"
fi

# Sanity: the summary prose 'as a required status check' IS present in the
# captured POST (it is the honest 'how to make it blocking' note) -- this proves
# the T3 grep correctly ignores PROSE and only flags endpoint paths.
if grep -q 'as a required status check' "$GH_CAPTURE"; then
    pass "T3 grep-trap proof: prose 'as a required status check' is in the body yet T3 did not false-fire (path-based match works)"
else
    fail "T3 grep-trap proof: expected the honest 'required status check' note in the summary" \
        "fixture/lib drift; captured: $(cat "$GH_CAPTURE")"
fi
echo ""

# =============================================================================
# T4 -- opt-in posts the check.
# LOKI_PROVEN_PR_CHECK=1 + fake gh -> the check-run create call IS issued
# (captured argv shows the check-runs POST).
# =============================================================================
echo "T4 -- opt-in (LOKI_PROVEN_PR_CHECK=1) issues the check-runs POST"

: > "$GH_CAPTURE"
LOKI_PROVEN_PR_CHECK=1 run_with_fake_gh maybe_check "$VERIFIED_PROOF" "" >/dev/null 2>&1
if [ ! -s "$GH_CAPTURE" ]; then
    fail "T4 opt-in: no gh call captured even with LOKI_PROVEN_PR_CHECK=1" \
        "function did not run or bailed early"
else
    if grep -E '^gh api ' "$GH_CAPTURE" | grep -q 'check-runs'; then
        pass "T4 opt-in: a check-runs POST was issued under LOKI_PROVEN_PR_CHECK=1"
    else
        fail "T4 opt-in: gh called but no check-runs POST captured" \
            "captured: $(cat "$GH_CAPTURE")"
    fi
fi

# Confirm the POST carries the advisory name and the head sha (from the proof
# fallback, since pr_url is empty). This proves it targets the right commit.
api_line="$(grep -E '^gh api ' "$GH_CAPTURE" | grep 'check-runs' || true)"
if printf '%s\n' "$api_line" | grep -q 'name=loki: verified-completion'; then
    pass "T4 opt-in: POST carries name='loki: verified-completion'"
else
    fail "T4 opt-in: advisory check-run name missing from POST" "api line: $api_line"
fi
if printf '%s\n' "$api_line" | grep -q 'head_sha=proofhead999888'; then
    pass "T4 opt-in: POST targets the proof's head sha (empty-pr_url fallback)"
else
    fail "T4 opt-in: POST head_sha not the proof fallback" "api line: $api_line"
fi
echo ""

echo "========================================================"
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
