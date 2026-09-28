#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-scorecard-run.sh
#
# S41-03: eval/loki10/scorecard-run.sh runs the 4 pinned arms (raw-sonnet,
# raw-opus, loki-sonnet, loki-opus) back to back with an auth guard for the
# E-98f defect (c): a stub `security` stands in for the keychain and a stub
# `claude` stands in for the refresh call. Neither the real keychain nor a
# real eval batch is ever touched.
#
# Legs:
#   1. --dry-run prints exactly the 4 pinned commands (model, --arm, --out
#      per rep) and never calls security, claude or run.sh
#   2. plenty of keychain time left -> auth guard is silent, run.sh runs once
#   3. ANTHROPIC_API_KEY set -> auth guard skips the keychain entirely
#   4. near-expiry (900s, well under what --n/--parallel needs): the wrapper
#      waits (polling the stub clock), then refreshes via the stub `claude`,
#      then re-reads -- and run.sh is never started before that refresh
#   5. keychain unreadable -> stops cleanly, nonzero exit, run.sh never runs
#   6. refresh call fails -> stops cleanly, nonzero exit, run.sh never runs
#   7. an unknown arm name -> nonzero exit before anything runs
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"

SCRIPT="$HERE/scorecard-run.sh"
if [ ! -x "$SCRIPT" ]; then
    echo "FAIL: $SCRIPT missing or not executable"
    exit 1
fi

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
echo "test tmp: $T"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

mkdir -p "$T/bin" "$T/tasks/t1" "$T/tasks/t2"
cat >"$T/tasks/t1/task.json" <<'JSON'
{"id": "t1", "tier": "small"}
JSON
cat >"$T/tasks/t2/task.json" <<'JSON'
{"id": "t2", "tier": "small"}
JSON

# --- stub run.sh: records every invocation, never runs a real eval ---
RUNSH_LOG="$T/runsh.log"
cat >"$T/bin/run.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$RUNSH_LOG"
exit 0
EOF
chmod +x "$T/bin/run.sh"

run_scorecard() {  # runs scorecard-run.sh with the fake run.sh spliced in
    local link_dir="$T/scriptdir-$$-$RANDOM"
    mkdir -p "$link_dir"
    for f in scorecard-run.sh lib-tmp.sh; do
        ln -sf "$HERE/$f" "$link_dir/$f"
    done
    ln -sf "$T/bin/run.sh" "$link_dir/run.sh"
    "$link_dir/scorecard-run.sh" "$@"
}

# --- Leg 1: --dry-run prints the pinned commands, nothing else runs ---
: >"$RUNSH_LOG"
out="$(run_scorecard --tier small --n 1 --arms raw-sonnet,raw-opus,loki-sonnet --out "$T/out1" --tasks-dir "$T/tasks" --dry-run 2>"$T/dry.err")"
rc=$?
if [ "$rc" -eq 0 ] && [ -s "$RUNSH_LOG" ]; then
    fail "leg1: --dry-run must never invoke run.sh"
elif ! grep -q -- '--arm raw-claude' <<<"$out" || ! grep -q -- '--arm v10' <<<"$out"; then
    fail "leg1: dry-run output missing pinned --arm flags: $out"
elif ! grep -q 'LOKI_EVAL_MODEL=claude-sonnet-5' <<<"$out" || ! grep -q 'LOKI_EVAL_MODEL=claude-opus-5-5' <<<"$out"; then
    fail "leg1: dry-run output missing pinned models: $out"
