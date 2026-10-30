#!/usr/bin/env bash
# One predictable execution path (OC-ROUTE).
# Sourced by bin/loki. Normalizes argv BEFORE the engine decision so argument
# order and input form never change the engine:
#   engine10 is the default for a PRD file, an issue ref, a multi-word task and a
#   one-word brief, whether the flags come first or last.
#   The legacy engine runs only on --engine legacy / LOKI_ENGINE=legacy, or a size or
#   env-provider fallback. A flag never changes the engine: engine10 maps it or refuses it.
# Pure functions: no exec, no side effects except R_* globals and the printers.
# Bash 3.2 compatible (no associative arrays, no ${var,,}).

# Flags that take a separate value token.
_ROUTE_VALUE_FLAGS=" --provider --budget --budget-limit --max-cost --max-iterations --max-retries --session-model --completion-promise --base-wait --max-wait --prd --brief --attempts --spec --aider-model --aider-flags --cline-model --isolation --output --engine --mirofish-rounds --mirofish-timeout --max-duration --log-level --compliance --cost --remote --issue --bmad-project --openspec --mirofish-docker --destination --domain --env-file --health-url --health-match --workspace --config --vars --seal-existing "
# Flags whose value is optional (cmd_start reads one only when it is present): --mirofish takes a URL (a token that does not
# start with --, as _loki_start_optval_consumes). Declared here so a refused one still consumes its value. --parallel is NOT
# here: cmd_start treats it as a plain boolean (_loki_start_flag_kind), so "--parallel 3" leaves 3 as a positional.
_ROUTE_OPTVAL_FLAGS=" --mirofish "
# Flags engine10 honors as-is.
_ROUTE_E10_FLAGS=" --no-pr --deep --json --verbose --quiet --resume --provider --max-cost --spec --attempts --seal-existing "
# The most a run cap can reach (capCeilingS(true) in loki-ts/src/util/run_cap.ts: the subscription ceiling).
_ROUTE_CAP_CEILING_S=3600
# Accepted and dropped (no-ops on a non-interactive run).
# --pr is a no-op because engine10 opens a PR by default (--no-pr turns it off).
_ROUTE_NOOP_FLAGS=" --yes -y --no-plan --no-mirofish --no-dashboard --pr "

# _route_refusal_hint FLAG: the engine10 replacement for a legacy-only flag (no engine10 equivalent exists).
_route_refusal_hint() {
    case "$1" in
        --ship) echo "engine10 opens the PR itself and does not auto-merge; merge it with 'loki merge-queue', or pass --engine legacy to keep --ship" ;;
        --worktree|-w) echo "engine10 runs each attempt in its own isolated worktree already; drop the flag, or pass --engine legacy for a git-worktree run" ;;
        --detach|-d) echo "run it in the background yourself ('nohup loki start ... &') or queue it with 'loki queue run', or pass --engine legacy for --detach" ;;
        --parallel) echo "use 'loki queue run --parallel K' or 'loki issues run --parallel K' for parallel runs, or pass --engine legacy for --parallel" ;;
        *) echo "drop it, or pass --engine legacy to run the legacy loop with it" ;;
    esac
}

_route_has() { case "$1" in *" $2 "*) return 0 ;; esac; return 1; }

# _route_optval_consumes FLAG NEXT: whether an optional-value flag takes the next token as its value.
_route_optval_consumes() {
    [ -n "$2" ] && [ "${2#--}" = "$2" ]
}

# _route_duration_s VALUE: seconds from 90, 90s, 90m or 2h; empty output when unusable or zero.
_route_duration_s() {
    local v="$1" n unit
    case "$v" in
        [0-9]*[0-9]|[0-9]) n="$v"; unit=s ;;
        [0-9]*[smh]) n="${v%?}"; unit="${v#"$n"}" ;;
        *) return 0 ;;
    esac
    case "$n" in *[!0-9]*|"") return 0 ;; esac
    n=$((10#$n))
    [ "$n" -gt 0 ] || return 0
    case "$unit" in m) n=$((n * 60)) ;; h) n=$((n * 3600)) ;; esac
    printf '%s' "$n"
}

