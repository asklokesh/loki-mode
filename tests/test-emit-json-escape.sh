#!/usr/bin/env bash
# Regression: events/emit.sh json_escape must produce valid JSON even when a
# payload value contains raw C0 control bytes. Before the fix, json_escape
# escaped only \\ " \t \r \b \f and let other control chars (0x01-0x07, 0x0B,
# 0x0E-0x1F) through raw, producing invalid JSON that consumers
# (dashboard _read_events, learning aggregator) silently drop on JSONDecodeError.
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

echo ""
echo "Results: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
