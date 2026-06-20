#!/usr/bin/env bash
# Test: providers/codex.sh treats LOKI_CODEX_MODEL as trusted (used verbatim),
# while the generic LOKI_MODEL_* fallback is still validated against
# CODEX_KNOWN_MODELS.
#
# Regression (BUG-PROV-003): codex.sh wrapped the WHOLE model chain in
# _codex_validate_model, so a provider-specific LOKI_CODEX_MODEL that did not
# match a known prefix (e.g. an org-scoped fine-tune "custom-org/my-model") was
# silently downgraded to the default gpt-5.3-codex, despite the comment claiming
# the var is trusted. The fix validates only the generic fallback arm.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX="$REPO_ROOT/providers/codex.sh"

PASS=0
FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS + 1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# resolve <env-assignments...> -- source codex.sh in a clean subshell with the
# given env and echo the three resolved model values, space-separated.
resolve() {
    env -i HOME="$HOME" PATH="$PATH" "$@" bash -c \
        'source "'"$CODEX"'" >/dev/null 2>&1
         printf "%s|%s|%s" "$PROVIDER_MODEL_PLANNING" \
            "$PROVIDER_MODEL_DEVELOPMENT" "$PROVIDER_MODEL_FAST"'
}

# Case 1: trusted org-scoped model used verbatim across all tiers (the bug).
out="$(resolve LOKI_CODEX_MODEL=custom-org/my-tuned-model)"
if [ "$out" = "custom-org/my-tuned-model|custom-org/my-tuned-model|custom-org/my-tuned-model" ]; then
    ok "LOKI_CODEX_MODEL (org-scoped) used verbatim across tiers"
else
    bad "LOKI_CODEX_MODEL downgraded: got '$out'"
fi

# Case 2: generic LOKI_MODEL_* with a Claude alias is still validated -> default.
out="$(resolve LOKI_MODEL_DEVELOPMENT=opus)"
dev="${out#*|}"; dev="${dev%%|*}"
if [ "$dev" = "gpt-5.3-codex" ]; then
    ok "generic LOKI_MODEL_DEVELOPMENT=opus validated -> default"
else
    bad "generic claude alias not validated: got '$dev'"
fi

# Case 3: generic LOKI_MODEL_* with a valid gpt- prefix is kept.
out="$(resolve LOKI_MODEL_DEVELOPMENT=gpt-5.3-custom)"
dev="${out#*|}"; dev="${dev%%|*}"
if [ "$dev" = "gpt-5.3-custom" ]; then
    ok "generic LOKI_MODEL_DEVELOPMENT=gpt-5.3-custom kept"
else
    bad "valid generic gpt model dropped: got '$dev'"
fi

# Case 4: no env -> default.
out="$(resolve)"
if [ "$out" = "gpt-5.3-codex|gpt-5.3-codex|gpt-5.3-codex" ]; then
    ok "no env -> default model across tiers"
else
    bad "default resolution changed: got '$out'"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
