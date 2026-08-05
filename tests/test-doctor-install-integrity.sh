#!/usr/bin/env bash
# `loki doctor` must be able to tell a BROKEN install from a healthy one.
#
# WHY. The quality gates shell out to detector scripts under tests/. When the
# package shipped without them -- package.json's files[] had no tests/ entry
# until v8.38.0, so EVERY npm install had zero detectors -- four gates
# fail-closed on every iteration. That is correct behaviour (a missing detector
# must never read as "nothing found"), but it means the build can never pass and
# first-pass completion is impossible no matter how good the model output is.
#
# `doctor` reported a healthy system the entire time, because it only ever
# checked for external COMMANDS (git, node, bun...) -- never for the files this
# package is supposed to contain. The one command meant to diagnose a broken
# setup could not see the most consequential breakage the package has shipped.
#
# WHAT IS ASSERTED. Both directions, against the real CLI:
#   - a complete install reports 4/4 and does not manufacture a failure
#   - an install with an EMPTY tests/ dir (the exact shape 8.8.0 shipped) FAILS,
#     names every missing file, explains the consequence, and offers the fix
#
# The negative case matters most: a check that cannot fail is decoration.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: doctor detects an incomplete install"

# --- healthy: the repo itself -------------------------------------------------
_healthy="$(LOKI_NO_UPDATE_CHECK=1 timeout 120 bash "$LOKI" doctor 2>&1 || true)"
case "$_healthy" in
    *"Install integrity"*) ok "doctor reports an install-integrity section" ;;
    *) bad "doctor has no install-integrity section" ;;
esac
case "$_healthy" in
    *"detectors present (4/4)"*) ok "a complete install reports 4/4" ;;
    *) bad "a complete install does not report 4/4" ;;
esac
case "$_healthy" in
    *"detectors MISSING"*) bad "a complete install reports a FALSE missing-detector failure" ;;
    *) ok "a complete install does not manufacture a failure" ;;
esac

# --- broken: tests/ present but EMPTY (the shape 8.8.0 actually shipped) ------
D="$(mktemp -d "${TMPDIR:-/tmp}/loki-integrity-XXXXXX")"
cp -R "$REPO_ROOT/autonomy" "$D/autonomy" 2>/dev/null
mkdir -p "$D/tests"
cp "$REPO_ROOT/VERSION" "$D/VERSION" 2>/dev/null || true

_broken="$(LOKI_NO_UPDATE_CHECK=1 timeout 120 bash "$D/autonomy/loki" doctor 2>&1 || true)"

case "$_broken" in
    *"detectors MISSING"*) ok "an empty tests/ dir is reported as MISSING" ;;
    *) bad "a broken install is NOT detected -- doctor cannot see the breakage it exists to find" ;;
esac

# Every missing file must be NAMED. "something is wrong" is not a diagnosis.
_unnamed=""
for _d in detect-test-mutations detect-mock-problems \
          detect-semantic-test-problems detect-invariant-violations; do
    case "$_broken" in *"$_d"*) ;; *) _unnamed="$_unnamed $_d" ;; esac
done
if [ -z "$_unnamed" ]; then
    ok "every missing detector is named"
else
    bad "missing detectors not named:$_unnamed"
fi

# The CONSEQUENCE must be stated: without it a user cannot tell whether this
# matters more than the 15 optional warnings above it.
case "$_broken" in
    *"every iteration will be blocked"*) ok "the consequence is explained" ;;
    *) bad "the failure does not say what it costs the user" ;;
esac

# And the FIX, in the blocker list -- the funnel-fix contract doctor already
# follows for every other hard failure.
case "$_broken" in
    *"Incomplete install"*"bun install -g loki-mode"*)
        ok "the blocker list names the fix" ;;
    *) bad "no actionable fix offered for an incomplete install" ;;
esac

rm -rf "$D"

# --- WIRING -------------------------------------------------------------------
# The behaviour above is driven through the real CLI, so these guard the pieces
# that a refactor could quietly drop.
if grep -q 'Quality-gate detectors present' "$LOKI"; then
    ok "WIRING: the integrity check is present in the CLI"
else
    bad "WIRING: the integrity check was removed"
fi

if grep -q '_doctor_block "Incomplete install' "$LOKI"; then
    ok "WIRING: an incomplete install registers as a hard blocker"
else
    bad "WIRING: an incomplete install no longer blocks -- doctor would report healthy"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
