#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-harness.sh
#
# EV-1: the Loki 10 eval harness (run.sh, harness.py, summarize) against two
# self-made fixture tasks with a stub arm. Never runs the real claude or loki.
# Legs:
#   1. validator accepts the fixtures and rejects '..', absolute hidden paths,
#      id/dir mismatch and a missing hidden.run
#   2. leak-check positive control: the stub fails loudly when a hidden file
#      is visible
#   3. pass stub -> completed, hidden absent during the arm and from the PR
#      branch, cost null when not reported
#   4. cost stub -> provider-reported cost recorded
#   5. nofix stub -> pr_opened but hidden fails, not completed
#   6. noop stub -> no PR, not completed, time_to_pr null
#   7. sleep stub on a 3s cap -> capped, not completed, sleeper killed
#   8. v10 arm: missing binary and missing engine marker -> arm_unavailable;
#      marker present -> completed
#   9. --all --parallel 2 records both tasks; run tmp removed after each run
#  10. SIGTERM to run.sh kills only its children, removes its tmp, no ok row
#  11. summarize: rates, n/a handling, interrupted excluded, Markdown misses
# Also: arm env drops LOKI_RUN_TMP/LOKI_*/GH_TOKEN; cost parsed from a
# pretty-printed message array.
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"
export LOKI_NO_BROWSER=1 LOKI_EVAL_MAX_LOAD=1000
unset LOKI_EVAL_MODEL

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
echo "test tmp: $T"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

STUB="$HERE/fixtures/stub-arm.sh"
TASKS="$T/tasks"
mkdir -p "$TASKS" "$T/bin"
ln -s "$STUB" "$T/bin/claude-stub"
ln -s "$STUB" "$T/bin/loki-stub"

# Seed each fixture's repo and write a runnable task dir with real source/ref.
for fx in fx-greet fx-cap; do
    seed="$T/seed-$fx"
    cp -R "$HERE/fixtures/$fx/seed" "$seed"
    git -C "$seed" init -q
    git -C "$seed" add -A
    git -C "$seed" -c user.name=t -c user.email=t@localhost commit -q -m seed
    # A later commit that must NOT be visible to the arm (fixture future).
    echo future > "$seed/future.txt"
    git -C "$seed" add future.txt
    git -C "$seed" -c user.name=t -c user.email=t@localhost commit -q -m future
    ref="$(git -C "$seed" rev-parse HEAD~1)"
    mkdir -p "$TASKS/$fx"
    cp -R "$HERE/fixtures/$fx/hidden" "$TASKS/$fx/hidden"
    sed -e "s|@SEED_REPO@|$seed|" -e "s|@SEED_REF@|$ref|" "$HERE/fixtures/$fx/task.json" > "$TASKS/$fx/task.json"
done

H() { python3 "$HERE/harness.py" "$@"; }
# run.sh owns its own run tmp, so it must not inherit ours.
RUN() { env -u LOKI_RUN_TMP bash "$HERE/run.sh" --tasks-dir "$TASKS" "$@"; }
row() { python3 -c 'import json,sys; r=[json.loads(l) for l in open(sys.argv[1])][-1]; print(json.dumps(r.get(sys.argv[2])))' "$1" "$2"; }

# ---- 1. validator
if H validate "$TASKS/fx-greet" "$TASKS/fx-cap" >/dev/null 2>&1; then pass "validator accepts fixtures"; else fail "validator rejected fixtures"; fi
bad_case() {
    local name="$1" expr="$2" d="$T/bad/$1"
    mkdir -p "$d"
    cp -R "$TASKS/fx-greet/hidden" "$d/hidden"
    python3 -c "import json,sys; t=json.load(open(sys.argv[1])); t['id']=sys.argv[3]; $expr; json.dump(t, open(sys.argv[2],'w'))" \
        "$TASKS/fx-greet/task.json" "$d/task.json" "$name"
    if H validate "$d" >/dev/null 2>&1; then fail "validator accepted $name"; else pass "validator rejects $name"; fi
}
bad_case dotdot "t['hidden']['files']=['../../etc/passwd']"
bad_case abspath "t['hidden']['files']=['/etc/passwd']"
bad_case idmismatch "t['id']='other'"
bad_case norun "del t['hidden']['run']"

# ---- 2. leak check positive control
mkdir -p "$T/leak" && touch "$T/leak/hidden_test.sh"
out="$(cd "$T/leak" && STUB_MODE=check bash "$STUB" 2>&1)"; rc=$?
if [ "$rc" = 97 ] && printf '%s' "$out" | grep -q "HIDDEN LEAK"; then pass "stub fails loudly on a visible hidden file"; else fail "leak control rc=$rc out=$out"; fi

export LOKI_EVAL_CLAUDE_BIN="$T/bin/claude-stub" LOKI_EVAL_LOKI_BIN="$T/bin/loki-stub"

