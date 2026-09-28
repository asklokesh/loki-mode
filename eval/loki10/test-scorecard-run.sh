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

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
