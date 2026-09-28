#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-harness.sh
#
# EV-1: the Loki 10 eval harness (run.sh, harness.py, summarize) against two
# self-made fixture tasks (plus variants built from them) with a stub arm.
# Never runs the real claude or loki.
# Legs:
#   1. validator accepts the fixtures and rejects '..', absolute hidden paths,
#      id/dir mismatch and a missing hidden.run
#   2. leak-check positive control: the stub fails loudly on a visible hidden file
#   3. pass stub -> completed; hidden absent during the arm; env scrubbed;
#      cost null when not reported; later upstream commits pruned
#   4. cost stub -> provider-reported cost recorded (single line and pretty)
#   5. nofix stub -> pr_opened but hidden fails, not completed
#   6. noop stub -> no PR, not completed, time_to_pr null
#   7. sleep stub on a 3s cap -> capped, not completed, sleeper killed
#   8. v10 arm: missing binary / missing marker -> arm_unavailable; marker with
#      a fresh run_id events file -> completed
#   9. --all --parallel 2 records both tasks; run tmp removed after each run
#  10. SIGTERM to run.sh kills only its children, removes its tmp, no ok row
#  Review legs (each red before its fix):
#  R1 committed or setup-created .loki/engine.json -> task_invalid
#  R1b marker without events file, or with a stale one -> arm_unavailable
#  R2 committed .loki/metrics -> task_invalid; estimate cost -> null;
#     provider-sourced cost -> recorded
#  Ra hidden test that exits 0 before its assertions -> not passed;
#     pytest that only skips -> not passed; real pytest pass -> completed
#  Rb arm sees no repo.source path, no global/system git config, no seed copy
#  Rc hidden path that is a symlink or blocked by a file -> graded fail;
#     a hardlink in the arm's own tree is never written through
#  Rd harness_error after a push keeps pr_opened
#  Re orphan left by the arm is killed
#  Rf hidden tests that already pass (or cannot be placed) at repo.ref -> task_invalid
#  Rg summarize dedupes by (task, arm) and groups by model and harness_sha
#  Rh push time before the run start is flagged, not clamped
#  Ri harness_sha carries -dirty exactly when the repo has local changes
#  12. (EV-3) config isolation: all three arms get a fresh empty
#      CLAUDE_CONFIG_DIR (operator's overridden) and env auth; auth reaches
#      only the arm (never setup, baseline or grade); the token is in no log;
#      (E-38) LOKI_ENGINE=legacy on the legacy arm, v10 on the v10 arm
#  13. (E-38) --tasks a,b runs exactly those ids; an unknown id exits 2
#  14. (E-52) LOKI_TS_ENTRY and an allowlisted LOKI_E10_* knob reach the v10
#      arm env; a non-allowlisted LOKI_E10_* knob and a GH_TOKEN canary do
#      not; the legacy arm gets neither knob
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"
export LOKI_NO_BROWSER=1 LOKI_EVAL_MAX_LOAD=1000
unset LOKI_EVAL_MODEL ANTHROPIC_API_KEY
# A fake operator token: the harness passes it through and never reads the
# keychain, so these legs are hermetic on macOS and Linux alike.
FAKE_OAUTH="fake-oauth-ev3-$$"
export CLAUDE_CODE_OAUTH_TOKEN="$FAKE_OAUTH"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
echo "test tmp: $T"
trap 'chmod -R u+rw "$T" 2>/dev/null; loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

STUB="$HERE/fixtures/stub-arm.sh"
TASKS="$T/tasks"
mkdir -p "$TASKS" "$T/bin" "$T/fakebin"
ln -s "$STUB" "$T/bin/claude-stub"
ln -s "$STUB" "$T/bin/loki-stub"

