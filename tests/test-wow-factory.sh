#!/usr/bin/env bash
# loki wow and loki factory help and the offline fallback. No model call.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$ROOT/autonomy/loki"
fail=0
check() {
  local name="$1" ok="$2"
  if [ "$ok" = "1" ]; then echo "PASS $name"; else echo "FAIL $name"; fail=1; fi
}

help_out="$("$LOKI" wow --help 2>&1)"
check "wow help names the offline fallback" "$(printf '%s' "$help_out" | grep -q 'offline sample' && echo 1 || echo 0)"
check "wow help names loki start" "$(printf '%s' "$help_out" | grep -q 'loki start' && echo 1 || echo 0)"

off="$("$LOKI" wow --offline 2>&1)"
check "wow offline shows a verdict word" "$(printf '%s' "$off" | grep -Eq 'VERIFIED|TAMPERED|UNCHECKED|No verdict' && echo 1 || echo 0)"
check "wow offline ends with the next step" "$(printf '%s' "$off" | grep -q 'Ready for your repo? loki start' && echo 1 || echo 0)"

dry="$("$LOKI" wow --dry-run 2>&1)"
check "wow dry-run does not claim a spend" "$(printf '%s' "$dry" | grep -Eq 'dry-run|offline sample' && echo 1 || echo 0)"

fac="$("$LOKI" factory --help 2>&1)"
check "factory names propose execute operate" "$(printf '%s' "$fac" | grep -q 'propose' && printf '%s' "$fac" | grep -q 'execute' && printf '%s' "$fac" | grep -q 'operate' && echo 1 || echo 0)"
check "factory says it wraps start" "$(printf '%s' "$fac" | grep -q 'loki start' && echo 1 || echo 0)"

tour="$("$LOKI" tour --help 2>&1)"
check "tour help still documents the sample" "$(printf '%s' "$tour" | grep -q 'offline' && echo 1 || echo 0)"
check "tour help points at live" "$(printf '%s' "$tour" | grep -q 'tour --live' && echo 1 || echo 0)"

exit "$fail"
