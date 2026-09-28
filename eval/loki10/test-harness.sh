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
#  Rj (EV-10) a setsid-escaped orphan (own process group) in the clone is
#     still killed, by cwd, not process-group signal
#  Rk (EV-10) same, chdir'd out of the clone, reaped by its own .loki/*.pid
#     entry instead; a decoy PID predating the run in the same file survives
#  Rl (EV-10) pid-file candidates are filtered by pid<=1 and by age before
#     any kill is attempted (direct filter check, no live kill(-1))
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
#  15. (EV-13) expected_outcome=no_change_needed: badoutcome value rejected
#      by the validator; a hidden test failing at repo.ref -> task_invalid
#      (inverted from the normal rule); completed only with no PR, no source
#      diff and the arm's own evidence (v10 receipt verdict, or the
#      raw-claude/legacy textual claim) -- a PR, a dirty diff, missing
#      evidence, a wrong v10 verdict or a failed regression check each alone
#      block completion, checked for v10, raw-claude and legacy; v10's own
#      sealed Wall test file left in the tree never counts as that diff, but
#      a real source change alongside it still does
#  16. (D30) validate accepts tier:medium, rejects an unknown tier value; a
#      task with no tier field defaults to small; --all --tier medium selects
#      only the medium task
#  17. (E-62/EV-8) v10 defaults to the repo's own bin/loki (never a global
#      install) and the manifest records the resolved binary path plus the
#      agent SDK version; v10 and legacy refuse (nonzero exit, no results
#      row) when loki-ts/node_modules differs from bun.lock -- a stale
#      installed version and a missing node_modules dir alike; raw-claude is
#      not gated by loki-ts at all
#  18. (D34) measure-size.py offline against the real tiered tasks -> rc=0;
#      negative controls -> rc=1 each: a temp large fixture at 3 files / 149
#      added lines (below both the 4-file and 150-line bars), a tiered task
#      whose refdiff was removed (in a temp copy, real tasks untouched), and
#      --online against an unreachable source
#  19. (S41-01) provider_cost accepts a partial-stream record (E-98e) and
#      records cost_partial_usd; LOKI_E10_CASCADE is allowlisted into arm_env
#      while an unlisted LOKI_E10_* knob stays scrubbed; new row fields
#      (tier, tokens, tokens_by_stage, first_turn_prompt_tokens, escalations,
#      attempts) default correctly and raw-claude tokens are read from
#      arm_stdout usage
#  19. (D38/EV-12E) measure-size.py excludes typing-examples/ and examples/
#      from the file count: an attrs-602-shaped fixture (3 product files
#      plus 2 typing-examples files) measures at exactly 3 files / 180
#      lines -- pinned columns, since a self-referential max_medium_lines
#      keeps this alone-in-its-set fixture's tier verdict "medium" either
#      way and cannot itself expose the regression
#  20. (D38/EV-12E) validate requires hidden.provenance, hidden.sha256 (every
#      hidden file re-hashed and compared, not just present) and a non-empty
#      hidden.requirements[] naming a hidden test id, on tier=large tasks
#      only; checked against a hand-built fixture (not a real task, so this
#      leg needs no sibling branch) and 4 negative controls, each asserted
#      by its rejection message, not just a nonzero exit (a traceback also
#      exits nonzero). check_lg_shortcuts walks tasks/lg-*/shortcuts/*.patch
#      (0 on this branch today): baseline at repo.ref must be RED by
#      assertion, never collection-only; the patch must apply; the trusted
#      hidden files are re-overlaid after the patch (never left to whatever
#      the patch itself touched) and the hidden run must still not complete.
#      4 hermetic local-git fixtures prove the checker itself: a full-pass
#      shortcut, a collection-only "RED", a patch that will not apply, and a
#      genuine shortcut left red
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
# EV-13: expected_outcome=no_change_needed. v-nochange's seed already has the
# fix (greet.sh prints "hello"), so the hidden test is a regression check and
# passes at repo.ref. v-nochange-badbase reuses fx-greet's unfixed seed, so
# the hidden test fails at repo.ref -- invalid for this expected outcome.
seed_task v-nochange fx-greet "t['expected_outcome'] = 'no_change_needed'" \
    'printf "#!/usr/bin/env bash\ngreet() { echo hello; }\n" > greet.sh'
seed_task v-nochange-badbase fx-greet "t['expected_outcome'] = 'no_change_needed'" ":"

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
# True only when the key is actually present in the row (row() prints "null"
# both for an absent key and for a present key holding null -- a field this
# slice adds must be checked with haskey, not row() alone, or a run against
# an older harness.py that lacks the key entirely reads as a false pass).
haskey() { python3 -c 'import json,sys; r=[json.loads(l) for l in open(sys.argv[1])][-1]; sys.exit(0 if sys.argv[2] in r else 1)' "$1" "$2"; }

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
bad_case badoutcome "t['expected_outcome']='built_it'"

# ---- 2. leak check positive control
mkdir -p "$T/leak" && touch "$T/leak/hidden_test.sh"
out="$(cd "$T/leak" && STUB_MODE=check bash "$STUB" 2>&1)"; rc=$?
if [ "$rc" = 97 ] && printf '%s' "$out" | grep -q "HIDDEN LEAK"; then pass "stub fails loudly on a visible hidden file"; else fail "leak control rc=$rc out=$out"; fi

export LOKI_EVAL_CLAUDE_BIN="$T/bin/claude-stub" LOKI_EVAL_LOKI_BIN="$T/bin/loki-stub"
# E-101: keep the durable-archive writes this fixture triggers out of the
# real repo and the operator's real $HOME/loki-ci-logs.
export LOKI_EVAL_ARCHIVE_REPO_ROOT="$T/archive-repo-root" LOKI_EVAL_ARCHIVE="$T/archive-ext"

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

# ---- Rj. (EV-10) a setsid-escaped orphan (own process group, own session,
# same cwd as the clone -- what a legacy detached /tmp/loki-run-*.sh loop
# looks like once it reparents to launchd) is still reaped by cwd, not by
# the process-group KILL above. The "escaped" marker (only written once the
# stub confirmed pgid==pid) rules out a vacuous pass from a spawn that never
# actually left the group.
R="$T/out-setsidorphan"
rm -f "$T/setsidorphan.pids"
STUB_MODE=setsidorphan STUB_PID_FILE="$T/setsidorphan.pids" RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
sp="$(sed -n '1p' "$T/setsidorphan.pids" 2>/dev/null)"
esc="$(sed -n '2p' "$T/setsidorphan.pids" 2>/dev/null)"
if [ "$esc" = escaped ] && [ -n "$sp" ] && ! kill -0 "$sp" 2>/dev/null; then
    pass "Rj: setsid-escaped clone orphan reaped after the arm exits"
else
    fail "Rj: setsid orphan sp=$sp esc=$esc still alive"; [ -n "$sp" ] && kill -9 "$sp" 2>/dev/null
fi

