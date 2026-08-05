#!/usr/bin/env bash
# Test: the opencode provider -- our model-agnostic route.
#
# WHY THIS PROVIDER MATTERS
#   Our catalog is a fixed table of providers. opencode is a REGISTRY: 75+
#   providers via AI SDK + Models.dev, any OpenAI-compatible endpoint, plus
#   local models (Ollama, LM Studio, llama.cpp). Driving it gives users every
#   cheap open model without us maintaining a per-vendor model list.
#
#   It replaces aider as the strategic cheap-model route. Verified 2026-07-29:
#   anomalyco/opencode had 190,871 stars with release v1.18.9 on 2026-07-28,
#   while Aider-AI/aider's last release was v0.86.0 on 2025-08-09 (~1 year
#   stale), Roo Code is archived and Continue is read-only. Capability is not
#   enough -- the integration target has to still be maintained.
#
# THE LOADER BUG THIS SURFACED
#   loader.sh required PROVIDER_AUTONOMOUS_FLAG to be NON-EMPTY. `opencode run
#   <prompt>` is already non-interactive and needs no such flag, so a valid
#   provider was rejected as "incomplete". The variable must still be DEFINED
#   (an author who forgets it is still caught) but an intentional empty value is
#   now legal -- the same treatment PROVIDER_PROMPT_FLAG already had.
#
# Proven directions:
#   REGISTERED : opencode is in SUPPORTED_PROVIDERS and validates.
#   LOADS      : load_provider succeeds and populates identity vars.
#   EMPTY_FLAG : a provider with an empty autonomous flag is accepted...
#   UNDEFINED  : ...but one that never defines it is still REJECTED.
#   NO_REGRESS : claude and aider still load (the validator was loosened, not broken).
#   TIERS      : all three tiers resolve, and to NON-Claude models.
#   POSITIONAL : the prompt is positional (opencode run has no -p flag).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS="$SCRIPT_DIR/../providers"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-opencode-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== opencode provider (model-agnostic route) ==="

# Everything runs under `bash -c`: providers/*.sh use bash indirect expansion
# (${!var}), which dies under zsh with "bad substitution" and would make every
# check fail identically -- reading as a provider bug when it is a shell mismatch.
runb() { bash -c "$1" 2>&1; }

# ---- REGISTERED ----------------------------------------------------------
if runb ". $PROVIDERS/loader.sh; validate_provider opencode" >/dev/null 2>&1; then
    ok "opencode validates as a supported provider"
else
    bad "validate_provider rejected opencode"
fi
if runb ". $PROVIDERS/loader.sh; printf '%s\n' \"\${SUPPORTED_PROVIDERS[@]}\"" | grep -qx "opencode"; then
    ok "opencode is listed in SUPPORTED_PROVIDERS"
else
    bad "opencode missing from SUPPORTED_PROVIDERS"
fi

# ---- LOADS ---------------------------------------------------------------
out="$(runb ". $PROVIDERS/loader.sh; load_provider opencode >/dev/null 2>&1 && printf '%s|%s' \"\$PROVIDER_NAME\" \"\$PROVIDER_CLI\"")"
if [ "$out" = "opencode|opencode" ]; then
    ok "load_provider opencode populates identity vars"
else
    bad "load_provider opencode produced '$out'"
fi

# ---- NO_REGRESS ----------------------------------------------------------
for p in claude aider codex cline; do
    if runb ". $PROVIDERS/loader.sh; load_provider $p" >/dev/null 2>&1; then
        ok "$p still loads (validator loosened, not broken)"
    else
        bad "$p no longer loads -- the validator change regressed it"
    fi
done

# ---- EMPTY_FLAG vs UNDEFINED --------------------------------------------
# A provider may legitimately need NO autonomy flag. One that never defines the
# variable at all is still an authoring error and must be caught.
cat > "$TMP/empty.sh" <<'EOF'
PROVIDER_NAME="tmpempty"; PROVIDER_DISPLAY_NAME="t"; PROVIDER_CLI="true"
PROVIDER_AUTONOMOUS_FLAG=""; PROVIDER_PROMPT_FLAG=""; PROVIDER_PROMPT_POSITIONAL=true
PROVIDER_HAS_SUBAGENTS=false; PROVIDER_HAS_PARALLEL=false; PROVIDER_DEGRADED=false
EOF
cat > "$TMP/undef.sh" <<'EOF'
PROVIDER_NAME="tmpundef"; PROVIDER_DISPLAY_NAME="t"; PROVIDER_CLI="true"
PROVIDER_PROMPT_FLAG=""; PROVIDER_PROMPT_POSITIONAL=true
PROVIDER_HAS_SUBAGENTS=false; PROVIDER_HAS_PARALLEL=false; PROVIDER_DEGRADED=false
EOF
if runb ". $PROVIDERS/loader.sh; . $TMP/empty.sh; validate_provider_config" >/dev/null 2>&1; then
    ok "an intentionally EMPTY autonomous flag is accepted"
else
    bad "empty autonomous flag still rejected -- opencode cannot load"
fi
if runb ". $PROVIDERS/loader.sh; unset PROVIDER_AUTONOMOUS_FLAG; . $TMP/undef.sh; validate_provider_config" >/dev/null 2>&1; then
    bad "an UNDEFINED autonomous flag was accepted -- the guard is now too loose"
else
    ok "an UNDEFINED autonomous flag is still rejected (guard intact)"
fi

# ---- TIERS ---------------------------------------------------------------
for tier in planning development fast; do
    m="$(runb ". $PROVIDERS/models.sh; loki_latest_model opencode $tier")"
    case "$(printf '%s' "$m" | tr '[:upper:]' '[:lower:]')" in
        "")       bad "opencode $tier resolved to nothing" ;;
        *claude*) bad "opencode $tier resolved to a Claude model ($m)" ;;
        *)        ok  "opencode $tier -> $m" ;;
    esac
done

# ---- POSITIONAL ----------------------------------------------------------
# `opencode run` takes the prompt positionally; asserting this stops someone
# from "fixing" it later by adding a -p flag that the CLI does not accept.
if grep -q 'PROVIDER_PROMPT_POSITIONAL=true' "$PROVIDERS/opencode.sh"; then
    ok "prompt is positional (matches 'opencode run <message>')"
else
    bad "opencode provider does not declare a positional prompt"
fi
if grep -qE 'opencode run .*--model' "$PROVIDERS/opencode.sh"; then
    ok "invocation uses 'opencode run --model' (verified CLI surface)"
else
    bad "invocation does not match the real opencode CLI"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