elif [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" != "3" ]; then
    fail "leg1: expected exactly 3 dry-run command lines, got: $out"
else
    pass "leg1: --dry-run prints the pinned commands and never runs run.sh"
fi

# --- stub security: prints ONLY a JSON blob with claudeAiOauth.expiresAt.
# EXPIRE_FILE holds the current simulated expiry (epoch ms). An optional
# STEP_MS makes each call also fast-forward the stored expiry backwards by
# that much, so a poll loop crosses the wait threshold in a handful of real
# seconds instead of waiting out real wall-clock minutes.
mk_security_stub() {
    local expire_file="$1" step_ms="${2:-0}"
    cat >"$T/bin/security" <<EOF
#!/usr/bin/env bash
exp="\$(cat "$expire_file")"
if [ "$step_ms" -ne 0 ]; then
    exp=\$(( exp - $step_ms ))
    echo "\$exp" >"$expire_file"
fi
printf '{"claudeAiOauth":{"accessToken":"unused-in-tests","expiresAt":%s}}' "\$exp"
EOF
    chmod +x "$T/bin/security"
}

CLAUDE_CALLS="$T/claude-calls.log"
mk_claude_stub_ok() {  # refresh succeeds: pushes expiry forward on each call
    local expire_file="$1" bump_ms="$2"
    cat >"$T/bin/claude" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CLAUDE_CALLS"
exp="\$(cat "$expire_file")"
echo \$(( exp + $bump_ms )) >"$expire_file"
exit 0
EOF
    chmod +x "$T/bin/claude"
}
mk_claude_stub_fail() {
    cat >"$T/bin/claude" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CLAUDE_CALLS"
exit 1
EOF
    chmod +x "$T/bin/claude"
}

# --- Leg 2: plenty of time left -> silent, run.sh runs once ---
: >"$RUNSH_LOG"
EXPFILE="$T/exp2"
echo $(( ($(date +%s) + 100000) * 1000 )) >"$EXPFILE"
mk_security_stub "$EXPFILE"
: >"$CLAUDE_CALLS"
out="$( (
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
    export LOKI_EVAL_SECURITY_BIN="$T/bin/security" LOKI_EVAL_CLAUDE_BIN="$T/bin/claude"
    run_scorecard --tier small --n 1 --arms raw-sonnet --out "$T/out2" --tasks-dir "$T/tasks"
) 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "leg2: expected success with ample keychain time, rc=$rc: $out"
elif [ ! -s "$RUNSH_LOG" ]; then
    fail "leg2: run.sh was never invoked"
elif [ -s "$CLAUDE_CALLS" ]; then
    fail "leg2: refresh should never fire with ample time left"
else
    pass "leg2: ample keychain time -> silent guard, run.sh runs"
fi

# --- Leg 3: operator credential set -> guard skips the keychain entirely ---
: >"$RUNSH_LOG"
rm -f "$T/bin/security"  # any call would fail the test
out="$( (
    unset CLAUDE_CODE_OAUTH_TOKEN
    export ANTHROPIC_API_KEY=fake-key LOKI_EVAL_SECURITY_BIN="$T/bin/security"
    run_scorecard --tier small --n 1 --arms raw-sonnet --out "$T/out3" --tasks-dir "$T/tasks"
) 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] || [ ! -s "$RUNSH_LOG" ]; then
    fail "leg3: ANTHROPIC_API_KEY must skip the keychain and still run: rc=$rc out=$out"
else
    pass "leg3: operator credential env var skips the keychain guard"
fi

# --- Leg 4: near-expiry -> waits, refreshes, never starts run.sh early ---
: >"$RUNSH_LOG"
EXPFILE="$T/exp4"
echo $(( ($(date +%s) + 900) * 1000 )) >"$EXPFILE"   # 900s, per the card's Wall check
mk_security_stub "$EXPFILE" 200000   # each poll fast-forwards 200s, so the wait converges in seconds
mk_claude_stub_ok "$EXPFILE" 10000000   # refresh jumps expiry far out
: >"$CLAUDE_CALLS"
out="$( (
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
    export LOKI_EVAL_SECURITY_BIN="$T/bin/security" LOKI_EVAL_CLAUDE_BIN="$T/bin/claude" \
        LOKI_EVAL_AUTH_POLL_S=1
    run_scorecard --tier small --n 5 --arms raw-sonnet --out "$T/out4" --tasks-dir "$T/tasks"
) 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "leg4: expected the batch to proceed after refresh, rc=$rc: $out"
elif [ ! -s "$CLAUDE_CALLS" ]; then
    fail "leg4: expected one operator refresh call, none seen"
elif [ ! -s "$RUNSH_LOG" ]; then
    fail "leg4: run.sh never ran after the refresh"
elif ! grep -q 'claude -p ok --model claude-haiku-4-5' <<<"$out"; then
    fail "leg4: refresh must be the pinned operator command: $out"
else
    pass "leg4: near-expiry waits, refreshes via the pinned command, then runs"
fi

# --- Leg 5: keychain unreadable -> stops cleanly, run.sh never called ---
: >"$RUNSH_LOG"
rm -f "$T/bin/security"
cat >"$T/bin/security" <<'EOF'
#!/usr/bin/env bash
exit 44
EOF
chmod +x "$T/bin/security"
: >"$CLAUDE_CALLS"
out="$( (
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
    export LOKI_EVAL_SECURITY_BIN="$T/bin/security"
    run_scorecard --tier small --n 1 --arms raw-sonnet --out "$T/out5" --tasks-dir "$T/tasks"
) 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
    fail "leg5: unreadable keychain must not exit 0"