# ---- Rk. (EV-10) a setsid orphan that chdir'd OUT of the clone before exec
# (so the cwd reap above cannot see it) is still reaped, from its own PID
# recorded in a *.pid file under the clone's .loki/ -- what legacy loki
# itself records. A decoy PID that predates this run, planted in the same
# pid file (plus a literal "-1"), must survive: the elapsed-time gate and the
# pid<=1 refusal are the only things standing between a stray or forged
# entry and os.kill.
R="$T/out-setsidorphan-pidfile"
rm -f "$T/setsidorphan-pidfile.pids"
sleep 300 >/dev/null 2>&1 &
DECOY=$!
sleep 6  # older than the harness's own age-gate margin before the run even starts
STUB_MODE=setsidorphan STUB_PID_FILE="$T/setsidorphan-pidfile.pids" STUB_ORPHAN_CHDIR=/tmp \
    STUB_ORPHAN_PIDFILE=".loki/run.pid" STUB_ORPHAN_DECOY_PID="$DECOY" \
    RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
sp="$(sed -n '1p' "$T/setsidorphan-pidfile.pids" 2>/dev/null)"
esc="$(sed -n '2p' "$T/setsidorphan-pidfile.pids" 2>/dev/null)"
if [ "$esc" = escaped ] && [ -n "$sp" ] && ! kill -0 "$sp" 2>/dev/null; then
    pass "Rk: setsid orphan recorded in a .loki/*.pid file (cwd outside the clone) is reaped"
else
    fail "Rk: pidfile orphan sp=$sp esc=$esc still alive"; [ -n "$sp" ] && kill -9 "$sp" 2>/dev/null
fi
if kill -0 "$DECOY" 2>/dev/null; then pass "Rk: a decoy PID predating the run is not killed via a stray pid-file entry"
else fail "Rk: decoy PID $DECOY (predates the run) was killed"; fi
kill "$DECOY" 2>/dev/null; wait "$DECOY" 2>/dev/null

# ---- Rl. (EV-10) pid-file candidates are filtered before any kill is even
# attempted: pid<=1 (kill(2) treats -1/0 as "every process the caller may
# signal", never a single-PID cleanup) and a PID older than the run's own
# start are both refused. The age case uses a real spawned process, not
# os.getpid(): the caller's own pid is already rejected by the identity
# check in _pid_is_ours regardless of age, so testing with it would pass
# vacuously without ever exercising the age filter. Exercises the filter
# function directly so this never risks a real kill(-1, SIGKILL) in a
# shared environment.
sleep 300 >/dev/null 2>&1 &
RL_OLD=$!
sleep 6  # older than the harness's own age-gate margin before the run "starts"
if python3 - "$HERE/harness.py" "$RL_OLD" <<'PY'
import importlib.util, os, sys, tempfile, time
spec = importlib.util.spec_from_file_location("harness", sys.argv[1])
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
old_pid = int(sys.argv[2])
d = tempfile.mkdtemp()
os.makedirs(os.path.join(d, ".loki"))
with open(os.path.join(d, ".loki", "run.pid"), "w") as f:
    f.write("-1\n")
pids = h._clone_orphan_pids(d, time.time() - 3600)
assert -1 not in pids and 0 not in pids and 1 not in pids, ("pid<=1 not filtered", pids)
with open(os.path.join(d, ".loki", "old.pid"), "w") as f:
    f.write(str(old_pid) + "\n")  # a real process that predates `started` below
pids = h._clone_orphan_pids(d, time.time())
assert old_pid not in pids, ("pre-run pid not filtered by age", pids)
PY
then pass "Rl: pid-file candidates filtered by pid<=1 and by age before any kill"
else fail "Rl: pid-file filter"; fi
kill "$RL_OLD" 2>/dev/null; wait "$RL_OLD" 2>/dev/null

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

