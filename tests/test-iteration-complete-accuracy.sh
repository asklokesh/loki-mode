#!/usr/bin/env bash
# tests/test-iteration-complete-accuracy.sh -- the done column must be honest and
# stable. v7.104.2 task-list accuracy fix.
#
# The pre-fix track_iteration_complete() wrote a THIN completed marker
# ({id,type,title:"Iteration N",status,exitCode,provider}: no description, no
# logs) via a BLIND append, and left the id in the sibling terminal file. Against
# real anonima data that produced: empty "done" cards, the same id five times in
# completed (blind append across sub-runs), and iteration-13 present in
# inProgress + completed + failed at once.
#
# Strategy mirrors test-iteration-card-plain.sh: extract the REAL python block
# that track_iteration_complete() runs from run.sh (anchored on the unique
# _LOKI_COMPLETED_TS env marker), unescape the double-quoted-heredoc backslashes
# the shell would consume, then drive it with real env against JSON fixtures.
# The block is self-contained (stdlib + env only), so no helper deps to extract.
#
# Asserts:
#   (1) HONEST title -- "Iteration N complete - <phase>", never the borrowed
#       in-progress PRD-story title (fake-green guard).
#   (2) logs + startedAt LIFTED from the in-progress record before it is removed.
#   (3) UPSERT-by-id -- a pre-existing same-id entry does not accumulate.
#   (4) MUTUAL EXCLUSION -- the id is removed from the OTHER terminal file and
#       from in-progress.
#   (5) failed path -- exit != 0 lands in failed with an honest failure title,
#       and is removed from completed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }

WORKDIR="$(mktemp -d -t loki-itercomplete.XXXXXX)"
trap 'rm -rf "${WORKDIR:-/nonexistent}"' EXIT

# --- Extract the real completer python block from run.sh ---------------------
# The block is: `    python3 -c "` ... `" 2>/dev/null || echo ...`, and it is the
# one that references the _LOKI_COMPLETED_TS env var (unique to the completer).
BLOCK_RAW="$WORKDIR/block.raw.py"
python3 - "$RUN_SCRIPT" > "$BLOCK_RAW" <<'PYEX'
import sys, re
src = open(sys.argv[1]).read()
# Find every python3 -c " ... " 2>/dev/null || echo block; pick the one that
# reads _LOKI_COMPLETED_TS (the iteration completer).
for m in re.finditer(r'    python3 -c "\n(.*?)\n" 2>/dev/null \|\| echo', src, re.S):
    body = m.group(1)
    if "_LOKI_COMPLETED_TS" in body:
        sys.stdout.write(body)
        break
else:
    sys.stderr.write("FATAL: could not locate track_iteration_complete python block (line/anchor drift?)\n")
    sys.exit(2)
PYEX
if [ ! -s "$BLOCK_RAW" ]; then
  echo "FATAL: failed to extract the completer python block from $RUN_SCRIPT"
  exit 2
fi

# Unescape the backslashes the shell consumes inside a double-quoted heredoc
# (\" -> ", \$ -> $, \` -> `, \\ -> \) so the extracted block parses as python.
BLOCK="$WORKDIR/block.py"
python3 - "$BLOCK_RAW" "$BLOCK" <<'PYUN'
import sys
raw = open(sys.argv[1]).read()
BS = chr(92)
un = (raw.replace(BS + '"', '"')
         .replace(BS + '$', '$')
         .replace(BS + '`', '`')
         .replace(BS + BS, BS))
import ast; ast.parse(un)  # fail loudly on drift
open(sys.argv[2], 'w').write(un)
PYUN
if [ $? -ne 0 ]; then
  echo "FATAL: extracted completer block did not parse as python"
  exit 2
fi

run_complete() {
  # args: task_id iter phase exit dur target other inprog
  _LOKI_TASK_ID="$1" _LOKI_ITER="$2" _LOKI_PHASE="$3" _LOKI_EXIT="$4" \
  _LOKI_DUR="$5" _LOKI_PROVIDER="claude" _LOKI_COMPLETED_TS="2026-07-01T10:05:00Z" \
  _LOKI_TARGET="$6" _LOKI_OTHER="$7" _LOKI_INPROG="$8" \
  python3 "$BLOCK"
}