_route_json_str() {
    printf '%s' "$1" | tr '\n\t\r' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Echoes the canonical https://github.com/owner/repo/pull/N for a github.com pull request URL
# (host case-insensitive, optional www., http or https, optional /files style suffix); echoes nothing otherwise.
# The owner/repo shape mirrors parsePrRef in loki-ts/src/commands/verify_pr.ts.
_route_pr_url() {
    local re='^[Hh][Tt][Tt][Pp][Ss]?://([Ww][Ww][Ww]\.)?[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]/([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*)/pull/([0-9]+)([/?#].*)?$'
    if [[ "$1" =~ $re ]]; then printf 'https://github.com/%s/pull/%s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"; fi
}

# `loki start <PR URL> [--json] [--out DIR] [--no-pr]` is the verify-pr command, whatever the flag order.
# Returns 1 when no argument is a PR URL (the caller carries on). Otherwise sets R_* (R_PR_ARGS = the verify-pr argv)
# and returns 0; an unsupported flag or a second input sets R_ERR.
# shellcheck disable=SC2034
_route_pr_mode() {
    local a pr="" bad="" badref="" extra="" i=0 n=$# u
    local -a argv=("$@") eargs=()
    for u in "$@"; do
        case "$u" in --help|-h) return 1 ;; esac
    done
    while [ "$i" -lt "$n" ]; do
        a="${argv[$i]}"; i=$((i + 1))
        case "$a" in
            --explain-route) R_EXPLAIN=1 ;;
            --json) eargs+=(--json); R_JSON=1 ;;
            --no-pr) ;;
            --out) eargs+=(--out "${argv[$i]:-}"); i=$((i + 1)) ;;
            --out=*) eargs+=(--out "${a#--out=}") ;;
            -*) [ -n "$bad" ] || bad="${a%%=*}" ;;
            *)
                u="$(_route_pr_url "$a")"
                # PR-shaped but invalid (a ".." in owner/repo): refused, like parsePrRef in verify_pr.ts.
                if [ -n "$u" ]; then case "${u#https://github.com/}" in *..*) [ -n "$badref" ] || badref="$a" ;; esac; fi
                if [ -n "$u" ] && [ -z "$pr" ]; then pr="$u"; else extra="${extra:+$extra }$a"; fi ;;
        esac
    done
    [ -n "$pr" ] || return 1
    R_DECIDED=1; R_INPUT_TYPE="pr"; R_INPUT="$pr"; R_ENGINE="verify-pr"; R_ADAPTER="verify-pr"
    R_PROVIDER="n/a"; R_MODEL="n/a (no model call)"
    R_REASON="pull request URL: verify-pr seals it; no plan or implement stage, nothing is pushed"
    if [ -n "$badref" ]; then
        R_ERR="loki: start <PR url>: not a valid pull request URL: $badref"
    elif [ -n "$bad" ]; then
        R_ERR="loki: start <PR url>: flag $bad is not supported (verify-pr takes --out DIR, --json and --no-pr)"
    elif [ -n "$extra" ]; then
        R_ERR="loki: start <PR url> takes one input; also got: $extra"
    else
        R_PR_ARGS=("$pr" ${eargs[@]+"${eargs[@]}"})
    fi
    return 0
}

