#!/usr/bin/env bash
# test-build-analytics-optin.sh -- opt-in build-outcome analytics (Build A).
#
# Asserts the STRICT second-layer gate and the FIXED allowlist for the
# build_verified event (autonomy/telemetry.sh loki_emit_build_verified +
# autonomy/lib/proof-analytics-props.py):
#   1. Default OFF even when base telemetry is ON (analytics is a separate,
#      explicit consent -- zero-egress-by-default moat).
#   2. Telemetry-on alone does NOT fire it.
#   3. Fires ONLY when analytics is explicitly opted in (LOKI_ANALYTICS=on)
#      AND telemetry is enabled.
#   4. Every telemetry opt-out (LOKI_TELEMETRY=off, DO_NOT_TRACK=1) also kills
#      analytics (opt-out always wins).
#   5. The emitted payload carries ONLY allowlisted scalars -- never spec/PRD
#      text, file paths, or any free-text field.
# Hermetic: curl is stubbed to capture the payload to a file; nothing egresses.

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$REPO/autonomy"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-analytics-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
# Uppercase PASSED/FAILED tokens so tests/detect-test-mutations.sh recognizes
# this file as tracking assertions (it greps for PASSED|FAILED|log_pass|log_fail).
ok()  { echo "[PASSED] $1"; PASS=$((PASS+1)); }
bad() { echo "[FAILED] $1"; FAIL=$((FAIL+1)); }

# A proof.json with deliberately-sensitive fields (spec text + file paths) the
# allowlist MUST NOT emit.
mkdir -p "$TMP/proofs/run1"
cat > "$TMP/proofs/run1/proof.json" <<'JSON'
{
  "run_id": "run1",
  "wall_clock_sec": 512,
  "iterations": 3,
  "files_changed": {"count": 7, "paths": ["secret/should-not-leak.ts"]},
  "council": {"final_verdict": "APPROVE"},
  "quality_gates": {"passed": 8, "total": 8},
  "honesty": {"headline": "VERIFIED", "evidence_gate_verdict": "PASS"},
  "spec": {"text": "SECRET-USER-PRD-TEXT-MUST-NOT-LEAK"},
  "facts": {"evidence_gate": {"verdict": "PASS"}}
}
JSON
PROOF="$TMP/proofs/run1/proof.json"

# --- reader allowlist (leak defense) ---
OUT="$(python3 "$SCRIPT_DIR/lib/proof-analytics-props.py" "$PROOF")"
if echo "$OUT" | grep -qiE "SECRET|should-not-leak|PRD|spec|paths"; then
  bad "allowlist leaks forbidden content: $OUT"
else
  ok "allowlist emits no spec/path/PRD text"
fi
echo "$OUT" | grep -q "headline=VERIFIED"        && ok "headline enum emitted"      || bad "headline missing"
echo "$OUT" | grep -q "files_changed_count=7"    && ok "files count (not paths)"    || bad "count missing"
echo "$OUT" | grep -q "gate_pass_rate=1.0"       && ok "gate_pass_rate computed"    || bad "rate missing"

# --- gate precedence (hermetic; curl stubbed) ---
GATE="$TMP/gate.sh"
cat > "$GATE" <<GATEEOF
export SCRIPT_DIR="$SCRIPT_DIR"
export HOME="$TMP/home"; mkdir -p "\$HOME/.loki"
export LOKI_TTY_INTERACTIVE=1
curl() { while [ \$# -gt 0 ]; do [ "\$1" = "-d" ] && shift && printf '%s' "\$1" > "$TMP/payload.json"; shift; done; }
export -f curl
source "$SCRIPT_DIR/telemetry.sh"
r() { rm -f "$TMP/payload.json"; loki_emit_build_verified "$PROOF"; sleep 0.4; }

unset LOKI_ANALYTICS LOKI_POSTHOG LOKI_TELEMETRY
r; [ -f "$TMP/payload.json" ] && echo "R1 FAIL" || echo "R1 PASS"

export LOKI_TELEMETRY=on; unset LOKI_ANALYTICS LOKI_POSTHOG
r; [ -f "$TMP/payload.json" ] && echo "R2 FAIL" || echo "R2 PASS"

export LOKI_TELEMETRY=on LOKI_ANALYTICS=on
r; { [ -f "$TMP/payload.json" ] && grep -q 'build_verified' "$TMP/payload.json"; } && echo "R3 PASS" || echo "R3 FAIL"

export LOKI_TELEMETRY=off LOKI_ANALYTICS=on
r; [ -f "$TMP/payload.json" ] && echo "R4 FAIL" || echo "R4 PASS"

export LOKI_TELEMETRY=on LOKI_ANALYTICS=on DO_NOT_TRACK=1
r; [ -f "$TMP/payload.json" ] && echo "R5 FAIL" || echo "R5 PASS"
GATEEOF

RES="$(bash "$GATE")"
grep -q "R1 PASS" <<<"$RES" && ok "default OFF (telemetry unset)"        || bad "R1: fired by default"
grep -q "R2 PASS" <<<"$RES" && ok "telemetry-on alone does not fire"      || bad "R2: fired telemetry-only"
grep -q "R3 PASS" <<<"$RES" && ok "fires on explicit opt-in"              || bad "R3: no fire on opt-in"
grep -q "R4 PASS" <<<"$RES" && ok "telemetry opt-out kills analytics"     || bad "R4: opt-out ignored"
grep -q "R5 PASS" <<<"$RES" && ok "DO_NOT_TRACK kills analytics"          || bad "R5: DO_NOT_TRACK ignored"

# The captured opt-in payload must ALSO be leak-free.
if [ -f "$TMP/payload.json" ]; then
  if grep -qiE "SECRET|should-not-leak" "$TMP/payload.json"; then
    bad "egress payload leaked forbidden content"
  else
    ok "egress payload is allowlist-only"
  fi
fi

echo ""
echo "=== build-analytics opt-in: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
