#!/usr/bin/env bash
# The longest silence is the metric that matches how a build FEELS.
#
# WHY. The loudest complaints about agents in this category are not "it was
# wrong", they are "it went quiet and I could not tell if it was working":
# opencode#11112 "always stuck at Preparing write" (76 comments), continue#7143,
# continue#5696. The agent may be working fine; the user cannot tell, so they
# kill it or leave.
#
# Wall-clock total is the wrong metric for that. A ten-minute build reporting
# something every twenty seconds feels fast; a four-minute build silent for
# three of them feels broken. What matters is the LONGEST GAP.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REP="$REPO_ROOT/autonomy/lib/silence_report.py"
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
W="$(mktemp -d "${TMPDIR:-/tmp}/loki-silence.XXXXXX")"; trap 'rm -rf "$W"' EXIT

_mk() {  # $1=file, then "type:offset" pairs
  local f="$1"; shift
  python3 - "$f" "$@" <<'PY'
import json,sys
from datetime import datetime,timedelta,timezone
f=sys.argv[1]; t=datetime(2026,7,30,12,0,0,tzinfo=timezone.utc)
with open(f,'w') as fh:
    for spec in sys.argv[2:]:
        k,off=spec.rsplit(':',1)
        fh.write(json.dumps({"type":k,"timestamp":(t+timedelta(seconds=int(off))).isoformat()})+"\n")
PY
}

echo "T1 -- a real in-build silence is found and NAMED"
F="$W/build.jsonl"
_mk "$F" "iteration_start:0" "code_review_start:5" "code_review_complete:219" "iteration_complete:224"
out=$(python3 "$REP" --events "$F" 2>&1)
printf '%s' "$out" | grep -q "214" && ok "detects the 214s silence" || bad "missed the 214s gap"
# A duration alone is not actionable. Naming the surrounding steps is what makes
# it fixable.
printf '%s' "$out" | grep -q "code_review_start" \
  && ok "names the step the silence followed" \
  || bad "reports a duration without naming the step"
n=$(python3 "$REP" --events "$F" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['gaps_over_threshold'])" 2>/dev/null)
[ "$n" = "1" ] && ok "exactly 1 gap over the 30s threshold" || bad "gaps_over_threshold=$n, expected 1"

echo
echo "T2 -- idle time between sessions is NOT counted as silence"
# A gap between session_resume events is a human away from the keyboard. Counting
# it would swamp the report with non-defects and make the real signal unusable --
# measured on this repo: 4234 such gaps versus 3 genuine in-build ones.
I="$W/idle.jsonl"
_mk "$I" "session_resume:0" "session_resume:3300" "cli_command_deprecated:3400"
z=$(python3 "$REP" --events "$I" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['gaps_over_threshold'])" 2>/dev/null)
[ "$z" = "0" ] && ok "3300s idle gap correctly ignored" || bad "counted idle time as silence (over=$z)"
python3 "$REP" --events "$I" 2>/dev/null | grep -qi "idle time" \
  && ok "says plainly that gaps were ignored as idle" \
  || bad "silently dropped gaps without saying so"

echo
echo "T3 -- refuses to invent data"
# A malformed line must be skipped, never turned into a synthetic timestamp: that
# would invent a gap or hide one, and either way the report stops being evidence.
B="$W/bad.jsonl"
_mk "$B" "iteration_start:0" "iteration_complete:100"
printf 'not json at all\n' >> "$B"
printf '{"type":"no_timestamp"}\n' >> "$B"
e=$(python3 "$REP" --events "$B" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['events'])" 2>/dev/null)
[ "$e" = "2" ] && ok "malformed and timestamp-less lines skipped (2 usable events)" \
  || bad "events=$e, expected 2"

M="$W/missing.jsonl"
python3 "$REP" --events "$M" 2>/dev/null | grep -qi "nothing to measure" \
  && ok "absent file reports 'nothing to measure', not a zero-silence claim" \
  || bad "absent file did not report honestly"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
