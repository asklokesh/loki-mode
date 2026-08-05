#!/usr/bin/env bash
# `loki doctor` reports the age of providers/model_catalog.json and warns when
# it goes stale -- WITHOUT ever changing an exit code.
#
# WHY THIS EXISTS: the catalog is hand-maintained and providers ship models
# constantly, so it rots silently. Nothing else in the system reports its age.
#
# The invariant this test defends is the ADVISORY one. A stale catalog is a
# hint, not a failure: it must never fail a build, and it must never flip
# doctor's exit code. That is asserted by capturing the exit code with a FRESH
# catalog and requiring the STALE run to produce the identical code -- not by
# hardcoding 0. On a bare CI runner with no provider CLI, doctor legitimately
# exits 1; a test that asserted 0 would be flaky by host, which is exactly the
# failure shape tests/test-doctor-blocker-parity.sh was written to catch.
#
# Uses the existing LOKI_MODEL_CATALOG override (providers/models.sh) so the
# real catalog is never mutated.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fixtures derived from the real catalog so schema drift is caught, not mocked.
make_catalog() {
    LOKI_FIXTURE_DATE="$1" LOKI_FIXTURE_OUT="$2" python3 -c "
import json, os, datetime
src = os.path.join(os.environ['REPO_ROOT'], 'providers', 'model_catalog.json')
d = json.load(open(src))
days = int(os.environ['LOKI_FIXTURE_DATE'])
d['updated'] = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
json.dump(d, open(os.environ['LOKI_FIXTURE_OUT'], 'w'))
"
}
export REPO_ROOT

make_catalog 400 "$TMP/stale.json"   # well past the 90-day threshold
make_catalog 3   "$TMP/fresh.json"   # comfortably inside it

# ---------------------------------------------------------------------------
# 1. Fresh catalog: no warning, and this run defines the baseline exit code.
# ---------------------------------------------------------------------------
fresh_out="$TMP/fresh.out"
LOKI_MODEL_CATALOG="$TMP/fresh.json" "$LOKI" doctor >"$fresh_out" 2>&1
fresh_rc=$?

if grep -q "may be missing newer models" "$fresh_out"; then
    bad "fresh catalog must NOT produce the stale warning"
else
    ok "fresh catalog produces no stale warning"
fi

if grep -q "Model catalog:" "$fresh_out"; then
    ok "doctor reports a Model catalog section"
else
    bad "doctor is missing the Model catalog section"
fi

# ---------------------------------------------------------------------------
# 2. Stale catalog: warning present, refresh command named.
# ---------------------------------------------------------------------------
stale_out="$TMP/stale.out"
LOKI_MODEL_CATALOG="$TMP/stale.json" "$LOKI" doctor >"$stale_out" 2>&1
stale_rc=$?

if grep -q "may be missing newer models" "$stale_out"; then
    ok "stale catalog produces the staleness warning"
else
    bad "stale catalog did NOT produce the staleness warning"
fi

# The warning is useless if it does not tell the operator what to run.
if grep -q "probe-model-catalog.py" "$stale_out"; then
    ok "stale warning names the single-command refresh"
else
    bad "stale warning does not name the refresh command"
fi

# The refresh must be advertised as human-verified, never auto-applied. This
# repo has been burned by a fabricated fact; a model ID that does not exist is
# worse than a stale catalog, so the wording is load-bearing.
if grep -q "never auto-applied" "$stale_out"; then
    ok "refresh is documented as human-verified, not auto-fetched"
else
    bad "refresh wording does not state it is human-verified"
fi

# ---------------------------------------------------------------------------
# 3. THE INVARIANT: advisory only. Stale must not change the exit code.
# ---------------------------------------------------------------------------
if [ "$stale_rc" -eq "$fresh_rc" ]; then
    ok "exit code unchanged by staleness (both routes returned $fresh_rc)"
else
    bad "stale catalog CHANGED the exit code ($fresh_rc -> $stale_rc) -- must be advisory"
fi

