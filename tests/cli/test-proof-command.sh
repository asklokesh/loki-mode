#!/usr/bin/env bash
# tests/cli/test-proof-command.sh
# Test: `loki proof list|show|open|share` (R1 proof-of-run CLI surface).
#
# Exercises the bash route of the proof command against a fixture .loki/proofs
# directory. No network: a fake `gh` on PATH records its args to a log instead
# of hitting GitHub. A fake `open`/`xdg-open`/`start` prevents a real browser
# launch. PATH is PREPENDED (not replaced) so python3/jq/mktemp still resolve.
#
# Assertions:
#   - list   shows the fixture run id, cost, verdict, file count.
#   - show   prints the proof.json content for a valid id; errors on missing.
#   - open   resolves the page and invokes the (faked) opener; errors on missing.
#   - share  WITHOUT --yes and answering "n" does NOT call `gh gist create`.
#   - share  WITH --yes DOES call `gh gist create` (recorded in the log).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

# tmp OUTSIDE the repo tree (mktemp default) so no .loki/ pollutes the repo.
TMP=$(mktemp -d -t loki-proof-cli-XXXX)
trap 'rm -rf "$TMP"' EXIT

# --- fixture proofs dir -----------------------------------------------------
PROJECT="$TMP/project"
PROOFS="$PROJECT/.loki/proofs"
RUN_ID="20260603T010203Z-abc123"
mkdir -p "$PROOFS/$RUN_ID"

cat > "$PROOFS/$RUN_ID/proof.json" <<JSON
{
  "schema_version": "1.0",
  "run_id": "$RUN_ID",
  "generated_at": "2026-06-03T01:02:03Z",
  "loki_version": "7.9.0",
  "cost": {"usd": 1.84, "input_tokens": 100, "output_tokens": 20},
  "files_changed": {"count": 3},
  "council": {"final_verdict": "APPROVE"},
  "redaction": {"applied": true, "rules_version": "1.0", "redactions_count": 2}
}
JSON

cat > "$PROOFS/$RUN_ID/index.html" <<'HTML'
<!DOCTYPE html><html><body><h1>Proof</h1></body></html>
HTML

# --- fake bin dir (prepended to PATH) ---------------------------------------
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
GH_LOG="$TMP/gh-calls.log"
: > "$GH_LOG"

cat > "$FAKEBIN/gh" <<EOF
#!/usr/bin/env bash
echo "gh \$*" >> "$GH_LOG"
case "\$1 \$2" in
  "auth status") exit 0 ;;
  "gist create") echo "https://gist.github.com/fake/deadbeef"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$FAKEBIN/gh"

for opener in open xdg-open start; do
  cat > "$FAKEBIN/$opener" <<EOF
#!/usr/bin/env bash
echo "$opener \$*" >> "$TMP/open-calls.log"
exit 0
EOF
  chmod +x "$FAKEBIN/$opener"
done
: > "$TMP/open-calls.log"

export PATH="$FAKEBIN:$PATH"

echo -e "${YELLOW}=== loki proof CLI tests ===${NC}"

# Helper: run the bash route of `loki proof ...` in the fixture project.
run_proof() {
  ( cd "$PROJECT" && LOKI_LEGACY_BASH=1 LOKI_DIR=".loki" \
      bash "$LOKI" proof "$@" )
}

# ---------------------------------------------------------------------------
# T1: list shows the fixture run.
# ---------------------------------------------------------------------------
out=$(run_proof list 2>&1)
if echo "$out" | grep -q "$RUN_ID" \
   && echo "$out" | grep -q "1.84" \
   && echo "$out" | grep -q "APPROVE"; then
  log_pass "proof list shows run id, cost, verdict"
else
  log_fail "proof list" "missing fields in output: $out"
fi

# ---------------------------------------------------------------------------
# T2: show prints proof.json for a valid id.
# ---------------------------------------------------------------------------
out=$(run_proof show "$RUN_ID" 2>&1)
if echo "$out" | grep -q '"schema_version"' \
   && echo "$out" | grep -q "$RUN_ID"; then
  log_pass "proof show prints proof.json for valid id"
else
  log_fail "proof show valid" "unexpected output: $out"
fi

# ---------------------------------------------------------------------------
# T3: show errors on missing id (non-zero exit).
# ---------------------------------------------------------------------------
out=$(run_proof show "does-not-exist" 2>&1)
rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qi "not found"; then
  log_pass "proof show errors on missing id"
else
  log_fail "proof show missing" "expected non-zero + 'not found', got rc=$rc: $out"
fi

# ---------------------------------------------------------------------------
# T4: open resolves the page and invokes the faked opener.
# ---------------------------------------------------------------------------
: > "$TMP/open-calls.log"
out=$(run_proof open "$RUN_ID" 2>&1)
rc=$?
if [ $rc -eq 0 ] && grep -q "index.html" "$TMP/open-calls.log"; then
  log_pass "proof open invokes opener for valid id"
else
  log_fail "proof open valid" "rc=$rc opener-log=$(cat "$TMP/open-calls.log"): $out"
fi

# ---------------------------------------------------------------------------
# T5: open errors on missing page.
# ---------------------------------------------------------------------------
out=$(run_proof open "no-such-run" 2>&1)
rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qi "not found"; then
  log_pass "proof open errors on missing page"
else
  log_fail "proof open missing" "expected non-zero + 'not found', got rc=$rc: $out"
fi

# ---------------------------------------------------------------------------
# T6: share WITHOUT --yes, answering "n" -> must NOT call `gh gist create`.
# ---------------------------------------------------------------------------
: > "$GH_LOG"
out=$( ( cd "$PROJECT" && LOKI_LEGACY_BASH=1 LOKI_DIR=".loki" \
         printf 'n\n' | bash "$LOKI" proof share "$RUN_ID" ) 2>&1 )
if grep -q "gist create" "$GH_LOG"; then
  log_fail "share declined no-network" "gh gist create was called despite 'n' answer"
elif echo "$out" | grep -qi "aborted"; then
  log_pass "share without --yes and 'n' answer does not publish"
else
  log_fail "share declined" "expected an abort message, got: $out"
fi

# ---------------------------------------------------------------------------
# T7: share WITH --yes -> DOES call `gh gist create` (mock, no real network).
# ---------------------------------------------------------------------------
: > "$GH_LOG"
out=$( ( cd "$PROJECT" && LOKI_LEGACY_BASH=1 LOKI_DIR=".loki" \
         bash "$LOKI" proof share "$RUN_ID" --yes ) 2>&1 )
if grep -q "gist create" "$GH_LOG"; then
  log_pass "share --yes invokes gh gist create (mocked)"
else
  log_fail "share --yes" "gh gist create not called. log=$(cat "$GH_LOG") out=$out"
fi

# ---------------------------------------------------------------------------
# T8: share shows the redaction-preview transparency summary before upload.
# ---------------------------------------------------------------------------
if echo "$out" | grep -qi "redaction" \
   && echo "$out" | grep -qi "stripped"; then
  log_pass "share shows redaction preview / what-is-shared summary"
else
  log_fail "share preview" "no redaction preview in share output: $out"
fi

echo ""
echo -e "${YELLOW}=== Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} ===${NC}"

[ $FAIL -gt 0 ] && exit 1
exit 0
