#!/usr/bin/env bash
# Outcome Ledger: the anchor gate, and the refusal to fabricate a rate.
#
# WHY THE ANCHOR GATE IS THE WHOLE TEST. `facts.git.head_sha` is `git rev-parse
# HEAD` at receipt-generation time, which for uncommitted work is the run's
# STARTING commit, not what the change became. Measured on this repo's own nine
# receipts: eight carry base_sha="" and share head_sha=1385e71c, a commit that
# touches TWO files while those receipts attest to EIGHT. Following head_sha
# regardless would attribute one commit's fate to eight unrelated runs and print
# it as a change-failure rate.
#
# File-overlap was tested as a fallback discriminator and REJECTED: those bad
# receipts overlap that commit by two files, so any overlap>0 rule marks all
# eight as anchored. Overlap is not evidence of identity.
#
# So the assertions below are mostly about REFUSING to measure. A tool that
# prints 0.0 where it means "I cannot tell" is the false-green this product
# exists to reject, and 0.0 is the number that would look best.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LEDGER="$REPO_ROOT/autonomy/lib/outcome_ledger.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: outcome ledger anchors before it measures"

[ -f "$LEDGER" ] || { echo "  FAIL: $LEDGER missing"; exit 1; }

# Build a synthetic repo we fully control: base commit, then a change, then a
# receipt naming that exact range. This is the only way to get an ANCHORED
# receipt, which is itself the point.
_mk_repo() {
    local d; d="$(mktemp -d)"
    git -C "$d" init -q .
    git -C "$d" config user.email t@t
    git -C "$d" config user.name t
    echo "line1" > "$d/a.txt"
    git -C "$d" add a.txt
    git -C "$d" commit -qm base
    printf 'line1\nline2\nline3\n' > "$d/a.txt"
    git -C "$d" add a.txt
    git -C "$d" commit -qm change
    printf '%s' "$d"
}

_write_receipt() {
    local d="$1" base="$2" head="$3"
    mkdir -p "$d/.loki/proofs/r1"
    python3 - "$d/.loki/proofs/r1/proof.json" "$base" "$head" <<'PY'
import json, sys
json.dump({"run_id": "r1", "facts": {"git": {
    "base_sha": sys.argv[2], "head_sha": sys.argv[3],
    "diff": {"count": 1, "files": [
        {"path": "a.txt", "insertions": 2, "deletions": 0, "status": "modified"}]}}}},
    open(sys.argv[1], "w"))
PY
}

# --- 1. ANCHORED + surviving -------------------------------------------------
D="$(_mk_repo)"
BASE="$(git -C "$D" rev-parse HEAD~1)"
HEAD_SHA="$(git -C "$D" rev-parse HEAD)"
_write_receipt "$D" "$BASE" "$HEAD_SHA"
OUT="$(cd "$D" && python3 "$LEDGER" --json 2>/dev/null)"

if printf '%s' "$OUT" | grep -q '"state": "anchored"'; then
    ok "a receipt whose base..head IS the change anchors"
else
    bad "a genuinely anchored receipt did not anchor"
fi
if printf '%s' "$OUT" | grep -q '"outcome": "SURVIVED"'; then
    ok "surviving work reports SURVIVED"
else
    bad "surviving work did not report SURVIVED"
fi

# --- 2. REVERTED is a fact, read from git's own trailer ----------------------
git -C "$D" revert --no-edit HEAD >/dev/null 2>&1
OUT="$(cd "$D" && python3 "$LEDGER" --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"outcome": "REVERTED"'; then
    ok "a reverted change is detected from the 'This reverts commit' trailer"
else
    bad "a real revert was not detected"
fi
# The three signals are independent; they must agree, or one of them is lying.
if printf '%s' "$OUT" | grep -q '"change_failure_rate": 1.0'; then
    ok "change-failure rate reflects the revert (1.0 over 1 measured)"
else
    bad "change-failure rate did not follow the revert"
fi
rm -rf "$D"

