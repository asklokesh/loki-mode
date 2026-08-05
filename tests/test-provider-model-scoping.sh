#!/usr/bin/env bash
# Test: a GLOBAL tier variable (LOKI_MODEL_DEVELOPMENT) must not silently pick a
# provider-specific model.
#
# Regression: aider.sh / cline.sh / opencode.sh each resolved their model as
#   "${LOKI_<P>_MODEL:-${LOKI_MODEL_DEVELOPMENT:-<catalog>}}"
# with the GLOBAL tier var AHEAD of the catalog. autonomy/run.sh maps the
# `model.development` config key to LOKI_MODEL_DEVELOPMENT for every provider,
# so an operator setting a development-tier model for one provider silently
# changed aider/cline/opencode too. Worse, those three take full routed model
# strings (litellm / "provider/model") while the global tier var carries Claude
# CLI aliases, so the leak produced `aider --model sonnet` -- namespace-
# incompatible, not merely mis-ordered. This is the class that once made an
# equivalence experiment unfalsifiable by recording the wrong model per run.
#
# The middle case of each provider block is the load-bearing one: global set,
# resolved value is STILL the catalog value.
#
# claude and codex rows are non-regression locks, not the bug:
#   - claude.sh intentionally honors the generic LOKI_MODEL_* tier vars (same
#     alias namespace, and claude.sh reads them for its max-tier pin logic).
#   - codex.sh already validates the generic arm against CODEX_KNOWN_MODELS, so
#     a Claude alias falls back to "pass no --model" rather than leaking.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS + 1)); }
bad(){ echo "FAIL: $1 (got: '$2', want: '$3')"; FAIL=$((FAIL + 1)); }

# resolve <provider> <var-to-print> [env-assignments...]
# Source the provider in a pristine subshell (env -i, so no case leaks into the
# next) and echo the resolved model variable.
resolve() {
    local provider="$1" var="$2"
    shift 2
    env -i HOME="$HOME" PATH="$PATH" "$@" bash -c \
        'source "'"$REPO_ROOT"'/providers/'"$provider"'.sh" >/dev/null 2>&1
         printf "%s" "${'"$var"':-}"'
}

# check <label> <want> <got>
check() {
    if [ "$3" = "$2" ]; then ok "$1"; else bad "$1" "$3" "$2"; fi
}

# Catalog is the source of truth for the "nothing set" expectation, so this test
# does not drift when a model is bumped in model_catalog.json.
catalog() {
    python3 -c '
import json,sys
c=json.load(open(sys.argv[1]))
print(c["providers"][sys.argv[2]]["latest_development"])' \
        "$REPO_ROOT/providers/model_catalog.json" "$1"
}

# --- The three fixed providers -------------------------------------------
# scoped var name, provider file, exported model var
for row in "aider:LOKI_AIDER_MODEL:AIDER_DEFAULT_MODEL" \
           "cline:LOKI_CLINE_MODEL:CLINE_DEFAULT_MODEL" \
           "opencode:LOKI_OPENCODE_MODEL:OPENCODE_DEFAULT_MODEL"; do
    p="${row%%:*}"
    rest="${row#*:}"
    scoped="${rest%%:*}"
    var="${rest#*:}"
    want_default="$(catalog "$p")"

    check "$p: nothing set -> catalog default" \
        "$want_default" "$(resolve "$p" "$var")"

    # The regression. Fails before the fix (resolves to "sonnet").
    check "$p: global LOKI_MODEL_DEVELOPMENT set -> STILL catalog default" \
        "$want_default" "$(resolve "$p" "$var" LOKI_MODEL_DEVELOPMENT=sonnet)"

    check "$p: provider-scoped $scoped wins" \
        "my/custom-model" "$(resolve "$p" "$var" "$scoped=my/custom-model")"

    check "$p: provider-scoped beats global" \
        "my/custom-model" \
        "$(resolve "$p" "$var" "$scoped=my/custom-model" LOKI_MODEL_DEVELOPMENT=sonnet)"
done

# --- catalog-miss fallback must stay provider-appropriate -----------------
# Same class as the main bug: aider/cline hardcoded "claude-opus-4-8" as their
# catalog-miss fallback, which is not a valid litellm/routed model string. Point
# LOKI_MODEL_CATALOG at a nonexistent file to force the fallback arm.
for p in aider cline opencode; do
    case "$p" in
        aider)    var=AIDER_DEFAULT_MODEL ;;
        cline)    var=CLINE_DEFAULT_MODEL ;;
        opencode) var=OPENCODE_DEFAULT_MODEL ;;
    esac
    got="$(resolve "$p" "$var" LOKI_MODEL_CATALOG=/nonexistent/catalog.json)"
    case "$got" in
        claude-*) bad "$p: catalog-miss fallback is provider-appropriate" \
                      "$got" "a non-Claude routed model string" ;;
        "")       bad "$p: catalog-miss fallback is non-empty" "$got" "a model string" ;;
        *)        ok "$p: catalog-miss fallback is provider-appropriate ($got)" ;;
    esac
done

# --- claude: global tier var is INTENTIONAL here (non-regression lock) ----
check "claude: nothing set -> sonnet default" \
    "sonnet" "$(resolve claude PROVIDER_MODEL_PLANNING)"
check "claude: global LOKI_MODEL_PLANNING still honored (by design)" \
    "opus" "$(resolve claude PROVIDER_MODEL_PLANNING LOKI_MODEL_PLANNING=opus)"
check "claude: provider-scoped beats global" \
    "haiku" "$(resolve claude PROVIDER_MODEL_PLANNING \
        LOKI_CLAUDE_MODEL_PLANNING=haiku LOKI_MODEL_PLANNING=opus)"

# --- codex: global tier var is validated, not leaked (non-regression lock) -
check "codex: nothing set -> empty (let Codex pick)" \
    "" "$(resolve codex PROVIDER_MODEL_DEVELOPMENT)"
check "codex: global LOKI_MODEL_DEVELOPMENT=sonnet rejected -> empty" \
    "" "$(resolve codex PROVIDER_MODEL_DEVELOPMENT LOKI_MODEL_DEVELOPMENT=sonnet)"
check "codex: provider-scoped LOKI_CODEX_MODEL trusted verbatim" \
    "custom-org/my-model" \
    "$(resolve codex PROVIDER_MODEL_DEVELOPMENT LOKI_CODEX_MODEL=custom-org/my-model)"

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
