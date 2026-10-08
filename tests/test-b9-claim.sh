#!/usr/bin/env bash
# shellcheck disable=SC2319
# tests/test-b9-claim.sh -- FCR-1: scripts/b9-claim.py classifies each arm's final output as claimed_done
# true/false/unclear with no model call. Fixtures under tests/fixtures/b9-claim/.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CL="$SCRIPT_DIR/../scripts/b9-claim.py"
FX="$SCRIPT_DIR/fixtures/b9-claim"
FAILS=0
check() { if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi; }
raw() { python3 -I "$CL" raw "$FX/$1" 2>&1; }
loki() { python3 -I "$CL" loki "$FX/$1" 2>&1; }

[ "$(raw raw-done.json)" = "true" ]; check raw-done-true $? "$(raw raw-done.json)"
[ "$(raw raw-blocked.json)" = "false" ]; check raw-blocked-false $? "$(raw raw-blocked.json)"
[ "$(raw raw-missing.json)" = "unclear" ]; check raw-missing-marker-unclear $? "$(raw raw-missing.json)"
[ "$(raw raw-done-midline.json)" = "unclear" ]; check raw-done-must-be-the-last-line $? "$(raw raw-done-midline.json)"
[ "$(raw raw-plain-done.txt)" = "true" ]; check raw-plain-text-done $? "$(raw raw-plain-done.txt)"
[ "$(python3 -I "$CL" raw "$FX/no-such-file" 2>&1)" = "unclear" ]; check raw-missing-file-unclear $? ""

[ "$(loki loki-verified.json)" = "true" ]; check loki-verified-claims-done $? "$(loki loki-verified.json)"
[ "$(loki loki-notproven.json)" = "false" ]; check loki-not-proven-is-not-a-claim $? "$(loki loki-notproven.json)"
[ "$(loki loki-noverdict.json)" = "unclear" ]; check loki-no-verdict-unclear $? "$(loki loki-noverdict.json)"
[ "$(loki loki-garbage.json)" = "unclear" ]; check loki-garbage-unclear $? "$(loki loki-garbage.json)"

# the claim never looks at the hidden tests: a lying DONE is still claimed_done = true; the tally pairs it with solved
[ "$(raw raw-lying-done.json)" = "true" ]; check lying-done-still-a-claim $? "$(raw raw-lying-done.json)"
T="$(printf 'true\t1\ntrue\t0\nfalse\t0\nunclear\t0\nunclear\t1\n' | python3 -I "$CL" tally 2>&1)"
[ "$T" = "claimed_done=2 claimed_not_done=1 unclear_excluded=2 claimed_done_and_failing=1 n=5" ]; check tally-counts-unclear-and-lying-done $? "$T"

# the raw prompt suffix is the explicit last-line contract
python3 -I "$CL" suffix | grep -q 'DONE' && python3 -I "$CL" suffix | grep -q 'BLOCKED'; check suffix-contract $? ""
python3 -I "$CL" bogus >/dev/null 2>&1; [ $? -eq 2 ]; check usage-rc2 $? ""
! grep -Eq 'anthropic|claude -p|urllib|requests|subprocess' "$CL"; check pure-no-model-call $? "script references a model or network"

[ "$FAILS" -eq 0 ]
