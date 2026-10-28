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
#   model=$(loki_latest_model claude planning)   # -> claude-opus-5-5
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

# LOKI_EFFORT knob (#346 slice 2). loki_provider_effort <provider> [model] [requested]
# prints "<effort>|<flag>|<clamped_from>" and nothing when no effort is requested.
# The catalog row (models[].effort, else providers.<p>.effort) decides: levels clamp
# the request to the highest allowed level not above it (else the lowest allowed),
# and a row with no flag prints "unsupported" so no flag is ever invented.
# Optional 4th/5th args <ledger_file> <stage> make the same python process append the ledger
# line, so loki_effort_argv costs one interpreter start, not two.
# Mirror of providerEffortParam in loki-ts/src/providers/model_routes.ts.
loki_provider_effort() {
    local provider="${1:-}" model="${2:-}" req="${3:-${LOKI_EFFORT:-}}"
    [ -n "$req" ] && [ -f "$LOKI_MODEL_CATALOG" ] || return 0
    python3 - "$LOKI_MODEL_CATALOG" "$provider" "$model" "$req" "${4:-}" "${5:-}" <<'PY'
import json, os, sys
path, provider, model, req = sys.argv[1:5]
ledger, stage = sys.argv[5], sys.argv[6]
def emit(eff, flag, frm):
    print("%s|%s|%s" % (eff, flag, frm))
    if ledger:
        try:
            os.makedirs(os.path.dirname(ledger), exist_ok=True)
            with open(ledger, "a") as fh:
                fh.write(json.dumps(dict(zip(["provider","stage","model","effort","clamped_from"],
                    [provider, stage, model, eff, frm])), separators=(",", ":"), ensure_ascii=False) + "\n")
        except OSError:
            pass
order = ["low", "medium", "high", "xhigh", "max"]
if req not in order:
    sys.exit(0)
p = json.load(open(path)).get("providers", {}).get(provider, {})
m = next((x for x in p.get("models", []) if model and (x.get("id") == model or x.get("alias") == model)), {})
e = m.get("effort") or p.get("effort")
if not e:
    sys.exit(0)
flag = e.get("flag")
levels = [l for l in order if l in e.get("levels", [])]
if e.get("unsupported") or not flag or not levels:
    emit("unsupported", "", req)
    sys.exit(0)
eff = req
if eff not in levels:
    below = [l for l in levels if order.index(l) <= order.index(req)]
    eff = below[-1] if below else levels[0]
emit(eff, flag, req if eff != req else "")
PY
}

# loki_effort_record <provider> <stage> <model> <effort> <clamped_from>: one JSON line per
# stage in ${LOKI_DIR:-.loki}/state/effort.jsonl so the effective effort is auditable.
loki_effort_record() {
    local dir="${LOKI_DIR:-.loki}/state"
    mkdir -p "$dir" 2>/dev/null || return 0
    # json.dumps escapes every field (no sourceable bash escape helper exists in the providers layer);
    # compact separators and raw unicode match Bun's JSON.stringify byte for byte.
    python3 -c 'import json,sys
k=["provider","stage","model","effort","clamped_from"]
print(json.dumps(dict(zip(k,sys.argv[1:6])),separators=(",",":"),ensure_ascii=False))' \
        "$1" "$2" "$3" "$4" "$5" >> "$dir/effort.jsonl" 2>/dev/null || true
}

# loki_effort_argv <provider> <model> <stage>: fills _LOKI_EFFORT_ARGV with the provider's
# own effort flag (empty when unrequested or unsupported) and records the outcome.
loki_effort_argv() {
    _LOKI_EFFORT_ARGV=()
    local out eff flag dir="${LOKI_DIR:-.loki}/state" ledger=""
    [ -n "${LOKI_EFFORT:-}" ] && ledger="$dir/effort.jsonl"
    out="$(loki_provider_effort "$1" "$2" "${LOKI_EFFORT:-}" "$ledger" "${3:-}")" || return 0
    [ -n "$out" ] || return 0
    IFS='|' read -r eff flag _ <<<"$out"
    if [ "$eff" != "unsupported" ] && [ -n "$flag" ]; then _LOKI_EFFORT_ARGV=("$flag" "$eff"); fi
    return 0
}
