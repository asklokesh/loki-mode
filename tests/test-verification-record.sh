#!/usr/bin/env bash
# LM-005: the verification record keeps integrity, execution validity and
# requirement coverage apart, and a passing label is never a bare pass when a
# check did not run. The fixtures live in tests/test_verification_record.py
# (all passed, one failed, skipped, stale revision, incomplete, modified test,
# requirements map present/absent, tampered record). This wrapper runs them
# under the shell runner and pins the contract doc.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: verification record (LM-005)"

if out="$(timeout -k 10 240 python3 -m pytest -q -p no:cacheprovider \
    "$SCRIPT_DIR/test_verification_record.py" 2>&1)"; then
    ok "fixture suite: $(printf '%s\n' "$out" | tail -n 1)"
else
    bad "fixture suite failed"
    printf '%s\n' "$out" | tail -n 40
fi

DOC="$REPO_ROOT/docs/contracts/verification.md"
if [ -f "$DOC" ]; then
    ok "contract doc exists"
    for needle in "integrity" "execution validity" "requirement coverage" \
        "signature alone"; do
        if grep -qi -- "$needle" "$DOC"; then
            ok "contract doc covers: $needle"
        else
            bad "contract doc missing: $needle"
        fi
    done
else
    bad "docs/contracts/verification.md is missing"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
