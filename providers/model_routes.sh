#!/usr/bin/env bash
# Model routes: run non-Anthropic models through the Tier-1 Claude harness.
#
# Claude Code honors ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_MODEL,
# so any Anthropic-compatible endpoint keeps every Loki control (cost, kill
# blocking, receipts). Mirror of loki-ts/src/providers/model_routes.ts.
#
# Spec forms (env LOKI_MODEL_ROUTE, or LOKI_MODEL_OVERRIDE when it is a route):
#   openrouter/<id>   https://openrouter.ai/api   token: OPENROUTER_API_KEY
#   ollama/<id>       http://localhost:11434
#   lmstudio/<id>     http://localhost:1234
#   llamacpp/<id>     http://localhost:8080
#   vllm/<id>         http://localhost:8000
#   custom/<id>       LOKI_MODEL_BASE_URL (+ optional LOKI_MODEL_API_KEY)
# Plain Claude ids (opus, sonnet, claude-*) are not routes: behavior unchanged.
#
# The env is applied only inside providers/model_route_exec.sh, which execs the
# claude child. It is never exported into the parent shell, and the token is
# never placed on a command line or logged.

# kind -> "base_url|token_var"
loki_model_route_table() {
    case "$1" in
        openrouter) echo "https://openrouter.ai/api|OPENROUTER_API_KEY" ;;
        ollama)     echo "http://localhost:11434|" ;;
        lmstudio)   echo "http://localhost:1234|" ;;
        llamacpp)   echo "http://localhost:8080|" ;;
        vllm)       echo "http://localhost:8000|" ;;
        custom)     echo "${LOKI_MODEL_BASE_URL:-}|LOKI_MODEL_API_KEY" ;;
        *) return 1 ;;
    esac
}

# Echo the active route spec, or nothing when none is configured.
loki_model_route_spec() {
    local s="${LOKI_MODEL_ROUTE:-}"
    if [ -z "$s" ]; then
        s="${LOKI_MODEL_OVERRIDE:-}"
        case "$s" in
            */*) loki_model_route_table "${s%%/*}" >/dev/null 2>&1 || s="" ;;
            *) s="" ;;
        esac
    fi
    [ -n "$s" ] && printf '%s\n' "$s"
    return 0
}

# Parse a spec. Sets LOKI_ROUTE_KIND, LOKI_ROUTE_MODEL, LOKI_ROUTE_BASE, LOKI_ROUTE_TOKEN_VAR.
# Returns 1 when the spec is not a usable route.
loki_model_route_parse() {
    local spec="${1:-}" kind model entry
    case "$spec" in */*) ;; *) return 1 ;; esac
    kind="${spec%%/*}"
    model="${spec#*/}"
    [ -n "$model" ] || return 1
    entry="$(loki_model_route_table "$kind")" || return 1
    LOKI_ROUTE_KIND="$kind"
    LOKI_ROUTE_MODEL="$model"
    LOKI_ROUTE_BASE="${entry%%|*}"
    LOKI_ROUTE_TOKEN_VAR="${entry#*|}"
    [ -n "$LOKI_ROUTE_BASE" ] || return 1
    return 0
}

# Echo the model id served by the active route (empty when none).
loki_model_route_model() {
    local spec
    spec="$(loki_model_route_spec)"
    [ -n "$spec" ] || return 0
    loki_model_route_parse "$spec" && printf '%s\n' "$LOKI_ROUTE_MODEL"
    return 0
}

# Gateway lane label (D99 item 1). Mirror of gatewayLaneLabel in model_routes.ts.
LOKI_GATEWAY_LANE_LABEL="gateway lane (unqualified)"
LOKI_GATEWAY_LANE_LOSS="prompt caching, extended thinking, server tools and hooks are not guaranteed on this lane"

# Echo the label when a non-Anthropic model runs behind the claude CLI (an active
# route, or ANTHROPIC_BASE_URL plus a non-Claude LOKI_MODEL_OVERRIDE). Claude
# routes print nothing.
loki_model_route_lane_label() {
    local spec m
    spec="$(loki_model_route_spec)"
    if [ -n "$spec" ] && loki_model_route_parse "$spec"; then
        printf '%s\n' "$LOKI_GATEWAY_LANE_LABEL"
        return 0
    fi
    [ -n "${ANTHROPIC_BASE_URL:-}" ] || return 0
    m="$(printf '%s' "${LOKI_MODEL_OVERRIDE:-}" | tr '[:upper:]' '[:lower:]')"
    case "$m" in
        ""|opus|sonnet|haiku|claude-*|*anthropic/claude*) ;;
        *) printf '%s\n' "$LOKI_GATEWAY_LANE_LABEL" ;;
    esac
    return 0
}

