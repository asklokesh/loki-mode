#!/usr/bin/env bash
# A GREEN `loki doctor` must not recommend a command that exits 2.
#
# THE BUG. On a host with the bundled Claude Agent SDK usable and NO provider CLI
# on PATH, doctor printed PASS ("'loki start' needs no separate CLI"), a yellow
# note that demo/quick/quickstart still need a CLI, and then ended with the
# unconditional line:
#
#   Next: loki quickstart (guided first build from your idea, no PRD needed)
#
# quickstart.sh:476 exits 2 when no provider is found. So the user read a green
# doctor, followed its LAST line, and hit a hard failure. The note was an earlier
# partial fix; it never reached the recommendation, which is the line people act
# on. The source comment at the PASS site already calls this "the worst first-run
# outcome we have" -- a correct diagnosis in a comment is not a fix.
#
# ASSERTED AS A PROPERTY, not as prose: when the SDK-only predicate holds, the
# recommendation must not NAME quickstart or demo. Matching exact wording would
# turn a copy edit into a false failure while a re-broken gate stayed green.
#
# TEST 3 IS THE POSITIVE CONTROL. Without it, deleting the whole "Next:" block
# would pass tests 1-2 -- a doctor that recommends nothing is not the fix.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/loki-ts/src/commands/doctor.ts"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a green doctor never recommends a command that cannot run"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }

# --- 1. The flag is recorded where its predicate is evaluated ----------------
# doctor.ts is the single doctor implementation (FC-DUP); the recommendation is
# asserted on its source: the flag is initialized, set when the bundled SDK is
# usable, and read by the Next block.
if grep -q 'let sdkOnly = false;' "$SRC"; then
  ok "the flag is initialized before the branch that conditionally sets it"
else
  bad "sdkOnly has no initializer"
fi
if grep -B2 -A2 'sdkOnly = true;' "$SRC" | grep -q 'sdkUsable\|if ('; then
  ok "the SDK-only state is recorded where its predicate is evaluated"
else
  bad "nothing records the SDK-only state -- the recommendation cannot know about it"
fi

# --- 2. The two branches of the recommendation --------------------------------
# Anchored on the `if (sdkOnly) {` guard that wraps the `Next:` lines.
_sdk_out="$(awk '/if \(sdkOnly\) \{/ && !d {f=1; next} f && /\} else \{/ {f=0; d=1} f {print}' "$SRC" | grep 'Next:\|loki ' || true)"
_cli_out="$(awk '/if \(sdkOnly\) \{/ {s=1} s && /\} else \{/ {e=1; next} e && /^  \}$/ {exit} e {print}' "$SRC")"

if [ -n "$_sdk_out" ]; then
  ok "the SDK-only path still recommends something (no dead end)"
else
  bad "the SDK-only path recommends nothing at all (or the block could not be extracted)"
fi

if printf '%s' "$_sdk_out" | grep -q 'Next: loki start'; then
  ok "SDK-only doctor points at 'loki start', which runs on the bundled SDK"
else
  bad "SDK-only doctor omits the one command that actually works here"
fi

if printf '%s' "$_sdk_out" | grep 'Next:' | grep -Eq 'loki (quickstart|demo)( |$)'; then
  bad "SDK-only doctor still recommends quickstart/demo as the next step -- both exit 2 here"
else
  ok "SDK-only doctor names neither quickstart nor demo as the next step"
fi

# --- 3. POSITIVE CONTROL: a real provider still gets the normal advice -------
if printf '%s' "$_cli_out" | grep -q 'loki quickstart'; then
  ok "with a provider CLI present, the normal quickstart recommendation is printed"
else
  bad "the provider-present path lost its recommendation -- over-broad fix"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
