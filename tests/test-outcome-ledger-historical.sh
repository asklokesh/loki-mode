#!/usr/bin/env bash
# Test: the outcome ledger distinguishes "historically unanchorable" from
# "newly broken".
#
# WHY THIS EXISTS. This repo's own ledger reports ANCHORED 0 of 9. All 9 are
# frozen receipts: 8 carry base_sha="" and 1 carries the empty tree, and every
# one was generated BEFORE proof-generator learned to read .loki/state/start-sha
# (commit 99ce689d, 2026-08-07). Those are history -- the missing baseline is in
# the receipt JSON on disk and no future fix can anchor them. Rewriting a receipt
# to improve a metric is exactly the dishonesty the module refuses.
#
# The danger is the opposite error: if the ledger files EVERY frozen receipt as
# history, a generator that starts dropping the anchor again would look like more
# old data instead of a regression. That silence is the failure this guards.
#
# Synthetic receipts in a tmpdir -- never .loki/proofs/, whose contents are real
# history that must not be touched and whose count can change.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$REPO_ROOT/autonomy/lib/outcome_ledger.py"

PASS=0
FAIL=0

ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
no() { echo "  FAIL: $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Outcome ledger: historical vs newly-broken"
echo

# A real repo with a real baseline, so the "live" and "anchored" cases are
# genuine git facts rather than mocks.
git init -q "$TMP"
git -C "$TMP" config user.email t@t
git -C "$TMP" config user.name t
printf 'one\n' > "$TMP/a.txt"
git -C "$TMP" add a.txt
git -C "$TMP" commit -qm base
BASE="$(git -C "$TMP" rev-parse HEAD)"
printf 'two\n' >> "$TMP/a.txt"
git -C "$TMP" add a.txt
git -C "$TMP" commit -qm work
HEAD_SHA="$(git -C "$TMP" rev-parse HEAD)"

mkreceipt() {
    # $1=id  $2=generated_at  $3=base_sha  $4=head_sha
    mkdir -p "$TMP/.loki/proofs/$1"
    cat > "$TMP/.loki/proofs/$1/proof.json" <<JSON
{
  "run_id": "$1",
  "generated_at": "$2",
  "facts": {"git": {"base_sha": "$3", "head_sha": "$4",
    "diff": {"files": [{"path": "a.txt", "insertions": 1}]}}}
}
JSON
}

run_ledger() {
    LOKI_OUTCOMES_CWD="$TMP" python3 "$LEDGER" --json 2>/dev/null
}

field() { python3 -c "import json,sys; print(json.load(sys.stdin)['summary'].get('$1'))"; }
klass_of() {
    python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d['receipts']:
    if r['run_id']=='$1':
        print((r.get('anchor') or {}).get('klass'));break
else: print('MISSING')"
}

# 1. A pre-fix receipt with base_sha="" is HISTORY, not a defect.
mkreceipt old-empty-base "2026-07-27T01:53:20.453742Z" "" "$HEAD_SHA"
OUT="$(run_ledger)"
K="$(printf '%s' "$OUT" | klass_of old-empty-base)"
if [ "$K" = "historical" ]; then
    ok "pre-fix base_sha='' classified historical"
else
    no "pre-fix base_sha='' classified historical" "got klass=$K"
fi

# 2. THE REGRESSION TRAP. Same defect, receipt written AFTER the fix. If this
#    reads as history, a broken generator hides behind old data.
mkreceipt new-empty-base "2026-08-08T10:00:00Z" "" "$HEAD_SHA"
OUT="$(run_ledger)"
K="$(printf '%s' "$OUT" | klass_of new-empty-base)"
if [ "$K" = "regression" ]; then
    ok "post-fix base_sha='' classified regression, not history"
else
    no "post-fix base_sha='' classified regression, not history" "got klass=$K"
fi

# 3. The two buckets are counted separately in the summary.
OUT="$(run_ledger)"
H="$(printf '%s' "$OUT" | field unanchored_historical)"
R="$(printf '%s' "$OUT" | field unanchored_regression)"
if [ "$H" = "1" ] && [ "$R" = "1" ]; then
    ok "summary counts historical=1 regression=1 separately"
else
    no "summary counts historical/regression separately" "historical=$H regression=$R"
fi

# 4. A receipt whose shas are real but unresolvable HERE is live, not frozen:
#    it can anchor later without the receipt changing. Uses a well-formed sha
#    that exists in no clone.
GHOST="0123456789012345678901234567890123456789"
mkreceipt ghost-sha "2026-08-08T10:00:00Z" "$GHOST" "$HEAD_SHA"
OUT="$(run_ledger)"
K="$(printf '%s' "$OUT" | klass_of ghost-sha)"
if [ "$K" = "live" ]; then
    ok "unresolvable-but-real sha classified live, not historical"
else
    no "unresolvable-but-real sha classified live" "got klass=$K"
fi

# 5. A receipt with no timestamp cannot be placed relative to the fix. It must
#    NOT be assumed historical -- that direction hides a regression.
mkreceipt no-timestamp "" "" "$HEAD_SHA"
OUT="$(run_ledger)"
K="$(printf '%s' "$OUT" | klass_of no-timestamp)"
if [ "$K" = "regression" ]; then
    ok "missing generated_at is not assumed historical"
else
    no "missing generated_at is not assumed historical" "got klass=$K"
fi

# 6. Classification never manufactures an anchor: a properly anchored receipt
#    still measures, and carries no klass at all.
rm -rf "$TMP/.loki/proofs"
mkreceipt good "2026-08-08T10:00:00Z" "$BASE" "$HEAD_SHA"
OUT="$(run_ledger)"
M="$(printf '%s' "$OUT" | field receipts_measured)"
K="$(printf '%s' "$OUT" | klass_of good)"
if [ "$M" = "1" ] && [ "$K" = "None" ]; then
    ok "anchored receipt still measures and carries no klass"
else
    no "anchored receipt still measures" "measured=$M klass=$K"
fi

# 7. BY DESIGN, not a regression. A genuinely greenfield run has no earlier
#    commit to diff against, so the empty tree is CORRECT at any date. Flagging
#    a fresh one as a defect would be a false alarm on the very signal added to
#    prevent false alarms.
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
mkreceipt fresh-greenfield "2026-08-08T10:00:00Z" "$EMPTY_TREE" "$HEAD_SHA"
OUT="$(run_ledger)"
K="$(printf '%s' "$OUT" | klass_of fresh-greenfield)"
if [ "$K" = "by_design" ]; then
    ok "post-fix greenfield is by_design, not a regression"
else
    no "post-fix greenfield is by_design, not a regression" "got klass=$K"
fi

# 8. Same for a receipt written over uncommitted work: base == head is honest,
#    not a generator failure, whatever the date.
mkreceipt fresh-uncommitted "2026-08-08T10:00:00Z" "$HEAD_SHA" "$HEAD_SHA"
OUT="$(run_ledger)"
K="$(printf '%s' "$OUT" | klass_of fresh-uncommitted)"
if [ "$K" = "by_design" ]; then
    ok "post-fix base==head is by_design, not a regression"
else
    no "post-fix base==head is by_design, not a regression" "got klass=$K"
fi

# 9. The human-readable output names the regression, so an operator reading the
#    terminal is not left to infer it from JSON.
mkreceipt new-empty-base2 "2026-08-08T10:00:00Z" "" "$HEAD_SHA"
TEXT="$(LOKI_OUTCOMES_CWD="$TMP" python3 "$LEDGER" 2>/dev/null)"
if printf '%s' "$TEXT" | grep -q "REGRESSION"; then
    ok "text output names the regression"
else
    no "text output names the regression" "no REGRESSION line in output"
fi

echo
echo "  passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "ALL TESTS PASSED"
