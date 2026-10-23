#!/usr/bin/env bash
# bun-safe.sh: the one way Loki runs bun with the user's repo as cwd.
# FC-REPO-BUNFIG-AND-ENV-REACH-ORCHESTRATOR: bun resolves bunfig.toml (preload = code) and .env
# from the CURRENT directory, which is the user's repo, not Loki's. Every bun that runs Loki code
# therefore gets --config=/dev/null (no bunfig anywhere, so no repo preload) and --no-env-file
# (no .env). One flag list, two entry points: no route may call bun any other way.
#   _loki_exec_bun <bun> <args...>  exec the Loki CLI entry ($BUN_CLI) under <bun>
#   loki_bun_run <args...>          run bun (script path first) and return; safe in pipes,
#                                   command substitution and background jobs
# A project .env is OFF by default. LOKI_ALLOW_PROJECT_ENV=1 opts in: bash reads the cwd .env
# itself and exports plain names only, never over a variable already set (the real environment
# wins, as in bun). Names are denied by CLASS, not one by one, because each class gives code
# execution or traffic redirection in a child: LOKI_*, BUN_*, NODE_*, npm config (NPM_*), loader
# (LD_*, DYLD_*), shell (PATH, HOME, SHELL, IFS, ENV, BASH_*, ...), every git and ssh knob (GIT_*
# includes GIT_CONFIG_COUNT/KEY_n/VALUE_n -> core.fsmonitor, GIT_ASKPASS; SSH_*), every proxy
# (*_PROXY, *_proxy), every endpoint (*_BASE_URL), interpreter startup (PYTHON*, PERL*, RUBY*)
# and EDITOR, VISUAL, PAGER.
_LOKI_BUN_SAFE_FLAGS=(--config=/dev/null --no-env-file)
_loki_apply_project_env() {
    [ "${LOKI_ALLOW_PROJECT_ENV:-}" = "1" ] && [ -f ./.env ] || return 0
    local _line _k _v
    while IFS= read -r _line || [ -n "$_line" ]; do
        _line="${_line#"${_line%%[![:space:]]*}"}"
        _line="${_line#export }"
        case "$_line" in ''|'#'*) continue ;; esac
        _k="${_line%%=*}"; _v="${_line#*=}"
        [ "$_k" != "$_line" ] || continue
        _k="${_k%"${_k##*[![:space:]]}"}"
        case "$_k" in
            ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;
            LOKI_*|BUN_*|NODE_*|NPM_*|npm_*|LD_*|DYLD_*|PATH|HOME|SHELL|IFS|ENV|BASH_ENV|BASH_*|PS4|CDPATH|GLOBIGNORE|SHELLOPTS|PROMPT_COMMAND) continue ;;
            GIT_*|SSH_*|*_PROXY|*_proxy|*_BASE_URL|PYTHON*|PERL*|RUBY*|EDITOR|VISUAL|PAGER) continue ;;
        esac
        [ -z "${!_k+x}" ] || continue
        case "$_v" in
            \"*\") _v="${_v#\"}"; _v="${_v%\"}" ;;
            \'*\') _v="${_v#\'}"; _v="${_v%\'}" ;;
        esac
        export "$_k=$_v"
    done < ./.env
}
# _loki_exec_bun <bun> <args...>: exec the Loki CLI entry under <bun> with repo config disabled.
_loki_exec_bun() {
    local _bun="$1"; shift
    _loki_apply_project_env
    exec "$_bun" "${_LOKI_BUN_SAFE_FLAGS[@]}" "$BUN_CLI" "$@"
}

# loki_bun_run: .env is applied in a subshell so the caller's environment is never changed.
loki_bun_run() {
    ( _loki_apply_project_env; exec bun "${_LOKI_BUN_SAFE_FLAGS[@]}" "$@" )
}
# loki_bun_run_detached: as loki_bun_run, with SIGHUP ignored (the exec keeps it ignored), for
# background servers that must outlive the shell. Replaces `nohup bun`.
loki_bun_run_detached() {
    ( trap '' HUP; _loki_apply_project_env; exec bun "${_LOKI_BUN_SAFE_FLAGS[@]}" "$@" )
}
