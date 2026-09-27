#!/usr/bin/env bash
# Loki 10 engine P4 push child for GitLab (ENGINE.md sections 6, 7 and 13).
#
#   engine10-push-gitlab.sh push-mr <repo-dir> <branch> <title> <body-file> [--draft]
#
# Prints the merge request URL. Holds GitLab credentials, runs no LLM, reads
# no untrusted text beyond argv. The target project comes only from the origin
# P0 pinned before any provider ran (_LOKI_ORIGIN_PINNED=1
# _LOKI_PINNED_ORIGIN=<url>), and that origin must be a literal gitlab.com
# https or ssh URL. _loki_trusted_push refuses non-github.com origins, so this
# mirrors its shape: the branch is fetched into a fresh --template= repo and
# pushed from there, so no agent-repo hook or config runs in the credentialed
# process; glab runs from / with the host fixed to gitlab.com.
set -o pipefail

die() { printf 'engine10-push-gitlab: %s\n' "$*" >&2; exit "${2:-2}"; }

# <url> -> GROUP[/SUBGROUP...]/PROJECT on stdout, or rc 1. Literal gitlab.com
# only: no host alias, no port, no embedded credentials, no odd characters.
_e10_gitlab_project_from_url() {
    local u="${1:-}" lc pre p
    lc="$(printf '%s' "$u" | tr '[:upper:]' '[:lower:]')"
    case "$lc" in
        https://gitlab.com/*) pre="https://gitlab.com/" ;;
        git@gitlab.com:*) pre="git@gitlab.com:" ;;
        ssh://git@gitlab.com/*) pre="ssh://git@gitlab.com/" ;;
        *) return 1 ;;
    esac
    p="${u:${#pre}}"
    p="${p%/}"
    p="${p%.git}"
    case "$p" in
        /* | */ | *//* | */.* | .* | *..* | */-/* | *[!A-Za-z0-9._/-]*) return 1 ;;
        ?*/?*) printf '%s\n' "$p" ;;
        *) return 1 ;;
    esac
}

# Neutral glab: cwd /, no git dir, host pinned so an ambient GITLAB_HOST
# cannot send the token elsewhere.
_e10_glab() {
    (
        cd / || exit 1
        unset GIT_DIR GIT_WORK_TREE GL_HOST GITLAB_API_HOST
        export GITLAB_HOST=gitlab.com
        command glab "$@"
    )
}

[ "${_LOKI_ORIGIN_PINNED:-}" = "1" ] || die "origin not pinned (_LOKI_ORIGIN_PINNED=1 required)"
url="${_LOKI_PINNED_ORIGIN:-}"
proj="$(_e10_gitlab_project_from_url "$url")" \
    || die "pinned origin refused: not a literal gitlab.com https or ssh GROUP/PROJECT URL"

mode="${1:-}"
shift || true
[ "$mode" = "push-mr" ] || die "usage: engine10-push-gitlab.sh push-mr <repo-dir> <branch> <title> <body-file> [--draft]"
[ "$#" -ge 4 ] && [ "$#" -le 5 ] || die "usage: push-mr <repo-dir> <branch> <title> <body-file> [--draft]"
dir="$1" branch="$2" title="$3" body="$4" draft=()
if [ "$#" -eq 5 ]; then
    [ "$5" = "--draft" ] || die "unknown flag: $5"
    draft=(--draft)
fi
[ -f "$body" ] || die "body file not found: $body"
dir="$(cd "$dir" 2>/dev/null && pwd -P)" || die "repo dir not found"
git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "bad branch name"
case "$branch" in
    main | master | HEAD) die "Not pushing branch '$branch': Loki never pushes directly to a default branch." ;;
esac
cur="$(git -C "$dir" config --get remote.origin.url 2>/dev/null)" || cur=""
[ "$cur" = "$url" ] || die "Not pushing branch '$branch': origin changed during the run; Loki does not push to a destination the agent could have chosen."

enc="${proj//\//%2F}"
def="$(_e10_glab api "projects/$enc" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("default_branch") or "")' 2>/dev/null)" || def=""
[ -n "$def" ] || die "Not pushing branch '$branch': could not resolve the default branch of $proj."
[ "$branch" != "$def" ] || die "Not pushing branch '$branch': it is the default branch of $proj."

tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-push-gl.XXXXXX")" || die "mktemp failed" 1
trap 'rm -rf "$tmp"' EXIT
git init -q --template= "$tmp" >/dev/null 2>&1 \
    && git -C "$tmp" fetch -q --no-tags --update-shallow "$dir" "+refs/heads/$branch:refs/heads/$branch" >/dev/null 2>&1 \
    && git -C "$tmp" rev-parse -q --verify "refs/heads/$branch" >/dev/null 2>&1 \
    || die "could not stage branch '$branch' in a fresh repo"
git -C "$tmp" push -q "$url" "refs/heads/$branch:refs/heads/$branch" || die "push failed (rc=$?)"

mr="$(_e10_glab mr list --repo "$proj" --source-branch "$branch" --output json 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0].get("web_url","") if d else "")' 2>/dev/null)" \
    || die "glab mr list failed"
if [ -z "$mr" ]; then
    mr="$(_e10_glab mr create --repo "$proj" --source-branch "$branch" --title "$title" \
        --description "$(cat "$body")" --yes "${draft[@]}" | grep -Eo 'https://gitlab\.com/[^[:space:]]+' | tail -n 1)" \
        || die "glab mr create failed"
    [ -n "$mr" ] || die "glab mr create printed no URL"
fi
printf '%s\n' "$mr"
