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

# ===========================================================================
# Machine-readable zero-spend preview (LOKI-QUICKSTART-JSON-PREVIEW-49).
# ===========================================================================

# ---------------------------------------------------------------------------
# Test 23: an idea JSON preview emits exactly one parseable versioned object
# containing the canonical template choice and untouched estimator response.
# Human presentation, providers, writes, and execution remain absent.
# ---------------------------------------------------------------------------
T23="$TMP/t23"; mkdir -p "$T23"
make_harness "$T23" "$PREVIEW_NONINT"
printf 'cmd_quickstart "a todo app with user accounts" --dry-run --json </dev/null\n' >> "$T23/harness.sh"
(cd "$T23" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
ok=true
[ "$rc" -eq 0 ] || ok=false
python3 - "$T23/stdout" <<'PY' || ok=false
import json, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_text()
assert raw.endswith("\n") and raw.count("\n") == 1
d = json.loads(raw)
assert d["schema_version"] == 1
assert d["command"] == "loki quickstart"
assert d["mode"] == "dry-run"
assert d["input_kind"] == "idea"
assert d["selected_template"] == "simple-todo-app"
assert d["source_name"] is None
assert d["plan"]["cost"]["total_usd"] == 0.40
assert d["plan"]["iterations"] == {"estimated": 4, "range": [3, 5]}
PY
[ ! -s "$T23/stderr" ] || ok=false
[ -f "$T23/provider-called" ] && ok=false
[ -f "$T23/prd.md" ] && ok=false
[ -f "$T23/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "idea --dry-run --json: one exact plan object, zero human/provider/write/build output"
else
    log_fail "idea JSON preview" "rc=$rc; JSON schema, purity, or side-effect boundary violated"
fi

# ---------------------------------------------------------------------------
# Test 24: a PRD JSON preview identifies the input honestly: no selected
# template is invented, while only the source basename is exposed.
# ---------------------------------------------------------------------------
T24="$TMP/t24"; mkdir -p "$T24"
printf '# Existing PRD\n\nBuild the existing spec.\n' > "$T24/customer-prd.md"
before=$(shasum -a 256 "$T24/customer-prd.md" | awk '{print $1}')
make_harness "$T24" "$PREVIEW_NONINT"
printf 'cmd_quickstart "%s/customer-prd.md" --json --dry-run </dev/null\n' "$T24" >> "$T24/harness.sh"
(cd "$T24" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
after=$(shasum -a 256 "$T24/customer-prd.md" | awk '{print $1}')
ok=true
[ "$rc" -eq 0 ] || ok=false
[ "$before" = "$after" ] || ok=false
python3 - "$T24/stdout" <<'PY' || ok=false
import json, pathlib, sys
d = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert d["input_kind"] == "prd"
assert d["selected_template"] is None
assert d["source_name"] == "customer-prd.md"
assert d["plan"]["time"]["estimated"] == "14 minutes"
PY
[ ! -s "$T24/stderr" ] || ok=false
[ -f "$T24/provider-called" ] && ok=false
[ -f "$T24/prd.md" ] && ok=false
[ -f "$T24/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "PRD --dry-run --json: source identified without inventing a template or changing bytes"
else
    log_fail "PRD JSON preview" "rc=$rc; source truth, JSON, or side-effect boundary violated"
fi

# ---------------------------------------------------------------------------
# Test 25: --json is preview-only. Without --dry-run it refuses before stdout,
# provider discovery, writes, or build execution.
# ---------------------------------------------------------------------------
T25="$TMP/t25"; mkdir -p "$T25"
make_harness "$T25" "$PREVIEW_NONINT"
printf 'cmd_quickstart "a todo app" --json </dev/null\n' >> "$T25/harness.sh"
(cd "$T25" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$T25/stdout" ] && grep -q -- "--json requires --dry-run" "$T25/stderr" && [ ! -f "$T25/provider-called" ] && [ ! -f "$T25/cmd_start.log" ]; then
    log_pass "--json without --dry-run: exit 2 with no data or side effects"
else
    log_fail "JSON mode guard" "rc=$rc or stdout/refusal/side-effect contract missing"
fi

# ---------------------------------------------------------------------------
# Test 26: estimator failure emits no partial JSON. Diagnostics remain on
# stderr and every provider/write/build boundary remains untouched.
# ---------------------------------------------------------------------------
T26="$TMP/t26"; mkdir -p "$T26"
make_harness "$T26" "$PREVIEW_NONINT
show_prd_plan() { return 1; }"
printf 'cmd_quickstart "a todo app" --dry-run --json </dev/null\n' >> "$T26/harness.sh"
(cd "$T26" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$T26/stdout" ] && grep -q "requires a displayed plan" "$T26/stderr" && [ ! -f "$T26/provider-called" ] && [ ! -f "$T26/prd.md" ] && [ ! -f "$T26/cmd_start.log" ]; then
    log_pass "JSON estimator failure: exit 2 with no partial data or side effects"
else
    log_fail "JSON estimator failure" "rc=$rc or empty-stdout/zero-side-effect refusal missing"
fi

# ---------------------------------------------------------------------------
# Explicit shipped-template selection (LOKI-QUICKSTART-TEMPLATE-SELECT-50).
# ---------------------------------------------------------------------------

# Human preview: an exact override bypasses ranking/picker but keeps the real
# estimator and all preview no-side-effect guarantees.
T27="$TMP/t27"; mkdir -p "$T27"
make_harness "$T27" "$PREVIEW_NONINT"
printf 'cmd_quickstart "a todo app" --template dashboard --dry-run </dev/null\n' >> "$T27/harness.sh"
out=$(cd "$T27" && run_to 15 bash harness.sh 2>&1); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Selected dashboard (--template)" && printf '%s' "$out" | grep -q "Template:    dashboard" && ! printf '%s' "$out" | grep -q "simple-todo-app" && [ ! -f "$T27/provider-called" ] && [ ! -f "$T27/prd.md" ] && [ ! -f "$T27/cmd_start.log" ]; then
    log_pass "explicit template human preview: exact selection, no ranking/provider/write/build"
else
    log_fail "explicit template human preview" "rc=$rc or override/purity contract missing"
fi

# JSON preview reports the explicit selection and retains the estimator object.
T28="$TMP/t28"; mkdir -p "$T28"
make_harness "$T28" "$PREVIEW_NONINT"
printf 'cmd_quickstart "a todo app" --dry-run --json --template dashboard </dev/null\n' >> "$T28/harness.sh"
(cd "$T28" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
ok=true
[ "$rc" -eq 0 ] || ok=false
python3 - "$T28/stdout" <<'PY' || ok=false
import json, pathlib, sys
d = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert d["selected_template"] == "dashboard"
assert d["input_kind"] == "idea"
assert d["plan"]["cost"]["total_usd"] == 0.40
PY
[ ! -s "$T28/stderr" ] || ok=false
[ -f "$T28/provider-called" ] && ok=false
[ -f "$T28/prd.md" ] && ok=false
[ -f "$T28/cmd_start.log" ] && ok=false
if [ "$ok" = true ]; then
    log_pass "explicit template JSON preview: selected_template is exact and side-effect free"
else
    log_fail "explicit template JSON preview" "rc=$rc or JSON/purity contract missing"
fi

# Fully specified non-interactive execution uses the selected shipped PRD and
# reaches only the existing cmd_start seam after showing its plan.
T29="$TMP/t29"; mkdir -p "$T29"
make_harness "$T29" "$NONINT"
printf 'cmd_quickstart "a todo app" --template dashboard --yes </dev/null\n' >> "$T29/harness.sh"
out=$(cd "$T29" && run_to 15 bash harness.sh 2>&1); rc=$?
start_args=$(cat "$T29/cmd_start.log" 2>/dev/null || echo "")
if [ "$rc" -eq 0 ] && [ "$start_args" = "./prd.md --yes --no-plan" ] && head -1 "$T29/prd.md" | grep -q "Analytics Dashboard" && printf '%s' "$out" | grep -q "Template:    dashboard"; then
    log_pass "explicit template execution: selected shipped PRD reaches unchanged cmd_start seam"
else
    log_fail "explicit template execution" "rc=$rc start_args='$start_args' or selected PRD mismatch"
fi

# Invalid override shapes all refuse before provider discovery, estimation,
# stdout data, file creation, or cmd_start. Keep each contract independently
# visible so a parser regression cannot hide behind a combined matrix result.
T30="$TMP/t30"; mkdir -p "$T30"
make_harness "$T30" "$PREVIEW_NONINT
show_prd_plan() { printf estimator-called > \"\$PWD/estimator-called\"; return 1; }"
printf 'cmd_quickstart "a todo app" --template </dev/null\n' >> "$T30/harness.sh"
(cd "$T30" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && grep -q "requires an exact shipped template name" "$T30/stderr" && [ ! -s "$T30/stdout" ] && [ ! -e "$T30/estimator-called" ] && [ ! -e "$T30/provider-called" ] && [ ! -e "$T30/prd.md" ] && [ ! -e "$T30/cmd_start.log" ]; then
    log_pass "missing --template value refuses before provider/estimator/write/build"
else
    log_fail "missing template value" "rc=$rc or early refusal boundary missing"
fi

T31="$TMP/t31"; mkdir -p "$T31"
make_harness "$T31" "$PREVIEW_NONINT
show_prd_plan() { printf estimator-called > \"\$PWD/estimator-called\"; return 1; }"
printf 'cmd_quickstart "a todo app" --template does-not-exist --dry-run </dev/null\n' >> "$T31/harness.sh"
(cd "$T31" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && grep -q "Unknown shipped template" "$T31/stderr" && [ ! -s "$T31/stdout" ] && [ ! -e "$T31/estimator-called" ] && [ ! -e "$T31/provider-called" ] && [ ! -e "$T31/prd.md" ] && [ ! -e "$T31/cmd_start.log" ]; then
    log_pass "unknown --template name refuses before provider/estimator/write/build"
else
    log_fail "unknown template name" "rc=$rc or early refusal boundary missing"
fi

T32="$TMP/t32"; mkdir -p "$T32"
make_harness "$T32" "$PREVIEW_NONINT
show_prd_plan() { printf estimator-called > \"\$PWD/estimator-called\"; return 1; }"
printf 'cmd_quickstart "a todo app" --template dashboard --template cli-tool --dry-run </dev/null\n' >> "$T32/harness.sh"
(cd "$T32" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && grep -q "may be specified only once" "$T32/stderr" && [ ! -s "$T32/stdout" ] && [ ! -e "$T32/estimator-called" ] && [ ! -e "$T32/provider-called" ] && [ ! -e "$T32/prd.md" ] && [ ! -e "$T32/cmd_start.log" ]; then
    log_pass "duplicate --template flags refuse before provider/estimator/write/build"
else
    log_fail "duplicate template flags" "rc=$rc or early refusal boundary missing"
fi

T33="$TMP/t33"; mkdir -p "$T33"
printf '# Existing PRD\n' > "$T33/customer-prd.md"
before=$(shasum -a 256 "$T33/customer-prd.md" | awk '{print $1}')
make_harness "$T33" "$PREVIEW_NONINT
show_prd_plan() { printf estimator-called > \"\$PWD/estimator-called\"; return 1; }"
printf 'cmd_quickstart "%s/customer-prd.md" --template dashboard --dry-run </dev/null\n' "$T33" >> "$T33/harness.sh"
(cd "$T33" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
after=$(shasum -a 256 "$T33/customer-prd.md" | awk '{print $1}')
if [ "$rc" -eq 2 ] && [ "$before" = "$after" ] && grep -q "cannot be combined with a PRD path" "$T33/stderr" && [ ! -s "$T33/stdout" ] && [ ! -e "$T33/estimator-called" ] && [ ! -e "$T33/provider-called" ] && [ ! -e "$T33/prd.md" ] && [ ! -e "$T33/cmd_start.log" ]; then
    log_pass "PRD plus --template refuses before provider/estimator/write/build"
else
    log_fail "template with PRD" "rc=$rc or early refusal/source-preservation boundary missing"
fi

# ===========================================================================
# Provider-free shipped-template discovery (LOKI-QUICKSTART-TEMPLATE-DISCOVERY-52).
# ===========================================================================

# Human output lists every actual shipped PRD exactly once in stable filename
# order and includes the same purpose copy used by the interactive picker.
T34="$TMP/t34"; mkdir -p "$T34"
make_harness "$T34" 'show_prd_plan() { printf estimator-called > "$PWD/estimator-called"; return 1; }
provider_offer_gate() { printf provider-called > "$PWD/provider-called"; return 1; }'
printf 'cmd_quickstart --list-templates </dev/null\n' >> "$T34/harness.sh"
(cd "$T34" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
expected_names=$(find "$REPO_ROOT/templates" -maxdepth 1 -type f -name '*.md' ! -name README.md -print | sed 's#.*/##; s/\.md$//' | LC_ALL=C sort)
actual_names=$(sed -n 's/^  \([^ ]*\)  *.*/\1/p' "$T34/stdout")
if [ "$rc" -eq 0 ] && [ "$actual_names" = "$expected_names" ] && grep -q 'dashboard.*Analytics / admin dashboard' "$T34/stdout" && [ ! -s "$T34/stderr" ] && [ ! -e "$T34/provider-called" ] && [ ! -e "$T34/estimator-called" ] && [ ! -e "$T34/prd.md" ] && [ ! -e "$T34/cmd_start.log" ]; then
    log_pass "template discovery human list: every shipped name/purpose in stable order, zero side effects"
else
    log_fail "template discovery human list" "rc=$rc, catalog mismatch, purpose missing, or forbidden boundary crossed"
fi

# JSON discovery is one schema-v1 object over the identical ordered catalog.
T35="$TMP/t35"; mkdir -p "$T35"
make_harness "$T35" 'show_prd_plan() { printf estimator-called > "$PWD/estimator-called"; return 1; }
provider_offer_gate() { printf provider-called > "$PWD/provider-called"; return 1; }'
printf 'cmd_quickstart --list-templates --json </dev/null\n' >> "$T35/harness.sh"
(cd "$T35" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
python3 - "$T35/stdout" "$REPO_ROOT/templates" <<'PY' || rc=99
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
expected = sorted(p.stem for p in pathlib.Path(sys.argv[2]).glob("*.md") if p.name != "README.md")
assert payload["schema_version"] == 1
assert payload["command"] == "loki quickstart"
assert payload["mode"] == "list-templates"
assert [item["name"] for item in payload["templates"]] == expected
assert all(set(item) == {"name", "purpose"} and item["purpose"] for item in payload["templates"])
PY
if [ "$rc" -eq 0 ] && [ ! -s "$T35/stderr" ] && [ ! -e "$T35/provider-called" ] && [ ! -e "$T35/estimator-called" ] && [ ! -e "$T35/prd.md" ] && [ ! -e "$T35/cmd_start.log" ]; then
    log_pass "template discovery JSON: one ordered schema-v1 catalog object, zero side effects"
else
    log_fail "template discovery JSON" "rc=$rc, schema/order mismatch, or forbidden boundary crossed"
fi

# Positional input conflicts with standalone discovery and refuses before all
# provider, estimator, write, and build boundaries.
T36="$TMP/t36"; mkdir -p "$T36"
make_harness "$T36" 'show_prd_plan() { printf estimator-called > "$PWD/estimator-called"; return 1; }
provider_offer_gate() { printf provider-called > "$PWD/provider-called"; return 1; }'
printf 'cmd_quickstart "a todo app" --list-templates </dev/null\n' >> "$T36/harness.sh"
(cd "$T36" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$T36/stdout" ] && grep -q 'accepts only the optional --json flag' "$T36/stderr" && [ ! -e "$T36/provider-called" ] && [ ! -e "$T36/estimator-called" ] && [ ! -e "$T36/prd.md" ] && [ ! -e "$T36/cmd_start.log" ]; then
    log_pass "template discovery plus positional input refuses before every side-effect boundary"
else
    log_fail "template discovery positional conflict" "rc=$rc or early refusal boundary missing"
fi

# Execution and preview flags are incompatible with discovery, including an
# explicit template selector that otherwise consumes a following value.
T37="$TMP/t37"; mkdir -p "$T37"
make_harness "$T37" 'show_prd_plan() { printf estimator-called > "$PWD/estimator-called"; return 1; }
provider_offer_gate() { printf provider-called > "$PWD/provider-called"; return 1; }'
for args in '--list-templates --yes' '--list-templates --dry-run' '--list-templates --template dashboard'; do
    (cd "$T37" && run_to 15 bash -c "source ./harness.sh; cmd_quickstart $args </dev/null" >"stdout-${args// /_}" 2>"stderr-${args// /_}"); rc=$?
    [ "$rc" -eq 2 ] || printf 'bad-rc\n' >> "$T37/failures"
done
if [ ! -e "$T37/failures" ] && [ ! -e "$T37/provider-called" ] && [ ! -e "$T37/estimator-called" ] && [ ! -e "$T37/prd.md" ] && [ ! -e "$T37/cmd_start.log" ]; then
    log_pass "template discovery rejects execution/preview flags before every side-effect boundary"
else
    log_fail "template discovery flag conflicts" "one conflict did not fail closed"
fi

# Duplicate discovery flags fail deterministically rather than emitting twice.
T38="$TMP/t38"; mkdir -p "$T38"
make_harness "$T38"
printf 'cmd_quickstart --list-templates --list-templates </dev/null\n' >> "$T38/harness.sh"
(cd "$T38" && run_to 15 bash harness.sh >stdout 2>stderr); rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$T38/stdout" ] && grep -q 'may be specified only once' "$T38/stderr" && [ ! -e "$T38/prd.md" ] && [ ! -e "$T38/cmd_start.log" ]; then
    log_pass "duplicate --list-templates refuses with no catalog or side effects"
else
    log_fail "duplicate template discovery" "rc=$rc or duplicate refusal missing"
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
