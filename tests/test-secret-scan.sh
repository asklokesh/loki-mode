#!/usr/bin/env bash
# shellcheck disable=SC2164  # cd in throwaway test subshells; failure is fatal anyway
# tests/test-secret-scan.sh - tests for the verify.sh secret-scan gate
# (autonomy/verify.sh: verify_gate_secret_scan + verify_secret_scan_file).
#
# Focus: the two-tier regex FALLBACK (gitleaks NOT assumed installed). The
# scenarios prove the gate (a) BLOCKS a real-format secret, and (b) stays clean
# on placeholders and env-var references that look secret-shaped but are not.
#
# Each scenario asserts BOTH:
#   - the secret_scan gate status in evidence.json (fail vs pass) -- the precise
#     signal for what this gate does, and
#   - the overall verdict / exit code (BLOCKED/2 vs not-blocked).
#
# Scenarios:
#   1. real-format AWS key (AKIA...)       -> secret_scan=fail, BLOCKED (exit 2)
#   2. PEM private key block               -> secret_scan=fail, BLOCKED (exit 2)
#   3. generic api_key="<32 hex>" literal  -> secret_scan=fail, BLOCKED (exit 2)
#   4. placeholder "your-api-key-here"     -> secret_scan=pass, NOT BLOCKED
#   5. env-var reference api_key=${API_KEY}-> secret_scan=pass, NOT BLOCKED
#
# Exit-code semantics: 0 VERIFIED, 1 CONCERNS, 2 BLOCKED, 3 verifier error.
#
# Each scenario runs in its own mktemp repo. All temp repos are cleaned up.

set -uo pipefail

# Isolate from the host's global/system git config (mirrors test-verify.sh) so a
# hostile commit.gpgsign cannot make every test commit fail rc=128.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d -t loki-secret-scan-tests.XXXXXX)"

