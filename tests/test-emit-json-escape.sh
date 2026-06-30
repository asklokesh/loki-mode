#!/usr/bin/env bash
# Regression: events/emit.sh json_escape must produce valid JSON even when a
# payload value contains raw C0 control bytes. The final awk pass escapes every
# byte in 0x01-0x1F to its \uXXXX form, so consumers (dashboard _read_events,
# learning aggregator) never silently drop the line on JSONDecodeError.
#
# Wave-5 additions:
#   - Case 4/5: backspace (0x08) and form-feed (0x0C) explicitly. The sed pass
#     previously carried two malformed empty-pattern entries (s//\b/g; s//\f/g)
#     that were dead no-ops; they were removed and the awk pass handles bs/ff.
#     These cases prove bs/ff still round-trip to valid JSON after the removal.
#   - Case 6: atomic write leaves no `.tmp` partial in the pending dir.
set -uo pipefail
EMIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/events/emit.sh"
passed=0; failed=0
ok(){ echo "  [PASS] $1"; passed=$((passed+1)); }
bad(){ echo "  [FAIL] $1"; failed=$((failed+1)); }

# Case 1: a value with raw C0 control bytes -> events.jsonl line is valid JSON
T1=$(mktemp -d)
( cd "$T1" && LOKI_DIR=.loki bash "$EMIT" state cli testaction \
    "key=$(printf 'has\x01ctrl\x02chars')" ) >/dev/null 2>&1
if python3 - "$T1/.loki/events.jsonl" <<'PY'
import json, sys
ok = True
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)            # raises if invalid
        # round-trips back to the original control bytes (escaped, not dropped)
        assert d['data']['key'] == 'has\x01ctrl\x02chars', repr(d['data']['key'])
sys.exit(0 if ok else 1)
PY
then ok "control chars -> valid JSON, value preserved"; else bad "control-char escaping"; fi
rm -rf "$T1"

# Case 2: the per-event pending file is also valid JSON (same json_escape path)
T2=$(mktemp -d)
( cd "$T2" && LOKI_DIR=.loki bash "$EMIT" state cli testaction \
    "key=$(printf 'x\x1bnoise')" ) >/dev/null 2>&1
if python3 - "$T2/.loki/events/pending" <<'PY'
import json, os, sys
d = sys.argv[1]
for fn in os.listdir(d):
    with open(os.path.join(d, fn)) as f:
        json.load(f)                    # raises if invalid
sys.exit(0)
PY
then ok "pending file -> valid JSON"; else bad "pending-file escaping"; fi
rm -rf "$T2"

# Case 3: UTF-8 multibyte content must NOT be mangled by the escape pass
T3=$(mktemp -d)
( cd "$T3" && LOKI_DIR=.loki bash "$EMIT" state cli testaction \
    "key=cafe-日本語" ) >/dev/null 2>&1
if python3 - "$T3/.loki/events.jsonl" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        assert d['data']['key'] == 'cafe-日本語', repr(d['data']['key'])
sys.exit(0)
PY
then ok "UTF-8 multibyte preserved"; else bad "UTF-8 regression"; fi
rm -rf "$T3"

# Case 4: backspace (0x08) -> valid JSON, value preserved byte-for-byte.
T4=$(mktemp -d)
( cd "$T4" && LOKI_DIR=.loki bash "$EMIT" state cli testaction \
    "key=$(printf 'a\x08b')" ) >/dev/null 2>&1
if python3 - "$T4/.loki/events.jsonl" "$T4/.loki/events/pending" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        assert d['data']['key'] == 'a\x08b', repr(d['data']['key'])
pend = sys.argv[2]
for fn in os.listdir(pend):
    if not fn.endswith('.json'):
        continue
    with open(os.path.join(pend, fn)) as f:
        p = json.load(f)
        assert p['payload']['key'] == 'a\x08b', repr(p['payload']['key'])
sys.exit(0)
PY
then ok "backspace (0x08) -> valid JSON, value preserved"; else bad "backspace escaping"; fi
rm -rf "$T4"

# Case 5: form-feed (0x0C) -> valid JSON, value preserved byte-for-byte.
T5=$(mktemp -d)
( cd "$T5" && LOKI_DIR=.loki bash "$EMIT" state cli testaction \
    "key=$(printf 'c\x0cd')" ) >/dev/null 2>&1
if python3 - "$T5/.loki/events.jsonl" "$T5/.loki/events/pending" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        assert d['data']['key'] == 'c\x0cd', repr(d['data']['key'])
pend = sys.argv[2]
for fn in os.listdir(pend):
    if not fn.endswith('.json'):
        continue
    with open(os.path.join(pend, fn)) as f:
        p = json.load(f)
        assert p['payload']['key'] == 'c\x0cd', repr(p['payload']['key'])
sys.exit(0)
PY
then ok "form-feed (0x0C) -> valid JSON, value preserved"; else bad "form-feed escaping"; fi
rm -rf "$T5"

# Case 6: atomic write -- no `.tmp` partial left in the pending dir, and the
# committed file parses cleanly. (temp-file + rename strategy in emit.sh)
T6=$(mktemp -d)
( cd "$T6" && LOKI_DIR=.loki bash "$EMIT" state cli testaction key=value ) >/dev/null 2>&1
leftovers=$(find "$T6/.loki/events/pending" -name '*.tmp' 2>/dev/null | wc -l | tr -d ' ')
committed=$(find "$T6/.loki/events/pending" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "$leftovers" = "0" ] && [ "$committed" -ge 1 ]; then
    ok "atomic write -> no .tmp leftover, committed .json present"
else
    bad "atomic write (.tmp leftovers=$leftovers committed=$committed)"
fi
rm -rf "$T6"

echo ""
echo "Results: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
