#!/usr/bin/env bash
# Regression coverage for a batch of advisor-verified CLI bugs:
#   BUG 1  --budget 0 / 0.00 must be rejected (a 0 cap pauses before any work)
#   BUG 4  loki memory retrieve must read the real result fields, not print
#          a uniform [unknown] ... (score 0.00)
#   BUG 5  loki plan --json must emit JSON (not ANSI prose) on error paths
#   BUG 8  brief-prd-*.md / quick-prd-*.md temp PRDs must be reaped when stale
#   BUG 9  loki preview --provider must not swallow the next flag as its value
#   BUG 10 loki docker --image / loki deploy --dir must not swallow the next
#          flag as their value
#
# These exercise the CLI arg-parse and helper code paths directly; none of
# them launches a real build.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

passed=0; failed=0
ok(){ echo "  [PASS] $1"; passed=$((passed+1)); }
bad(){ echo "  [FAIL] $1"; failed=$((failed+1)); }

# ---------------------------------------------------------------------------
# BUG 1: --budget 0 and --budget=0.00 rejected; positive value not rejected.
# ---------------------------------------------------------------------------
T1=$(mktemp -d)
printf '# Tiny\n## Overview\nx\n' > "$T1/prd.md"
out=$( (cd "$T1" && bash "$LOKI" start --budget 0 ./prd.md) 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'must be greater than 0'; then ok "BUG1: --budget 0 rejected"; else bad "BUG1: --budget 0 (rc=$rc)"; fi
out=$( (cd "$T1" && bash "$LOKI" start --budget=0.00 ./prd.md) 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'must be greater than 0'; then ok "BUG1: --budget=0.00 rejected"; else bad "BUG1: --budget=0.00 (rc=$rc)"; fi
# A positive budget must NOT trip the new guard. Verify the guard logic in
# isolation (the awk positivity test the CLI uses) rather than launching a real
# build: 5.00 passes, 0 and 0.00 fail.
if awk -v b=5.00 'BEGIN{exit !(b+0 > 0)}' && ! awk -v b=0 'BEGIN{exit !(b+0 > 0)}' && ! awk -v b=0.00 'BEGIN{exit !(b+0 > 0)}'; then
  ok "BUG1: positivity guard accepts 5.00, rejects 0 / 0.00"
else
  bad "BUG1: positivity guard logic"
fi
rm -rf "$T1"

# ---------------------------------------------------------------------------
# BUG 4: loki memory retrieve reads _source/_score/pattern, not the legacy
# source/summary/score (which never exist -> [unknown] 0.00 for every row).
# ---------------------------------------------------------------------------
T4=$(mktemp -d)
PYTHONPATH="$REPO_ROOT" python3 - "$T4" <<'PYSEED' 2>/dev/null
import sys, os
os.chdir(sys.argv[1])
from memory.storage import MemoryStorage
from memory.schemas import SemanticPattern
s = MemoryStorage('.loki/memory')
s.save_pattern(SemanticPattern(id='p1', pattern='Validate budget input is positive before use', category='cli', confidence=0.9))
PYSEED
if [ -d "$T4/.loki/memory" ]; then
  out=$( (cd "$T4" && LOKI_DIR=.loki bash "$LOKI" memory retrieve "budget validation") 2>&1 )
  if printf '%s' "$out" | grep -qi 'Validate budget input' && printf '%s' "$out" | grep -qi 'semantic' && ! printf '%s' "$out" | grep -q '\[unknown\]'; then
    ok "BUG4: memory retrieve shows real source/summary/score"
  else
    bad "BUG4: memory retrieve output ($out)"
  fi
else
  echo "  [SKIP] BUG4: memory module unavailable to seed"
fi
rm -rf "$T4"

# ---------------------------------------------------------------------------
# BUG 5: loki plan --json emits JSON on error paths (missing arg, missing file)
# and keeps colored prose only on the non-json path.
# ---------------------------------------------------------------------------
out=$(bash "$LOKI" plan --json 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then ok "BUG5: plan --json missing-arg -> valid JSON"; else bad "BUG5: plan --json missing-arg (rc=$rc, out=$out)"; fi
out=$(bash "$LOKI" plan /tmp/loki-no-such-prd-xyz.md --json 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("error")' 2>/dev/null; then ok "BUG5: plan --json missing-file -> valid JSON with error"; else bad "BUG5: plan --json missing-file (rc=$rc, out=$out)"; fi
# Non-json path keeps human prose (must NOT be JSON).
out=$(bash "$LOKI" plan /tmp/loki-no-such-prd-xyz.md 2>&1)
if ! printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then ok "BUG5: plan (no --json) keeps human prose"; else bad "BUG5: plan non-json leaked JSON"; fi

# ---------------------------------------------------------------------------
# BUG 8: stale brief-prd-*.md / quick-prd-*.md are reaped (>1 day old), fresh
# ones kept. We assert the exact find expression used in the CLI.
# ---------------------------------------------------------------------------
T8=$(mktemp -d); mkdir -p "$T8/.loki"
old_stamp=$(date -v-2d +%Y%m%d0000 2>/dev/null || date -d '2 days ago' +%Y%m%d0000)
touch -t "$old_stamp" "$T8/.loki/quick-prd-111.md" "$T8/.loki/brief-prd-222.md"
touch "$T8/.loki/quick-prd-999.md"
find "$T8/.loki" -maxdepth 1 -name 'quick-prd-*.md' -mtime +1 -delete 2>/dev/null || true
find "$T8/.loki" -maxdepth 1 -name 'brief-prd-*.md' -mtime +1 -delete 2>/dev/null || true
if [ ! -f "$T8/.loki/quick-prd-111.md" ] && [ ! -f "$T8/.loki/brief-prd-222.md" ] && [ -f "$T8/.loki/quick-prd-999.md" ]; then
  ok "BUG8: stale temp PRDs reaped, fresh kept"
else
  bad "BUG8: temp PRD reaping"
fi
# And confirm the CLI actually contains the reaper at both call sites.
if grep -q "name 'quick-prd-\*.md' -mtime +1 -delete" "$LOKI" && grep -q "name 'brief-prd-\*.md' -mtime +1 -delete" "$LOKI"; then
  ok "BUG8: reaper present in CLI source"
else
  bad "BUG8: reaper missing from CLI source"
fi
rm -rf "$T8"

# ---------------------------------------------------------------------------
# BUG 9: loki preview --provider must reject a missing or flag-shaped value.
# ---------------------------------------------------------------------------
out=$(bash "$LOKI" preview --provider --public 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'requires a value'; then ok "BUG9: preview --provider --public -> error (not swallowed)"; else bad "BUG9: preview --provider --public (rc=$rc)"; fi
out=$(bash "$LOKI" preview --provider 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'requires a value'; then ok "BUG9: preview --provider (no value) -> error"; else bad "BUG9: preview --provider no-value (rc=$rc)"; fi

# ---------------------------------------------------------------------------
# BUG 10: loki docker --image and loki deploy --dir must reject a flag-shaped
# value. A valid value must still be accepted.
# ---------------------------------------------------------------------------
out=$(bash "$LOKI" docker --image --dry-run 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'requires a value'; then ok "BUG10: docker --image --dry-run -> error"; else bad "BUG10: docker --image --dry-run (rc=$rc)"; fi
out=$(bash "$LOKI" deploy --dir --no-clip 2>&1); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi 'requires a directory'; then ok "BUG10: deploy --dir --no-clip -> error"; else bad "BUG10: deploy --dir --no-clip (rc=$rc)"; fi
out=$(bash "$LOKI" deploy --dir /tmp --no-clip 2>&1) || true
if ! printf '%s' "$out" | grep -qi 'requires a directory'; then ok "BUG10: deploy --dir /tmp accepted"; else bad "BUG10: deploy --dir /tmp wrongly rejected"; fi

echo ""
echo "Results: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
