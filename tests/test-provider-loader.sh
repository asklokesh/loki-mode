#!/usr/bin/env bash
# Test: Provider Loader Functionality
# Tests the provider loading, validation, and auto-detection

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

# Source the loader
source "$PROVIDERS_DIR/loader.sh"

echo "========================================"
echo "Provider Loader Tests"
echo "========================================"
echo "Providers dir: $PROVIDERS_DIR"
echo ""

# ===========================================
# Test 1: validate_provider() with valid providers
# ===========================================
log_test "validate_provider() with valid providers"
valid_count=0
# v7.5.18: gemini removed from provider set. v8.2.0 added opencode.
for provider in "${SUPPORTED_PROVIDERS[@]}"; do
    if validate_provider "$provider"; then
        ((valid_count++))
    else
        log_fail "validate_provider rejected valid provider: $provider"
    fi
done

if [ $valid_count -eq ${#SUPPORTED_PROVIDERS[@]} ]; then
    log_pass "validate_provider() accepts every supported provider"
fi

# ===========================================
# Test 2: validate_provider() with invalid providers
# ===========================================
log_test "validate_provider() with invalid provider names"
invalid_providers=("invalid" "foo" "openai" "gpt" "" "../etc/passwd" "claude.sh")
invalid_rejected=0

for provider in "${invalid_providers[@]}"; do
    if ! validate_provider "$provider"; then
        ((invalid_rejected++))
    else
        log_fail "validate_provider accepted invalid provider: '$provider'"
    fi
done

if [ $invalid_rejected -eq ${#invalid_providers[@]} ]; then
    log_pass "validate_provider() rejects all invalid providers"
fi

# ===========================================
# Test 3: load_provider() loads correct config for each provider
# ===========================================
log_test "load_provider() loads correct config for claude"
# Reset provider variables
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "claude"; then
    if [ "$PROVIDER_NAME" = "claude" ] && [ "$PROVIDER_CLI" = "claude" ] && [ "$PROVIDER_DEGRADED" = "false" ]; then
        log_pass "load_provider() correctly loads claude config"
    else
        log_fail "load_provider() loaded claude but variables incorrect"
    fi
else
    log_fail "load_provider() failed to load claude"
fi

log_test "load_provider() loads correct config for codex"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "codex"; then
    if [ "$PROVIDER_NAME" = "codex" ] && [ "$PROVIDER_CLI" = "codex" ]; then
        log_pass "load_provider() correctly loads codex config"
    else
        log_fail "load_provider() loaded codex but variables incorrect (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
    fi
else
    log_fail "load_provider() failed to load codex"
fi

# Gemini load_provider test removed in v7.5.18 Phase A (gemini provider removed).

log_test "load_provider() rejects invalid provider"
if ! load_provider "invalid_provider" 2>/dev/null; then
    log_pass "load_provider() correctly rejects invalid provider"
else
    log_fail "load_provider() should reject invalid provider"
fi

# ===========================================
# Test 4: check_provider_installed() behavior
# ===========================================
log_test "check_provider_installed() for known providers"

# Test with claude (may or may not be installed)
if command -v claude >/dev/null 2>&1; then
    if check_provider_installed "claude"; then
        log_pass "check_provider_installed() correctly detects installed claude"
    else
        log_fail "check_provider_installed() should detect installed claude"
    fi
else
    if ! check_provider_installed "claude"; then
        log_pass "check_provider_installed() correctly reports claude not installed"
    else
        log_fail "check_provider_installed() should report claude not installed"
    fi
fi

log_test "check_provider_installed() for unknown provider"
if ! check_provider_installed "unknown_provider"; then
    log_pass "check_provider_installed() returns false for unknown provider"
else
    log_fail "check_provider_installed() should return false for unknown provider"
fi

# ===========================================
# Test 5: auto_detect_provider() priority order
# ===========================================
log_test "auto_detect_provider() priority order"

# Get installed providers list
installed_list=$(get_installed_providers)

# Check priority order is correct (claude > cline > codex > aider > opencode).
detected=$(auto_detect_provider)

if [ -n "$detected" ]; then
    # Verify the detected provider is actually installed
    if check_provider_installed "$detected"; then
        # Verify priority: if claude is installed, it should be detected
        if command -v claude >/dev/null 2>&1; then
            if [ "$detected" = "claude" ]; then
                log_pass "auto_detect_provider() prioritizes claude correctly"
            else
                log_fail "auto_detect_provider() should return claude when installed (got: $detected)"
            fi
        elif command -v codex >/dev/null 2>&1; then
            if [ "$detected" = "codex" ]; then
                log_pass "auto_detect_provider() falls back to codex correctly"
            else
                log_fail "auto_detect_provider() should return codex when claude not installed (got: $detected)"
            fi
        else
            log_pass "auto_detect_provider() returned installed provider: $detected"
        fi
    else
        log_fail "auto_detect_provider() returned non-installed provider: $detected"
    fi
else
    # No provider installed - this is acceptable
    if [ -z "$installed_list" ]; then
        log_pass "auto_detect_provider() returns empty when no providers installed"
    else
        log_fail "auto_detect_provider() should detect installed providers: $installed_list"
    fi
fi

# Test that auto_detect_provider returns failure code when no providers found
log_test "auto_detect_provider() returns correct exit code"
# We can't easily test "no providers" scenario without mocking, so just verify function exists
if type auto_detect_provider >/dev/null 2>&1; then
    log_pass "auto_detect_provider() function exists and is callable"
else
    log_fail "auto_detect_provider() function not found"
fi

# ===========================================
# Test 6: SUPPORTED_PROVIDERS array
# ===========================================
log_test "SUPPORTED_PROVIDERS array contents"
# v7.5.18: gemini removed. v8.2.0 added opencode.
# v8.2.0: opencode added as the model-agnostic route -- it reaches 75+ providers
# via the AI SDK + Models.dev registry plus any OpenAI-compatible endpoint, so a
# user can run cheap open models without us maintaining a per-vendor model list.
if [ ${#SUPPORTED_PROVIDERS[@]} -eq 5 ]; then
    expected=("claude" "codex" "cline" "aider" "opencode")
    all_match=true
    for i in "${!expected[@]}"; do
        if [ "${SUPPORTED_PROVIDERS[$i]}" != "${expected[$i]}" ]; then
            all_match=false
            break
        fi
    done
    if $all_match; then
        log_pass "SUPPORTED_PROVIDERS contains correct providers in order (claude, codex, cline, aider, opencode)"
    else
        log_fail "SUPPORTED_PROVIDERS order mismatch"
    fi
else
    log_fail "SUPPORTED_PROVIDERS should have 5 entries (got: ${#SUPPORTED_PROVIDERS[@]})"
fi

# ===========================================
# Test 7: DEFAULT_PROVIDER value
# ===========================================
log_test "DEFAULT_PROVIDER is set to claude"
if [ "$DEFAULT_PROVIDER" = "claude" ]; then
    log_pass "DEFAULT_PROVIDER is correctly set to 'claude'"
else
    log_fail "DEFAULT_PROVIDER should be 'claude' (got: $DEFAULT_PROVIDER)"
fi

# ===========================================
# Test 8: load_provider() loads cline config correctly
# ===========================================
log_test "load_provider() loads correct config for cline"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_MCP 2>/dev/null || true

if load_provider "cline"; then
    if [ "$PROVIDER_NAME" = "cline" ] && [ "$PROVIDER_CLI" = "cline" ] && [ "$PROVIDER_DEGRADED" = "false" ]; then
        log_pass "load_provider() correctly loads cline config (not degraded)"
    else
        log_fail "load_provider() loaded cline but variables incorrect (NAME=$PROVIDER_NAME, DEGRADED=$PROVIDER_DEGRADED)"
    fi
else
    log_fail "load_provider() failed to load cline"
fi

# ===========================================
# Test 9: Cline has subagents and MCP (Tier 2)
# ===========================================
log_test "Cline provider has subagents and MCP capabilities"
unset PROVIDER_NAME PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_MCP PROVIDER_HAS_TASK_TOOL 2>/dev/null || true

if load_provider "cline"; then
    if [ "$PROVIDER_HAS_SUBAGENTS" = "true" ] && [ "$PROVIDER_HAS_MCP" = "true" ] && [ "$PROVIDER_HAS_TASK_TOOL" = "false" ]; then
        log_pass "Cline has subagents=true, MCP=true, Task tool=false (Tier 2)"
    else
        log_fail "Cline capability flags incorrect (subagents=$PROVIDER_HAS_SUBAGENTS, MCP=$PROVIDER_HAS_MCP, task=$PROVIDER_HAS_TASK_TOOL)"
    fi
else
    log_fail "load_provider() failed to load cline for capability check"
fi

# ===========================================
# Test 10: load_provider() loads aider config correctly
# ===========================================
log_test "load_provider() loads correct config for aider"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "aider"; then
    if [ "$PROVIDER_NAME" = "aider" ] && [ "$PROVIDER_CLI" = "aider" ] && [ "$PROVIDER_DEGRADED" = "true" ]; then
        log_pass "load_provider() correctly loads aider config (degraded)"
    else
        log_fail "load_provider() loaded aider but variables incorrect (NAME=$PROVIDER_NAME, DEGRADED=$PROVIDER_DEGRADED)"
    fi
else
    log_fail "load_provider() failed to load aider"
fi

# ===========================================
# Test 11: Aider is fully degraded (Tier 3)
# ===========================================
log_test "Aider provider is fully degraded (no subagents, no MCP)"
unset PROVIDER_NAME PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_MCP PROVIDER_HAS_TASK_TOOL PROVIDER_HAS_PARALLEL 2>/dev/null || true

if load_provider "aider"; then
    if [ "$PROVIDER_HAS_SUBAGENTS" = "false" ] && [ "$PROVIDER_HAS_MCP" = "false" ] && [ "$PROVIDER_HAS_TASK_TOOL" = "false" ] && [ "$PROVIDER_HAS_PARALLEL" = "false" ]; then
        log_pass "Aider all capabilities false (Tier 3 degraded)"
    else
        log_fail "Aider capability flags incorrect (subagents=$PROVIDER_HAS_SUBAGENTS, MCP=$PROVIDER_HAS_MCP)"
    fi
else
    log_fail "load_provider() failed to load aider for capability check"
fi

# ===========================================
# Test 12: Cline and Aider not in auto_detect_provider
# ===========================================
log_test "auto_detect_provider() does not return cline or aider"
detected=$(auto_detect_provider 2>/dev/null)
if [ "$detected" != "cline" ] && [ "$detected" != "aider" ]; then
    log_pass "auto_detect_provider() does not auto-detect cline or aider"
else
    log_fail "auto_detect_provider() should not auto-detect $detected"
fi

# ===========================================
# Test 13: P12-26 permission policy flags (claude)
# ===========================================
log_test "claude permission argv: default is compiled only with an operator policy (else legacy); legacy keeps skip-permissions; unknown fails closed to compiled"
export LOKI_WEB_POLICY=off # w2-07: these assertions pin the policy-only argv; defaults are tested in Test 13b
_pp_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.pp.XXXXXX")"
mkdir -p "$_pp_dir/.loki"
printf '%s' '{"claude_permissions":{"mode":"acceptEdits","allow":["Read","Bash(rm:*)"],"deny":["Bash(rm:*)"]}}' > "$_pp_dir/.loki/policies.json"
# shellcheck disable=SC2016
_pp_probe='source "$1/providers/claude.sh" 2>/dev/null; _loki_claude_permission_argv; printf "%s|" "${_LOKI_PERM_ARGV[@]}"'
_pp_leg=$(LOKI_PERMISSION_POLICY=legacy LOKI_PROJECT_DIR="$_pp_dir" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/..")
_pp_def=$(env -u LOKI_PERMISSION_POLICY HOME="$_pp_dir" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/..")
_pp_unk=$(LOKI_PERMISSION_POLICY=bogus HOME="$_pp_dir" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/.." 2>"$_pp_dir/unk.err")
_pp_unkwarn=$(grep -c "unknown value" "$_pp_dir/unk.err")
mkdir -p "$_pp_dir/empty-home"
_pp_banner_def=$(env -u LOKI_PERMISSION_POLICY HOME="$_pp_dir" bash -c 'source "$1/providers/claude.sh" 2>/dev/null; loki_permission_policy_banner' _ "$PROVIDERS_DIR/..")
_pp_banner_nopol=$(env -u LOKI_PERMISSION_POLICY HOME="$_pp_dir/empty-home" bash -c 'source "$1/providers/claude.sh" 2>/dev/null; loki_permission_policy_banner' _ "$PROVIDERS_DIR/..")
_pp_nopol_unset=$(env -u LOKI_PERMISSION_POLICY HOME="$_pp_dir/empty-home" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/..")
_pp_nopol_cmp=$(LOKI_PERMISSION_POLICY=compiled HOME="$_pp_dir/empty-home" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir/empty-home" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/.." 2>/dev/null)
mkdir -p "$_pp_dir/yaml-cost/.loki" "$_pp_dir/yaml-cp/.loki"
printf 'policies:\n  cost:\n    max: 5\n' > "$_pp_dir/yaml-cost/.loki/policies.yaml"
printf 'policies:\n  claude_permissions:\n    mode: default\n' > "$_pp_dir/yaml-cp/.loki/policies.yaml"
_pp_yaml_cost=$(env -u LOKI_PERMISSION_POLICY HOME="$_pp_dir/yaml-cost" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir/yaml-cost" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/..")
_pp_yaml_cp=$(env -u LOKI_PERMISSION_POLICY HOME="$_pp_dir/yaml-cp" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir/yaml-cp" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/.." 2>/dev/null)
_pp_banner_leg=$(LOKI_PERMISSION_POLICY=legacy bash -c 'source "$1/providers/claude.sh" 2>/dev/null; loki_permission_policy_banner' _ "$PROVIDERS_DIR/..")
_pp_cmp=$(LOKI_PERMISSION_POLICY=compiled HOME="$_pp_dir" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/..")
printf '%s' '{bad' > "$_pp_dir/.loki/policies.json"
_pp_bad=$(LOKI_PERMISSION_POLICY=compiled HOME="$_pp_dir" LOKI_MANAGED_SETTINGS="$_pp_dir/none.json" LOKI_PROJECT_DIR="$_pp_dir" bash -c "$_pp_probe" _ "$PROVIDERS_DIR/.." 2>/dev/null)
rm -rf "$_pp_dir"
_pp_want="--permission-mode|acceptEdits|--allowedTools|Read|--disallowedTools|Bash(rm:*)|"
if [ "$_pp_leg" = "--dangerously-skip-permissions|" ] \
   && [ "$_pp_def" = "$_pp_want" ] \
   && [ "$_pp_unk" = "$_pp_want" ] && [ "$_pp_unkwarn" -ge 1 ] \
   && [ "$_pp_banner_def" = "Permission policy: compiled (set LOKI_PERMISSION_POLICY=legacy to revert)" ] \
   && [ "$_pp_banner_leg" = "Permission policy: legacy (unset LOKI_PERMISSION_POLICY to use compiled)" ] \
   && [ "$_pp_banner_nopol" = "Permission policy: legacy (no operator policy found; add one to use compiled)" ] \
   && [ "$_pp_nopol_unset" = "--dangerously-skip-permissions|" ] \
   && [ "$_pp_nopol_cmp" = "--permission-mode|acceptEdits|" ] \
   && [ "$_pp_yaml_cost" = "--dangerously-skip-permissions|" ] \
   && [ "$_pp_yaml_cp" = "--permission-mode|plan|" ] \
   && [ "$_pp_cmp" = "$_pp_want" ] \
   && [ "$_pp_bad" = "--permission-mode|plan|" ]; then
    log_pass "default compiled, legacy escape hatch, unknown fails closed, banner present, invalid policy fails closed"
else
    log_fail "permission argv mismatch: leg=[$_pp_leg] unk=[$_pp_unk] banner=[$_pp_banner_def] def=[$_pp_def] cmp=[$_pp_cmp] bad=[$_pp_bad] nopol_banner=[$_pp_banner_nopol] nopol_unset=[$_pp_nopol_unset] nopol_cmp=[$_pp_nopol_cmp] yaml_cost=[$_pp_yaml_cost] yaml_cp=[$_pp_yaml_cp]"
fi

unset LOKI_WEB_POLICY

# ===========================================
# Test 13b: w2-07 default web and credential deny on the bash route
# ===========================================
log_test "claude permission argv: web tools and credential reads denied by default; LOKI_WEB_POLICY=off restores"
_pw_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.pw.XXXXXX")"
# shellcheck disable=SC2016
_pw_probe='source "$1/providers/claude.sh" 2>/dev/null; _loki_claude_permission_argv; printf "%s|" "${_LOKI_PERM_ARGV[@]}"'
_pw_want="--dangerously-skip-permissions|--disallowedTools|WebFetch,WebSearch,Read(//**/.env*),Read(//**/.aws/**),Read(//**/.ssh/**),Read(//**/*.pem)|"
_pw_leg=$(env -u LOKI_WEB_POLICY LOKI_PERMISSION_POLICY=legacy HOME="$_pw_dir" LOKI_PROJECT_DIR="$_pw_dir" bash -c "$_pw_probe" _ "$PROVIDERS_DIR/..")
_pw_off=$(LOKI_WEB_POLICY=off LOKI_PERMISSION_POLICY=legacy HOME="$_pw_dir" LOKI_PROJECT_DIR="$_pw_dir" bash -c "$_pw_probe" _ "$PROVIDERS_DIR/..")
_pw_allow=$(env -u LOKI_WEB_POLICY LOKI_PERMISSION_POLICY=compiled LOKI_WEB_ALLOW_DOMAINS=docs.python.org HOME="$_pw_dir" LOKI_MANAGED_SETTINGS="$_pw_dir/none.json" LOKI_PROJECT_DIR="$_pw_dir" bash -c "$_pw_probe" _ "$PROVIDERS_DIR/.." 2>/dev/null)
rm -rf "$_pw_dir"
if [ "$_pw_leg" = "$_pw_want" ] && [ "$_pw_off" = "--dangerously-skip-permissions|" ] \
   && [ "$_pw_allow" = "--permission-mode|acceptEdits|--allowedTools|WebFetch(domain:docs.python.org)|--disallowedTools|WebSearch,Read(//**/.env*),Read(//**/.aws/**),Read(//**/.ssh/**),Read(//**/*.pem)|" ]; then
    log_pass "default deny, opt-out, and domain allowlist on the bash route"
else
    log_fail "web policy argv: leg=[$_pw_leg] off=[$_pw_off] allow=[$_pw_allow]"
fi

# ===========================================
# Test 14: P12-26b quickstart + python sites reach the shared helper
# ===========================================
log_test "quickstart classify and magic debate honor LOKI_PERMISSION_POLICY (stub claude)"
export LOKI_WEB_POLICY=off # w2-07: pin the policy-only argv (see Test 13b)
_pq_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.pq.XXXXXX")"
mkdir -p "$_pq_dir/.loki" "$_pq_dir/bin"
printf '%s' '{"claude_permissions":{"mode":"acceptEdits","deny":["Bash(rm:*)"]}}' > "$_pq_dir/.loki/policies.json"
printf '#!/bin/sh\nprintf "%%s|" "$@" > "%s/argv"\necho ok\n' "$_pq_dir" > "$_pq_dir/bin/claude"
chmod +x "$_pq_dir/bin/claude"
_pq_root="$PROVIDERS_DIR/.."
# shellcheck disable=SC2016
_pq_qs='source "$1/autonomy/quickstart.sh" >/dev/null 2>&1; _qs_classify_invoke "hi" >/dev/null 2>&1; cat "$2/argv"'
_pq_env=(LOKI_NO_BROWSER=1 LOKI_ALLOW_CLAUDE_SIDECALLS=1 LOKI_PROVIDER=claude PATH="$_pq_dir/bin:$PATH" HOME="$_pq_dir" LOKI_MANAGED_SETTINGS="$_pq_dir/none.json" LOKI_PROJECT_DIR="$_pq_dir")
_pq_def=$(env LOKI_PERMISSION_POLICY=legacy "${_pq_env[@]}" bash -c "$_pq_qs" _ "$_pq_root" "$_pq_dir")
_pq_cmp=$(env LOKI_PERMISSION_POLICY=compiled "${_pq_env[@]}" bash -c "$_pq_qs" _ "$_pq_root" "$_pq_dir")
# shellcheck disable=SC2016
_pq_py='import sys; sys.path.insert(0, sys.argv[1]); from magic.core.debate import DebateRunner; r = DebateRunner.__new__(DebateRunner); r.provider = "claude"; r.project_dir = sys.argv[2]; print("|".join(r._build_command("p")))'
_pq_pdef=$(env LOKI_PERMISSION_POLICY=legacy "${_pq_env[@]}" python3 -c "$_pq_py" "$_pq_root" "$_pq_dir")
_pq_pcmp=$(env LOKI_PERMISSION_POLICY=compiled "${_pq_env[@]}" python3 -c "$_pq_py" "$_pq_root" "$_pq_dir")
_pq_want="--permission-mode|acceptEdits|--disallowedTools|Bash(rm:*)|"
_pq_ddef=$(env -u LOKI_PERMISSION_POLICY "${_pq_env[@]}" bash -c "$_pq_qs" _ "$_pq_root" "$_pq_dir")
_pq_pddef=$(env -u LOKI_PERMISSION_POLICY "${_pq_env[@]}" python3 -c "$_pq_py" "$_pq_root" "$_pq_dir")
rm -rf "$_pq_dir"
if [ "$_pq_def" = "--dangerously-skip-permissions|-p|hi|" ] \
   && [ "$_pq_cmp" = "${_pq_want}-p|hi|" ] \
   && [ "$_pq_pdef" = "claude|--dangerously-skip-permissions|-p|p" ] \
   && [ "$_pq_pcmp" = "claude|${_pq_want}-p|p" ] \
   && [ "$_pq_ddef" = "${_pq_want}-p|hi|" ] \
   && [ "$_pq_pddef" = "claude|${_pq_want}-p|p" ]; then
    log_pass "quickstart and debate: legacy keeps the flag, default and compiled apply the policy"
else
    log_fail "p12-26b mismatch: qs_def=[$_pq_def] qs_cmp=[$_pq_cmp] py_def=[$_pq_pdef] py_cmp=[$_pq_pcmp]"
fi

unset LOKI_WEB_POLICY

# ===========================================
# Test 15: P12-26b helper leaks no exports and fails closed
# ===========================================
log_test "loki _loki_perm_argv_for: no caveman leak under legacy, plan when helper missing"
export LOKI_WEB_POLICY=off # w2-07: pin the policy-only argv (see Test 13b)
_pl_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.pl.XXXXXX")"
sed -n '/^_loki_perm_argv_for() {/,/^}/p' "$PROVIDERS_DIR/../autonomy/loki" > "$_pl_dir/fn.sh"
# shellcheck disable=SC2016
_pl_probe='. "$1/fn.sh"; _LOKI_SCRIPT_DIR="$2"; _loki_perm_argv_for "$1"; printf "%s|%s" "${CAVEMAN_DEFAULT_MODE:-unset}" "${_LOKI_PERM_ARGV[*]}"'
_pl_leak=$(LOKI_PERMISSION_POLICY=legacy CAVEMAN_DEFAULT_MODE=full bash -c "$_pl_probe" _ "$_pl_dir" "$PROVIDERS_DIR/../autonomy" 2>/dev/null)
_pl_cmpleak=$(LOKI_PERMISSION_POLICY=compiled HOME="$_pl_dir" LOKI_MANAGED_SETTINGS="$_pl_dir/none.json" CAVEMAN_DEFAULT_MODE=full bash -c "$_pl_probe" _ "$_pl_dir" "$PROVIDERS_DIR/../autonomy" 2>/dev/null)
_pl_miss=$(LOKI_PERMISSION_POLICY=compiled CAVEMAN_DEFAULT_MODE=full bash -c "$_pl_probe" _ "$_pl_dir" "$_pl_dir/nolib" 2>/dev/null)
# quickstart: helper missing + compiled must fail closed
_pl_qs=$(LOKI_PERMISSION_POLICY=compiled LOKI_ALLOW_CLAUDE_SIDECALLS=1 LOKI_PROVIDER=claude PATH="$_pl_dir:$PATH" bash -c '
  printf "#!/bin/sh\nprintf \"%%s|\" \"\$@\" > \"%s/argv\"\n" "$1" > "$1/claude"; chmod +x "$1/claude"
  mkdir -p "$1/qs/lib"; cp "$2/autonomy/quickstart.sh" "$1/qs/quickstart.sh"; mkdir -p "$1/providers"; cp "$2/providers/"*.sh "$1/providers/"
  . "$1/qs/quickstart.sh" >/dev/null 2>&1; _qs_classify_invoke hi >/dev/null 2>&1; cat "$1/argv"' _ "$_pl_dir" "$PROVIDERS_DIR/.." 2>/dev/null)
rm -rf "$_pl_dir"
if [ "$_pl_leak" = "full|--dangerously-skip-permissions" ] \
   && [ "$_pl_cmpleak" = "full|--permission-mode acceptEdits" ] \
   && [ "$_pl_miss" = "full|--permission-mode plan" ] \
   && [ "$_pl_qs" = "--permission-mode|plan|-p|hi|" ]; then
    log_pass "no leak, legacy flag under legacy, plan when helper missing"
else
    log_fail "p12-26b helper: leak=[$_pl_leak] cmpleak=[$_pl_cmpleak] miss=[$_pl_miss] qs=[$_pl_qs]"
fi

unset LOKI_WEB_POLICY

# Test 16: P12-27 OTel passthrough (set vars only, unchanged, never invented)
echo ""
echo "Test 16: OTel passthrough and gateway lane label (P12-27)"
# Vars are set NON-exported inside the shell so only the loader export helper can
# hand them to the child (an exported prefix would be inherited regardless).
_ot_out=$(env -u OTEL_SERVICE_NAME -u OTEL_RESOURCE_ATTRIBUTES -u OTEL_EXPORTER_OTLP_HEADERS \
    -u OTEL_EXPORTER_OTLP_ENDPOINT -u CLAUDE_CODE_ENABLE_TELEMETRY \
    bash -c 'OTEL_EXPORTER_OTLP_ENDPOINT="http://c:4318"; CLAUDE_CODE_ENABLE_TELEMETRY=1
      source "$1/providers/loader.sh"; load_provider claude >/dev/null 2>&1
      bash "$1/providers/model_route_exec.sh" env | grep -E "^(OTEL_|CLAUDE_CODE_ENABLE_TELEMETRY)" | sort | tr "\n" "|"' _ "$PROVIDERS_DIR/..")
if [ "$_ot_out" = "CLAUDE_CODE_ENABLE_TELEMETRY=1|OTEL_EXPORTER_OTLP_ENDPOINT=http://c:4318|" ]; then
    log_pass "OTel vars reach the child unchanged; unset ones are not invented"
else
    log_fail "otel passthrough: [$_ot_out]"
fi

_gl_route=$(env -u ANTHROPIC_BASE_URL -u LOKI_MODEL_OVERRIDE LOKI_MODEL_ROUTE=ollama/qwen3-coder \
    bash -c 'source "$1/model_routes.sh"; loki_model_route_lane_label' _ "$PROVIDERS_DIR")
_gl_gw=$(env -u LOKI_MODEL_ROUTE ANTHROPIC_BASE_URL=https://gw.example LOKI_MODEL_OVERRIDE=gpt-5 \
    bash -c 'source "$1/model_routes.sh"; loki_model_route_lane_label' _ "$PROVIDERS_DIR")
_gl_claude=$(env -u LOKI_MODEL_ROUTE ANTHROPIC_BASE_URL=https://gw.example LOKI_MODEL_OVERRIDE=sonnet \
    bash -c 'source "$1/model_routes.sh"; loki_model_route_lane_label' _ "$PROVIDERS_DIR")
_gl_none=$(env -u LOKI_MODEL_ROUTE -u ANTHROPIC_BASE_URL -u LOKI_MODEL_OVERRIDE \
    bash -c 'source "$1/model_routes.sh"; loki_model_route_lane_label' _ "$PROVIDERS_DIR")
_gl_rep=$(env -u ANTHROPIC_BASE_URL -u LOKI_MODEL_OVERRIDE LOKI_MODEL_ROUTE=ollama/qwen3-coder \
    bash -c 'source "$1/model_routes.sh"; loki_model_route_lane_report' _ "$PROVIDERS_DIR" | tail -1)
if [ "$_gl_rep" != "prompt caching, extended thinking, server tools and hooks are not guaranteed on this lane" ]; then
    log_fail "lane report loss line: [$_gl_rep]"
fi
if [ "$_gl_route" = "gateway lane (unqualified)" ] && [ "$_gl_gw" = "gateway lane (unqualified)" ] \
   && [ -z "$_gl_claude" ] && [ -z "$_gl_none" ]; then
    log_pass "gateway lane label on non-Anthropic routes only"
else
    log_fail "lane label: route=[$_gl_route] gw=[$_gl_gw] claude=[$_gl_claude] none=[$_gl_none]"
fi

# #242: a PROVIDER_DEFAULT_* knob defined in providers/*.sh must have a reader
# (any other line naming it, in any tracked-style source file). An orphan makes
# the matching LOKI_* env var a silent no-op. Run against a planted orphan too.
_pd_orphans() {
    local root="$1" name n
    while IFS= read -r name; do
        n=$(grep -rIw --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=history \
            -e "$name" "$root" 2>/dev/null | grep -vE "^[^:]*:[[:space:]]*${name}=" | grep -c . || true)
        [ "${n:-0}" -eq 0 ] && echo "$name"
    done < <(grep -rhoE "^[[:space:]]*PROVIDER_DEFAULT_[A-Z0-9_]+=" "$root/providers" 2>/dev/null | tr -d ' \t=' | sort -u)
}
_pd_real="$(_pd_orphans "$PROVIDERS_DIR/..")"
if [ -z "$_pd_real" ]; then
    log_pass "every PROVIDER_DEFAULT_* knob has a reader"
else
    log_fail "PROVIDER_DEFAULT_* knobs with no reader: $_pd_real"
fi
_pd_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.pd.XXXXXX")"
mkdir -p "$_pd_dir/providers"
printf 'PROVIDER_DEFAULT_PLANTED_ORPHAN="${LOKI_PLANTED:-x}"\n' > "$_pd_dir/providers/x.sh"
_pd_planted="$(_pd_orphans "$_pd_dir")"
rm -rf "$_pd_dir"
if [ "$_pd_planted" = "PROVIDER_DEFAULT_PLANTED_ORPHAN" ]; then
    log_pass "orphan guard goes red on a planted PROVIDER_DEFAULT_* knob"
else
    log_fail "orphan guard missed the planted knob: [$_pd_planted]"
fi

# #346 slice 2: LOKI_EFFORT reaches claude, aider, opencode and cline through the catalog,
# clamped per provider/model, with the effective effort recorded per stage.
_ef_argv() {
    local prov="$1" req="$2" ldir="$3"
    LOKI_DIR="$ldir" LOKI_EFFORT="$req" bash -c '
        source "$1/loader.sh"; load_provider "$2" >/dev/null 2>&1; provider_invoke_argv development "p"
        printf "%s\n" "${_LOKI_INVOKE_ARGV[@]}"' _ "$PROVIDERS_DIR" "$prov"
}
_ef_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.ef.XXXXXX")"
_ef_flag() { _ef_argv "$1" "$2" "$_ef_dir" | grep -A1 -x -e "$3" | tail -1; }
[ "$(_ef_flag aider high --reasoning-effort)" = "high" ] \
    && log_pass "LOKI_EFFORT=high -> aider --reasoning-effort high" \
    || log_fail "aider effort flag missing: [$(_ef_flag aider high --reasoning-effort)]"
[ "$(_ef_flag opencode high --variant)" = "high" ] \
    && log_pass "LOKI_EFFORT=high -> opencode --variant high" \
    || log_fail "opencode effort flag missing: [$(_ef_flag opencode high --variant)]"
[ "$(_ef_flag aider max --reasoning-effort)" = "high" ] \
    && log_pass "LOKI_EFFORT=max clamps to high for aider" \
    || log_fail "aider max not clamped: [$(_ef_flag aider max --reasoning-effort)]"
if _ef_argv cline high "$_ef_dir" | grep -qiE -e '^--(effort|variant|reasoning-effort|thinking)'; then
    log_fail "cline emitted an invented effort flag"
else
    log_pass "cline emits no effort flag (unsupported)"
fi
if _ef_argv aider "" "$_ef_dir" | grep -q -e '--reasoning-effort'; then
    log_fail "aider emitted an effort flag with LOKI_EFFORT unset"
else
    log_pass "no LOKI_EFFORT, no effort flag"
fi
_ef_ledger="$_ef_dir/state/effort.jsonl"
if grep -q '"provider":"aider".*"effort":"high".*"clamped_from":"max"' "$_ef_ledger" 2>/dev/null \
   && grep -q '"provider":"cline".*"effort":"unsupported"' "$_ef_ledger" 2>/dev/null \
   && grep -q '"provider":"opencode".*"effort":"high"' "$_ef_ledger" 2>/dev/null; then
    log_pass "effective effort recorded per stage (clamped_from and unsupported included)"
else
    log_fail "effort ledger incomplete: $(tr '\n' ' ' < "$_ef_ledger" 2>/dev/null)"
fi
_ef_claude="$(LOKI_EFFORT=low bash -c 'source "$1/../autonomy/lib/claude-flags.sh"; loki_effort_for_tier development standard ""' _ "$PROVIDERS_DIR" 2>/dev/null)"
_ef_claude_max="$(LOKI_EFFORT=max bash -c 'source "$1/../autonomy/lib/claude-flags.sh"; loki_effort_for_tier development standard claude-opus-5-5' _ "$PROVIDERS_DIR" 2>/dev/null)"
[ "$_ef_claude" = "low" ] && log_pass "LOKI_EFFORT overrides the claude tier effort" \
    || log_fail "claude LOKI_EFFORT ignored: [$_ef_claude]"
[ "$_ef_claude_max" = "max" ] && log_pass "claude LOKI_EFFORT=max kept on a model whose catalog allows max" \
    || log_fail "claude clamp wrong: [$_ef_claude_max]"
rm -rf "$_ef_dir"


# PG-19 review: the claude route records clamped_from only for a valid level that was clamped, and every
# ledger line is valid JSON whatever LOKI_EFFORT holds.
_ef2_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.ef2.XXXXXX")"
_ef2_claude() {
    LOKI_DIR="$_ef2_dir" LOKI_EFFORT="$1" bash -c '
        source "$1/loader.sh"; load_provider claude >/dev/null 2>&1
        source "$1/../autonomy/lib/claude-flags.sh"
        loki_claude_flag_supported() { return 0; }
        _loki_build_claude_auto_flags development standard claude-opus-5-5' _ "$PROVIDERS_DIR" >/dev/null 2>&1
}
_ef2_claude 'a"b'
_ef2_claude HIGH
_ef2_claude garbage
_ef2_claude max
_ef2_claude low
_ef2_bad=""
while IFS= read -r _l; do
    printf '%s' "$_l" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null || _ef2_bad="$_ef2_bad [$_l]"
done < "$_ef2_dir/state/effort.jsonl"
[ -z "$_ef2_bad" ] && [ "$(wc -l < "$_ef2_dir/state/effort.jsonl" | tr -d ' ')" = "5" ] \
    && log_pass "every effort ledger line is valid JSON, hostile LOKI_EFFORT included" \
    || log_fail "invalid or missing effort ledger lines:$_ef2_bad"
_ef2_cf="$(python3 -c '
import json,sys
print(",".join(json.loads(l)["clamped_from"] for l in open(sys.argv[1])))' "$_ef2_dir/state/effort.jsonl")"
[ "$_ef2_cf" = ",,,,"  ] \
    && log_pass "claude records no clamped_from for invalid values or an unclamped level" \
    || log_fail "claude clamped_from wrong: [$_ef2_cf]"
rm -rf "$_ef2_dir"

# Effort knob startup cost: loki_effort_argv must start python3 exactly once per call (resolve and
# ledger write share one process). A python3 shim on PATH counts starts deterministically.
_lat_dir="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.lat.XXXXXX")"
_lat_real_py="$(command -v python3)"
mkdir -p "$_lat_dir/bin"
printf '#!/bin/sh\necho x >> "%s/count"\nexec "%s" "$@"\n' "$_lat_dir" "$_lat_real_py" > "$_lat_dir/bin/python3"
chmod 755 "$_lat_dir/bin/python3"
for _lat_p in opencode aider cline; do
    PATH="$_lat_dir/bin:$PATH" LOKI_DIR="$_lat_dir/ldir" LOKI_EFFORT=high bash -c '
        source "$1/models.sh"; : > "$3/count"; loki_effort_argv "$2" "" development' _ "$PROVIDERS_DIR" "$_lat_p" "$_lat_dir"
    _lat_n="$(wc -l < "$_lat_dir/count" | tr -d ' ')"
    [ "$_lat_n" = "1" ] \
        && log_pass "$_lat_p loki_effort_argv starts python3 exactly once" \
        || log_fail "$_lat_p loki_effort_argv started python3 $_lat_n times (expected 1)"
done
rm -rf "$_lat_dir"


echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
