#!/usr/bin/env bash
# tests/test-assumption-gate-brief-mode.sh -- F50: zero-config / one-line-brief
# runs must cleanly COMPLETE.
#
# Root cause being verified: a class=contradictory ledger entry is never
# auto-acknowledged (P2-4), so in autonomous mode (no human to set
# confirmed=true) the assumption-ledger gate blocks completion forever and a
# brief run grinds to max-iterations. That is a broken first-run UX for the
# non-technical zero-config audience the brief path exists to serve.
#
# Fix under test (spec_ledger_acknowledge_all in autonomy/spec-interrogation.sh):
#   - brief mode (LOKI_TTFV=brief, or explicit param "brief"): a contradiction is
#     RESOLVED-WITH-DEFAULT (acknowledged=true + resolved_with_default=true +
#     honest resolution_note) so council_assumption_ledger_gate clears (rc 0).
#   - PRD / default mode: a contradiction is STILL NOT auto-acked; the gate STILL
#     blocks (rc 1) so a human can resolve it (unchanged behavior).
#   - Honesty: the contradiction is still recorded and still counted by
#     spec_ledger_counts, and ledger.md shows the resolved-with-default state and
#     the resolution note. Nothing is silently dropped.
#
# Uses the REAL functions with NO provider call (canned ledger JSON + the REAL
# gate). Skips gracefully when python3 or the implementation is absent.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SI_SH="$REPO_ROOT/autonomy/spec-interrogation.sh"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"
    exit 0
fi
if [ ! -f "$SI_SH" ] || [ ! -f "$COUNCIL_SH" ]; then
    echo "SKIP: spec-interrogation.sh or completion-council.sh not found. (Not a fail.)"
    exit 0
fi

# Stub log_* helpers (run.sh provides them in production).
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }
log_step()    { :; }

# shellcheck source=/dev/null
source "$SI_SH"
# shellcheck source=/dev/null
source "$COUNCIL_SH"

if ! type spec_ledger_acknowledge_all >/dev/null 2>&1 \
   || ! type council_assumption_ledger_gate >/dev/null 2>&1; then
    echo "SKIP: required functions not defined. (Not a fail.)"
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-assumption-brief.XXXXXX)" || exit 2
cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

# Write a fresh isolated TARGET_DIR holding one OPEN high-severity contradiction.
# Echoes the absolute path.
new_contra_target() {
    local name="$1"
    local t="$TMP_ROOT/$name"
    mkdir -p "$t/.loki/assumptions" "$t/.loki/council"
    cat > "$t/.loki/assumptions/a-contra01.json" <<'ENTRY'
{
  "id": "a-contra01",
  "gap": "Section 2 mandates immutable records; section 5 specifies an edit endpoint.",
  "assumption": "Spec is internally inconsistent; cannot satisfy both.",
  "why": "grill: Contradictions",
  "severity": "high",
  "class": "contradictory",
  "affects": "data-model",
  "source": "grill",
  "confirmed": false,
  "acknowledged": false,
  "created_at": "2026-06-20T00:00:00Z"
}
ENTRY
    printf '%s' "$t"
}

# ===========================================================================
# CASE 1 (regression guard): default / PRD mode STILL blocks on a contradiction.
# ===========================================================================
t1="$(new_contra_target case-prd)"
(
    export TARGET_DIR="$t1"
    # No LOKI_TTFV (PRD/default mode). Ack lifecycle must NOT clear the contradiction.
    unset LOKI_TTFV 2>/dev/null || true
    spec_ledger_acknowledge_all
)
GATE_RC1=0
(
    export TARGET_DIR="$t1"
    export COUNCIL_STATE_DIR="$t1/.loki/council"
    export ITERATION_COUNT=3
    unset LOKI_TTFV 2>/dev/null || true
    council_assumption_ledger_gate
)
GATE_RC1=$?
if [ "$GATE_RC1" -eq 1 ]; then
    ok "(1) PRD mode: contradiction STILL blocks completion (rc 1)"
else
    bad "(1) PRD-mode block" "expected 1, got $GATE_RC1"
fi
# Prove the contradiction stayed unacknowledged in PRD mode.
_ack1="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("acknowledged"))' \
    "$t1/.loki/assumptions/a-contra01.json" 2>/dev/null)"
if [ "$_ack1" = "False" ]; then
    ok "(1) PRD mode: contradiction left acknowledged=false (unchanged P2-4)"
else
    bad "(1) PRD-mode ack state" "expected False, got $_ack1"
fi

