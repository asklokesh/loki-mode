#!/usr/bin/env bash
# A user must never have to type a model name.
#
# The contract: pick a provider, and the capability tier decides the model.
# medium is the default. On codex that means:
#
#   small  -> gpt-5.6-luna   (budget, high volume)
#   medium -> gpt-5.6-terra  (default; performance/affordability balance)
#   high   -> gpt-5.6-sol    (frontier, complex professional work)
#
# Model IDs verified against developers.openai.com/api/docs/models.
#
# Before this, every codex tier fell back to CODEX_DEFAULT_MODEL, which is the
# empty string. So all three tiers resolved to nothing, no --model was sent, and
# LOKI_SESSION_MODEL=high selected nothing at all -- the tier vocabulary existed
# but did nothing on codex, forcing users to name a model by hand.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: codex capability tiers resolve to distinct real models"

# --- the tier table -----------------------------------------------------------
for pair in "small:gpt-5.6-luna" "medium:gpt-5.6-terra" "high:gpt-5.6-sol"; do
    tier="${pair%%:*}"
    want="${pair##*:}"
    got="$(bash -c "source providers/models.sh 2>/dev/null; \
                    loki_latest_model codex \"\$(loki_tier_alias $tier)\"" 2>/dev/null)"
    if [[ "$got" == "$want" ]]; then
        ok "$tier -> $want"
    else
        ko "$tier -> $want" "got: '${got:-<empty>}'"
    fi
done

# --- the three must be DISTINCT ----------------------------------------------
# The prior catalog pointed all three tiers at one model, which made the
# vocabulary decorative: asking for high cost the same and did the same as
# asking for small.
distinct="$(bash -c 'source providers/models.sh 2>/dev/null
    for t in small medium high; do loki_latest_model codex "$(loki_tier_alias $t)"; done' \
    2>/dev/null | sort -u | grep -c .)"
if [[ "$distinct" -eq 3 ]]; then
    ok "the three tiers resolve to three different models"
else
    ko "the three tiers resolve to three different models" \
       "only $distinct distinct value(s) -- the tier vocabulary is decorative"
fi

# --- provider defaults --------------------------------------------------------
# Sourcing the provider with nothing set must populate all three tiers.
eval "$(bash -c 'source providers/models.sh 2>/dev/null
                 source providers/codex.sh 2>/dev/null
                 printf "P=%s\nD=%s\nF=%s\n" "$PROVIDER_MODEL_PLANNING" \
                        "$PROVIDER_MODEL_DEVELOPMENT" "$PROVIDER_MODEL_FAST"' 2>/dev/null)"
if [[ -n "${P:-}" && -n "${D:-}" && -n "${F:-}" ]]; then
    ok "sourcing codex.sh populates every tier (was empty for all three)"
else
    ko "sourcing codex.sh populates every tier" \
       "planning='${P:-}' development='${D:-}' fast='${F:-}'"
fi

# --- explicit override still wins --------------------------------------------
# LOKI_CODEX_MODEL is trusted verbatim (BUG-PROV-003): an operator naming a
# fine-tune or org-scoped model must not be silently downgraded to a tier
# default.
override="$(bash -c 'source providers/models.sh 2>/dev/null
    LOKI_CODEX_MODEL=ft:gpt-my-custom source providers/codex.sh 2>/dev/null
    printf "%s" "$PROVIDER_MODEL_PLANNING"' 2>/dev/null)"
if [[ "$override" == "ft:gpt-my-custom" ]]; then
    ok "LOKI_CODEX_MODEL still overrides the tier default verbatim"
else
    ko "LOKI_CODEX_MODEL still overrides the tier default verbatim" \
       "got: '${override:-<empty>}'"
fi

# --- a Claude alias must not leak through ------------------------------------
# The generic LOKI_MODEL_* chain is validated because it can carry Claude
# aliases, which are invalid on codex.
leak="$(bash -c 'source providers/models.sh 2>/dev/null
    LOKI_MODEL_PLANNING=sonnet source providers/codex.sh 2>/dev/null
    printf "%s" "$PROVIDER_MODEL_PLANNING"' 2>/dev/null)"
if [[ "$leak" != *sonnet* && "$leak" != *opus* && "$leak" != *haiku* ]]; then
    ok "a Claude alias in the generic chain does not reach codex"
else
    ko "a Claude alias in the generic chain does not reach codex" "got: '$leak'"
fi

# --- catalog self-consistency -------------------------------------------------
# latest_<tier> mirrors are DERIVED; they must agree with models[].
mirror_ok="$(python3 -c "
import json
c = json.load(open('providers/model_catalog.json'))['providers']['codex']
first = {}
for m in c['models']:
    first.setdefault(m['tier'], m['id'])
bad = [t for t in ('planning','development','fast')
       if c.get('latest_'+t) != first.get(t)]
print('ok' if not bad else 'drift:' + ','.join(bad))" 2>/dev/null)"
if [[ "$mirror_ok" == "ok" ]]; then
    ok "catalog latest_<tier> mirrors agree with models[]"
else
    ko "catalog latest_<tier> mirrors agree with models[]" "$mirror_ok"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
