#!/usr/bin/env bash
#===============================================================================
# Live Build HUD Tests (FEAT-HUD)
#
# Targeted coverage for render_build_hud() / _hud_fmt_secs() in autonomy/run.sh.
# The HUD is a single per-iteration stdout line emitted only on an interactive
# TTY (foreground, not --bg, not opted out). Reference: docs/BUILD-HUD-PLAN.md S10.
#
# WHY EXTRACT, NOT SOURCE run.sh: sourcing autonomy/run.sh executes main() and
# starts the orchestrator. Instead we extract the two self-contained HUD helpers
# (by name anchor, so the test does not rot when line numbers drift) into a temp
# file and source THAT with CYAN/NC/MAX_ITERATIONS defined.
#
# WHY A PTY FOR CASES 1/3/4/6: the gate (run.sh:1017) early-returns 0 BEFORE the
# body touches a single variable when stdout is not a tty. So any test that wants
# to exercise the body (cost render, opt-out, set -u safety, ETA) MUST run under
# a pseudo-tty, otherwise it passes vacuously without ever entering the gate. We
# drive the helper under a pty via `python3 -c 'import pty; pty.spawn(...)'`,
# which is portable across macOS and Linux (GNU/BSD `script` differ in CLI), and
# python3 is already a runtime dependency of the cost read. Case 2 (off-TTY zero
# bytes) and case 5 (_hud_fmt_secs, which has no gate) run without a pty.
#
# NON-VACUITY: case 1 asserts the pty path actually emits `[HUD]` (proves the
# gate-open branch is reached); case 2 asserts the off-TTY path emits ZERO bytes
# (proves the parity guarantee). Together they prove the gate both fires and
# suppresses.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_SH="$PROJECT_DIR/autonomy/run.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-buildhud.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Live Build HUD Tests (FEAT-HUD)"
echo "==============================="
echo ""

