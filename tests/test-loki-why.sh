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

# Case 6 (BUG 2/6): status="exited" (run.sh writes this each iteration; can
# survive a crash) must have a real diagnosis, not the no-mapping fallback.
T6=$(mktemp -d); mkdir -p "$T6/.loki"
printf '{"status":"exited","lastExitCode":137,"iterationCount":3}\n' > "$T6/.loki/autonomy-state.json"
out=$( (cd "$T6" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'exited mid-iteration' && ! printf '%s' "$out" | grep -qi 'No diagnosis mapping'; then ok "exited -> real diagnosis (no fallback)"; else bad "exited diagnosis (BUG 2/6)"; fi
rm -rf "$T6"

# Case 7 (BUG 3): completion.json outcome vocabulary (complete/max_iterations)
# must normalize onto GUIDE keys when there is no live state status.
T7=$(mktemp -d); mkdir -p "$T7/.loki/state"
printf '{"outcome":"complete","branch":"feat/x","files_changed":2}\n' > "$T7/.loki/state/completion.json"
out=$( (cd "$T7" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'council agreed' && ! printf '%s' "$out" | grep -qi 'No diagnosis mapping'; then ok "completion outcome=complete -> council_approved mapping (BUG 3)"; else bad "completion outcome normalization (BUG 3)"; fi
printf '{"outcome":"max_iterations"}\n' > "$T7/.loki/state/completion.json"
out=$( (cd "$T7" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'iteration cap'; then ok "completion outcome=max_iterations -> max_iterations_reached mapping (BUG 3)"; else bad "max_iterations normalization (BUG 3)"; fi
rm -rf "$T7"

# Case 8 (BUG 7): a live/crashed run must NOT report the PREVIOUS run's stale
# completion branch/changes/PR as if they were this run -- they get labeled.
T8=$(mktemp -d); mkdir -p "$T8/.loki/state"
( cd "$T8" && git init -q && git config user.email t@t.t && git config user.name t && echo x > f && git add f && git commit -qm init )
printf '{"status":"exited","lastExitCode":1,"iterationCount":2}\n' > "$T8/.loki/autonomy-state.json"
printf '{"outcome":"complete","branch":"feat/old","head_sha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef","files_changed":9,"pr_url":"http://old-pr"}\n' > "$T8/.loki/state/completion.json"
out=$( (cd "$T8" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'from previous completed run'; then ok "live run + stale completion -> labeled previous (BUG 7)"; else bad "stale completion labeling (BUG 7)"; fi
# And a terminal completion at the CURRENT head must NOT be labeled stale.
T8H=$( cd "$T8" && git rev-parse HEAD )
rm -f "$T8/.loki/autonomy-state.json"
printf '{"outcome":"complete","branch":"feat/cur","head_sha":"%s","files_changed":2,"pr_url":"http://cur-pr"}\n' "$T8H" > "$T8/.loki/state/completion.json"
out=$( (cd "$T8" && LOKI_DIR=.loki bash "$LOKI" why) 2>&1 )
if printf '%s' "$out" | grep -qi 'feat/cur' && ! printf '%s' "$out" | grep -qi 'from previous completed run'; then ok "current completion -> NOT labeled stale (BUG 7)"; else bad "current completion mislabeled (BUG 7)"; fi
rm -rf "$T8"

echo ""
echo "Results: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
