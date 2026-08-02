#!/usr/bin/env bash
# Test: tools/verify-demo.sh
#
# The demo's entire value is that it EXERCISES the verification chain rather
# than describing it. So this asserts by running it, never by reading it.
#
# THE ASSERTION THAT CARRIES THIS FILE. Grepping the output for "VERIFIED" is
# not enough: `echo VERIFIED` satisfies that, and a demo that printed its own
# verdicts would sail through while the real verifier was broken. So the test
# extracts the sha256 the demo reports and RE-COMPUTES it here from the receipt
# bytes. Only a genuine receipt-attest.py run over a genuine generated receipt
# can put that exact 64-hex digest on stdout. Do not weaken this to a keyword
# match.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO="$ROOT/tools/verify-demo.sh"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-test-verify-demo-XXXXXX")"
trap 'rm -rf "$TMPROOT"' EXIT

echo "========================================"
echo "verify-demo Tests"
echo "========================================"
echo "Demo: $DEMO"
echo ""

# ===========================================
# Test 1: the demo exists and parses
# ===========================================
log_test "demo exists and is syntactically valid"
if [ ! -f "$DEMO" ]; then
    log_fail "tools/verify-demo.sh does not exist"
elif bash -n "$DEMO" 2>/dev/null; then
    log_pass "tools/verify-demo.sh exists and passes bash -n"
else
    log_fail "tools/verify-demo.sh fails bash -n"
fi

# ===========================================
# Run once on a healthy tree; every following test reads this run.
# ===========================================
OUT="$TMPROOT/run.out"
bash "$DEMO" >"$OUT" 2>&1
DEMO_EXIT=$?

log_test "demo exits 0 on a healthy tree"
if [ "$DEMO_EXIT" -eq 0 ]; then
    log_pass "demo exited 0"
else
    log_fail "demo exited $DEMO_EXIT (expected 0); output follows"
    sed 's/^/    /' "$OUT"
fi

# ===========================================
# Test 3: it declares the receipts synthetic and disclaims spend.
# A demo mistakable for a real run is a fabricated credential.
# ===========================================
# The disclosure must land BEFORE the first verdict, not only in the closing
# summary: a reader who stops at the first VERIFIED must already have been told
# these receipts are synthetic. Asserting position (not just presence) is what
# stops the up-front banner being weakened while a trailing mention keeps a
# keyword grep green.
log_test "output states the receipts are SYNTHETIC and no money was spent, up front"
synth_line="$(grep -n "SYNTHETIC" "$OUT" | head -1 | cut -d: -f1)"
verdict_line="$(grep -n '^VERIFIED' "$OUT" | head -1 | cut -d: -f1)"
if [ -z "$synth_line" ]; then
    log_fail "output never states the receipts are SYNTHETIC"
elif ! grep -qi "no money was spent" "$OUT" \
        || ! grep -qi "no provider was contacted" "$OUT" \
        || ! grep -qi "no build was run" "$OUT"; then
    log_fail "output does not disclaim build/provider/spend"
elif [ -z "$verdict_line" ]; then
    log_fail "no verdict line found, so disclosure ordering cannot be checked"
elif [ "$synth_line" -lt "$verdict_line" ]; then
    log_pass "synthetic/no-spend disclosure appears before the first verdict"
else
    log_fail "SYNTHETIC disclosure (line $synth_line) comes after the first verdict (line $verdict_line)"
fi

# ===========================================
# Test 4: a REAL verification happened.
# The sha256 is re-computed here from the receipt the demo kept under --keep.
# A hardcoded echo cannot produce a digest that matches bytes on disk.
# ===========================================
log_test "a real VERIFIED verdict, proven by re-computing the reported sha256"
KEEPOUT="$TMPROOT/keep.out"
bash "$DEMO" --keep >"$KEEPOUT" 2>&1
KEEP_EXIT=$?
SCRATCH="$(sed -n 's/^scratch kept at: //p' "$KEEPOUT" | tail -1)"

