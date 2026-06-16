#!/usr/bin/env bash
# Tests for tests/detect-invariant-violations.sh (spec-independent invariants).
# Verifies the detector:
#   1. A file with a hardcoded secret (AWS key) -> flagged CRITICAL.
#   2. A private-key PEM block -> flagged CRITICAL.
#   3. An email literal in a log statement -> flagged HIGH.
#   4. A clean source file -> NOT flagged (no CRITICAL/HIGH).
#   5. A placeholder secret (AWS's own EXAMPLE key, your-api-key-here) -> NOT
#      flagged (true negative, conservative; not just a blank clean file).
#   6. --strict exit-code contract: exit 1 on CRITICAL/HIGH, exit 0 when clean.
#   7. LOKI_SCAN_DIR redirect: the detector scans the target dir, not its repo.
#
# Mock / local only. No network, no paid calls. Uses an isolated temp dir.
#
# NOTE on fixture realism: the "flagged" fixtures use realistic credential
# shapes that deliberately do NOT hit the placeholder allowlist, and the email
# fixture uses a real-looking domain (acme.com, not example.com). Otherwise the
# test would pass/fail for the wrong reason.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="$SCRIPT_DIR/detect-invariant-violations.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-invariant-test-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
no() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# --- Fixture A: hardcoded AWS access key (realistic, NOT the EXAMPLE key) -----
mkdir -p "$WORK/secret"
cat > "$WORK/secret/config.js" <<'EOF'
const aws = {
  region: "us-east-1",
  accessKeyId: "AKIA2J4K7LMNPQ6RSTUV",
  service: "s3",
};
module.exports = aws;
EOF

