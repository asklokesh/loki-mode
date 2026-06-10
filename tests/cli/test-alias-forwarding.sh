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
    # export uses 'markdown' (human-readable) here so the standard contract
    # (deprecation line present on alias stderr) holds. The positional
    # machine-output formats (json|csv|timeline) deliberately SUPPRESS the
    # pointer; that is asserted separately below (v7.31 finding 4).
    "export|report export|markdown"
    "dogfood|report dogfood|"
    # kpis -> report kpis (CLI consolidation Phase B). kpis is Bun-only: on the
    # Bun route both forms reach runKpis (timestamps normalized for byte
    # parity); on the bash route both print the honest Bun-requirement message
    # (empty stdout, exit 1). Either way the data-driven contract holds: alias
    # gets the pointer, canonical does not, machine flags suppress it. The
    # bash-route honesty specifics are also asserted in the finding-7 block.
    "kpis|report kpis|"
    "trust-metrics|trust detail|"
    # 'share' creates a real GitHub Gist (network + non-deterministic URL) when
    # invoked bare, so we exercise its forwarding contract via the deterministic
    # --help path instead. The deprecation line still fires under --help.
    "share|report share|--help"
    # CLI consolidation Phase B (slice B2): compound -> memory compound;
    # explain/onboard/code/context -> analyze <verb>; heal/migrate -> modernize
    # <verb>. The bare forms spawn agents or read large repo state, so the
    # deterministic --help path is used (matching the 'share' pattern). Each
    # handler's --help is stable, exits 0, and spawns nothing. The pointer still
    # fires under --help (not a machine-output flag).
    "compound|memory compound|--help"
    "explain|analyze explain|--help"
    "onboard|analyze onboard|--help"
    "code|analyze code|--help"
    "context|analyze context|--help"
    "heal|modernize heal|--help"
    "migrate|modernize migrate|--help"
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

# Phase B (slice B2): no-side-effect contract for each new alias. In a fresh dir
# with no .loki, the alias and its canonical must exit identically and (proven by
# the dedicated row at the end of this section) leave no .loki behind. --help is
# used so heal/migrate/explain/onboard/code never spawn an agent or touch any
# foreign process; the forwarding is still exercised through the noun dispatcher.
assert_no_loki_exit_parity compound "memory compound" "--help"
assert_no_loki_exit_parity explain "analyze explain" "--help"
assert_no_loki_exit_parity onboard "analyze onboard" "--help"
assert_no_loki_exit_parity code "analyze code" "--help"
assert_no_loki_exit_parity context "analyze context" "--help"
assert_no_loki_exit_parity heal "modernize heal" "--help"
assert_no_loki_exit_parity migrate "modernize migrate" "--help"