# ---- 3. pass
R="$T/out-pass"
STUB_MODE=pass LOKI_SENTINEL_X=1 GH_TOKEN=fake-token RUN --arm raw-claude --task fx-greet --out "$R" >"$T/pass.log" 2>&1
J="$R/results.jsonl"
grep -q "ENV-CHECK: run_tmp=unset sentinel=unset gh_token=unset" "$R"/logs/*/arm_stderr.log \
    && pass "arm env drops LOKI_RUN_TMP, operator LOKI_* knobs and GH_TOKEN" || fail "arm env leak: $(grep ENV-CHECK "$R"/logs/*/arm_stderr.log)"
[ "$(row "$J" completed)" = true ] && [ "$(row "$J" hidden_pass)" = true ] && [ "$(row "$J" pr_opened)" = true ] \
    && pass "pass stub recorded as completed" || fail "pass stub not completed: $(tail -1 "$J" 2>/dev/null) $(cat "$T/pass.log")"
[ "$(row "$J" cost_usd)" = null ] && pass "cost null when not reported" || fail "cost not null: $(row "$J" cost_usd)"
[ "$(row "$J" time_to_pr_s)" != null ] && pass "time_to_pr_s recorded" || fail "time_to_pr_s null on a PR"
armlog="$(python3 -c 'import json,sys; print([json.loads(l) for l in open(sys.argv[1])][-1]["logs"]["arm_stdout"])' "$J")"
grep -q "HIDDEN-CHECK: absent" "$armlog" && pass "hidden files absent during the arm" || fail "stub leak check did not report absent"
prj="$R/logs/$(ls "$R/logs")/pr.json"
[ -f "$prj" ] && grep -q '"branch": "fix-greet"' "$prj" && pass "PR record file written" || fail "no PR record"
rtmp="$(sed -n 's/^run tmp: //p' "$T/pass.log")"
[ -n "$rtmp" ] && [ ! -e "$rtmp" ] && pass "run tmp removed after the run" || fail "run tmp left behind: $rtmp"

# The PR branch never contains the hidden file, and the future commit was pruned.
PROBE="$T/probe"
mkdir -p "$PROBE"
cat > "$T/bin/probe-stub" <<'EOF'
#!/usr/bin/env bash
git cat-file -e "$(cat "$PROBE_FUTURE_SHA")" 2>/dev/null && echo "FUTURE VISIBLE" || echo "FUTURE ABSENT"
EOF
chmod +x "$T/bin/probe-stub"
git -C "$T/seed-fx-greet" rev-parse HEAD > "$PROBE/future-sha"
PROBE_FUTURE_SHA="$PROBE/future-sha" LOKI_EVAL_CLAUDE_BIN="$T/bin/probe-stub" \
    RUN --arm raw-claude --task fx-greet --out "$T/out-probe" >/dev/null 2>&1
grep -q "FUTURE ABSENT" "$T/out-probe"/logs/*/arm_stdout.log && pass "later upstream commits pruned from the arm checkout" \
    || fail "future commit visible to the arm: $(cat "$T/out-probe"/logs/*/arm_stdout.log)"

# ---- 4. cost
R="$T/out-cost"
STUB_MODE=cost RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" cost_usd)" = 0.25 ] && pass "provider-reported cost recorded" || fail "cost=$(row "$R/results.jsonl" cost_usd)"
R2="$T/out-costpretty"
STUB_MODE=costpretty RUN --arm raw-claude --task fx-greet --out "$R2" >/dev/null 2>&1
[ "$(row "$R2/results.jsonl" cost_usd)" = 0.25 ] && pass "cost parsed from pretty-printed message array" || fail "pretty cost=$(row "$R2/results.jsonl" cost_usd)"

# ---- 5. nofix
R="$T/out-nofix"
STUB_MODE=nofix RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" pr_opened)" = true ] && [ "$(row "$J" hidden_pass)" = false ] && [ "$(row "$J" completed)" = false ] \
    && pass "pushed branch without the fix is not completed" || fail "nofix row: $(tail -1 "$J")"

# ---- 6. noop
R="$T/out-noop"
STUB_MODE=noop RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" pr_opened)" = false ] && [ "$(row "$J" completed)" = false ] && [ "$(row "$J" time_to_pr_s)" = null ] \
    && pass "no-op is not completed" || fail "noop row: $(tail -1 "$J")"

# ---- 7. cap
R="$T/out-cap"
t0=$(date +%s)
STUB_MODE=sleep STUB_PID_FILE="$T/sleep.pids" RUN --arm raw-claude --task fx-cap --out "$R" >/dev/null 2>&1
el=$(( $(date +%s) - t0 ))
J="$R/results.jsonl"
[ "$(row "$J" capped)" = true ] && [ "$(row "$J" completed)" = false ] && [ "$el" -lt 60 ] \
    && pass "cap kills a sleeping stub and records capped (${el}s)" || fail "cap row (${el}s): $(tail -1 "$J")"
alive=0
while read -r p; do kill -0 "$p" 2>/dev/null && alive=1; done < "$T/sleep.pids"
[ "$alive" = 0 ] && pass "sleeper and its child are gone" || fail "sleeper survived the cap"

