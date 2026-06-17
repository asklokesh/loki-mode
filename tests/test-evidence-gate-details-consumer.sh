#!/usr/bin/env bash
# tests/test-evidence-gate-details-consumer.sh -- regression guard for v7.51.0
# P1-1 "evidence-gate-details consumer".
#
# WHAT THIS GUARDS
#   The completion council writes .loki/council/evidence-gate-details.json on
#   every evidence-gate run. Before v7.51.0 run.sh had ZERO consumers of that
#   file -- the audit record was durable but invisible. v7.51.0 added
#   surface_evidence_gate_details() (autonomy/run.sh), an ADVISORY consumer that:
#     - present + verdict=block  -> WARN (visible, attention-grabbing)
#     - present + verdict!=block -> INFO (visible, informational)
#     - absent / malformed       -> silent, rc 0 (degrade, never error/block)
#   It NEVER blocks and returns rc 0 always.
#
#   tests/test-evidence-gate-no-tests.sh asserts the council WRITES the file.
#   This test asserts run.sh CONSUMES it with the right WARN/INFO/silent
#   behavior -- a distinct, previously-uncovered code path.
#
# STRATEGY
#   surface_evidence_gate_details lives in run.sh and depends only on log_warn /
#   log_info and python3. We extract the function body from run.sh by name (not
#   sourcing all of run.sh) and re-route log_warn -> "WARN:" / log_info ->
#   "INFO:" markers so we can assert which arm fired. We then drive it against a
#   block detail file, a pass detail file, an absent file, and a malformed file.
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

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

# Extract ONLY surface_evidence_gate_details() from run.sh and eval it. Avoids
# executing run.sh top-level code. The function spans from its `() {` line to
# the first line that is exactly `}` at column 0.
_fn="$(awk '/^surface_evidence_gate_details\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: surface_evidence_gate_details not found in run.sh. Implementation not landed. (Not a fail.)"
    exit 0
fi

# Markered log helpers so we can detect which arm fired.
log_warn() { printf 'WARN: %s\n' "$*"; }
log_info() { printf 'INFO: %s\n' "$*"; }

# shellcheck disable=SC1090
eval "$_fn"

if ! type surface_evidence_gate_details >/dev/null 2>&1; then
    echo "SKIP: surface_evidence_gate_details did not eval cleanly. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-egd-consumer-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# write_details <dir> <json>  -> writes <dir>/.loki/council/evidence-gate-details.json
write_details() {
    local dir="$1" json="$2"
    mkdir -p "$dir/.loki/council"
    printf '%s' "$json" > "$dir/.loki/council/evidence-gate-details.json"
}

# run_surface <dir> -> captures stdout (the WARN:/INFO: marker) + rc.
run_surface() {
    local dir="$1"
    ( TARGET_DIR="$dir"; export TARGET_DIR; surface_evidence_gate_details )
}

# ---------------------------------------------------------------------------
# Case 1: verdict=block -> WARN
# ---------------------------------------------------------------------------
echo "Case 1: present + verdict=block -> WARN"
D1="$WORK/block"; mkdir -p "$D1"
write_details "$D1" '{"verdict":"block","diff":{"ok":false},"tests":{"ok":false,"runner":"node-test"}}'
out1="$(run_surface "$D1")"; rc1=$?
if printf '%s' "$out1" | grep -q '^WARN:.*verdict=block'; then
    ok "case1 block -> WARN (out: $out1)"
else
    bad "case1 block did not WARN" "out=[$out1]"
fi
[ "$rc1" -eq 0 ] && ok "case1 rc 0 (never blocks)" || bad "case1 rc!=0" "rc=$rc1"

# ---------------------------------------------------------------------------
# Case 2: verdict=pass -> INFO (not WARN)
# ---------------------------------------------------------------------------
echo "Case 2: present + verdict!=block -> INFO"
D2="$WORK/pass"; mkdir -p "$D2"
write_details "$D2" '{"verdict":"pass","diff":{"ok":true},"tests":{"ok":true,"runner":"node-test"}}'
out2="$(run_surface "$D2")"; rc2=$?
if printf '%s' "$out2" | grep -q '^INFO:.*verdict=pass'; then
    ok "case2 pass -> INFO (out: $out2)"
else
    bad "case2 pass did not INFO" "out=[$out2]"
fi
if printf '%s' "$out2" | grep -q '^WARN:'; then
    bad "case2 pass wrongly WARNed" "out=[$out2]"
else
    ok "case2 pass did not WARN"
fi
[ "$rc2" -eq 0 ] && ok "case2 rc 0" || bad "case2 rc!=0" "rc=$rc2"

# ---------------------------------------------------------------------------
# Case 3: absent file -> silent, rc 0
# ---------------------------------------------------------------------------
echo "Case 3: absent file -> silent + rc 0"
D3="$WORK/absent"; mkdir -p "$D3"   # no details file
out3="$(run_surface "$D3")"; rc3=$?
if [ -z "$out3" ]; then
    ok "case3 absent -> no output (silent)"
else
    bad "case3 absent produced output" "out=[$out3]"
fi
[ "$rc3" -eq 0 ] && ok "case3 rc 0 (degrades silently)" || bad "case3 rc!=0" "rc=$rc3"

# ---------------------------------------------------------------------------
# Case 4: malformed JSON -> silent, rc 0 (never errors)
# ---------------------------------------------------------------------------
echo "Case 4: malformed file -> silent + rc 0"
D4="$WORK/malformed"; mkdir -p "$D4"
write_details "$D4" '{ this is not valid json '
out4="$(run_surface "$D4")"; rc4=$?
if printf '%s' "$out4" | grep -qE '^(WARN|INFO):'; then
    bad "case4 malformed produced a verdict line" "out=[$out4]"
else
    ok "case4 malformed -> no verdict line (silent)"
fi
[ "$rc4" -eq 0 ] && ok "case4 rc 0 (never errors on garbage)" || bad "case4 rc!=0" "rc=$rc4"

# ---------------------------------------------------------------------------
echo
echo "evidence-gate-details-consumer: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
