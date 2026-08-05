#!/usr/bin/env bash
# Test: warn at RUN time when an alt-provider endpoint is configured without a
# model override.
#
# WHY THIS EXISTS
#   ANTHROPIC_BASE_URL routes Loki at a non-Anthropic endpoint (OpenRouter,
#   Ollama, LiteLLM, vLLM, self-hosted). The model override at
#   providers/claude.sh:520 and loki-ts/src/runner/providers.ts:328 applies ONLY
#   when ANTHROPIC_BASE_URL and LOKI_MODEL_OVERRIDE are BOTH set. With just the
#   base URL, Loki keeps resolving the Anthropic-only tier aliases
#   (opus/sonnet/haiku); most alt-providers reject those, and the run dies at the
#   first model call with a provider-side error the user cannot easily trace back
#   to a missing env var.
#
#   `loki doctor` already warns on this condition, but doctor is opt-in and the
#   run is not. This makes the run itself say it.
#
# Proven directions:
#   POSITIVE : base URL set, override absent  -> warns, and names the fix.
#   NEGATIVE-A: base URL set, override SET    -> silent (correctly configured).
#   NEGATIVE-B: no base URL at all            -> silent (the overwhelmingly
#              common case; a stock Anthropic run must not see alt-provider noise).
#   NON-FATAL : the helper always returns 0. A mapping proxy (LiteLLM) can serve
#              the aliases legitimately, so this must never block a run.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== alt-provider model-alias warning ==="

# Extract the helper rather than sourcing run.sh (sourcing runs main()).
HELPER="$(mktemp "${TMPDIR:-/tmp}/loki-altwarn-XXXXXX.sh")"
trap 'rm -f "$HELPER"' EXIT
{
    echo 'log_warn() { printf "WARN: %s\n" "$*"; }'
    awk '/^_loki_warn_alt_provider_model_alias\(\) \{/{p=1} p{print} p&&/^\}/{exit}' "$RUN_SH"
} > "$HELPER"

if ! grep -q '_loki_warn_alt_provider_model_alias()' "$HELPER"; then
    bad "could not extract the helper from run.sh (moved or renamed?)"
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi
ok "extracted _loki_warn_alt_provider_model_alias from run.sh"

run_case() {
    # Runs the helper in a clean env with only the vars this case sets.
    env -u ANTHROPIC_BASE_URL -u LOKI_MODEL_OVERRIDE "$@" \
        bash -c 'source "$0"; _loki_warn_alt_provider_model_alias; echo "RC=$?"' "$HELPER" 2>&1
}

# ---- POSITIVE: base URL, no override -> must warn --------------------------
out="$(run_case ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1)"
if printf '%s' "$out" | grep -q 'LOKI_MODEL_OVERRIDE is not'; then
    ok "warns when ANTHROPIC_BASE_URL is set without LOKI_MODEL_OVERRIDE"
else
    bad "expected a warning; got: $(printf '%s' "$out" | head -2)"
fi
# The warning has to be actionable, not just an alarm.
if printf '%s' "$out" | grep -q 'export LOKI_MODEL_OVERRIDE='; then
    ok "warning names the exact fix (export LOKI_MODEL_OVERRIDE=...)"
else
    bad "warning does not tell the user how to fix it"
fi
# It should also echo the endpoint so the user knows WHICH config triggered it.
if printf '%s' "$out" | grep -q 'openrouter.ai'; then
    ok "warning echoes the configured endpoint"
else
    bad "warning does not name the endpoint it saw"
fi

# ---- NON-FATAL: must return 0 so a run is never blocked --------------------
if printf '%s' "$out" | grep -q 'RC=0'; then
    ok "helper is non-fatal (returns 0) -- a mapping proxy stays supported"
else
    bad "helper returned non-zero; it must never block a run"
fi

# ---- NEGATIVE-A: both set -> silent ----------------------------------------
out="$(run_case ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1 LOKI_MODEL_OVERRIDE=some/model-id)"
if printf '%s' "$out" | grep -q 'WARN:'; then
    bad "warned even though LOKI_MODEL_OVERRIDE was set: $(printf '%s' "$out" | head -1)"
else
    ok "silent when both variables are set (correctly configured)"
fi

# ---- NEGATIVE-B: no base URL -> silent -------------------------------------
out="$(run_case)"
if printf '%s' "$out" | grep -q 'WARN:'; then
    bad "warned on a stock Anthropic run (no ANTHROPIC_BASE_URL): $(printf '%s' "$out" | head -1)"
else
    ok "silent on a stock run with no alt endpoint (no false alarm)"
fi

# ---- Wiring: the helper must actually be CALLED in the preflight -----------
# A defined-but-uncalled helper would pass every assertion above and still never
# fire for a real user.
if grep -q '^\s*_loki_warn_alt_provider_model_alias$' "$RUN_SH"; then
    ok "helper is invoked from the run preflight (not dead code)"
else
    bad "helper is defined but never called in run.sh"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
