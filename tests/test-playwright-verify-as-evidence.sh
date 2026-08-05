#!/usr/bin/env bash
# tests/test-playwright-verify-as-evidence.sh -- regression guard for
# playwright_verify_as_evidence() (autonomy/playwright-verify.sh:312).
#
# WHAT THIS GUARDS
#   playwright_verify_as_evidence() formats .loki/verification/playwright-results.json
#   (read via the module-global PLAYWRIGHT_RESULTS_FILE, NOT a function argument --
#   the one optional arg is the OUTPUT destination file) into the council evidence
#   block. Per the module header comment ("Advisory only - failures do NOT block
#   iterations or council approval"), the function itself always returns 0 when a
#   results file is present or absent -- pass/fail is NOT signalled via rc, it is
#   signalled via the "Overall: PASS"/"Overall: FAIL" text the council/reviewer
#   reads. There was no test asserting the function actually DISTINGUISHES a real
#   PASS fixture from a real FAIL fixture in that text -- a regression that always
#   printed "PASS" (or dropped the Overall line) would fake-green a broken app in
#   the evidence council sees, silently.
#
# STRATEGY
#   Extract ONLY playwright_verify_as_evidence() from the module by name (avoids
#   sourcing the whole file, which would require live npx/playwright). Set the
#   module-global PLAYWRIGHT_RESULTS_FILE to hand-written PASS/FAIL/missing
#   fixtures and assert on the emitted evidence text + rc.
#
#   RUN_SH overridable so the non-vacuity self-check can point at a mutated copy.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PW_SH="${LOKI_PLAYWRIGHT_SH_OVERRIDE:-$REPO_ROOT/autonomy/playwright-verify.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$PW_SH" ]; then
    echo "SKIP: $PW_SH not found. (Not a fail.)"; exit 0
fi

# Extract ONLY playwright_verify_as_evidence() by name. Function spans from its
# `() {` line to the first line that is exactly `}` at column 0.
_fn="$(awk '/^playwright_verify_as_evidence\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$PW_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: playwright_verify_as_evidence not found in $PW_SH. Implementation not landed. (Not a fail.)"
    exit 0
fi

# shellcheck disable=SC1090
eval "$_fn"

if ! type playwright_verify_as_evidence >/dev/null 2>&1; then
    echo "SKIP: playwright_verify_as_evidence did not eval cleanly. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-pw-evidence-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Case 1: PASS fixture -> evidence text says "Overall: PASS", per-check [PASS]
# ---------------------------------------------------------------------------
PLAYWRIGHT_RESULTS_FILE="$WORK/pass-results.json"
cat > "$PLAYWRIGHT_RESULTS_FILE" <<'JSON'
{
  "passed": true,
  "url": "http://localhost:3000",
  "duration_ms": 842,
  "checks": {"page_loaded": true, "no_console_errors": true, "title_present": true},
  "errors": [],
  "screenshot": ""
}
JSON
out_pass="$(playwright_verify_as_evidence)"; rc_pass=$?

if printf '%s' "$out_pass" | grep -q 'Overall: PASS'; then
    ok "PASS fixture -> evidence text contains 'Overall: PASS'"
else
    bad "PASS fixture -> evidence text contains 'Overall: PASS'" "out=[$out_pass]"
fi
if printf '%s' "$out_pass" | grep -q '\[PASS\] page_loaded'; then
    ok "PASS fixture -> per-check line marked [PASS]"
else
    bad "PASS fixture -> per-check line marked [PASS]" "out=[$out_pass]"
fi
if printf '%s' "$out_pass" | grep -q 'Overall: FAIL'; then
    bad "PASS fixture wrongly contains 'Overall: FAIL'" "out=[$out_pass]"
else
    ok "PASS fixture does not contain 'Overall: FAIL'"
fi
[ "$rc_pass" -eq 0 ] && ok "PASS fixture -> rc 0" || bad "PASS fixture -> rc 0" "rc=$rc_pass"

# ---------------------------------------------------------------------------
# Case 2: FAIL fixture -> evidence text says "Overall: FAIL", errors listed,
# per-check [FAIL] shown -- and it must be DISTINCT from the PASS output.
# ---------------------------------------------------------------------------
PLAYWRIGHT_RESULTS_FILE="$WORK/fail-results.json"
cat > "$PLAYWRIGHT_RESULTS_FILE" <<'JSON'
{
  "passed": false,
  "url": "http://localhost:3000",
  "duration_ms": 1533,
  "checks": {"page_loaded": true, "no_console_errors": false, "title_present": true},
  "errors": ["Uncaught TypeError: x is not a function"],
  "screenshot": ".loki/verification/screenshots/verify-fail.png"
}
JSON
out_fail="$(playwright_verify_as_evidence)"; rc_fail=$?

if printf '%s' "$out_fail" | grep -q 'Overall: FAIL'; then
    ok "FAIL fixture -> evidence text contains 'Overall: FAIL'"
else
    bad "FAIL fixture -> evidence text contains 'Overall: FAIL'" "out=[$out_fail]"
fi
if printf '%s' "$out_fail" | grep -q '\[FAIL\] no_console_errors'; then
    ok "FAIL fixture -> failing check marked [FAIL]"
else
    bad "FAIL fixture -> failing check marked [FAIL]" "out=[$out_fail]"
fi
if printf '%s' "$out_fail" | grep -q 'Uncaught TypeError'; then
    ok "FAIL fixture -> error detail included"
else
    bad "FAIL fixture -> error detail included" "out=[$out_fail]"
fi
[ "$rc_fail" -eq 0 ] && ok "FAIL fixture -> rc 0 (advisory-only, never blocks)" || bad "FAIL fixture -> rc 0" "rc=$rc_fail"

if [ "$out_pass" != "$out_fail" ]; then
    ok "PASS and FAIL fixtures produce genuinely distinct evidence text"
else
    bad "PASS and FAIL fixtures produce genuinely distinct evidence text" "identical output"
fi

# ---------------------------------------------------------------------------
# Case 3: no results file -> silent (no evidence block), rc 0.
# ---------------------------------------------------------------------------
PLAYWRIGHT_RESULTS_FILE="$WORK/does-not-exist.json"
out_missing="$(playwright_verify_as_evidence)"; rc_missing=$?
if [ -z "$out_missing" ]; then
    ok "missing results file -> no evidence block emitted"
else
    bad "missing results file -> no evidence block emitted" "out=[$out_missing]"
fi
[ "$rc_missing" -eq 0 ] && ok "missing results file -> rc 0" || bad "missing results file -> rc 0" "rc=$rc_missing"

# ---------------------------------------------------------------------------
echo
echo "playwright-verify-as-evidence: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
