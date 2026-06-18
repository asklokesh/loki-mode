#!/usr/bin/env bash
# git-pr-advisory.sh -- shared, PRINT-ONLY pull-request advisory helper.
#
# LOAD-BEARING INVARIANT: every function here is pure and print-only. It NEVER
# runs `git push`, NEVER runs `gh pr create`, NEVER mutates the repo. It only
# prints the commands a user would run, plus a best-effort clipboard copy of the
# push line. This is the single source of truth sourced by BOTH autonomy/run.sh
# (LOCK A3 create_session_pr) and autonomy/loki (cmd_deploy) so the two surfaces
# print byte-identical, correct commands and cannot drift.
#
# set -e SAFE: this lib may be sourced under `set -uo pipefail` (run.sh) AND
# `set -euo pipefail` (loki). Every fallible command ends with `|| true` or sits
# in a guarded `if`; no bare `((..))`; every var defaulted with `${VAR:-}`;
# every optional tool is `command -v`-guarded. All print paths `return 0` so a
# sourced call cannot abort the caller under set -e.

# Double-source guard.
[ -n "${_GIT_PR_ADVISORY_SH:-}" ] && return 0
_GIT_PR_ADVISORY_SH=1

# _git_pr_advisory_origin_url [dir]
# Echoes the origin remote URL, or empty string if none. Best-effort, never errors.
_git_pr_advisory_origin_url() {
    local dir="${1:-.}"
    local url=""
    command -v git >/dev/null 2>&1 || { printf '%s' ""; return 0; }
    url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
    if [ -z "$url" ]; then
        url="$(git -C "$dir" config --get remote.origin.url 2>/dev/null || true)"
    fi
    printf '%s' "${url:-}"
    return 0
}

# _git_pr_advisory_compare_url <origin_url> <base> <head>
# Echoes a GitHub compare URL, or empty if the origin URL is not a parseable
# github.com remote. Handles both ssh (git@github.com:owner/repo.git) and https
# (https://github.com/owner/repo[.git]) forms. Non-github hosts -> empty.
_git_pr_advisory_compare_url() {
    local origin_url="${1:-}"
    local base="${2:-}"
    local head="${3:-}"
    [ -n "$origin_url" ] || { printf '%s' ""; return 0; }
    [ -n "$base" ] || { printf '%s' ""; return 0; }
    [ -n "$head" ] || { printf '%s' ""; return 0; }

    # Only github.com remotes yield a compare URL. Do not fabricate for other hosts.
    case "$origin_url" in
        *github.com[:/]*) : ;;
        *) printf '%s' ""; return 0 ;;
    esac

    # Reuse the run.sh:2123-2133 idiom: extract owner/repo from ssh or https forms.
    local repo=""
    repo="$(printf '%s' "$origin_url" | sed -E 's/.*github\.com[:/]([^/]+\/[^/]+)(\.git)?$/\1/' 2>/dev/null || true)"
    repo="${repo%.git}"

    if [ -n "$repo" ] && [ "$repo" != "$origin_url" ] && [ "${repo#*/}" != "$repo" ]; then
        printf '%s' "https://github.com/${repo}/compare/${base}...${head}?expand=1"
        return 0
    fi

    printf '%s' ""
    return 0
}

# print_pr_advice <base_branch> <head_branch> [dir]
# Prints PR advice. PRINT-ONLY: never pushes, never creates a PR. Always return 0.
print_pr_advice() {
    local base="${1:-main}"
    local head="${2:-HEAD}"
    local dir="${3:-.}"

    printf '%s\n' "To open a pull request:"
    printf '%s\n' "  git push -u origin ${head}"

    if command -v gh >/dev/null 2>&1; then
        printf '%s\n' "  gh pr create --base ${base} --head ${head} --title \"Loki Mode session changes\" --fill"
    else
        local origin_url="" compare_url=""
        origin_url="$(_git_pr_advisory_origin_url "$dir")"
        compare_url="$(_git_pr_advisory_compare_url "$origin_url" "$base" "$head")"
        if [ -n "$compare_url" ]; then
            printf '%s\n' "  Open: ${compare_url}"
        else
            printf '%s\n' "  Open a pull request for branch ${head} on your git host."
        fi
    fi

    # Best-effort clipboard copy of the push line. TTY-gated, command-v guarded,
    # never fatal. Print a note only if a copy tool actually ran.
    if [ -t 1 ]; then
        local push_line="git push -u origin ${head}"
        local copied=""
        if command -v pbcopy >/dev/null 2>&1; then
            printf '%s' "$push_line" | pbcopy >/dev/null 2>&1 && copied="1" || true
        elif command -v wl-copy >/dev/null 2>&1; then
            printf '%s' "$push_line" | wl-copy >/dev/null 2>&1 && copied="1" || true
        elif command -v xclip >/dev/null 2>&1; then
            printf '%s' "$push_line" | xclip -selection clipboard >/dev/null 2>&1 && copied="1" || true
        elif command -v xsel >/dev/null 2>&1; then
            printf '%s' "$push_line" | xsel --clipboard --input >/dev/null 2>&1 && copied="1" || true
        elif command -v clip >/dev/null 2>&1; then
            printf '%s' "$push_line" | clip >/dev/null 2>&1 && copied="1" || true
        fi
        if [ -n "$copied" ]; then
            printf '%s\n' "  (push command copied to clipboard)"
        fi
    fi

    return 0
}
