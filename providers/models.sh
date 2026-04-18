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
#   model=$(loki_latest_model claude planning)   # -> claude-opus-4-7
#   model=$(loki_latest_model gemini fast)       # -> gemini-3-flash-preview
#
# Env override order: LOKI_<PROVIDER>_MODEL_<TIER> > LOKI_<PROVIDER>_MODEL > catalog latest.

# Resolve catalog path relative to this script, regardless of CWD.
_LOKI_MODELS_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LOKI_MODEL_CATALOG="${LOKI_MODEL_CATALOG:-$_LOKI_MODELS_SH_DIR/model_catalog.json}"

# Return the "latest_<tier>" id for a provider from the catalog.
# Args: $1 provider (claude|codex|gemini|cline|aider)
#       $2 tier     (planning|development|fast)
loki_latest_model() {
    local provider="${1:-claude}"
    local tier="${2:-planning}"
    local tier_upper
    tier_upper=$(printf '%s' "$tier" | tr '[:lower:]' '[:upper:]')
    local provider_upper
    provider_upper=$(printf '%s' "$provider" | tr '[:lower:]' '[:upper:]')

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
p = data.get("providers", {}).get(provider)
if not p:
    sys.exit(1)
model = p.get(f"latest_{tier}")
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
