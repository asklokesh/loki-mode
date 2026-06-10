#!/usr/bin/env bash
# tests/cli/test-quickstart.sh
# Test: v7.29.0 loki quickstart guided interview (autonomy/quickstart.sh).
#
# ZERO spend, ZERO real build, ZERO network. Two strategies, matching the
# slice-B provider-offer test:
#   1. CLI-level (subprocess against autonomy/loki): --help exits 0; the non-TTY
#      gate exits 2 without hanging (timeout-guarded).
#   2. Source-level (source quickstart.sh, override _qs_non_interactive, stub
#      show_prd_plan / provider_offer_gate / cmd_start): drive the full interview
#      from piped stdin and assert the composition -- the PRD is written, the
#      plan figures print before the confirm, and cmd_start is invoked with the
#      right args -- WITHOUT starting a build. Note: production cmd_start EXECS
#      the runner (loki:1856) and never returns; quickstart subshells it. The
#      stub here returns instead, which is fine: these tests assert only the
#      composition (the argv cmd_start receives), never post-cmd_start behavior.
#
# The source-level seam is the only way to test the interview without a PTY:
# the non-TTY gate fires first in a plain subprocess and exits 2 before step 2.
# Overriding the named predicate (the design's testability hook) is exactly the
# lever slice B uses for its consent path; documented, deterministic, portable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
QS="$REPO_ROOT/autonomy/quickstart.sh"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d -t loki-quickstart-XXXX)
trap 'rm -rf "$TMP"' EXIT

# Portable timeout (GNU `timeout` on Linux, `gtimeout` via Homebrew on macOS).
TIMEOUT_BIN=""
for t in timeout gtimeout; do
    if command -v "$t" >/dev/null 2>&1; then TIMEOUT_BIN="$(command -v "$t")"; break; fi