# A stale catalog must not be counted as a warning either: the Summary counts
# feed the bun-parity matrix and the "All required checks passed" branch.
# The Summary line is ANSI-colored BETWEEN the numbers, so strip escapes first.
summary_of() {
    sed -E 's/\x1b\[[0-9;]*m//g' "$1" \
        | grep -oE '[0-9]+ passed, [0-9]+ failed, [0-9]+ warnings' | head -1
}
fresh_summary="$(summary_of "$fresh_out")"
stale_summary="$(summary_of "$stale_out")"
if [ -n "$fresh_summary" ] && [ "$fresh_summary" = "$stale_summary" ]; then
    ok "summary tally identical fresh vs stale ($fresh_summary)"
else
    bad "summary tally shifted: fresh='$fresh_summary' stale='$stale_summary'"
fi

# ---------------------------------------------------------------------------
# 4. --json carries the same signal without affecting ok/summary.
# ---------------------------------------------------------------------------
LOKI_MODEL_CATALOG="$TMP/stale.json" "$LOKI" doctor --json >"$TMP/stale.json.out" 2>/dev/null
json_rc=$?
LOKI_MODEL_CATALOG="$TMP/fresh.json" "$LOKI" doctor --json >"$TMP/fresh.json.out" 2>/dev/null
json_fresh_rc=$?

if REPORT="$TMP/stale.json.out" python3 -c "
import json, os, sys
d = json.load(open(os.environ['REPORT']))
mc = d.get('model_catalog') or {}
sys.exit(0 if mc.get('status') == 'warn' and (mc.get('age_days') or 0) > 90 else 1)
" 2>/dev/null; then
    ok "--json reports model_catalog.status=warn when stale"
else
    bad "--json did not report a stale model_catalog"
fi

if REPORT="$TMP/fresh.json.out" python3 -c "
import json, os, sys
d = json.load(open(os.environ['REPORT']))
sys.exit(0 if (d.get('model_catalog') or {}).get('status') == 'pass' else 1)
" 2>/dev/null; then
    ok "--json reports model_catalog.status=pass when fresh"
else
    bad "--json did not report a fresh model_catalog"
fi

# Same advisory invariant on the machine-readable path: 'ok' and the tally are
# what automation gates on, so staleness must leave both untouched.
if [ "$json_rc" -eq "$json_fresh_rc" ]; then
    ok "--json exit code unchanged by staleness (both $json_fresh_rc)"
else
    bad "--json exit code changed by staleness ($json_fresh_rc -> $json_rc)"
fi

if python3 -c "
import json, sys
a = json.load(open('$TMP/fresh.json.out'))['summary']
b = json.load(open('$TMP/stale.json.out'))['summary']
sys.exit(0 if a == b else 1)
" 2>/dev/null; then
    ok "--json summary (incl. ok) identical fresh vs stale"
else
    bad "--json summary shifted between fresh and stale"
fi

# ---------------------------------------------------------------------------
# 5. Air-gapped: the age check reads a local file and must make no network call.
# ---------------------------------------------------------------------------
if grep -n "Model catalog" -A 30 "$LOKI" | grep -qE "curl|wget|urllib|http"; then
    bad "model catalog check appears to make a network call"
else
    ok "model catalog check is local-only (no network in the default path)"
fi

# ---------------------------------------------------------------------------
# 6. Unreadable catalog degrades to a warning, never a crash or a failure.
# ---------------------------------------------------------------------------
printf 'not json at all' > "$TMP/broken.json"
broken_out="$TMP/broken.out"
LOKI_MODEL_CATALOG="$TMP/broken.json" "$LOKI" doctor >"$broken_out" 2>&1
broken_rc=$?
if [ "$broken_rc" -eq "$fresh_rc" ] && grep -q "cannot determine age" "$broken_out"; then
    ok "unreadable catalog warns without changing the exit code"
else
    bad "unreadable catalog changed exit code ($fresh_rc -> $broken_rc) or did not warn"
fi

printf '\n%s\n' "----------------------------------------"
printf 'Passed: %d  Failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