# Phase B (slice B2): prove each new alias creates NO .loki in a clean dir (the
# named no-side-effect contract). _deprecated_alias gates its telemetry emit on
# .loki already existing, so a forwarding alias must leave a fresh dir pristine.
for _b2_alias in compound explain onboard code context heal migrate; do
    _b2_fresh="$(mktemp -d "${TMPDIR:-/tmp}/loki-b2-noloki.XXXXXX")"
    ( cd "$_b2_fresh" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" "$_b2_alias" --help >/dev/null 2>&1 ) || true
    if [ ! -e "$_b2_fresh/.loki" ]; then
        log_pass "$_b2_alias alias: no .loki created in a clean dir (no-side-effect contract)"
    else
        log_fail "$_b2_alias alias: no .loki created in a clean dir" ".loki was created"
    fi
    rm -rf "$_b2_fresh"
done

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
# Phase B (slice B2): 'ctx' is the short alias of 'context', now forwarding to
# 'analyze context' (the pointer uses the typed token 'ctx').
assert_short_alias ctx "analyze context"

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
# v7.31 finding 3: the 'run' alias must add NO side effect in a clean dir. The
# telemetry emit creates .loki/events/pending; gate it on .loki existing (like
# every other alias). In a fresh dir with no .loki, `loki run <bogus>` must
# leave NO .loki behind.
# ---------------------------------------------------------------------------
{
    fresh="$(mktemp -d "${TMPDIR:-/tmp}/loki-run-noloki.XXXXXX")"
    ( cd "$fresh" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" run 999999 >/dev/null 2>&1 ) || true
    if [ ! -e "$fresh/.loki" ]; then
        log_pass "run alias: no .loki created in a clean dir (no-side-effect contract)"
    else
        log_fail "run alias: no .loki created in a clean dir" ".loki was created: $(find "$fresh/.loki" -type f 2>/dev/null | head -1)"
    fi
    rm -rf "$fresh"
}

# ---------------------------------------------------------------------------
# v7.31 finding 4: positional machine-output formats (export json|csv|timeline)
# must suppress the deprecation pointer so a combined 2>&1 stream stays clean.
# We assert on the bash route specifically (export routes through bash); stdout
# stays pure machine output and stderr carries no 'is now' note.
# ---------------------------------------------------------------------------
{
    for fmt in json csv timeline; do
        e_err="$( ( cd "$WORKDIR" && env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" export "$fmt" ) 2>&1 1>/dev/null)"
        if echo "$e_err" | grep -qF "is now 'loki report export'"; then
            log_fail "export $fmt: pointer suppressed (positional machine format)" "note leaked to stderr"
        else
            log_pass "export $fmt: pointer suppressed (positional machine format)"
        fi
    done
    # markdown (human-readable) is NOT a machine format: the pointer SHOULD fire.
    md_err="$( ( cd "$WORKDIR" && env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" export markdown ) 2>&1 1>/dev/null)"
    if echo "$md_err" | grep -qF "is now 'loki report export'"; then
        log_pass "export markdown: pointer still fires (human-readable, not suppressed)"
    else
        log_fail "export markdown: pointer still fires" "note missing for human-readable format"
    fi
}

# ---------------------------------------------------------------------------
# v7.31 finding 5: `trust detail` accepts the flag in any position and both
# orderings produce byte-identical stdout on the current route. (bin/loki routes
# any 'detail' token to bash; cmd_trust strips 'detail' flag-anywhere.)
# ---------------------------------------------------------------------------
{
    o1="$(run_loki trust --json detail 2>/dev/null | normalize)"
    o2="$(run_loki trust detail --json 2>/dev/null | normalize)"
    c1=$?
    run_loki trust --json detail >/dev/null 2>&1; rc1=$?
    run_loki trust detail --json >/dev/null 2>&1; rc2=$?
    if [ "$o1" = "$o2" ] && [ "$rc1" = "$rc2" ]; then
        log_pass "trust detail: flag-anywhere byte-identical stdout + exit ($rc1)"
    else
        log_fail "trust detail: flag-anywhere parity" "stdout_match=$([ "$o1" = "$o2" ] && echo yes || echo no) rc1=$rc1 rc2=$rc2"
    fi
}

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

# Front-page canonical command-entry count is bounded (<= 23). We count lines
# in the "Commands:" block (up to the first "Options for" section) that look
# like a command entry: two-space indent + a lowercase token. Group headers end
# in ':' and are excluded.
# v7.31.0 integration: upper bound grown 20 -> 22 to promote two v7.30 canonical
# commands into sensible groups -- quickstart (Build, guided first build) and
# mcp (Observe, the MCP server launcher added in v7.30) -- so the grouped front
# page lists them instead of burying them in the overflow prose.
# Phase B (slice B2): grown 22 -> 23 to admit the 'analyze' canonical noun
# (design section 2 #12), which absorbs explain/onboard/code/context as aliases.
# Net CANONICAL commands drop (four top-level commands become aliases, one noun
# is added); the line-count guardrail just tracks the new noun. Later Phase B
# slices (ui/new/admin) pull the front page back toward the ~17 target.
CMD_BLOCK="$(echo "$HELP_OUT" | awk '/^Commands:/{f=1;next} /^Options for/{f=0} f')"
ENTRY_COUNT="$(echo "$CMD_BLOCK" | grep -E '^  [a-z]' | grep -vE '^  [a-z].*:$' | wc -l | tr -d ' ')"
if [ "$ENTRY_COUNT" -le 23 ] && [ "$ENTRY_COUNT" -ge 12 ]; then
    log_pass "help: front-page entry count in [12,23] ($ENTRY_COUNT)"
else
    log_fail "help: front-page entry count in [12,23]" "got $ENTRY_COUNT"
fi

