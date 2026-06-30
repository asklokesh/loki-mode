#!/usr/bin/env bash
# Tests for _loki_build_worktree_claude_flags (autonomy/run.sh): the parallel
# worktree Claude invocation must apply the same auto-flags (effort, max-budget,
# fallback model, mcp-config) as the main invocation, each independently gated on
# CLI support + an opt-out env var, and never applied for non-claude providers.
#
# The function is extracted from run.sh and exercised with stubbed helper
# functions (the same injection seam the function uses via `type ... >/dev/null`)
# so no real provider/CLI is invoked.
set -uo pipefail

SCRIPT_DIR_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR_T/../autonomy/run.sh"
PASS=0
FAIL=0
ok()   { echo "ok: $1"; PASS=$((PASS + 1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# Extract just the function body from run.sh (line-drift resilient: from the
# function header to its closing brace at column 0).
FN_SRC="$(awk '/^_loki_build_worktree_claude_flags\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$RUN_SCRIPT")"
if [ -z "$FN_SRC" ]; then
  echo "FAIL: could not extract _loki_build_worktree_claude_flags from run.sh"
  exit 1
fi

# Run a scenario in a clean subshell: define stubs, source the function, call it,
# print the resulting flags array one element per line.
run_case() {
  # shellcheck disable=SC2317
  (
    set -uo pipefail
    # Default stubs: a claude CLI that supports every flag, helpers that return
    # deterministic values. Individual cases override via env before calling.
    loki_claude_flag_supported() { return 0; }
    provider_get_tier_param() { echo "claude-sonnet-4-6"; }
    loki_effort_for_tier() { echo "high"; }
    loki_remaining_budget() { echo "12.50"; }
    loki_fallback_for_primary() { echo "claude-haiku-4-5"; }
    loki_mcp_config_argv() { echo "--mcp-config"; echo "/tmp/mcp.json"; }
    # Allow per-case overrides of the above + env.
    eval "${CASE_SETUP:-}"
    # shellcheck disable=SC1090
    eval "$FN_SRC"
    _loki_build_worktree_claude_flags
    # Print the array (empty-array safe under set -u).
    printf '%s\n' ${_LOKI_WT_AUTO_FLAGS[@]+"${_LOKI_WT_AUTO_FLAGS[@]}"}
  )
}

# 1. claude + all supported -> all four flag groups present.
out="$(CASE_SETUP='PROVIDER_NAME=claude' run_case)"
echo "$out" | grep -q -- '--effort' && echo "$out" | grep -q 'high' && ok "effort flag applied" || bad "effort flag missing"
echo "$out" | grep -q -- '--max-budget-usd' && echo "$out" | grep -q '12.50' && ok "max-budget flag applied" || bad "max-budget missing"
echo "$out" | grep -q -- '--fallback-model' && echo "$out" | grep -q 'claude-haiku-4-5' && ok "fallback-model flag applied" || bad "fallback-model missing"
echo "$out" | grep -q -- '--mcp-config' && ok "mcp-config flag applied" || bad "mcp-config missing"

# 2. non-claude provider -> NO flags at all.
out="$(CASE_SETUP='PROVIDER_NAME=codex' run_case)"
[ -z "$(echo "$out" | tr -d '[:space:]')" ] && ok "non-claude provider gets zero auto-flags" || bad "non-claude provider wrongly got flags: $out"

# 3. opt-out env vars each suppress only their own flag.
out="$(CASE_SETUP='PROVIDER_NAME=claude; LOKI_AUTO_EFFORT=off' run_case)"
echo "$out" | grep -q -- '--effort' && bad "LOKI_AUTO_EFFORT=off did not suppress effort" || ok "LOKI_AUTO_EFFORT=off suppresses effort"
echo "$out" | grep -q -- '--max-budget-usd' && ok "max-budget still present when only effort opted out" || bad "max-budget wrongly suppressed"

out="$(CASE_SETUP='PROVIDER_NAME=claude; LOKI_AUTO_BUDGET=off' run_case)"
echo "$out" | grep -q -- '--max-budget-usd' && bad "LOKI_AUTO_BUDGET=off did not suppress budget" || ok "LOKI_AUTO_BUDGET=off suppresses budget"

out="$(CASE_SETUP='PROVIDER_NAME=claude; LOKI_AUTO_FALLBACK=off' run_case)"
echo "$out" | grep -q -- '--fallback-model' && bad "LOKI_AUTO_FALLBACK=off did not suppress fallback" || ok "LOKI_AUTO_FALLBACK=off suppresses fallback"

# 4. a flag the CLI does not support is not applied (gating on flag support).
out="$(CASE_SETUP='PROVIDER_NAME=claude; loki_claude_flag_supported() { [ "$1" != "--effort" ]; }' run_case)"
echo "$out" | grep -q -- '--effort' && bad "unsupported --effort was wrongly applied" || ok "unsupported flag is not applied"
echo "$out" | grep -q -- '--max-budget-usd' && ok "other supported flags still applied when one is unsupported" || bad "other flags wrongly dropped"

# 5. non-vacuity: the extracted function actually ran (claude case produced flags).
out="$(CASE_SETUP='PROVIDER_NAME=claude' run_case)"
[ -n "$(echo "$out" | tr -d '[:space:]')" ] && ok "non-vacuity: function produced flags in the claude case" || bad "non-vacuity: function produced nothing (extraction broken?)"

echo "===================================="
echo "Worktree auto-flags tests: PASS=$PASS FAIL=$FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
