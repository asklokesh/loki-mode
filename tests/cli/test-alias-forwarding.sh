#!/usr/bin/env bash
# Test: deprecated-alias back-compat contract (CLI consolidation Phase A)
#
# Data-driven suite. For every (alias, canonical, args) row it asserts the
# binding alias contract from internal/CLI-CONSOLIDATION-DESIGN.md section 6:
#   1. Exit-code parity:  alias and canonical return the same exit code.
#   2. Stdout parity:     alias stdout (2>/dev/null) is byte-identical to the
#                         canonical command's stdout.
#   3. Deprecation line:  present on STDERR for the alias, absent for canonical.
#   4. Machine-output:    under --json the deprecation line is suppressed on
#                         the alias, and stdout still matches the canonical.
#   5. -q / --quiet:      also suppress the deprecation line on the alias.
#
# Adding an alias = adding a row to ALIAS_ROWS, not writing a new test.
#
# Both routes: pass LOKI_ROUTE=bash (LOKI_LEGACY_BASH=1) or LOKI_ROUTE=bun
# (BUN_FROM_SOURCE=1, the default Bun shim path). local-ci runs it twice. This
# is critical for Bun-native tokens (stats) whose deprecation line must fire on
# the Bun route too, not only bash.
#
# Help-structure assertions (front-page entry bounds, groups present, aliases
# only in the footer / `loki help aliases`) are at the end.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI_SHIM="$REPO_ROOT/bin/loki"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL+1)); }

# Route selection: default to the Bun shim path; LOKI_ROUTE=bash forces bash.
ROUTE="${LOKI_ROUTE:-bun}"
declare -a ROUTE_ENV
if [ "$ROUTE" = "bash" ]; then
    ROUTE_ENV=("LOKI_LEGACY_BASH=1")
else
    # BUN_FROM_SOURCE=1 forces src/cli.ts (reads VERSION live) so the route is
    # deterministic regardless of whether dist was rebuilt. If bun is missing,
    # bin/loki silently falls through to bash; the contract still holds because
    # the bash arms emit the same line.
    ROUTE_ENV=("BUN_FROM_SOURCE=1")
fi

echo -e "${YELLOW}=== alias-forwarding suite (route: $ROUTE) ===${NC}"

# Isolated, deterministic .loki fixture so reporting commands emit stable,
# identical output for alias-vs-canonical byte comparison. mktemp per CLAUDE.md.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/loki-alias-test.XXXXXX")"
cleanup() { rm -rf "$WORKDIR" 2>/dev/null || true; }
trap cleanup EXIT
mkdir -p "$WORKDIR/.loki/state" "$WORKDIR/.loki/metrics/efficiency" \
         "$WORKDIR/.loki/metrics" "$WORKDIR/.loki/quality" "$WORKDIR/.loki/proofs"
cat > "$WORKDIR/.loki/state/orchestrator.json" <<'JSON'
{"currentPhase":"build","currentIteration":2}
JSON
cat > "$WORKDIR/.loki/metrics/efficiency/iteration-001.json" <<'JSON'
{"input_tokens":1000,"output_tokens":500,"cost_usd":0.12,"duration_seconds":30}
JSON
cat > "$WORKDIR/.loki/metrics/efficiency/iteration-002.json" <<'JSON'
{"input_tokens":2000,"output_tokens":800,"cost_usd":0.24,"duration_seconds":45}
JSON