# Deprecated alias tokens must NOT appear as command entries in the Commands
# block (they live in the footer / `loki help aliases`). We check the entry
# tokens specifically, not prose.
ENTRY_TOKENS="$(echo "$CMD_BLOCK" | grep -E '^  [a-z]' | grep -vE '^  [a-z].*:$' | awk '{print $1}')"
ALIAS_TOKENS="stats metrics cost export share dogfood kpis trust-metrics serve open otel cp wt rc compound explain onboard code context heal migrate"
alias_leak=0
for tok in $ALIAS_TOKENS; do
    if echo "$ENTRY_TOKENS" | grep -qx "$tok"; then
        log_fail "help: alias token absent from Commands block" "found '$tok' as a front-page entry"
        alias_leak=1
    fi
done
[ "$alias_leak" = 0 ] && log_pass "help: no deprecated alias token in Commands block"

# v7.31 finding 8: piped help/grouped-help must emit ZERO ANSI escape sequences
# (isatty gate, matching the bare-loki welcome). We capture raw (no sed strip)
# through a pipe (non-TTY stdout) and assert no ESC bytes.
help_raw="$(run_loki help 2>/dev/null)"
if printf '%s' "$help_raw" | grep -q "$(printf '\033')"; then
    log_fail "help: no ANSI when piped" "ESC byte present in piped 'loki help'"
else
    log_pass "help: no ANSI when piped (isatty gate)"
fi
aliases_raw="$(run_loki help aliases 2>/dev/null)"
if printf '%s' "$aliases_raw" | grep -q "$(printf '\033')"; then
    log_fail "help aliases: no ANSI when piped" "ESC byte present in piped 'loki help aliases'"
else
    log_pass "help aliases: no ANSI when piped (isatty gate)"
fi

# `loki help aliases` lists every alias-table row.
ALIASES_OUT="$(run_loki help aliases 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
for tok in stats metrics cost export share dogfood kpis trust-metrics serve open otel cp wt rc run compound explain onboard code context ctx heal migrate; do
    if echo "$ALIASES_OUT" | grep -qE "^  $tok( |\$)"; then
        log_pass "help aliases: lists '$tok'"
    else
        log_fail "help aliases: lists '$tok'" "row missing from 'loki help aliases'"
    fi
done

# ---------------------------------------------------------------------------
# v7.31 finding 12: the bun-parity text normalizer in scripts/local-ci.sh must
# strip the optional "Dashboard:" status line (environment-dependent, not
# route-dependent) so the parity gate does not flake when the operator standalone
# dashboard is up. We assert the exact sed deletion: a Dashboard line (with an
# ANSI color prefix, as cmd_status / status.ts emit it) is removed while other
# lines survive. This guards against the local-ci sed being dropped/altered.
{
    fixture="$(printf '%bDashboard:%b http://127.0.0.1:57374/\nPhase: build\nIteration: 2\n' '\033[0;36m' '\033[0m')"
    stripped="$(printf '%s\n' "$fixture" | sed -E "/Dashboard:.*http/d")"
    if ! printf '%s' "$stripped" | grep -q "Dashboard:" \
        && printf '%s' "$stripped" | grep -q "Phase: build" \
        && printf '%s' "$stripped" | grep -q "Iteration: 2"; then
        log_pass "parity normalizer: Dashboard line stripped, other lines survive"
    else
        log_fail "parity normalizer Dashboard strip" "result: $(printf '%s' "$stripped" | tr '\n' '|')"
    fi
    # The local-ci script must actually contain this normalization rule.
    if grep -q 'Dashboard:.*http' "$REPO_ROOT/scripts/local-ci.sh"; then
        log_pass "parity normalizer: scripts/local-ci.sh has the Dashboard-line rule"
    else
        log_fail "parity normalizer rule present in local-ci.sh" "rule missing"
    fi
}

