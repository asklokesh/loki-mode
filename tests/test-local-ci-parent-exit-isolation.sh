#!/usr/bin/env bash
# Regression guard: a check body is operator-controlled shell. Its `exit` must
# end only that check, never scripts/local-ci.sh itself. In particular, the
# core.bare parent check currently has three legitimate `exit 0` branches and
# one fatal `exit 1` branch; the dist check has three fatal `exit 1` branches.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI="$REPO_ROOT/scripts/local-ci.sh"
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-local-ci-exit-test.XXXXXX")"
trap 'rm -rf "$TMPROOT"' EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "[PASS] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

# Exercise the real function body without running the 100+ checks below it.
awk '/^run_check\(\) \{/{copy=1} copy{print} copy && /^}/{exit}' "$CI" > "$TMPROOT/run-check.fn"

run_case() {
  local name="$1" verbose="$2" body="$3" expected_rc="$4" expected_marker="$5"
  {
    cat <<EOF
set -uo pipefail
declare -a PASSED=() FAILED=() SKIPPED=()
VERBOSE=$verbose
GREEN='' RED='' YELLOW='' CYAN='' DIM='' NC=''
_should_defer() { return 1; }
skip_check() { SKIPPED+=("\$1 (\$2)"); }
EOF
    cat "$TMPROOT/run-check.fn"
    cat <<EOF
run_check parent '$body'
run_check post-parent 'printf POST_PARENT'
printf 'MARKER:$name:P=%s:F=%s:S=%s\n' "\${#PASSED[@]}" "\${#FAILED[@]}" "\${#SKIPPED[@]}"
[ "\${#FAILED[@]}" -eq 0 ]
EOF
  } > "$TMPROOT/$name.sh"

  local out rc
  out="$(bash "$TMPROOT/$name.sh" 2>&1)"; rc=$?
  if [ "$rc" = "$expected_rc" ] && case "$out" in *"$expected_marker"*) true;; *) false;; esac; then
    ok "$name keeps exit local, records its result, and reaches the post-parent marker"
  else
    bad "$name (rc=$rc; wanted $expected_rc + $expected_marker; output: ${out//$'\n'/ | })"
  fi
}

# Non-verbose is the normal gate route. These statuses cover every current
# parent-check exit branch: success (0) and fatal (1). A distinct non-one fatal
# proves propagation is status-agnostic rather than special-cased.
run_case quiet-exit-0 0 'exit 0' 0 'MARKER:quiet-exit-0:P=2:F=0:S=0'
run_case quiet-exit-1 0 'exit 1' 1 'MARKER:quiet-exit-1:P=1:F=1:S=0'
run_case quiet-exit-7 0 'exit 7' 1 'MARKER:quiet-exit-7:P=1:F=1:S=0'

# --verbose has its own eval call and therefore needs the same executable
# contract, not a static assertion about the normal route.
run_case verbose-exit-0 1 'exit 0' 0 'MARKER:verbose-exit-0:P=2:F=0:S=0'
run_case verbose-exit-1 1 'exit 1' 1 'MARKER:verbose-exit-1:P=1:F=1:S=0'
run_case verbose-exit-7 1 'exit 7' 1 'MARKER:verbose-exit-7:P=1:F=1:S=0'

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