# Run the CLI in the fixture cwd with the chosen route env. All stdout/stderr is
# captured by the caller via redirection.
run_loki() {
    ( cd "$WORKDIR" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" "$@" )
}

# The deprecation pointer grep pattern: "is now 'loki <canonical>'".
dep_pattern() { echo "is now 'loki $1'"; }

# Normalize volatile fields so two separate process runs of the SAME command
# compare equal. Some reporting handlers stamp the current time into output
# (e.g. export's "exported_at", trust-metrics' "snapshot at ..."). The alias
# contract is about forwarding correctness, not wall-clock stability, so we
# blank ISO-8601 timestamps before byte comparison. This keeps the assertion
# strict on EVERYTHING else (structure, values, formatting).
normalize() {
    sed -E \
        -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z?/<TS>/g' \
        -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/<TS>/g'
}

# ---------------------------------------------------------------------------
# Data table: alias|canonical|args
# args may be empty. Multi-word canonical (e.g. "report session") is allowed.
# ---------------------------------------------------------------------------
ALIAS_ROWS=(
    "stats|report session|"
    "metrics|report metrics|"
    "cost|report cost|"
    "export|report export|json"
    "dogfood|report dogfood|"
    "trust-metrics|trust detail|"
    # 'share' creates a real GitHub Gist (network + non-deterministic URL) when
    # invoked bare, so we exercise its forwarding contract via the deterministic
    # --help path instead. The deprecation line still fires under --help.
    "share|report share|--help"
)

assert_row() {
    local alias_cmd="$1" canonical="$2" args="$3"
    local label="$alias_cmd -> $canonical"
    # shellcheck disable=SC2206
    local alias_argv=($alias_cmd $args)
    # shellcheck disable=SC2206
    local canon_argv=($canonical $args)

    # --- canonical baseline ---
    local c_out c_err c_code
    c_out="$(run_loki "${canon_argv[@]}" 2>"$WORKDIR/c.err")"; c_code=$?
    c_err="$(cat "$WORKDIR/c.err")"

    # --- alias ---
    local a_out a_err a_code
    a_out="$(run_loki "${alias_argv[@]}" 2>"$WORKDIR/a.err")"; a_code=$?
    a_err="$(cat "$WORKDIR/a.err")"

    # 1. exit-code parity
    if [ "$a_code" = "$c_code" ]; then
        log_pass "$label: exit-code parity ($a_code)"
    else
        log_fail "$label: exit-code parity" "alias=$a_code canonical=$c_code"
    fi

    # 2. stdout byte-identity (timestamps normalized; see normalize()).
    if [ "$(echo "$a_out" | normalize)" = "$(echo "$c_out" | normalize)" ]; then
        log_pass "$label: stdout byte-identical"
    else
        log_fail "$label: stdout byte-identical" "stdout differs"
    fi

    # 3. deprecation line present on alias stderr, absent on canonical stderr
    local pat; pat="$(dep_pattern "$canonical")"
    if echo "$a_err" | grep -qF "$pat"; then
        log_pass "$label: deprecation line on alias stderr"
    else
        log_fail "$label: deprecation line on alias stderr" "missing: $pat (got: $a_err)"
    fi
    if echo "$c_err" | grep -qF "$pat"; then
        log_fail "$label: canonical stderr clean" "canonical leaked deprecation line"
    else
        log_pass "$label: canonical stderr has no deprecation line"
    fi

    # 4 + 5. machine-output / quiet suppression on the alias
    local flag
    for flag in --json -q --quiet; do
        local m_err
        run_loki "${alias_argv[@]}" "$flag" >/dev/null 2>"$WORKDIR/m.err" || true
        m_err="$(cat "$WORKDIR/m.err")"
        if echo "$m_err" | grep -qF "$pat"; then
            log_fail "$label: $flag suppresses deprecation line" "line leaked under $flag"
        else
            log_pass "$label: $flag suppresses deprecation line"
        fi
    done

    # 4b. --json stdout parity (alias --json == canonical --json) for rows whose
    # canonical supports --json. The reporting handlers accept --json; if a
    # handler ignores it the streams still match (both ignore identically).
    local aj cj
    aj="$(run_loki "${alias_argv[@]}" --json 2>/dev/null | normalize)"
    cj="$(run_loki "${canon_argv[@]}" --json 2>/dev/null | normalize)"
    if [ "$aj" = "$cj" ]; then
        log_pass "$label: --json stdout byte-identical"
    else
        log_fail "$label: --json stdout byte-identical" "json stdout differs"
    fi
}

for row in "${ALIAS_ROWS[@]}"; do
    IFS='|' read -r alias_cmd canonical args <<< "$row"
    assert_row "$alias_cmd" "$canonical" "$args"
done

# ---------------------------------------------------------------------------
# No-.loki exit-code parity. A forwarding alias must add NO side effect the
# canonical lacks. emit.sh creates .loki/events/pending as a side effect, which
# previously made cmd_share's "No .loki/" guard pass (exit 0) and removed a
# bash-vs-bun race for read-only reporters. This row runs alias vs canonical in
# a FRESH dir with no .loki and asserts identical exit codes. (Seeded rows above
# mask this class; this is the dedicated guard.)
# ---------------------------------------------------------------------------
assert_no_loki_exit_parity() {
    local alias_cmd="$1" canonical="$2" args="$3"
    local label="$alias_cmd -> $canonical (no-.loki exit parity)"
    local fresh; fresh="$(mktemp -d "${TMPDIR:-/tmp}/loki-alias-noloki.XXXXXX")"
    # shellcheck disable=SC2206
    local alias_argv=($alias_cmd $args)
    # shellcheck disable=SC2206
    local canon_argv=($canonical $args)
    local a_code c_code
    ( cd "$fresh" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" "${alias_argv[@]}" >/dev/null 2>&1 ); a_code=$?
    rm -rf "$fresh"; fresh="$(mktemp -d "${TMPDIR:-/tmp}/loki-alias-noloki.XXXXXX")"
    ( cd "$fresh" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" "${canon_argv[@]}" >/dev/null 2>&1 ); c_code=$?
    rm -rf "$fresh"
    if [ "$a_code" = "$c_code" ]; then
        log_pass "$label: exit codes match ($a_code)"
    else
        log_fail "$label: exit codes match" "alias=$a_code canonical=$c_code"
    fi
}

# share is the canonical case (exits 1 at its no-.loki guard BEFORE any network
# call); the reporting rows exit-parity by construction once the side effect is
# gone.
assert_no_loki_exit_parity share "report share" "--format text"
assert_no_loki_exit_parity stats "report session" ""
assert_no_loki_exit_parity cost "report cost" ""

# ---------------------------------------------------------------------------
# Short-alias rows that share a handler with their canonical (cp/wt/rc/otel/
# open/serve). These do not all have stable stdout to byte-compare cheaply
# (some start servers / open browsers), so we assert the contract that is safe
# to check headlessly: the deprecation line fires for the alias and is
# suppressed under --json. Canonical equivalence for these lands with their
# noun groups in Phase B.
# ---------------------------------------------------------------------------
assert_short_alias() {
    local alias_cmd="$1" canonical="$2"
    local label="$alias_cmd -> $canonical (short alias)"
    local pat; pat="$(dep_pattern "$canonical")"
    local err
    # Use --help where the handler supports it so we never start a server.
    run_loki "$alias_cmd" --help >/dev/null 2>"$WORKDIR/sh.err" || true
    err="$(cat "$WORKDIR/sh.err")"
    if echo "$err" | grep -qF "$pat"; then
        log_pass "$label: deprecation line present (--help)"
    else
        log_fail "$label: deprecation line present (--help)" "missing: $pat (got: $err)"
    fi
    run_loki "$alias_cmd" --json --help >/dev/null 2>"$WORKDIR/shj.err" || true
    err="$(cat "$WORKDIR/shj.err")"
    if echo "$err" | grep -qF "$pat"; then
        log_fail "$label: --json suppresses deprecation line" "line leaked under --json"
    else
        log_pass "$label: --json suppresses deprecation line"
    fi
}

assert_short_alias cp checkpoint
assert_short_alias wt worktree
assert_short_alias rc remote
assert_short_alias otel telemetry
assert_short_alias serve "api start"
assert_short_alias open preview

# 'run' has its own inline deprecation (cmd_run, v6.84.0) aligned to the
# standardized pointer. A real 'loki run <N>' touches the network/issue path,
# so assert the contract on a bogus ref that exits fast: the pointer is present
# and suppressed under --json.
assert_run_alias() {
    local label="run -> start <issue> (inline alias)"
    local pat; pat="$(dep_pattern "start <issue-ref>")"
    local err
    run_loki run 999999 >/dev/null 2>"$WORKDIR/run.err" || true
    err="$(cat "$WORKDIR/run.err")"
    if echo "$err" | grep -qF "$pat"; then
        log_pass "$label: deprecation line present"
    else
        log_fail "$label: deprecation line present" "missing: $pat (got head: $(echo "$err" | head -1))"
    fi
    run_loki run 999999 --json >/dev/null 2>"$WORKDIR/runj.err" || true
    err="$(cat "$WORKDIR/runj.err")"
    if echo "$err" | grep -qF "$pat"; then
        log_fail "$label: --json suppresses deprecation line" "line leaked under --json"
    else
        log_pass "$label: --json suppresses deprecation line"
    fi
}
assert_run_alias

# ---------------------------------------------------------------------------
# Help-structure assertions
# ---------------------------------------------------------------------------
echo -e "${YELLOW}=== help-structure assertions (route: $ROUTE) ===${NC}"

HELP_OUT="$(run_loki help 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"

# Usage contract line still present (test-cli-commands.sh pins on "Usage").
if echo "$HELP_OUT" | grep -q "Usage:"; then
    log_pass "help: Usage line present"
else
    log_fail "help: Usage line present" "missing Usage:"
fi

# Group section headers present.
for grp in "Build:" "Session:" "Verify / trust:" "Observe:" "Report:" "Knowledge:" "Modernize:" "Config:"; do
    if echo "$HELP_OUT" | grep -qF "$grp"; then
        log_pass "help: group present ($grp)"
    else
        log_fail "help: group present ($grp)" "missing group header"
    fi
done

# Front-page canonical command-entry count is bounded (<= 20). We count lines
# in the "Commands:" block (up to the first "Options for" section) that look
# like a command entry: two-space indent + a lowercase token. Group headers end
# in ':' and are excluded.
CMD_BLOCK="$(echo "$HELP_OUT" | awk '/^Commands:/{f=1;next} /^Options for/{f=0} f')"
ENTRY_COUNT="$(echo "$CMD_BLOCK" | grep -E '^  [a-z]' | grep -vE '^  [a-z].*:$' | wc -l | tr -d ' ')"
if [ "$ENTRY_COUNT" -le 20 ] && [ "$ENTRY_COUNT" -ge 12 ]; then
    log_pass "help: front-page entry count in [12,20] ($ENTRY_COUNT)"
else
    log_fail "help: front-page entry count in [12,20]" "got $ENTRY_COUNT"
fi

# Deprecated alias tokens must NOT appear as command entries in the Commands
# block (they live in the footer / `loki help aliases`). We check the entry
# tokens specifically, not prose.
ENTRY_TOKENS="$(echo "$CMD_BLOCK" | grep -E '^  [a-z]' | grep -vE '^  [a-z].*:$' | awk '{print $1}')"
ALIAS_TOKENS="stats metrics cost export share dogfood trust-metrics serve open otel cp wt rc"
alias_leak=0
for tok in $ALIAS_TOKENS; do
    if echo "$ENTRY_TOKENS" | grep -qx "$tok"; then
        log_fail "help: alias token absent from Commands block" "found '$tok' as a front-page entry"
        alias_leak=1
    fi
done
[ "$alias_leak" = 0 ] && log_pass "help: no deprecated alias token in Commands block"

# `loki help aliases` lists every alias-table row.
ALIASES_OUT="$(run_loki help aliases 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
for tok in stats metrics cost export share dogfood trust-metrics serve open otel cp wt rc run; do
    if echo "$ALIASES_OUT" | grep -qE "^  $tok( |\$)"; then
        log_pass "help aliases: lists '$tok'"
    else
        log_fail "help aliases: lists '$tok'" "row missing from 'loki help aliases'"
    fi
done

# ---------------------------------------------------------------------------
echo ""
echo "===================================================="
echo -e "Results (route $ROUTE): ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "===================================================="
[ "$FAIL" -eq 0 ]