# ---------------------------------------------------------------------------
# v7.31 finding 6: `report dogfood` must degrade HONESTLY when
# scripts/dogfood-stats.sh is absent (it is a dev-only helper not shipped in the
# npm tarball). We force the absent path by pointing SKILL_DIR at a fixture dir
# that lacks scripts/. Contract: exit 0, an honest message on stderr (human
# mode), and a structured {"available": false} payload on stdout (--json).
{
    DF_SKILL="$(mktemp -d "${TMPDIR:-/tmp}/loki-dogfood-noscript.XXXXXX")"
    # human mode
    d_out="$(SKILL_DIR="$DF_SKILL" env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" report dogfood 2>"$DF_SKILL/d.err")"; d_code=$?
    d_err="$(cat "$DF_SKILL/d.err")"
    if [ "$d_code" -eq 0 ] \
        && echo "$d_err" | grep -qi "unavailable in this install" \
        && [ -z "$d_out" ]; then
        log_pass "report dogfood (script absent): exit 0, honest stderr, clean stdout"
    else
        log_fail "report dogfood degrade (human)" "code=$d_code stderr=$(echo "$d_err" | head -1)"
    fi
    # --json mode
    dj_out="$(SKILL_DIR="$DF_SKILL" env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" report dogfood --json 2>/dev/null)"; dj_code=$?
    if [ "$dj_code" -eq 0 ] && echo "$dj_out" | grep -qF '"available": false'; then
        log_pass "report dogfood --json (script absent): exit 0, {\"available\": false}"
    else
        log_fail "report dogfood degrade (--json)" "code=$dj_code json=$dj_out"
    fi
    rm -rf "$DF_SKILL"
}

# ---------------------------------------------------------------------------
# v7.31 finding 7: kpis is Bun-only. On the bash route it must NOT say the
# generic "Unknown command" (which contradicts help listing it); it must state
# the Bun requirement honestly (and emit {"available": false} for --json).
# ---------------------------------------------------------------------------
{
    k_err="$( ( cd "$WORKDIR" && env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" kpis ) 2>&1 1>/dev/null)"
    if echo "$k_err" | grep -qi "requires the Bun runtime" \
        && ! echo "$k_err" | grep -qi "Unknown command"; then
        log_pass "kpis (bash route): honest Bun-requirement message, not 'Unknown command'"
    else
        log_fail "kpis (bash route) honesty" "got: $(echo "$k_err" | head -1)"
    fi
    k_json="$( ( cd "$WORKDIR" && env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" kpis --json ) 2>/dev/null)"
    if echo "$k_json" | grep -qF '"available": false'; then
        log_pass "kpis --json (bash route): structured {\"available\": false}"
    else
        log_fail "kpis --json (bash route)" "got: $k_json"
    fi
}

