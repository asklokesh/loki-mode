#!/usr/bin/env bash
# B5: loki why -- actionable failure/outcome diagnosis. Read-only over the
# already-captured run artifacts; never fabricates.
set -uo pipefail
LOKI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/loki"
passed=0; failed=0
ok(){ echo "  [PASS] $1"; passed=$((passed+1)); }
bad(){ echo "  [FAIL] $1"; failed=$((failed+1)); }

# Case 1: no run -> honest non-zero error
T1=$(mktemp -d)
out=$( (cd "$T1" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'no run found'; then ok "no-run -> non-zero + honest message"; else bad "no-run case (rc=$rc)"; fi
rm -rf "$T1"

# Case 2: a terminal failure state -> diagnosis + next action
T2=$(mktemp -d); mkdir -p "$T2/.loki/state"
printf '{"status":"failed","lastExitCode":1,"iterationCount":3}\n' > "$T2/.loki/autonomy-state.json"
out=$( (cd "$T2" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'failure state' && printf '%s' "$out" | grep -qi 'What to do'; then ok "failed -> diagnosis + action"; else bad "failed diagnosis"; fi
rm -rf "$T2"

# Case 3: council_approved -> review/PR guidance
T3=$(mktemp -d); mkdir -p "$T3/.loki/state"
printf '{"status":"council_approved","lastExitCode":0,"iterationCount":8}\n' > "$T3/.loki/autonomy-state.json"
printf '{"outcome":"council_approved","branch":"loki/x","files_changed":5,"insertions":50,"deletions":2,"pr_url":""}\n' > "$T3/.loki/state/completion.json"
out=$( (cd "$T3" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'council' && printf '%s' "$out" | grep -qi 'PR'; then ok "council_approved -> review/PR guidance + completion fields"; else bad "council_approved"; fi

# Case 4: --json emits valid JSON with state + completion
jout=$( (cd "$T3" && LOKI_DIR=.loki bash "$LOKI" why --json) 2>&1 )
if printf '%s' "$jout" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "state" in d and "completion" in d' 2>/dev/null; then ok "--json valid with state+completion"; else bad "--json"; fi
rm -rf "$T3"

# Case 5: never fabricates -- a status with no completion file still reports honestly
T5=$(mktemp -d); mkdir -p "$T5/.loki"
printf '{"status":"running","iterationCount":2}\n' > "$T5/.loki/autonomy-state.json"
out=$( (cd "$T5" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'running' && printf '%s' "$out" | grep -qi 'crash'; then ok "running -> honest crash/resume guidance"; else bad "running case"; fi
rm -rf "$T5"

echo ""
echo "Results: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
