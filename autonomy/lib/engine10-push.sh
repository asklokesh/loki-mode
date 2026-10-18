#!/usr/bin/env bash
# Loki 10 engine P4 push child (ENGINE.md sections 6 and 7).
#
#   engine10-push.sh push-pr <repo-dir> <branch> <title> <body-file> [--draft] [--base <branch>]
#   engine10-push.sh pr-ready <repo-dir> <branch> <body-file> <pr-url>   (reused open PR: replace its body, then mark it ready; <pr-url> must be the pinned-owner PR)
#   engine10-push.sh check-origin  (exit 0 when the pinned origin is acceptable to push-pr, else the refusal; no network)
#   engine10-push.sh comment <pr-number> <body-file>
#   engine10-push.sh issue-comment [--update] <issue-ref> <body-file>
#   engine10-push.sh status  <sha> <pending|success|failure|error> <description>
#
# Fork mode: when gh reports the authenticated user cannot push to the pinned
# repo (permissions.push false), push-pr pushes to that user's fork (created
# if missing, verified as a fork of the pinned repo owned by that user) and
# opens the PR upstream from <user>:<branch>. A draft run in fork mode pushes
# to the fork only and exits 4: Loki does not open draft PRs on a repository
# the user cannot push to. issue-comment (status and backstop comments) is a
# no-op there for the same reason; a receipt comment on the user's own PR is
# still posted. LOKI_PR_FORK=0 turns fork mode off (the direct push runs and
# fails as before). No token is needed beyond the user's gh/git login.
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
    # RECOVERY: remote already at the local commit means a prior attempt landed; push nothing.
    local want have
    want="$(_e10_git -C "$dir" rev-parse -q --verify "refs/heads/$branch" 2>/dev/null)" || want=""
    have="$(_e10_git ls-remote "$origin" "refs/heads/$branch" 2>/dev/null | awk '{print $1; exit}')" || have=""
    if [ -n "$want" ] && [ "$want" = "$have" ]; then
        log_info "push skipped: remote already has $branch at ${want:0:12}"
        return 0
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

# The one open-PR lookup for push-pr reuse and pr-ready. gh cannot filter --head by owner, so a stranger's fork PR with the
# same branch name would match; select only a same-repo PR from the pinned owner. Prints the URL, or nothing.
_e10_find_pr() {
    local owner="${_e10_repo%%/*}"
    case "$owner" in '' | *[!A-Za-z0-9_.-]*) return 1 ;; esac
    _e10_gh pr list --repo "$_e10_repo" --head "$1" --state open \
        --json url,isCrossRepository,headRepositoryOwner,headRefName,state \
        --jq "[.[] | select(.isCrossRepository == false and .state == \"OPEN\" and (.headRepositoryOwner.login | ascii_downcase) == \"$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')\")] | .[0].url // empty"
}

