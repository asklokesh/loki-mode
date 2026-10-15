#!/usr/bin/env bash
# loki chat: interactive Plan/Build REPL. Claude Code is the default provider.
# Sourced by autonomy/loki; defines cmd_chat. Free text goes to the provider
# in the current mode; slash commands delegate to existing loki commands.

_LOKI_CHAT_SYSTEM_PROMPT="You are running inside Loki Mode chat. Be concise. Prefer small, verifiable changes. Loki commands available to the user: loki start, loki quick, loki verify, loki receipt, loki undo."

_chat_loki_bin() {
    local d="${_LOKI_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    if [ -x "$d/../bin/loki" ]; then echo "$d/../bin/loki"
    elif command -v loki >/dev/null 2>&1; then command -v loki
    else echo "$d/loki"; fi
}

_chat_help() {
    cat <<'HLP'
Loki chat commands:
  /plan              read-only mode (no edits)
  /build             edit mode
  /run <prd|brief>   loki start with this session's model and provider (same run as the shell)
  /attach            attach to the current or most recent loki start run in this repo
  /quick <task>      loki quick
  /edit <change>     apply one change (build mode for this turn)
  /verify            loki verify
  /receipt           loki receipt
  /model <id>        set model for this session
  /provider <name>   switch provider (claude, codex, cline, aider, opencode)
  /cost              loki cost
  /diff              git diff --stat plus diff
  /undo [args]       loki undo
  /help, /exit
Attached mode (loki chat --attach or /attach): /status /steer <msg> /diff /verify /receipt /stop
  /detach returns to normal chat. Free text asks the provider about the run (state and log tail as context).
Anything else is sent to the current provider in the current mode.
HLP
}


# Run a delegate without letting a non-zero exit end the session (autonomy/loki runs under set -e).
_chat_do() { local _rc=0; "$@" || _rc=$?; [ "$_rc" -eq 0 ] || echo "(exit $_rc)"; return 0; }

# Newest loki start run in this repo: engine10 run dir first, then legacy session state.
_chat_run_dir() {
    local root="${LOKI_DIR:-.loki}" d newest=""
    for d in "$root"/runs/e10-*/; do [ -d "$d" ] && newest="${d%/}"; done
    echo "$newest"
}

_chat_run_state() {
    local root="${LOKI_DIR:-.loki}" rd="$1" pid
    if [ -f "$root/STOPPED" ]; then echo stopped; return; fi
    if [ -f "$root/loki.pid" ]; then
        pid="$(head -n1 "$root/loki.pid" 2>/dev/null | tr -d '[:space:]')"
        case "$pid" in ''|*[!0-9]*) ;; *) kill -0 "$pid" 2>/dev/null && { echo running; return; } ;; esac
    fi
    if [ -n "$rd" ] && [ -f "$rd/events.jsonl" ]; then
        if grep -q '"run.completed"' "$rd/events.jsonl" 2>/dev/null; then echo finished; else echo running; fi
        return
    fi
    echo finished
}

# Context block for free-text questions in attached mode: state plus the log tail.
_chat_attach_context() {
    local root="${LOKI_DIR:-.loki}" rd lf
    rd="$(_chat_run_dir)"
    printf 'Run state: %s\n' "$(_chat_run_state "$rd")"
    [ -n "$rd" ] && printf 'Run dir: %s\n' "$rd"
    [ -f "$root/state/provider" ] && printf 'Provider: %s\n' "$(head -n1 "$root/state/provider" 2>/dev/null)"
    if [ -n "$rd" ] && [ -f "$rd/events.jsonl" ]; then
        printf 'Last events:\n'; tail -n 20 "$rd/events.jsonl" 2>/dev/null | cut -c1-300
    fi
    lf="$(ls -t "$root"/logs/*.log 2>/dev/null | head -n1 || true)"
    if [ -n "$lf" ]; then printf 'Log tail (%s):\n' "$lf"; tail -n 40 "$lf" 2>/dev/null | cut -c1-300; fi
}

_chat_attach_banner() {
    local rd; rd="$(_chat_run_dir)"
    if [ ! -d "${LOKI_DIR:-.loki}" ]; then
        echo "No .loki state here. Start a run with: loki start <prd|brief>"; return 1
    fi
    echo "Attached to ${rd:+$(basename "$rd")}${rd:-the current session} ($(_chat_run_state "$rd")). /status /steer /diff /verify /receipt /stop /detach"
}

# _chat_send <mode> <text>: one turn against the active provider.
_chat_send() {
    local mode="$1" text="$2"
    if [ "$_CHAT_PROVIDER" = "claude" ]; then
        command -v claude >/dev/null 2>&1 || { echo "loki chat: claude CLI not found" >&2; return 1; }
        local -a args=(-p "$text" --append-system-prompt "$_LOKI_CHAT_SYSTEM_PROMPT")
        if [ "$mode" = "plan" ]; then args+=(--permission-mode plan); else args+=(--permission-mode acceptEdits); fi
        [ -n "$_CHAT_MODEL" ] && args+=(--model "$_CHAT_MODEL")
        [ "$_CHAT_STARTED" = "1" ] && args+=(--continue)
        claude "${args[@]}" || return $?
        _CHAT_STARTED=1
        return 0
    fi
    local prompt="$text"
    if [ "$mode" = "plan" ]; then
        prompt="PLAN MODE: analyze and propose only. Do NOT modify any files. Request: $text"
    fi
    (
        # shellcheck disable=SC1091
        source "${_LOKI_SCRIPT_DIR:-.}/../providers/loader.sh" 2>/dev/null || exit 1
        load_provider "$_CHAT_PROVIDER" >/dev/null 2>&1 || { echo "loki chat: cannot load provider $_CHAT_PROVIDER" >&2; exit 1; }
        provider_invoke "$prompt"
    )
}

