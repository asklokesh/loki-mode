#!/usr/bin/env bash
# tests/test-emit-jsonl.sh
#
# Regression test for the "dashboard event blindness" bug: events/emit.sh in
# emit mode used to write ONLY a per-event pending file and never append a line
# to .loki/events.jsonl, the file the dashboard reads (dashboard/server.py
# _read_events). This test asserts that emit.sh now ALSO appends exactly one
# valid one-line record in the FLAT {timestamp,type,data} schema the dashboard
# consumes -- matching run.sh's emit_event / emit_event_json -- while keeping
# the pending-file write intact for other consumers.
#
# Self-contained: uses mktemp, a trap-based cleanup, and no network/process.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMIT_SH="$REPO_ROOT/events/emit.sh"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

# --- temp sandbox -----------------------------------------------------------
TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/loki-emit-jsonl.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_TEST" 2>/dev/null || true; }
trap cleanup EXIT

LOKI_TEST_DIR="$TMPDIR_TEST/.loki"
EVENTS_JSONL="$LOKI_TEST_DIR/events.jsonl"
PENDING_DIR="$LOKI_TEST_DIR/events/pending"

echo "=== test-emit-jsonl.sh ==="
echo "sandbox: $TMPDIR_TEST"
echo

# --- emit one event ---------------------------------------------------------
# emit.sh prints the EVENT_ID on stdout; capture and discard it so it does not
# confuse assertions. LOKI_DIR drives both the pending dir and the jsonl path.
EVENT_ID="$(LOKI_DIR="$LOKI_TEST_DIR" bash "$EMIT_SH" session cli start provider=claude foo=bar)"
echo "emitted event id: $EVENT_ID"
echo

# --- (a) pending file created ----------------------------------------------
PENDING_COUNT=$(find "$PENDING_DIR" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
if [ "$PENDING_COUNT" -ge 1 ]; then
    pass "(a) pending file created ($PENDING_COUNT in $PENDING_DIR)"
else
    fail "(a) no pending file created in $PENDING_DIR"
fi

# --- (b) events.jsonl gains exactly one line -------------------------------
if [ -f "$EVENTS_JSONL" ]; then
    LINE_COUNT=$(wc -l < "$EVENTS_JSONL" | tr -d ' ')
    if [ "$LINE_COUNT" -eq 1 ]; then
        pass "(b) events.jsonl has exactly 1 line"
    else
        fail "(b) events.jsonl has $LINE_COUNT lines (expected 1)"
    fi
else
    fail "(b) events.jsonl was not created at $EVENTS_JSONL"
fi

# --- (c) record parses as JSON with the right flat-schema keys --------------
# Flat schema (dashboard/server.py _read_events + run.sh emit_event_json):
#   {"timestamp": <str>, "type": <str>, "data": <object>}
if [ -f "$EVENTS_JSONL" ]; then
    LINE="$(head -n 1 "$EVENTS_JSONL")"
    echo "record: $LINE"
    SCHEMA_OK=$(python3 - "$LINE" <<'PY'
import json, sys
line = sys.argv[1]
try:
    ev = json.loads(line)
except Exception as e:
    print("BADJSON:%s" % e); sys.exit(0)
keys = set(ev.keys())
if keys != {"timestamp", "type", "data"}:
    print("BADKEYS:%s" % sorted(keys)); sys.exit(0)
if not isinstance(ev["timestamp"], str) or not ev["timestamp"]:
    print("BADTS"); sys.exit(0)
if ev["type"] != "session":
    print("BADTYPE:%s" % ev["type"]); sys.exit(0)
if not isinstance(ev["data"], dict):
    print("BADDATA_TYPE"); sys.exit(0)
# data must carry the payload built from action + key=value args
if ev["data"].get("action") != "start":
    print("BADACTION:%s" % ev["data"].get("action")); sys.exit(0)
if ev["data"].get("provider") != "claude" or ev["data"].get("foo") != "bar":
    print("BADKV:%s" % ev["data"]); sys.exit(0)
print("OK")
PY
)
    if [ "$SCHEMA_OK" = "OK" ]; then
        pass "(c) record is valid flat-schema JSON {timestamp,type,data} with expected payload"
    else
        fail "(c) record failed schema check: $SCHEMA_OK"
    fi
fi

# --- non-vacuity: against the OLD emit.sh, events.jsonl is empty/absent ------
# Reconstruct the pre-fix behavior: the old script wrote ONLY the pending file
# and the per-event EVENT; events.jsonl was created only by the rotation block
# (an mv of an existing file), never by an append. We simulate "old emit.sh" by
# stripping the new safe_append_event_jsonl call from a copy and running it in a
# clean sandbox. If events.jsonl appears, the test is vacuous.
OLD_SANDBOX="$TMPDIR_TEST/old"
mkdir -p "$OLD_SANDBOX"
OLD_EMIT="$OLD_SANDBOX/emit-old.sh"
# Remove the flat-schema append lines (the FLAT_EVENT build + the helper call).
grep -v 'FLAT_EVENT=' "$EMIT_SH" | grep -v 'safe_append_event_jsonl "\$EVENTS_LOG"' > "$OLD_EMIT"
OLD_LOKI_DIR="$OLD_SANDBOX/.loki"
OLD_EVENTS_JSONL="$OLD_LOKI_DIR/events.jsonl"
LOKI_DIR="$OLD_LOKI_DIR" bash "$OLD_EMIT" session cli start provider=claude >/dev/null 2>&1 || true
if [ -f "$OLD_EVENTS_JSONL" ] && [ -s "$OLD_EVENTS_JSONL" ]; then
    fail "(non-vacuity) OLD emit.sh ALSO produced a non-empty events.jsonl -- test is vacuous"
else
    pass "(non-vacuity) OLD emit.sh produced NO events.jsonl record (absent/empty)"
fi

echo
if [ "$FAILS" -eq 0 ]; then
    echo "=== ALL TESTS PASSED ==="
    exit 0
else
    echo "=== $FAILS TEST(S) FAILED ==="
    exit 1
fi