# --- Fixtures: a stale completed with a dup id, a failed carrying the same id,
#     and a rich in-progress record with a BORROWED title + logs. --------------
Q="$WORKDIR/q"
mkdir -p "$Q"
cat > "$Q/completed.json" <<'J'
[{"id":"iteration-13","type":"iteration","title":"Iteration 13","status":"completed","exitCode":0,"provider":"claude"}]
J
cat > "$Q/failed.json" <<'J'
[{"id":"iteration-13","type":"iteration","title":"Iteration 13","status":"failed","exitCode":1,"provider":"claude"}]
J
cat > "$Q/in-progress.json" <<'J'
[{"id":"iteration-13","type":"iteration","title":"server.js entrypoint (borrowed PRD story)","description":"old","status":"in_progress","startedAt":"2026-07-01T10:00:00Z","logs":["phase: implement","ran tests"]}]
J

run_complete iteration-13 13 implement 0 45000 "$Q/completed.json" "$Q/failed.json" "$Q/in-progress.json"

python3 - "$Q" <<'PYCHK'
import json, sys
from collections import Counter
q = sys.argv[1]
comp = json.load(open(f"{q}/completed.json"))
fail = json.load(open(f"{q}/failed.json"))
inp  = json.load(open(f"{q}/in-progress.json"))
i13 = [t for t in comp if t.get("id") == "iteration-13"]

checks = []
rec = i13[-1] if i13 else {}
# (1) honest title, not borrowed
checks.append(("honest-title", rec.get("title") == "Iteration 13 complete - implement"))
checks.append(("no-borrowed-title", "server.js" not in (rec.get("title") or "") and "server.js" not in (rec.get("description") or "")))
# (2) logs + startedAt lifted
checks.append(("logs-lifted", rec.get("logs") == ["phase: implement", "ran tests"]))
checks.append(("startedAt-lifted", rec.get("startedAt") == "2026-07-01T10:00:00Z"))
checks.append(("has-description", bool(rec.get("description"))))
# (3) upsert-by-id -- exactly one iteration-13 in completed
checks.append(("upsert-single", Counter(t.get("id") for t in comp)["iteration-13"] == 1))
# (4) mutual exclusion + in-progress removal
checks.append(("removed-from-failed", not any(t.get("id") == "iteration-13" for t in fail)))
checks.append(("removed-from-inprogress", not any(t.get("id") == "iteration-13" for t in inp)))

for name, passed in checks:
    print(("ok: " if passed else "FAIL: ") + name)
sys.exit(0 if all(p for _, p in checks) else 1)
PYCHK
if [ $? -eq 0 ]; then ok "completed path: honest, lifted, upsert, mutual-exclusion"; else fail "completed path assertions"; fi

# --- Failed path: exit != 0 lands in failed, honest fail title, off completed. -
cat > "$Q/completed.json" <<'J'
[{"id":"iteration-14","type":"iteration","title":"Iteration 14","status":"completed","exitCode":0,"provider":"claude"}]
J
cat > "$Q/failed.json" <<'J'
[]
J
cat > "$Q/in-progress.json" <<'J'
[{"id":"iteration-14","type":"iteration","title":"borrowed","status":"in_progress","logs":["x"]}]
J
run_complete iteration-14 14 verify 2 800 "$Q/failed.json" "$Q/completed.json" "$Q/in-progress.json"
python3 - "$Q" <<'PYCHK'
import json, sys
q = sys.argv[1]
comp = json.load(open(f"{q}/completed.json"))
fail = json.load(open(f"{q}/failed.json"))
rec = [t for t in fail if t.get("id") == "iteration-14"]
rec = rec[-1] if rec else {}
checks = [
    ("fail-title", rec.get("title") == "Iteration 14 failed (exit 2)"),
    ("fail-status", rec.get("status") == "failed"),
    ("fail-dur-ms", "800ms" in (rec.get("description") or "")),
    ("removed-from-completed", not any(t.get("id") == "iteration-14" for t in comp)),
]
for name, passed in checks:
    print(("ok: " if passed else "FAIL: ") + name)
sys.exit(0 if all(p for _, p in checks) else 1)
PYCHK
if [ $? -eq 0 ]; then ok "failed path: honest fail title, mutual-exclusion"; else fail "failed path assertions"; fi

echo
echo "-----------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL ITERATION-COMPLETE ACCURACY TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$FAIL"
