#!/usr/bin/env bash
# nightly-flake-tracker.sh - flag tests that flip pass/fail on an identical SHA
# across saved Nightly job logs.
#
# Usage: nightly-flake-tracker.sh SHA:LABEL:LOGFILE [SHA:LABEL:LOGFILE ...]
#   LABEL names the run/job the log came from (for example 37790534786-bun).
#   Fetch logs with: gh api repos/OWNER/REPO/actions/jobs/JOB_ID/logs > file
#        nightly-flake-tracker.sh --gh-run RUN_ID
#   --gh-run fetches the "Bun tests on ..." job logs of one Actions run with gh
#   (repo from GITHUB_REPOSITORY) and tracks them at each job's head SHA.
#   bun=latest (experimental) legs get a "-drift" label suffix so a flip there
#   reads as upstream drift.
#
# Recognized result lines (timestamp and ANSI stripped):
#   bun test:       "(pass) name [1.2ms]" / "(fail) name [1.2ms]"
#   shell runner:   "<tick> Name PASSED" / "<cross> Name FAILED"
# Output, per test seen both passing and failing on one SHA:
#   FLIP <sha7> <test> pass=<labels> fail=<labels>
#   BOARD: <slice line>
# A test failing in every observation of a SHA is reported as STABLE-FAIL
# (a real defect, not a flake). Exit 0 = no flips, 1 = flips, 2 = usage error.
set -uo pipefail

usage() {
    echo "usage: $0 SHA:LABEL:LOGFILE [...] | --gh-run RUN_ID" >&2
    exit 2
}

if [ "${1:-}" = "--gh-run" ]; then
    run_id="${2:-}"
    case "$run_id" in '' | *[!0-9]*) usage ;; esac
    [ "$#" -eq 2 ] || usage
    if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
        echo "--gh-run needs gh and jq" >&2
        exit 2
    fi
    repo="${GITHUB_REPOSITORY:-}"
    [ -n "$repo" ] || repo='{owner}/{repo}'
    gh_logdir="$(mktemp -d "${TMPDIR:-/tmp}/nightly-flake-gh.XXXXXX")" || exit 2
    trap 'rm -rf -- "$gh_logdir"' EXIT
    jobs_json="$(gh api --paginate "repos/$repo/actions/runs/$run_id/jobs?per_page=100")" || {
        echo "gh api jobs failed for run $run_id" >&2
        exit 2
    }
    set --
    while IFS=$'\t' read -r jid jname jsha; do
        [ -n "$jid" ] || continue
        label="$jid-$(printf '%s' "$jname" | sed -e 's/^Bun tests on //' -e 's/ (nightly)$//' -e 's/[^A-Za-z0-9.=-]/_/g')"
        case "$jname" in *bun=latest*) label="$label-drift" ;; esac
        gh api "repos/$repo/actions/jobs/$jid/logs" >"$gh_logdir/$jid.log" 2>/dev/null || continue
        set -- "$@" "$jsha:$label:$gh_logdir/$jid.log"
    done < <(printf '%s' "$jobs_json" | jq -r '.jobs[]? | select(.name | startswith("Bun tests on")) | [.id, .name, .head_sha] | @tsv')
    if [ "$#" -lt 1 ]; then
        echo "no Bun test job logs found for run $run_id" >&2
        exit 0
    fi
fi

if [ "$#" -lt 1 ]; then
    usage
fi

for arg in "$@"; do
    sha="${arg%%:*}"
    rest="${arg#*:}"
    label="${rest%%:*}"
    log="${rest#*:}"
    if [ -z "$sha" ] || [ -z "$label" ] || [ ! -f "$log" ]; then
        echo "bad argument or missing log: $arg" >&2
        exit 2
    fi
done

extract() {
    local sha="$1" label="$2" log="$3"
    sed -e $'s/\x1b\\[[0-9;]*m//g' -e 's/\r$//' "$log" |
        awk -v sha="$sha" -v label="$label" '
        {
            line = $0
            sub(/^\357\273\277/, "", line)
            sub(/^[0-9T:.-]+Z /, "", line)
            if (match(line, /^\((pass|fail)\) /)) {
                st = substr(line, 2, 4)
                name = substr(line, RLENGTH + 1)
                sub(/ \[[0-9.]+(ms|s)\]$/, "", name)
                print sha "\t" label "\t" st "\t" name
            } else if (line ~ /^[^A-Za-z0-9(\[ ]+ .+ (PASSED|FAILED)$/) {
                st = (line ~ /PASSED$/) ? "pass" : "fail"
                name = line
                sub(/^[^ ]+ /, "", name)
                sub(/ (PASSED|FAILED)$/, "", name)
                print sha "\t" label "\t" st "\t" name
            }
        }'
}

all=""
for arg in "$@"; do
    sha="${arg%%:*}"
    rest="${arg#*:}"
    label="${rest%%:*}"
    log="${rest#*:}"
    all="${all}$(extract "$sha" "$label" "$log")"$'\n'
done

report="$(printf '%s\n' "$all" | awk -F'\t' '
    NF == 4 {
        k = $1 SUBSEP $4
        seen[k] = 1
        if ($3 == "pass") { if (index(P[k], "," $2 ",") == 0) P[k] = P[k] "," $2 "," }
        else { if (index(F[k], "," $2 ",") == 0) F[k] = F[k] "," $2 "," }
    }
    END {
        for (k in seen) {
            split(k, a, SUBSEP)
            p = P[k]; f = F[k]
            gsub(/,,/, ",", p); gsub(/,,/, ",", f)
            gsub(/^,|,$/, "", p); gsub(/^,|,$/, "", f)
            if (p != "" && f != "") {
                printf "FLIP %s %s pass=%s fail=%s\n", substr(a[1], 1, 7), a[2], p, f
                printf "BOARD: | FLAKE | fix flaky test \"%s\" (flipped on %s: pass in %s, fail in %s) | wait on a condition, no retries |\n", a[2], substr(a[1], 1, 7), p, f
            } else if (f != "") {
                printf "STABLE-FAIL %s %s fail=%s\n", substr(a[1], 1, 7), a[2], f
            }
        }
    }' | sort)"

[ -n "$report" ] && printf '%s\n' "$report"
case "$report" in
    *FLIP\ *) exit 1 ;;
esac
exit 0