# ---- 17. (E-62/EV-8) v10 arm binary default + loki-ts lockfile refusal.
# Reuses the Ri minirepo M (harness.py resolves REPO as its own two-parents-up,
# so M is "the repo" for a run through M/eval/loki10/run.sh) with its own
# bin/loki stub and a minimal loki-ts/{bun.lock,node_modules}, so this never
# touches the real loki-ts or invokes the real claude/loki.
mkdir -p "$M/bin"
ln -s "$STUB" "$M/bin/loki"
mkdir -p "$M/loki-ts/node_modules/fake-pinned-dep"
cat > "$M/loki-ts/bun.lock" <<'EOF'
{
  "lockfileVersion": 1,
  "workspaces": { "": { "dependencies": { "fake-pinned-dep": "1.2.3" } } },
  "packages": { "fake-pinned-dep": ["fake-pinned-dep@1.2.3", "", {}, ""] }
}
EOF
set_dep_version() { echo "{\"name\":\"fake-pinned-dep\",\"version\":\"$1\"}" > "$M/loki-ts/node_modules/fake-pinned-dep/package.json"; }
set_dep_version 1.2.3
MRUN_NOBIN() { env -u LOKI_EVAL_LOKI_BIN -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$TASKS" bash "$M/eval/loki10/run.sh" "$@"; }

R="$T/out-mini-v10bin"
MRUN_NOBIN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
got="$(python3 -c 'import json,sys; print([json.loads(l) for l in open(sys.argv[1])][-1]["arm_binary"])' "$R/manifest.jsonl" 2>/dev/null)"
[ "$got" = "$M/bin/loki" ] && pass "E-62: v10 arm defaults to the repo's own bin/loki, not a global install" \
    || fail "E-62: arm_binary=$got"
has_sdk="$(python3 -c 'import json,sys; print("agent_sdk_version" in [json.loads(l) for l in open(sys.argv[1])][-1])' "$R/manifest.jsonl" 2>/dev/null)"
[ "$has_sdk" = True ] && pass "E-62: manifest records agent_sdk_version" \
    || fail "E-62: manifest missing agent_sdk_version: $(cat "$R/manifest.jsonl" 2>/dev/null)"

# A node_modules version that does not match bun.lock's resolved version -> refused.
set_dep_version 9.9.9
R="$T/out-mini-lockmismatch"
out="$(MRUN_NOBIN --arm v10 --task fx-greet --out "$R" 2>&1)"; rc=$?
[ "$rc" != 0 ] && [ ! -s "$R/results.jsonl" ] && printf '%s' "$out" | grep -q "node_modules differs from bun.lock" \
    && pass "E-62: v10 refuses when loki-ts/node_modules differs from bun.lock" \
    || fail "E-62: lockfile mismatch rc=$rc out=$out"
set_dep_version 1.2.3

# node_modules missing entirely -> also refused, for both loki arms.
rm -rf "$M/loki-ts/node_modules"
R="$T/out-mini-nomodules"
out="$(MRUN_NOBIN --arm v10 --task fx-greet --out "$R" 2>&1)"; rc=$?
[ "$rc" != 0 ] && [ ! -s "$R/results.jsonl" ] && printf '%s' "$out" | grep -q "node_modules is missing" \
    && pass "E-62: v10 refuses when loki-ts/node_modules is missing" \
    || fail "E-62: missing node_modules rc=$rc out=$out"
R="$T/out-mini-legacy-nomodules"
out="$(MRUN_NOBIN --arm legacy --task fx-greet --out "$R" 2>&1)"; rc=$?
[ "$rc" != 0 ] && printf '%s' "$out" | grep -q "node_modules is missing" \
    && pass "E-62: legacy arm also refuses on a missing loki-ts/node_modules" \
    || fail "E-62: legacy missing node_modules rc=$rc out=$out"
mkdir -p "$M/loki-ts/node_modules/fake-pinned-dep"
set_dep_version 1.2.3

# raw-claude never touches loki-ts, so it is never gated by this check.
rm -rf "$M/loki-ts/node_modules"
R="$T/out-mini-rawclaude-lockcheck"
STUB_MODE=noop MRUN_NOBIN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
[ -s "$R/results.jsonl" ] && pass "E-62: raw-claude arm is not gated by the loki-ts lockfile check" \
    || fail "E-62: raw-claude row missing: $(cat "$R/results.jsonl" 2>/dev/null)"
mkdir -p "$M/loki-ts/node_modules/fake-pinned-dep"
set_dep_version 1.2.3

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

# ---- 15. (EV-13) expected_outcome=no_change_needed
R="$T/out-nc-badbase"
STUB_MODE=noop RUN --arm raw-claude --task v-nochange-badbase --out "$R" >/dev/null 2>&1
[ "$(row "$R/results.jsonl" status)" = '"task_invalid"' ] \
    && pass "EV-13: hidden test failing at repo.ref -> task_invalid for no_change_needed" \
    || fail "EV-13: badbase row: $(tail -1 "$R/results.jsonl")"

# raw-claude and legacy: same textual-evidence rule, exercised on both arms.
for arm in raw-claude legacy; do
    R="$T/out-nc-$arm-pass"
    STUB_MODE=alreadydone RUN --arm "$arm" --task v-nochange --out "$R" >/dev/null 2>&1
    J="$R/results.jsonl"
    [ "$(row "$J" completed)" = true ] && [ "$(row "$J" pr_opened)" = false ] \
        && [ "$(row "$J" no_source_diff)" = true ] && [ "$(row "$J" no_change_evidence)" = true ] \
        && [ "$(row "$J" hidden_pass)" = true ] \
        && pass "EV-13 $arm: no diff + claim text + regression pass -> completed" \
        || fail "EV-13 $arm pass row: $(tail -1 "$J")"

    R="$T/out-nc-$arm-noevidence"
    STUB_MODE=noop RUN --arm "$arm" --task v-nochange --out "$R" >/dev/null 2>&1
    J="$R/results.jsonl"
    [ "$(row "$J" no_change_evidence)" = false ] && [ "$(row "$J" completed)" = false ] \
        && pass "EV-13 $arm: no claim text -> not completed" || fail "EV-13 $arm noevidence row: $(tail -1 "$J")"

    R="$T/out-nc-$arm-dirty"
    STUB_MODE=dirtynoop RUN --arm "$arm" --task v-nochange --out "$R" >/dev/null 2>&1
    J="$R/results.jsonl"
    [ "$(row "$J" no_source_diff)" = false ] && [ "$(row "$J" completed)" = false ] \
        && pass "EV-13 $arm: uncommitted source diff, no push -> not completed" \
        || fail "EV-13 $arm dirty row: $(tail -1 "$J")"

    R="$T/out-nc-$arm-pr"
    STUB_MODE=nofix RUN --arm "$arm" --task v-nochange --out "$R" >/dev/null 2>&1
    J="$R/results.jsonl"
    [ "$(row "$J" pr_opened)" = true ] && [ "$(row "$J" completed)" = false ] \
        && pass "EV-13 $arm: a pushed branch is never completed for no_change_needed" \
        || fail "EV-13 $arm pr row: $(tail -1 "$J")"
done

# v10: evidence comes from the receipt verdict, not text.
R="$T/out-nc-v10-pass"
STUB_MODE=noop STUB_V10_MARKER=1 STUB_V10_VERDICT=ALREADY_SATISFIED RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" completed)" = true ] && [ "$(row "$J" no_change_evidence)" = true ] \
    && pass "EV-13 v10: ALREADY_SATISFIED receipt + no diff -> completed" || fail "EV-13 v10 pass row: $(tail -1 "$J")"

R="$T/out-nc-v10-wrongverdict"
STUB_MODE=noop STUB_V10_MARKER=1 STUB_V10_VERDICT=VERIFIED RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" no_change_evidence)" = false ] && [ "$(row "$J" completed)" = false ] \
    && pass "EV-13 v10: a non-ALREADY_SATISFIED verdict -> not completed" || fail "EV-13 v10 wrongverdict row: $(tail -1 "$J")"

R="$T/out-nc-v10-dirty"
STUB_MODE=dirtynoop STUB_V10_MARKER=1 STUB_V10_VERDICT=ALREADY_SATISFIED RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" no_source_diff)" = false ] && [ "$(row "$J" completed)" = false ] \
    && pass "EV-13 v10: ALREADY_SATISFIED verdict but a source diff -> not completed" \
    || fail "EV-13 v10 dirty row: $(tail -1 "$J")"

R="$T/out-nc-v10-pr"
STUB_MODE=nofix STUB_V10_MARKER=1 STUB_V10_VERDICT=ALREADY_SATISFIED RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" pr_opened)" = true ] && [ "$(row "$J" completed)" = false ] \
    && pass "EV-13 v10: a pushed branch is never completed even with ALREADY_SATISFIED" \
    || fail "EV-13 v10 pr row: $(tail -1 "$J")"

# v10: the Wall stage's own side effect (a loki_wall_* file left in the
# tracked tree, receipt.wall.files pointing at it) must never itself read as
# a source change -- the exact repro from the EV-13 review.
R="$T/out-nc-v10-wall"
STUB_MODE=noop STUB_V10_MARKER=1 STUB_V10_VERDICT=ALREADY_SATISFIED STUB_V10_WALL=1 \
    RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" no_source_diff)" = true ] && [ "$(row "$J" completed)" = true ] \
    && pass "EV-13 v10: Wall's own sealed test file left in the tree -> still no_source_diff, completed" \
    || fail "EV-13 v10 wall row: $(tail -1 "$J")"

# v10: the Wall exclusion must not swallow a REAL source change alongside it.
R="$T/out-nc-v10-wall-and-dirty"
STUB_MODE=dirtynoop STUB_V10_MARKER=1 STUB_V10_VERDICT=ALREADY_SATISFIED STUB_V10_WALL=1 \
    RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" no_source_diff)" = false ] && [ "$(row "$J" completed)" = false ] \
    && pass "EV-13 v10: Wall's file excluded but a real source diff still blocks completion" \
    || fail "EV-13 v10 wall+dirty row: $(tail -1 "$J")"

# v10: a receipt cannot launder a real edit as a sealed Wall file by naming
# it in wall.files alone -- no loki_wall_ prefix, no sealed copy backing it.
R="$T/out-nc-v10-fakewall"
STUB_MODE=dirtynoop STUB_V10_MARKER=1 STUB_V10_VERDICT=ALREADY_SATISFIED STUB_V10_WALL=fake \
    RUN --arm v10 --task v-nochange --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" no_source_diff)" = false ] && [ "$(row "$J" completed)" = false ] \
    && pass "EV-13 v10: a receipt naming a real edit as a Wall file does not exclude it" \
    || fail "EV-13 v10 fakewall row: $(tail -1 "$J")"
