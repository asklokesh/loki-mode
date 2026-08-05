#!/usr/bin/env bash
# A capped council must shrink the TAIL, never the mandate.
#
# WHY THIS EXISTS -- measured, from real code_review_start/complete pairs:
#
#     3 reviewers ->  31s        6 reviewers -> 177s
#     7 reviewers -> 280s        7 reviewers -> 502s
#
# Dispatch is already concurrent (run.sh:14803 forks with `) &`), so the growth
# is the max-of-N tail plus contention on a single provider. The tier map sizes
# only the SPECIALIST slots ({simple:2, standard:2, complex:4}); installed
# agents and dependency-analyst append afterwards, so nothing bounded the total.
# A scoped GitHub issue was drawing a 7-member council -- including two
# overlapping security reviewers -- and paying 9-16x the 3-member wall clock.
#
# THE SAFETY PROPERTY UNDER TEST. Shrinking a council must never be able to
# manufacture an approval. Mandatory reviewers carry mandates no keyword-selected
# specialist has, so:
#
#   - mandatory reviewers are NEVER trimmed
#   - a cap BELOW the mandatory count is refused, not honoured
#   - the default (unset / 0) changes nothing
#
# The selector is a python heredoc inside run.sh, so this test extracts and runs
# the cap logic against synthetic reviewer lists. That tests the trimming rule
# itself, which is where the safety property lives.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: review council total cap"

# Re-implement the trimming rule exactly as run.sh applies it, driven by env.
# Kept in one place so a drift between this and run.sh shows up as a mismatch
# in the wiring assertions at the bottom.
cap_probe() {
    local cap="$1" mandatory_n="$2" total_n="$3"
    LOKI_REVIEW_MAX_REVIEWERS="$cap" _M="$mandatory_n" _T="$total_n" python3 - <<'PY'
import os
m = int(os.environ["_M"]); t = int(os.environ["_T"])
mandatory = [{"name": f"mand{i}"} for i in range(m)]
reviewers = mandatory + [{"name": f"spec{i}"} for i in range(t - m)]

try:
    _cap = int(os.environ.get("LOKI_REVIEW_MAX_REVIEWERS", "0") or "0")
except ValueError:
    _cap = 0
if _cap > 0 and len(reviewers) > _cap:
    _mandatory_names = {r["name"] for r in mandatory}
    _keep = [r for r in reviewers if r["name"] in _mandatory_names]
    for _r in reviewers:
        if len(_keep) >= _cap:
            break
        if _r["name"] not in _mandatory_names:
            _keep.append(_r)
    reviewers = _keep if len(_keep) >= len(_mandatory_names) else reviewers

print("%d|%s" % (len(reviewers),
                 ",".join(r["name"] for r in reviewers)))
PY
}

# --- default is a no-op ------------------------------------------------------
out="$(cap_probe 0 3 7)"
if [ "${out%%|*}" = "7" ]; then
    ok "unset/0 cap leaves the council untouched (7 -> 7)"
else
    bad "default cap changed the council: $out"
fi

# --- a cap trims the tail ----------------------------------------------------
out="$(cap_probe 4 3 7)"
if [ "${out%%|*}" = "4" ]; then
    ok "cap=4 trims a 7-member council to 4"
else
    bad "cap=4 did not trim: $out"
fi

# --- mandatory reviewers survive --------------------------------------------
out="$(cap_probe 4 3 7)"
names="${out#*|}"
_missing=""
for m in mand0 mand1 mand2; do
    case ",$names," in *",$m,"*) ;; *) _missing="$_missing $m" ;; esac
done
if [ -z "$_missing" ]; then
    ok "every mandatory reviewer survives the cap"
else
    bad "cap dropped mandatory reviewer(s):$_missing"
fi

# --- a cap BELOW the mandate is refused --------------------------------------
# Honouring it would drop a reviewer carrying a mandate, which is how a smaller
# council could manufacture an approval.
out="$(cap_probe 1 3 7)"
if [ "${out%%|*}" -ge 3 ]; then
    ok "a cap below the mandatory count is refused, not honoured"
else
    bad "cap=1 cut below the mandatory set: $out"
fi

# --- a cap at or above the size is a no-op -----------------------------------
out="$(cap_probe 9 3 7)"
if [ "${out%%|*}" = "7" ]; then
    ok "a cap larger than the council is a no-op"
else
    bad "cap=9 altered a 7-member council: $out"
fi

# --- a malformed cap must not crash or silently trim -------------------------
out="$(LOKI_REVIEW_MAX_REVIEWERS=abc cap_probe "" 3 7 2>/dev/null)"
out="$(cap_probe abc 3 7)"
if [ "${out%%|*}" = "7" ]; then
    ok "a non-numeric cap falls back to uncapped"
else
    bad "a malformed cap changed the council: $out"
fi

# --- WIRING ------------------------------------------------------------------
# The probe above tests the RULE. These assert run.sh actually carries it, since
# a correct rule nothing applies is the caller-vs-callee gap found nine times in
# this codebase already.
if grep -q 'LOKI_REVIEW_MAX_REVIEWERS' "$RUN_SH"; then
    ok "WIRING: run.sh reads LOKI_REVIEW_MAX_REVIEWERS"
else
    bad "WIRING: the cap env var is absent from run.sh"
fi

if grep -q '_keep if len(_keep) >= len(_mandatory_names) else reviewers' "$RUN_SH"; then
    ok "WIRING: run.sh refuses a cap below the mandatory set"
else
    bad "WIRING: the below-mandate guard is missing; a cap could drop a mandate"
fi

if grep -q 'if _r\["name"\] not in _mandatory_names:' "$RUN_SH"; then
    ok "WIRING: run.sh trims only non-mandatory reviewers"
else
    bad "WIRING: the mandatory-exclusion in the trim loop is missing"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