# seed_task NAME BASE PY_EXPR PRE_CMD: seed a repo from fixtures/BASE/seed
# (PRE_CMD runs in it before the first commit), add a later "future" commit
# the arm must never see, and write a runnable task dir. PY_EXPR edits the
# task dict `t`.
seed_task() {
    local name="$1" base="$2" expr="$3" pre="$4" seed="$T/seed-$1" ref
    cp -R "$HERE/fixtures/$base/seed" "$seed"
    (cd "$seed" && bash -c "$pre") || return 1
    git -C "$seed" init -q
    git -C "$seed" add -A -f .
    git -C "$seed" -c user.name=t -c user.email=t@localhost commit -q -m seed
    echo future > "$seed/future.txt"
    git -C "$seed" add future.txt
    git -C "$seed" -c user.name=t -c user.email=t@localhost commit -q -m future
    ref="$(git -C "$seed" rev-parse HEAD~1)"
    mkdir -p "$TASKS/$name"
    cp -R "$HERE/fixtures/$base/hidden" "$TASKS/$name/hidden"
    python3 - "$HERE/fixtures/$base/task.json" "$TASKS/$name/task.json" "$name" "$seed" "$ref" "$expr" <<'PY'
import json, sys
src, dst, name, seed, ref, expr = sys.argv[1:]
t = json.load(open(src))
t["id"] = name
t["repo"] = {"source": seed, "ref": ref}
exec(expr)
json.dump(t, open(dst, "w"), indent=2)
PY
}
seed_task fx-greet fx-greet "" ":"
seed_task fx-cap fx-cap "" ":"
seed_task v-committed-marker fx-greet "" \
    'mkdir -p .loki/events && echo "{\"engine\": \"v10\", \"run_id\": \"old\"}" > .loki/engine.json && touch .loki/events/old.jsonl'
seed_task v-setup-marker fx-greet \
    "t['setup'] = 'mkdir -p .loki && echo {\\\"engine\\\": \\\"v10\\\"} > .loki/engine.json'" ":"
seed_task v-committed-metrics fx-greet "" \
    'mkdir -p .loki/metrics/efficiency && echo "{\"iteration\": 1, \"cost_usd\": 9.99}" > .loki/metrics/efficiency/iteration-1.json'
seed_task v-pytest fx-greet "t['hidden']['run'] = 'pytest -q'" ":"
seed_task v-blocker fx-greet "t['hidden']['files'] = ['tests/hidden_test.sh']; t['hidden']['run'] = 'bash tests/hidden_test.sh'" ":"
mkdir -p "$TASKS/v-blocker/hidden/tests" && mv "$TASKS/v-blocker/hidden/hidden_test.sh" "$TASKS/v-blocker/hidden/tests/"
seed_task v-blocked-base fx-greet "t['hidden']['files'] = ['tests/hidden_test.sh']; t['hidden']['run'] = 'bash tests/hidden_test.sh'" \
    'echo "a file where the hidden dir must go" > tests'
mkdir -p "$TASKS/v-blocked-base/hidden/tests" && mv "$TASKS/v-blocked-base/hidden/hidden_test.sh" "$TASKS/v-blocked-base/hidden/tests/"
seed_task v-chmod fx-greet "" ":"
seed_task v-baseline-pass fx-greet "t['hidden']['run'] = 'echo \"\$LOKI_EVAL_NONCE\"'" ":"

# A pytest stand-in: "skip" mode reports only skips with exit 0 (a conftest
# that skips everything); otherwise it runs the real hidden script.
cat > "$T/fakebin/pytest" <<'EOF'
#!/usr/bin/env bash
if [ "${FAKE_PYTEST:-}" = skip ]; then echo "1 skipped in 0.01s"; exit 0; fi
if bash hidden_test.sh >/dev/null 2>&1; then echo "1 passed in 0.01s"; else echo "1 failed in 0.01s"; exit 1; fi
EOF
chmod +x "$T/fakebin/pytest"
# A venv-style interpreter: `.venv/bin/python -m pytest ...` (the EV-2 public
# task shape) forwards to the fake pytest.
cat > "$T/fakebin/fakepy" <<EOF
#!/usr/bin/env bash
[ "\$1 \$2" = "-m pytest" ] || exit 2
shift 2
exec "$T/fakebin/pytest" "\$@"
EOF
chmod +x "$T/fakebin/fakepy"
seed_task v-venv-pytest fx-greet \
    "t['setup'] = 'mkdir -p .venv/bin && ln -sf $T/fakebin/fakepy .venv/bin/python'; t['hidden']['run'] = '.venv/bin/python -m pytest -q -p no:cacheprovider -k \"(greet or hello)\"'" ":"

