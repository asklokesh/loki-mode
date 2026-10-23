#!/usr/bin/env bash
# Tests for the simple-web build profile (loki_apply_build_profile in run.sh).
# Verifies: (1) profile unset -> every PHASE_* stays true (unchanged); (2)
# profile=simple-web -> wasteful phases false, quality-critical phases true and
# COUNCIL untouched; (3) operator LOKI_PHASE_* override always wins.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
check() { # check <desc> <expected> <actual>
    if [ "$2" = "$3" ]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "FAIL: $1 (expected '$2', got '$3')"
    fi
}

# Extract the helper definition + its resolution logic from run.sh so we test the
# REAL code (not a copy). We pull the helper function and the PHASE_* assignment
# block, then evaluate them in a clean subshell with a controlled environment.
extract() {
    awk '/^loki_is_supervised_simple_web\(\)/,/^loki_apply_build_profile$/' "$RUN_SH"
    awk '/^PHASE_UNIT_TESTS=/,/^PHASE_UAT=/' "$RUN_SH"
}
PROFILE_CODE="$(extract)"

# Resolve PHASE_* under a given environment; echoes "VAR=value" lines.
resolve() { # resolve <env assignments...>
    env -i bash -c "$*
$PROFILE_CODE
for v in PHASE_UNIT_TESTS PHASE_API_TESTS PHASE_E2E_TESTS PHASE_SECURITY \
         PHASE_INTEGRATION PHASE_CODE_REVIEW PHASE_WEB_RESEARCH PHASE_PERFORMANCE \
         PHASE_ACCESSIBILITY PHASE_REGRESSION PHASE_UAT; do
    echo \"\$v=\${!v}\"
done"
}
val() { grep "^$2=" <<<"$1" | cut -d= -f2; }

# --- 1. profile unset -> all phases true (byte-identical to today) ------------
R="$(resolve 'true')"
for v in UNIT_TESTS API_TESTS E2E_TESTS SECURITY INTEGRATION CODE_REVIEW \
         WEB_RESEARCH PERFORMANCE ACCESSIBILITY REGRESSION UAT; do
    check "unset: PHASE_$v true" "true" "$(val "$R" "PHASE_$v")"
done

# --- 2. profile=simple-web -> wasteful off, quality-critical on ---------------
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web')"
# Dropped (wasteful for a static frontend):
check "simple-web: API_TESTS off"    "false" "$(val "$R" PHASE_API_TESTS)"
check "simple-web: INTEGRATION off"  "false" "$(val "$R" PHASE_INTEGRATION)"
check "simple-web: PERFORMANCE off"  "false" "$(val "$R" PHASE_PERFORMANCE)"
check "simple-web: REGRESSION off"   "false" "$(val "$R" PHASE_REGRESSION)"
check "simple-web: UAT off"          "false" "$(val "$R" PHASE_UAT)"
check "simple-web: WEB_RESEARCH off" "false" "$(val "$R" PHASE_WEB_RESEARCH)"
# Kept (catch real defects on a landing page):
check "simple-web: E2E kept"           "true" "$(val "$R" PHASE_E2E_TESTS)"
check "simple-web: CODE_REVIEW kept"   "true" "$(val "$R" PHASE_CODE_REVIEW)"
check "simple-web: SECURITY kept"      "true" "$(val "$R" PHASE_SECURITY)"
check "simple-web: ACCESSIBILITY kept" "true" "$(val "$R" PHASE_ACCESSIBILITY)"
# Unit tests are not dropped by the profile (default stays true).
check "simple-web: UNIT_TESTS untouched" "true" "$(val "$R" PHASE_UNIT_TESTS)"

# Ordinary simple-web does not enter the exact supervised policy branch, so it
# must leave an operator council value unchanged.
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web; export LOKI_COUNCIL_ENABLED=operator; echo LOKI_COUNCIL_ENABLED=$LOKI_COUNCIL_ENABLED')"
if grep -q '^LOKI_COUNCIL_ENABLED=operator$' <<<"$R"; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1)); echo "FAIL: ordinary simple-web mutated council policy"
fi

# --- 3. operator override wins (pre-set LOKI_PHASE_API_TESTS=true kept) --------
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web; export LOKI_PHASE_API_TESTS=true')"
check "override: API_TESTS stays true" "true" "$(val "$R" PHASE_API_TESTS)"
# And an operator can still force-OFF a kept phase.
R="$(resolve 'export LOKI_BUILD_PROFILE=simple-web; export LOKI_PHASE_E2E_TESTS=false')"
check "override: E2E forced false" "false" "$(val "$R" PHASE_E2E_TESTS)"

