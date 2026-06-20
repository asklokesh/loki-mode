#!/usr/bin/env bash
#===============================================================================
# Proven PR -- Evidence Receipt renderer tests (Loop 6 / v7.90.0)
#
# Targeted coverage for render_evidence_receipt_md in autonomy/lib/proof-pr.sh:
# the shared, PRINT-ONLY Evidence Receipt renderer that all four PR-body
# construction sites route through. Reference: internal/LOOP6-PROVEN-PR-PLAN.md
# (SDET tests T1, T5, T6, T7, T9 + R-DET-2). T2/T3/T4 (check-run) live in
# tests/test-proven-pr-check.sh; T8 installed-layout + Bun parity belong to
# SDET 2.
#
# WHY SOURCE THE LIB DIRECTLY: proof-pr.sh is a pure, side-effect-free library
# (double-source guarded, print-only, returns 0 on every path). Sourcing it runs
# no top-level code, so we source it and drive render_evidence_receipt_md
# directly with hand-authored proof.json fixtures.
#
# WHY HAND-AUTHOR FIXTURES (not run the generator): the renderer reads
# honesty.headline VERBATIM (R-HON-1, proof-pr.sh:99) and never recomputes a
# verdict. So a fixture's headline field IS the input under test. We author each
# proof.json by hand to exercise every headline state plus the malformed/missing
# cases, independent of the generator's _compute_headline rules.
#
# THE T1 ASSERTION TRAP (binding, from the dev fleet): every rendered body --
# INCLUDING a NOT VERIFIED body -- contains the substring "VERIFIED" inside the
# mandatory "What the headline means" footnote (proof-pr.sh:231-237). A naive
# `grep -c VERIFIED` returns >1 on a non-green body. The ONLY green claim is the
# standalone line that reads EXACTLY "Headline: VERIFIED" (proof-pr.sh:151). We
# assert T1 with an ANCHORED full-line match: grep -qx 'Headline: VERIFIED'
# (the -x flag requires the WHOLE line to match, so "Headline: VERIFIED WITH
# GAPS" and the footnote prose can never satisfy it). POSITIVE CONTROL: a real
# VERIFIED fixture DOES match the anchored line, proving the matcher is not
# vacuously false.
#
# R-DET-2 (T6): production call sites pass an EMPTY expected_head_sha by design
# (the session commit happens between proof-gen and PR-create). So the head/base
# cross-check is exercised by calling render_evidence_receipt_md DIRECTLY with a
# non-empty MISMATCHING head sha against a VERIFIED fixture and asserting NO
# anchored "Headline: VERIFIED" line appears.
#
# NO NETWORK, NO REPO MUTATION: render is print-only; these tests never invoke
# git/gh and run entirely against a temp dir.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROOF_PR_LIB="$PROJECT_DIR/autonomy/lib/proof-pr.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-proven-pr-receipt.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Proven PR -- Evidence Receipt renderer tests (Loop 6 / v7.90.0)"
echo "==============================================================="
echo ""

if [ ! -f "$PROOF_PR_LIB" ]; then
    fail "lib present" "missing $PROOF_PR_LIB"
    echo ""
    echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
    exit 1
fi

# shellcheck disable=SC1090
. "$PROOF_PR_LIB"

if ! command -v render_evidence_receipt_md >/dev/null 2>&1; then
    fail "render_evidence_receipt_md defined" "function not found after sourcing lib"
    echo ""
    echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
    exit 1
fi

# -----------------------------------------------------------------------------
# Fixture authors. Each writes a proof.json with a chosen honesty.headline and
# (for non-VERIFIED) a non-empty honesty.degraded[] so the "gaps ARE listed"
# half of T1 has something to render (proof-pr.sh:198-214 only renders the gaps
# block when degraded is non-empty).
# -----------------------------------------------------------------------------

# A fully VERIFIED proof (positive control + head-match base for R-DET-2).
write_verified_proof() {
    local path="$1"
    cat > "$path" <<'JSON'
{
  "run_id": "run-verified-0001",
  "honesty": {
    "headline": "VERIFIED",
    "degraded": []
  },
  "facts": {
    "git": {
      "base_sha": "baseaaaa1111",
      "head_sha": "headbbbb2222",
      "diff_sha256": "deadbeefcafef00d",
      "diff": { "count": 3 }
    },
    "tests": { "status": "verified", "command": "npm test", "exit_code": 0 },
    "build": { "status": "verified", "command": "npm run build" },
    "security": { "ran": true, "high_active": 0, "status": "clean" },
    "cost": { "usd": 0.42 },
    "meta": { "run_id": "run-verified-0001" }
  }
}
JSON
}

