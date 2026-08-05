#!/usr/bin/env bash
# The check that guards the SHIPPED PACKAGE was missing from the DEFAULT route.
#
# `doctor` verifies that four quality-gate detectors are present. They ship via
# package.json `files[]`, and when they were absent from the tarball,
# mutation-integrity failed closed on EVERY iteration for EVERY npm user --
# first-pass completion was impossible regardless of model output (v8.38.0).
#
# The bash route has checked this since then. The Bun route -- which is the
# DEFAULT runtime -- did not. The users most likely to hit the failure were
# precisely the ones whose doctor could not see it.
#
# Bun Parity caught it as a tally mismatch (bash "14 passed" vs bun "10 passed",
# a difference of exactly these four checks) and had been RED since v8.59.0.
#
# Nothing in a git checkout reproduces the original packaging failure, which is
# why doctor must assert it against the installed layout on both routes.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: install-integrity check exists on BOTH doctor routes"

# --- both routes must implement it -------------------------------------------
if grep -q 'Install integrity' "$REPO_ROOT/autonomy/loki"; then
    ok "bash route checks install integrity"
else
    bad "bash route lost the install-integrity check"
fi

if grep -q 'Install integrity' "$REPO_ROOT/loki-ts/src/commands/doctor.ts"; then
    ok "bun route checks install integrity"
else
    bad "bun route (the DEFAULT runtime) does not check install integrity"
fi

# The detector list must match between routes, or the tallies diverge again.
for det in detect-test-mutations detect-mock-problems \
           detect-semantic-test-problems detect-invariant-violations; do
    if grep -q "$det" "$REPO_ROOT/loki-ts/src/commands/doctor.ts"; then
        ok "bun route checks $det"
    else
        bad "bun route omits $det, so its tally will not match bash"
    fi
done

# --- BEHAVIOUR: the routes must agree on the tally ---------------------------
# The parity job compares normalized text; a count mismatch is what failed.
LOKI="$REPO_ROOT/bin/loki"
if [ ! -x "$LOKI" ]; then
    bad "bin/loki not executable; behaviour checks are inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-doctorparity-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

"$LOKI" doctor > "$SCRATCH/bun.txt" 2>/dev/null
LOKI_LEGACY_BASH=1 "$LOKI" doctor > "$SCRATCH/bash.txt" 2>/dev/null

_summary() {  # strip ANSI, pull the pass count out of the Summary line
    sed -e 's/\x1b\[[0-9;]*m//g' "$1" \
        | grep '^Summary:' | sed -E 's/.*Summary: ([0-9]+) passed.*/\1/' | head -1
}

_bun="$(_summary "$SCRATCH/bun.txt")"
_bash="$(_summary "$SCRATCH/bash.txt")"

if [ -z "$_bun" ] || [ -z "$_bash" ]; then
    bad "could not read a Summary count (bun='$_bun' bash='$_bash')"
elif [ "$_bun" = "$_bash" ]; then
    ok "both routes report the same pass count ($_bun)"
else
    bad "tally mismatch: bash=$_bash bun=$_bun -- this is the Bun Parity failure"
fi

# Both routes must actually PRINT the section, not merely contain the string.
for route in bun bash; do
    if grep -q 'Install integrity' "$SCRATCH/$route.txt"; then
        ok "$route route prints the Install integrity section"
    else
        bad "$route route never printed Install integrity at runtime"
    fi
done

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