if [ "$KEEP_EXIT" -ne 0 ]; then
    log_fail "demo --keep exited $KEEP_EXIT (expected 0)"
elif [ -z "$SCRATCH" ] || [ ! -d "$SCRATCH" ]; then
    log_fail "demo --keep did not report a surviving scratch directory"
else
    # The VERIFIED verdict and the digest immediately under it.
    reported_sha="$(grep -A4 '^VERIFIED' "$KEEPOUT" | sed -n 's/^sha256 *//p' | head -1)"
    receipt="$SCRATCH/.loki/proofs/tampered/proof.json"
    # The demo moves the generated receipt here before the gate step, so the
    # gate sees only the tampered one while these bytes survive for re-hashing.
    good_receipt="$SCRATCH/generated/proof.json"
    actual_sha=""
    if [ -f "$good_receipt" ]; then
        # Recomputed the way receipt-attest.py does it (receipt-attest.py:182):
        # sha256 over the CANONICALIZED receipt with `verification` stripped,
        # not over the raw file bytes, so the digest is stable across machines
        # regardless of key order or whitespace. Re-deriving it independently
        # here is what makes a hardcoded "VERIFIED" impossible to fake.
        actual_sha="$(python3 - "$good_receipt" "$ROOT" <<'PY'
import hashlib, importlib.util, json, pathlib, sys
sys.dont_write_bytecode = True
receipt, root = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location(
    "proof_verify", pathlib.Path(root) / "autonomy" / "lib" / "proof-verify.py")
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
proof = json.loads(open(receipt).read())
proof.pop("verification", None)
print(hashlib.sha256(pv._canonical(proof).encode("utf-8")).hexdigest())
PY
)"
    fi

    if ! grep -q '^VERIFIED' "$KEEPOUT"; then
        log_fail "no VERIFIED verdict line in demo output"
    elif [ -z "$reported_sha" ]; then
        log_fail "demo printed VERIFIED but no sha256 -- verifier output not shown"
    elif [ -z "$actual_sha" ]; then
        log_fail "demo printed VERIFIED but left no good receipt to re-hash"
    elif [ "$reported_sha" = "$actual_sha" ]; then
        log_pass "reported sha256 matches the receipt on disk ($reported_sha)"
    else
        log_fail "sha256 mismatch: demo said $reported_sha, receipt hashes to $actual_sha"
    fi

    # ===========================================
    # Test 5: the tamper was caught by the real verifier, with a reason.
    # ===========================================
    log_test "tampered receipt is CAUGHT with the verifier's own reason"
    if grep -q '^FAILED' "$KEEPOUT" && grep -q 'integrity  FAILED' "$KEEPOUT" \
            && grep -q 'hash mismatch' "$KEEPOUT"; then
        log_pass "tamper caught: FAILED verdict with the hash-mismatch reason"
    else
        log_fail "no real tamper-CAUGHT verdict with a reason in the output"
    fi

    # The tampered receipt must differ from the good one on disk, or the
    # "tamper" was cosmetic and the catch proves nothing.
    log_test "the tampered receipt genuinely differs from the generated one"
    if [ -f "$receipt" ] && [ -f "$good_receipt" ] \
            && ! cmp -s "$receipt" "$good_receipt"; then
        log_pass "tampered receipt differs from the good receipt"
    else
        log_fail "tampered receipt missing or identical to the good receipt"
    fi

    # ===========================================
    # Test 6: the gate refused.
    # ===========================================
    log_test "the CI gate refuses to pass on the tampered receipt"
    if grep -q 'GATE: FAIL' "$KEEPOUT"; then
        log_pass "ci-gate.py printed a FAIL verdict"
    else
        log_fail "no gate FAIL verdict in the output"
    fi

    rm -rf "$SCRATCH"
fi

# ===========================================
# Test 7: cleanup by default.
# ===========================================
log_test "scratch directory is removed unless --keep"
scratch_default="$(sed -n 's/^ *scratch workspace: //p' "$OUT" | tail -1)"
if [ -z "$scratch_default" ]; then
    log_fail "demo did not report its scratch workspace path"
