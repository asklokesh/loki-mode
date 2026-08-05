#!/usr/bin/env bash
# tests/test-evidence-gate-rc.sh -- regression guard for
# _evidence_gate_and_surface() rc propagation (autonomy/run.sh:10168).
#
# WHAT THIS GUARDS
#   _evidence_gate_and_surface() wraps council_evidence_gate() so its advisory
#   sibling surface_evidence_gate_details() also runs, while preserving the
#   caller's `! council_evidence_gate` elif-chain semantics byte-for-byte: a
#   failing evidence gate must still propagate its exact non-zero rc out of
#   the wrapper. tests/test-human-intervention-signals.sh:69 stubs
#   _evidence_gate_and_surface() itself as a no-op dependency (it is testing
#   check_human_intervention, a DIFFERENT function) -- so the wrapper's own rc
#   propagation has never been driven against the real function body. A
#   regression that swallows the gate's rc (e.g. `return 0` unconditionally,
#   or `|| true` added to the gate call) would silently let a failing evidence
#   gate stop blocking completion.
#
# STRATEGY
#   Extract ONLY _evidence_gate_and_surface() from run.sh by name (not sourcing
#   the whole file). Stub its two dependencies: council_evidence_gate (the rc
#   under test) and surface_evidence_gate_details (advisory-only, must not
#   affect the returned rc even when the stub itself fails).
#
#   RUN_SH overridable so the non-vacuity self-check can point at a mutated copy.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

# Extract ONLY _evidence_gate_and_surface() from run.sh. Function spans from
# its `() {` line to the first line that is exactly `}` at column 0.
_fn="$(awk '/^_evidence_gate_and_surface\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: _evidence_gate_and_surface not found in run.sh. Implementation not landed. (Not a fail.)"
    exit 0
fi

# ---------------------------------------------------------------------------
# Case 1: council_evidence_gate FAILS (rc=2) -> the wrapper must propagate rc=2
# ---------------------------------------------------------------------------
council_evidence_gate() { return 2; }
surface_evidence_gate_details() { return 0; }

# shellcheck disable=SC1090
eval "$_fn"

if ! type _evidence_gate_and_surface >/dev/null 2>&1; then
    echo "SKIP: _evidence_gate_and_surface did not eval cleanly. (Not a fail.)"; exit 0
fi

rc=0; _evidence_gate_and_surface || rc=$?
if [ "$rc" -eq 2 ]; then
    ok "failing council_evidence_gate (rc=2) propagates rc=2 out of the wrapper"
else
    bad "failing council_evidence_gate (rc=2) propagates rc=2 out of the wrapper" "got rc=$rc"
fi

# ---------------------------------------------------------------------------
# Case 2: surface_evidence_gate_details ALSO fails -- its rc must NOT leak.
# The wrapper's `|| true` on the surface call must keep the gate's rc (2) as
# the return value, not the surface helper's failure.
# ---------------------------------------------------------------------------
council_evidence_gate() { return 2; }
surface_evidence_gate_details() { return 1; }
eval "$_fn"

rc=0; _evidence_gate_and_surface || rc=$?
if [ "$rc" -eq 2 ]; then
    ok "a failing surface_evidence_gate_details does not clobber the gate's rc"
else
    bad "a failing surface_evidence_gate_details does not clobber the gate's rc" "got rc=$rc"
fi

# ---------------------------------------------------------------------------
# Case 3: council_evidence_gate PASSES (rc=0) -> the wrapper returns 0.
# ---------------------------------------------------------------------------
council_evidence_gate() { return 0; }
surface_evidence_gate_details() { return 0; }
eval "$_fn"

rc=0; _evidence_gate_and_surface || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "passing council_evidence_gate (rc=0) returns 0"
else
    bad "passing council_evidence_gate (rc=0) returns 0" "got rc=$rc"
fi

# ---------------------------------------------------------------------------
# Case 4: a different non-zero rc (e.g. 1) also propagates exactly, not just 2.
# ---------------------------------------------------------------------------
council_evidence_gate() { return 1; }
surface_evidence_gate_details() { return 0; }
eval "$_fn"

rc=0; _evidence_gate_and_surface || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "failing council_evidence_gate (rc=1) propagates rc=1 exactly (not clamped)"
else
    bad "failing council_evidence_gate (rc=1) propagates rc=1 exactly (not clamped)" "got rc=$rc"
fi

# ---------------------------------------------------------------------------
echo
echo "evidence-gate-rc: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
