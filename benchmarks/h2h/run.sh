#!/usr/bin/env bash
# B1 head-to-head benchmark: raw Claude Code vs Loki on hidden-test coding tasks in 4 languages.
# Protocol and latest numbers: benchmarks/h2h/RESULTS.md.
#
#   bash benchmarks/h2h/run.sh                                  all 4 configs x every task x 1 rep
#   bash benchmarks/h2h/run.sh --reps 3 --jobs 4 --budget 38 --ledger spend.jsonl   the published protocol
#   bash benchmarks/h2h/run.sh --resume results/<file>.json ... finish an interrupted invocation
#   bash benchmarks/h2h/run.sh --configs raw-haiku,loki-haiku --tasks py-csv-quotes --reps 3
#   bash benchmarks/h2h/run.sh --configs oracle,noop            offline task self-check (no model)
#   bash benchmarks/h2h/run.sh --budget 25 --ledger spend.jsonl stop before a run once spend reaches $25
#   bash benchmarks/h2h/run.sh --suite replay --configs oracle,noop    replay suite self-check
#
# Configs: raw-haiku, raw-opus (`command claude -p <task> --model M --output-format json
# --dangerously-skip-permissions`), raw-haiku-verify, raw-opus-verify (the same, with one sentence
# appended asking it to run the repo's tests and check its change), loki-haiku (bin/loki <task>
# --no-pr with LOKI_SESSION_MODEL=haiku), loki-default (bin/loki with no model setting).
# Suites: tasks/ (synthetic, the default) and replay/ (--suite replay: real closed issues from
# permissively licensed projects, vendored at the fix's parent commit and scored by the fix's own
# test files; meta.json "source" records license, issue, fix PR and commits).
# Tasks live in <suite>/<id>/: repo/ (the snapshot, visible tests included), task.txt
# (what the user types), hidden/ (acceptance tests, copied in only after the contestant
# exits), solution/ (a reference overlay used by the oracle config) and meta.json.
# Every contestant gets a fresh git copy, a throwaway HOME (only the Claude credential
# store is linked) and a 600s timeout. Results: results/<date>-<shortsha>.json plus a
# markdown table on stdout. Needs python3, git, bun, pytest, go and cargo; real configs need
# a logged-in claude CLI.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 -I "$here/h2h.py" "$@"