_route_classify() {
    # $1 = single positional. Echoes: pr | issue | prd | task | brief | missing-prd
    local p="$1"
    if [ -n "$(_route_pr_url "$p")" ]; then echo pr; return 0; fi
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
# R_* are the result interface read by the sourcing caller.
# shellcheck disable=SC2034
loki_route_resolve() {
    local verb="$1"; shift
    R_DECIDED=0; R_E10=0; R_HARD=0; R_ENGINE=""; R_REASON=""; R_INPUT_TYPE=""; R_INPUT=""
    R_PROVIDER=""; R_MODEL=""; R_NOTICE=""; R_ERR=""; R_EXPLAIN=0; R_JSON=0; R_SESSION_MODEL=""; R_VERB=""
    R_E10_ARGS=(); R_CLEAN=(); R_ADAPTER=""; R_CAPDIFF=(); R_E10_CAP_S=""; R_DRY=0; R_MAXCOST=""; R_PR_ARGS=()
    if [ "$verb" = "start" ] && _route_pr_mode "$@"; then return 0; fi

    local a engine_req="" dry=0 help=0 legacy_flag="" session_model="" provider_flag="" max_duration="" cap_err="" input_flag=""
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
                local name="${a%%=*}" val=""
                if _route_has "$_ROUTE_VALUE_FLAGS" "$name"; then
                    if [ "$name" = "$a" ]; then
                        val="${argv[$i]:-}"; i=$((i + 1)); R_CLEAN+=("$val")
                    else
                        val="${a#*=}"
                    fi
                elif _route_has "$_ROUTE_OPTVAL_FLAGS" "$name"; then
                    if [ "$name" = "$a" ]; then
                        if _route_optval_consumes "$name" "${argv[$i]:-}"; then
                            val="${argv[$i]}"; i=$((i + 1)); R_CLEAN+=("$val")
                        fi
                    else
                        val="${a#*=}"
                    fi
                fi
                case "$name" in
                    --prd|--brief) input_flag="$name"; positionals+=("$val"); continue ;;
                    --provider) provider_flag="$val"; passthru+=(--provider "$val"); continue ;;
                    --session-model) session_model="$val"; continue ;;
                    --budget|--budget-limit|--max-cost) passthru+=(--max-cost "$val"); R_MAXCOST="$val"; continue ;;
                    --dry-run) dry=1; continue ;;
                    --json) R_JSON=1; passthru+=(--json); continue ;;
                    -v) passthru+=(--verbose); continue ;;
                    --attempts) passthru+=(--attempts "$val"); continue ;;
                    --spec) passthru+=(--spec "$val"); continue ;;
                    --seal-existing) passthru+=(--seal-existing "$val"); continue ;;
                    --max-duration)
                        max_duration="$(_route_duration_s "$val")"
                        if [ -z "$max_duration" ] && [ -z "$cap_err" ]; then
                            cap_err="loki: --max-duration '$val' is not a duration (use seconds, or 90m / 2h)"
                        fi
                        continue ;;
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
        # Only `loki start` sends a PR URL to verify-pr (_route_pr_mode); on any other verb engine10 runs it as a brief.
        if [ "$R_INPUT_TYPE" = "pr" ]; then R_INPUT_TYPE=brief; fi
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
    fi

    R_DECIDED=1
    if [ -n "$cap_err" ]; then R_ERR="$cap_err"; return 0; fi
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

    # --prd and --brief name the input themselves; a second input would have glued its words into the task.
    if [ -n "$input_flag" ] && [ "$npos" -gt 1 ]; then
        R_ERR="loki: $input_flag cannot be combined with another input (${positionals[*]}); give one input"
        return 0
    fi
    # A flag never changes the engine (#236): an unmapped one is refused, not routed to legacy.
    if [ -n "$legacy_flag" ] && [ "$engine_req" != "legacy" ]; then
        R_ERR="loki: flag $legacy_flag is not supported by the Loki 10 engine; $(_route_refusal_hint "$legacy_flag")"
        return 0
    fi
    # Wall-clock cap: LOKI_E10_CAP_S seconds, bounded by the run-cap ceiling.
    if [ -n "$max_duration" ] && [ "$engine_req" != "legacy" ]; then
        R_E10_CAP_S="$max_duration"
        if [ "$R_E10_CAP_S" -gt "$_ROUTE_CAP_CEILING_S" ]; then
            R_E10_CAP_S="$_ROUTE_CAP_CEILING_S"
            R_NOTICE="loki: --max-duration $max_duration s is above the engine10 run-cap ceiling; using ${_ROUTE_CAP_CEILING_S}s."
        fi
    fi
    if [ -n "$provider_flag" ] && [ "$engine_req" != "legacy" ]; then
        case "$provider_flag" in
            claude|codex|cline|aider|opencode) ;;
            *)
                R_ERR="loki: --provider $provider_flag has no Loki 10 engine invoker (use claude, codex, cline, aider or opencode, or pass --engine legacy)"
                return 0 ;;
        esac
    fi
    # --dry-run (engine10 has no preview of its own for these inputs): print the route, then exit 0 without a run.
    if [ "$dry" = "1" ] && [ "$engine_req" != "legacy" ]; then R_DRY=1; fi
    local why=""
    if [ "$engine_req" = "legacy" ]; then
        R_ENGINE=legacy; R_REASON="explicit: --engine legacy or LOKI_ENGINE=legacy"
    elif [ "$engine_req" = "engine10" ]; then
        R_ENGINE=engine10; R_E10=1; R_HARD=1; R_REASON="explicit: --engine engine10"
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
    _route_adapter_and_diffs "$legacy_flag"
    return 0
}

