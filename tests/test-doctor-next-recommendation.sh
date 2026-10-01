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
SRC="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a green doctor never recommends a command that cannot run"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }

# --- 1. The flag is set by the SAME predicate that gates the note ------------
# autonomy/loki cannot be sourced (it ends in `main "$@"`), so the branch is
# extracted and exercised directly, mirroring tests/test-verify-runner-selection.sh.
_sdk_branch="$(grep -A 20 'detect_bundled_sdk_provider >/dev/null 2>&1 && detect_bundled_sdk_provider; then' "$SRC")"
if printf '%s' "$_sdk_branch" | grep -q '_doctor_sdk_only=1'; then
  ok "the SDK-only state is recorded where its predicate is evaluated"
else
  bad "nothing records the SDK-only state -- the recommendation cannot know about it"
fi

# The flag must be initialized OUTSIDE the branch that sets it, or the "Next:"
# block reads an unset variable under `set -u` on every ordinary host.
if grep -q 'local _doctor_sdk_only=0' "$SRC"; then
  ok "the flag is initialized before the branch that conditionally sets it"
else
  bad "_doctor_sdk_only has no initializer -- unset on every non-SDK-only host"
fi

# --- 2. BEHAVIOUR: the SDK-only recommendation names neither trap command ----
# Extract the recommendation block and run it under both flag values. This is a
# real execution, not a grep over source, so a flag that is set but never read
# is caught.
#
# Anchored on the RECOMMENDATION (the `Next:` line), not on the conditional that
# currently guards it. Anchoring on the `if` would make any edit to that line
# collapse the extraction into the harness guard below, so a genuinely broken
# recommendation would fail for the wrong reason and the behavioural assertions
# would never run.
# Scoped to cmd_doctor and to top-level `if` blocks that CONTAIN a `Next:` echo.
# Comments elsewhere in this file quote the old bad line verbatim, so an
# unscoped /Next:/ match would pull prose into the block and let an assertion
# fail on a comment rather than on behaviour.
_rec_block="$SCRIPT_DIR/.next-rec.$$.sh"
{
  echo 'set -u'
  # Anchored on the RECOMMENDATION LINES, not on the shape of whatever guards
  # them. Everything from the first `Next:` echo back to the nearest preceding
  # `if`/`else`/`fi`/blank boundary through the closing `fi` is taken verbatim,
  # so the block still extracts whether the guard is `if [ ... ]`, `if cmd`, or
  # a case. Anchoring on `if [` made a guard rewritten to any other form vanish
  # into the harness guard below, which reports "inconclusive" for what is
  # actually a broken recommendation.
  awk '/^cmd_doctor\(\) \{$/{ind=1} ind==0{next}
       /^\}$/{ind=0; next}
       { line[NR]=$0 }
       /^ *echo "Next:/{ if (!first) first=NR; last=NR }
       END{
         if (!first) exit
         s=first; while (s>1 && line[s-1] !~ /^    (if |elif )/) s--
         if (s>1) s--                      # include the guard line itself
         e=last; while ((e in line) && line[e] !~ /^    fi$/) e++
         if (!(e in line)) e=last          # unguarded form: just the echoes
         for (i=s;i<=e;i++) if (i in line) print line[i]
       }' "$SRC"
} > "$_rec_block"

if [ "$(wc -l < "$_rec_block" | tr -d '[:space:]')" -lt 4 ]; then
  # A vacuous extraction would make every assertion below pass on an empty file.
  bad "harness: could not extract the recommendation block; assertions inconclusive"
  rm -f "$_rec_block"
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

_sdk_out="$(_doctor_sdk_only=1 bash "$_rec_block" 2>&1)"
_cli_out="$(_doctor_sdk_only=0 bash "$_rec_block" 2>&1)"
rm -f "$_rec_block"

if [ -n "$_sdk_out" ]; then
  ok "the SDK-only path still recommends something (no dead end)"
else
  bad "the SDK-only path recommends nothing at all"
fi

if printf '%s' "$_sdk_out" | grep -Eq 'loki (quickstart|demo)( |$)'; then
  bad "SDK-only doctor still recommends quickstart/demo -- both exit 2 here"
else
  ok "SDK-only doctor names neither quickstart nor demo as the next step"
fi

# It must point at the command that DOES work on the SDK path.
if printf '%s' "$_sdk_out" | grep -q 'loki start'; then
  ok "SDK-only doctor points at 'loki start', which runs on the bundled SDK"
else
  bad "SDK-only doctor omits the one command that actually works here"
fi

# --- 3. POSITIVE CONTROL: a real provider still gets the normal advice -------
if printf '%s' "$_cli_out" | grep -q 'loki quickstart'; then
  ok "with a provider CLI present, the normal quickstart recommendation is printed"
else
  bad "the provider-present path lost its recommendation -- over-broad fix"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
