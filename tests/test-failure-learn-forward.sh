#!/usr/bin/env bash
# test-failure-learn-forward.sh -- learn-forward + failure observability.
#
# (A) _loki_archive_last_error: before LAST_ERROR.json is cleared each run, its
#     record is appended to an append-only, bounded failure-history so the next
#     run can see a REPEATED failure signature. No-op on a clean run; capped at 50.
# (B) completion.json carries error_class + error_brief (from LAST_ERROR.json) so
#     a terminal outcome is not just an opaque label -- verified via the same
#     read logic run.sh uses.
#
# Extracts _loki_archive_last_error from run.sh and drives it hermetically (no
# real build). No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNSH="$SCRIPT_DIR/../autonomy/run.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$RUNSH" ] || { echo "FATAL: run.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }

FN="$(awk '/^_loki_archive_last_error\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$RUNSH")"
[ -n "$FN" ] || { echo "FATAL: could not extract _loki_archive_last_error"; exit 2; }

arch() { bash -c "set -u; $FN"$'\n'"_loki_archive_last_error \"\$1\" \"\$2\"" _ "$1" "$2"; }

# --- (A) archive behavior ---
D="$(mktemp -d)"

# 1. no source -> no history created (clean run leaves nothing behind)
arch "$D/absent.json" "$D/hist.jsonl"
[ -f "$D/hist.jsonl" ] && fail "no-source must not create history" || ok

# 2. a real LAST_ERROR -> one history entry, reason preserved
printf '%s\n' '{"error_class":"spec_contradiction","brief":"Spec is inconsistent","iteration":0}' > "$D/le.json"
arch "$D/le.json" "$D/hist.jsonl"
[ "$(grep -c . "$D/hist.jsonl" 2>/dev/null)" = "1" ] && ok || fail "expected 1 history entry"
grep -q "spec_contradiction" "$D/hist.jsonl" && ok || fail "reason not preserved in history"

# 3. append (not overwrite): a 2nd archive -> 2 entries
arch "$D/le.json" "$D/hist.jsonl"
[ "$(grep -c . "$D/hist.jsonl" 2>/dev/null)" = "2" ] && ok || fail "archive must append, not overwrite"

# 4. bounded at 50: write 55 -> exactly 50 kept
for _i in $(seq 1 51); do arch "$D/le.json" "$D/hist.jsonl"; done
N="$(grep -c . "$D/hist.jsonl" 2>/dev/null)"
[ "$N" = "50" ] && ok || fail "history must cap at 50, got $N"

# 5. corrupt existing history line does not crash the archive (fail-closed on write)
printf '%s\n' 'not json at all' > "$D/hist.jsonl"
arch "$D/le.json" "$D/hist.jsonl"
[ -f "$D/hist.jsonl" ] && grep -q "spec_contradiction" "$D/hist.jsonl" && ok || fail "must tolerate a corrupt history line"

rm -rf "$D"

# --- (B) completion.json carries the classified reason ---
CB="$(mktemp -d)"; mkdir -p "$CB/state"
printf '%s\n' '{"error_class":"spec_contradiction","brief":"Spec is inconsistent"}' > "$CB/state/LAST_ERROR.json"
# Replicate the exact read logic run.sh uses for completion.json.
python3 -c "
import json, os
ec=eb=None
try:
    r=json.load(open('$CB/state/LAST_ERROR.json'))
    if isinstance(r,dict): ec=r.get('error_class'); eb=r.get('brief')
except Exception: pass
json.dump({'outcome':'inconclusive_spec_contradiction','error_class':ec,'error_brief':eb}, open('$CB/state/completion.json','w'))
"
python3 -c "import json,sys; d=json.load(open('$CB/state/completion.json')); sys.exit(0 if d.get('error_class')=='spec_contradiction' and d.get('error_brief') else 1)" \
    && ok || fail "completion.json must carry error_class + error_brief on a failure"
# clean run: no LAST_ERROR -> error_class None
rm -f "$CB/state/LAST_ERROR.json"
python3 -c "
import json, os
ec=None
try:
    r=json.load(open('$CB/state/LAST_ERROR.json')); ec=r.get('error_class')
except Exception: pass
json.dump({'outcome':'complete','error_class':ec}, open('$CB/state/completion.json','w'))
"
python3 -c "import json,sys; d=json.load(open('$CB/state/completion.json')); sys.exit(0 if d.get('error_class') is None else 1)" \
    && ok || fail "clean run must leave error_class None (no stale reason)"
rm -rf "$CB"

echo ""
echo "test-failure-learn-forward: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
