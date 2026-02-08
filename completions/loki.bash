#!/bin/bash

_loki_completion() {
    local cur prev words cword
    _init_completion || return

    # Main subcommands
    local main_commands="start stop pause resume status dashboard import council memory provider config help completions"

    # 1. If we are on the first argument (subcommand)
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${main_commands}" -- "$cur") )
        return 0
    fi

    # 2. Handle subcommands and their specific flags/args
    case "${words[1]}" in
        start)
            # If the previous word was --provider, show provider names
            if [[ "$prev" == "--provider" ]]; then
                COMPREPLY=( $(compgen -W "claude codex gemini" -- "$cur") )
                return 0
            fi

            # If the word starts with a dash (flag), OR is empty (user hit TAB immediately)
            # We show flags.
            if [[ "$cur" == -* ]]; then
                local flags="--provider --max-iterations --parallel --background --help"
                COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )
                return 0
            fi
            
            # Otherwise, default to file completion (for PRD files)
            # We use -o plusdirs to ensure directory completion works nicely
            COMPREPLY=( $(compgen -f -- "$cur") )
            ;;

        council)
            local council_cmds="status verdicts convergence force-review report config help"
            COMPREPLY=( $(compgen -W "${council_cmds}" -- "$cur") )
            ;;

        memory)
            local memory_cmds="list show search stats export dedupe index retrieve episode pattern skill help"
            COMPREPLY=( $(compgen -W "${memory_cmds}" -- "$cur") )
            ;;

        provider)
            local provider_cmds="show set list info help"
            COMPREPLY=( $(compgen -W "${provider_cmds}" -- "$cur") )
            ;;

        config)
            local config_cmds="show init edit path help"
            COMPREPLY=( $(compgen -W "${config_cmds}" -- "$cur") )
            ;;

        completions)
            COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
            ;;
    esac
}

# NOTE: Removed '-o nospace'. Added '-o filenames' to handle paths correctly.
complete -o bashdefault -o default -o filenames -F _loki_completion loki