# ---- 16. (D30) tier field: validate + --tier selection
bad_case tier_bogus "t['tier']='bogus'"
seed_task fx-medium fx-greet "t['tier']='medium'" ":"
if H validate "$TASKS/fx-medium" >/dev/null 2>&1; then pass "validator accepts tier:medium"; else fail "validator rejected tier:medium"; fi
if H validate "$TASKS/fx-greet" >/dev/null 2>&1; then pass "validator accepts a task with no tier (defaults small)"; else fail "validator rejected a tierless task"; fi

R="$T/out-tier"
mkdir -p "$T/tasks-tier"
cp -R "$TASKS/fx-greet" "$TASKS/fx-medium" "$T/tasks-tier/"
STUB_MODE=noop env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$T/tasks-tier" bash "$HERE/run.sh" \
    --arm raw-claude --all --tier medium --out "$R" >/dev/null 2>&1
got="$(python3 -c 'import json,sys; print(",".join(sorted(json.loads(l)["task"] for l in open(sys.argv[1]))))' "$R/results.jsonl" 2>/dev/null)"
[ "$got" = "fx-medium" ] && pass "D30: --all --tier medium selects only the medium task" || fail "D30: --tier rows='$got'"

# An invalid tier value must fail loudly under --tier selection, never be
# silently dropped and shrink the run (E-38 contract). A valid medium task
# sits alongside fx-bad so a selection filter that drops fx-bad (tier=None
# no longer matching) still has fx-good to run on and would exit 0, not 2:
# without this second task, `not tasks` alone would return 2 and mask a
# reverted fix (found in EV-11 review).
mkdir -p "$T/tasks-tier-bad" && cp -R "$TASKS/fx-medium" "$T/tasks-tier-bad/fx-bad"
python3 -c "import json; p='$T/tasks-tier-bad/fx-bad/task.json'; t=json.load(open(p)); t['id']='fx-bad'; t['tier']='Medium'; json.dump(t, open(p,'w'))"
cp -R "$TASKS/fx-medium" "$T/tasks-tier-bad/fx-good"
python3 -c "import json; p='$T/tasks-tier-bad/fx-good/task.json'; t=json.load(open(p)); t['id']='fx-good'; json.dump(t, open(p,'w'))"
STUB_MODE=noop env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$T/tasks-tier-bad" bash "$HERE/run.sh" \
    --arm raw-claude --all --tier medium --out "$T/out-tier-bad" >/dev/null 2>&1
rc=$?
[ "$rc" = 2 ] && pass "D30: --tier medium exits 2 on a task with an invalid tier value, not a silent drop" \
    || fail "D30: bad-tier rc=$rc"

# ---- 18. (D34) measure-size.py: real-task offline pass + negative controls
MS="$REPO_ROOT/eval/loki10/measure-size.py"

python3 "$MS" >"$T/ms-real.out" 2>&1
rc=$?
[ "$rc" = 0 ] && pass "D34: measure-size.py offline passes on the real tiered tasks" \
    || fail "D34: measure-size.py offline rc=$rc: $(cat "$T/ms-real.out")"
grep -E -q "^pub-attrs-1313[[:space:]]+medium[[:space:]]+4[[:space:]]+74[[:space:]]+OK" "$T/ms-real.out" \
    && pass "D34: pub-attrs-1313 reads 4 files, 74 lines, OK" \
    || fail "D34: pub-attrs-1313 row missing/wrong: $(cat "$T/ms-real.out")"

# fake_diff PATH N1 N2 [N3]: write a synthetic filtered diff with one block
# per size, each block a single-file addition of that many '+' lines.
fake_diff() {
    local path="$1"; shift
    python3 - "$path" "$@" <<'PY'
import sys
def block(idx, n):
    p = "m%d.py" % idx
    out = ["diff --git a/%s b/%s\n" % (p, p), "--- a/%s\n" % p, "+++ b/%s\n" % p,
           "@@ -1,1 +1,%d @@\n" % (n + 1), " a\n"]
    out += ["+x%d\n" % i for i in range(n)]
    return "".join(out)
out_path, sizes = sys.argv[1], [int(s) for s in sys.argv[2:]]
with open(out_path, "w") as f:
    for i, n in enumerate(sizes):
        f.write(block(i, n))
PY
}

# Negative control A: a large-tier fixture at 3 files / 149 added lines --
# below both the >=4-file and >=150-line D34 bars, must MISS (rc=1).
mkdir -p "$T/ms-large/tasks/fake-large" "$T/ms-large/refdiff"
cat > "$T/ms-large/tasks/fake-large/task.json" <<'JSON'
{"id": "fake-large", "tier": "large", "repo": {"source": "https://example.invalid/nope.git", "ref": "deadbeef"}}
JSON
fake_diff "$T/ms-large/refdiff/fake-large.diff" 50 50 49
python3 "$MS" --tasks-dir "$T/ms-large/tasks" --refdiff-dir "$T/ms-large/refdiff" >"$T/ms-large.out" 2>&1
rc=$?
[ "$rc" = 1 ] && pass "D34: 3 files / 149 lines below the large bar -> rc=1" \
    || fail "D34: large-fixture rc=$rc: $(cat "$T/ms-large.out")"

# Negative control B: a tiered task with its refdiff removed, in a temp copy
# (the real tasks/refdiff dirs are never touched).
mkdir -p "$T/ms-norefdiff/tasks" "$T/ms-norefdiff/refdiff"
cp -R "$REPO_ROOT/eval/loki10/tasks/pub-attrs-1313" "$T/ms-norefdiff/tasks/"
python3 "$MS" --tasks-dir "$T/ms-norefdiff/tasks" --refdiff-dir "$T/ms-norefdiff/refdiff" >"$T/ms-norefdiff.out" 2>&1
rc=$?
[ "$rc" = 1 ] && grep -q "missing refdiff" "$T/ms-norefdiff.out" \
    && pass "D34: tiered task with no refdiff -> rc=1" \
    || fail "D34: no-refdiff rc=$rc: $(cat "$T/ms-norefdiff.out")"

# E-136: a second file whose change is docstring/annotation/comment only must
# not count; a real behavioral second file must.
python3 - "$MS" >"$T/ms-e136.out" 2>&1 <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ms", sys.argv[1])
ms = importlib.util.module_from_spec(spec); spec.loader.exec_module(ms)
def blk(p, old, new):
    return ("diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -1,3 +1,3 @@\n" % (p, p, p, p)
            + "".join("-%s\n" % l for l in old) + "".join("+%s\n" % l for l in new))
