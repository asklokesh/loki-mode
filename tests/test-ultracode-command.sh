#!/usr/bin/env bash
# tests/test-ultracode-command.sh - Tests for loki ultracode command (v7.38.0)
#
# Phase 1: `loki ultracode "<task>"` is an opt-in, capability-gated, cost-class
# disclosed, Claude-provider-only PASSTHROUGH that prepends the `ultracode`
# keyword to the prompt and routes through `claude -p`, firing Claude Code's
# Dynamic Workflow runtime. These tests STUB `claude` on PATH so no real (paid)
# workflow ever runs. The stub records its argv to a log so we can assert exactly
# what argv was emitted and that ZERO invocations happen on every refuse path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_DIR/autonomy/loki"
PASS=0
FAIL=0
TOTAL=0

TEST_DIR=$(mktemp -d /tmp/loki-test-ultracode-XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT

run_test() {
    local name="$1"
    TOTAL=$((TOTAL + 1))
    echo -n "  TEST $TOTAL: $name ... "
}
pass() { PASS=$((PASS + 1)); echo "PASS"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

echo "=== loki ultracode command tests ==="
echo ""

STUB_DIR="$TEST_DIR/stub-bin"
mkdir -p "$STUB_DIR"
STUB_LOG="$TEST_DIR/claude-argv.log"

# Capability-PRESENT stub: `claude --version` reports a modern version (>= 2.1.154)
# and `claude --help` is benign. A `claude -p ...` invocation logs the full argv
# (one token per line) and prints a marker so we can assert it ran.
cat > "$STUB_DIR/claude" << 'STUBEOF'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
    echo "2.1.177 (Claude Code)"
    exit 0
fi
if [ "$1" = "--help" ]; then
    echo "Usage: claude [options] [command]"
    echo "Commands:"
    echo "  config   Manage configuration"
    exit 0
fi
# Any other invocation (the -p workflow call): log argv + marker.
printf '%s\n' "$@" > "${STUB_CLAUDE_LOG:?}"
echo "STUB_ULTRACODE_RAN"
exit 0
STUBEOF
chmod +x "$STUB_DIR/claude"

# --- Test: --yes emits `claude -p "ultracode: <task>"` through the argv ---
run_test "--yes emits a prompt containing 'ultracode:' through the claude argv"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        "$LOKI" ultracode "list files and count them" --yes </dev/null 2>/dev/null) || true
    echo "$out" | grep -q "STUB_ULTRACODE_RAN" || { echo "stub did not run: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] || { echo "no argv log" >&2; exit 1; }
    mapfile -t argv < "$STUB_LOG"
    # argv[0] must be -p, argv[1] the prompt beginning with "ultracode: ".
    [ "${argv[0]}" = "-p" ] || { echo "argv[0]=${argv[0]}" >&2; exit 1; }
    case "${argv[1]}" in
        "ultracode: list files and count them") : ;;
        *) echo "argv[1]=${argv[1]} (expected ultracode-prefixed prompt)" >&2; exit 1 ;;
    esac
    # opus model must be requested per project policy.
    printf '%s\n' "${argv[@]}" | grep -qx -- "--model" || { echo "no --model: ${argv[*]}" >&2; exit 1; }
    printf '%s\n' "${argv[@]}" | grep -qx -- "opus" || { echo "no opus: ${argv[*]}" >&2; exit 1; }
    exit 0
) && pass || fail "expected 'ultracode:'-prefixed -p prompt"

# --- Test: cost-class disclosure always prints ---
run_test "cost-class disclosure prints (no dollar figure)"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        "$LOKI" ultracode "x" --yes </dev/null 2>&1) || true
    echo "$out" | grep -qi "cost meaningfully more" || { echo "no cost disclosure: $out" >&2; exit 1; }
    echo "$out" | grep -qi "billed as normal usage" || { echo "no billing class: $out" >&2; exit 1; }
    # Must NOT fabricate a dollar figure.
    echo "$out" | grep -q '\$[0-9]' && { echo "unexpected dollar figure: $out" >&2; exit 1; }
    exit 0
) && pass || fail "expected cost-class disclosure with no dollar figure"

# --- Test: LOKI_USE_CLAUDE_WORKFLOWS=1 proceeds non-interactively ---
run_test "LOKI_USE_CLAUDE_WORKFLOWS=1 proceeds non-interactively"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        LOKI_USE_CLAUDE_WORKFLOWS=1 CI="" \
        "$LOKI" ultracode "audit repo" </dev/null 2>/dev/null) || true
    echo "$out" | grep -q "STUB_ULTRACODE_RAN" || { echo "stub did not run: $out" >&2; exit 1; }
    exit 0
) && pass || fail "expected LOKI_USE_CLAUDE_WORKFLOWS=1 to proceed"

