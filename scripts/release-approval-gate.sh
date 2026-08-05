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
# Usage:
#   scripts/release-approval-gate.sh [--range <git-range>] [--approve "<note>"]
#
# Exit codes: 0 allowed (no VERSION change, or approved), 1 DENIED,
#             64 usage error, 66 not a git repo.

set -uo pipefail

RANGE=""
APPROVE_NOTE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --range)   RANGE="${2:-}"; shift 2 ;;
        --approve) APPROVE_NOTE="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
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
