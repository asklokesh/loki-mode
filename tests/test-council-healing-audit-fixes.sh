#!/usr/bin/env bash
# Regression tests for council + healing functional bugs (2026-05-28 audit):
#  D#M2: council test-failure detection counted ANY line with "error" ->
#        a passing suite mentioning "error" forced CONTINUE forever.
#  D#M5: healing failure-modes.json append used get('modes',[]) (throwaway)
#        instead of setdefault, silently dropping the record on a fresh file.
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

GREP_RE='([1-9][0-9]*[[:space:]]+(failed|errors?)|^FAILED|[[:space:]]FAILED[[:space:]]|tests? failed|assertionerror|traceback \(most recent)'

# D#M2: benign passing suite mentioning "error" must score 0 failures.
tmp=$(mktemp -d)
printf '11 passed in 0.15s\n0 errors\ntest_error_handling PASSED\nno errors found\n' > "$tmp/test-a.log"
benign=$(grep -ciE "$GREP_RE" "$tmp/test-a.log" | tr -dc '0-9'); benign=${benign:-0}
printf '3 failed, 8 passed\nAssertionError: boom\n' > "$tmp/test-b.log"
real=$(grep -ciE "$GREP_RE" "$tmp/test-b.log" | tr -dc '0-9'); real=${real:-0}
rm -rf "$tmp"
if [ "$benign" = "0" ] && [ "$real" -ge 1 ]; then
    ok "council failure-detection: passing suite w/ 'error' = 0, real failure >= 1"
else
    bad "council failure-detection wrong (benign=$benign real=$real)"
fi

# D#M2 source: the refined regex is present, the blanket one is gone.
if grep -q "assertionerror" autonomy/completion-council.sh \
   && ! grep -q 'grep -ciE "(FAIL|ERROR|failed|error:)"' autonomy/completion-council.sh; then
    ok "completion-council.sh uses the refined failure regex (blanket grep removed)"
else
    bad "completion-council.sh still uses the blanket failure grep"
fi

# D#M5: setdefault records on a fresh failure-modes.json.
tmp=$(mktemp -d)
f="$tmp/failure-modes.json"
echo '{}' > "$f"
python3 -c "
import json, sys
with open(sys.argv[1]) as fh: data = json.load(fh)
data.setdefault('modes', []).append({'mode_id':'x'})
with open(sys.argv[1],'w') as fh: json.dump(data, fh)
" "$f"
got=$(python3 -c "import json;print(len(json.load(open('$f')).get('modes',[])))")
rm -rf "$tmp"
[ "$got" = "1" ] && ok "healing failure-mode recorded on fresh file (setdefault)" || bad "setdefault append lost (got=$got)"

# D#M5 source: setdefault present, throwaway get gone.
if grep -q "data.setdefault('modes', \[\]).append" autonomy/hooks/migration-hooks.sh \
   && ! grep -q "data.get('modes', \[\]).append" autonomy/hooks/migration-hooks.sh; then
    ok "migration-hooks.sh uses setdefault('modes')"
else
    bad "migration-hooks.sh still uses get('modes') throwaway append"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
