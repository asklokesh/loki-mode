#!/usr/bin/env bash
# scripts/local-ci.sh - the one pre-push and PR gate. Runs exactly the tests under
# tests/min/ (hermetic, offline, no model calls; bash -n and the Python parse are
# the first of them). Same command locally and in .github/workflows/pr-fast.yml.
#
#   bash scripts/local-ci.sh                     run everything, cheap tests first
#   LOCAL_CI_ONLY=hygiene,pack-contents bash scripts/local-ci.sh    run a subset
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
trap 'case "$out" in */loki-local-ci.*) rm -rf -- "$out" ;; esac' EXIT

failed=()
for t in "${selected[@]}"; do
    start="$(date +%s)"
    if bash "tests/min/$t.sh" >"$out/$t.log" 2>&1; then
        printf 'PASS  %-24s %3ss\n' "$t" "$(( $(date +%s) - start ))"
    else
        printf 'FAIL  %-24s %3ss\n' "$t" "$(( $(date +%s) - start ))"
        failed+=("$t")
        sed 's/^/    | /' "$out/$t.log"
    fi
done

if [ "${#failed[@]}" -gt 0 ]; then
    echo "local-ci: FAILED: ${failed[*]}" >&2
    exit 1
fi
echo "local-ci: all ${#selected[@]} tests passed"