elif [ -d "$scratch_default" ]; then
    log_fail "scratch directory survived without --keep: $scratch_default"
    rm -rf "$scratch_default"
else
    log_pass "scratch directory cleaned up by default"
fi

# ===========================================
# Test 8: a missing required tool names the tool and fails.
#
# Symlinks, not copies: receipt-attest.py resolves its own path to find
# autonomy/lib, and resolve() follows a symlink back to the real repo. A copy
# would break its imports and this would pass for the wrong reason.
# ===========================================
log_test "a missing required tool is named, and the demo exits non-zero"
FAKE="$TMPROOT/fakeroot"
mkdir -p "$FAKE/tools" "$FAKE/autonomy/lib"
cp "$DEMO" "$FAKE/tools/verify-demo.sh"
ln -s "$ROOT/autonomy/lib/proof-generator.py" "$FAKE/autonomy/lib/proof-generator.py"
ln -s "$ROOT/tools/receipt-attest.py" "$FAKE/tools/receipt-attest.py"
# ci-gate.py deliberately absent.

HIDE_OUT="$TMPROOT/hidden.out"
bash "$FAKE/tools/verify-demo.sh" >"$HIDE_OUT" 2>&1
HIDE_EXIT=$?

if [ "$HIDE_EXIT" -eq 0 ]; then
    log_fail "demo reported success (exit 0) with ci-gate.py absent"
elif grep -q "ci-gate.py" "$HIDE_OUT" && grep -qi "missing" "$HIDE_OUT"; then
    log_pass "demo named the missing tool (ci-gate.py) and exited $HIDE_EXIT"
else
    log_fail "demo exited $HIDE_EXIT but did not name the missing tool; output:"
    sed 's/^/    /' "$HIDE_OUT"
fi

# ===========================================
# Test 9: requirement 5 -- the demo is also a smoke test, so it must FAIL when
# the chain misbehaves, not just narrate whatever happened.
#
# Asserted by neutering the verifier the demo depends on: a stub attest that
# exits 0 for every receipt (including the tampered one) is exactly the
# regression the demo exists to catch. Testing the guard by breaking the
# WORLD rather than by grepping the demo's source is what makes this catch a
# deleted guard -- the earlier assertions all still pass in that state,
# because the real tool is still being run and its output is unchanged.
# ===========================================
log_test "demo exits non-zero when the verifier stops catching tampering"
# BOTH the attester and the gate are stubbed green. Stubbing only the attester
# would prove nothing: the real gate would still fail on the tampered receipt
# and carry the exit code on its own, so the assertion would pass even with the
# tamper guard deleted. Blinding every downstream check leaves the demo's own
# per-step assertion as the ONLY thing that can still fail.
BLIND="$TMPROOT/blindroot"
mkdir -p "$BLIND/tools" "$BLIND/autonomy/lib"
cp "$DEMO" "$BLIND/tools/verify-demo.sh"
ln -s "$ROOT/autonomy/lib/proof-generator.py" "$BLIND/autonomy/lib/proof-generator.py"
cat > "$BLIND/tools/receipt-attest.py" <<'STUB'
#!/usr/bin/env python3
"""Stub: a verifier that has gone blind and passes everything."""
print("VERIFIED -- every axis checked here passed")
print("sha256       " + "0" * 64)
raise SystemExit(0)
STUB
cat > "$BLIND/tools/ci-gate.py" <<'STUB'
#!/usr/bin/env python3
"""Stub: a gate that has gone blind and passes everything."""
print("GATE: PASS -- 1 of 1 policies passed")
raise SystemExit(0)
STUB

BLIND_OUT="$TMPROOT/blind.out"
bash "$BLIND/tools/verify-demo.sh" >"$BLIND_OUT" 2>&1
BLIND_EXIT=$?
if [ "$BLIND_EXIT" -eq 0 ]; then
    log_fail "demo exited 0 while a blind verifier passed the tampered receipt"
    sed 's/^/    /' "$BLIND_OUT"
