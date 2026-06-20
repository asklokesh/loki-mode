#!/usr/bin/env bash
# loki ship must review the SHIPPABLE work, not nothing. Regression for the
# wave-2 finding: run.sh auto-commits session work to loki/session-*, so by ship
# time the tree is clean and cmd_review's uncommitted-diff default saw an empty
# diff -> false "clean" all-clear. Fix: on a clean loki/* branch, ship scopes the
# review to the branch-vs-base range (--since <base> from base-branch.txt).
set -uo pipefail
LOKI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/autonomy/loki"
pass=0; fail=0
ok(){ echo "  [PASS] $1"; pass=$((pass+1)); }
bad(){ echo "  [FAIL] $1"; fail=$((fail+1)); }

mk(){ # build a clean loki/* branch repo with committed work + gitignored .loki
  local d; d=$(mktemp -d)
  git -C "$d" init -q; git -C "$d" config user.email a@b.c; git -C "$d" config user.name a
  echo init > "$d/r.txt"; git -C "$d" add r.txt; git -C "$d" commit -qm init
  git -C "$d" checkout -q -b loki/session-9
  mkdir -p "$d/.loki/state"; printf 'main\n' > "$d/.loki/state/base-branch.txt"
  printf '.loki/\n' > "$d/.gitignore"; git -C "$d" add .gitignore; git -C "$d" commit -qm gi
  printf 'def x():\n    return 1\n' > "$d/work.py"
  git -C "$d" add work.py; git -C "$d" commit -qm "session work"
  echo "$d"
}

# 1. clean loki/* branch: ship scopes review to the branch range (not empty)
d=$(mk)
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship 2>&1)
printf '%s' "$out" | grep -qi 'reviewing the branch range vs main' && ok "clean loki branch -> reviews branch range" || bad "did not scope to branch range"
printf '%s' "$out" | grep -qi 'No changes to review' && bad "still reviewed empty uncommitted diff (the bug)" || ok "did NOT fall back to empty uncommitted diff"
rm -rf "$d"

# 2. explicit scope arg is respected (not overridden)
d=$(mk)
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship --staged 2>&1)
printf '%s' "$out" | grep -qi 'reviewing the branch range' && bad "overrode explicit --staged" || ok "explicit scope arg respected"
rm -rf "$d"

# 2b. passthrough flags (--yes) are NOT explicit scope: ship --yes must STILL
#     auto-scope to the branch range (regression: --yes used to count as a scope
#     arg and skip the scoping -> empty-diff false "clean").
d=$(mk)
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship --yes 2>&1)
printf '%s' "$out" | grep -qi 'reviewing the branch range vs main' && ok "ship --yes still auto-scopes" || bad "ship --yes skipped scoping (the --yes regression)"
printf '%s' "$out" | grep -qi 'No changes to review' && bad "ship --yes reviewed empty diff" || ok "ship --yes did not review empty diff"
rm -rf "$d"

# 2c. a positional <file> IS explicit scope: ship work.py must NOT be overridden
#     by the branch-range auto-scope (it should review just that file/path).
d=$(mk)
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship work.py 2>&1)
printf '%s' "$out" | grep -qi 'reviewing the branch range' && bad "positional file overridden by auto-scope" || ok "positional file scope respected"
rm -rf "$d"

# 2d. --severity is a THRESHOLD not a scope; both forms must STILL auto-scope.
#     The two-token form `--severity high` is the documented form -- its value
#     'high' must not fall through and wrongly mark explicit scope (that would
#     re-introduce the empty-diff false-clean bug).
d=$(mk)
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship --severity high 2>&1)
printf '%s' "$out" | grep -qi 'reviewing the branch range vs main' && ok "ship --severity high (two-token) still auto-scopes" || bad "ship --severity high skipped scoping"
printf '%s' "$out" | grep -qi 'No changes to review' && bad "ship --severity high reviewed empty diff" || ok "ship --severity high did not review empty diff"
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship --severity=high 2>&1)
printf '%s' "$out" | grep -qi 'reviewing the branch range vs main' && ok "ship --severity=high (one-token) still auto-scopes" || bad "ship --severity=high skipped scoping"
rm -rf "$d"

# 3. ship never pushes/PRs (print-only safety preserved)
d=$(mk)
out=$(cd "$d" && LOKI_DIR=.loki timeout 90 bash "$LOKI" ship 2>&1)
printf '%s' "$out" | grep -qiE 'does not push or deploy|run the command above' && ok "ship is print-only" || bad "ship print-only notice missing"
rm -rf "$d"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
