#!/usr/bin/env bash
# tests/test-tier-routing.sh
#
# SLICE 6a: complexity-aware MODEL routing (net-new; opt-in LOKI_TIER_ROUTING=1).
#
# Asserts the mapping table for resolve_model_for_tier (providers/claude.sh) with
# LOKI_TIER_ROUTING on and off:
#   - LOKI_TIER_ROUTING=0 (default)   -> flat sonnet on every tier (no change).
#   - complex  + planning             -> opus.
#   - simple   + fast + ALLOW_HAIKU   -> haiku.
#   - simple   + fast WITHOUT haiku   -> sonnet (never route to an unavailable model).
#   - development (ACT) tier          -> NEVER below sonnet, any complexity.
#   - standard complexity             -> unchanged (flat) on every tier.
#   - explicit override wins          -> a set LOKI_CLAUDE_MODEL_PLANNING is not
#                                        nudged even when complex+planning.
#
# NEVER invokes a real model. Pure function-sourcing; no network, no token spend.

set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"

# resolve_model_for_tier in a clean subshell with a controlled env so the sourced
# claude.sh recomputes PROVIDER_MODEL_* from the env we set (haiku, overrides).
# Echoes only the resolved model on stdout.
resolve() {
  # args: tier ; env passed by caller via `env VAR=... resolve tier`
  env -i \
    HOME="${HOME:-/tmp}" PATH="$PATH" \
    LOKI_TIER_ROUTING="${LOKI_TIER_ROUTING:-}" \
    LOKI_COMPLEXITY="${LOKI_COMPLEXITY:-}" \
    LOKI_ALLOW_HAIKU="${LOKI_ALLOW_HAIKU:-}" \
    LOKI_CLAUDE_MODEL_PLANNING="${LOKI_CLAUDE_MODEL_PLANNING:-}" \
    bash -c '
      set -u
      . "'"$CLAUDE_SH"'" >/dev/null 2>&1
      resolve_model_for_tier "'"$1"'"
    ' _ "$1"
}

expect() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then ok "$desc ($got)"; else bad "$desc: got '$got' want '$want'"; fi
}

# 0. Syntax sanity.
bash -n "$CLAUDE_SH" && ok "claude.sh passes bash -n" || bad "claude.sh syntax error"

# 1. LOKI_TIER_ROUTING=0 (default OFF) -> flat resolution, no complexity nudge.
#    Note: without ALLOW_HAIKU the flat fast default is sonnet, so complexity is
#    the ONLY variable under test here (ALLOW_HAIKU itself already flips the flat
#    fast default to haiku independently of routing -- see case 3 vs 6).
expect "routing-off complex planning -> flat sonnet" \
  "$(LOKI_TIER_ROUTING=0 LOKI_COMPLEXITY=complex resolve planning)" "sonnet"
expect "routing-off simple fast (no haiku) -> flat sonnet" \
  "$(LOKI_TIER_ROUTING=0 LOKI_COMPLEXITY=simple resolve fast)" "sonnet"
expect "routing-off complex development -> flat sonnet" \
  "$(LOKI_TIER_ROUTING=0 LOKI_COMPLEXITY=complex resolve development)" "sonnet"

# 2. LOKI_TIER_ROUTING=1: complex + planning -> opus.
expect "routing-on complex planning -> opus" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=complex resolve planning)" "opus"

# 3. LOKI_TIER_ROUTING=1: simple + fast + ALLOW_HAIKU -> haiku.
expect "routing-on simple fast+haiku -> haiku" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=simple LOKI_ALLOW_HAIKU=true resolve fast)" "haiku"

# 4. LOKI_TIER_ROUTING=1: simple + fast WITHOUT haiku -> sonnet (support gate).
expect "routing-on simple fast no-haiku -> sonnet" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=simple resolve fast)" "sonnet"

# 5. HARD GUARD: development (ACT) NEVER below sonnet, any complexity / haiku.
expect "routing-on simple development -> sonnet (guard)" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=simple LOKI_ALLOW_HAIKU=true resolve development)" "sonnet"
expect "routing-on complex development -> sonnet (guard, no opus bump)" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=complex resolve development)" "sonnet"

# 6. standard complexity -> routing inert (no complex opus-bump, no simple haiku-drop).
#    Both cases use configs where routing WOULD move the model if complexity were
#    complex/simple, proving the standard guard rather than a coincidental flat value.
expect "routing-on standard planning -> sonnet (no opus bump)" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=standard resolve planning)" "sonnet"
expect "routing-on standard fast+haiku -> haiku (flat, no simple-drop applied)" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=standard LOKI_ALLOW_HAIKU=true resolve fast)" "haiku"

# 7. explicit override wins: a set LOKI_CLAUDE_MODEL_PLANNING is not nudged even
#    on complex+planning (it already moved the model off the flat default).
expect "routing-on complex planning w/ explicit override -> honors override" \
  "$(LOKI_TIER_ROUTING=1 LOKI_COMPLEXITY=complex LOKI_CLAUDE_MODEL_PLANNING=sonnet resolve planning)" "sonnet"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
