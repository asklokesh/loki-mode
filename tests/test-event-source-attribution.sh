#!/usr/bin/env bash
# Every emit.sh event was attributed to "unknown" in the dashboard.
#
# THE DEFECT. emit.sh built the flat record with a comment asserting that
# `source` is "not part of the dashboard schema" and dropping it. That claim
# was false against the code it names: dashboard/server.py:6686 reads
#
#     s = e.get("data", {}).get("source", "unknown")
#
# and exposes the tally as `signalsBySource`. So every event routed through
# emit.sh landed with no source and fell into the "unknown" bucket, making the
# entire by-source breakdown meaningless.
#
# The failure shape is the dangerous one: no error, no warning, a populated
# chart that is simply wrong. Nobody looks for a bug in a number that renders.
#
# This pins the writer to what the READER actually parses, rather than to a
# comment about what the reader supposedly wants.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMIT="$REPO_ROOT/events/emit.sh"
SERVER="$REPO_ROOT/dashboard/server.py"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: emitted events carry the source the dashboard reads"

# --- the reader really does read data.source ---------------------------------
# If this stops being true the test below is measuring nothing, so assert it
# rather than assuming it.
if grep -q 'get("data", {}).get("source"' "$SERVER"; then
    ok "the dashboard reads data.source (so the field is load-bearing)"
else
    bad "the dashboard no longer reads data.source; this test is now inert"
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-srcattr-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/.loki"

# emit.sh contract: <type> <source> <action> [key=value ...]
( cd "$SCRATCH" && bash "$EMIT" state "my-component" "phase_change" >/dev/null 2>&1 )
( cd "$SCRATCH" && bash "$EMIT" task "runner" "complete" task_id=task-001 >/dev/null 2>&1 )

_log="$SCRATCH/.loki/events.jsonl"
if [ ! -s "$_log" ]; then
    bad "emit.sh wrote no events.jsonl; the checks below would be vacuous"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
ok "emit.sh wrote events.jsonl (assertions below are live)"

# --- what a dashboard-shaped reader actually sees ----------------------------
_res="$(LOKI_T_LOG="$_log" python3 - <<'PY'
import json, os, sys
seen = []
with open(os.environ["LOKI_T_LOG"]) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            print("UNPARSEABLE")
            sys.exit(0)
        d = e.get("data", {})
        # Byte-for-byte the dashboard's own expression.
        seen.append((d.get("source", "unknown"), d.get("action"), d.get("task_id")))
for s, a, t in seen:
    print("%s|%s|%s" % (s, a, t))
PY
)"

case "$_res" in
    *UNPARSEABLE*) bad "emit.sh produced a line the reader cannot parse" ;;
    *) ok "every record parses as JSON" ;;
esac

case "$_res" in
    *"my-component|phase_change|"*)
        ok "the source survives to the flat record, with action intact" ;;
    *"unknown|"*)
        bad "the source was dropped: the dashboard attributes this to 'unknown'" ;;
    *)  bad "unexpected record shape: $_res" ;;
esac

# A caller's key=value pairs must survive the splice. Prepending `source` by
# rebuilding the object is where extra keys would silently vanish.
case "$_res" in
    *"runner|complete|task-001"*)
        ok "caller key=value pairs survive alongside the source" ;;
    *)  bad "extra payload keys were lost: $_res" ;;
esac

# --- nothing may be attributed to unknown ------------------------------------
# The whole point: a populated but wrong chart is worse than an empty one.
case "$_res" in
    *"unknown|"*) bad "at least one event still falls into the unknown bucket" ;;
    *)            ok "no event falls into the 'unknown' source bucket" ;;
esac

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