# --- 4. small-task fast path ---------------------------------------------
# small_resolve <setup>: runs the REAL profile code, then the post-detection
# entry point, and echoes the resulting knobs.
small_resolve() {
    env -i bash -c "$*
$PROFILE_CODE
loki_maybe_apply_small_profile
for v in LOKI_BUILD_PROFILE LOKI_SPEC_GRILL LOKI_PRD_ENRICH LOKI_WIKI_AUTO \
         LOKI_AUTO_DOCS LOKI_GATE_DEVILS_ADVOCATE LOKI_REVIEW_REQUIREMENTS_ONLY \
         LOKI_COUNCIL_MODEL_VOTERS LOKI_ADVISOR_MODEL LOKI_SIMPLE LOKI_DOCS_TIER \
         LOKI_SMALL_PROFILE_ACTIVE LOKI_PHASE_UNIT_TESTS LOKI_PHASE_E2E_TESTS \
         LOKI_PHASE_CODE_REVIEW LOKI_PHASE_SECURITY LOKI_COUNCIL_ENABLED \
         LOKI_EVIDENCE_GATE LOKI_PROOF_GATE LOKI_PROOF LOKI_GATE_DOC_COVERAGE \
         LOKI_BUILD_CHECK_BLOCK; do
    echo \"\$v=\${!v-<unset>}\"
done"
}
sval() { grep "^$2=" <<<"$1" | cut -d= -f2-; }

R="$(small_resolve 'DETECTED_COMPLEXITY=simple')"
check "small: profile marker"        "small" "$(sval "$R" LOKI_BUILD_PROFILE)"
check "small: active flag"           "1"     "$(sval "$R" LOKI_SMALL_PROFILE_ACTIVE)"
check "small: SPEC_GRILL off"        "0"     "$(sval "$R" LOKI_SPEC_GRILL)"
check "small: PRD_ENRICH off"        "0"     "$(sval "$R" LOKI_PRD_ENRICH)"
check "small: WIKI_AUTO off"         "0"     "$(sval "$R" LOKI_WIKI_AUTO)"
check "small: AUTO_DOCS false"       "false" "$(sval "$R" LOKI_AUTO_DOCS)"
check "small: DEVILS_ADVOCATE off"   "false" "$(sval "$R" LOKI_GATE_DEVILS_ADVOCATE)"
check "small: REQUIREMENTS_ONLY not forced" "<unset>" "$(sval "$R" LOKI_REVIEW_REQUIREMENTS_ONLY)"
check "small: council single call"   "0"     "$(sval "$R" LOKI_COUNCIL_MODEL_VOTERS)"
check "small: reviewer model haiku"  "haiku" "$(sval "$R" LOKI_ADVISOR_MODEL)"
check "small: SIMPLE prompt arm"     "1"     "$(sval "$R" LOKI_SIMPLE)"
check "small: docs tier exported"    "small" "$(sval "$R" LOKI_DOCS_TIER)"
# Wall: no deterministic gate, holdout or Seal knob is written by the profile.
for v in LOKI_PHASE_UNIT_TESTS LOKI_PHASE_E2E_TESTS LOKI_PHASE_CODE_REVIEW \
         LOKI_PHASE_SECURITY LOKI_COUNCIL_ENABLED LOKI_EVIDENCE_GATE \
         LOKI_PROOF_GATE LOKI_PROOF LOKI_GATE_DOC_COVERAGE LOKI_BUILD_CHECK_BLOCK; do
    check "small: $v untouched" "<unset>" "$(sval "$R" "$v")"
done

# Complex and standard tiers are unchanged.
for t in standard complex ""; do
    R="$(small_resolve "DETECTED_COMPLEXITY=$t")"
    check "tier '$t': no small profile" "<unset>" "$(sval "$R" LOKI_BUILD_PROFILE)"
    check "tier '$t': SPEC_GRILL untouched" "<unset>" "$(sval "$R" LOKI_SPEC_GRILL)"
    check "tier '$t': SIMPLE untouched" "<unset>" "$(sval "$R" LOKI_SIMPLE)"
done

