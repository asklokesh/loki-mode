#!/usr/bin/env bash
# Loki 10 engine P4 push child (ENGINE.md sections 6 and 7).
#
#   engine10-push.sh push-pr <repo-dir> <branch> <title> <body-file> [--draft] [--base <branch>]
#   engine10-push.sh check-origin   (exit 0 when the pinned origin is acceptable to push-pr, else the refusal; no network)
#   engine10-push.sh comment <pr-number> <body-file>
#   engine10-push.sh issue-comment <issue-ref> <body-file>
#   engine10-push.sh status  <sha> <pending|success|failure|error> <description>
#
# Holds GitHub credentials, runs no LLM, reads no untrusted text. Inputs come
# only from argv and the origin pinned by P0 before any provider ran
# (_LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN=<url>). The target repository is
# always derived from that pin, never from the agent-writable tree.
#
# The push and gh helpers are not copied: this sources exactly the run.sh
# region tests/test-trusted-push-agent-config.sh extracts, by the same awk
# anchors, and fails closed when an anchor is missing.
set -o pipefail

log_warn() { printf 'WARN: %s\n' "$*" >&2; }
log_info() { printf 'INFO: %s\n' "$*" >&2; }
die() { printf 'engine10-push: %s\n' "$*" >&2; exit "${2:-2}"; }

# Capture the pin before sourcing: the region resets both variables to "".
_e10_pinned="${_LOKI_ORIGIN_PINNED:-}"
_e10_origin="${_LOKI_PINNED_ORIGIN:-}"

_e10_run_sh="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)/run.sh"
[ -f "$_e10_run_sh" ] || die "run.sh not found at $_e10_run_sh" 3
_e10_region="$(awk '
    /^_LOKI_WITHHELD_TOKENS=""$/ { on = 1 }
    on { print }
    on && /^_loki_withhold_github_tokens\(\) \{$/ { last = 1 }
    last && /^}$/ { done = 1; exit }
    END { if (!done) exit 3 }
' "$_e10_run_sh")" || die "run.sh trusted-push anchors not found; refusing to push" 3
for _e10_fn in _loki_trusted_push _loki_with_github_tokens _loki_run_neutral _loki_github_repo_from_url; do
    # No pipe into grep -q: under pipefail, grep exiting on its first match
    # SIGPIPEs the still-writing printf (rc 141), which read as "missing"
    # intermittently under CPU load and silently skipped the push.
    [[ $'\n'"$_e10_region"$'\n' == *$'\n'"${_e10_fn}() {"$'\n'* ]] \
        || die "run.sh region lacks ${_e10_fn}; refusing to push" 3
done
eval "$_e10_region" || die "run.sh region failed to load" 3
_LOKI_ORIGIN_PINNED="$_e10_pinned"
_LOKI_PINNED_ORIGIN="$_e10_origin"

[ "$_LOKI_ORIGIN_PINNED" = "1" ] || die "origin not pinned (_LOKI_ORIGIN_PINNED=1 required)"

