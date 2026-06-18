#!/usr/bin/env bash
# Test: codex.sh resolve_model_for_tier normalizes LOKI_MAX_TIER (trim + lowercase)
# before applying the cost ceiling, mirroring claude.sh:356 (loki_apply_max_tier_clamp).
#
# Regression: pre-fix, codex.sh:163-171 switched on the RAW LOKI_MAX_TIER value, so a
# user-typed cap like "Haiku" or " haiku " (settings.json maxTier exports verbatim) fell
# through to the default arm and the cost ceiling was silently bypassed for codex, while
# claude honored it. This locks the parity fix: mixed-case / whitespace caps must cap.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Hermetic: codex resolve_model_for_tier reads these PROVIDER_EFFORT_* vars.
export PROVIDER_EFFORT_PLANNING="xhigh"
export PROVIDER_EFFORT_DEVELOPMENT="high"
export PROVIDER_EFFORT_FAST="low"

# shellcheck source=/dev/null
source "$REPO_ROOT/providers/codex.sh"

PASS=0
FAIL=0

# assert_effort <max_tier> <tier> <expected_effort> <description>
assert_effort() {
    local max_tier="$1" tier="$2" expected="$3" desc="$4"
    local actual
    actual="$(LOKI_MAX_TIER="$max_tier" resolve_model_for_tier "$tier")"
    if [ "$actual" = "$expected" ]; then
        echo "PASS: $desc (LOKI_MAX_TIER='$max_tier', tier=$tier -> $actual)"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $desc (LOKI_MAX_TIER='$max_tier', tier=$tier -> got '$actual', want '$expected')"
        FAIL=$((FAIL + 1))
    fi
}

# Exact-lowercase haiku already worked pre-fix (baseline / non-vacuity anchor).
assert_effort "haiku" "development" "low" "exact 'haiku' caps development -> low"

# The bug: these all fell through to 'high' (development default) pre-fix.
assert_effort "Haiku"  "development" "low" "mixed-case 'Haiku' caps development -> low"
assert_effort " haiku " "development" "low" "whitespace ' haiku ' caps development -> low"
assert_effort "HAIKU"  "development" "low" "uppercase 'HAIKU' caps development -> low"

# Mixed-case sonnet must also normalize (xhigh -> high).
assert_effort "Sonnet" "planning" "high" "mixed-case 'Sonnet' caps planning xhigh -> high"
assert_effort " SONNET " "planning" "high" "whitespace+upper ' SONNET ' caps planning xhigh -> high"

# Existing alias arms must still work after normalization.
assert_effort "low"  "planning" "low"   "alias 'low' caps planning -> low"
assert_effort "high" "planning" "high"  "alias 'high' caps planning xhigh -> high"
assert_effort "opus" "planning" "xhigh" "'opus' does not cap planning -> xhigh"
assert_effort "" "planning" "xhigh"     "empty ceiling leaves planning -> xhigh"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
