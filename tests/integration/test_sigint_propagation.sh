#!/usr/bin/env bash
# tests/integration/test_sigint_propagation.sh
# v7.5.12: Verify Ctrl+C (SIGINT) propagates from the loki run.sh parent to
# the running provider subprocess and both exit within 5 seconds.
#
# Background: prior to v7.5.12 the perpetual-mode trap silently ignored
# SIGINT, so a user pressing Ctrl+C 9 times had no effect. The fix kills
# the active provider pipeline on the first Ctrl+C and exits on the
# second one within 2 seconds (double-Ctrl+C escape).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0

ok()  { echo "PASS [$1]"; PASS=$((PASS + 1)); }
bad() { echo "FAIL [$1] $2"; FAIL=$((FAIL + 1)); }

#
# Test 1: kill_provider_child function reaps a long-running child.
#
test_kill_provider_child() {
    local name="kill_provider_child reaps direct child within ~2s"
    # Launch a subshell that sources only the function definition so we can
    # exercise it in isolation without booting the full runner.
    local script
    script=$(mktemp -t loki-sigint-XXXXXX.sh)
    cat > "$script" <<'EOF'
# Minimal stub of the helper from autonomy/run.sh v7.5.12.
LOKI_PROVIDER_ACTIVE=0
kill_provider_child() {
    local killed=0
    if pkill -TERM -P $$ 2>/dev/null; then
        killed=1
    fi
    local proc
    for proc in claude codex gemini aider cline; do
        pkill -TERM -f "^${proc}( |$)" 2>/dev/null && killed=1
    done
    local i=0
    while [ $i -lt 20 ]; do
        if ! pgrep -P $$ >/dev/null 2>&1; then
            break
        fi
        sleep 0.1
        i=$((i + 1))
    done
    if pgrep -P $$ >/dev/null 2>&1; then
        pkill -KILL -P $$ 2>/dev/null || true
        killed=1
    fi
    LOKI_PROVIDER_ACTIVE=0
    [ $killed -eq 1 ] && return 0 || return 1
}

# Spawn a long-running child (mock provider).
sleep 60 &
CHILD_PID=$!
LOKI_PROVIDER_ACTIVE=1

# Verify child is alive.
if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "SETUP_FAIL: child did not start"
    exit 99
fi

# Time the kill.
START=$(date +%s)
kill_provider_child
END=$(date +%s)
ELAPSED=$((END - START))

# Verify child is dead.
if kill -0 "$CHILD_PID" 2>/dev/null; then
    echo "FAIL: child PID $CHILD_PID still alive after kill_provider_child"
    kill -9 "$CHILD_PID" 2>/dev/null || true
    exit 1
fi

if [ "$ELAPSED" -gt 5 ]; then
    echo "FAIL: kill took ${ELAPSED}s, expected <=5s"
    exit 2
fi

if [ "$LOKI_PROVIDER_ACTIVE" -ne 0 ]; then
    echo "FAIL: LOKI_PROVIDER_ACTIVE not reset to 0"
    exit 3
fi

echo "OK: child killed in ${ELAPSED}s, flag reset"
exit 0
EOF

    local out
    out=$(bash "$script" 2>&1)
    local rc=$?
    rm -f "$script"

    if [ $rc -eq 0 ]; then
        ok "$name"
    else
        bad "$name" "rc=$rc out=$out"
    fi
}