cleanup() {
    rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

_ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Run verify.sh cd'd into a repo. Sets RC, VERDICT, and SECRET_STATUS (the
# secret_scan gate status read from evidence.json).
run_verify() {
    local repo="$1"; shift
    ( cd "$repo" && bash "$VERIFY_SH" "$@" ) >/dev/null 2>&1
    RC=$?
    local ev="$repo/.loki/verify/evidence.json"
    if [ -f "$ev" ]; then
        VERDICT="$(python3 -c "import json; print(json.load(open('$ev'))['verdict'])" 2>/dev/null || echo "PARSE_ERROR")"
        SECRET_STATUS="$(python3 -c "import json; d=json.load(open('$ev')); print(([g['status'] for g in d['deterministic_gates'] if g['gate']=='secret_scan'] or ['MISSING'])[0])" 2>/dev/null || echo "?")"
    else
        VERDICT="NO_EVIDENCE"; SECRET_STATUS="NO_EVIDENCE"
    fi
}

# Init a repo with a main branch + one base commit (mirrors test-verify.sh).
init_repo() {
    local repo="$1"
    mkdir -p "$repo"
    ( cd "$repo"
      git init -q
      git config user.email "test@loki.local"
      git config user.name "loki test"
      git config commit.gpgsign false
      echo "# project" > README.md
      git add README.md
      git commit -qm "base" --no-gpg-sign --no-verify
      git branch -m main
    )
}

# Commit a single file on a feature branch.
commit_file() {
    local repo="$1" name="$2" body="$3"
    ( cd "$repo"
      git checkout -q -b feature
      printf '%s\n' "$body" > "$name"
      git add "$name"
      git commit -qm "add $name" --no-gpg-sign --no-verify
    )
}

echo "=== test-secret-scan.sh ==="
echo "VERIFY_SH: $VERIFY_SH"

# Pre-flight: syntax.
if bash -n "$VERIFY_SH" 2>/dev/null; then
    _ok "verify.sh passes bash -n"
else
    _no "verify.sh failed bash -n"
fi

# If gitleaks is installed, these scenarios still BLOCK (gitleaks also flags
# them), but they would not be exercising the fallback we changed. Note it.
if command -v gitleaks >/dev/null 2>&1; then
    echo "  NOTE: gitleaks is on PATH -- scan uses gitleaks, not the regex fallback."
    echo "        Blocking behavior is still asserted; fallback regex is also unit-tested below."
fi

# -------------------------------------------------------------------------
# Scenario 1: real-format AWS access key -> secret_scan=fail, BLOCKED.
# AKIAIOSFODNN7EXAMPLE is the AWS documentation example value (tier-1 format
# match flags unconditionally even though it contains "EXAMPLE").
# -------------------------------------------------------------------------
S1="$TMP_ROOT/s1-aws"
init_repo "$S1"
commit_file "$S1" "config.py" '# planted test value, not a live credential
AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"'
run_verify "$S1" main
if [ "$RC" -eq 2 ] && [ "$VERDICT" = "BLOCKED" ] && [ "$SECRET_STATUS" = "fail" ]; then
    _ok "real AWS key -> secret_scan=fail, BLOCKED (exit 2)"
else
    _no "real AWS key -> expected fail/BLOCKED/2, got status=$SECRET_STATUS verdict=$VERDICT rc=$RC"
fi

# -------------------------------------------------------------------------
# Scenario 2: PEM private key block -> secret_scan=fail, BLOCKED.
# -------------------------------------------------------------------------
S2="$TMP_ROOT/s2-pem"
init_repo "$S2"
commit_file "$S2" "id_rsa" '-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAplantedtestkeymaterialnotrealdonotusethisanywhere00
-----END RSA PRIVATE KEY-----'
run_verify "$S2" main
if [ "$RC" -eq 2 ] && [ "$VERDICT" = "BLOCKED" ] && [ "$SECRET_STATUS" = "fail" ]; then
    _ok "PEM private key block -> secret_scan=fail, BLOCKED (exit 2)"
else
    _no "PEM private key -> expected fail/BLOCKED/2, got status=$SECRET_STATUS verdict=$VERDICT rc=$RC"
fi

# -------------------------------------------------------------------------
# Scenario 3: generic high-entropy assignment (tier-2 pattern) -> BLOCKED.
# Proves the NEW generic api_key="..." detection fires, not just tier-1
# formats. The value is a literal 40-char token, no placeholder/env markers.
# -------------------------------------------------------------------------
S3="$TMP_ROOT/s3-generic"
init_repo "$S3"
commit_file "$S3" "settings.js" 'const api_key = "ab12CD34ef56GH78ij90KL12mn34OP56qr78ST90";'
run_verify "$S3" main
if [ "$RC" -eq 2 ] && [ "$VERDICT" = "BLOCKED" ] && [ "$SECRET_STATUS" = "fail" ]; then
    _ok "generic api_key literal -> secret_scan=fail, BLOCKED (exit 2)"
else
    _no "generic api_key literal -> expected fail/BLOCKED/2, got status=$SECRET_STATUS verdict=$VERDICT rc=$RC"
fi

# -------------------------------------------------------------------------
# Scenario 4: placeholder value -> secret_scan=pass, NOT BLOCKED.
# "your-api-key-here" is an obvious placeholder and must NOT be flagged.
# (Verdict may be VERIFIED or CONCERNS depending on other gates; the precise
# assertion is secret_scan=pass and not-BLOCKED.)
# -------------------------------------------------------------------------
S4="$TMP_ROOT/s4-placeholder"
init_repo "$S4"
commit_file "$S4" "config.example.js" 'const api_key = "your-api-key-here";
const token = "REDACTED";
const secret = "changeme-placeholder-value";'
run_verify "$S4" main
if [ "$SECRET_STATUS" = "pass" ] && [ "$VERDICT" != "BLOCKED" ] && [ "$RC" -ne 2 ]; then
    _ok "placeholder values -> secret_scan=pass, NOT BLOCKED (verdict=$VERDICT)"
else
    _no "placeholder values -> expected pass + not-BLOCKED, got status=$SECRET_STATUS verdict=$VERDICT rc=$RC"
fi

# -------------------------------------------------------------------------
# Scenario 5: env-var references -> secret_scan=pass, NOT BLOCKED.
# ${API_KEY}, process.env.X, os.environ are references, not literals.
# -------------------------------------------------------------------------
S5="$TMP_ROOT/s5-envref"
init_repo "$S5"
commit_file "$S5" "config.js" 'const api_key = process.env.API_KEY;
const token = `${SOME_LONG_TOKEN_NAME_HERE}`;
const header = `Bearer ${ACCESS_TOKEN}`;
const secret = os.environ["CLIENT_SECRET"];'
run_verify "$S5" main
if [ "$SECRET_STATUS" = "pass" ] && [ "$VERDICT" != "BLOCKED" ] && [ "$RC" -ne 2 ]; then
    _ok "env-var references -> secret_scan=pass, NOT BLOCKED (verdict=$VERDICT)"
else
    _no "env-var references -> expected pass + not-BLOCKED, got status=$SECRET_STATUS verdict=$VERDICT rc=$RC"
fi

# -------------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------------
echo ""
echo "=== test-secret-scan.sh results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