elif [ -s "$RUNSH_LOG" ]; then
    fail "leg5: run.sh must never run after an auth failure"
elif grep -qi 'accessToken\|unused-in-tests' <<<"$out"; then
    fail "leg5: token value must never appear in output"
else
    pass "leg5: unreadable keychain stops the batch cleanly, run.sh never runs"
fi

# --- Leg 6: refresh call fails -> stops cleanly, run.sh never called ---
: >"$RUNSH_LOG"
EXPFILE="$T/exp6"
echo $(( ($(date +%s) + 900) * 1000 )) >"$EXPFILE"
mk_security_stub "$EXPFILE" 200000   # each poll fast-forwards 200s, so the wait converges in seconds
mk_claude_stub_fail
: >"$CLAUDE_CALLS"
out="$( (
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
    export LOKI_EVAL_SECURITY_BIN="$T/bin/security" LOKI_EVAL_CLAUDE_BIN="$T/bin/claude" \
        LOKI_EVAL_AUTH_POLL_S=1
    run_scorecard --tier small --n 5 --arms raw-sonnet --out "$T/out6" --tasks-dir "$T/tasks"
) 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
    fail "leg6: a failed refresh must not exit 0"
elif [ -s "$RUNSH_LOG" ]; then
    fail "leg6: run.sh must never run after a failed refresh"
elif [ ! -s "$CLAUDE_CALLS" ]; then
    fail "leg6: expected one refresh attempt"
else
    pass "leg6: a failed refresh stops the batch cleanly, run.sh never runs"
fi

# --- Leg 7: unknown arm name -> rejected before anything runs ---
: >"$RUNSH_LOG"
out="$(run_scorecard --tier small --n 1 --arms raw-sonnet,bogus-arm --out "$T/out7" --tasks-dir "$T/tasks" --dry-run 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
    fail "leg7: an unknown arm name must be rejected"
else
    pass "leg7: unknown arm name rejected"
fi

#===============================================================================
# S41-18: resume. Before each arm/rep, scorecard-run.sh reads that rep's
# results.jsonl and hands the harness only tasks with no `status: ok` row for
# this exact (model, harness_sha, arm) -- the same tuple harness.py's own
# dedupe() keys on. A fully-done rep is skipped (harness never invoked);
# auth_guard still runs before every rep that has work.
#
# Legs a/b run the REAL run.sh + harness.py against the fixtures/stub-arm.sh
# fixture, so the pre-existing "ok" rows are genuine, not hand-written. Legs
# c/d reuse the fake-run.sh + security-stub harness from legs 1-7 (fast; the
# thing under test there is the auth_guard/retry decision, not the harness
# run itself), with hand-written rows that use the exact keys dedupe() reads.
#===============================================================================
STUB="$HERE/fixtures/stub-arm.sh"
RSTASKS="$T/rtasks"
mkdir -p "$RSTASKS"

seed_min_task() {  # NAME -- a runnable fx-greet-based task dir under $RSTASKS
    local name="$1" seed="$T/rseed-$1" ref
    cp -R "$HERE/fixtures/fx-greet/seed" "$seed"
    git -C "$seed" init -q
    git -C "$seed" add -A -f .
    git -C "$seed" -c user.name=t -c user.email=t@localhost commit -q -m seed
    ref="$(git -C "$seed" rev-parse HEAD)"
    mkdir -p "$RSTASKS/$name"
    cp -R "$HERE/fixtures/fx-greet/hidden" "$RSTASKS/$name/hidden"
    python3 - "$HERE/fixtures/fx-greet/task.json" "$RSTASKS/$name/task.json" "$name" "$seed" "$ref" <<'PY'
import json, sys
src, dst, name, seed, ref = sys.argv[1:]
t = json.load(open(src))
t["id"] = name
t["repo"] = {"source": seed, "ref": ref}
json.dump(t, open(dst, "w"), indent=2)
PY
}
seed_min_task rt1
seed_min_task rt2

export LOKI_EVAL_CLAUDE_BIN="$STUB"
export LOKI_EVAL_ARCHIVE_REPO_ROOT="$T/rs-archive-repo" LOKI_EVAL_ARCHIVE="$T/rs-archive-ext"
export CLAUDE_CODE_OAUTH_TOKEN="fake-oauth-s41-18-$$"   # satisfies harness.py's own arm_auth AND the auth_guard env-skip