# A VERIFIED WITH GAPS proof (non-empty degraded list).
write_gaps_proof() {
    local path="$1"
    cat > "$path" <<'JSON'
{
  "run_id": "run-gaps-0002",
  "honesty": {
    "headline": "VERIFIED WITH GAPS",
    "degraded": [
      { "item": "build", "status": "not_run", "reason": "no build command recorded" }
    ]
  },
  "facts": {
    "git": {
      "base_sha": "baseccc33333",
      "head_sha": "headddd44444",
      "diff_sha256": "0011223344556677",
      "diff": { "count": 2 }
    },
    "tests": { "status": "verified", "command": "pytest -q", "exit_code": 0 },
    "build": { "status": "not_run", "command": "" },
    "security": { "ran": false, "high_active": 0, "status": "not_run" },
    "cost": { "usd": 0.10 },
    "meta": { "run_id": "run-gaps-0002" }
  }
}
JSON
}

# A NOT VERIFIED proof (failed test -> non-empty degraded list).
write_notverified_proof() {
    local path="$1"
    cat > "$path" <<'JSON'
{
  "run_id": "run-notv-0003",
  "honesty": {
    "headline": "NOT VERIFIED",
    "degraded": [
      { "item": "tests", "status": "failed", "reason": "1 test failed" }
    ]
  },
  "facts": {
    "git": {
      "base_sha": "baseeee55555",
      "head_sha": "headfff66666",
      "diff_sha256": "8899aabbccddeeff",
      "diff": { "count": 1 }
    },
    "tests": { "status": "failed", "command": "npm test", "exit_code": 1 },
    "build": { "status": "not_run", "command": "" },
    "security": { "ran": false, "high_active": 0, "status": "not_run" },
    "cost": { "usd": 0.05 },
    "meta": { "run_id": "run-notv-0003" }
  }
}
JSON
}

# -----------------------------------------------------------------------------
# CALL-SITE GUARD PROXY (modeled, not in the lib under test).
# The LOKI_PROVEN_PR env gate lives in run.sh at the call sites, NOT in
# proof-pr.sh (the lib has no LOKI_PROVEN_PR reference). For T5 (byte-identical
# no-op) we model the documented call-site contract from
# LOOP6-PROVEN-PR-PLAN.md A4 with a thin wrapper so we test the integrated
# behavior the integrator will wire, not a guard the lib never had.
# -----------------------------------------------------------------------------
maybe_render() {
    # Mirrors A4: render by default; LOKI_PROVEN_PR=0 -> renderer not invoked at
    # any site, body bytes are byte-identical to today (no receipt block).
    if [ "${LOKI_PROVEN_PR:-}" = "0" ]; then
        return 0
    fi
    render_evidence_receipt_md "$@"
}

# =============================================================================
# T1 -- NO green PR body unless VERIFIED.
# Render a VERIFIED WITH GAPS fixture and a NOT VERIFIED fixture; assert NO
# standalone "Headline: VERIFIED" line AND the degraded items ARE listed.
# Plus a POSITIVE CONTROL: a real VERIFIED fixture DOES carry the anchored line
# (so the anchored matcher is proven non-vacuous).
# =============================================================================
echo "T1 -- no green headline unless VERIFIED (anchored full-line match)"

VERIFIED_PROOF="$WORKROOT/verified.json"
GAPS_PROOF="$WORKROOT/gaps.json"
NOTV_PROOF="$WORKROOT/notverified.json"
write_verified_proof "$VERIFIED_PROOF"
write_gaps_proof "$GAPS_PROOF"
write_notverified_proof "$NOTV_PROOF"

# Positive control: VERIFIED fixture, empty expected head -> green line present.
verified_body="$(render_evidence_receipt_md "$VERIFIED_PROOF" "" "")"
if printf '%s\n' "$verified_body" | grep -qx 'Headline: VERIFIED'; then
    pass "T1 positive control: VERIFIED fixture renders the anchored 'Headline: VERIFIED' line"
else
    fail "T1 positive control: VERIFIED fixture did NOT render 'Headline: VERIFIED'" \
        "matcher would be vacuously true; body: $verified_body"