H() { python3 "$HERE/harness.py" "$@"; }
# run.sh owns its own run tmp, so it must not inherit ours. The tasks dir goes
# through env, never argv (argv is visible to the arm in ps).
RUN() { env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$TASKS" bash "$HERE/run.sh" "$@"; }
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

# Probe arm: dumps what it can see (Rb) and checks the future commit.
cat > "$T/bin/probe-stub" <<'EOF'
#!/usr/bin/env bash
git cat-file -e "$(cat "$PROBE_FUTURE_SHA")" 2>/dev/null && echo "FUTURE VISIBLE" || echo "FUTURE ABSENT"
echo "ARGS: $*"
# The arm's own auth is expected in its env; keep its value out of the log.
env | grep -v -e '^CLAUDE_CODE_OAUTH_TOKEN=' -e '^ANTHROPIC_API_KEY='
cat .git/logs/HEAD 2>/dev/null
cat .git/config
echo "GLOBAL-NAME: [$(git config --global user.name 2>/dev/null)]"
echo "SIBLINGS: $(ls ..)"
echo "PS: $(ps -ww -ax -o args=)"
EOF
chmod +x "$T/bin/probe-stub"
git -C "$T/seed-fx-greet" rev-parse HEAD > "$T/future-sha"
PROBE_FUTURE_SHA="$T/future-sha" LOKI_EVAL_CLAUDE_BIN="$T/bin/probe-stub" \
    RUN --arm raw-claude --task fx-greet --out "$T/out-probe" >/dev/null 2>&1
PL="$(cat "$T/out-probe"/logs/*/arm_stdout.log)"
printf '%s' "$PL" | grep -q "FUTURE ABSENT" && pass "later upstream commits pruned from the arm checkout" \
    || fail "future commit visible to the arm: $PL"

# ---- Rb. arm cannot reach repo.source or the operator's git config
printf '%s' "$PL" | grep -qF "$T/seed-fx-greet" && fail "Rb: repo.source path visible to the arm" \
    || pass "Rb: repo.source path not visible to the arm (argv, env, .git)"
printf '%s' "$PL" | grep -qx "GIT_CONFIG_GLOBAL=/dev/null" && printf '%s' "$PL" | grep -qx "GIT_CONFIG_NOSYSTEM=1" \
    && printf '%s' "$PL" | grep -qx "GLOBAL-NAME: \[\]" && pass "Rb: arm git ignores global and system config" \
    || fail "Rb: arm git config not isolated: $(printf '%s' "$PL" | grep -E 'GIT_CONFIG|GLOBAL-NAME')"
printf '%s' "$PL" | grep "^SIBLINGS:" | grep -q "seed" && fail "Rb: private seed copy left beside the checkout" \
    || pass "Rb: no seed copy beside the checkout during the arm"
PSL="$(printf '%s\n' "$PL" | sed -n '/^PS: /,$p')"
if printf '%s' "$PSL" | grep -qF "$TASKS"; then fail "Rb: tasks dir visible in the process list during the arm"
elif printf '%s' "$PSL" | grep -qF "$T/seed-"; then fail "Rb: repo.source visible in the process list during the arm"
else pass "Rb: neither tasks dir nor repo.source in the process list during the arm"; fi

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
[ "$(row "$R/results.jsonl" completed)" = true ] && pass "v10 with marker and fresh events -> completed" || fail "v10 marker: $(tail -1 "$R/results.jsonl")"

# ---- R1. a pre-existing marker makes the task invalid, never a v10 pass
for v in v-committed-marker v-setup-marker; do
    R="$T/out-$v"
    STUB_MODE=pass RUN --arm v10 --task "$v" --out "$R" >/dev/null 2>&1
    [ "$(row "$R/results.jsonl" status)" = '"task_invalid"' ] && [ "$(row "$R/results.jsonl" completed)" = false ] \
        && pass "R1: $v -> task_invalid" || fail "R1: $v row: $(tail -1 "$R/results.jsonl")"
done
# ---- R1b. marker must point at an events file written during this run
for m in noevents stale oldpath badfield; do
    R="$T/out-v10-$m"
    STUB_MODE=pass STUB_V10_MARKER="$m" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
    [ "$(row "$R/results.jsonl" status)" = '"arm_unavailable"' ] && pass "R1b: v10 marker with $m events -> arm_unavailable" \
        || fail "R1b: $m row: $(tail -1 "$R/results.jsonl")"
done

# ---- R2. loki-arm cost only from provider-sourced records
R="$T/out-metrics"
STUB_MODE=pass RUN --arm legacy --task v-committed-metrics --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"task_invalid"' ] && [ "$(row "$R/results.jsonl" cost_usd)" = null ] \
    && pass "R2: committed .loki/metrics -> task_invalid, no cost" || fail "R2: metrics row: $(tail -1 "$R/results.jsonl")"
R="$T/out-estimate"
STUB_MODE=pass STUB_LOKI_COST=estimate RUN --arm legacy --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" cost_usd)" = null ] && pass "R2: record without provider cost_source -> cost null" \
    || fail "R2: estimate cost=$(row "$R/results.jsonl" cost_usd)"
