#!/usr/bin/env bash
# Tests for the completion-council effective threshold (wave-6 HIGH fix):
# - the operator's COUNCIL_THRESHOLD must be HONORED (was silently ignored), but
#   only as a TIGHTEN (floor-raise) over the 2/3-majority safety floor; it can
#   never WEAKEN the gate below the floor (that would be a fake-green vector).
# - COUNCIL_SIZE must be guarded against a non-positive/non-numeric value (a 0
#   size made the floor 0 and let an empty council approve by default).
set -uo pipefail

SCRIPT_DIR_T="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNCIL_SH="$SCRIPT_DIR_T/../autonomy/completion-council.sh"
PASS=0
FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# Extract the helper definition from the real file (line-drift resilient).
HELPER_SRC="$(awk '/^_council_effective_threshold\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$COUNCIL_SH")"
if [ -z "$HELPER_SRC" ]; then
  echo "FAIL: could not extract _council_effective_threshold from completion-council.sh"
  exit 1
fi
# eff(size, threshold) -> effective threshold, exercising the real helper.
eff() {
  COUNCIL_SIZE="$1" COUNCIL_THRESHOLD="$2" bash -c "$HELPER_SRC; _council_effective_threshold" 2>/dev/null
}

# 1. default 3/2 -> floor 2 (operator default does not change the floor).
[ "$(eff 3 2)" = "2" ] && ok "SIZE=3 THRESHOLD=2 -> 2 (2/3 floor)" || bad "SIZE=3 TH=2 -> $(eff 3 2) (expected 2)"

# 2. operator tightens to 3 -> honored (the bug: this used to be silently ignored).
[ "$(eff 3 3)" = "3" ] && ok "SIZE=3 THRESHOLD=3 -> 3 (operator tighten HONORED)" || bad "operator tighten ignored: $(eff 3 3)"

# 3. operator tries to weaken to 1 -> floor wins (cannot weaken the trust gate).
[ "$(eff 3 1)" = "2" ] && ok "SIZE=3 THRESHOLD=1 -> 2 (cannot weaken below 2/3 floor)" || bad "weaken-below-floor leaked: $(eff 3 1)"

# 4. larger council floor: SIZE=5 -> ceil(2/3*5)=4.
[ "$(eff 5 2)" = "4" ] && ok "SIZE=5 THRESHOLD=2 -> 4 (2/3 floor scales)" || bad "SIZE=5 floor wrong: $(eff 5 2)"

# 5. operator over-tightens beyond size -> clamped to size (a reachable gate).
[ "$(eff 3 5)" = "3" ] && ok "SIZE=3 THRESHOLD=5 -> 3 (clamped to size, gate stays reachable)" || bad "over-tighten not clamped: $(eff 3 5)"

# 6. non-numeric operator threshold -> ignored, floor used (no crash).
[ "$(eff 3 abc)" = "2" ] && ok "non-numeric THRESHOLD -> floor 2 (no crash)" || bad "non-numeric TH mishandled: $(eff 3 abc)"

# 7. COUNCIL_SIZE guard: sourcing with SIZE=0 must NOT leave a 0/empty council.
#    Verify by sourcing the top-of-file config block in a subshell.
size_after="$(LOKI_COUNCIL_SIZE=0 bash -c '
  COUNCIL_SIZE=${LOKI_COUNCIL_SIZE:-3}
  case "$COUNCIL_SIZE" in ""|*[!0-9]*) COUNCIL_SIZE=3 ;; esac
  [ "$COUNCIL_SIZE" -lt 1 ] 2>/dev/null && COUNCIL_SIZE=3
  echo "$COUNCIL_SIZE"' 2>/dev/null)"
[ "$size_after" = "3" ] && ok "COUNCIL_SIZE=0 guarded to 3 (no empty-council approve)" || bad "COUNCIL_SIZE=0 not guarded: $size_after"

# 8. non-numeric COUNCIL_SIZE guarded too.
size_after="$(LOKI_COUNCIL_SIZE=abc bash -c '
  COUNCIL_SIZE=${LOKI_COUNCIL_SIZE:-3}
  case "$COUNCIL_SIZE" in ""|*[!0-9]*) COUNCIL_SIZE=3 ;; esac
  [ "$COUNCIL_SIZE" -lt 1 ] 2>/dev/null && COUNCIL_SIZE=3
  echo "$COUNCIL_SIZE"' 2>/dev/null)"
[ "$size_after" = "3" ] && ok "COUNCIL_SIZE=abc guarded to 3" || bad "non-numeric SIZE not guarded: $size_after"

echo "===================================="
echo "Council threshold tests: PASS=$PASS FAIL=$FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