# Sets R_ADAPTER and R_CAPDIFF[] from R_ENGINE / R_PROVIDER. Empty R_CAPDIFF means the
# full Claude Code path on the Loki 10 engine. Statements mirror providers/*.sh
# (PROVIDER_HAS_TASK_TOOL=false for every non-claude provider).
_route_adapter_and_diffs() {
    local legacy_flag="$1"
    R_CAPDIFF=()
    if [ "$R_ENGINE" = "legacy" ]; then
        R_ADAPTER="legacy-bash:$R_PROVIDER"
        R_CAPDIFF+=("runs the previous bash loop (autonomy/run.sh) instead of the Loki 10 supervisor")
        if [ -n "$legacy_flag" ]; then
            R_CAPDIFF+=("honors $legacy_flag, which engine10 does not support")
        fi
    else
        R_ADAPTER="engine10:$R_PROVIDER"
    fi
    case "$R_PROVIDER" in
        claude) ;;
        codex|cline|aider|opencode)
            R_CAPDIFF+=("provider $R_PROVIDER has no Claude Code Task-tool subagents (providers/$R_PROVIDER.sh)") ;;
        *)
            R_CAPDIFF+=("provider $R_PROVIDER has no engine10 invoker") ;;
    esac
}

# Print the route (human or --json). Returns 0.
loki_route_print() {
    local shown="$R_INPUT"
    if [ "${#shown}" -gt 72 ]; then shown="$(printf '%s' "$shown" | cut -c1-69)..."; fi
    if [ "$R_JSON" = "1" ]; then
        local diffs="" d
        for d in ${R_CAPDIFF[@]+"${R_CAPDIFF[@]}"}; do
            diffs="${diffs:+$diffs,}\"$(_route_json_str "$d")\""
        done
        printf '{"engine":"%s","adapter":"%s","provider":"%s","model":"%s","input_type":"%s","input":"%s","reason":"%s","capability_differences":[%s],"run_cap_s":%s}\n' \
            "$(_route_json_str "$R_ENGINE")" "$(_route_json_str "$R_ADAPTER")" "$(_route_json_str "$R_PROVIDER")" "$(_route_json_str "$R_MODEL")" \
            "$(_route_json_str "$R_INPUT_TYPE")" "$(_route_json_str "$shown")" "$(_route_json_str "$R_REASON")" "$diffs" "${R_E10_CAP_S:-null}"
    else
        printf 'engine:   %s\nadapter:  %s\nprovider: %s\nmodel:    %s\ninput:    %s (%s)\nreason:   %s\n' \
            "$R_ENGINE" "$R_ADAPTER" "$R_PROVIDER" "$R_MODEL" "$R_INPUT_TYPE" "$shown" "$R_REASON"
        local d
        for d in ${R_CAPDIFF[@]+"${R_CAPDIFF[@]}"}; do printf 'differs:  %s\n' "$d"; done
    fi
    return 0
}

# Entry used by bin/loki. Args: the full original argv. Sets R_* and returns:
#   0 = handled (caller reads R_DECIDED); 7 = `loki route` / --explain-route printed (caller exits 0)
#   8 = usage or input error already printed (caller exits 2)
# shellcheck disable=SC2034
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
    if [ "$R_DRY" = "1" ]; then
        loki_route_print
        printf 'max-cost: %s\nrun-cap: %ss\ndry-run: nothing was started\n' "${R_MAXCOST:-default (engine10 resolves its own)}" "${R_E10_CAP_S:-$_ROUTE_CAP_CEILING_S}"
        return 7
    fi
    if [ -n "$R_NOTICE" ]; then echo "$R_NOTICE" >&2; fi
    R_VERB="$verb"
    return 0
}
