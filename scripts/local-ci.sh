#!/usr/bin/env bash
# scripts/local-ci.sh - the one pre-push and PR gate. Runs exactly the tests under
# tests/min/ (hermetic, offline, no model calls; bash -n and the Python parse are
# the first of them). Same command locally and in .github/workflows/pr-fast.yml.
#
#   bash scripts/local-ci.sh                     run everything, cheap tests first
#   LOCAL_CI_ONLY=hygiene,pack-contents bash scripts/local-ci.sh    run a subset
#   LOCAL_CI_JOBS=1 bash scripts/local-ci.sh     one test at a time (default 4 at a time)
#
# Needs bun, node, python3, git and npm on PATH. loki-ts/dist is not committed: this
# script installs loki-ts dependencies when missing and builds dist when it is missing
# or older than loki-ts/src, VERSION or the build script (the tests run the bundle). Exit 0 only when
# every selected test passes. There is one tier; LOCAL_CI_TIER is not read.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

TESTS=(syntax hygiene version-consistency release-notes docker-and-zip-sources pack-contents
       cli-entrypoints newcomer-path receipt-roundtrip redaction detect-gates typecheck dist-freshness engine10-e2e-stub scope-and-fix auto-route one-line-goal stacks triage-router
       decompose-and-intake workspace h2h-harness learn-from-runs issue-context outcome-metrics run-safety context-pack host-guard
       providers-supported trigger-server)

selected=("${TESTS[@]}")
if [ -n "${LOCAL_CI_ONLY:-}" ]; then
    selected=()
    IFS=',' read -r -a want <<< "$LOCAL_CI_ONLY"
    for w in "${want[@]}"; do
        if [ -f "tests/min/$w.sh" ]; then selected+=("$w"); else echo "local-ci: no such test: $w" >&2; exit 2; fi
    done
fi

# Build loki-ts/dist once, serially, before any test runs it (parallel tests must not race a build).
if [ ! -f loki-ts/dist/loki.js ] || [ ! -f loki-ts/dist/cockpit.js ] \
   || [ -n "$(find loki-ts/src loki-ts/scripts loki-ts/data VERSION -type f -newer loki-ts/dist/loki.js -print -quit 2>/dev/null)" ]; then
    if [ ! -d loki-ts/node_modules ]; then
        bun install --cwd loki-ts --frozen-lockfile >&2 || { echo "local-ci: bun install failed in loki-ts" >&2; exit 2; }
    fi
    (cd loki-ts && bun run build >&2) || { echo "local-ci: loki-ts build failed" >&2; exit 2; }
fi

out="$(mktemp -d "${TMPDIR:-/tmp}/loki-local-ci.XXXXXX")" || exit 2
pids=()
kill_tree() { # kill_tree <pid>: stop a recorded pid and everything it started
    local c
    for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
    kill -TERM "$1" 2>/dev/null || true
}
cleanup() {
    local p
    for p in ${pids[@]+"${pids[@]}"}; do kill_tree "$p"; done
    case "$out" in */loki-local-ci.*) rm -rf -- "$out" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The tests are hermetic (tests/min/lib.sh: throwaway HOME and temp dir, no model calls), so they run
# LOCAL_CI_JOBS at a time (default 4; 1 = one after another in the order above). Results print in the
# order above as each one finishes; with more than one job the slow tests start first.
JOBS="${LOCAL_CI_JOBS:-4}"
case "$JOBS" in ''|*[!0-9]*|0) echo "local-ci: LOCAL_CI_JOBS must be a positive integer" >&2; exit 2 ;; esac
HEAVY=(run-safety scope-and-fix newcomer-path auto-route engine10-e2e-stub learn-from-runs decompose-and-intake host-guard h2h-harness)

order=()
if [ "$JOBS" -gt 1 ]; then
    for h in "${HEAVY[@]}"; do
        for t in "${selected[@]}"; do [ "$t" = "$h" ] && order+=("$t"); done
    done
fi
for t in "${selected[@]}"; do
    case " ${order[*]-} " in *" $t "*) ;; *) order+=("$t") ;; esac
done

run_one() { # run_one <test>: log to $out/<test>.log, then record seconds and exit code (the rc file marks completion)
    local t="$1" start rc
    start="$(date +%s)"
    bash "tests/min/$t.sh" >"$out/$t.log" 2>&1
    rc=$?
    echo "$(( $(date +%s) - start ))" >"$out/$t.sec"
    echo "$rc" >"$out/$t.rc.tmp" && mv "$out/$t.rc.tmp" "$out/$t.rc"
}

failed=()
next=0      # next entry of "selected" to print
started=0   # next entry of "order" to start
report_ready() {
    local t sec
    while [ "$next" -lt "${#selected[@]}" ]; do
        t="${selected[$next]}"
        [ -f "$out/$t.rc" ] || break
        sec="$(cat "$out/$t.sec")"
        if [ "$(cat "$out/$t.rc")" = 0 ]; then
            printf 'PASS  %-24s %3ss\n' "$t" "$sec"
        else
            printf 'FAIL  %-24s %3ss\n' "$t" "$sec"
            failed+=("$t")
            sed 's/^/    | /' "$out/$t.log"
        fi
        next=$((next + 1))
    done
}
while [ "$next" -lt "${#selected[@]}" ]; do
    while [ "$started" -lt "${#order[@]}" ] && [ "$(jobs -rp | wc -l | tr -d ' ')" -lt "$JOBS" ]; do
        run_one "${order[$started]}" &
        pids+=("$!")
        started=$((started + 1))
    done
    report_ready
    [ "$next" -lt "${#selected[@]}" ] && sleep 0.2
done
wait

if [ "${#failed[@]}" -gt 0 ]; then
    echo "local-ci: FAILED: ${failed[*]}" >&2
    exit 1
fi
echo "local-ci: all ${#selected[@]} tests passed"
