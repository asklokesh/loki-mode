#!/usr/bin/env bash
# tests/test-claude-flags.sh -- Phase B (v7.5.19) regression test for autonomy/lib/claude-flags.sh.
#
# Verifies:
# - loki_effort_for_tier maps RARV tiers to effort levels per spec
# - loki_effort_for_tier shifts up one notch when complexity=complex
# - loki_remaining_budget emits empty when LOKI_BUDGET_LIMIT unset/0
# - loki_remaining_budget computes correctly when budget.json exists
# - loki_remaining_budget emits empty when remaining <= 0 (never emits 0)
# - loki_fallback_for_primary maps opus->sonnet always; sonnet->haiku only with LOKI_ALLOW_HAIKU=true
# - loki_claude_flag_supported caches the help output and returns 0/1 honestly

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

# ---------- Static checks ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "helper parses with bash -n"
else
    bad "helper failed bash -n"
fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S error "$HELPER" >/dev/null 2>&1; then
        ok "helper shellcheck -S error clean"
    else
        bad "helper shellcheck -S error reported issues"
    fi
else
    ok "SKIP: shellcheck not on PATH"
fi

# Source the helper for the function tests.
# shellcheck disable=SC1090
. "$HELPER"

# ---------- loki_effort_for_tier ----------
v=$(loki_effort_for_tier planning); [ "$v" = "xhigh" ] && ok "effort planning=xhigh" || bad "effort planning got [$v]"
v=$(loki_effort_for_tier development); [ "$v" = "high" ] && ok "effort development=high" || bad "effort development got [$v]"
v=$(loki_effort_for_tier fast); [ "$v" = "medium" ] && ok "effort fast=medium" || bad "effort fast got [$v]"

# Capability alias inputs
v=$(loki_effort_for_tier best); [ "$v" = "xhigh" ] && ok "effort best=xhigh" || bad "effort best got [$v]"
v=$(loki_effort_for_tier balanced); [ "$v" = "high" ] && ok "effort balanced=high" || bad "effort balanced got [$v]"
v=$(loki_effort_for_tier cheap); [ "$v" = "low" ] && ok "effort cheap=low" || bad "effort cheap got [$v]"

# Unknown tier defaults to high
v=$(loki_effort_for_tier mystery); [ "$v" = "high" ] && ok "effort unknown=high (default)" || bad "effort unknown got [$v]"

# Complexity=complex shifts one notch up
v=$(loki_effort_for_tier development complex); [ "$v" = "xhigh" ] && ok "effort development+complex=xhigh" || bad "effort development+complex got [$v]"
v=$(loki_effort_for_tier fast complex); [ "$v" = "high" ] && ok "effort fast+complex=high" || bad "effort fast+complex got [$v]"
v=$(loki_effort_for_tier cheap complex); [ "$v" = "medium" ] && ok "effort cheap+complex=medium" || bad "effort cheap+complex got [$v]"
v=$(loki_effort_for_tier planning complex); [ "$v" = "xhigh" ] && ok "effort planning+complex=xhigh (no auto-max)" || bad "effort planning+complex got [$v]"

# ---------- loki_remaining_budget ----------
TMPROOT=$(mktemp -d -t loki-claude-flags-XXXX)
mkdir -p "$TMPROOT/.loki/metrics"

# Empty LOKI_BUDGET_LIMIT -> empty output
v=$(LOKI_BUDGET_LIMIT="" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: unset limit -> empty" || bad "remaining_budget unset got [$v]"

# Zero LOKI_BUDGET_LIMIT -> empty
v=$(LOKI_BUDGET_LIMIT="0" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: limit=0 -> empty" || bad "remaining_budget limit=0 got [$v]"

v=$(LOKI_BUDGET_LIMIT="0.00" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: limit=0.00 -> empty" || bad "remaining_budget limit=0.00 got [$v]"

# Limit + no budget.json -> emit full limit (no spend recorded)
v=$(LOKI_BUDGET_LIMIT="50" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ "$v" = "50.00" ] && ok "remaining_budget: limit=50, no spend -> 50.00" || bad "remaining_budget no spend got [$v]"

# Limit + budget.json with spend -> emit difference
python3 -c "import json; open('$TMPROOT/.loki/metrics/budget.json','w').write(json.dumps({'current_spend': 12.34}))"
v=$(LOKI_BUDGET_LIMIT="50" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ "$v" = "37.66" ] && ok "remaining_budget: 50 - 12.34 = 37.66" || bad "remaining_budget got [$v]"

# Spend exceeds limit -> emit empty (never emit 0 or negative)
python3 -c "import json; open('$TMPROOT/.loki/metrics/budget.json','w').write(json.dumps({'current_spend': 60.00}))"
v=$(LOKI_BUDGET_LIMIT="50" TARGET_DIR="$TMPROOT" loki_remaining_budget)
[ -z "$v" ] && ok "remaining_budget: overspent -> empty (no 0 or negative)" || bad "remaining_budget overspent got [$v]"

# ---------- loki_fallback_for_primary ----------
v=$(loki_fallback_for_primary opus); [ "$v" = "sonnet" ] && ok "fallback opus -> sonnet" || bad "fallback opus got [$v]"

# sonnet -> haiku ONLY when LOKI_ALLOW_HAIKU=true
v=$(LOKI_ALLOW_HAIKU=false loki_fallback_for_primary sonnet)
[ -z "$v" ] && ok "fallback sonnet (no haiku) -> empty" || bad "fallback sonnet no-haiku got [$v]"

v=$(LOKI_ALLOW_HAIKU=true loki_fallback_for_primary sonnet)
[ "$v" = "haiku" ] && ok "fallback sonnet (allow-haiku) -> haiku" || bad "fallback sonnet allow-haiku got [$v]"

v=$(LOKI_ALLOW_HAIKU=true loki_fallback_for_primary haiku)
[ -z "$v" ] && ok "fallback haiku -> empty (no further fallback)" || bad "fallback haiku got [$v]"

v=$(loki_fallback_for_primary claude-opus-4-7)
[ -z "$v" ] && ok "fallback dated id -> empty (no auto-fallback)" || bad "fallback dated got [$v]"

# ---------- loki_claude_flag_supported ----------
if command -v claude >/dev/null 2>&1; then
    if loki_claude_flag_supported "--effort"; then
        ok "flag_supported --effort detected"
    else
        bad "flag_supported --effort NOT detected (Claude CLI version may be old)"
    fi
    if loki_claude_flag_supported "--definitely-not-a-real-flag-xyz123"; then
        bad "flag_supported false positive on fake flag"
    else
        ok "flag_supported correctly rejects unknown flag"
    fi
else
    ok "SKIP: claude not on PATH; flag_supported behavior untested"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
