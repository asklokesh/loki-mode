#!/usr/bin/env bash
# Regression: is_rate_limited must detect REAL provider rate-limits but NOT
# false-positive on the agent's own output (a build that printed/generated
# rate-limit code or prose). Wave-1 bug: bare-keyword whole-file grep wrongly
# triggered a multi-minute wait on an iteration that merely built a 429 handler.
set -uo pipefail
RUN_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/run.sh"
H=$(mktemp); trap 'rm -f "$H"' EXIT
sed -n '/^is_rate_limited() {/,/^}/p' "$RUN_SH" > "$H"
grep -q 'is_rate_limited' "$H" || { echo "FATAL: could not extract is_rate_limited"; exit 2; }
source "$H"
pass=0; fail=0
ok(){ echo "  [PASS] $1"; pass=$((pass+1)); }
bad(){ echo "  [FAIL] $1"; fail=$((fail+1)); }
t(){ # t <desc> <expect:0|1> <content>
  local d="$1" exp="$2" f; f=$(mktemp); printf '%b' "$3" > "$f"
  if is_rate_limited "$f"; then r=0; else r=1; fi; rm -f "$f"
  [ "$r" = "$exp" ] && ok "$d" || bad "$d (expected rc=$exp got $r)"
}
# REAL rate-limits -> detected (rc 0)
t "API Error 429 Too Many Requests" 0 'building...\nAPI Error: 429 Too Many Requests\nretry-after: 60\n'
t "Error: rate limit exceeded" 0 'Error: rate limit exceeded\n'
t "Claude resets 3pm" 0 'Claude usage limit reached, resets 3pm\n'
# Agent's OWN output -> NOT flagged (rc 1)
t "agent built a 429/retry-after handler (code)" 1 'def handle_rate_limit():\n    # retry-after backoff for 429\n    return "built"\nDone.\n'
t "agent prose mentioning 429 + retry-after" 1 'Added a 429 handler and retry-after parsing.\nTests pass.\n'
t "clean iteration, no signal" 1 'Iteration complete. All checks passed.\n'
echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