# --- 3. THE REGRESSION THAT MATTERS: empty base_sha must NOT anchor ----------
# This is the exact shape of 8 of this repo's 9 real receipts.
D="$(_mk_repo)"
HEAD_SHA="$(git -C "$D" rev-parse HEAD)"
_write_receipt "$D" "" "$HEAD_SHA"
OUT="$(cd "$D" && python3 "$LEDGER" --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "base_sha_empty"'; then
    ok "a receipt with no recorded baseline is UNKNOWN, not measured"
else
    bad "a receipt with no baseline was measured anyway -- fabricated numbers"
fi
if printf '%s' "$OUT" | grep -q '"change_failure_rate": "UNKNOWN"'; then
    ok "with nothing measurable the rate is UNKNOWN, never 0.0"
else
    bad "an unmeasurable rate was reported as a number (false green)"
fi
rm -rf "$D"

# --- 4. Greenfield empty-tree baseline is not a baseline ---------------------
D="$(_mk_repo)"
HEAD_SHA="$(git -C "$D" rev-parse HEAD)"
_write_receipt "$D" "4b825dc642cb6eb9a060e54bf8d69288fbee4904" "$HEAD_SHA"
OUT="$(cd "$D" && python3 "$LEDGER" --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "greenfield_no_baseline"'; then
    ok "the empty-tree sha is refused as a baseline"
else
    bad "the empty-tree sha was accepted as a real baseline"
fi
rm -rf "$D"

# --- 5. A file-set mismatch must not anchor ----------------------------------
# The discriminator overlap-matching cannot make: the range is real and
# reachable, but it is not THIS change.
D="$(_mk_repo)"
BASE="$(git -C "$D" rev-parse HEAD~1)"
HEAD_SHA="$(git -C "$D" rev-parse HEAD)"
mkdir -p "$D/.loki/proofs/r1"
python3 - "$D/.loki/proofs/r1/proof.json" "$BASE" "$HEAD_SHA" <<'PY'
import json, sys
# Claims TWO files; the real range touches one. Same shape as the eight
# real receipts that overlap their head_sha commit by two files.
json.dump({"run_id": "r1", "facts": {"git": {
    "base_sha": sys.argv[2], "head_sha": sys.argv[3],
    "diff": {"count": 2, "files": [
        {"path": "a.txt", "insertions": 2, "deletions": 0, "status": "modified"},
        {"path": "unrelated.txt", "insertions": 9, "deletions": 0, "status": "modified"}]}}}},
    open(sys.argv[1], "w"))
PY
OUT="$(cd "$D" && python3 "$LEDGER" --json 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "diff_range_mismatch"'; then
    ok "a range whose files do not match the receipt is refused"
else
    bad "a non-matching range anchored -- overlap masqueraded as identity"
fi
rm -rf "$D"

# --- 6. Read-only: analysing a repo must never modify it ---------------------
D="$(_mk_repo)"
BASE="$(git -C "$D" rev-parse HEAD~1)"
HEAD_SHA="$(git -C "$D" rev-parse HEAD)"
_write_receipt "$D" "$BASE" "$HEAD_SHA"
BEFORE="$(git -C "$D" status --porcelain)"
(cd "$D" && python3 "$LEDGER" >/dev/null 2>&1)
AFTER="$(git -C "$D" status --porcelain)"
if [ "$BEFORE" = "$AFTER" ]; then
    ok "the ledger does not modify the repo it analyses"
else
    bad "the ledger mutated the repo under analysis"
fi
rm -rf "$D"

# --- 7. Single telemetry egress point stays single ---------------------------
if [ "$(grep -c 'loki_telemetry\|curl ' "$LEDGER")" = "0" ]; then
    ok "the ledger adds no second telemetry egress point"
else
    bad "the ledger emits telemetry directly (must route through telemetry.sh)"
fi

# --- 8. House style ----------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$LEDGER" 2>/dev/null; then
    ok "no emoji and no em-dash in the ledger source"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