# ===========================================================================
# CASE 2 (the fix): brief mode RESOLVES-WITH-DEFAULT -> gate clears.
# ===========================================================================
t2="$(new_contra_target case-brief)"
(
    export TARGET_DIR="$t2"
    export LOKI_TTFV=brief        # zero-config one-line-brief run
    spec_ledger_acknowledge_all
    spec_ledger_rebuild_md
) >/dev/null 2>&1
GATE_RC2=0
(
    export TARGET_DIR="$t2"
    export COUNCIL_STATE_DIR="$t2/.loki/council"
    export ITERATION_COUNT=3
    export LOKI_TTFV=brief
    council_assumption_ledger_gate
)
GATE_RC2=$?
if [ "$GATE_RC2" -eq 0 ]; then
    ok "(2) brief mode: contradiction resolved-with-default -> gate clears (rc 0)"
else
    bad "(2) brief-mode clear" "expected 0, got $GATE_RC2 (brief run would never complete)"
fi
if [ ! -f "$t2/.loki/council/assumption-block.json" ]; then
    ok "(2) brief mode: no permanent block file written"
else
    bad "(2) brief-mode block file" "assumption-block.json should not exist"
fi

# ===========================================================================
# CASE 3 (honesty): the resolved contradiction is still recorded + surfaced.
# ===========================================================================
# 3a: still counted (surfacing in proof-of-done is independent of ack state).
_c3="$(TARGET_DIR="$t2" spec_ledger_counts)"
_total3="${_c3%% *}"; _high3="${_c3##* }"
if [ "$_total3" = "1" ] && [ "$_high3" = "1" ]; then
    ok "(3a) brief mode: contradiction still counted (total=1 high=1), not dropped"
else
    bad "(3a) brief-mode counts" "expected total=1 high=1, got total=$_total3 high=$_high3"
fi
# 3b: the resolved_with_default marker + honest note are persisted.
_rwd="$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("resolved_with_default"))' \
    "$t2/.loki/assumptions/a-contra01.json" 2>/dev/null)"
_note="$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("resolution_note") or "")' \
    "$t2/.loki/assumptions/a-contra01.json" 2>/dev/null)"
if [ "$_rwd" = "True" ] && [ -n "$_note" ]; then
    ok "(3b) brief mode: resolved_with_default=true + honest resolution_note recorded"
else
    bad "(3b) brief-mode honesty marker" "resolved_with_default=$_rwd note='${_note}'"
fi
# 3c: ledger.md shows the resolved-with-default state + note (loki own / receipt path).
if grep -q 'resolved-with-default' "$t2/.loki/assumptions/ledger.md" 2>/dev/null \
   && grep -q '^- Resolution:' "$t2/.loki/assumptions/ledger.md" 2>/dev/null; then
    ok "(3c) brief mode: ledger.md surfaces resolved-with-default state + Resolution line"
else
    bad "(3c) brief-mode ledger.md" "missing resolved-with-default state or Resolution line"
fi

# ===========================================================================
# CASE 4: a non-contradiction high-sev gap is auto-acked in BOTH modes (no
# regression to the existing gap lifecycle). Brief mode must not REGRESS the
# normal gap path -- it only ADDS contradiction resolution.
# ===========================================================================
t4="$TMP_ROOT/case-gap"
mkdir -p "$t4/.loki/assumptions" "$t4/.loki/council"
cat > "$t4/.loki/assumptions/a-gap01.json" <<'GENTRY'
{
  "id": "a-gap01",
  "gap": "How are passwords stored?",
  "assumption": "Spec silent; took the implementer default.",
  "why": "grill: Security blind spots",
  "severity": "high",
  "class": "missing",
  "affects": "security",
  "source": "grill",
  "confirmed": false,
  "acknowledged": false,
  "created_at": "2026-06-20T00:00:00Z"
}
GENTRY
(
    export TARGET_DIR="$t4"
    export LOKI_TTFV=brief
    spec_ledger_acknowledge_all
)
GATE_RC4=0
(
    export TARGET_DIR="$t4"
    export COUNCIL_STATE_DIR="$t4/.loki/council"
    export ITERATION_COUNT=3
    export LOKI_TTFV=brief
    council_assumption_ledger_gate
)
GATE_RC4=$?
if [ "$GATE_RC4" -eq 0 ]; then
    ok "(4) brief mode: ordinary high-sev gap auto-acked -> gate clears (no regression)"
else
    bad "(4) brief-mode gap clear" "expected 0, got $GATE_RC4"
fi
# An ordinary gap must NOT be marked resolved_with_default (that label is for
# contradictions only; a gap is a plain auto-ack).
_rwd4="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("resolved_with_default"))' \
    "$t4/.loki/assumptions/a-gap01.json" 2>/dev/null)"
if [ "$_rwd4" = "None" ]; then
    ok "(4) brief mode: ordinary gap NOT mislabeled resolved_with_default"
else
    bad "(4) gap label leak" "expected None, got $_rwd4"
fi

echo ""
echo "==================================================="
echo "assumption-gate brief-mode tests: $PASS passed, $FAIL failed"
echo "==================================================="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
