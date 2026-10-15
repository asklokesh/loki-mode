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
  /run <prd|brief>   loki start with a PRD file or one-line brief
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
Anything else is sent to the current provider in the current mode.
HLP
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

cmd_chat() {
    local tui=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --tui) tui=1 ;;
            --help|-h)
                echo "Usage: loki chat [--tui]"
                echo "  Interactive Plan/Build session. --tui execs the claude CLI with Loki context."
                echo "  Bare 'loki' opens chat on a TTY; set LOKI_NO_CHAT=1 to disable."
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
    echo "Loki chat (provider: $_CHAT_PROVIDER). /help for commands, /exit to quit."
    while true; do
        if ! IFS= read -r -e -p "loki[$mode]> " line; then echo; break; fi
        [ -n "$line" ] || continue
        case "$line" in
            /*) cmd="${line%% *}"; rest=""; [ "$cmd" != "$line" ] && rest="${line#* }" ;;
            *) _chat_send "$mode" "$line"; continue ;;
        esac
        case "$cmd" in
            /exit|/quit) break ;;
            /help) _chat_help ;;
            /plan) mode="plan"; echo "Plan mode: read-only." ;;
            /build) mode="build"; echo "Build mode: edits allowed." ;;
            /run)
                [ -n "$rest" ] || { echo "usage: /run <prd|brief>"; continue; }
                "$loki" start "$rest" ;;
            /quick)
                [ -n "$rest" ] || { echo "usage: /quick <task>"; continue; }
                "$loki" quick "$rest" ;;
            /edit)
                [ -n "$rest" ] || { echo "usage: /edit <change>"; continue; }
                _chat_send build "$rest" ;;
            /verify) "$loki" verify ;;
            /receipt) "$loki" receipt ;;
            /cost) "$loki" cost ;;
            /undo) # shellcheck disable=SC2086
                "$loki" undo $rest ;;
            /diff) git diff --stat; git diff ;;
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