main = blk("pkg/a.py", ["def f():", "    return 1"], ["def f():", "    return 2"])
doc = blk("pkg/b.py", ['def g():', '    """old doc"""', '    return 1'], ['def g():', '    """new doc"""', '    return 1'])
ann = blk("pkg/c.py", ["def h(x):", "    y = x", "    return y"], ["def h(x: int) -> int:", "    y: int = x", "    return y"])
beh = blk("pkg/d.py", ["def k(x):", "    return x"], ["def k(x):", "    return x + 1"])
bad = blk("pkg/e.py", ["    return ("], ["    return (1,"])
assert ms.measure(main + doc)[0] == 1, "docstring-only second file counted"
assert ms.measure(main + ann)[0] == 1, "annotation-only second file counted"
assert ms.measure(main + beh)[0] == 2, "behavioral second file not counted"
assert ms.measure(main + bad)[0] == 2, "unparseable file must count (fail safe)"
PY
rc=$?
[ "$rc" = 0 ] && pass "E-136: docstring/annotation-only files do not count; behavioral and unparseable files do" \
    || fail "E-136: rc=$rc: $(cat "$T/ms-e136.out")"

# Negative control C: --online against an unreachable source -> rc=1. A
# nonexistent local path (never DNS) so this is hermetic and fast rather
# than at the mercy of a resolver; measure-size.py's own GIT_TIMEOUT_S
# bounds the git subprocess, so no bash-level timeout wrapper is needed
# (and none is assumed installed). Two 1-line files so the task is
# offline-OK on its own (files>=2); the only way this can miss is the
# online fetch itself.
mkdir -p "$T/ms-unreachable/tasks/fake-task" "$T/ms-unreachable/refdiff"
cat > "$T/ms-unreachable/tasks/fake-task/task.json" <<JSON
{"id": "fake-task", "tier": "medium", "repo": {"source": "$T/no-such-repo", "ref": "deadbeef"}}
JSON
cat > "$T/ms-unreachable/tasks/fake-task/NOTES.md" <<'NOTES'
- merge_sha: cafef00d
NOTES
fake_diff "$T/ms-unreachable/refdiff/fake-task.diff" 1 1
python3 "$MS" --online --tasks-dir "$T/ms-unreachable/tasks" --refdiff-dir "$T/ms-unreachable/refdiff" \
    >"$T/ms-unreachable.out" 2>&1
rc=$?
[ "$rc" = 1 ] && grep -q "online fetch failed" "$T/ms-unreachable.out" \
    && pass "D34: --online against an unreachable source -> rc=1" \
    || fail "D34: unreachable-source rc=$rc: $(cat "$T/ms-unreachable.out")"

# ---- 19. (S41-01) partial-stream cost, the allowlist grant, and the new row fields
# A minimal inline arm: no push (cost_usd is set unconditionally right after
# the arm exits, whether or not it ever opens a PR -- same as R2's estimate
# stub above), just an efficiency record with cost_source partial-stream
# (E-98e's killed-session shape).
cat > "$T/bin/s41-partial-stub" <<'EOF'
#!/usr/bin/env bash
mkdir -p .loki/metrics/efficiency
printf '{"iteration": 1, "cost_source": "partial-stream", "cost_usd": 0.5, "input_tokens": 10}\n' \
    > .loki/metrics/efficiency/iteration-1.json
echo '{"type":"result"}'
EOF
chmod +x "$T/bin/s41-partial-stub"
R="$T/out-s41-partial"
LOKI_EVAL_LOKI_BIN="$T/bin/s41-partial-stub" RUN --arm legacy --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" cost_usd)" = 0.5 ] && [ "$(row "$J" cost_partial_usd)" = 0.5 ] \
    && [ "$(row "$J" cost_source)" = '"loki efficiency records (cost_source=partial-stream)"' ] \
    && pass "S41-01: partial-stream record priced, not null; cost_partial_usd recorded" \
    || fail "S41-01: partial row: $(tail -1 "$J")"

cat > "$T/bin/e52b-stub" <<'EOF'
#!/usr/bin/env bash
echo "ENV-CHECK4: cascade=${LOKI_E10_CASCADE:-unset} notallowed=${LOKI_E10_NOTALLOWED:-unset}" >&2
EOF
chmod +x "$T/bin/e52b-stub"
R="$T/out-s41-cascade"
LOKI_E10_CASCADE=0 LOKI_E10_NOTALLOWED=leak LOKI_EVAL_LOKI_BIN="$T/bin/e52b-stub" \
    RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
got="$(grep -h '^ENV-CHECK4:' "$R"/logs/*/arm_stderr.log)"
[ "$got" = "ENV-CHECK4: cascade=0 notallowed=unset" ] \
    && pass "S41-01: LOKI_E10_CASCADE allowlisted, LOKI_E10_NOTALLOWED still scrubbed" \
    || fail "S41-01: cascade env: got '$got'"

# tier default, and the new fields' null defaults (never 0/{}) on a v10 pass
# with no cost events at all
R="$T/out-s41-rowfields"
STUB_MODE=pass STUB_V10_MARKER=1 RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
haskey "$J" tier && [ "$(row "$J" tier)" = '"small"' ] && pass "S41-01: tier defaults to small" \
    || fail "S41-01: tier=$(row "$J" tier) present=$(haskey "$J" tier; echo $?)"
haskey "$J" tokens && haskey "$J" tokens_by_stage && haskey "$J" first_turn_prompt_tokens \
    && [ "$(row "$J" tokens)" = null ] && [ "$(row "$J" tokens_by_stage)" = null ] \
    && [ "$(row "$J" first_turn_prompt_tokens)" = null ] \
    && [ "$(row "$J" escalations)" = 0 ] && [ "$(row "$J" attempts)" = 0 ] \
    && pass "S41-01: tokens/tokens_by_stage/first_turn_prompt_tokens default null (never 0, and present), escalations/attempts default 0" \
    || fail "S41-01: defaults: tokens=$(row "$J" tokens) by_stage=$(row "$J" tokens_by_stage) fft=$(row "$J" first_turn_prompt_tokens) esc=$(row "$J" escalations) att=$(row "$J" attempts)"

# raw-claude tokens harvested from the same JSON the cost stub already emits;
# null (not zero) when the JSON carries no usage object at all -- but the
# key must still be PRESENT, since row() prints "null" for a missing key too
# (a harness that never sets row["tokens"] at all must not read as a pass)
cat > "$T/bin/s41-usage-stub" <<'EOF'
#!/usr/bin/env bash
echo '{"type":"result","total_cost_usd":0.25,"usage":{"input_tokens":11,"output_tokens":22,"cache_read_input_tokens":33,"cache_creation_input_tokens":44}}'
EOF
chmod +x "$T/bin/s41-usage-stub"
R="$T/out-s41-rawtokens"
LOKI_EVAL_CLAUDE_BIN="$T/bin/s41-usage-stub" RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" tokens)" = '{"input": 11, "output": 22, "cache_read": 33, "cache_write": 44}' ] \
    && pass "S41-01: raw-claude tokens read from arm_stdout usage" || fail "S41-01: raw tokens=$(row "$J" tokens)"
R="$T/out-s41-rawtokens-none"
STUB_MODE=pass RUN --arm raw-claude --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
haskey "$J" tokens && [ "$(row "$J" tokens)" = null ] && pass "S41-01: raw-claude tokens null (and present) with no usage object" \
    || fail "S41-01: raw tokens (no usage)=$(row "$J" tokens) present=$(haskey "$J" tokens; echo $?)"