# /run: the exact run the shell would give: loki start with this session's provider and model.
# The summary prints at the end of the run; chat stays open afterwards.
_chat_run_start() {
    local loki="$1" input="$2" rc=0
    local -a args=(start "$input" --provider "$_CHAT_PROVIDER")
    [ -n "$_CHAT_MODEL" ] && args+=(--model "$_CHAT_MODEL")
    "$loki" "${args[@]}" || rc=$?
    echo "(run finished, exit $rc; chat is still open)"
    return 0
}

cmd_chat() {
    local tui=0 attach=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --tui) tui=1 ;;
            --attach) attach=1 ;;
            --help|-h)
                echo "Usage: loki chat [--tui] [--attach]"
                echo "  Interactive Plan/Build session. --tui execs the claude CLI with Loki context."
                echo "  --attach joins the current or most recent 'loki start' run in this repo."
                echo "  'loki start' is the primary path; /run inside chat runs the same thing."
                _chat_help
                return 0 ;;
            *) echo "loki chat: unknown option: $1" >&2; return 2 ;;
        esac
        shift
    done

    if [ "$tui" = "1" ]; then
        command -v claude >/dev/null 2>&1 || { echo "loki chat: claude CLI not found" >&2; return 1; }
        local -a targs=(--append-system-prompt "$_LOKI_CHAT_SYSTEM_PROMPT")
        [ -n "${LOKI_MODEL:-}" ] && targs+=(--model "$LOKI_MODEL")
        exec claude "${targs[@]}"
    fi

    if [ ! -t 0 ]; then
        echo "loki chat needs an interactive terminal (use loki quick for one-shot tasks)" >&2
        return 2
    fi

    local loki; loki="$(_chat_loki_bin)"
    local mode="plan" line cmd rest
    _CHAT_PROVIDER="${LOKI_PROVIDER:-claude}"
    _CHAT_MODEL="${LOKI_MODEL:-}"
    _CHAT_STARTED=0
    local attached=0
    echo "Loki chat (provider: $_CHAT_PROVIDER). /help for commands, /exit to quit."
    if [ "$attach" = "1" ]; then _chat_attach_banner && attached=1; fi
    while true; do
        local plabel="$mode"; [ "$attached" = "1" ] && plabel="attached"
        if ! IFS= read -r -e -p "loki[$plabel]> " line; then echo; break; fi
        [ -n "$line" ] || continue
        case "$line" in
            /*) cmd="${line%% *}"; rest=""; [ "$cmd" != "$line" ] && rest="${line#* }" ;;
            *)
                if [ "$attached" = "1" ]; then
                    _chat_send plan "You are answering questions about a running or finished Loki run. Read-only: do not modify files. Context:
$(_chat_attach_context)

Question: $line" || true
                else
                    _chat_send "$mode" "$line" || true
                fi
                continue ;;
        esac
        if [ "$attached" = "1" ]; then
            case "$cmd" in
                /status) _chat_do "$loki" status; continue ;;
                /steer)
                    [ -n "$rest" ] || { echo "usage: /steer <message>"; continue; }
                    _chat_do "$loki" steer "$rest"; continue ;;
                /stop) _chat_do "$loki" stop; continue ;;
                /detach) attached=0; echo "Detached."; continue ;;
            esac
        fi
        case "$cmd" in
            /exit|/quit) break ;;
            /help) _chat_help ;;
            /plan) mode="plan"; echo "Plan mode: read-only." ;;
            /build) mode="build"; echo "Build mode: edits allowed." ;;
            /run)
                [ -n "$rest" ] || { echo "usage: /run <prd|brief>"; continue; }
                _chat_run_start "$loki" "$rest"
                _chat_attach_banner || true ;;
            /attach) _chat_attach_banner && attached=1 ;;
            /status) _chat_do "$loki" status ;;
            /steer)
                [ -n "$rest" ] || { echo "usage: /steer <message>"; continue; }
                _chat_do "$loki" steer "$rest" ;;
            /stop) _chat_do "$loki" stop ;;
            /detach) echo "Not attached." ;;
            /quick)
                [ -n "$rest" ] || { echo "usage: /quick <task>"; continue; }
                _chat_do "$loki" quick "$rest" ;;
            /edit)
                [ -n "$rest" ] || { echo "usage: /edit <change>"; continue; }
                _chat_send build "$rest" ;;
            /verify) _chat_do "$loki" verify ;;
            /receipt) _chat_do "$loki" receipt ;;
            /cost) _chat_do "$loki" cost ;;
            /undo) # shellcheck disable=SC2086
                _chat_do "$loki" undo $rest ;;
            /diff) _chat_do git diff --stat; _chat_do git diff ;;
            /model)
                if [ -n "$rest" ]; then _CHAT_MODEL="$rest"; echo "model: $rest"; else echo "model: ${_CHAT_MODEL:-default}"; fi ;;
            /provider)
                case "$rest" in
                    claude|codex|cline|aider|opencode) _CHAT_PROVIDER="$rest"; _CHAT_STARTED=0; echo "provider: $rest" ;;
                    *) echo "usage: /provider claude|codex|cline|aider|opencode (now: $_CHAT_PROVIDER)" ;;
                esac ;;
            *) echo "unknown command: $cmd (try /help)" ;;
        esac
    done
    return 0
}
