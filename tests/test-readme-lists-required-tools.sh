#!/usr/bin/env bash
# Every tool `loki doctor` marks REQUIRED must appear in the README's install
# prerequisites, under "Required:" and not under "Recommended:".
#
# WHY THIS EXISTS. README.md listed `jq` under "Recommended:" ("for nicer JSON
# handling in shell flows") while doctor marked it required, turned it into a
# `fail`, and pushed "jq is not installed" into the blockers list. A reader who
# installed exactly what the README called Required got a doctor that refused to
# pass, naming a tool the README had told them was optional. Node.js had the
# same split, and the README demanded Python 3.10+ where doctor enforces 3.8.
#
# The direction is deliberate: doctor is the authority. It is the thing that
# actually blocks, so prose that disagrees with it is the side that is wrong.
# This guard therefore reads the required set OUT of doctor and asserts the
# README covers it -- adding a required tool to doctor without a README entry
# fails here.
#
# doctor.ts TOOL_SPECS is the single doctor and carries the list, so a gap the
# README could not reveal. The two lists are asserted equal as well.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
README="$REPO_ROOT/README.md"
DOCTOR_TS="$REPO_ROOT/loki-ts/src/commands/doctor.ts"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# The Bun route's required set. Anchored on the object-literal shape: a bare
# `required` also matches the `required: Severity;` type field, which would pull
# in a phantom entry and make the count assertion meaningless.
bun_required=$(
    grep -oE '\{ displayName: "[^"]+", jsonName: "[^"]+", cmd: "[^"]+", required: "required"' \
        "$DOCTOR_TS" 2>/dev/null |
        sed -E 's/.*cmd: "([^"]+)".*/\1/' | sort -u
)

echo "T1 -- the required set was actually extracted"

# VACUITY GUARD. A zero-entry extraction makes every later loop pass over
# nothing. Assert the exact expected set, not merely that it is non-empty: a
# regex that silently drifts to 1 of 5 entries would still be "non-empty".
expected="curl git jq node python3"
got=$(echo "$bun_required" | tr '\n' ' ' | sed 's/ *$//')
if [ "$got" = "$expected" ]; then
    ok "doctor.ts required set is exactly: $expected"
else
    bad "extraction drifted -- want '$expected', got '$got'"
fi

echo
echo
echo "T3 -- every required tool is in the README's Required block"

# Scope the search to the block between the two headings. A whole-file grep
# passes even with a tool sitting under "Recommended:", because these names also
# appear in code examples elsewhere in the README -- which is exactly how the jq
# contradiction survived.
required_block=$(
    awk '/^Required:$/{flag=1; next} /^Recommended:$/{flag=0} flag' "$README"
)
recommended_block=$(
    awk '/^Recommended:$/{flag=1; next} /^$/{if(flag && ++blanks>=3) flag=0} flag' "$README"
)

if [ -z "$required_block" ]; then
    bad "README has no 'Required:' block to check (heading renamed or removed)"
else
    while IFS= read -r tool; do
        [ -n "$tool" ] || continue
        if printf '%s' "$required_block" | grep -qF "\`$tool\`"; then
            ok "$tool is listed under Required"
        elif printf '%s' "$recommended_block" | grep -qF "\`$tool\`"; then
            bad "$tool is REQUIRED by doctor but the README lists it under Recommended"
        else
            bad "$tool is REQUIRED by doctor but absent from the README Required block"
        fi
    done <<EOF
$bun_required
EOF
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