# escalations/attempts/tokens_by_stage/first_turn_prompt_tokens through the
# real pipeline: an inline v10 arm writes a fresh, valid engine marker plus
# events.jsonl (never backdated -- v10_marker_problem would reject a stale
# one) with two implement sessions (attempts is scoped to the implement
# stage, not every session.started), one escalated fix.round, and two cost
# events on different stages (by_stage split). The two result-cost files ARE
# backdated relative to each other, so first_turn_prompt_tokens is proven to
# come from mtime order, not name order (impl sorts before plan by name).
cat > "$T/bin/s41-events-stub" <<'EOF'
#!/usr/bin/env bash
mkdir -p .loki/runs/fx
cat > .loki/engine.json <<JSON
{"engine": "v10", "run_id": "fx", "events": ".loki/runs/fx/events.jsonl"}
JSON
cat > .loki/runs/fx/events.jsonl <<JSONL
{"v":1,"seq":0,"ts":"2026-01-01T00:00:00Z","run":"fx","type":"session.started","stage":"plan","data":{}}
{"v":1,"seq":1,"ts":"2026-01-01T00:00:01Z","run":"fx","type":"cost","stage":"plan","data":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":3,"cache_creation_tokens":4}}
{"v":1,"seq":2,"ts":"2026-01-01T00:00:02Z","run":"fx","type":"session.started","stage":"implement","data":{}}
{"v":1,"seq":3,"ts":"2026-01-01T00:00:03Z","run":"fx","type":"cost","stage":"implement","data":{"input_tokens":10,"output_tokens":20,"cache_read_tokens":30,"cache_creation_tokens":40}}
{"v":1,"seq":4,"ts":"2026-01-01T00:00:04Z","run":"fx","type":"fix.round","stage":"fix","data":{"escalated":true}}
{"v":1,"seq":5,"ts":"2026-01-01T00:00:05Z","run":"fx","type":"session.started","stage":"implement","data":{}}
JSONL
mkdir -p .loki/metrics
printf '{"first_turn_prompt_tokens": 999}\n' > .loki/metrics/result-cost-fx-plan.json
touch -t 202601010000 .loki/metrics/result-cost-fx-plan.json
printf '{"first_turn_prompt_tokens": 111}\n' > .loki/metrics/result-cost-fx-impl.json
touch -t 202601010001 .loki/metrics/result-cost-fx-impl.json
echo '{"type":"result"}'
EOF
chmod +x "$T/bin/s41-events-stub"
R="$T/out-s41-events"
LOKI_EVAL_LOKI_BIN="$T/bin/s41-events-stub" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" tokens)" = '{"input": 11, "output": 22, "cache_read": 33, "cache_write": 44}' ] \
    && [ "$(row "$J" tokens_by_stage)" = '{"plan": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}, "implement": {"input": 10, "output": 20, "cache_read": 30, "cache_write": 40}}' ] \
    && [ "$(row "$J" first_turn_prompt_tokens)" = 999 ] \
    && [ "$(row "$J" escalations)" = 1 ] && [ "$(row "$J" attempts)" = 2 ] \
    && pass "S41-01: real v10 run: tokens/by_stage/first_turn_prompt_tokens(mtime order)/escalations/attempts(implement-scoped)" \
    || fail "S41-01: events row: tokens=$(row "$J" tokens) by_stage=$(row "$J" tokens_by_stage) fft=$(row "$J" first_turn_prompt_tokens) esc=$(row "$J" escalations) att=$(row "$J" attempts)"

# S41-01 review fix: a v10 run whose worker was killed mid-session must not
# report the surviving records' lower sum as measured. Stub: 3 sessions start
# and S41_COSTS (default 3) cost events exist; S41_RECORDS (default 3)
# efficiency records are written, so 2 models the deleted last record.
cat > "$T/bin/s41-killed-stub" <<'EOF'
#!/usr/bin/env bash
mkdir -p .loki/runs/fx .loki/metrics/efficiency
printf '{"engine": "v10", "run_id": "fx", "events": ".loki/runs/fx/events.jsonl"}\n' > .loki/engine.json
: > .loki/runs/fx/events.jsonl
for i in 1 2 3; do
  echo '{"v":1,"type":"session.started","stage":"implement","data":{"session_id":"s'$i'"}}' >> .loki/runs/fx/events.jsonl
  [ "$i" -le "${S41_COSTS:-3}" ] && echo '{"v":1,"type":"cost","stage":"implement","data":{"session_id":"s'$i'","input_tokens":1}}' >> .loki/runs/fx/events.jsonl
done
costs=(0.1 0.2 0.07101)
for i in $(seq 1 "${S41_RECORDS:-3}"); do
  printf '{"iteration": %s, "cost_source": "provider", "cost_usd": %s}\n' "$i" "${costs[$((i-1))]}" > .loki/metrics/efficiency/iteration-$i.json
done
echo '{"type":"result"}'
EOF
chmod +x "$T/bin/s41-killed-stub"
R="$T/out-s41-complete"
LOKI_EVAL_LOKI_BIN="$T/bin/s41-killed-stub" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" cost_usd)" = 0.37101 ] && [ "$(row "$J" tokens)" != null ] \
    && pass "S41-01: complete v10 run keeps cost_usd 0.37101 and tokens (positive control)" \
    || fail "S41-01: complete run: $(tail -1 "$J")"
R="$T/out-s41-killed"
S41_RECORDS=2 LOKI_EVAL_LOKI_BIN="$T/bin/s41-killed-stub" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" cost_usd)" = null ] && [ "$(row "$J" cost_source)" = '"not reported (3 sessions started, 2 recorded)"' ] \
    && pass "S41-01: 3 sessions started, 2 records -> cost_usd null with reason" \
    || fail "S41-01: killed run: $(tail -1 "$J")"
R="$T/out-s41-killed-tok"
S41_COSTS=2 LOKI_EVAL_LOKI_BIN="$T/bin/s41-killed-stub" RUN --arm v10 --task fx-greet --out "$R" >/dev/null 2>&1
J="$R/results.jsonl"
[ "$(row "$J" tokens)" = null ] \
    && pass "S41-01: a started session without a cost event -> tokens null" \
    || fail "S41-01: tokens=$(row "$J" tokens)"

# ---- 19. (D38/EV-12E) measure-size.py: typing-examples/ and examples/ are
# excluded from the file count. This fixture is alone in its own tasks-dir,
# so max_medium_lines is self-referential (equals its own line count either
# way) and its tier verdict alone ("medium") cannot expose the regression --
# the assertion instead pins the exact (files, lines) columns: 5/220 before
# the fix (2 typing-examples files and their lines still counted), 3/180
# after.
mkdir -p "$T/ms-attrs602/tasks/attrs-602-shaped" "$T/ms-attrs602/refdiff"
cat > "$T/ms-attrs602/tasks/attrs-602-shaped/task.json" <<'JSON'
{"id": "attrs-602-shaped", "tier": "medium", "repo": {"source": "https://example.invalid/nope.git", "ref": "deadbeef"}}
JSON
fake_diff_paths() {  # fake_diff_paths OUT (PATH LINES)...
    local out="$1"; shift
    python3 - "$out" "$@" <<'PY'
import sys
def block(p, n):
    o = ["diff --git a/%s b/%s\n" % (p, p), "--- a/%s\n" % p, "+++ b/%s\n" % p,
         "@@ -1,1 +1,%d @@\n" % (n + 1), " a\n"]
    o += ["+x%d\n" % i for i in range(n)]
    return "".join(o)
out_path, args = sys.argv[1], sys.argv[2:]
with open(out_path, "w") as f:
    for i in range(0, len(args), 2):
        f.write(block(args[i], int(args[i + 1])))
PY
}
fake_diff_paths "$T/ms-attrs602/refdiff/attrs-602-shaped.diff" \
    "src/attrs/_make.py" 80 "src/attrs/_funcs.py" 60 "src/attrs/converters.py" 40 \
    "typing-examples/example.py" 20 "typing-examples/example2.py" 20
