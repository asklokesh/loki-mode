#!/usr/bin/env bash
# Loki 10 engine P4 push child (ENGINE.md sections 6 and 7).
#
#   engine10-push.sh push-pr <repo-dir> <branch> <title> <body-file> [--draft]
#   engine10-push.sh comment <pr-number> <body-file>
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
    printf '%s\n' "$_e10_region" | grep -q "^${_e10_fn}() {\$" \
        || die "run.sh region lacks ${_e10_fn}; refusing to push" 3
done
eval "$_e10_region" || die "run.sh region failed to load" 3
_LOKI_ORIGIN_PINNED="$_e10_pinned"
_LOKI_PINNED_ORIGIN="$_e10_origin"

[ "$_LOKI_ORIGIN_PINNED" = "1" ] || die "origin not pinned (_LOKI_ORIGIN_PINNED=1 required)"
_e10_repo="$(_loki_github_repo_from_url "$_LOKI_PINNED_ORIGIN")" \
    || die "pinned origin refused: $(_loki_origin_refusal "$_LOKI_PINNED_ORIGIN")"

_e10_gh() { _loki_with_github_tokens _loki_run_neutral "$_e10_repo" command gh "$@"; }

mode="${1:-}"
shift || true
case "$mode" in
    push-pr)
        [ "$#" -ge 4 ] && [ "$#" -le 5 ] || die "usage: push-pr <repo-dir> <branch> <title> <body-file> [--draft]"
        dir="$1" branch="$2" title="$3" body="$4" draft=()
        if [ "$#" -eq 5 ]; then
            [ "$5" = "--draft" ] || die "unknown flag: $5"
            draft=(--draft)
        fi
        [ -f "$body" ] || die "body file not found: $body"
        _loki_trusted_push _loki_with_github_tokens "$dir" "$branch" || die "push refused or failed (rc=$?)"
        url="$(_e10_gh pr list --repo "$_e10_repo" --head "$branch" --state open --json url --jq '.[0].url')" \
            || die "gh pr list failed"
        if [ -z "$url" ] || [ "$url" = "null" ]; then
            url="$(_e10_gh pr create --repo "$_e10_repo" --head "$branch" --title "$title" --body-file "$body" "${draft[@]}")" \
                || die "gh pr create failed"
            url="$(printf '%s\n' "$url" | tail -n 1)"
        fi
        printf '%s\n' "$url"
        ;;
    comment)
        [ "$#" -eq 2 ] || die "usage: comment <pr-number> <body-file>"
        case "$1" in '' | *[!0-9]*) die "pr number must be digits" ;; esac
        [ -f "$2" ] || die "body file not found: $2"
        _e10_gh pr comment "$1" --repo "$_e10_repo" --body-file "$2" || die "gh pr comment failed"
        ;;
    status)
        [ "$#" -eq 3 ] || die "usage: status <sha> <state> <description>"
        [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "sha must be 40 lowercase hex characters"
        case "$2" in pending | success | failure | error) ;; *) die "bad state: $2" ;; esac
        _e10_gh api "repos/$_e10_repo/statuses/$1" -f "state=$2" -f context=loki/deep-verify \
            -f "description=$3" >/dev/null || die "gh api status failed"
        ;;
    *) die "usage: engine10-push.sh push-pr|comment|status ..." ;;
esac