# ---------------------------------------------------------------------------
# v7.32 finding 1 (HIGH, token-hijack): `kpis` is the report subcommand ONLY
# when it is the FIRST non-flag token after `report`. The canonical orderings
# (`report kpis --json`, `report --json kpis`) still route to the KPI handler,
# but a `kpis` token used as a POSITIONAL VALUE of a different report subcommand
# (export's output filename) must NOT be hijacked: `report export json kpis`
# (and the top-level `export json kpis` alias, which forwards through cmd_report)
# must behave exactly as on main -- exit 0 and create a file named `kpis`. Both
# routes (the suite runs twice: ROUTE=bun and ROUTE=bash).
# ---------------------------------------------------------------------------
{
    # 1a. Canonical kpis orderings still resolve to the KPI handler. On the bash
    # route both print the honest Bun-requirement message; on the Bun route both
    # render the snapshot. Either way they must NOT fall through to the legacy
    # report path ("Unknown option") -- that would mean the subcommand match
    # broke. We assert the snapshot/Bun-message on stdout+stderr combined.
    for order in "kpis --json" "--json kpis"; do
        # shellcheck disable=SC2086
        ro="$(run_loki report $order 2>&1)"
        if echo "$ro" | grep -qiE 'requires the Bun runtime|"available"|"schema_version"|Loki Mode KPIs' \
            && ! echo "$ro" | grep -qiF "Unknown option"; then
            log_pass "report $order: routes to kpis handler (route $ROUTE)"
        else
            log_fail "report $order: routes to kpis handler" "got: $(echo "$ro" | head -1)"
        fi
    done

    # 1b. export-positional-kpis must NOT be hijacked, both directions:
    #   - `report export json kpis`     (direct report subcommand)
    #   - `export json kpis`            (top-level export alias -> cmd_report)
    # Expected on every route, exactly as on main: exit 0, a file named `kpis`
    # created with the exported JSON. Run in a fresh mktemp dir so the output
    # file is isolated and the cwd is clean.
    for variant in "report export json kpis" "export json kpis"; do
        hj="$(mktemp -d "${TMPDIR:-/tmp}/loki-kpis-hijack.XXXXXX")"
        # cmd_export needs a session to export (else exit 1 "No active session");
        # seed the minimal fixture the finding's repro used.
        mkdir -p "$hj/.loki/state"
        echo '{"phase":"act","iteration":3}' > "$hj/.loki/state/session.json"
        # shellcheck disable=SC2086
        ( cd "$hj" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" $variant >/dev/null 2>&1 ); hj_code=$?
        if [ "$hj_code" -eq 0 ] && [ -f "$hj/kpis" ]; then
            log_pass "$variant: not hijacked -- exit 0, file 'kpis' created (route $ROUTE)"
        else
            log_fail "$variant: not hijacked" "code=$hj_code file_exists=$([ -f "$hj/kpis" ] && echo yes || echo no)"
        fi
        rm -rf "$hj"
    done
}

# ---------------------------------------------------------------------------
# v7.32 finding 1: main-parity proof for `report export json kpis`. We extract
# main's autonomy/loki via `git show` into a temp script and run the SAME
# command through it, then assert the current branch produces a byte-identical
# exported file (timestamps normalized). This pins the UX-monotonicity contract:
# a v7.31.0-working command keeps working identically. Runs on the BASH route
# (export is bash-owned); on the Bun route the shim delegates `export` to bash
# too, so the exported file is route-invariant. Skipped gracefully if git/main
# are unavailable (e.g. a shallow CI checkout).
# ---------------------------------------------------------------------------
{
    if git -C "$REPO_ROOT" rev-parse --verify -q main >/dev/null 2>&1; then
        MAIN_LOKI="$(mktemp "${TMPDIR:-/tmp}/loki-main-XXXXXX.sh")"
        if git -C "$REPO_ROOT" show main:autonomy/loki > "$MAIN_LOKI" 2>/dev/null && [ -s "$MAIN_LOKI" ]; then
            # main dir (seed the same minimal session fixture the finding used)
            md="$(mktemp -d "${TMPDIR:-/tmp}/loki-main-export.XXXXXX")"
            mkdir -p "$md/.loki/state"; echo '{"phase":"act","iteration":3}' > "$md/.loki/state/session.json"
            ( cd "$md" && env LOKI_LEGACY_BASH=1 bash "$MAIN_LOKI" report export json kpis >/dev/null 2>&1 ); m_code=$?
            # branch dir (via the same bash entrypoint to match main's invocation)
            bd="$(mktemp -d "${TMPDIR:-/tmp}/loki-branch-export.XXXXXX")"
            mkdir -p "$bd/.loki/state"; echo '{"phase":"act","iteration":3}' > "$bd/.loki/state/session.json"
            ( cd "$bd" && env LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/autonomy/loki" report export json kpis >/dev/null 2>&1 ); b_code=$?
            # The exported JSON embeds the VERSION string (differs main vs branch)
            # and a wall-clock "exported_at"; both are blanked so the assertion
            # pins the STRUCTURE + session payload (the monotonicity contract),
            # not the version bump or timestamp. normalize() handles the ISO time;
            # an extra sed blanks the "version" line.
            export_norm() { normalize | sed -E 's/"version": *"[^"]*"/"version": "<V>"/'; }
            if [ "$m_code" -eq 0 ] && [ "$b_code" -eq 0 ] && [ -f "$md/kpis" ] && [ -f "$bd/kpis" ] \
                && [ "$(export_norm < "$md/kpis")" = "$(export_norm < "$bd/kpis")" ]; then
                log_pass "report export json kpis: byte-identical to main (exit $b_code, file 'kpis' parity)"
            else
                log_fail "report export json kpis: main-parity" "main_code=$m_code branch_code=$b_code main_file=$([ -f "$md/kpis" ] && echo yes || echo no) branch_file=$([ -f "$bd/kpis" ] && echo yes || echo no)"
            fi
            rm -rf "$md" "$bd"
        else
            log_pass "report export json kpis: main-parity SKIPPED (main:autonomy/loki not extractable)"
        fi
        rm -f "$MAIN_LOKI"
    else
        log_pass "report export json kpis: main-parity SKIPPED (no 'main' ref in this checkout)"
    fi
}

# ---------------------------------------------------------------------------
# v7.32 finding 2 (MEDIUM, --json first-arg-only): on the bash route the
# Bun-requirement helper honors --json FLAG-ANYWHERE, not just as $1. With the
# suppression flags first, a machine consumer must still get the structured
# {"available": false} payload on stdout (not prose on stderr). Both the
# deprecated `kpis` alias and the canonical `report kpis` forms. Bash route
# specifically (the helper only runs there).
# ---------------------------------------------------------------------------
{
    for argv in "kpis --quiet --json" "report kpis -q --json"; do
        # shellcheck disable=SC2086
        j_out="$( ( cd "$WORKDIR" && env LOKI_LEGACY_BASH=1 bash "$LOKI_SHIM" $argv ) 2>/dev/null)"
        if echo "$j_out" | grep -qF '"available": false'; then
            log_pass "$argv (bash route): structured JSON on stdout (--json flag-anywhere)"
        else
            log_fail "$argv (bash route): --json flag-anywhere" "stdout: $j_out"
        fi
    done
}

# ---------------------------------------------------------------------------
# v7.32 finding 4 (LOW, error-channel parity): the consolidated noun family
# emits unknown-subcommand diagnostics on STDERR. The new nouns (analyze,
# modernize) already do; this asserts the migrated siblings (memory, report)
# now match -- error text on stderr, empty stdout, exit 1 -- on both routes.
# ---------------------------------------------------------------------------
{
    assert_err_channel() {
        local label="$1"; shift
        local fresh; fresh="$(mktemp -d "${TMPDIR:-/tmp}/loki-errchan.XXXXXX")"
        local out err code
        out="$( ( cd "$fresh" && env "${ROUTE_ENV[@]}" bash "$LOKI_SHIM" "$@" ) 2>"$fresh/e.err")"; code=$?
        err="$(cat "$fresh/e.err")"
        if [ "$code" -eq 1 ] && [ -z "$out" ] && echo "$err" | grep -qiF "Unknown"; then
            log_pass "$label: unknown-subcommand error on stderr, clean stdout, exit 1 (route $ROUTE)"
        else
            log_fail "$label: error-channel parity" "code=$code stdout='$out' stderr_head=$(echo "$err" | head -1)"
        fi
        rm -rf "$fresh"
    }
    assert_err_channel "memory bogus" memory bogus
    assert_err_channel "report bogus" report bogus
    # The new nouns are the reference (already stderr); assert they still are.
    assert_err_channel "analyze bogus" analyze bogus
    assert_err_channel "modernize bogus" modernize bogus
}

# ---------------------------------------------------------------------------
# v7.32 finding 3 (MEDIUM, stale-dist inversion): bin/loki must prefer the src
# dispatcher over a gitignored dist/loki.js when src is NEWER (so a dev machine
# never runs a stale bundle that lacks a freshly-added shim->Bun route like
# `report kpis`). A full touch-ordering mktemp test is awkward because bin/loki
# derives REPO_ROOT from its OWN path, so a copied shim resolves back to the
# real tree; per the task's sanctioned fallback we pin the guard with a static
# assertion that the `-nt` freshness check is present in the dist-preference arm.
# ---------------------------------------------------------------------------
{
    # Pattern starts with a non-dash char so it is never mis-parsed as a flag
    # (some environments alias grep to ugrep, which reads a leading '-nt' as the
    # -t option). Matches the `src/cli.ts" -nt "..dist/loki.js"` freshness arm.
    if grep -qF 'src/cli.ts" -nt "$REPO_ROOT/loki-ts/dist/loki.js"' "$REPO_ROOT/bin/loki"; then
        log_pass "bin/loki: stale-dist freshness guard present (src preferred when newer than dist)"
    else
        log_fail "bin/loki freshness guard" "the '-nt' dist-vs-src check is missing from bin/loki"
    fi
}

# ---------------------------------------------------------------------------
echo ""
echo "===================================================="
echo -e "Results (route $ROUTE): ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "===================================================="
[ "$FAIL" -eq 0 ]
