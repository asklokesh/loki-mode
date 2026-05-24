#!/usr/bin/env bash
# Test: N-01 forge.config.validate(strict=True) + `loki forge lint --strict`.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. validate(strict=True) promotes warnings to errors
if run_py "
from forge.config import validate
r = validate({'extra_key': 'x'}, strict=True)
assert any('unknown top-level' in e for e in r['errors']), r
assert r['warnings'] == [], r
assert r.get('strict') is True
print('OK')" | grep -q '^OK$'; then pass "N-01 strict promotes warnings"; else fail "strict mode broken"; fi

# 2. strict=False keeps the existing split
if run_py "
from forge.config import validate
r = validate({'extra_key': 'x'})
assert any('unknown top-level' in w for w in r['warnings']), r
assert r['errors'] == [], r
print('OK')" | grep -q '^OK$'; then pass "N-01 non-strict default unchanged"; else fail "default mode regressed"; fi

# 3. strict with no warnings -> empty errors
if run_py "
from forge.config import validate
r = validate({'schema_version': 1, 'tables': [{'name':'users','columns':['id pk']}]}, strict=True)
assert r['errors'] == [], r
print('OK')" | grep -q '^OK$'; then pass "N-01 strict clean spec"; else fail "false positive on clean spec"; fi

# 4. `loki forge lint --strict` exits 2 when warnings present
tmp=$(mktemp -d)
cat > "$tmp/forge.yaml" <<'YAML'
extra_unknown_key: value
tables:
  - name: users
    columns:
      - id pk
YAML
set +e
(cd "$tmp" && "$ROOT/bin/loki" forge lint --strict) > "$tmp/out.txt" 2>&1
exit_code=$?
set -e
if [[ "$exit_code" == "2" ]] && grep -q '"strict": true' "$tmp/out.txt"; then
    pass "N-01 lint --strict exits 2 + JSON flag set"
else
    fail "lint --strict wrong exit ($exit_code) or missing strict flag"
fi
rm -rf "$tmp"

# 5. `loki forge lint` (no --strict) exits 0 on the same spec
tmp=$(mktemp -d)
cat > "$tmp/forge.yaml" <<'YAML'
extra_unknown_key: value
tables:
  - name: users
    columns:
      - id pk
YAML
set +e
(cd "$tmp" && "$ROOT/bin/loki" forge lint) > "$tmp/out.txt" 2>&1
exit_code=$?
set -e
if [[ "$exit_code" == "0" ]] && grep -q '"strict": false' "$tmp/out.txt"; then
    pass "N-01 lint default exits 0 + strict=false in JSON"
else
    fail "lint default unexpected exit ($exit_code)"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