R="$T/out-provider"
STUB_MODE=pass STUB_LOKI_COST=provider RUN --arm legacy --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" cost_usd)" = 0.5 ] && pass "R2: provider-sourced record -> cost recorded" \
    || fail "R2: provider cost=$(row "$R/results.jsonl" cost_usd)"

# ---- Ra. nonce: early exit 0 and skip-only pytest cannot pass
R="$T/out-exit0"
STUB_MODE=exit0 RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" pr_opened)" = true ] && [ "$(row "$R/results.jsonl" hidden_pass)" = false ] \
    && pass "Ra: hidden test exiting 0 before its assertions does not pass" || fail "Ra: exit0 row: $(tail -1 "$R/results.jsonl")"
R="$T/out-pyskip"
PATH="$T/fakebin:$PATH" FAKE_PYTEST=skip STUB_MODE=pass RUN --arm raw-claude --task v-pytest --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" hidden_pass)" = false ] && [ "$(row "$R/results.jsonl" completed)" = false ] \
    && pass "Ra: pytest reporting only skips does not pass" || fail "Ra: skip row: $(tail -1 "$R/results.jsonl")"
R="$T/out-pypass"
PATH="$T/fakebin:$PATH" STUB_MODE=pass RUN --arm raw-claude --task v-pytest --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" completed)" = true ] && pass "Ra: pytest with passed tests and no failures completes" \
    || fail "Ra: pytest pass row: $(tail -1 "$R/results.jsonl")"
R="$T/out-venvpass"
STUB_MODE=pass RUN --arm raw-claude --task v-venv-pytest --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" completed)" = true ] && pass "Ra: .venv/bin/python -m pytest -k \"(...)\" is summary-verified and completes" \
    || fail "Ra: venv pytest pass row: $(tail -1 "$R/results.jsonl")"
R="$T/out-venvskip"
FAKE_PYTEST=skip STUB_MODE=pass RUN --arm raw-claude --task v-venv-pytest --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" hidden_pass)" = false ] && pass "Ra: venv pytest reporting only skips does not pass" \
    || fail "Ra: venv pytest skip row: $(tail -1 "$R/results.jsonl")"

# ---- Rc. symlinked or blocked hidden paths in the PR tree grade as fail
echo ORIGINAL > "$T/symlink-target"
R="$T/out-symlink"
STUB_MODE=symlink STUB_SYMLINK_TARGET="$T/symlink-target" RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(cat "$T/symlink-target")" = ORIGINAL ] && [ "$(row "$R/results.jsonl" status)" = '"ok"' ] \
    && [ "$(row "$R/results.jsonl" hidden_pass)" = false ] && [ "$(row "$R/results.jsonl" grade_refused)" != null ] \
    && pass "Rc: symlinked hidden path refused, target untouched" \
    || fail "Rc: symlink target=$(cat "$T/symlink-target") row: $(tail -1 "$R/results.jsonl")"
echo ORIGINAL > "$T/hardlink-target"
R="$T/out-hardlink"
STUB_MODE=hardlink STUB_HARDLINK_TARGET="$T/hardlink-target" RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(cat "$T/hardlink-target")" = ORIGINAL ] && [ "$(row "$R/results.jsonl" pr_opened)" = false ] \
    && pass "Rc: hardlinked hidden path in the arm's tree does not write through" \
    || fail "Rc: hardlink target=$(head -1 "$T/hardlink-target") row: $(tail -1 "$R/results.jsonl")"
