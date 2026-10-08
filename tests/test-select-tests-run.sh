#!/usr/bin/env bash
# tests/test-select-tests-run.sh -- FC-47: select-tests.sh --run must never be
# a silent no-op. Every early exit (R0 unparseable, broad-blast, unknown shape,
# docs-only, empty diff) has to reach the run step. Runs the selector inside a
# throwaway fake repo whose tests/run-all-tests.sh is a stub, so an R0 --run
# does not launch the real full suite.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; [ -z "${2:-}" ] || printf '%s\n' "$2"; }

TMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
WORK="$(mktemp -d "${TMP_ROOT}/loki-run.sel47.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

FAKE="$WORK/repo"
mkdir -p "$FAKE/scripts" "$FAKE/tests/moat"
cp "$REPO_ROOT/scripts/select-tests.sh" "$FAKE/scripts/select-tests.sh"
printf 'shell_test\ttests/guard-a.sh\n' >"$FAKE/scripts/global-guards.tsv"
printf '#!/usr/bin/env bash\necho STUB-FULL-SUITE-RAN\n' >"$FAKE/tests/run-all-tests.sh"
printf '#!/usr/bin/env bash\necho GUARD-A-RAN\n' >"$FAKE/tests/guard-a.sh"
SEL="$FAKE/scripts/select-tests.sh"

run_sel() { # stdin = file list
    printf '%s\n' "$FILES" | LOKI_NO_BROWSER=1 bash "$SEL" --files - --run 2>&1
}

# 1. broad-blast R0 path: --run executes the full suite
FILES="package.json"
out="$(run_sel)"; rc=$?
case "$out" in *STUB-FULL-SUITE-RAN*) ok ;; *) bad "R0 broad-blast --run did not run the full suite" "$out" ;; esac
[ "$rc" -eq 0 ] && ok || bad "R0 broad-blast --run rc=$rc" "$out"
case "$out" in *"suites executed: 1"*) ok ;; *) bad "R0 --run missing 'suites executed: 1'" "$out" ;; esac

# 2. unknown path shape R0
FILES="mystery.xyz"
out="$(run_sel)"; rc=$?
case "$out" in *STUB-FULL-SUITE-RAN*) ok ;; *) bad "unknown-shape --run ran nothing" "$out" ;; esac

# 3. unparseable (files mode, missing file list) is R0
out="$(LOKI_NO_BROWSER=1 bash "$SEL" --files-from "$WORK/nope" --run 2>&1)"; rc=$?
case "$out" in *STUB-FULL-SUITE-RAN*) ok ;; *) bad "unparseable --run ran nothing" "$out" ;; esac

# 4. docs-only: the docs guards run, count is printed
FILES="docs/readme-x.md"
out="$(run_sel)"; rc=$?
case "$out" in *GUARD-A-RAN*) ok ;; *) bad "docs-only --run did not run the global guards" "$out" ;; esac
case "$out" in *"suites executed: "[1-9]*) ok ;; *) bad "docs-only --run missing suites executed" "$out" ;; esac

# 5. selection that executes zero suites fails with NOTHING RUN
printf '' >"$FAKE/scripts/global-guards.tsv"
FILES="docs/readme-x.md"
out="$(run_sel)"; rc=$?
[ "$rc" -ne 0 ] && ok || bad "zero-suite --run exited 0" "$out"
case "$out" in *"NOTHING RUN"*) ok ;; *) bad "zero-suite --run missing NOTHING RUN" "$out" ;; esac
case "$out" in *"suites executed: 0"*) ok ;; *) bad "zero-suite --run missing count" "$out" ;; esac

# 6. empty diff is the one documented empty selection: rc 0
FILES=""
out="$(run_sel)"; rc=$?
[ "$rc" -eq 0 ] && ok || bad "empty diff --run rc=$rc" "$out"
case "$out" in *"suites executed: 0"*) ok ;; *) bad "empty diff --run missing count" "$out" ;; esac

# 7. selection without --run is unchanged (emits rows, runs nothing)
printf 'shell_test\ttests/guard-a.sh\n' >"$FAKE/scripts/global-guards.tsv"
out="$(printf 'package.json\n' | bash "$SEL" --files - 2>&1)"
case "$out" in *"R0"*ALL*) ok ;; *) bad "plain R0 selection output changed" "$out" ;; esac
case "$out" in *STUB-FULL-SUITE-RAN*) bad "plain selection executed suites" "$out" ;; *) ok ;; esac

echo "test-select-tests-run: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