# Explicit user env beats the profile.
R="$(small_resolve 'DETECTED_COMPLEXITY=simple; export LOKI_SPEC_GRILL=1 LOKI_ADVISOR_MODEL=sonnet LOKI_WIKI_AUTO=1 LOKI_AUTO_DOCS=true LOKI_SIMPLE=0')"
check "override: SPEC_GRILL kept"   "1"      "$(sval "$R" LOKI_SPEC_GRILL)"
check "override: reviewer kept"     "sonnet" "$(sval "$R" LOKI_ADVISOR_MODEL)"
check "override: WIKI_AUTO kept"    "1"      "$(sval "$R" LOKI_WIKI_AUTO)"
check "override: AUTO_DOCS kept"    "true"   "$(sval "$R" LOKI_AUTO_DOCS)"
check "override: SIMPLE kept"       "0"      "$(sval "$R" LOKI_SIMPLE)"

# Opt-out and other profiles.
R="$(small_resolve 'DETECTED_COMPLEXITY=simple; export LOKI_SMALL_PROFILE=0')"
check "opt-out: no small profile" "<unset>" "$(sval "$R" LOKI_BUILD_PROFILE)"
R="$(small_resolve 'DETECTED_COMPLEXITY=simple; export LOKI_BUILD_PROFILE=simple-web')"
check "simple-web wins over small" "simple-web" "$(sval "$R" LOKI_BUILD_PROFILE)"
check "simple-web: SIMPLE not forced" "<unset>" "$(sval "$R" LOKI_SIMPLE)"

# Scoped-change diff budget: a large dirty tree is not a small task.
BIGREPO="$(mktemp -d "${TMPDIR:-/tmp}/loki-bp-small.XXXXXX")"
git -C "$BIGREPO" init -q
seq 1 50 > "$BIGREPO/a.txt"
git -C "$BIGREPO" add a.txt
git -C "$BIGREPO" -c user.name=t -c user.email=t@t commit -q -m a
seq 1 900 > "$BIGREPO/a.txt"
R="$(small_resolve "DETECTED_COMPLEXITY=simple; export LOKI_SCOPED_CHANGE_ACTIVE=1 TARGET_DIR=$BIGREPO")"
check "scoped over diff budget: no small" "<unset>" "$(sval "$R" LOKI_BUILD_PROFILE)"
R="$(small_resolve "DETECTED_COMPLEXITY=simple; export LOKI_SCOPED_CHANGE_ACTIVE=1 TARGET_DIR=$BIGREPO LOKI_SMALL_DIFF_BUDGET=5000")"
check "scoped within diff budget: small" "small" "$(sval "$R" LOKI_BUILD_PROFILE)"
rm -rf "$BIGREPO"

# Main-session lean flags: small profile only, single "--tools=" never emitted
# for the main role, setting sources widened to project,local.
main_flags() { # main_flags <setup>
    env -i bash -c "$*
$PROFILE_CODE
loki_lean_child_flags() { printf '%s\n' --setting-sources project --strict-mcp-config --mcp-config '{\"mcpServers\":{}}'; }
if loki_small_main_session_flags; then printf '%s|' \"\${_LOKI_SMALL_MAIN_ARGV[@]}\"; else echo NONE; fi"
}
check "main flags: inactive profile -> none" "NONE" "$(main_flags 'true')"
check "main flags: small -> lean + project,local" \
    "--setting-sources|project,local|--strict-mcp-config|--mcp-config|{\"mcpServers\":{}}|" \
    "$(main_flags 'export LOKI_SMALL_PROFILE_ACTIVE=1')"
# API-key host: child helper emits --bare; the main session must never get it.
bare_flags() {
    env -i bash -c "export LOKI_SMALL_PROFILE_ACTIVE=1
$PROFILE_CODE
loki_lean_child_flags() { printf '%s\n' --bare; }
if loki_small_main_session_flags; then printf '%s|' \"\${_LOKI_SMALL_MAIN_ARGV[@]}\"; else echo NONE; fi"
}
check "main flags: --bare never passed to main" "NONE" "$(bare_flags)"
check "supervised reviewer uses single --tools= arg" "1" \
    "$(grep -c '^ *"--tools="$' "$RUN_SH")"
check "empty reviewer list guard present" "1" \
    "$(grep -c 'no reviewers selected; review is inconclusive' "$RUN_SH")"
check "main flags: opt-out -> none" "NONE" \
    "$(main_flags 'export LOKI_SMALL_PROFILE_ACTIVE=1 LOKI_SMALL_LEAN_MAIN=0')"

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
