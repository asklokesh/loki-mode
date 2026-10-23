#!/usr/bin/env bash
# DEFAULT-DENY release interlock: a VERSION-changing push must not publish
# without an explicit, recorded approval.
#
# THIS CHECK IS BYPASSABLE, and saying so is the point.
#
# It is a script an operator runs; nothing forces it. Not running it is a
# bypass, and so is `git push` from any other shell. It is NOT a control on
# the publishing path -- it is an operator-side check that makes the exposure
# visible and refuses by default when it IS run.
#
# The only non-bypassable controls are founder-gated and deliberately NOT
# applied here, because both change the publishing path or repository
# settings:
#   - an `environment:` key on the publish jobs in release.yml, which makes
#     GitHub require a reviewer before those jobs start
#   - a branch ruleset on main
#
# Until one of those exists, treat a green run of this script as "the operator
# checked", never as "publishing is gated".
#
# THE EXPOSURE THIS CLOSES, measured on this repository today:
#
#   .github/workflows/release.yml triggers on
#       push: { paths: ['VERSION'], branches: [main] }
#   and that workflow runs `gh release create`, `npm publish --access public`
#   (twice) and a Docker push.
#
#   It has NO `environment:` key, so GitHub's own required-reviewer approval
#   mechanism is not in play, and
#       gh api repos/asklokesh/loki-mode/branches/main/protection
#   returns 404 "Branch not protected".
#
#   Net effect: one commit that edits VERSION, reaching main by any route,
#   publishes to npm and Docker Hub with no human in the loop. Not a
#   hypothetical -- that is the current configuration.
#
# WHY A LOCAL GATE AND NOT A WORKFLOW EDIT. Editing release.yml to add an
# `environment:` gate is the right permanent fix, but it is a change to the
# publishing path itself and is founder-gated. This runs BEFORE a push, is
# default-deny, and needs no repository settings change to take effect. It is
# the interlock that can exist today; the workflow/ruleset change is the one
# that needs approval, and both are named in the report rather than conflated.
#
# WHAT IT CHECKS. Given a range (default: what a push would send), it fails
# when VERSION is modified unless an approval token is present. Approval is
# explicit and recorded, never inferred:
#
#   LOKI_RELEASE_APPROVED=1                 in the environment, or
#   --approve "<who/why>"                   recorded to the audit log
#
# A warning would not do. A prompt that can be ignored is not an interlock,
# which is the same reasoning behind the benchmark spend interlock.
#
# SHIPPED-SHA CHECK (runs first, on every invocation, no bypass). Every commit
# in the range must be approved by SHA, or the range is DENIED (exit 1):
#   1. Named: an approvals line (default docs/v10/BOARD.md, --approvals FILE)
#      matching `<TL|HIGH|CTO|tl-x|rev-x>[ rN] APPROVE <sha 9-40 hex>` names it.
#   2. Rebase-equal: its `git patch-id --stable` equals that of an approved SHA.
#      A rebase that changed content has a new patch-id and needs a new approval.
#   3. Hold: the approving row's slice id (first column) is held when any row
#      with that id has status blocked or parked, or notes containing HOLD.
#      A held slice denies even an approved commit. Holds match by slice id.
#   4. Exempt only: a merge with an empty `git diff-tree --cc`, and a
#      `release: vX.Y.Z` commit whose files are all in release.sh
#      RELEASE_COMMIT_FILES (or loki-ts/dist/).
# LOKI_RELEASE_APPROVED and --approve cover only the VERSION check below.
#
# Usage:
#   scripts/release-approval-gate.sh [--range <git-range>] [--approvals FILE]
#                                    [--approve "<note>"]
#
# Exit codes: 0 allowed (no VERSION change, or approved), 1 DENIED,
#             64 usage error, 66 not a git repo.

set -uo pipefail

RANGE=""
APPROVE_NOTE=""
APPROVALS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --range)   RANGE="${2:-}"; shift 2 ;;
        --approve) APPROVE_NOTE="${2:-}"; shift 2 ;;
        --approvals) APPROVALS="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,56p' "$0"; exit 0 ;;
        *) printf 'release-approval-gate: unknown argument: %s\n' "$1" >&2; exit 64 ;;
    esac
done

git rev-parse --git-dir >/dev/null 2>&1 || {
    printf 'release-approval-gate: not a git repository\n' >&2; exit 66; }

AUDIT="${LOKI_RELEASE_AUDIT:-$HOME/loki-ci-logs/release-approvals.log}"