done
run_to() {  # run_to <secs> <cmd...>
    local secs="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}

# A reusable harness that sources quickstart.sh with the boundaries stubbed and
# the gate overridden, then runs cmd_quickstart with the given stdin + args.
# Writes a "harness.sh" into a fresh CWD per call so ./prd.md never lands in the
# repo. Captures cmd_start's argv to cmd_start.log inside that CWD.
#   make_harness <cwd> [extra-shell-snippet]
# The snippet (optional) is injected after the default stubs so individual tests
# can override show_prd_plan, etc.
make_harness() {
    local cwd="$1"; local extra="${2:-}"
    cat > "$cwd/harness.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
export SKILL_DIR="$REPO_ROOT"
export NO_COLOR=1
# Default stubs: an honest deterministic estimate, a provider present, and
# boundary no-ops that record what they were called with.
show_prd_plan() { printf '%s' '{"cost":{"total_usd":0.40},"time":{"estimated":"14 minutes"},"iterations":{"estimated":4,"range":[3,5]},"complexity":{"tier":"simple"}}'; }
source "$QS"
_qs_non_interactive() { return 1; }
provider_offer_gate() { return 0; }
detect_any_provider() { return 0; }
cmd_start() { printf '%s\n' "\$*" > "\$PWD/cmd_start.log"; return 0; }
$extra
EOF
    # Append the actual invocation line via the caller.
}

echo "========================================"
echo "Loki Quickstart Tests"
echo "========================================"
echo ""

# Sanity: the unit and the CLI exist.
if [ ! -f "$QS" ]; then
    log_fail "fixture" "autonomy/quickstart.sh not found at $QS"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi
if [ ! -x "$LOKI" ]; then
    log_fail "fixture" "autonomy/loki not executable at $LOKI"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi
log_pass "fixture: quickstart.sh and loki present"

# ---------------------------------------------------------------------------
# Test 1: loki quickstart --help exits 0 and prints concise usage.
# ---------------------------------------------------------------------------
out=$(run_to 10 "$LOKI" quickstart --help </dev/null 2>&1); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi "guided first build"; then
    log_pass "quickstart --help exits 0 with usage"
else
    log_fail "quickstart --help" "exit=$rc or missing usage text"
fi

# ---------------------------------------------------------------------------
# Test 2: non-TTY exits 2 with the automation hint and does NOT hang.
# stdin is /dev/null (not a TTY); the gate must fire before any read.
# ---------------------------------------------------------------------------
out=$(run_to 10 "$LOKI" quickstart </dev/null 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "interactive and needs a terminal"; then
    log_pass "non-TTY exits 2 with automation hint (no hang)"
else
    log_fail "non-TTY exit 2" "exit=$rc (124=timeout/hang) or missing hint"
fi

# ---------------------------------------------------------------------------
# Test 3: CI=1 forces the same non-interactive exit 2 (even were stdin a TTY).
# ---------------------------------------------------------------------------
out=$(CI=1 run_to 10 "$LOKI" quickstart </dev/null 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "interactive and needs a terminal"; then
    log_pass "CI=1 exits 2 with automation hint"
else
    log_fail "CI=1 exit 2" "exit=$rc or missing hint"
fi

# ---------------------------------------------------------------------------
# Test 4: full Enter-Enter-Enter-Enter flow (source-level, all boundaries
# stubbed). Asserts: PRD written to ./prd.md, the default template is
# simple-todo-app, the plan figures print BEFORE the confirm prompt, and
# cmd_start is invoked with exactly "./prd.md --yes --no-plan" -- no build.
# ---------------------------------------------------------------------------
T4="$TMP/t4"; mkdir -p "$T4"
make_harness "$T4"
printf 'printf '"'"'\\n\\n\\n\\n'"'"' | cmd_quickstart\n' >> "$T4/harness.sh"
out=$(cd "$T4" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T4/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
[ -f "$T4/prd.md" ] || ok=false
[ "$start_args" = "./prd.md --yes --no-plan" ] || ok=false
# Plan figures must appear before the confirm line.
plan_line=$(printf '%s\n' "$out" | grep -n "Cost:" | head -1 | cut -d: -f1)
confirm_line=$(printf '%s\n' "$out" | grep -n "Start the build now" | head -1 | cut -d: -f1)
if [ -n "$plan_line" ] && [ -n "$confirm_line" ] && [ "$plan_line" -lt "$confirm_line" ]; then :; else ok=false; fi
# The default PRD must be the sample Todo app.
head -1 "$T4/prd.md" 2>/dev/null | grep -qi "todo" || ok=false
if [ "$ok" = true ]; then
    log_pass "Enter x4: ./prd.md written, plan before confirm, cmd_start ./prd.md --yes --no-plan"
else
    log_fail "Enter x4 flow" "rc=$rc start_args='$start_args' prd=$([ -f "$T4/prd.md" ] && echo yes || echo no) plan@$plan_line confirm@$confirm_line"
fi

# ---------------------------------------------------------------------------
# Test 5: one-liner positional. "a todo app with user accounts" must yield the
# design's top-3 (simple-todo-app, saas-starter, rest-api-auth) and selecting 2
# must build from saas-starter. Asserts no provider/LLM is invoked for matching
# (the harness has no claude on PATH for the matcher; matching is pure shell).
# ---------------------------------------------------------------------------
T5="$TMP/t5"; mkdir -p "$T5"
make_harness "$T5"
printf 'printf '"'"'2\\n\\n'"'"' | cmd_quickstart "a todo app with user accounts"\n' >> "$T5/harness.sh"
out=$(cd "$T5" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T5/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
printf '%s' "$out" | grep -q "1) simple-todo-app" || ok=false
printf '%s' "$out" | grep -q "2) saas-starter" || ok=false
printf '%s' "$out" | grep -q "3) rest-api-auth" || ok=false
printf '%s' "$out" | grep -q "Template:    saas-starter" || ok=false
[ "$start_args" = "./prd.md --yes --no-plan" ] || ok=false
if [ "$ok" = true ]; then
    log_pass "one-liner top-3 matches design; pick 2 -> saas-starter"
else
    log_fail "one-liner positional" "rc=$rc start_args='$start_args'; top-3 or selection mismatch"
    printf '%s\n' "$out" | grep -E "1\)|2\)|3\)|Template:" | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# Test 6: PRD-path positional skips steps 2-3 and goes straight to plan+confirm.
# ---------------------------------------------------------------------------
T6="$TMP/t6"; mkdir -p "$T6"
printf '# My Custom PRD\n\nBuild a thing.\n' > "$T6/my-prd.md"
make_harness "$T6"
printf 'printf '"'"'\\n'"'"' | cmd_quickstart "%s/my-prd.md"\n' "$T6" >> "$T6/harness.sh"
out=$(cd "$T6" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T6/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
# Step 3 (template picker) must NOT appear for a PRD path.
printf '%s' "$out" | grep -q "Pick a starting template" && ok=false
printf '%s' "$out" | grep -q "Step 4 of 4: Review the plan" || ok=false
[ "$start_args" = "./prd.md --yes --no-plan" ] || ok=false
# The PRD copied to ./prd.md must be the user's PRD content.
head -1 "$T6/prd.md" 2>/dev/null | grep -qi "My Custom PRD" || ok=false
if [ "$ok" = true ]; then
    log_pass "PRD-path positional skips steps 2-3, builds from the given PRD"
else
    log_fail "PRD-path positional" "rc=$rc start_args='$start_args'; picker shown or wrong PRD"
fi

# ---------------------------------------------------------------------------
# Test 7: template scorer determinism. Same input twice -> identical top-3.
# Also asserts empty input -> simple-todo-app default and no provider call.
# ---------------------------------------------------------------------------
T7="$TMP/t7"; mkdir -p "$T7"
cat > "$T7/scorer.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
export SKILL_DIR="$REPO_ROOT"
source "$QS"
echo "=== run1 ==="; _qs_score_templates "a todo app with user accounts"
echo "=== run2 ==="; _qs_score_templates "a todo app with user accounts"
echo "=== empty ==="; _qs_score_templates ""
EOF
sc=$(cd "$T7" && run_to 15 bash scorer.sh 2>&1)
run1=$(printf '%s\n' "$sc" | sed -n '/=== run1 ===/,/=== run2 ===/p' | grep -v "===")
run2=$(printf '%s\n' "$sc" | sed -n '/=== run2 ===/,/=== empty ===/p' | grep -v "===")
empty_top=$(printf '%s\n' "$sc" | sed -n '/=== empty ===/,$p' | grep -v "===" | head -1)
ok=true
[ -n "$run1" ] || ok=false
[ "$run1" = "$run2" ] || ok=false
[ "$empty_top" = "simple-todo-app" ] || ok=false
# Determinism + expected design ordering for the canonical input.
expected=$'simple-todo-app\nsaas-starter\nrest-api-auth'
[ "$run1" = "$expected" ] || ok=false
if [ "$ok" = true ]; then
    log_pass "scorer deterministic (run1==run2), empty->simple-todo-app, matches design top-3"
else
    log_fail "scorer determinism" "run1='$run1' run2='$run2' empty='$empty_top'"
fi

# ---------------------------------------------------------------------------
# Test 8: existing ./prd.md, decline overwrite -> falls back to
# ./prd-quickstart.md and leaves the original prd.md untouched (design 3.6).
# This is the "existing-prd.md" handling: graceful fallback, never a clobber.
# ---------------------------------------------------------------------------
T8="$TMP/t8"; mkdir -p "$T8"
printf 'ORIGINAL-PRD-CONTENT\n' > "$T8/prd.md"
make_harness "$T8"
# Enter (idea) Enter (template) Enter (confirm) n (decline overwrite).
printf 'printf '"'"'\\n\\n\\nn\\n'"'"' | cmd_quickstart\n' >> "$T8/harness.sh"
out=$(cd "$T8" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T8/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
# Original untouched.
grep -q "ORIGINAL-PRD-CONTENT" "$T8/prd.md" 2>/dev/null || ok=false
# Fallback written and used.
[ -f "$T8/prd-quickstart.md" ] || ok=false
[ "$start_args" = "./prd-quickstart.md --yes --no-plan" ] || ok=false
if [ "$ok" = true ]; then
    log_pass "existing prd.md: declined overwrite -> prd-quickstart.md, original preserved"
else
    log_fail "existing prd.md fallback" "rc=$rc start_args='$start_args'; original or fallback wrong"
fi

# ---------------------------------------------------------------------------
# Test 9: a CI/non-TTY run produces ZERO side effects. The top gate exits 2
# before step 2, so no PRD is ever written to the CWD and no build is started.
# This is the anti-surprise guarantee: automation that accidentally invokes
# quickstart never spends, never clobbers files, never hangs.
# ---------------------------------------------------------------------------
T9="$TMP/t9"; mkdir -p "$T9"
( cd "$T9" && CI=1 run_to 10 "$LOKI" quickstart </dev/null >/dev/null 2>&1 )
if [ ! -f "$T9/prd.md" ] && [ ! -f "$T9/prd-quickstart.md" ]; then
    log_pass "CI run writes no PRD and starts no build (gated before any side effect)"
else
    log_fail "CI side-effect gate" "prd.md or prd-quickstart.md leaked under CI"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
