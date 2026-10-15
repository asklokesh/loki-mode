#!/usr/bin/env bash
# One predictable execution path (OC-ROUTE).
# Sourced by bin/loki. Normalizes argv BEFORE the engine decision so argument
# order and input form never change the engine:
#   engine10 is the default for a PRD file, an issue ref, a multi-word task and a
#   one-word brief, whether the flags come first or last.
#   The legacy engine runs only on --engine legacy / LOKI_ENGINE=legacy, or, for
#   one specific flag engine10 cannot honor, for that call only (with a notice).
# Pure functions: no exec, no side effects except R_* globals and the printers.
# Bash 3.2 compatible (no associative arrays, no ${var,,}).

# Flags that take a separate value token.
_ROUTE_VALUE_FLAGS=" --provider --budget --budget-limit --max-cost --max-iterations --max-retries --session-model --completion-promise --base-wait --max-wait --prd --brief --attempts --spec --aider-model --aider-flags --cline-model --isolation --output --engine --mirofish-rounds --mirofish-timeout "
# Flags engine10 honors as-is.
_ROUTE_E10_FLAGS=" --no-pr --deep --json --verbose --provider --max-cost --spec --attempts "
# Accepted and dropped (no-ops on a non-interactive run).
_ROUTE_NOOP_FLAGS=" --yes -y --no-plan --no-mirofish --no-dashboard "

_route_has() { case "$1" in *" $2 "*) return 0 ;; esac; return 1; }