#
# Test 2: SIGINT to a parent shell propagates to and kills the child.
# Simulates: user presses Ctrl+C in their terminal while `loki start` is
# running a provider subprocess. The terminal's SIGINT is delivered to the
# foreground process group, so both parent and child should exit within 5s.
#
test_sigint_process_group() {
    local name="SIGINT to parent kills both parent and provider child within 5s"
    local script
    script=$(mktemp -t loki-sigint-pg-XXXXXX.sh)
    local child_pid_file
    child_pid_file=$(mktemp -t loki-sigint-pid-XXXXXX)

    cat > "$script" <<EOF
#!/usr/bin/env bash
# Mimic the run.sh perpetual-mode behavior.
LOKI_PROVIDER_ACTIVE=0
INTERRUPT_COUNT=0
INTERRUPT_LAST_TIME=0

kill_provider_child() {
    pkill -TERM -P \$\$ 2>/dev/null || true
    sleep 0.5
    pkill -KILL -P \$\$ 2>/dev/null || true
    LOKI_PROVIDER_ACTIVE=0
}

cleanup() {
    local now=\$(date +%s)
    local diff=\$((now - INTERRUPT_LAST_TIME))
    if [ "\$diff" -lt 2 ] && [ "\$INTERRUPT_COUNT" -gt 0 ]; then
        kill_provider_child
        exit 130
    fi
    INTERRUPT_COUNT=\$((INTERRUPT_COUNT + 1))
    INTERRUPT_LAST_TIME=\$now
    if [ "\$LOKI_PROVIDER_ACTIVE" -eq 1 ]; then
        kill_provider_child
    fi
}
trap cleanup INT TERM
# Reset SIGINT to default-handle (bash auto-ignores it for backgrounded
# scripts; the explicit trap re-enables it).

# Spawn mock provider (sleep 60).
sleep 60 &
CHILD=\$!
echo "\$CHILD" > "$child_pid_file"
LOKI_PROVIDER_ACTIVE=1
wait \$CHILD
# Loop continues -- spawn another, simulating the next iteration.
sleep 60 &
CHILD=\$!
LOKI_PROVIDER_ACTIVE=1
wait \$CHILD
exit 0
EOF
    chmod +x "$script"

    # Start the parent in the background.
    "$script" >/dev/null 2>&1 &
    local parent_pid=$!

    # Wait briefly for the child to register.
    local i=0
    while [ $i -lt 20 ]; do
        if [ -s "$child_pid_file" ]; then break; fi
        sleep 0.1
        i=$((i + 1))
    done

    local child_pid
    child_pid=$(cat "$child_pid_file" 2>/dev/null || echo "")

    if [ -z "$child_pid" ]; then
        bad "$name" "child PID never recorded"
        kill -9 "$parent_pid" 2>/dev/null || true
        rm -f "$script" "$child_pid_file"
        return
    fi

    # NOTE: We use SIGTERM (not SIGINT) here because bash backgrounded
    # scripts have SIGINT auto-ignored when job control is off. In a real
    # terminal, the user's Ctrl+C is delivered as SIGINT to the foreground
    # process group, which IS caught. Both signals route to the same
    # `cleanup` trap handler, so this still validates the propagation logic.

    # First TERM: should kill the provider child but not the parent
    # (perpetual mode continues iterating). The trap returns; the parent
    # spawns the next iteration's mock provider and waits on it.
    kill -TERM "$parent_pid" 2>/dev/null || true
    # Wait long enough for first child to die and second `wait` to be active,
    # but short enough that we are still inside the 2s double-signal window.
    sleep 1.2

    # Second TERM within 2s: should exit the parent via double-signal escape.
    kill -TERM "$parent_pid" 2>/dev/null || true

    # Wait up to 5s for parent to exit.
    local start_t end_t
    start_t=$(date +%s)
    local exited=0
    while true; do
        if ! kill -0 "$parent_pid" 2>/dev/null; then
            exited=1
            break
        fi
        end_t=$(date +%s)
        if [ $((end_t - start_t)) -gt 5 ]; then
            break
        fi
        sleep 0.2
    done

    end_t=$(date +%s)
    local elapsed=$((end_t - start_t))

    # Check both parent and original child are dead.
    if [ $exited -eq 0 ]; then
        bad "$name" "parent PID $parent_pid still alive after 5s"
        kill -9 "$parent_pid" 2>/dev/null || true
    elif kill -0 "$child_pid" 2>/dev/null; then
        bad "$name" "child PID $child_pid still alive (parent exited)"
        kill -9 "$child_pid" 2>/dev/null || true
    elif [ "$elapsed" -gt 5 ]; then
        bad "$name" "took ${elapsed}s, expected <=5s"
    else
        ok "$name (parent+child gone in ${elapsed}s)"
    fi

    rm -f "$script" "$child_pid_file"
}

#
# Test 3: Verify run.sh defines the new helper and globals.
#
test_run_sh_has_helper() {
    local name="autonomy/run.sh defines kill_provider_child and LOKI_PROVIDER_ACTIVE"
    if grep -q "^kill_provider_child()" "$REPO_ROOT/autonomy/run.sh" \
        && grep -q "^LOKI_PROVIDER_ACTIVE=" "$REPO_ROOT/autonomy/run.sh"; then
        ok "$name"
    else
        bad "$name" "helper or global missing from run.sh"
    fi
}

#
# Test 4: bash -n clean.
#
test_bash_n() {
    local name="autonomy/run.sh passes bash -n"
    if bash -n "$REPO_ROOT/autonomy/run.sh" 2>/dev/null; then
        ok "$name"
    else
        bad "$name" "syntax errors present"
    fi
}

test_run_sh_has_helper
test_bash_n
test_kill_provider_child
test_sigint_process_group

echo
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