# Default range: commits this branch would push to its upstream, else vs main.
if [ -z "$RANGE" ]; then
    if up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" \
       && [ -n "$up" ]; then
        RANGE="$up..HEAD"
    else
        RANGE="origin/main..HEAD"
    fi
fi

# ---- shipped-SHA check ------------------------------------------------------
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TOP="$(git rev-parse --show-toplevel)"
[ -n "$APPROVALS" ] || APPROVALS="$TOP/docs/v10/BOARD.md"
APPROVAL_RE='(TL|HIGH|CTO|tl-[0-9a-z]+|rev-[0-9a-z]+)( r[0-9]+)? APPROVE [0-9a-f]{9,40}'
EXEMPT_FILES="$(sed -n 's/^RELEASE_COMMIT_FILES="\(.*\)"$/\1/p' "$SELF_DIR/release.sh" 2>/dev/null)"
TAB="$(printf '\t')"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || { printf 'release-approval-gate: no temp dir\n' >&2; exit 70; }
cleanup_work() { case "$WORK" in */loki-run.*) rm -rf -- "$WORK" ;; esac; }
: > "$WORK/approved.tsv"; : > "$WORK/held.txt"; : > "$WORK/denied.txt"

patch_id_of() {
    git diff-tree -p --root "$1" 2>/dev/null | git patch-id --stable 2>/dev/null | cut -d' ' -f1
}

if [ -f "$APPROVALS" ]; then
    # Held slice ids: any row with status blocked/parked, or notes with HOLD.
    awk -F'|' '/^\|/ {
        id=$2; gsub(/^ +| +$/, "", id); st=$7; gsub(/^ +| +$/, "", st); sub(/[@ ].*/, "", st)
        notes=""; for (i=8; i<=NF; i++) notes = notes " " $i
        if (id != "" && (st == "blocked" || st == "parked" || notes ~ /(^|[^A-Za-z])HOLD([^A-Za-z]|$)/)) print id
    }' "$APPROVALS" | sort -u > "$WORK/held.txt"
    grep -E "$APPROVAL_RE" "$APPROVALS" > "$WORK/approval-lines.txt" || true
    while IFS= read -r aline; do
        aslice=""
        case "$aline" in
            '|'*) aslice="$(printf '%s\n' "$aline" | awk -F'|' '{ id=$2; gsub(/^ +| +$/, "", id); print id }')" ;;
        esac
        for tok in $(printf '%s\n' "$aline" | grep -oE "$APPROVAL_RE" | awk '{print $NF}'); do
            full="$(git rev-parse --verify -q "${tok}^{commit}" 2>/dev/null || true)"
            pid=""
            [ -n "$full" ] && pid="$(patch_id_of "$full")"
            printf '%s\t%s\t%s\t%s\n' "$tok" "$full" "$aslice" "$pid" >> "$WORK/approved.tsv"
        done
    done < "$WORK/approval-lines.txt"
fi

