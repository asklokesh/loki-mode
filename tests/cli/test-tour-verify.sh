#!/usr/bin/env bash
# tests/cli/test-tour-verify.sh
# Test: TEN-ADOPTION-01. `loki tour` (and `loki demo --offline`) runs the REAL
# verifier (engine10 verify, via bun) on the bundled sealed receipt, its event
# log and public JWK, prints VERIFIED, then prints TAMPERED for a one-byte-flipped
# copy. Offline, no key, no spend. Without Bun it prints the command and no verdict.
#
# Entry path under test: bin/loki tour and bin/loki demo --offline. The mutation
# cases point SKILL_DIR at a throwaway tree holding a modified copy of the fixture.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/bin/loki"
FIX="$REPO_ROOT/skills/fixtures/demo-receipt"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-tourtest.XXXXXXXX")
trap 'rm -rf "$TMP"' EXIT
export TMPDIR="$TMP"

# Fresh fake SKILL_DIR holding only the demo fixture (copy), for mutation cases.
mk_skill() {
    local d="$TMP/skill-$1"
    mkdir -p "$d/skills/fixtures"
    cp -R "$FIX" "$d/skills/fixtures/demo-receipt"
    printf '%s\n' "$d"
}

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not available; the verifier cannot run"
    exit 0
fi

BEFORE=$(cksum "$FIX/receipt.json" "$FIX/events.jsonl" "$FIX/pubkey.jwk")

# 1. tour: VERIFIED for the bundled receipt, TAMPERED for the flipped copy, rc 0
out=$("$LOKI" tour 2>&1); rc=$?
[ "$rc" -eq 0 ] && log_pass "tour exits 0" || log_fail "tour exits 0" "rc=$rc"
printf '%s\n' "$out" | grep -q '^  Result: VERIFIED$' \
    && log_pass "tour prints VERIFIED from the verifier" || log_fail "tour prints VERIFIED" "$(printf '%s' "$out" | tail -8)"
printf '%s\n' "$out" | grep -q '^  Result: TAMPERED$' \
    && log_pass "tour prints TAMPERED for the byte-flipped copy" || log_fail "tour prints TAMPERED" "$(printf '%s' "$out" | tail -8)"
printf '%s\n' "$out" | grep -q 'for display only' \
    && log_fail "display-only disclaimer is gone" "still printed" || log_pass "display-only disclaimer is gone"
# VERIFIED must come before TAMPERED (the copy is checked second)
v_line=$(printf '%s\n' "$out" | grep -n '^  Result: VERIFIED$' | head -n 1 | cut -d: -f1)
t_line=$(printf '%s\n' "$out" | grep -n '^  Result: TAMPERED$' | head -n 1 | cut -d: -f1)
[ -n "$v_line" ] && [ -n "$t_line" ] && [ "$v_line" -lt "$t_line" ] \
    && log_pass "original is verified before the copy is tampered" || log_fail "result order" "v=$v_line t=$t_line"

# 2. demo --offline is the same path
out=$("$LOKI" demo --offline 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^  Result: VERIFIED$' && printf '%s\n' "$out" | grep -q '^  Result: TAMPERED$'; } \
    && log_pass "demo --offline shows VERIFIED then TAMPERED, rc 0" || log_fail "demo --offline" "rc=$rc"

# 3. bundled files untouched, no temp dir left behind
AFTER=$(cksum "$FIX/receipt.json" "$FIX/events.jsonl" "$FIX/pubkey.jwk")
[ "$BEFORE" = "$AFTER" ] && log_pass "bundled fixture is not modified by the tour" || log_fail "fixture modified" "checksums differ"
left=$(find "$TMP" -maxdepth 1 -name 'loki-tour.*' | wc -l | tr -d ' ')
[ "$left" = "0" ] && log_pass "tour leaves no temp directory" || log_fail "temp cleanup" "$left left"

# 4. fixture never carries private key material
if grep -rq 'BEGIN [A-Z ]*PRIVATE KEY' "$FIX" || grep -q '"d"' "$FIX/pubkey.jwk"; then
    log_fail "fixture has no private key" "private key material found"
else
    log_pass "fixture has no private key material"
fi

# 5. mutation (a): one changed field in the receipt -> TAMPERED, never VERIFIED
d=$(mk_skill a)
sed 's/"turns": 7/"turns": 8/' "$d/skills/fixtures/demo-receipt/receipt.json" > "$d/r.tmp"
if cmp -s "$d/r.tmp" "$d/skills/fixtures/demo-receipt/receipt.json"; then
    log_fail "mutation a applied" "sed matched nothing"
else
    mv "$d/r.tmp" "$d/skills/fixtures/demo-receipt/receipt.json"
    out=$(SKILL_DIR="$d" "$LOKI" tour 2>&1); rc=$?
    { [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^  Result: TAMPERED$' && ! printf '%s\n' "$out" | grep -q '^  Result: VERIFIED$'; } \
        && log_pass "changed field: TAMPERED, not VERIFIED" || log_fail "mutation a" "rc=$rc $(printf '%s' "$out" | tail -6)"
fi

# 6. mutation (b): no pubkey.jwk -> UNCHECKED plus the command, never VERIFIED
d=$(mk_skill b)
rm -f "$d/skills/fixtures/demo-receipt/pubkey.jwk"
out=$(SKILL_DIR="$d" "$LOKI" tour 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'UNCHECKED' && printf '%s\n' "$out" | grep -q 'loki verify --pubkey' && ! printf '%s\n' "$out" | grep -q '^  Result: VERIFIED$'; } \
    && log_pass "missing pubkey: UNCHECKED with the command, never VERIFIED" || log_fail "mutation b" "rc=$rc $(printf '%s' "$out" | tail -6)"

# 7. mutation (c): bun hidden from PATH -> the command, no verdict
safe="$TMP/safebin"
mkdir -p "$safe"
for t in bash sh sed grep cat cp rm mktemp head cut tr wc find dirname basename uname date id ls mkdir tail awk python3 env stat sleep printf git; do
    p=$(command -v "$t" 2>/dev/null || true)
    case "$p" in /*) ln -sf "$p" "$safe/$t" ;; esac
done
if PATH="$safe" command -v bun >/dev/null 2>&1; then
    log_fail "bun hidden from PATH" "bun still resolvable"
else
    out=$(PATH="$safe" "$(command -v bash)" "$LOKI" tour 2>&1); rc=$?
    { [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'loki verify --pubkey' && ! printf '%s\n' "$out" | grep -q 'Result:'; } \
        && log_pass "no bun: command printed, no verdict claimed" || log_fail "mutation c" "rc=$rc $(printf '%s' "$out" | tail -6)"
fi

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