fi

# GAPS body: no green line; gap item listed.
gaps_body="$(render_evidence_receipt_md "$GAPS_PROOF" "" "")"
if printf '%s\n' "$gaps_body" | grep -qx 'Headline: VERIFIED'; then
    fail "T1 gaps: anchored 'Headline: VERIFIED' line wrongly present on a GAPS body" \
        "body: $gaps_body"
else
    if printf '%s\n' "$gaps_body" | grep -q 'no build command recorded'; then
        pass "T1 gaps: no green line, and the degraded item IS listed"
    else
        fail "T1 gaps: degraded item not listed in body" "body: $gaps_body"
    fi
fi
# Sanity: GAPS body must still carry its own honest amber label.
if printf '%s\n' "$gaps_body" | grep -qx 'Headline: VERIFIED WITH GAPS'; then
    pass "T1 gaps: honest 'Headline: VERIFIED WITH GAPS' label present"
else
    fail "T1 gaps: amber headline label missing" "body: $gaps_body"
fi

# NOT VERIFIED body: no green line; gap item listed.
notv_body="$(render_evidence_receipt_md "$NOTV_PROOF" "" "")"
if printf '%s\n' "$notv_body" | grep -qx 'Headline: VERIFIED'; then
    fail "T1 not-verified: anchored 'Headline: VERIFIED' line wrongly present" \
        "body: $notv_body"
else
    if printf '%s\n' "$notv_body" | grep -q '1 test failed'; then
        pass "T1 not-verified: no green line, and the degraded item IS listed"
    else
        fail "T1 not-verified: degraded item not listed in body" "body: $notv_body"
    fi
fi

# Anti-trap proof: the footnote DOES contain the substring "VERIFIED", so a
# naive substring search would false-positive. Demonstrate that the naive check
# would be wrong while the anchored check is right.
if printf '%s\n' "$notv_body" | grep -q 'VERIFIED'; then
    pass "T1 anti-trap: a naive substring grep finds 'VERIFIED' (footnote) on a red body -- anchored match is the correct gate"
else
    fail "T1 anti-trap: footnote substring 'VERIFIED' missing" \
        "fixture/lib drift; body: $notv_body"
fi
echo ""

# =============================================================================
# T5 -- byte-identical no-op under LOKI_PROVEN_PR=0.
# With the gate off, the renderer is NOT invoked at any site, so the body is the
# LEGACY body (no receipt block). We model the legacy body as a fixed golden PR
# body and assert: (a) maybe_render under LOKI_PROVEN_PR=0 emits zero bytes, and
# (b) legacy_body + (gate-off render) is byte-identical to legacy_body alone.
# =============================================================================
echo "T5 -- byte-identical no-op under LOKI_PROVEN_PR=0"

LEGACY_BODY="Implemented the feature.

- Added foo
- Fixed bar"

golden_off="$WORKROOT/golden-off.txt"
actual_off="$WORKROOT/actual-off.txt"

# Golden: the legacy body with the feature OFF == legacy body, nothing appended.
printf '%s\n' "$LEGACY_BODY" > "$golden_off"

# Actual: legacy body then the gate-off render appended.
{
    printf '%s\n' "$LEGACY_BODY"
    LOKI_PROVEN_PR=0 maybe_render "$VERIFIED_PROOF" "" ""
} > "$actual_off"

if cmp -s "$golden_off" "$actual_off"; then
    pass "T5 gate off: PR body is byte-identical to legacy (no receipt block appended)"
else
    fail "T5 gate off: body differs from legacy under LOKI_PROVEN_PR=0" \
        "diff: $(diff "$golden_off" "$actual_off" 2>&1 | head -20)"
fi

# Non-vacuity: with the gate ON (default), the render DOES add bytes -- proving
# T5's no-op is a real suppression, not a renderer that always emits nothing.
golden_on="$WORKROOT/golden-on.txt"
{
    printf '%s\n' "$LEGACY_BODY"
    maybe_render "$VERIFIED_PROOF" "" ""
} > "$golden_on"
if cmp -s "$golden_off" "$golden_on"; then
    fail "T5 non-vacuity: gate-on body equals gate-off body" \
        "renderer emitted nothing even when enabled; suppression test is vacuous"
else
    pass "T5 non-vacuity: gate-on body differs (receipt block added), so the no-op is a real suppression"