R="$T/out-blocker"
STUB_MODE=blocker RUN --arm raw-claude --task v-blocker --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"ok"' ] && [ "$(row "$R/results.jsonl" hidden_pass)" = false ] \
    && pass "Rc: file blocking a hidden parent dir -> graded fail, not harness_error" \
    || fail "Rc: blocker row: $(tail -1 "$R/results.jsonl")"

# ---- Rd. harness_error after the push keeps pr_opened
R="$T/out-chmod"
STUB_MODE=chmodafter STUB_CHMOD_FILE="$TASKS/v-chmod/hidden/hidden_test.sh" RUN --arm raw-claude --task v-chmod --out "$R" >/dev/null 2>&1
chmod 644 "$TASKS/v-chmod/hidden/hidden_test.sh"
[ "$(row "$R/results.jsonl" status)" = '"harness_error"' ] && [ "$(row "$R/results.jsonl" pr_opened)" = true ] \
    && [ "$(row "$R/results.jsonl" completed)" = false ] && pass "Rd: harness_error after push keeps pr_opened" \
    || fail "Rd: row: $(tail -1 "$R/results.jsonl")"

# ---- Re. orphans left by the arm die with its process group
R="$T/out-orphan"
rm -f "$T/orphan.pids"
STUB_MODE=orphan STUB_PID_FILE="$T/orphan.pids" RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
op="$(cat "$T/orphan.pids" 2>/dev/null)"
if [ -n "$op" ] && ! kill -0 "$op" 2>/dev/null; then pass "Re: orphan sleeper killed after the arm exits"; else
    fail "Re: orphan $op still alive"; [ -n "$op" ] && kill "$op" 2>/dev/null; fi

# ---- Rf. hidden tests that pass before the arm make the task invalid
R="$T/out-baseline"
STUB_MODE=noop RUN --arm raw-claude --task v-baseline-pass --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"task_invalid"' ] && pass "Rf: hidden tests passing at repo.ref -> task_invalid" \
    || fail "Rf: row: $(tail -1 "$R/results.jsonl")"
R="$T/out-blocked-base"
STUB_MODE=pass RUN --arm raw-claude --task v-blocked-base --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"task_invalid"' ] && pass "Rf: hidden files unplaceable at repo.ref -> task_invalid" \
    || fail "Rf: blocked-base row: $(tail -1 "$R/results.jsonl")"

# ---- Rh. push time before the run start is flagged
R="$T/out-backdate"
STUB_MODE=backdate RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" push_time_anomaly)" = true ] && [ "$(row "$R/results.jsonl" time_to_pr_s)" = null ] \
    && [ "$(row "$R/results.jsonl" completed)" = false ] && pass "Rh: backdated push flagged, not clamped to 0" \
    || fail "Rh: row: $(tail -1 "$R/results.jsonl")"