run_real() {  # a direct real-run.sh call, used only to pre-seed a genuine row
    env -u LOKI_RUN_TMP LOKI_EVAL_TASKS_DIR="$RSTASKS" bash "$HERE/run.sh" "$@"
}
ok_rows_for() {  # FILE TASK -> count of status:ok rows for that task id
    [ -f "$1" ] || { echo 0; return; }
    python3 -c 'import json,sys
n=0
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    r=json.loads(l)
    if r.get("task")==sys.argv[2] and r.get("status")=="ok": n+=1
print(n)' "$1" "$2"
}
manifest_lines() { [ -f "$1" ] && wc -l <"$1" | tr -d ' ' || echo 0; }

# The same harness_sha computation scorecard-run.sh itself uses (REPO_ROOT,
# HEAD, dirty iff the tree -- eval/loki10/archive excluded -- has changes),
# for hand-writing rows in legs c/d that must match what its own dedupe
# filter will compute at test time.
current_harness_sha() {
    local sha
    sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" || sha="unknown"
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- . ':(exclude)eval/loki10/archive' 2>/dev/null)" ]; then
        sha="${sha}-dirty"
    fi
    printf '%s' "$sha"
}
HSHA="$(current_harness_sha)"
write_ok_row() {  # FILE TASK STATUS
    mkdir -p "$(dirname "$1")"
    python3 -c 'import json,sys
row = {"run_id": sys.argv[2] + "-seed", "task": sys.argv[2], "arm": "raw-claude",
       "model": "claude-sonnet-5", "harness_sha": sys.argv[4], "status": sys.argv[3]}
open(sys.argv[1], "a").write(json.dumps(row) + "\n")' "$1" "$2" "$3" "$HSHA"
}

# --- Leg a: killed mid-rep, then rerun, gives exactly one ok row per task ---
OUTA="$T/outA"
STUB_MODE=pass LOKI_EVAL_MODEL=claude-sonnet-5 run_real --arm raw-claude --task rt1 --out "$OUTA/rep1/raw-sonnet" >"$T/a-seed.log" 2>&1
if [ "$(ok_rows_for "$OUTA/rep1/raw-sonnet/results.jsonl" rt1)" != 1 ]; then
    fail "legA setup: seeding rt1's ok row failed: $(cat "$T/a-seed.log")"
else
    out="$(env -u LOKI_RUN_TMP STUB_MODE=pass "$HERE/scorecard-run.sh" --tier small --n 1 --arms raw-sonnet --out "$OUTA" --tasks-dir "$RSTASKS" 2>&1)"
    rc=$?
    j="$OUTA/rep1/raw-sonnet/results.jsonl"
    if [ "$rc" -ne 0 ]; then
        fail "legA: resume run failed, rc=$rc: $out"
    elif [ "$(ok_rows_for "$j" rt1)" != 1 ]; then
        fail "legA: rt1 (already done) must not be rerun: $(cat "$j")"
    elif [ "$(ok_rows_for "$j" rt2)" != 1 ]; then
        fail "legA: rt2 (missing) must end up with exactly one ok row: $(cat "$j")"
    else
        pass "legA: a run killed mid-rep resumes with exactly one ok row per task"
    fi
fi

# --- Leg b: a fully done rep, rerun, invokes the harness zero times ---
OUTB="$T/outB"
out="$(env -u LOKI_RUN_TMP STUB_MODE=pass "$HERE/scorecard-run.sh" --tier small --n 1 --arms raw-sonnet --out "$OUTB" --tasks-dir "$RSTASKS" 2>&1)"
rc=$?
j="$OUTB/rep1/raw-sonnet/results.jsonl"
m="$OUTB/rep1/raw-sonnet/manifest.jsonl"
if [ "$rc" -ne 0 ] || [ "$(ok_rows_for "$j" rt1)" != 1 ] || [ "$(ok_rows_for "$j" rt2)" != 1 ]; then
    fail "legB setup: first full pass did not complete both tasks: $out"
