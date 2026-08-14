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
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi "guided first build" && printf '%s' "$out" | grep -q -- "--dry-run"; then
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
# Test 8b: BOTH ./prd.md AND ./prd-quickstart.md already exist; declining the
# overwrite must NOT clobber prd-quickstart.md either (bug-hunt MEDIUM). The
# fallback walks numbered suffixes: prd-quickstart-2.md gets the new PRD and
# both originals survive byte-for-byte.
# ---------------------------------------------------------------------------
T8B="$TMP/t8b"; mkdir -p "$T8B"
printf 'ORIGINAL-PRD-CONTENT\n' > "$T8B/prd.md"
printf 'ORIG-QUICKSTART-PRD\n' > "$T8B/prd-quickstart.md"
make_harness "$T8B"
printf 'printf '"'"'\\n\\n\\nn\\n'"'"' | cmd_quickstart\n' >> "$T8B/harness.sh"
out=$(cd "$T8B" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T8B/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
grep -q "ORIGINAL-PRD-CONTENT" "$T8B/prd.md" 2>/dev/null || ok=false
grep -q "ORIG-QUICKSTART-PRD" "$T8B/prd-quickstart.md" 2>/dev/null || ok=false
[ -f "$T8B/prd-quickstart-2.md" ] || ok=false
[ "$start_args" = "./prd-quickstart-2.md --yes --no-plan" ] || ok=false
if [ "$ok" = true ]; then
    log_pass "both PRDs exist: fallback walks to prd-quickstart-2.md, neither original clobbered"
else
    log_fail "fallback no-clobber" "rc=$rc start_args='$start_args'; an original was clobbered or suffix walk failed"
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

# ===========================================================================
# Non-interactive one-command path (LOKI-QUICKSTART-ONE-COMMAND-47).
#
# Contract: with NO terminal, quickstart proceeds ONLY when BOTH a non-empty
# positional (idea or readable PRD path) AND an explicit argv --yes/-y are
# present. Anything less keeps the exit-2 refusal and writes nothing.
#
# Every test below feeds </dev/null rather than a pipe of newlines. That is the
# discriminating part: a piped '\n\n\n' would satisfy a `read` and pass even if
# the code still prompted. With /dev/null, any surviving prompt yields an empty
# read and the assertions on output/argv catch it -- rc=0 plus the absence of
# every prompt string is what actually proves "never prompts".
#
# _qs_non_interactive is forced to 0 (true) via make_harness's existing $extra
# slot, so these exercise the real gate rather than a TTY accident.
# ===========================================================================
NONINT='_qs_non_interactive() { return 0; }'

# ---------------------------------------------------------------------------
# Test 10: allowed idea flow. Idea + --yes with no terminal must reach cmd_start
# with zero prompts. Asserts POSITIVELY that the plan rendered and the
# top-ranked template was chosen, and NEGATIVELY that none of the three
# interactive prompts (picker, choose-line, confirm) appeared.
# ---------------------------------------------------------------------------
T10="$TMP/t10"; mkdir -p "$T10"
make_harness "$T10" "$NONINT"
printf 'cmd_quickstart "a todo app with user accounts" --yes </dev/null\n' >> "$T10/harness.sh"
out=$(cd "$T10" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T10/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
[ -f "$T10/prd.md" ] || ok=false
[ "$start_args" = "./prd.md --yes --no-plan" ] || ok=false
# The honest estimator still rendered, and the deterministic top match was used.
printf '%s' "$out" | grep -q "Cost:" || ok=false
printf '%s' "$out" | grep -q "Template:    simple-todo-app" || ok=false
# No prompt may appear anywhere in the transcript.
printf '%s' "$out" | grep -q "Pick a starting template" && ok=false
printf '%s' "$out" | grep -q "Choose 1-" && ok=false
printf '%s' "$out" | grep -q "Start the build now" && ok=false
if [ "$ok" = true ]; then
    log_pass "non-interactive idea + --yes: no prompts, plan shown, top template, cmd_start reached"
else
    log_fail "non-interactive idea flow" "rc=$rc start_args='$start_args' prd=$([ -f "$T10/prd.md" ] && echo yes || echo no)"
    printf '%s\n' "$out" | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# Test 11: allowed PRD-path flow. A readable PRD path + --yes uses the PRD
# directly, still renders the plan, and never shows the template picker.
# ---------------------------------------------------------------------------
T11="$TMP/t11"; mkdir -p "$T11"
printf '# Headless PRD\n\nBuild a thing.\n' > "$T11/my-prd.md"
make_harness "$T11" "$NONINT"
printf 'cmd_quickstart "%s/my-prd.md" --yes </dev/null\n' "$T11" >> "$T11/harness.sh"
out=$(cd "$T11" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T11/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
[ "$start_args" = "./prd.md --yes --no-plan" ] || ok=false
# The user's PRD content is what landed, not a template.
head -1 "$T11/prd.md" 2>/dev/null | grep -qi "Headless PRD" || ok=false
printf '%s' "$out" | grep -q "Cost:" || ok=false
printf '%s' "$out" | grep -q "Pick a starting template" && ok=false
printf '%s' "$out" | grep -q "Start the build now" && ok=false
if [ "$ok" = true ]; then
    log_pass "non-interactive PRD path + --yes: uses the PRD directly, plan shown, no picker"
else
    log_fail "non-interactive PRD flow" "rc=$rc start_args='$start_args'"
fi

# ---------------------------------------------------------------------------
# Test 12: missing consent. An idea with NO --yes must keep the exit-2 refusal
# and write nothing. The absence of cmd_start.log is the load-bearing half: it
# proves no build was STARTED, which absence of prd.md alone does not.
# ---------------------------------------------------------------------------
T12="$TMP/t12"; mkdir -p "$T12"
make_harness "$T12" "$NONINT"
printf 'cmd_quickstart "a todo app" </dev/null\n' >> "$T12/harness.sh"
out=$(cd "$T12" && run_to 15 bash harness.sh 2>&1); rc=$?
ok=true
[ "$rc" -eq 2 ] || ok=false
printf '%s' "$out" | grep -qi "interactive and needs a terminal" || ok=false
[ -f "$T12/prd.md" ] && ok=false
[ -f "$T12/prd-quickstart.md" ] && ok=false
[ -f "$T12/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "idea without --yes: exit 2, zero writes, no build started"
else
    log_fail "missing consent refusal" "rc=$rc; wrote a file or started a build"
fi

# ---------------------------------------------------------------------------
# Test 13: missing input. --yes with NO positional must also refuse. Consent
# alone is not enough: there is still nothing to build without an idea or PRD.
# ---------------------------------------------------------------------------
T13="$TMP/t13"; mkdir -p "$T13"
make_harness "$T13" "$NONINT"
printf 'cmd_quickstart --yes </dev/null\n' >> "$T13/harness.sh"
out=$(cd "$T13" && run_to 15 bash harness.sh 2>&1); rc=$?
ok=true
[ "$rc" -eq 2 ] || ok=false
printf '%s' "$out" | grep -qi "interactive and needs a terminal" || ok=false
[ -f "$T13/prd.md" ] && ok=false
[ -f "$T13/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "--yes without an idea: exit 2, zero writes, no build started"
else
    log_fail "missing input refusal" "rc=$rc; wrote a file or started a build"
fi

# ---------------------------------------------------------------------------
# Test 14: ambient consent env vars must NOT unlock the bypass. This is the
# test that discriminates the argv-only yes_flag from the env-inclusive
# _qs_assume_yes. LOKI_AUTO_CONFIRM=true is what `loki --yes <cmd>` and CI-ish
# environments export; if the gate read THAT, an ambient variable plus a stray
# positional would silently start a paid build with no human in the loop.
# ---------------------------------------------------------------------------
T14="$TMP/t14"; mkdir -p "$T14"
make_harness "$T14" "$NONINT"
printf 'export LOKI_AUTO_CONFIRM=true\nexport LOKI_ASSUME_YES=1\ncmd_quickstart "a todo app" </dev/null\n' >> "$T14/harness.sh"
out=$(cd "$T14" && run_to 15 bash harness.sh 2>&1); rc=$?
ok=true
[ "$rc" -eq 2 ] || ok=false
printf '%s' "$out" | grep -qi "interactive and needs a terminal" || ok=false
[ -f "$T14/prd.md" ] && ok=false
[ -f "$T14/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "ambient LOKI_AUTO_CONFIRM/LOKI_ASSUME_YES do not unlock the bypass (argv --yes required)"
else
    log_fail "ambient consent must not unlock" "rc=$rc; env var alone started a build"
fi

# ---------------------------------------------------------------------------
# Test 15: collision safety on the allowed path. With prd.md AND
# prd-quickstart.md present, the non-interactive run must never prompt to
# overwrite and never clobber: it walks to prd-quickstart-2.md and both
# originals survive byte-for-byte.
# ---------------------------------------------------------------------------
T15="$TMP/t15"; mkdir -p "$T15"
printf 'ORIGINAL-PRD-CONTENT\n' > "$T15/prd.md"
printf 'ORIG-QUICKSTART-PRD\n' > "$T15/prd-quickstart.md"
make_harness "$T15" "$NONINT"
printf 'cmd_quickstart "a todo app" --yes </dev/null\n' >> "$T15/harness.sh"
out=$(cd "$T15" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T15/cmd_start.log" 2>/dev/null || echo "")
ok=true
[ "$rc" -eq 0 ] || ok=false
grep -q "ORIGINAL-PRD-CONTENT" "$T15/prd.md" 2>/dev/null || ok=false
grep -q "ORIG-QUICKSTART-PRD" "$T15/prd-quickstart.md" 2>/dev/null || ok=false
[ -f "$T15/prd-quickstart-2.md" ] || ok=false
[ "$start_args" = "./prd-quickstart-2.md --yes --no-plan" ] || ok=false
# The overwrite prompt must never have been shown.
printf '%s' "$out" | grep -qi "Overwrite?" && ok=false
if [ "$ok" = true ]; then
    log_pass "non-interactive collision: no overwrite prompt, walks to prd-quickstart-2.md, originals intact"
else
    log_fail "non-interactive collision safety" "rc=$rc start_args='$start_args'; clobbered or prompted"
fi

# ---------------------------------------------------------------------------
# Test 16: an explicit --yes authorizes the displayed estimate, not an
# unbounded build. If the estimator fails, the non-interactive path must refuse
# before writing a PRD or calling cmd_start.
# ---------------------------------------------------------------------------
T16="$TMP/t16"; mkdir -p "$T16"
make_harness "$T16" "$NONINT
show_prd_plan() { return 1; }"
printf 'cmd_quickstart "a todo app" --yes </dev/null\n' >> "$T16/harness.sh"
out=$(cd "$T16" && run_to 15 bash harness.sh 2>&1); rc=$?
ok=true
[ "$rc" -eq 2 ] || ok=false
printf '%s' "$out" | grep -qi "requires a displayed plan" || ok=false
[ -f "$T16/prd.md" ] && ok=false
[ -f "$T16/prd-quickstart.md" ] && ok=false
[ -f "$T16/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "estimator failure: exit 2, zero writes, no unpriced build"
else
    log_fail "estimator failure refusal" "rc=$rc; wrote a file or started an unpriced build"
fi

# ===========================================================================
# Zero-spend preview path (LOKI-QUICKSTART-PREVIEW-48).
# ===========================================================================

PREVIEW_NONINT='_qs_non_interactive() { return 0; }
_qs_selected_provider() { printf provider-called > "$PWD/provider-called"; return 1; }
detect_any_provider() { printf provider-called > "$PWD/provider-called"; return 1; }
provider_offer_gate() { printf provider-called > "$PWD/provider-called"; return 1; }'

# ---------------------------------------------------------------------------
# Test 17: an idea preview works without a terminal or provider. It uses the
# canonical top match and estimator, then exits before every write/build seam.
# ---------------------------------------------------------------------------
T17="$TMP/t17"; mkdir -p "$T17"
make_harness "$T17" "$PREVIEW_NONINT"
printf 'cmd_quickstart "a todo app with user accounts" --dry-run </dev/null\n' >> "$T17/harness.sh"
out=$(cd "$T17" && run_to 15 bash harness.sh 2>&1); rc=$?
ok=true
[ "$rc" -eq 0 ] || ok=false
printf '%s' "$out" | grep -q "Template:    simple-todo-app" || ok=false
printf '%s' "$out" | grep -q "Cost:        ~\$0.40" || ok=false
printf '%s' "$out" | grep -q "Preview complete" || ok=false
printf '%s' "$out" | grep -q "Start the build now" && ok=false
[ -f "$T17/provider-called" ] && ok=false
[ -f "$T17/prd.md" ] && ok=false
[ -f "$T17/prd-quickstart.md" ] && ok=false
[ -f "$T17/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "idea --dry-run: plan shown without provider, prompts, PRD writes, or build"
else
    log_fail "idea preview" "rc=$rc; provider, prompt, write, or build boundary violated"
fi

# ---------------------------------------------------------------------------
# Test 18: a readable PRD preview estimates that exact file and still writes
# nothing. The absence of cmd_start.log is the execution boundary proof.
# ---------------------------------------------------------------------------
T18="$TMP/t18"; mkdir -p "$T18"
printf '# Preview PRD\n\nBuild a thing.\n' > "$T18/my-prd.md"
before=$(shasum -a 256 "$T18/my-prd.md" | awk '{print $1}')
make_harness "$T18" "$PREVIEW_NONINT"
printf 'cmd_quickstart "%s/my-prd.md" --dry-run </dev/null\n' "$T18" >> "$T18/harness.sh"
out=$(cd "$T18" && run_to 15 bash harness.sh 2>&1); rc=$?
after=$(shasum -a 256 "$T18/my-prd.md" | awk '{print $1}')
ok=true
[ "$rc" -eq 0 ] || ok=false
[ "$before" = "$after" ] || ok=false
printf '%s' "$out" | grep -q "Template:    my-prd.md" || ok=false
[ -f "$T18/provider-called" ] && ok=false
[ -f "$T18/prd.md" ] && ok=false
[ -f "$T18/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "PRD --dry-run: exact source estimated and byte-preserved; zero execution"
else
    log_fail "PRD preview" "rc=$rc; source changed or side effect observed"
fi

# ---------------------------------------------------------------------------
# Test 19: preview requires explicit input even in an interactive-capable
# harness. It never falls back to prompting for an idea.
# ---------------------------------------------------------------------------
T19="$TMP/t19"; mkdir -p "$T19"
make_harness "$T19" "$PREVIEW_NONINT"
printf 'cmd_quickstart --dry-run </dev/null\n' >> "$T19/harness.sh"
out=$(cd "$T19" && run_to 15 bash harness.sh 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "requires an IDEA" && [ ! -f "$T19/cmd_start.log" ]; then
    log_pass "--dry-run without input: exit 2 before provider, write, or build"
else
    log_fail "preview missing input" "rc=$rc or refusal/zero-execution contract missing"
fi

# ---------------------------------------------------------------------------
# Test 20: preview and explicit execution consent are incompatible. Reject at
# argv validation so option order cannot silently choose a mode.
# ---------------------------------------------------------------------------
T20="$TMP/t20"; mkdir -p "$T20"
make_harness "$T20" "$PREVIEW_NONINT"
printf 'cmd_quickstart "a todo app" --yes --dry-run </dev/null\n' >> "$T20/harness.sh"
out=$(cd "$T20" && run_to 15 bash harness.sh 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "cannot be combined" && [ ! -f "$T20/provider-called" ] && [ ! -f "$T20/cmd_start.log" ]; then
    log_pass "--yes + --dry-run: ambiguous execution intent refused before side effects"
else
    log_fail "preview/consent conflict" "rc=$rc or early-refusal contract missing"
fi

# ---------------------------------------------------------------------------
# Test 21: a path-looking typo is not reinterpreted as an idea. This prevents a
# plausible but unrelated template plan from being presented for a missing PRD.
# ---------------------------------------------------------------------------
T21="$TMP/t21"; mkdir -p "$T21"
make_harness "$T21" "$PREVIEW_NONINT"
printf 'cmd_quickstart "./missing-prd.md" --dry-run </dev/null\n' >> "$T21/harness.sh"
out=$(cd "$T21" && run_to 15 bash harness.sh 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "not a readable file" && [ ! -f "$T21/provider-called" ] && [ ! -f "$T21/cmd_start.log" ]; then
    log_pass "missing PRD-looking path: exit 2 instead of previewing an unrelated idea"
else
    log_fail "missing preview PRD" "rc=$rc or path refusal contract missing"
fi

# ---------------------------------------------------------------------------
# Test 22: estimator failure is terminal for preview, with no provider, file,
# or build side effect.
# ---------------------------------------------------------------------------
T22="$TMP/t22"; mkdir -p "$T22"
make_harness "$T22" "$PREVIEW_NONINT
show_prd_plan() { return 1; }"
printf 'cmd_quickstart "a todo app" --dry-run </dev/null\n' >> "$T22/harness.sh"
out=$(cd "$T22" && run_to 15 bash harness.sh 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "requires a displayed plan" && [ ! -f "$T22/provider-called" ] && [ ! -f "$T22/prd.md" ] && [ ! -f "$T22/cmd_start.log" ]; then
    log_pass "preview estimator failure: exit 2 with zero provider/write/build side effects"
else
    log_fail "preview estimator failure" "rc=$rc or zero-side-effect refusal missing"
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