fi
echo ""

# =============================================================================
# T6 -- determinism: the rendered verify-yourself <run_id> equals THIS proof's
# facts.meta.run_id (not mtime-latest). Seed two proofs (different run_ids,
# different mtimes) and assert the rendered body references the run_id of the
# proof we PASSED, not the newest file on disk.
# Plus R-DET-2: a head-sha mismatch on a VERIFIED proof does NOT render the
# anchored green line.
# =============================================================================
echo "T6 -- determinism (run_id from facts.meta.run_id) + R-DET-2 head mismatch"

# Seed an OLDER proof then a NEWER proof with distinct run_ids.
OLD_PROOF="$WORKROOT/old.json"
NEW_PROOF="$WORKROOT/new.json"
cat > "$OLD_PROOF" <<'JSON'
{
  "run_id": "run-OLD-aaaa",
  "honesty": { "headline": "VERIFIED", "degraded": [] },
  "facts": {
    "git": { "base_sha": "obase", "head_sha": "ohead", "diff_sha256": "oooo", "diff": { "count": 1 } },
    "tests": { "status": "verified", "command": "t", "exit_code": 0 },
    "build": { "status": "verified", "command": "b" },
    "security": { "ran": false, "high_active": 0, "status": "not_run" },
    "cost": { "usd": 0.01 },
    "meta": { "run_id": "run-OLD-aaaa" }
  }
}
JSON
# Make NEW strictly newer on disk so an mtime-latest bug would pick it.
sleep 1
cat > "$NEW_PROOF" <<'JSON'
{
  "run_id": "run-NEW-bbbb",
  "honesty": { "headline": "VERIFIED", "degraded": [] },
  "facts": {
    "git": { "base_sha": "nbase", "head_sha": "nhead", "diff_sha256": "nnnn", "diff": { "count": 1 } },
    "tests": { "status": "verified", "command": "t", "exit_code": 0 },
    "build": { "status": "verified", "command": "b" },
    "security": { "ran": false, "high_active": 0, "status": "not_run" },
    "cost": { "usd": 0.02 },
    "meta": { "run_id": "run-NEW-bbbb" }
  }
}
JSON

# Render THIS run = the OLDER proof. Its run_id must appear; the newer (latest by
# mtime) run_id must NOT, proving the renderer keys off the proof it was given,
# never the newest file.
old_body="$(render_evidence_receipt_md "$OLD_PROOF" "" "")"
if printf '%s\n' "$old_body" | grep -q 'loki proof verify run-OLD-aaaa'; then
    if printf '%s\n' "$old_body" | grep -q 'run-NEW-bbbb'; then
        fail "T6 determinism: body referenced the mtime-latest run_id (run-NEW-bbbb)" \
            "renderer is mtime-latest, not proof-keyed; body: $old_body"
    else
        pass "T6 determinism: verify-yourself references THIS proof's run_id (run-OLD-aaaa), not the mtime-latest one"
    fi
else
    fail "T6 determinism: this proof's run_id (run-OLD-aaaa) not referenced" "body: $old_body"
fi

# R-DET-2: VERIFIED proof + a non-empty MISMATCHING expected_head_sha -> the
# anchored green line MUST be absent (degrade to an honest mismatch line).
mismatch_body="$(render_evidence_receipt_md "$VERIFIED_PROOF" "totally-different-head" "")"
if printf '%s\n' "$mismatch_body" | grep -qx 'Headline: VERIFIED'; then
    fail "T6 R-DET-2: green 'Headline: VERIFIED' line rendered despite head-sha mismatch" \
        "stale/wrong-run proof rendered fake-green; body: $mismatch_body"
else
    if printf '%s\n' "$mismatch_body" | grep -q 'does not match this branch head'; then
        pass "T6 R-DET-2: head-sha mismatch suppresses the green line and prints the honest mismatch line"
    else
        fail "T6 R-DET-2: no green line BUT no honest mismatch line either" "body: $mismatch_body"
    fi
fi

# Non-vacuity for R-DET-2: a MATCHING head sha DOES render the green line.
match_body="$(render_evidence_receipt_md "$VERIFIED_PROOF" "headbbbb2222" "")"
if printf '%s\n' "$match_body" | grep -qx 'Headline: VERIFIED'; then
    pass "T6 R-DET-2 non-vacuity: a MATCHING expected head sha renders the green line (cross-check is real, not always-suppress)"