# A `release: vX.Y.Z` commit is exempt only when every file it touches is one
# the release script stages (RELEASE_COMMIT_FILES, or the rebuilt dist).
is_release_exempt() {
    local sha="$1" subj f
    subj="$(git log -1 --format=%s "$sha")"
    printf '%s\n' "$subj" | grep -qE '^release: v[0-9]+\.[0-9]+\.[0-9]+$' || return 1
    [ -n "$EXEMPT_FILES" ] || return 1
    for f in $(git diff-tree --no-commit-id --name-only -r --root "$sha"); do
        case " $EXEMPT_FILES " in *" $f "*) continue ;; esac
        case "$f" in loki-ts/dist/*) continue ;; esac
        return 1
    done
    return 0
}

shipped_count=0
for sha in $(git rev-list --reverse "$RANGE" 2>/dev/null); do
    shipped_count=$((shipped_count + 1))
    parents="$(git rev-list --parents -n 1 "$sha" | wc -w | tr -d ' ')"
    if [ "$parents" -gt 2 ] && [ -z "$(git diff-tree --cc --no-commit-id "$sha" 2>/dev/null)" ]; then
        continue
    fi
    if is_release_exempt "$sha"; then continue; fi

    matched_slice=""; matched=0
    while IFS="$TAB" read -r tok full aslice pid; do
        [ -n "$tok" ] || continue
        case "$sha" in "$tok"*) matched=1; matched_slice="$aslice"; break ;; esac
    done < "$WORK/approved.tsv"
    if [ "$matched" = 0 ] && [ "$parents" -le 2 ]; then
        mine="$(patch_id_of "$sha")"
        if [ -n "$mine" ]; then
            while IFS="$TAB" read -r tok full aslice pid; do
                [ -n "$pid" ] || continue
                if [ "$pid" = "$mine" ]; then matched=1; matched_slice="$aslice"; break; fi
            done < "$WORK/approved.tsv"
        fi
    fi

    short="$(git rev-parse --short=9 "$sha")"
    subj="$(git log -1 --format=%s "$sha")"
    if [ "$matched" = 1 ]; then
        if [ -n "$matched_slice" ] && grep -qxF -- "$matched_slice" "$WORK/held.txt"; then
            printf '  %s %s: hold on %s\n' "$short" "$subj" "$matched_slice" >> "$WORK/denied.txt"
        fi
        continue
    fi
    # Not approved. "Changed content" when an approved commit shares its author
    # and author time (or subject): the same change, rebased with edits.
    reason="unnamed"
    my_at="$(git log -1 --format='%at %ae' "$sha")"
    while IFS="$TAB" read -r tok full aslice pid; do
        [ -n "$full" ] || continue
        if [ "$(git log -1 --format='%at %ae' "$full")" = "$my_at" ] \
           || [ "$(git log -1 --format=%s "$full")" = "$subj" ]; then
            reason="rebase changed content (no patch-id match)"; break
        fi
    done < "$WORK/approved.tsv"
    printf '  %s %s: %s\n' "$short" "$subj" "$reason" >> "$WORK/denied.txt"
done

if [ -s "$WORK/denied.txt" ]; then
    printf 'DENIED: %s commit(s) in %s are not approved by SHA (approvals: %s)\n' \
        "$(wc -l < "$WORK/denied.txt" | tr -d ' ')" "$RANGE" "$APPROVALS"
    cat "$WORK/denied.txt"
    printf '  LOKI_RELEASE_APPROVED and --approve do not cover this check.\n'
    cleanup_work
    exit 1
fi
cleanup_work
printf 'shipped-SHA check: %s commit(s) in %s named, rebase-equal or exempt\n' "$shipped_count" "$RANGE"

# Does anything in the range touch VERSION? That is precisely the release
# workflow's own trigger path, so the gate keys on the same signal rather than
# on a second definition that could drift from it.
changed="$(git diff --name-only "$RANGE" 2>/dev/null | grep -x 'VERSION' || true)"

if [ -z "$changed" ]; then
    printf 'ALLOWED: no VERSION change in %s -- release.yml would not trigger\n' "$RANGE"
    exit 0
fi

# From here on VERSION IS changing, so a push to main WOULD publish.
old="$(git show "$(printf '%s' "$RANGE" | sed 's/\.\..*//'):VERSION" 2>/dev/null | tr -d '[:space:]')"
new="$(git show HEAD:VERSION 2>/dev/null | tr -d '[:space:]')"

approved=0
reason=""
if [ "${LOKI_RELEASE_APPROVED:-}" = "1" ]; then
    approved=1; reason="LOKI_RELEASE_APPROVED=1"
fi
if [ -n "$APPROVE_NOTE" ]; then
    approved=1; reason="--approve ${APPROVE_NOTE}"
fi

if [ "$approved" != "1" ]; then
    printf 'DENIED: VERSION changes in %s (%s -> %s)\n' "$RANGE" "${old:-unknown}" "${new:-unknown}"
    printf '  .github/workflows/release.yml triggers on a VERSION-path push to\n'
    printf '  main and runs `gh release create`, `npm publish` and a Docker push.\n'
    printf '  There is no `environment:` approval gate in that workflow, and\n'
    printf '  main has no branch protection, so nothing else would stop it.\n'
    printf '\n'
    printf '  This push would PUBLISH. Approve explicitly to proceed:\n'
    printf '    LOKI_RELEASE_APPROVED=1 %s\n' "$0"
    printf '    %s --approve "founder: shipping vX.Y.Z"\n' "$0"
    exit 1
fi

mkdir -p "$(dirname "$AUDIT")" 2>/dev/null || true
printf '%s\tAPPROVED\t%s -> %s\trange=%s\treason=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "${old:-unknown}" "${new:-unknown}" \
    "$RANGE" "$reason" >> "$AUDIT" 2>/dev/null || true

printf 'ALLOWED: VERSION %s -> %s, approved (%s)\n' "${old:-unknown}" "${new:-unknown}" "$reason"
printf '  recorded to %s\n' "$AUDIT"
exit 0
