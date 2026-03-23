#!/bin/bash

_loki_completion() {
    local cur prev words cword
    _init_completion || return

    # Main subcommands (must match autonomy/loki main case statement)
    local main_commands="start quick demo init stop pause resume status dashboard logs serve api sandbox notify import github issue config provider reset memory compound checkpoint council dogfood projects enterprise secrets doctor watchdog audit metrics syslog onboard share explain plan report test ci watch telemetry agent context code run export review optimize heal migrate cluster worktree trigger failover remote version completions help"

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

            # If the word starts with a dash, show flags
            if [[ "$cur" == -* ]]; then
                local flags="--provider --max-iterations --parallel --background --bg --simple --complex --github --no-dashboard --sandbox --skip-memory --yes --budget --help"
                COMPREPLY=( $(compgen -W "${flags}" -- "$cur") )
                return 0
            fi

            # Otherwise, default to file completion (for PRD files)
            COMPREPLY=( $(compgen -f -- "$cur") )
            ;;

        council)
            local council_cmds="status verdicts convergence force-review report config help"
            COMPREPLY=( $(compgen -W "${council_cmds}" -- "$cur") )
            ;;

        memory)
            local memory_cmds="list show search stats export clear dedupe index timeline consolidate economics retrieve episode pattern skill vectors help"
            COMPREPLY=( $(compgen -W "${memory_cmds}" -- "$cur") )
            ;;

        compound)
            local compound_cmds="list show search run stats help"
            COMPREPLY=( $(compgen -W "${compound_cmds}" -- "$cur") )
            ;;

        provider)
            local provider_cmds="show set list info help"
            COMPREPLY=( $(compgen -W "${provider_cmds}" -- "$cur") )
            ;;

        config)
            local config_cmds="show init edit path help"
            COMPREPLY=( $(compgen -W "${config_cmds}" -- "$cur") )
            ;;

        dashboard)
            local dashboard_cmds="start stop status url open help"
            COMPREPLY=( $(compgen -W "${dashboard_cmds}" -- "$cur") )
            ;;

        sandbox)
            local sandbox_cmds="start stop status logs shell build help"
            COMPREPLY=( $(compgen -W "${sandbox_cmds}" -- "$cur") )
            ;;

        notify)
            local notify_cmds="test slack discord webhook status help"
            COMPREPLY=( $(compgen -W "${notify_cmds}" -- "$cur") )
            ;;

        enterprise)
            local enterprise_cmds="status token audit help"
            COMPREPLY=( $(compgen -W "${enterprise_cmds}" -- "$cur") )
            ;;

        projects)
            local projects_cmds="list show register add remove discover sync health help"
            COMPREPLY=( $(compgen -W "${projects_cmds}" -- "$cur") )
            ;;

        telemetry)
            local telemetry_cmds="status enable disable stop start help"
            COMPREPLY=( $(compgen -W "${telemetry_cmds}" -- "$cur") )
            ;;

        agent)
            local agent_cmds="list info run start help"
            COMPREPLY=( $(compgen -W "${agent_cmds}" -- "$cur") )
            ;;

        syslog)
            local syslog_cmds="test status help"
            COMPREPLY=( $(compgen -W "${syslog_cmds}" -- "$cur") )
            ;;

        status)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--json --help" -- "$cur") )
                return 0
            fi
            ;;

        doctor)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--json --help" -- "$cur") )
                return 0
            fi
            ;;

        reset)
            local reset_cmds="all retries failed help"
            COMPREPLY=( $(compgen -W "${reset_cmds}" -- "$cur") )
            ;;

        logs)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--follow -f --lines -n --help" -- "$cur") )
                return 0
            fi
            ;;

        issue)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--repo --start --dry-run --output --help" -- "$cur") )
                return 0
            fi
            local issue_cmds="parse view"
            COMPREPLY=( $(compgen -W "${issue_cmds}" -- "$cur") )
            ;;

        onboard)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--depth --format --output --stdout --update --help" -- "$cur") )
                return 0
            fi
            if [[ "$prev" == "--depth" ]]; then
                COMPREPLY=( $(compgen -W "1 2 3" -- "$cur") )
                return 0
            fi
            if [[ "$prev" == "--format" ]]; then
                COMPREPLY=( $(compgen -W "markdown json yaml" -- "$cur") )
                return 0
            fi
            _filedir -d
            ;;

        metrics)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--json --last --save --share --help" -- "$cur") )
                return 0
            fi
            local metrics_cmds="prometheus"
            COMPREPLY=( $(compgen -W "${metrics_cmds}" -- "$cur") )
            ;;

        watch)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--once --interval --no-auto-start --debounce --help" -- "$cur") )
                return 0
            fi
            # Default to file completion for PRD files
            COMPREPLY=( $(compgen -f -- "$cur") )
            ;;

        share)
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "--private --format --help" -- "$cur") )
                return 0
            fi
            if [[ "$prev" == "--format" ]]; then
                COMPREPLY=( $(compgen -W "text markdown html" -- "$cur") )
                return 0
            fi
            ;;

        completions)
            COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
            ;;

        context|ctx)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "show files tools add clear help" -- "$cur") )
                return 0
            fi
            if [[ "${words[2]}" == "add" ]]; then
                COMPREPLY=( $(compgen -f -- "$cur") )
                return 0
            fi
            ;;

        code)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "overview symbols deps hotspots diff help" -- "$cur") )
                return 0
            fi
            case "${words[2]}" in
                overview)
                    if [[ "$cur" == -* ]]; then
                        COMPREPLY=( $(compgen -W "--silent" -- "$cur") )
                        return 0
                    fi
                    _filedir -d
                    ;;
                deps)
                    COMPREPLY=( $(compgen -f -- "$cur") )
                    ;;
                hotspots)
                    if [[ "$cur" == -* ]]; then
                        COMPREPLY=( $(compgen -W "--top" -- "$cur") )
                        return 0
                    fi
                    ;;
                symbols)
                    ;;
            esac
            ;;
    esac
}

# NOTE: Removed '-o nospace'. Added '-o filenames' to handle paths correctly.
complete -o bashdefault -o default -o filenames -F _loki_completion loki