# Label plus the feature-loss line, for any bash surface that reports the lane.
loki_model_route_lane_report() {
    local label
    label="$(loki_model_route_lane_label)"
    [ -n "$label" ] || return 0
    printf '%s\n%s\n' "$label" "$LOKI_GATEWAY_LANE_LOSS"
}

# Populate _LOKI_ROUTE_EXEC with a command prefix for the claude child. Empty
# array when no route is active, so callers expand it with ${arr[@]+...}.
loki_model_route_prefix() {
    _LOKI_ROUTE_EXEC=()
    local spec dir
    spec="$(loki_model_route_spec)"
    [ -n "$spec" ] || return 0
    loki_model_route_parse "$spec" || return 0
    dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
    _LOKI_ROUTE_EXEC=(bash "$dir/model_route_exec.sh")
}

# Local runtime probe: print "<runtime>\t<model id>" per discovered model.
# 1s timeouts. Uses python3 only to parse JSON.
loki_models_probe_local() {
    local rt url path body
    for rt in "ollama|http://localhost:11434|/api/tags" \
              "lmstudio|http://localhost:1234|/v1/models" \
              "llamacpp|http://localhost:8080|/v1/models" \
              "vllm|http://localhost:8000|/v1/models"; do
        IFS='|' read -r name url path <<EOF
$rt
EOF
        body="$(curl -s --connect-timeout 1 --max-time 1 "${url}${path}" 2>/dev/null)" || continue
        [ -n "$body" ] || continue
        printf '%s' "$body" | python3 -c '
import json, sys
name = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
items = d.get("models") if isinstance(d, dict) and "models" in d else d.get("data", []) if isinstance(d, dict) else []
for m in items or []:
    mid = (m.get("name") or m.get("model") or m.get("id")) if isinstance(m, dict) else None
    if mid:
        print(name + "\t" + mid)
' "$name"
    done
}

# loki models [--routes] [--local] [--json]
loki_models_cmd() {
    local want_local=0 json=0 arg
    for arg in "$@"; do
        case "$arg" in
            --local) want_local=1 ;;
            --json) json=1 ;;
            --routes) ;;
            -h|--help)
                echo "Usage: loki models [--local] [--json]"
                echo ""
                echo "  (default)  List model routes usable as --model / LOKI_MODEL_ROUTE values"
                echo "  --local    Probe local runtimes (ollama, lmstudio, llamacpp, vllm) for models"
                echo "  --json     Machine-readable output"
                echo ""
                echo "Route env: LOKI_MODEL_ROUTE=openrouter/<id> | ollama/<id> | lmstudio/<id> |"
                echo "           llamacpp/<id> | vllm/<id> | custom/<id> (needs LOKI_MODEL_BASE_URL)"
                return 0
                ;;
            *) echo "loki models: unknown option: $arg" >&2; return 2 ;;
        esac
    done

    local kinds="openrouter ollama lmstudio llamacpp vllm custom" k entry base tvar
    if [ "$want_local" = "1" ]; then
        local found
        found="$(loki_models_probe_local)"
        if [ "$json" = "1" ]; then
            printf '%s' "$found" | python3 -c '
import json, sys
out = []
for line in sys.stdin.read().splitlines():
    rt, _, mid = line.partition("\t")
    out.append({"runtime": rt, "id": mid, "model": rt + "/" + mid})
print(json.dumps({"local": out}, indent=2))
'
        elif [ -z "$found" ]; then
            echo "No local runtimes responded (probed :11434 ollama, :1234 lmstudio, :8080 llamacpp, :8000 vllm)."
        else
            echo "Discovered local models (paste as LOKI_MODEL_ROUTE=<value>):"
            printf '%s\n' "$found" | while IFS="$(printf '\t')" read -r rt mid; do
                echo "  $rt/$mid"
            done
        fi
        return 0
    fi

    if [ "$json" = "1" ]; then
        local sep="" first=1
        printf '{"routes": ['
        for k in $kinds; do
            entry="$(loki_model_route_table "$k")"; base="${entry%%|*}"; tvar="${entry#*|}"
            [ "$first" = "1" ] || printf ','
            first=0
            printf '{"kind":"%s","base_url":"%s","token_env":"%s","example":"%s/<model-id>"}' "$k" "$base" "$tvar" "$k"
        done
        printf ']}\n'
        return 0
    fi
    echo "Model routes (run any Anthropic-compatible endpoint through the Claude harness):"
    for k in $kinds; do
        entry="$(loki_model_route_table "$k")"; base="${entry%%|*}"; tvar="${entry#*|}"
        [ "$k" = "custom" ] && base="\$LOKI_MODEL_BASE_URL"
        printf '  %-11s %-28s %s\n' "$k/<id>" "$base" "${tvar:+token: \$$tvar}"
    done
    echo ""
    echo "Use: LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start ./prd.md"
    echo "Discover local models: loki models --local"
}

# Allow direct execution: bash providers/model_routes.sh [args]
if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
    loki_models_cmd "$@"
fi
