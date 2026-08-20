#!/usr/bin/env bash
# Dynamic model-catalog loader for Loki Mode providers.
#
# Instead of hardcoding dated model IDs (e.g. claude-sonnet-4-5-20250929)
# throughout the codebase, every provider and caller reads from the single
# source of truth at providers/model_catalog.json. When a new model ships,
# update that one JSON file and every provider picks it up.
#
# Usage:
#   source providers/models.sh
#   model=$(loki_latest_model claude planning)   # -> claude-opus-4-8
#
# Env override order: LOKI_<PROVIDER>_MODEL_<TIER> > LOKI_<PROVIDER>_MODEL > catalog latest.

# Resolve catalog path relative to this script, regardless of CWD.
_LOKI_MODELS_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOKI_MODEL_CATALOG="${LOKI_MODEL_CATALOG:-$_LOKI_MODELS_SH_DIR/model_catalog.json}"

# GENERIC CAPABILITY TIERS. Callers should ask for small|medium|high and never
# name a vendor model. medium is the DEFAULT.
#
#   small  -> the cheap/fast model   (claude: haiku, codex: luna)
#   medium -> the workhorse          (claude: sonnet, codex: terra)  [default]
#   high   -> the expensive/best     (claude: opus,   codex: sol)
#
# WHY AN ALIAS LAYER RATHER THAN A RENAME: the catalog already keys models by
# planning/development/fast and several call sites depend on those names. This
# maps onto them instead of duplicating the mapping, so there is exactly one
# place a model id is written down. Hardcoding "medium = claude-sonnet-5"
# anywhere would recreate the drift class this repo keeps paying for -- a doc
# that named a default matching neither the code nor the catalog, and a test
# that demanded open-weights providers resolve to a Claude model.
loki_tier_alias() {
    case "${1:-medium}" in
        small|fast)              printf 'fast' ;;
        high|planning|best)      printf 'planning' ;;
        medium|development|'')   printf 'development' ;;
        # Unknown value falls back to the DEFAULT rather than failing the run:
        # a typo in a pipeline config should not change which model you pay for
        # silently, and it should not halt a build either. The caller can see
        # what resolved via loki_latest_model.
        *)                       printf 'development' ;;
    esac
}

# Return the "latest_<tier>" id for a provider from the catalog.
# Args: $1 provider (claude|codex|cline|aider|opencode)
#       $2 tier     (planning|development|fast, or small|medium|high)
loki_latest_model() {
    local provider="${1:-claude}"
    local tier
    tier="$(loki_tier_alias "${2:-planning}")"
    local tier_upper
    tier_upper=$(printf '%s' "$tier" | tr '[:lower:]' '[:upper:]')
    local provider_upper
    # Uppercase AND normalize to a legal shell identifier. A provider named with
    # a hyphen (e.g. "some-new-vendor") would otherwise build
    # LOKI_SOME-NEW-VENDOR_MODEL_DEVELOPMENT, which is not a valid variable name;
    # the indirect expansion below then fails and takes the whole lookup with it,
    # so the provider silently resolves to nothing. Found when adding the generic
    # registry fallback: "notaprovider" worked and "some-new-vendor" did not.
    provider_upper=$(printf '%s' "$provider" \
        | tr '[:lower:]' '[:upper:]' \
        | tr -c 'A-Z0-9_' '_' )

    # Env override chain
    local override="LOKI_${provider_upper}_MODEL_${tier_upper}"
    if [ -n "${!override:-}" ]; then
        printf '%s' "${!override}"
        return 0
    fi
    local generic_override="LOKI_${provider_upper}_MODEL"
    if [ -n "${!generic_override:-}" ]; then
        printf '%s' "${!generic_override}"
        return 0
    fi

    if [ ! -f "$LOKI_MODEL_CATALOG" ]; then
        return 1
    fi
    # Require python3 (all Loki runtimes ship with it).
    python3 - "$LOKI_MODEL_CATALOG" "$provider" "$tier" <<'PY'
import json, sys
catalog_path, provider, tier = sys.argv[1], sys.argv[2], sys.argv[3]
with open(catalog_path) as fh:
    data = json.load(fh)
providers = data.get("providers", {})
p = providers.get(provider)
if not p:
    # REGISTRY FALLBACK (v8.2.0). A fixed table of provider keys means every
    # unknown provider is a fallthrough that resolves to NOTHING -- verified
    # before this change: `loki_latest_model notaprovider development` returned
    # empty with rc=1. That makes "bring your own endpoint" a dead end, which is
    # the opposite of model-agnostic.
    #
    # A "generic" key turns the unknown case into a first-class one. It is the
    # same shape codex already uses (all three tiers collapsed onto one model),
    # so this generalizes an accepted pattern rather than inventing a mechanism.
    #
    # The env-override chain above still wins, so an operator naming a specific
    # model per tier is never overridden by this default.
    p = providers.get("generic")
    if not p:
        sys.exit(1)

# SINGLE SOURCE OF TRUTH: models[] is authoritative, top-level latest_<tier> is
# derived. Before this, both existed independently and drifted -- claude
# latest_fast said claude-sonnet-5 while models[tier=fast] said claude-haiku-4-5,
# so asking for the cheap tier silently billed the mid tier. models[] wins
# because it is the richer structure (context_window, max_output, open_weights,
# alias, notes per model); the top-level keys carry nothing it does not.
#
# ORDER IS LOAD-BEARING: a provider may declare several models at one tier
# (codex lists gpt-5.3-codex and o3 both as planning). First match wins, so the
# FIRST entry at a tier is the default. Reordering models[] changes what real
# builds dispatch. tests/test-model-catalog-single-source.sh pins this.
models = [m for m in p.get("models", []) if isinstance(m, dict)]
model = next((m.get("id") for m in models if m.get("tier") == tier), None)

if not model:
    # No entry at this tier. Falling back must be DECLARED, never accidental:
    # codex genuinely runs one model for every tier and varies reasoning effort
    # instead, so an absent tier is legitimate for it -- but silently walking to
    # some other tier is how you end up dispatching a model nobody chose. The
    # provider states the substitution in the catalog as tier_fallback, and we
    # honor only that.
    fallback_tier = (p.get("tier_fallback") or {}).get(tier)
    if fallback_tier:
        model = next(
            (m.get("id") for m in models if m.get("tier") == fallback_tier), None
        )

if not model:
    sys.exit(1)
print(model)
PY
}

# Print full catalog for a provider as lines: <id>\t<tier>\t<alias?>
# Useful for `loki provider models <name>` output.
loki_list_models() {
    local provider="${1:-claude}"
    if [ ! -f "$LOKI_MODEL_CATALOG" ]; then
        return 1
    fi
    python3 - "$LOKI_MODEL_CATALOG" "$provider" <<'PY'
import json, sys
catalog_path, provider = sys.argv[1], sys.argv[2]
with open(catalog_path) as fh:
    data = json.load(fh)
p = data.get("providers", {}).get(provider, {})
for m in p.get("models", []):
    alias = m.get("alias", "")
    print(f"{m.get('id','')}\t{m.get('tier','')}\t{alias}")
PY
}