# --- Test: non-claude provider exits cleanly with ZERO invocation + honest msg ---
run_test "non-claude provider exits cleanly, honest message, zero invocation"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    code=0
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=codex \
        "$LOKI" ultracode "x" --yes </dev/null 2>&1) || code=$?
    # Clean exit (0), honest "Claude provider only" message, zero workflow calls.
    [ "$code" -eq 0 ] || { echo "expected exit 0, got $code: $out" >&2; exit 1; }
    echo "$out" | grep -qi "Claude provider" || { echo "no honest msg: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "workflow WAS invoked on non-claude provider!" >&2; exit 1; }
    exit 0
) && pass || fail "expected clean exit + honest message + zero calls on non-claude"

# --- Test: older / unsupported claude CLI degrades cleanly, zero invocation ---
run_test "older-CLI/unsupported degrades cleanly, zero invocation"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    # A claude stub whose --version reports an OLD version (< 2.1.154).
    old_dir="$TEST_DIR/stub-old"
    mkdir -p "$old_dir"
    cat > "$old_dir/claude" << 'OLD'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
    echo "2.1.100 (Claude Code)"
    exit 0
fi
if [ "$1" = "--help" ]; then
    echo "Usage: claude [options] [command]"
    exit 0
fi
# Should never reach here in this test; log it so the test fails if it does.
printf '%s\n' "$@" > "${STUB_CLAUDE_LOG:?}"
exit 0
OLD
    chmod +x "$old_dir/claude"
    code=0
    # Fresh process so the per-process version cache is not poisoned by a prior test.
    out=$(PATH="$old_dir:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        __LOKI_CLAUDE_VERSION_CACHE="" __LOKI_CLAUDE_HELP_CACHE="" \
        "$LOKI" ultracode "x" --yes </dev/null 2>&1) || code=$?
    [ "$code" -eq 0 ] || { echo "expected clean exit 0, got $code: $out" >&2; exit 1; }
    echo "$out" | grep -qi "2.1.154\|workflows unavailable" || { echo "no honest degrade msg: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "workflow WAS invoked on old CLI!" >&2; exit 1; }
    exit 0
) && pass || fail "expected clean degrade + zero calls on old CLI"

# --- Test: CLAUDE_CODE_DISABLE_WORKFLOWS=1 degrades cleanly, zero invocation ---
run_test "CLAUDE_CODE_DISABLE_WORKFLOWS=1 degrades cleanly, zero invocation"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    code=0
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        CLAUDE_CODE_DISABLE_WORKFLOWS=1 \
        __LOKI_CLAUDE_VERSION_CACHE="" __LOKI_CLAUDE_HELP_CACHE="" \
        "$LOKI" ultracode "x" --yes </dev/null 2>&1) || code=$?
    [ "$code" -eq 0 ] || { echo "expected clean exit 0, got $code: $out" >&2; exit 1; }
    echo "$out" | grep -qi "workflows unavailable\|disabled" || { echo "no honest msg: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "workflow WAS invoked while disabled!" >&2; exit 1; }
    exit 0
) && pass || fail "expected clean degrade + zero calls when disabled"

# --- Test: non-TTY without --yes refuses (exit 2) and makes ZERO calls ---
run_test "non-TTY without --yes exits 2 and never invokes the workflow"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    code=0
    # stdin is /dev/null (not a TTY); no --yes; LOKI_USE_CLAUDE_WORKFLOWS unset.
    PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        LOKI_USE_CLAUDE_WORKFLOWS="" CI="" \
        __LOKI_CLAUDE_VERSION_CACHE="" __LOKI_CLAUDE_HELP_CACHE="" \
        "$LOKI" ultracode "x" </dev/null >/dev/null 2>&1 || code=$?
    [ "$code" -eq 2 ] || { echo "exit code=$code (expected 2)" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "workflow WAS invoked (silent bill!)" >&2; exit 1; }
    exit 0
) && pass || fail "expected exit 2 and zero workflow calls"

# --- Test: missing task argument errors (exit 1) and makes ZERO calls ---
run_test "missing task argument errors with usage, zero invocation"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    code=0
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        "$LOKI" ultracode --yes </dev/null 2>&1) || code=$?
    [ "$code" -eq 1 ] || { echo "expected exit 1, got $code: $out" >&2; exit 1; }
    echo "$out" | grep -qi "requires a task" || { echo "no usage msg: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "workflow WAS invoked with no task!" >&2; exit 1; }
    exit 0
) && pass || fail "expected exit 1 + usage + zero calls on missing task"

# --- Test: --help short-circuits without invoking the workflow ---
run_test "--help prints usage and never invokes the workflow"
(
    cd "$TEST_DIR"
    rm -f "$STUB_LOG"
    out=$(PATH="$STUB_DIR:$PATH" STUB_CLAUDE_LOG="$STUB_LOG" LOKI_PROVIDER=claude \
        "$LOKI" ultracode --help </dev/null 2>&1) || true
    echo "$out" | grep -qi "loki ultracode" || { echo "no help text: $out" >&2; exit 1; }
    [ -f "$STUB_LOG" ] && { echo "workflow WAS invoked on --help!" >&2; exit 1; }
    exit 0
) && pass || fail "expected help text + zero calls"

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $TOTAL total ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
