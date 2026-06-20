#!/usr/bin/env bash
# loki next: resolves the build state to the right next step. Regression for the
# v7.83.0 council finding: a completion-only state (outcome in completion.json,
# no live status) must resolve via the same outcome-alias map as loki why, so
# "complete" -> ship and "max_iterations" -> resume, not drift to "status".
set -uo pipefail
LOKI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/autonomy/loki"
pass=0; fail=0
ok(){ echo "  [PASS] $1"; pass=$((pass+1)); }
bad(){ echo "  [FAIL] $1"; fail=$((fail+1)); }
run_next(){ # <setup-json-into-completion> -> echoes the "Will run" line
  local d; d=$(mktemp -d); mkdir -p "$d/.loki/state"
  printf '%s\n' "$1" > "$d/.loki/state/completion.json"
  (cd "$d" && LOKI_DIR=.loki bash "$LOKI" next --dry-run 2>&1)
  rm -rf "$d"
}
# completion-only "complete" -> council_approved -> loki ship
o=$(run_next '{"outcome":"complete"}')
printf '%s' "$o" | grep -q 'Will run *: loki ship' && ok "completion-only complete -> ship" || bad "complete -> ship (got: $(printf '%s' "$o" | grep 'Will run'))"
# completion-only "max_iterations" -> resume
o=$(run_next '{"outcome":"max_iterations"}')
printf '%s' "$o" | grep -q 'Will run *: loki resume' && ok "completion-only max_iterations -> resume" || bad "max_iterations -> resume"
# live status wins over completion outcome
d=$(mktemp -d); mkdir -p "$d/.loki/state"
printf '{"status":"failed"}\n' > "$d/.loki/autonomy-state.json"
printf '{"outcome":"complete"}\n' > "$d/.loki/state/completion.json"
o=$(cd "$d" && LOKI_DIR=.loki bash "$LOKI" next --dry-run 2>&1); rm -rf "$d"
printf '%s' "$o" | grep -q 'Will run *: loki why' && ok "live status (failed) wins -> why" || bad "live status precedence"
# no run -> honest message
d=$(mktemp -d); o=$(cd "$d" && LOKI_DIR=.loki bash "$LOKI" next 2>&1); rm -rf "$d"
printf '%s' "$o" | grep -qi 'no run found' && ok "no run -> honest message" || bad "no-run message"
echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