else
    before_manifest="$(manifest_lines "$m")"
    before_results="$(wc -l <"$j" | tr -d ' ')"
    # A path nothing can execute: if the harness were invoked at all despite
    # every task being done, this would fail loudly instead of silently
    # passing by luck.
    out2="$(env -u LOKI_RUN_TMP LOKI_EVAL_CLAUDE_BIN="$T/no-such-claude-binary" "$HERE/scorecard-run.sh" --tier small --n 1 --arms raw-sonnet --out "$OUTB" --tasks-dir "$RSTASKS" 2>&1)"
    rc=$?
    after_manifest="$(manifest_lines "$m")"
    after_results="$(wc -l <"$j" | tr -d ' ')"
    if [ "$rc" -ne 0 ]; then
        fail "legB: a fully done rep must exit 0, rc=$rc: $out2"
    elif [ "$after_manifest" != "$before_manifest" ]; then
        fail "legB: harness invoked (manifest.jsonl grew $before_manifest -> $after_manifest)"
    elif [ "$after_results" != "$before_results" ]; then
        fail "legB: results.jsonl changed on a fully done rerun"
    else
        pass "legB: a fully done rep invokes the harness zero times on rerun"
    fi
fi

# --- Leg c: auth_guard runs only before a rep that still has work ---
CTASKS="$T/ctasks"
mkdir -p "$CTASKS/ct1" "$CTASKS/ct2"
echo '{"id": "ct1", "tier": "small"}' >"$CTASKS/ct1/task.json"
echo '{"id": "ct2", "tier": "small"}' >"$CTASKS/ct2/task.json"
OUTC="$T/outC"
write_ok_row "$OUTC/rep1/raw-sonnet/results.jsonl" ct1 ok
write_ok_row "$OUTC/rep1/raw-sonnet/results.jsonl" ct2 ok   # rep1 fully done; rep2 has no results file at all

: >"$RUNSH_LOG"
EXPFILE="$T/expC"
echo $(( ($(date +%s) + 100000) * 1000 )) >"$EXPFILE"
SEC_CALLS="$T/sec-calls-c.log"
cat >"$T/bin/security" <<EOF
#!/usr/bin/env bash
echo called >>"$SEC_CALLS"
exp="\$(cat "$EXPFILE")"
printf '{"claudeAiOauth":{"accessToken":"unused-in-tests","expiresAt":%s}}' "\$exp"
EOF
chmod +x "$T/bin/security"
: >"$SEC_CALLS"
out="$( (
    unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
    export LOKI_EVAL_SECURITY_BIN="$T/bin/security"
    run_scorecard --tier small --n 2 --arms raw-sonnet --out "$OUTC" --tasks-dir "$CTASKS"
) 2>&1)"
rc=$?
sec_calls="$(manifest_lines "$SEC_CALLS")"
runsh_lines="$(manifest_lines "$RUNSH_LOG")"
if [ "$rc" -ne 0 ]; then
    fail "legC: expected success, rc=$rc: $out"
elif [ "$sec_calls" != 1 ]; then
    fail "legC: expected exactly 1 auth_guard keychain read (rep2 only, rep1 has no work), got $sec_calls"
elif [ "$runsh_lines" != 1 ]; then
    fail "legC: expected exactly 1 run.sh invocation (rep2 only), got $runsh_lines"
elif ! grep -q -- '--tasks ct1,ct2' "$RUNSH_LOG"; then
    fail "legC: rep2 must run both of its missing tasks: $(cat "$RUNSH_LOG")"
else
    pass "legC: auth_guard runs only before the rep that still has work"
fi

# --- Leg d: an existing non-ok row (error or timeout) is retried ---
OUTD="$T/outD"
write_ok_row "$OUTD/rep1/raw-sonnet/results.jsonl" ct1 harness_error   # non-ok: must be retried
write_ok_row "$OUTD/rep1/raw-sonnet/results.jsonl" ct2 ok              # ok: must not be retried
: >"$RUNSH_LOG"
out="$( (
    export ANTHROPIC_API_KEY=fake-key-legd
    run_scorecard --tier small --n 1 --arms raw-sonnet --out "$OUTD" --tasks-dir "$CTASKS"
) 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
    fail "legD: expected success, rc=$rc: $out"
elif [ "$(manifest_lines "$RUNSH_LOG")" != 1 ]; then
    fail "legD: expected exactly 1 run.sh invocation, got $(manifest_lines "$RUNSH_LOG")"
elif ! grep -q -- '--tasks ct1' "$RUNSH_LOG" || grep -q -- '--tasks ct1,ct2\|--tasks ct2' "$RUNSH_LOG"; then
    fail "legD: a non-ok row (ct1) must be retried, an ok row (ct2) must not: $(cat "$RUNSH_LOG")"
else
    pass "legD: an existing non-ok row (error or timeout) is retried, an ok row is not"
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