elif grep -q "verify-demo: FAILED" "$BLIND_OUT"; then
    log_pass "demo exited $BLIND_EXIT and reported the step that misbehaved"
else
    log_fail "demo exited $BLIND_EXIT but never said which step misbehaved"
fi

# ===========================================
# Test 10: the tamper guard specifically.
#
# Test 9 blinds every downstream tool at once, which proves the demo fails
# SOMEWHERE but cannot isolate WHICH guard fired -- the attest guard and the
# gate guard both cover that scenario, so deleting either one alone still
# leaves the other to catch it. This pins the attest guard on its own: only
# receipt-attest.py is blinded, and the gate is stubbed to FAIL so it can
# never supply the non-zero exit on the tamper guard's behalf. If the demo
# stops asserting on the attest step, nothing else here can hide it.
# ===========================================
log_test "the tamper-step guard fires on its own, not via the gate downstream"
SOLO="$TMPROOT/soloroot"
mkdir -p "$SOLO/tools" "$SOLO/autonomy/lib"
cp "$DEMO" "$SOLO/tools/verify-demo.sh"
ln -s "$ROOT/autonomy/lib/proof-generator.py" "$SOLO/autonomy/lib/proof-generator.py"
cp "$BLIND/tools/receipt-attest.py" "$SOLO/tools/receipt-attest.py"
cat > "$SOLO/tools/ci-gate.py" <<'STUB'
#!/usr/bin/env python3
"""Stub: gate correctly refuses, so it cannot mask a missing attest guard."""
print("GATE: FAIL -- 0 of 1 policies passed")
raise SystemExit(1)
STUB

SOLO_OUT="$TMPROOT/solo.out"
bash "$SOLO/tools/verify-demo.sh" >"$SOLO_OUT" 2>&1
SOLO_EXIT=$?
if [ "$SOLO_EXIT" -eq 0 ]; then
    log_fail "demo exited 0 while a blind attester passed the tampered receipt"
elif grep -q "tampered receipt attested as clean" "$SOLO_OUT"; then
    log_pass "demo blamed the attest step specifically (exit $SOLO_EXIT)"
else
    log_fail "demo exited $SOLO_EXIT but did not blame the tamper step; output:"
    sed 's/^/    /' "$SOLO_OUT"
fi

# ===========================================
# Test 11: requirement 3 -- never write inside the user's real .loki.
#
# Run from a cwd that HAS a .loki, and assert it is byte-identical afterwards.
# The file LIST is compared, not just the sentinel's survival: the failure mode
# here is an ADDED file (a receipt dropped into the caller's proofs dir), which
# a survival-only check cannot see. Doubles as the only exercise of the demo
# from a cwd other than the repo root.
# ===========================================
log_test "demo never writes inside the caller's real .loki"
FAKECWD="$TMPROOT/fakecwd"
mkdir -p "$FAKECWD/.loki/proofs"
echo "sentinel" > "$FAKECWD/.loki/proofs/untouched.json"
before="$(find "$FAKECWD/.loki" | sort)
$(cat "$FAKECWD/.loki/proofs/untouched.json")"
( cd "$FAKECWD" && bash "$DEMO" >/dev/null 2>&1 )
CWD_EXIT=$?
after="$(find "$FAKECWD/.loki" | sort)
$(cat "$FAKECWD/.loki/proofs/untouched.json")"

if [ "$CWD_EXIT" -ne 0 ]; then
    log_fail "demo exited $CWD_EXIT when run from a directory containing .loki"
elif [ "$before" = "$after" ]; then
    log_pass "caller's .loki unchanged (same files, same contents)"
else
    log_fail "demo modified the caller's .loki"
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed 's/^/    /'
fi

echo ""
echo "========================================"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "========================================"

[ "$FAILED" -eq 0 ]