else
    fail "T6 R-DET-2 non-vacuity: matching head sha failed to render green line" \
        "cross-check suppresses unconditionally; body: $match_body"
fi
echo ""

# =============================================================================
# T7 -- missing proof: no proof.json -> the body renders the single honest
# "Evidence Receipt: unavailable for this run." line and the function returns 0
# (no crash, never blocks PR creation).
# =============================================================================
echo "T7 -- missing proof renders the honest unavailable line and returns 0"

MISSING="$WORKROOT/does-not-exist.json"
rm -f "$MISSING"
missing_out="$WORKROOT/missing-out.txt"
render_evidence_receipt_md "$MISSING" "" "" > "$missing_out"
rc=$?
if [ "$rc" -eq 0 ]; then
    expected_line="Evidence Receipt: unavailable for this run."
    if [ "$(cat "$missing_out")" = "$expected_line" ]; then
        pass "T7 missing proof: exactly the single honest unavailable line, rc=0"
    else
        fail "T7 missing proof: output was not the single honest line" \
            "got: $(cat "$missing_out")"
    fi
else
    fail "T7 missing proof: function returned non-zero ($rc) -- could block PR creation"
fi

# Also: a malformed (non-JSON) proof must degrade the same honest way.
BADJSON="$WORKROOT/bad.json"
printf '%s\n' "this is not json {{{" > "$BADJSON"
bad_out="$(render_evidence_receipt_md "$BADJSON" "" "")"
bad_rc=$?
if [ "$bad_rc" -eq 0 ] && [ "$bad_out" = "Evidence Receipt: unavailable for this run." ]; then
    pass "T7 malformed proof: degrades to the single honest unavailable line, rc=0"
else
    fail "T7 malformed proof: did not degrade honestly" "rc=$bad_rc out=$bad_out"
fi
echo ""

# =============================================================================
# T9 -- redaction: the renderer only ECHOES fields from the already-redacted
# proof.json. A proof whose values are already redacted renders those redacted
# values; the renderer cannot introduce a raw-secret-shaped string of its own.
# We seed a proof with a placeholder REDACTED marker in a value field and assert
# (a) the redacted marker appears in the body and (b) no token-shaped raw secret
# that we never put in the proof appears in the body.
# =============================================================================
echo "T9 -- renderer echoes already-redacted values, introduces no raw secret"

REDACTED_PROOF="$WORKROOT/redacted.json"
# diff_sha256 carries a clearly-redacted placeholder; the renderer prints it
# verbatim. There is NO raw secret anywhere in this fixture.
cat > "$REDACTED_PROOF" <<'JSON'
{
  "run_id": "run-redact-0009",
  "honesty": { "headline": "VERIFIED", "degraded": [] },
  "facts": {
    "git": {
      "base_sha": "[REDACTED-BASE]",
      "head_sha": "[REDACTED-HEAD]",
      "diff_sha256": "[REDACTED]",
      "diff": { "count": 1 }
    },
    "tests": { "status": "verified", "command": "npm test", "exit_code": 0 },
    "build": { "status": "verified", "command": "npm run build" },
    "security": { "ran": true, "high_active": 0, "status": "clean" },
    "cost": { "usd": 0.01 },
    "meta": { "run_id": "run-redact-0009" }
  }
}
JSON

redact_body="$(render_evidence_receipt_md "$REDACTED_PROOF" "" "")"
if printf '%s\n' "$redact_body" | grep -q '\[REDACTED\]'; then
    pass "T9 redaction: the already-redacted value ([REDACTED]) is echoed into the body verbatim"
else
    fail "T9 redaction: redacted value not present in body" "body: $redact_body"
fi

# The renderer must not invent a secret. A token-shaped string we never put in
# the proof (e.g. an AWS-key-shaped token or 'sk-' token) must be absent.
# Since our fixture contains no such token, finding one would mean the renderer
# fabricated/leaked it. Assert absence of common secret shapes.
if printf '%s\n' "$redact_body" | grep -Eq 'AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}'; then
    fail "T9 redaction: a raw-secret-shaped token appears in the body the renderer produced" \
        "renderer introduced a secret not present in the proof; body: $redact_body"
else
    pass "T9 redaction: no raw-secret-shaped token introduced by the renderer (it only echoes proof fields)"
fi
echo ""

echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