# ---- Ri. harness_sha marks a dirty tree (deterministic: a private mini repo
# holding a copy of the harness, run clean and then with an untracked file)
M="$T/minirepo"
mkdir -p "$M/eval/loki10" "$M/providers"
cp "$HERE/harness.py" "$HERE/run.sh" "$HERE/lib-tmp.sh" "$M/eval/loki10/"
cp "$REPO_ROOT/providers/model_catalog.json" "$M/providers/"
git -C "$M" init -q && git -C "$M" add -A && git -C "$M" -c user.name=t -c user.email=t@localhost commit -q -m mini
MRUN() { env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$TASKS" bash "$M/eval/loki10/run.sh" "$@"; }
STUB_MODE=noop MRUN --arm raw-claude --task fx-greet --out "$T/out-mini-clean" >/dev/null 2>&1
touch "$M/untracked.txt"
STUB_MODE=noop MRUN --arm raw-claude --task fx-greet --out "$T/out-mini-dirty" >/dev/null 2>&1
c="$(row "$T/out-mini-clean/results.jsonl" harness_sha)"
d="$(row "$T/out-mini-dirty/results.jsonl" harness_sha)"
case "$c" in *-dirty\" | null | "") cok=0 ;; *) cok=1 ;; esac
case "$d" in *-dirty\") dok=1 ;; *) dok=0 ;; esac
[ "$cok" = 1 ] && [ "$dok" = 1 ] && pass "Ri: harness_sha clean=$c dirty=$d" || fail "Ri: clean=$c dirty=$d"

# ---- 9. --all --parallel
R="$T/out-all"
mkdir -p "$T/tasks-all"
cp -R "$TASKS/fx-greet" "$TASKS/fx-cap" "$T/tasks-all/"
STUB_MODE=noop env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$T/tasks-all" bash "$HERE/run.sh" --arm raw-claude --all --parallel 2 --out "$R" >/dev/null 2>&1
n="$(grep -c . "$R/results.jsonl" 2>/dev/null)"
[ "$n" = 2 ] && pass "--all --parallel 2 records both tasks" || fail "--all rows=$n"

# ---- 10. SIGTERM to run.sh stops only its children and records no verdict
R="$T/out-stop"
rm -f "$T/stop.pids"
STUB_MODE=sleep STUB_PID_FILE="$T/stop.pids" env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$TASKS" bash "$HERE/run.sh" \
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

# ---- Rg. summarize: dedupe, grouping, denominators (synthetic rows)
S_IN="$T/synthetic.jsonl"
python3 - "$S_IN" <<'PY'
import json, sys
def r(run_id, task, arm, status="ok", sha="s1", ended="2026-01-01T00:00:00", **kw):
    d = {"run_id": run_id, "task": task, "arm": arm, "status": status, "model": "m1",
         "harness_sha": sha, "ended": ended, "completed": False, "pr_opened": False,
         "hidden_pass": False, "capped": False, "cost_usd": None, "time_to_pr_s": None}
    d.update(kw)
    return d
rows = [
    r("a1", "t1", "raw-claude", ended="2026-01-01T00:00:01", completed=True, pr_opened=True, hidden_pass=True, time_to_pr_s=10, cost_usd=1.0),
    r("a1", "t1", "raw-claude", ended="2026-01-01T00:00:01", completed=True, pr_opened=True, hidden_pass=True, time_to_pr_s=10, cost_usd=1.0),
    r("a2", "t2", "raw-claude", ended="2026-01-01T00:00:02", completed=True, pr_opened=True, hidden_pass=True, time_to_pr_s=20, cost_usd=1.0),
    r("a3", "t2", "raw-claude", ended="2026-01-01T00:00:03"),
    r("a4", "t3", "raw-claude", "harness_error", ended="2026-01-01T00:00:04", pr_opened=True),
    r("a5", "t4", "raw-claude", "task_invalid", invalid_reason="hidden tests already pass at repo.ref"),
    r("a6", "t4", "v10", completed=True, pr_opened=True, hidden_pass=True, time_to_pr_s=5),
    r("a7", "t1", "v10", "arm_unavailable"),
    r("a8", "t5", "raw-claude", "interrupted"),
    r("a9", "t6", "raw-claude", "harness_error", started="2026-01-01T00:00:05"),
    r("b1", "t1", "raw-claude", sha="s2", completed=True, pr_opened=True, hidden_pass=True, time_to_pr_s=7),
]
with open(sys.argv[1], "w") as f:
    for x in rows:
        f.write(json.dumps(x) + "\n")
PY
S="$(bash "$HERE/summarize" "$S_IN" --json)"
chk() { python3 -c "import json,sys; s=json.loads(sys.argv[1]); g={x['harness_sha']: x for x in s}; assert $2, s" "$S" 2>/dev/null && pass "$1" || fail "$1: $S"; }
chk "Rg: two groups by model and harness_sha" "len(s) == 2 and set(g) == {'s1', 's2'}"
chk "Rg: dedupe keeps the newest row per (task, arm); harness_error after the arm ran counts" \
    "g['s1']['arms']['raw-claude']['evaluated'] == 4 and g['s1']['arms']['raw-claude']['completed'] == 1"
chk "Rg: invalid task excluded from every arm and listed" \
    "[x['task'] for x in g['s1']['invalid_tasks']] == ['t4'] and g['s1']['arms']['v10']['evaluated'] == 0 and g['s1']['arms']['v10']['completion_rate'] is None"
chk "Rg: unavailable and interrupted counted separately" \
    "g['s1']['arms']['v10']['unavailable'] == 1 and g['s1']['arms']['raw-claude']['infra_or_interrupted'] == 1"
chk "Rg: cost n/a when some evaluated runs unmeasured" \
    "g['s1']['arms']['raw-claude']['cost_per_completed_usd'] is None and g['s1']['arms']['raw-claude']['cost_measured_runs'] == 1"
chk "Rg: second group scored on its own" "g['s2']['arms']['raw-claude']['completion_rate'] == 1.0"
md="$(bash "$HERE/summarize" "$S_IN" --markdown)"
printf '%s' "$md" | grep -q "| raw-claude | 1/4 | 25.0% |" && printf '%s' "$md" | grep -q "t2 / raw-claude: no branch pushed" \
    && printf '%s' "$md" | grep -q "t4: hidden tests already pass at repo.ref" && printf '%s' "$md" | grep -q "harness s2" \
    && pass "Rg: Markdown groups, invalid tasks and misses" || fail "Rg: markdown: $md"

# ---- 12. config isolation (EV-3): every arm gets a fresh empty
# CLAUDE_CONFIG_DIR under its rundir (overriding the operator's), plus auth,
# and the auth reaches ONLY the arm process: never setup, grade or argv.
mkdir -p "$T/operator-cfg" && echo "never commit without approval" > "$T/operator-cfg/CLAUDE.md"
mkdir -p "$TASKS/fx-iso" && cp -R "$TASKS/fx-greet/hidden" "$TASKS/fx-iso/hidden"
python3 - "$TASKS/fx-greet/task.json" "$TASKS/fx-iso/task.json" <<'EOF'
import json, sys
t = json.load(open(sys.argv[1]))
probe = 'oauth=${CLAUDE_CODE_OAUTH_TOKEN:+set} key=${ANTHROPIC_API_KEY:+set}'
t.update(id="fx-iso", setup='echo "AUTH-PROBE: %s"' % probe)
t["hidden"]["run"] = 'echo "AUTH-PROBE: %s"; bash hidden_test.sh' % probe
json.dump(t, open(sys.argv[2], "w"))
EOF
FAKE_KEY="fake-apikey-ev3-$$"
# no_auth_outside_arm <outdir> <label>: the setup, baseline (hidden run at
# repo.ref) and grade hidden-run logs each hold at least one probe line
# (positive control), and no probe line in any log carries auth.
no_auth_outside_arm() {
    local lg n bad ok=1
    for lg in setup baseline.stdout grade_hidden.stdout; do
        n="$(cat "$1"/logs/*/"$lg".log 2>/dev/null | grep -c '^AUTH-PROBE:')"
        [ "${n:-0}" -ge 1 ] || { ok=0; echo "  $2 $lg.log: no probe line"; }
    done
    bad="$(cat "$1"/logs/*/*.log 2>/dev/null | grep '^AUTH-PROBE:' | grep -vx 'AUTH-PROBE: oauth= key=')"
    [ -z "$bad" ] || { ok=0; echo "  $2: bad='$bad'"; }
    [ "$ok" = 1 ] && pass "$2: no auth in setup, baseline or grade env" || fail "$2: auth leaked outside the arm"
    if grep -h '^ARGV:' "$1"/logs/*/arm_stderr.log | grep -qF -e "$FAKE_OAUTH" -e "$FAKE_KEY"; then
        fail "$2: auth token in the arm argv"
    else
        pass "$2: no auth token in the arm argv"
    fi
}
for arm in raw-claude v10 legacy; do
    R="$T/out-iso-$arm"
    STUB_MODE=noop STUB_V10_MARKER=1 CLAUDE_CONFIG_DIR="$T/operator-cfg" RUN --arm "$arm" --task fx-iso --out "$R" >/dev/null 2>&1
    # E-38: the engine is pinned per loki arm, so the default flip cannot move EV-5.
    eng="$arm"; [ "$arm" = raw-claude ] && eng="unset"
    want="ENV-CHECK2: config=rundir/claude-config claude_md=absent oauth=set api_key=unset engine=$eng"
    got="$(grep -h '^ENV-CHECK2:' "$R"/logs/*/arm_stderr.log)"
    [ "$got" = "$want" ] && pass "$arm arm env carries the config isolation" || fail "$arm isolation: got '$got'"
    [ "$(row "$R/results.jsonl" auth_source)" = '"env:CLAUDE_CODE_OAUTH_TOKEN"' ] \
        && pass "$arm auth source recorded" || fail "$arm auth_source=$(row "$R/results.jsonl" auth_source)"
    no_auth_outside_arm "$R" "$arm"
done
# An operator API key wins, reaches only the arm (setup AND the PR-branch
# grade run), and the OAuth token is not also passed.
R="$T/out-iso-apikey"
STUB_MODE=pass ANTHROPIC_API_KEY="$FAKE_KEY" RUN --arm raw-claude --task fx-iso --out "$R" >/dev/null 2>&1
got="$(grep -h '^ENV-CHECK2:' "$R"/logs/*/arm_stderr.log)"
[ "$got" = "ENV-CHECK2: config=rundir/claude-config claude_md=absent oauth=unset api_key=set engine=unset" ] \
    && pass "operator API key passed to the arm alone" || fail "api key isolation: got '$got'"
no_auth_outside_arm "$R" "api-key"
if grep -rqF -e "$FAKE_OAUTH" -e "$FAKE_KEY" "$T"/out-*; then fail "auth token value written to a log"; else pass "auth token value appears in no log"; fi

# ---- 13. (E-38) --tasks runs exactly the listed ids; an unknown id is
# refused before any run, so a 5-task measurement never silently shrinks.
R="$T/out-tasks"
STUB_MODE=noop RUN --arm raw-claude --tasks "fx-iso, fx-greet" --out "$R" >/dev/null 2>&1
got="$(python3 -c 'import json,sys; print(",".join(sorted(json.loads(l)["task"] for l in open(sys.argv[1]))))' "$R/results.jsonl" 2>/dev/null)"
[ "$got" = "fx-greet,fx-iso" ] && pass "E-38: --tasks runs exactly the listed tasks" || fail "E-38: --tasks rows='$got'"
R="$T/out-tasks-bad"
STUB_MODE=noop RUN --arm raw-claude --tasks fx-greet,no-such-task --out "$R" >/dev/null 2>&1
rc=$?
[ "$rc" = 2 ] && [ ! -s "$R/results.jsonl" ] && pass "E-38: --tasks with an unknown id exits 2 with no rows" \
    || fail "E-38: bad --tasks rc=$rc rows=$(wc -l < "$R/results.jsonl" 2>/dev/null)"

# ---- 14. (E-52) v10-only engine knob passthrough
cat > "$T/bin/e52-stub" <<'EOF'
#!/usr/bin/env bash
echo "ENV-CHECK3: entry=${LOKI_TS_ENTRY:-unset} plan=${LOKI_E10_PLAN:-unset} task_text=${LOKI_E10_TASK_TEXT:-unset} gh=${GH_TOKEN:+set}" >&2
EOF
chmod +x "$T/bin/e52-stub"
GH_CANARY="e52-gh-canary-$$"
R="$T/out-e52-v10"
LOKI_TS_ENTRY="/fake/dist/loki.js" LOKI_E10_PLAN="plan-value" LOKI_E10_TASK_TEXT="should-not-leak" GH_TOKEN="$GH_CANARY" \
    LOKI_EVAL_LOKI_BIN="$T/bin/e52-stub" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
got="$(grep -h '^ENV-CHECK3:' "$R"/logs/*/arm_stderr.log)"
[ "$got" = "ENV-CHECK3: entry=/fake/dist/loki.js plan=plan-value task_text=unset gh=" ] \
    && pass "E-52: v10 arm gets LOKI_TS_ENTRY and allowlisted LOKI_E10_PLAN, not LOKI_E10_TASK_TEXT or GH_TOKEN" \
    || fail "E-52: v10 ENV-CHECK3: got '$got'"
grep -rqF "$GH_CANARY" "$R" && fail "E-52: GH_TOKEN canary reached a log" || pass "E-52: GH_TOKEN canary in no log"

R="$T/out-e52-legacy"
LOKI_TS_ENTRY="/fake/dist/loki.js" LOKI_E10_PLAN="plan-value" GH_TOKEN="$GH_CANARY" \
    LOKI_EVAL_LOKI_BIN="$T/bin/e52-stub" RUN --arm legacy --task fx-greet --out "$R" >/dev/null 2>&1
got="$(grep -h '^ENV-CHECK3:' "$R"/logs/*/arm_stderr.log)"
[ "$got" = "ENV-CHECK3: entry=unset plan=unset task_text=unset gh=" ] \
    && pass "E-52: legacy arm gets neither LOKI_TS_ENTRY nor LOKI_E10_PLAN" || fail "E-52: legacy ENV-CHECK3: got '$got'"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