# --- Fixture B: private-key PEM block ----------------------------------------
mkdir -p "$WORK/pem"
cat > "$WORK/pem/key.js" <<'EOF'
const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefg
-----END RSA PRIVATE KEY-----`;
EOF

# --- Fixture C: email literal logged (real-looking domain) -------------------
mkdir -p "$WORK/pii"
cat > "$WORK/pii/handler.js" <<'EOF'
function onLogin(user) {
  console.log("user logged in: john.doe@acme.com");
  return true;
}
EOF

# --- Fixture D: clean source (no secrets, no logged PII) ---------------------
mkdir -p "$WORK/clean"
cat > "$WORK/clean/app.js" <<'EOF'
function add(a, b) {
  return a + b;
}
const apiKey = process.env.API_KEY;
console.log("service started on port", 3000);
module.exports = { add };
EOF

# --- Fixture E: placeholder secrets (must NOT be flagged) --------------------
mkdir -p "$WORK/placeholder"
cat > "$WORK/placeholder/config.js" <<'EOF'
const aws = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  apiKey: "your-api-key-here",
  token: "sk-test-placeholder-token-value",
};
console.log("contact us at support@example.com");
module.exports = aws;
EOF

run_detector() { LOKI_SCAN_DIR="$1" bash "$DETECTOR" 2>&1; }
run_detector_strict_rc() {
    local rc=0
    LOKI_SCAN_DIR="$1" bash "$DETECTOR" --strict >/dev/null 2>&1 || rc=$?
    echo "$rc"
}

# === Test 1: AWS key fixture flagged CRITICAL ==============================
out_secret=$(run_detector "$WORK/secret")
if echo "$out_secret" | grep -q '\[CRITICAL\]'; then
    ok "AWS-key fixture: prints a [CRITICAL] token"
else
    no "AWS-key fixture: expected a [CRITICAL] token, got none"
fi
rc=$(run_detector_strict_rc "$WORK/secret")
if [ "$rc" -eq 1 ]; then
    ok "AWS-key fixture: --strict exits 1 on CRITICAL"
else
    no "AWS-key fixture: --strict expected exit 1, got $rc"
fi

# === Test 2: PEM private key flagged CRITICAL ==============================
out_pem=$(run_detector "$WORK/pem")
if echo "$out_pem" | grep -q '\[CRITICAL\]'; then
    ok "PEM fixture: private-key block flagged CRITICAL"
else
    no "PEM fixture: expected a [CRITICAL] token, got none"
fi

# === Test 3: email-in-log flagged HIGH ====================================
out_pii=$(run_detector "$WORK/pii")
if echo "$out_pii" | grep -q '\[HIGH\]'; then
    ok "PII fixture: email-in-log flagged HIGH"
else
    no "PII fixture: expected a [HIGH] token, got none"
fi
rc=$(run_detector_strict_rc "$WORK/pii")
if [ "$rc" -eq 1 ]; then
    ok "PII fixture: --strict exits 1 on HIGH"
else
    no "PII fixture: --strict expected exit 1, got $rc"
fi

# === Test 4: clean fixture NOT flagged ====================================
out_clean=$(run_detector "$WORK/clean")
if echo "$out_clean" | grep -qE '\[(CRITICAL|HIGH)\]'; then
    no "clean fixture: false positive -- got a CRITICAL/HIGH finding"
    echo "$out_clean" | grep -E '\[(CRITICAL|HIGH)\]'
else
    ok "clean fixture: no false-positive CRITICAL/HIGH (env-var apiKey stays clean)"
fi
rc=$(run_detector_strict_rc "$WORK/clean")
if [ "$rc" -eq 0 ]; then
    ok "clean fixture: --strict exits 0 (clean)"
else
    no "clean fixture: --strict expected exit 0, got $rc"
fi

# === Test 5: placeholder secrets NOT flagged ==============================
out_ph=$(run_detector "$WORK/placeholder")
if echo "$out_ph" | grep -qE '\[(CRITICAL|HIGH)\]'; then
    no "placeholder fixture: false positive -- AWS EXAMPLE key / your-api-key flagged"
    echo "$out_ph" | grep -E '\[(CRITICAL|HIGH)\]'
else
    ok "placeholder fixture: AWS EXAMPLE key + your-api-key-here + example.com stay clean"
fi
rc=$(run_detector_strict_rc "$WORK/placeholder")
if [ "$rc" -eq 0 ]; then
    ok "placeholder fixture: --strict exits 0 (placeholders do not block)"
else
    no "placeholder fixture: --strict expected exit 0, got $rc"
fi

# === Test 6: LOKI_SCAN_DIR redirect honored ===============================
out_redirect=$(cd / && LOKI_SCAN_DIR="$WORK/secret" bash "$DETECTOR" 2>&1)
if echo "$out_redirect" | grep -q "config.js"; then
    ok "LOKI_SCAN_DIR redirect: scans the target dir regardless of cwd"
else
    no "LOKI_SCAN_DIR redirect: did not scan target dir (no config.js in output)"
fi
out_redirect_clean=$(cd / && LOKI_SCAN_DIR="$WORK/clean" bash "$DETECTOR" 2>&1)
if echo "$out_redirect_clean" | grep -qE '\[(CRITICAL|HIGH)\]'; then
    no "LOKI_SCAN_DIR redirect: clean target unexpectedly flagged HIGH/CRITICAL"
else
    ok "LOKI_SCAN_DIR redirect: clean target stays clean"
fi

# === Test 7: test files are NOT the scan surface ==========================
# Test files in ANY ecosystem convention with a secret must be ignored (this
# detector scans SOURCE; test fixtures legitimately embed fake credentials).
mkdir -p "$WORK/testsurface"
cat > "$WORK/testsurface/leak.test.js" <<'EOF'
const aws = { accessKeyId: "AKIA2J4K7LMNPQ6RSTUV" };
EOF
cat > "$WORK/testsurface/test_redaction.py" <<'EOF'
def test_redact():
    secret = "AKIA2J4K7LMNPQ6RSTUV"
    assert redact(secret) == "***"
EOF
mkdir -p "$WORK/testsurface/tests"
cat > "$WORK/testsurface/tests/fixture.go" <<'EOF'
package tests
var awsKey = "AKIA2J4K7LMNPQ6RSTUV"
EOF
out_ts=$(run_detector "$WORK/testsurface")
if echo "$out_ts" | grep -qE '\[(CRITICAL|HIGH)\]'; then
    no "test-surface: a test file was scanned (should be skipped: *.test.js / test_*.py / tests/ dir)"
    echo "$out_ts" | grep -E '\[(CRITICAL|HIGH)\]'
else
    ok "test-surface: *.test.js + test_*.py + tests/ dir all skipped (source-only surface honored)"
fi

# --- Summary ----------------------------------------------------------------
echo ""
echo "=========================================="
echo "Results: $((PASS + FAIL)) test(s) -- $PASS passed, $FAIL failed"
echo "=========================================="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