python3 "$MS" --tasks-dir "$T/ms-attrs602/tasks" --refdiff-dir "$T/ms-attrs602/refdiff" >"$T/ms-attrs602.out" 2>&1
rc=$?
[ "$rc" = 0 ] && grep -E -q '^attrs-602-shaped[[:space:]]+medium[[:space:]]+3[[:space:]]+180[[:space:]]+OK' "$T/ms-attrs602.out" \
    && pass "D38: attrs-602-shaped fixture (3 product files + typing-examples) reads medium: 3 files, 180 lines" \
    || fail "D38: attrs-602-shaped exclusion rc=$rc: $(cat "$T/ms-attrs602.out")"

# ---- 20a. (D38/EV-12E) validate: tier=large requires hidden.provenance,
# hidden.sha256 (re-hashed, not just present) and hidden.requirements[]
# naming a test id. A hand-built fixture, not a dependency on any sibling
# retrofit branch, so this leg stays hermetic after EV-12F/EV-12G merge.
mkdir -p "$T/lg-schema/hidden"
printf 'def test_x():\n    assert True\n' > "$T/lg-schema/hidden/test_x.py"
SHA_X="$(python3 -c "import hashlib; print(hashlib.sha256(open('$T/lg-schema/hidden/test_x.py','rb').read()).hexdigest())")"
python3 -c "
import json
json.dump({
    'id': 'lg-schema', 'kind': 'public', 'prompt': 'x',
    'repo': {'source': 'https://example.invalid/nope.git', 'ref': 'deadbeefcafe'},
    'hidden': {
        'files': ['test_x.py'], 'run': 'pytest -q test_x.py',
        'provenance': {'test_x.py': 'authored'},
        'sha256': {'test_x.py': '$SHA_X'},
        'requirements': [{'id': 'R1', 'tests': ['test_x']}],
    },
    'tier': 'large',
}, open('$T/lg-schema/task.json', 'w'))
"
if H validate "$T/lg-schema" >/dev/null 2>&1
then pass "D38: a well-formed tier=large task (provenance+sha256+requirements) validates"
else fail "D38: well-formed tier=large task was rejected"
fi
lg_bad_case() {  # lg_bad_case NAME PY_MUTATION_OF_t WANT_MSG: rejected, and by
                  # the right message -- a nonzero exit alone also matches an
                  # unrelated crash/traceback (this repo's exit-code false-green trap)
    local name="$1" expr="$2" want="$3" d="$T/lg-bad/$1"
    mkdir -p "$d/hidden"
    cp "$T/lg-schema/hidden/test_x.py" "$d/hidden/test_x.py"
    python3 -c "import json,sys; t=json.load(open(sys.argv[1])); t['id']=sys.argv[3]; $expr; json.dump(t, open(sys.argv[2],'w'))" \
        "$T/lg-schema/task.json" "$d/task.json" "$name"
    out="$(H validate "$d" 2>&1)"; rc=$?
    if [ "$rc" != 0 ] && printf '%s\n' "$out" | grep -qF "$want"; then
        pass "D38: validator rejects $name ($want)"
    else
        fail "D38: validator on $name: rc=$rc, expected a '$want' rejection: $out"
    fi
}
lg_bad_case lg-wrong-sha "t['hidden']['sha256']['test_x.py']='0'*64" "sha256 mismatch"
lg_bad_case lg-missing-provenance "del t['hidden']['provenance']" "hidden.provenance is required"
lg_bad_case lg-empty-requirement-tests "t['hidden']['requirements'][0]['tests']=[]" "names no hidden test id"
lg_bad_case lg-no-requirements "t['hidden']['requirements']=[]" "hidden.requirements is required"

# EV-12G's real tasks use singular hidden.requirements[].test (a plain
# string) instead of EV-12F-a/b's plural .tests (a list) -- a positive case,
# not just the 4 rejections above, so reverting validator support for this
# shape (the only thing keeping EV-12G's 3 real tasks mergeable, since
# validate is not wired into CI) would still be caught here.
mkdir -p "$T/lg-singular-test/hidden"
cp "$T/lg-schema/hidden/test_x.py" "$T/lg-singular-test/hidden/test_x.py"
python3 -c "
import json
t = json.load(open('$T/lg-schema/task.json'))
t['id'] = 'lg-singular-test'
t['hidden']['requirements'] = [{'id': 'R1', 'test': 'test_x'}]
json.dump(t, open('$T/lg-singular-test/task.json', 'w'))
"
if H validate "$T/lg-singular-test" >/dev/null 2>&1
then pass "D38: requirements[].test (singular, EV-12G's shape) validates"
else fail "D38: requirements[].test (singular, EV-12G's shape) was rejected"
fi