# Fork mode probe. Prints true, false, or nothing (unknown: gh failed or did not say). Only a literal false means no push
# access; anything else keeps the direct path (fail open, so a gh hiccup never reroutes a push the user could make).
_e10_can_push() { _e10_gh api "repos/$_e10_repo" --jq '.permissions.push' 2>/dev/null | head -n 1; }
_e10_fork_off() { [ "${LOKI_PR_FORK:-}" = "0" ]; }
# Creates or finds the gh user's fork of the pinned repo; prints OWNER/REPO only after gh confirms it is a fork of
# that repo owned by that user. A fork can take a few seconds to appear after the create call.
_e10_fork() {
    local me="$1" fork="" info i
    fork="$(_e10_gh api -X POST "repos/$_e10_repo/forks" --jq .full_name 2>/dev/null | head -n 1)" || fork=""
    [[ "$fork" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    for i in 1 2 3 4 5 6; do
        info="$(_e10_gh api "repos/$fork" --jq '[(.fork|tostring), (.parent.full_name // ""), .owner.login] | join(" ")' 2>/dev/null)" || info=""
        if [ -n "$info" ]; then
            [ "$(printf '%s' "$info" | tr '[:upper:]' '[:lower:]')" = "$(printf 'true %s %s' "$_e10_repo" "$me" | tr '[:upper:]' '[:lower:]')" ] || return 1
            printf '%s\n' "$fork"
            return 0
        fi
        [ "$i" -lt 6 ] && sleep 2
    done
    return 3 # the fork exists by name but GitHub has not served it yet
}
# Fork-mode twin of _e10_find_pr: the open cross-repo PR whose head is <me>:<branch> (--head matches the branch name
# only; the jq owner filter is what pins it to <me>).
_e10_find_fork_pr() {
    local me="$1"
    case "$me" in '' | *[!A-Za-z0-9_.-]*) return 1 ;; esac
    _e10_gh pr list --repo "$_e10_repo" --head "$2" --state open \
        --json url,isCrossRepository,headRepositoryOwner,headRefName,state \
        --jq "[.[] | select(.isCrossRepository == true and .state == \"OPEN\" and (.headRepositoryOwner.login | ascii_downcase) == \"$(printf '%s' "$me" | tr '[:upper:]' '[:lower:]')\")] | .[0].url // empty"
}

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
        if ! _e10_fork_off && [ "$(_e10_can_push)" = "false" ]; then
            # A stacked parent published in fork mode lives on the fork, not upstream, so an upstream base would not exist.
            [ "${#base[@]}" -eq 0 ] || die "no push access to $_e10_repo: a stacked PR (--base) needs push access there; rerun without LOKI_PR_BASE"
            _e10_me="$(_e10_gh api user --jq .login 2>/dev/null)" || _e10_me=""
            [[ "$_e10_me" =~ ^[A-Za-z0-9_.-]+$ ]] || die "no push access to $_e10_repo and the gh user could not be resolved for a fork; run gh auth login"
            log_info "no push access to $_e10_repo: creating or reusing the fork under $_e10_me (LOKI_PR_FORK=0 turns this off)"
            _e10_fork_repo="$(_e10_fork "$_e10_me")" || { [ "$?" -eq 3 ] && die "no push access to $_e10_repo: the fork under $_e10_me is still being created on GitHub; rerun to push once it exists"
                die "no push access to $_e10_repo and its fork under $_e10_me could not be created or verified"; }
            log_info "no push access to $_e10_repo: pushing to the fork $_e10_fork_repo"
            _loki_trusted_push _loki_with_github_tokens "$dir" "$branch" "$_e10_fork_repo" || die "push to fork $_e10_fork_repo refused or failed (rc=$?)"
            if [ "${#draft[@]}" -gt 0 ]; then
                printf 'fork-only: pushed %s to %s; no draft PR is opened on %s, which you cannot push to. Open one yourself: gh pr create --repo %s --head %s:%s\n' \
                    "$branch" "$_e10_fork_repo" "$_e10_repo" "$_e10_repo" "$_e10_me" "$branch" >&2
                exit 4
            fi
            url="$(_e10_find_fork_pr "$_e10_me" "$branch")" || die "gh pr list failed"
            _e10_pr_state=reused
            if [ -z "$url" ]; then
                _e10_pr_state=created
                url="$(_e10_gh pr create --repo "$_e10_repo" --head "$_e10_me:$branch" --title "$title" --body-file "$body" "${base[@]}")" \
                    || die "gh pr create failed"
                url="$(printf '%s\n' "$url" | tail -n 1)"
            fi
            printf '%s\n' "$_e10_pr_state"
            printf '%s\n' "$url"
            exit 0
        fi
        # RECOVERY: a resumed publish skips the push when the remote branch is already at the local commit.
        _e10_want="$(_e10_git -C "$dir" rev-parse -q --verify "refs/heads/$branch" 2>/dev/null)" || _e10_want=""
        _e10_have=""
        case "$branch" in main | master | HEAD) ;; *)
            _e10_have="$(_e10_gh api "repos/$_e10_repo/git/ref/heads/$branch" --jq .object.sha 2>/dev/null)" || _e10_have="" ;;
        esac
        if [ -n "$_e10_want" ] && [ "$_e10_want" = "$_e10_have" ]; then
            log_info "push skipped: remote already has $branch at ${_e10_want:0:12}"
        else
            _loki_trusted_push _loki_with_github_tokens "$dir" "$branch" || die "push refused or failed (rc=$?)"
        fi
        url="$(_e10_find_pr "$branch")" || die "gh pr list failed"
        _e10_pr_state=reused
        if [ -z "$url" ]; then
            _e10_pr_state=created
            url="$(_e10_gh pr create --repo "$_e10_repo" --head "$branch" --title "$title" --body-file "$body" "${draft[@]}" "${base[@]}")" \
                || die "gh pr create failed"
            url="$(printf '%s\n' "$url" | tail -n 1)"
        fi
        printf '%s\n' "$_e10_pr_state"  # marker line before the URL: reused (open PR found) or created
        printf '%s\n' "$url"
        ;;
    pr-ready)
        # M-21 N3: a reused wave PR whose units are all PROVEN keeps its old draft state and body; fix both, same pinned origin and tokens as push-pr.
        [ "$#" -eq 4 ] || die "usage: pr-ready <repo-dir> <branch> <body-file> <pr-url>"
        branch="$2" body="$3" want_url="$4"
        [ -f "$body" ] || die "body file not found: $body"
        git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "invalid branch: $branch"
        case "$branch" in main | master | HEAD) die "refusing to edit a PR for default branch: $branch" ;; esac
        [ -z "$_e10_local" ] || { log_info "local origin: no PR to mark ready (no-op)"; exit 0; }
        url="$(_e10_find_pr "$branch")" || die "gh pr list failed"
        [ -n "$url" ] || die "no open PR from $_e10_repo for branch: $branch"
        [ "$url" = "$want_url" ] || die "refusing: PR $want_url is not the pinned-owner PR for $branch ($url)"
        _e10_gh pr edit "$url" --repo "$_e10_repo" --body-file "$body" >/dev/null || die "gh pr edit failed"
        _e10_gh pr ready "$url" --repo "$_e10_repo" >/dev/null || die "gh pr ready failed"
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
        # --update: the status projector. One comment carrying the marker below is edited in place (created when absent),
        # so an issue shows live run state without a new comment per event. Only a comment written by the authenticated
        # gh user counts, and the body file must carry the marker (it is built by the supervisor, never from task text).
        # The PR receipt comment (<!-- loki-receipt -->) uses the same upsert: a PR number is an issue number to the API.
        _e10_upd=""
        [ "${1:-}" != "--update" ] || { _e10_upd=1; shift; }
        [ "$#" -eq 2 ] || die "usage: issue-comment [--update] <issue-ref> <body-file>"
        num="${1##*#}"
        case "$num" in '' | *[!0-9]*) die "cannot extract issue number from: $1" ;; esac
        [ -f "$2" ] || die "body file not found: $2"
        [ -z "$_e10_local" ] || { log_info "local origin: no issue to comment on (no-op)"; exit 0; }
        # Status and backstop comments are for a repo the user maintains; on one they cannot push to they would land on
        # someone else's issue. The receipt comment rides the user's own PR and is still posted.
        # The receipt body starts with its marker (receipt_surface.ts); only that first line exempts a comment, so issue
        # text quoting the marker inside a status body cannot. Unlike push-pr this fails closed: a status or backstop
        # comment is posted only when gh confirms push access, since a wrong guess is a public comment on someone's issue.
        if [ "$(head -n 1 -- "$2")" != '<!-- loki-receipt -->' ] && [ "$(_e10_can_push)" != "true" ]; then
            log_info "push access to $_e10_repo not confirmed: not commenting on its issue $num"
            exit 0
        fi
        if [ -n "$_e10_upd" ]; then
            _e10_marker=""
            for _e10_m in '<!-- loki-status -->' '<!-- loki-receipt -->'; do
                if grep -qF -- "$_e10_m" "$2"; then _e10_marker="$_e10_m"; break; fi
            done
            [ -n "$_e10_marker" ] || die "status body must carry <!-- loki-status --> or <!-- loki-receipt -->"
            _e10_me="$(_e10_gh api user --jq .login 2>/dev/null)" || _e10_me=""
            _e10_cid=""
            # A receipt upsert never posts on a failed lookup: that would stack a duplicate and still report success.
            if [ -z "$_e10_me" ] && [ "$_e10_marker" = '<!-- loki-receipt -->' ]; then die "cannot resolve the gh user for the receipt comment lookup"; fi
            if [ -n "$_e10_me" ]; then
                if _e10_ids="$(_e10_gh api "repos/$_e10_repo/issues/$num/comments" --paginate \
                    --jq ".[] | select(.user.login == \"$_e10_me\") | select(.body | contains(\"$_e10_marker\")) | .id" 2>/dev/null)"; then
                    _e10_cid="$(printf '%s\n' "$_e10_ids" | head -n 1)"
                elif [ "$_e10_marker" = '<!-- loki-receipt -->' ]; then
                    die "receipt comment lookup failed"
                fi
            fi
            case "$_e10_cid" in
                '')
                    # A PR number is not an issue to `gh issue comment`; the receipt marker only ever rides a PR.
                    if [ "$_e10_marker" = '<!-- loki-receipt -->' ]; then
                        _e10_gh pr comment "$num" --repo "$_e10_repo" --body-file "$2" || die "gh pr comment failed"
                    else
                        _e10_gh issue comment "$num" --repo "$_e10_repo" --body-file "$2" || die "gh issue comment failed"
                    fi
                    ;;
                *[!0-9]*) die "unexpected comment id" ;;
                *) _e10_gh api -X PATCH "repos/$_e10_repo/issues/comments/$_e10_cid" -F "body=@$2" >/dev/null || die "gh api comment update failed" ;;
            esac
            exit 0
        fi
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
    *) die "usage: engine10-push.sh push-pr|pr-ready|comment|issue-comment|status ..." ;;
esac