# ---- 8. v10 availability
R="$T/out-v10"
STUB_MODE=pass LOKI_EVAL_LOKI_BIN="$T/bin/missing" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"arm_unavailable"' ] && pass "v10 missing binary -> arm_unavailable" || fail "v10 missing: $(tail -1 "$R/results.jsonl")"
STUB_MODE=pass RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"arm_unavailable"' ] && [ "$(row "$R/results.jsonl" completed)" = false ] \
    && pass "v10 without engine marker -> arm_unavailable, not a pass" || fail "v10 no marker: $(tail -1 "$R/results.jsonl")"
STUB_MODE=pass STUB_V10_MARKER=1 RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" completed)" = true ] && pass "v10 with engine marker -> completed" || fail "v10 marker: $(tail -1 "$R/results.jsonl")"

# ---- 9. --all --parallel
R="$T/out-all"
STUB_MODE=noop RUN --arm raw-claude --all --parallel 2 --out "$R" >/dev/null 2>&1
n="$(grep -c . "$R/results.jsonl" 2>/dev/null)"
[ "$n" = 2 ] && pass "--all --parallel 2 records both tasks" || fail "--all rows=$n"

# ---- 10. SIGTERM to run.sh stops only its children and records no verdict
R="$T/out-stop"
rm -f "$T/stop.pids"
STUB_MODE=sleep STUB_PID_FILE="$T/stop.pids" env -u LOKI_RUN_TMP bash "$HERE/run.sh" --tasks-dir "$TASKS" \
    --arm raw-claude --task fx-greet --out "$R" >"$T/stop.log" 2>&1 &
rpid=$!
for _ in $(seq 1 100); do [ -s "$T/stop.pids" ] && break; sleep 0.2; done
kill -TERM "$rpid" 2>/dev/null
for _ in $(seq 1 150); do kill -0 "$rpid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$rpid" 2>/dev/null; then fail "run.sh still running 30s after SIGTERM"; kill -KILL "$rpid" 2>/dev/null; fi
wait "$rpid" 2>/dev/null
alive=0
while read -r p; do kill -0 "$p" 2>/dev/null && alive=1; done < "$T/stop.pids"
[ -s "$T/stop.pids" ] && [ "$alive" = 0 ] && pass "SIGTERM kills the arm and its child" || fail "sleeper survived SIGTERM"
rtmp="$(sed -n 's/^run tmp: //p' "$T/stop.log")"
[ -n "$rtmp" ] && [ ! -e "$rtmp" ] && pass "run tmp removed after SIGTERM" || fail "run tmp left after SIGTERM: $rtmp"
st="$(row "$R/results.jsonl" status 2>/dev/null)"
[ -z "$st" ] || [ "$st" = '"interrupted"' ] && pass "interrupted run is not recorded as ok ($st)" || fail "stop row status=$st"

# ---- 11. summarize
cat "$T/out-pass/results.jsonl" "$T/out-cost/results.jsonl" "$T/out-nofix/results.jsonl" \
    "$T/out-noop/results.jsonl" "$T/out-cap/results.jsonl" "$T/out-v10/results.jsonl" > "$T/all.jsonl"
# An interrupted row must not enter the denominator.
echo '{"task":"fx-greet","arm":"raw-claude","status":"interrupted","completed":false,"capped":false,"cost_usd":null,"time_to_pr_s":null}' >> "$T/all.jsonl"
S="$(bash "$HERE/summarize" "$T/all.jsonl" --json)"
chk() { python3 -c "import json,sys; s=json.loads(sys.argv[1]); assert $2, s" "$S" 2>/dev/null && pass "$1" || fail "$1: $S"; }
chk "raw-claude 2 of 5 completed" "s['raw-claude']['completed']==2 and s['raw-claude']['evaluated']==5"
chk "raw-claude cost n/a when some runs unmeasured" "s['raw-claude']['cost_per_completed_usd'] is None and s['raw-claude']['cost_measured_runs']==1"
chk "raw-claude capped count 1" "s['raw-claude']['capped']==1"
chk "interrupted run counted separately, not as a miss" "s['raw-claude']['infra_or_interrupted']==1"
chk "v10 unavailable runs excluded from the rate" "s['v10']['unavailable']==2 and s['v10']['evaluated']==1 and s['v10']['completion_rate']==1.0"
head -2 "$T/out-v10/results.jsonl" > "$T/unavail.jsonl"
S="$(bash "$HERE/summarize" "$T/unavail.jsonl" --json)"
chk "all-unavailable arm rate is n/a, not 0" "s['v10']['completion_rate'] is None"
md="$(bash "$HERE/summarize" "$T/all.jsonl" --markdown)"
printf '%s' "$md" | grep -q "| raw-claude | 2/5 | 40.0% |" && printf '%s' "$md" | grep -q "fx-greet / raw-claude: no branch pushed" \
    && printf '%s' "$md" | grep -q "fx-cap / raw-claude: capped" && pass "Markdown table and misses" || fail "markdown: $md"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