# ---- 20. (D38/EV-12E) tasks/lg-*/shortcuts/*.patch: applying a committed
# shortcut at repo.ref must never let the hidden run complete, and the
# baseline hidden run at repo.ref must be RED by assertion (an "N failed"
# summary), never collection-only (0 collected / no tests ran), which would
# make a hidden test read RED for the wrong reason. check_lg_shortcuts walks
# tasks/lg-*/shortcuts/*.patch under a tasks dir; 0 patches is a pass (real
# lg-* tasks land via EV-12F/EV-12G, not this slice -- eval/loki10/tasks has
# none today).
check_lg_shortcuts() {
    local tasks_dir="$1" n=0 ok=0 td tier patch name source ref setup run out rc workdir rel
    for td in "$tasks_dir"/lg-*; do
        [ -f "$td/task.json" ] || continue
        tier="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("tier"))' "$td/task.json")"
        [ "$tier" = large ] || continue
        for patch in "$td"/shortcuts/*.patch; do
            [ -f "$patch" ] || continue
            n=$((n + 1))
            name="$(basename "$td")/$(basename "$patch")"
            source="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repo"]["source"])' "$td/task.json")"
            ref="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repo"]["ref"])' "$td/task.json")"
            setup="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("setup") or "")' "$td/task.json")"
            run="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hidden"]["run"])' "$td/task.json")"
            workdir="$T/lgshortcut-$n"
            rm -rf "$workdir"
            if ! git clone -q "$source" "$workdir" >/dev/null 2>&1 || ! git -C "$workdir" checkout -q "$ref" >/dev/null 2>&1; then
                echo "FAIL(shortcut leg): $name: cannot check out repo.ref"; ok=1; continue
            fi
            [ -n "$setup" ] && (cd "$workdir" && bash -c "$setup") >/dev/null 2>&1
            copy_hidden() {  # overlay the trusted hidden files, fresh, same as run_hidden -- a
                              # shortcut patch touching one of these paths must never leak through
                while IFS= read -r rel; do
                    [ -n "$rel" ] || continue
                    mkdir -p "$workdir/$(dirname "$rel")"
                    cp "$td/hidden/$rel" "$workdir/$rel"
                done < <(python3 -c 'import json,sys; [print(p) for p in json.load(open(sys.argv[1]))["hidden"]["files"]]' "$td/task.json")
            }
            copy_hidden
            out="$(cd "$workdir" && bash -c "$run" 2>&1)"; rc=$?
            if ! printf '%s\n' "$out" | grep -qE '[0-9]+ failed'; then
                echo "FAIL(shortcut leg): $name: baseline at ref is not RED by assertion (rc=$rc): $out"; ok=1; continue
            fi
            # Reset tracked files to repo.ref before checking/applying the patch:
            # it was authored against the pristine ref tree, not against whatever
            # copy_hidden just overlaid on top of a hidden.files path that
            # happens to be tracked (a real werkzeug/httpx test file, say).
            git -C "$workdir" checkout -q -- .
            if ! git -C "$workdir" apply --check "$patch" >/dev/null 2>&1; then
                echo "FAIL(shortcut leg): $name: shortcut patch does not apply at repo.ref"; ok=1; continue
            fi
            git -C "$workdir" apply "$patch"
            copy_hidden
            out="$(cd "$workdir" && bash -c "$run" 2>&1)"; rc=$?
            if [ "$rc" = 0 ] || ! printf '%s\n' "$out" | grep -qE '[0-9]+ failed'; then
                echo "FAIL(shortcut leg): $name: shortcut grades completed (hidden run did not stay red)"; ok=1; continue
            fi
        done
    done
    echo "checked $n patches"
    return $ok
}

check_lg_shortcuts "$REPO_ROOT/eval/loki10/tasks" >"$T/lgshort-real.out" 2>&1
rc=$?
[ "$rc" = 0 ] && pass "D38: real tasks/lg-*/shortcuts/*.patch all still fail the hidden run at repo.ref ($(tail -1 "$T/lgshort-real.out"))" \
    || fail "D38: real lg-* shortcut leg rc=$rc: $(cat "$T/lgshort-real.out")"

# Hermetic self-test of check_lg_shortcuts itself on 4 local git fixtures,
# so the checker's own red/green logic is proven before real lg-* tasks land.
mk_lg_repo() {  # writes+commits src/x.py in $1, prints its sha
    mkdir -p "$1/src"; printf 'a\n' > "$1/src/x.py"
    git -C "$1" init -q; git -C "$1" add -A
    git -C "$1" -c user.name=t -c user.email=t@localhost commit -q -m seed
    git -C "$1" rev-parse HEAD
}
mk_lg_patch() {  # mk_lg_patch REPO EDIT_CMD OUT: a real `git diff` patch
    local repo="$1" edit="$2" out="$3" scratch="$T/lg-patch-scratch-$RANDOM"
    git clone -q "$repo" "$scratch" >/dev/null 2>&1
    (cd "$scratch" && bash -c "$edit")
    git -C "$scratch" diff > "$out"
    rm -rf "$scratch"
}
mk_lg_task() {  # mk_lg_task NAME REPO REF TEST_BODY PATCH_FILE; prints its own tasks-dir root
    local name="$1" repo="$2" ref="$3" test_body="$4" patch_file="$5" td="$T/lgt-$1/lg-$1"
    mkdir -p "$td/hidden" "$td/shortcuts"
    printf '%s' "$test_body" > "$td/hidden/hidden_test.sh"
    python3 -c "
import json
json.dump({'id': 'lg-$name', 'repo': {'source': '$repo', 'ref': '$ref'},
           'hidden': {'files': ['hidden_test.sh'], 'run': 'bash hidden_test.sh'},
           'tier': 'large'}, open('$td/task.json', 'w'))
"
    cp "$patch_file" "$td/shortcuts/sc-$name.patch"
    printf '%s' "$T/lgt-$name"
}
LGREPO="$T/lg-fixture-repo"
LGREF="$(mk_lg_repo "$LGREPO")"
RED_TEST='#!/usr/bin/env bash
if grep -q FIXED src/x.py; then echo "1 passed in 0.01s"; exit 0; else echo "1 failed in 0.01s"; exit 1; fi
'
COLLECT_TEST='#!/usr/bin/env bash
echo "no tests ran in 0.01s"
exit 5
'
mk_lg_patch "$LGREPO" 'echo "# FIXED" >> src/x.py' "$T/patch-a.diff"
mk_lg_patch "$LGREPO" 'echo "# not the fix" >> src/x.py' "$T/patch-d.diff"
cat > "$T/patch-c.diff" <<'PATCH'
diff --git a/does-not-exist.py b/does-not-exist.py
--- a/does-not-exist.py
+++ b/does-not-exist.py
@@ -1,1 +1,2 @@
 a
+FIXED
PATCH

dir_a="$(mk_lg_task a "$LGREPO" "$LGREF" "$RED_TEST" "$T/patch-a.diff")"
check_lg_shortcuts "$dir_a" >"$T/lgshort-a.out" 2>&1; rc=$?
[ "$rc" != 0 ] && pass "D38 shortcut leg: a shortcut that fully passes fails the leg" \
    || fail "D38 shortcut leg: a-fixture (full-pass shortcut) wrongly cleared: $(cat "$T/lgshort-a.out")"

dir_b="$(mk_lg_task b "$LGREPO" "$LGREF" "$COLLECT_TEST" "$T/patch-a.diff")"
check_lg_shortcuts "$dir_b" >"$T/lgshort-b.out" 2>&1; rc=$?
[ "$rc" != 0 ] && pass "D38 shortcut leg: collection-only RED at ref fails the leg" \
    || fail "D38 shortcut leg: b-fixture (collection-only RED) wrongly cleared: $(cat "$T/lgshort-b.out")"

dir_c="$(mk_lg_task c "$LGREPO" "$LGREF" "$RED_TEST" "$T/patch-c.diff")"
check_lg_shortcuts "$dir_c" >"$T/lgshort-c.out" 2>&1; rc=$?
[ "$rc" != 0 ] && pass "D38 shortcut leg: a patch that does not apply fails the leg" \
    || fail "D38 shortcut leg: c-fixture (non-applying patch) wrongly cleared: $(cat "$T/lgshort-c.out")"

dir_d="$(mk_lg_task d "$LGREPO" "$LGREF" "$RED_TEST" "$T/patch-d.diff")"
check_lg_shortcuts "$dir_d" >"$T/lgshort-d.out" 2>&1; rc=$?
[ "$rc" = 0 ] && pass "D38 shortcut leg: positive control (shortcut still fails an assertion) passes the leg" \
    || fail "D38 shortcut leg: d-fixture (genuine shortcut) wrongly failed: $(cat "$T/lgshort-d.out")"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