_route_json_str() {
    printf '%s' "$1" | tr '\n\t\r' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

_route_classify() {
    # $1 = single positional. Echoes: issue | prd | task | brief | missing-prd
    local p="$1"
    case "$p" in
        */*\#[0-9]*|http*://*/issues/*|http*://*/browse/*|jira:*|linear:*|https://linear.app/*/issue/*) echo issue; return 0 ;;
    esac
    if [ -f "$p" ]; then echo prd; return 0; fi
    case "$p" in
        *" "*) echo task; return 0 ;;
        *.md|*.markdown|*.txt|*.json|*.yaml|*.yml) echo missing-prd; return 0 ;;
    esac
    echo brief
}

# loki_route_resolve VERB ARGS...   VERB = start | quick | bare
# Sets: R_DECIDED R_E10 R_HARD R_ENGINE R_REASON R_INPUT_TYPE R_INPUT R_PROVIDER
#       R_MODEL R_NOTICE R_ERR R_EXPLAIN R_JSON R_E10_ARGS[] R_CLEAN[] R_SESSION_MODEL R_VERB
loki_route_resolve() {
    local verb="$1"; shift
    R_DECIDED=0; R_E10=0; R_HARD=0; R_ENGINE=""; R_REASON=""; R_INPUT_TYPE=""; R_INPUT=""
    R_PROVIDER=""; R_MODEL=""; R_NOTICE=""; R_ERR=""; R_EXPLAIN=0; R_JSON=0; R_SESSION_MODEL=""; R_VERB=""
    R_E10_ARGS=(); R_CLEAN=()

    local a v engine_req="" help=0 legacy_flag="" unknown_flag="" session_model="" provider_flag=""
    local -a positionals=() passthru=()
    local i=0 n=$#
    local -a argv=("$@")
    while [ "$i" -lt "$n" ]; do
        a="${argv[$i]}"
        i=$((i + 1))
        case "$a" in
            --engine) engine_req="${argv[$i]:-}"; i=$((i + 1)); continue ;;
            --engine=*) engine_req="${a#--engine=}"; continue ;;
            --explain-route) R_EXPLAIN=1; continue ;;
            --help|-h) help=1; R_CLEAN+=("$a"); continue ;;
            --) R_CLEAN+=("$a"); while [ "$i" -lt "$n" ]; do positionals+=("${argv[$i]}"); R_CLEAN+=("${argv[$i]}"); i=$((i + 1)); done; break ;;
        esac
        R_CLEAN+=("$a")
        case "$a" in
            -*)
                local name="${a%%=*}" val="" hasval=0
                if _route_has "$_ROUTE_VALUE_FLAGS" "$name"; then
                    if [ "$name" = "$a" ]; then
                        val="${argv[$i]:-}"; i=$((i + 1)); R_CLEAN+=("$val")
                    else
                        val="${a#*=}"
                    fi
                    hasval=1
                fi
                case "$name" in
                    --prd) positionals+=("$val"); continue ;;
                    --brief) positionals+=("$val"); continue ;;
                    --provider) provider_flag="$val"; passthru+=(--provider "$val"); continue ;;
                    --session-model) session_model="$val"; continue ;;
                    --budget|--budget-limit|--max-cost) passthru+=(--max-cost "$val"); continue ;;
                    --json) R_JSON=1; passthru+=(--json); continue ;;
                    -v) passthru+=(--verbose); continue ;;
                    --attempts) passthru+=(--attempts "$val"); continue ;;
                    --spec) passthru+=(--spec "$val"); continue ;;
                esac
                if _route_has "$_ROUTE_NOOP_FLAGS" "$name"; then continue; fi
                if _route_has "$_ROUTE_E10_FLAGS" "$name"; then passthru+=("$name"); continue; fi
                # Everything else is a flag engine10 does not honor.
                if [ -z "$legacy_flag" ]; then legacy_flag="$name"; fi
                ;;
            *) positionals+=("$a") ;;
        esac
    done

    if [ "$help" = "1" ]; then return 0; fi

    # Engine request: flag wins over env.
    if [ -z "$engine_req" ]; then engine_req="${LOKI_ENGINE:-}"; fi
    engine_req=$(printf '%s' "$engine_req" | tr '[:upper:]' '[:lower:]')
    case "$engine_req" in
        ""|legacy) ;;
        engine10|e10|v10|10) engine_req=engine10 ;;
        *) R_ERR="loki: unknown engine '$engine_req' (use --engine legacy or --engine engine10)"; R_DECIDED=1; return 0 ;;
    esac

    # Input.
    local npos=${#positionals[@]}
    if [ "$npos" -eq 0 ]; then
        R_INPUT_TYPE=none
        local k=0 sp=0
        while [ "$k" -lt "${#passthru[@]}" ]; do
            if [ "${passthru[$k]}" = "--spec" ]; then sp=1; fi
            k=$((k + 1))
        done
        # No positional and no --spec: not ours (bare `loki start` auto-detects a PRD).
        if [ "$sp" = "0" ]; then R_INPUT_TYPE=""; return 0; fi
        R_INPUT_TYPE=spec
        R_INPUT="(from --spec)"
    elif [ "$npos" -eq 1 ]; then
        R_INPUT_TYPE=$(_route_classify "${positionals[0]}")
        R_INPUT="${positionals[0]}"
    else
        R_INPUT_TYPE=task
        R_INPUT="${positionals[*]}"
    fi

    # Bare flag-first form takes over only multi-word tasks and issue refs (a one-word
    # first argument is the command namespace) and only when no unknown flag is present.
    if [ "$verb" = "bare" ]; then
        case "$R_INPUT_TYPE" in
            task|issue) ;;
            *) R_INPUT_TYPE=""; return 0 ;;
        esac
        if [ -n "$legacy_flag" ] && [ -z "$engine_req" ]; then R_INPUT_TYPE=""; return 0; fi
    fi

    R_DECIDED=1
    if [ "$R_INPUT_TYPE" = "missing-prd" ]; then
        R_ERR="loki: PRD file not found: ${positionals[0]}"
        return 0
    fi

    # Provider and model (display only; engine10 resolves its own at run time).
    R_PROVIDER="$provider_flag"
    if [ -z "$R_PROVIDER" ]; then R_PROVIDER="${LOKI_PROVIDER:-}"; fi
    if [ -z "$R_PROVIDER" ] && [ -f "${PWD}/.loki/state/provider" ]; then
        R_PROVIDER="$(sed -n '1p' "${PWD}/.loki/state/provider" 2>/dev/null || true)"
    fi
    if [ -z "$R_PROVIDER" ]; then R_PROVIDER=claude; fi
    if [ -n "$session_model" ]; then
        R_MODEL="$session_model"
    elif [ -n "${LOKI_SESSION_MODEL:-}" ]; then
        R_MODEL="$LOKI_SESSION_MODEL"
    elif [ -n "${LOKI_MODEL_ROUTE:-}" ]; then
        R_MODEL="route: $LOKI_MODEL_ROUTE"
    elif [ -n "${LOKI_MODEL_OVERRIDE:-}" ]; then
        R_MODEL="$LOKI_MODEL_OVERRIDE"
    elif [ "$R_PROVIDER" = "opencode" ] && [ -n "${LOKI_OPENCODE_MODEL:-}" ]; then
        R_MODEL="$LOKI_OPENCODE_MODEL"
    elif [ "$R_PROVIDER" = "claude" ]; then
        R_MODEL="${LOKI_CLAUDE_MODEL_DEVELOPMENT:-${LOKI_MODEL_DEVELOPMENT:-claude (provider default)}}"
    else
        R_MODEL="$R_PROVIDER (model not recorded)"
    fi
    R_SESSION_MODEL="$session_model"

    # Task text for engine10: a PRD file is read, anything else is the words.
    local task
    if [ "$R_INPUT_TYPE" = "prd" ]; then
        task=$(cat "${positionals[0]}" 2>/dev/null || true)
    elif [ "$R_INPUT_TYPE" = "spec" ]; then
        task=""
    else
        task="${positionals[*]}"
    fi
    if [ "$verb" = "quick" ]; then R_E10_ARGS+=(--no-pr); fi
    if [ -n "$task" ]; then R_E10_ARGS+=("$task"); fi
    R_E10_ARGS+=("${passthru[@]+"${passthru[@]}"}")

    local why=""
    if [ "$engine_req" = "legacy" ]; then
        R_ENGINE=legacy; R_REASON="explicit: --engine legacy or LOKI_ENGINE=legacy"
    elif [ "$engine_req" = "engine10" ]; then
        if [ -n "$legacy_flag" ]; then
            R_ERR="loki: flag $legacy_flag is not supported by the engine10 engine; drop it or use --engine legacy"
            return 0
        fi
        R_ENGINE=engine10; R_E10=1; R_HARD=1; R_REASON="explicit: --engine engine10"
    elif [ -n "$legacy_flag" ]; then
        R_ENGINE=legacy
        R_REASON="flag $legacy_flag is not supported by engine10"
        R_NOTICE="loki: routing this call to the legacy engine because of $legacy_flag (engine10 does not support it). Drop the flag to use engine10, or pass --engine legacy to silence this."
    else
        case "$R_PROVIDER" in
            claude|codex|cline|aider|opencode) ;;
            *) why="provider $R_PROVIDER has no engine10 invoker (use claude, codex, cline, aider or opencode)" ;;
        esac
        if [ -z "$why" ] && [ "$R_INPUT_TYPE" = "prd" ]; then
            local sz
            sz=$(wc -c < "${positionals[0]}" 2>/dev/null | tr -d ' ' || echo 0)
            if [ "${sz:-0}" -gt 100000 ]; then why="PRD is larger than 100000 bytes (engine10 takes the task as one argument)"; fi
        fi
        if [ -n "$why" ]; then
            R_ENGINE=legacy; R_REASON="$why"
            R_NOTICE="loki: routing this call to the legacy engine: $why."
        else
            R_ENGINE=engine10; R_E10=1
            R_REASON="default: $R_INPUT_TYPE input runs on engine10 regardless of flag order"
        fi
    fi
    return 0
}

# Print the route (human or --json). Returns 0.
loki_route_print() {
    local shown="$R_INPUT"
    if [ "${#shown}" -gt 72 ]; then shown="$(printf '%s' "$shown" | cut -c1-69)..."; fi
    if [ "$R_JSON" = "1" ]; then
        printf '{"engine":"%s","provider":"%s","model":"%s","input_type":"%s","input":"%s","reason":"%s"}\n' \
            "$(_route_json_str "$R_ENGINE")" "$(_route_json_str "$R_PROVIDER")" "$(_route_json_str "$R_MODEL")" \
            "$(_route_json_str "$R_INPUT_TYPE")" "$(_route_json_str "$shown")" "$(_route_json_str "$R_REASON")"
    else
        printf 'engine:   %s\nprovider: %s\nmodel:    %s\ninput:    %s (%s)\nreason:   %s\n' \
            "$R_ENGINE" "$R_PROVIDER" "$R_MODEL" "$R_INPUT_TYPE" "$shown" "$R_REASON"
    fi
}

# Entry used by bin/loki. Args: the full original argv. Sets R_* and returns:
#   0 = handled (caller reads R_DECIDED); 7 = `loki route` / --explain-route printed (caller exits 0)
#   8 = usage or input error already printed (caller exits 2)
loki_route_dispatch() {
    R_DECIDED=0
    local verb="" first="${1:-}"
    case "$first" in
        route)
            shift
            case "${1:-}" in start|quick) verb="$1"; shift ;; *) verb=start ;; esac
            loki_route_resolve "$verb" "$@"
            if [ -n "$R_ERR" ]; then echo "$R_ERR" >&2; return 8; fi
            if [ "$R_DECIDED" != "1" ]; then
                echo "loki: usage: loki route [start|quick] <task | prd.md | owner/repo#N> [flags] [--json]" >&2; return 8
            fi
            loki_route_print; return 7
            ;;
        start|quick)
            verb="$first"; shift
            loki_route_resolve "$verb" "$@"
            ;;
        -*)
            loki_route_resolve bare "$@"
            verb=bare
            ;;
        *)
            # Positional-first call: only LOKI_ENGINE needs the resolver here.
            if [ -n "${LOKI_ENGINE:-}" ]; then
                case "$first" in
                    *" "*|*/*\#[0-9]*|http*://*/issues/*)
                        loki_route_resolve bare "$@"; verb=bare ;;
                esac
            fi
            ;;
    esac
    if [ "$R_DECIDED" != "1" ]; then return 0; fi
    if [ -n "$R_ERR" ]; then echo "$R_ERR" >&2; return 8; fi
    if [ "$R_EXPLAIN" = "1" ]; then loki_route_print; return 7; fi
    if [ -n "$R_NOTICE" ]; then echo "$R_NOTICE" >&2; fi
    R_VERB="$verb"
    return 0
}