# E-41: the eval harness (eval/loki10/harness.py) pins origin to a local bare
# repo and scores "PR opened" as a branch landing there. Only an absolute,
# colon-free path whose own git dir is itself a bare repo qualifies; anything
# else (URL, scp host:path, relative, non-bare, a subdirectory) takes the
# GitHub path below and its refusal.
_e10_local_bare() {
    local p="$1" abs
    case "$p" in /*) ;; *) return 1 ;; esac
    case "$p" in *:*) return 1 ;; esac
    abs="$(cd "$p" 2>/dev/null && pwd -P)" || return 1
    [ "$(git -C "$abs" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] || return 1
    [ "$(git -C "$abs" rev-parse --absolute-git-dir 2>/dev/null)" = "$abs" ]
}
_e10_local=""
_e10_git_env="GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT"
# shellcheck disable=SC2086 # word-split list of variable names
if (unset $_e10_git_env; _e10_local_bare "$_LOKI_PINNED_ORIGIN"); then
    _e10_local=1
else
    _e10_repo="$(_loki_github_repo_from_url "$_LOKI_PINNED_ORIGIN")" \
        || die "pinned origin refused: $(_loki_origin_refusal "$_LOKI_PINNED_ORIGIN")"
fi

# Local push: like _loki_trusted_push, the branch is fetched into a fresh
# template-less repo and pushed from there, so the agent repo's config
# (pushInsteadOf, remote.<url>.receivepack) and hooks never apply. The bare
# repo's own receive-side hooks (and its core.hooksPath) DO run: git does not
# pass -c core.hooksPath to the local receive-pack. What protects them is the
# allowlisted env below: they inherit it, so no token, SSH agent or askpass
# reaches them.
_e10_git() {
    env -i PATH="$PATH" HOME=/dev/null TMPDIR="${TMPDIR:-/tmp}" GIT_CONFIG_NOSYSTEM=1 \
        GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null "$@"
}
_e10_local_push() {
    local dir="$1" branch="$2" origin="$_LOKI_PINNED_ORIGIN" def tmp rc=1
    dir="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
    git check-ref-format --branch "$branch" >/dev/null 2>&1 || return 1
    case "$branch" in
        main | master | HEAD)
            log_warn "Not pushing branch '$branch': Loki never pushes directly to a default branch."
            return 2 ;;
    esac
    def="$(_e10_git -C "$origin" symbolic-ref --short HEAD 2>/dev/null)" || def=""
    if [ -z "$def" ] || [ "$branch" = "$def" ]; then
        log_warn "Not pushing branch '$branch': it is (or may be) the default branch of $origin."
        return 2
    fi
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-push.XXXXXX")" || return 1
    if _e10_git init -q --template= "$tmp" >/dev/null 2>&1 \
        && _e10_git -C "$tmp" fetch -q --no-tags --update-shallow "$dir" \
            "+refs/heads/$branch:refs/heads/$branch" >/dev/null 2>&1 \
        && _e10_git -C "$tmp" rev-parse -q --verify "refs/heads/$branch" >/dev/null 2>&1; then
        rc=0
        _e10_git -C "$tmp" push -q "$origin" "refs/heads/$branch:refs/heads/$branch" || rc=$?
    fi
    rm -rf "$tmp"
    return "$rc"
}

_e10_gh() { _loki_with_github_tokens _loki_run_neutral "$_e10_repo" command gh "$@"; }

mode="${1:-}"
shift || true
case "$mode" in
    check-origin)
        # The origin validation above already ran and died on a refusal; reaching here means push-pr would accept it.
        exit 0
        ;;
    push-pr)
        [ "$#" -ge 4 ] && [ "$#" -le 7 ] || die "usage: push-pr <repo-dir> <branch> <title> <body-file> [--draft] [--base <branch>]"
        dir="$1" branch="$2" title="$3" body="$4" draft=() base=()
        shift 4
        # MASS-2: --base stacks the PR on a parent slice's branch; a name git would not accept is refused.
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --draft) draft=(--draft); shift ;;
                --base)
                    [ "$#" -ge 2 ] || die "--base needs a branch"
                    case "$2" in -* | '') die "invalid base branch: $2" ;; esac
                    git check-ref-format --branch "$2" >/dev/null 2>&1 || die "invalid base branch: $2"
                    base=(--base "$2"); shift 2 ;;
                *) die "unknown flag: $1" ;;
            esac
        done
        [ -f "$body" ] || die "body file not found: $body"
        if [ -n "$_e10_local" ]; then
            _e10_local_push "$dir" "$branch" || die "push refused or failed (rc=$?)"
            printf 'local://%s#%s\n' "$_LOKI_PINNED_ORIGIN" "$branch"
            exit 0
        fi
        _loki_trusted_push _loki_with_github_tokens "$dir" "$branch" || die "push refused or failed (rc=$?)"
        url="$(_e10_gh pr list --repo "$_e10_repo" --head "$branch" --state open --json url --jq '.[0].url')" \
            || die "gh pr list failed"
        if [ -z "$url" ] || [ "$url" = "null" ]; then
            url="$(_e10_gh pr create --repo "$_e10_repo" --head "$branch" --title "$title" --body-file "$body" "${draft[@]}" "${base[@]}")" \
                || die "gh pr create failed"
            url="$(printf '%s\n' "$url" | tail -n 1)"
        fi
        printf '%s\n' "$url"
        ;;
    comment)
        [ "$#" -eq 2 ] || die "usage: comment <pr-number> <body-file>"
        case "$1" in '' | *[!0-9]*) die "pr number must be digits" ;; esac
        [ -f "$2" ] || die "body file not found: $2"
        [ -z "$_e10_local" ] || { log_info "local origin: no PR to comment on (no-op)"; exit 0; }
        _e10_gh pr comment "$1" --repo "$_e10_repo" --body-file "$2" || die "gh pr comment failed"
        ;;
    issue-comment)
        # E-67: a FAILED run with no diff (or no remote) has no PR to open; comment on the issue
        # instead so the run's reason is never silently lost. <issue-ref> is owner/repo#N or #N.
        [ "$#" -eq 2 ] || die "usage: issue-comment <issue-ref> <body-file>"
        num="${1##*#}"
        case "$num" in '' | *[!0-9]*) die "cannot extract issue number from: $1" ;; esac
        [ -f "$2" ] || die "body file not found: $2"
        [ -z "$_e10_local" ] || { log_info "local origin: no issue to comment on (no-op)"; exit 0; }
        _e10_gh issue comment "$num" --repo "$_e10_repo" --body-file "$2" || die "gh issue comment failed"
        ;;
    status)
        [ "$#" -eq 3 ] || die "usage: status <sha> <state> <description>"
        [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "sha must be 40 lowercase hex characters"
        case "$2" in pending | success | failure | error) ;; *) die "bad state: $2" ;; esac
        [ -z "$_e10_local" ] || { log_info "local origin: no commit status to set (no-op)"; exit 0; }
        _e10_gh api "repos/$_e10_repo/statuses/$1" -f "state=$2" -f context=loki/deep-verify \
            -f "description=$3" >/dev/null || die "gh api status failed"
        ;;
    *) die "usage: engine10-push.sh push-pr|comment|issue-comment|status ..." ;;
esac