# -----------------------------------------------------------------------------
# Extract the two HUD helpers from autonomy/run.sh into a sourceable temp file.
# Anchored on the function-definition lines, not absolute line numbers.
# render_build_hud() opens the block; we keep printing until the first top-level
# `}` AFTER _hud_fmt_secs() opens (the inner blocks are indented, so `^}` only
# matches the two function-closing braces).
# -----------------------------------------------------------------------------
HUD_LIB="$WORKROOT/hud-lib.sh"
awk '
    /^render_build_hud\(\) \{/ { p=1 }
    p { print }
    p && /^_hud_fmt_secs\(\) \{/ { f=1 }
    f && /^}/ { exit }
' "$RUN_SH" > "$HUD_LIB"

# Sanity: the extraction must contain BOTH function definitions, or every test
# below is meaningless. Fail loudly (not vacuously) if extraction missed.
if grep -q '^render_build_hud() {' "$HUD_LIB" && grep -q '^_hud_fmt_secs() {' "$HUD_LIB"; then
    pass "extracted render_build_hud + _hud_fmt_secs from run.sh ($(wc -l < "$HUD_LIB" | tr -d ' ') lines)"
else
    fail "could not extract both HUD helpers from $RUN_SH" "$(head -3 "$HUD_LIB")"
    echo ""
    echo "Results: $PASS/$TOTAL passed, $FAIL failed (extraction failed; aborting)"
    exit 1
fi

# pty driver: run a bash harness with stdout connected to a pseudo-tty so that
# `[ -t 1 ]` is true inside the harness. Returns the harness stdout. Portable
# across macOS/Linux. If a pty cannot be allocated we print a SKIP sentinel so a
# missing-pty environment never masquerades as a silent PASS.
run_under_pty() {
    local harness="$1"
    if ! command -v python3 >/dev/null 2>&1; then
        echo "__PTY_UNAVAILABLE__"
        return 0
    fi
    python3 -c 'import pty,sys; pty.spawn(["bash", sys.argv[1]])' "$harness" 2>/dev/null \
        || echo "__PTY_UNAVAILABLE__"
}

# =============================================================================
# Test 1: HUD appears on a TTY; cost field renders with a fake tracking.json and
#         DEGRADES (line still appears, no cost field) when it is removed.
# =============================================================================
echo "Test 1: HUD renders on a TTY (contains [HUD] + iter 1/), cost field + degrade"
T1="$WORKROOT/t1"
mkdir -p "$T1/.loki/context"
# Fake cumulative cost so the cost field renders. Cost is read CWD-relative
# (.loki/context/tracking.json), so the harness cd's into $T1.
cat > "$T1/.loki/context/tracking.json" <<'EOF'
{"totals": {"total_cost_usd": 0.42}}
EOF

cat > "$WORKROOT/h1-cost.sh" <<EOF
cd "$T1" || exit 1
CYAN=''; NC=''; MAX_ITERATIONS=5
# Leave _LOKI_RUN_START_SHA unset so the files field is omitted (keeps the
# cost/iter assertions clean); leave start epoch unset so no elapsed/eta noise.
source "$HUD_LIB"
render_build_hud 1 REASON 5
EOF
out1="$(run_under_pty "$WORKROOT/h1-cost.sh")"

if echo "$out1" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 1 SKIPPED: no pty available (acceptance requires the TTY path)" "$out1"
elif echo "$out1" | grep -q '\[HUD\]' && echo "$out1" | grep -q 'iter 1/'; then
    pass "HUD line emitted on a TTY (contains [HUD] and iter 1/)"
    if echo "$out1" | grep -q '\$0\.42'; then
        pass "cost field renders (\$0.42) from the fake tracking.json"
    else
        fail "cost field did not render with a valid tracking.json" "out=$out1"
    fi
else
    fail "HUD line not emitted under a pty (gate not reached - vacuous risk)" "out=$out1"
fi

# Degrade: remove tracking.json -> line STILL appears, WITHOUT a cost field.
rm -f "$T1/.loki/context/tracking.json"
out1d="$(run_under_pty "$WORKROOT/h1-cost.sh")"
if echo "$out1d" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 1 degrade SKIPPED: no pty available" "$out1d"
elif echo "$out1d" | grep -q '\[HUD\]' && ! echo "$out1d" | grep -q '\$0\.'; then
    pass "degrade: HUD line still appears with NO cost field when tracking.json is absent"
else
    fail "degrade path wrong: expected [HUD] without a \$ cost field" "out=$out1d"
fi

# =============================================================================
# Test 2: Off-TTY byte-identical -- the HUD must add ZERO bytes off a tty, both
#         with LOKI_HUD unset and with LOKI_HUD=0. This is the parity guarantee.
# =============================================================================
echo "Test 2: off-TTY emits ZERO bytes (LOKI_HUD unset and LOKI_HUD=0)"
T2="$WORKROOT/t2"
mkdir -p "$T2/.loki/context"
cat > "$T2/.loki/context/tracking.json" <<'EOF'
{"totals": {"total_cost_usd": 1.23}}
EOF

# Run the helper with stdout NOT a tty (a normal command-substitution pipe).
out2_unset="$(cd "$T2" || exit 1; CYAN=''; NC=''; MAX_ITERATIONS=5; source "$HUD_LIB"; render_build_hud 2 ACT 9)"
out2_zero="$(cd "$T2" || exit 1; CYAN=''; NC=''; MAX_ITERATIONS=5; LOKI_HUD=0; source "$HUD_LIB"; render_build_hud 2 ACT 9)"

if [ -z "$out2_unset" ] && [ -z "$out2_zero" ]; then
    pass "off-TTY produced zero bytes with LOKI_HUD unset AND LOKI_HUD=0 (byte-identical parity)"
else
    fail "off-TTY must produce zero bytes" "unset=[$out2_unset] zero=[$out2_zero]"
fi

# =============================================================================
# Test 3: Opt-out on a TTY -- LOKI_HUD=0 under a pty must emit NO [HUD] line.
# =============================================================================
echo "Test 3: opt-out on a TTY (LOKI_HUD=0) emits no [HUD]"
cat > "$WORKROOT/h3-optout.sh" <<EOF
cd "$T2" || exit 1
CYAN=''; NC=''; MAX_ITERATIONS=5; export LOKI_HUD=0
source "$HUD_LIB"
render_build_hud 1 REASON 5
echo "SENTINEL_END"
EOF
out3="$(run_under_pty "$WORKROOT/h3-optout.sh")"
if echo "$out3" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 3 SKIPPED: no pty available" "$out3"
elif echo "$out3" | grep -q 'SENTINEL_END' && ! echo "$out3" | grep -q '\[HUD\]'; then
    pass "LOKI_HUD=0 on a TTY suppressed the HUD (no [HUD], harness still ran)"
else
    fail "opt-out failed: [HUD] present or harness did not run" "out=$out3"
fi

# =============================================================================
# Test 4: set -u safety -- run the helper under `bash -u` on a TTY with iter/
#         phase/dur present but MAX_ITERATIONS / _LOKI_RUN_START_SHA /
#         _LOKI_RUN_START_EPOCH / tracking.json all unset/absent. Must exit 0
#         with no "unbound variable". Must run under a pty (the body only
#         executes when the gate is open).
# =============================================================================
echo "Test 4: set -u safety with all optional vars unset (TTY, bash -u)"
T4="$WORKROOT/t4-empty"
mkdir -p "$T4"   # no .loki, no tracking.json
cat > "$WORKROOT/h4-setu.sh" <<EOF
set -u
cd "$T4" || exit 1
# CYAN/NC must be defined: the final echo references them with no :- default,
# so leaving them unset would itself be the unbound-variable false positive we
# are testing for. Everything ELSE (MAX_ITERATIONS, _LOKI_RUN_START_SHA,
# _LOKI_RUN_START_EPOCH, LOKI_MAX_ITERATIONS) is deliberately left unset.
CYAN=''; NC=''
source "$HUD_LIB"
render_build_hud 1 REASON 5 && echo "RC=0" || echo "RC=\$?"
EOF
out4="$(run_under_pty "$WORKROOT/h4-setu.sh" 2>&1)"
if echo "$out4" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 4 SKIPPED: no pty available" "$out4"
elif echo "$out4" | grep -qi 'unbound variable'; then
    fail "set -u: helper hit an unbound variable" "out=$out4"
elif echo "$out4" | grep -q 'RC=0' && echo "$out4" | grep -q '\[HUD\]'; then
    pass "helper exits 0 under bash -u with all optional vars unset (no unbound var); HUD still rendered"
else
    fail "set -u: expected RC=0 + [HUD], no unbound error" "out=$out4"
fi

# =============================================================================
# Test 5: _hud_fmt_secs formatting -- 37->37s, 131->2m11s, 3720->1h02m.
#         No gate on this helper, so no pty needed.
# =============================================================================
echo "Test 5: _hud_fmt_secs formatting (37s / 2m11s / 1h02m)"
fmt_check() {
    local in="$1" want="$2"
    local got
    got="$(CYAN=''; NC=''; source "$HUD_LIB"; _hud_fmt_secs "$in")"
    if [ "$got" = "$want" ]; then
        pass "_hud_fmt_secs($in) = '$got'"
    else
        fail "_hud_fmt_secs($in) expected '$want'" "got '$got'"
    fi
}
fmt_check 37 "37s"
fmt_check 131 "2m11s"
fmt_check 3720 "1h02m"

# =============================================================================
# Test 6: ETA -- with a small LOKI_MAX_ITERATIONS (10), a start epoch in the
#         past, and iter 3, an `eta ~` field appears. With default/unset max
#         (LOKI_MAX_ITERATIONS unset), NO eta field appears. Must run under a
#         pty (ETA is computed in the gated body).
# =============================================================================
echo "Test 6: ETA appears only with a small LOKI_MAX_ITERATIONS"
T6="$WORKROOT/t6"
mkdir -p "$T6"
PAST_EPOCH="$(( $(date +%s) - 600 ))"   # 10 minutes ago

# 6a: small max -> eta present
cat > "$WORKROOT/h6-eta.sh" <<EOF
cd "$T6" || exit 1
CYAN=''; NC=''; MAX_ITERATIONS=10
export LOKI_MAX_ITERATIONS=10
export _LOKI_RUN_START_EPOCH=$PAST_EPOCH
source "$HUD_LIB"
render_build_hud 3 REFLECT 5
EOF
out6a="$(run_under_pty "$WORKROOT/h6-eta.sh")"

# 6b: unset max -> no eta
cat > "$WORKROOT/h6-noeta.sh" <<EOF
cd "$T6" || exit 1
CYAN=''; NC=''; MAX_ITERATIONS=1000
unset LOKI_MAX_ITERATIONS
export _LOKI_RUN_START_EPOCH=$PAST_EPOCH
source "$HUD_LIB"
render_build_hud 3 REFLECT 5
EOF
out6b="$(run_under_pty "$WORKROOT/h6-noeta.sh")"

if echo "$out6a" | grep -q '__PTY_UNAVAILABLE__' || echo "$out6b" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 6 SKIPPED: no pty available" "$out6a / $out6b"
elif echo "$out6a" | grep -q 'eta ~' && ! echo "$out6b" | grep -q 'eta ~'; then
    pass "eta ~ present with small LOKI_MAX_ITERATIONS, absent with unset max"
else
    fail "ETA gating wrong" "with-small-max=[$out6a] with-unset-max=[$out6b]"
fi

echo ""
echo "==============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
