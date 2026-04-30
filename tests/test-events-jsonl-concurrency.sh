#!/usr/bin/env bash
# tests/test-events-jsonl-concurrency.sh
#
# v7.5.10 smoke test: verify safe_append_event_jsonl() in events/emit.sh
# serializes concurrent appends to .loki/events.jsonl. Spawns N parallel
# writers and asserts:
#   1) The expected number of lines were written.
#   2) Every line is well-formed JSON (no interleaved/torn writes).
#   3) Every unique payload appears exactly once.
#
# Exit 0 on success, non-zero on failure.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMIT_SH="$REPO_ROOT/events/emit.sh"

if [ ! -f "$EMIT_SH" ]; then
    echo "FAIL: $EMIT_SH not found"
    exit 1
fi

TMP=$(mktemp -d -t loki-evt-XXXXXX)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

EVENTS_FILE="$TMP/events.jsonl"
N=10
# Build a long-ish line (>200 bytes) to exercise the contention window
# more aggressively than a tiny payload would.
PADDING=$(printf 'x%.0s' $(seq 1 250))

# Source the helper in lib-only mode.
# shellcheck disable=SC1090
LOKI_EMIT_LIB_ONLY=1 . "$EMIT_SH" || {
    echo "FAIL: could not source $EMIT_SH"
    exit 1
}

if ! declare -f safe_append_event_jsonl >/dev/null; then
    echo "FAIL: safe_append_event_jsonl not defined after sourcing"
    exit 1
fi

# Detect chosen lock strategy (informational only).
if command -v flock >/dev/null 2>&1; then
    echo "INFO: using flock(1) strategy"
else
    echo "INFO: using mkdir() mutex fallback strategy"
fi

# Spawn N concurrent appenders.
pids=()
for i in $(seq 1 "$N"); do
    (
        line="{\"id\":$i,\"pad\":\"$PADDING\"}"
        safe_append_event_jsonl "$EVENTS_FILE" "$line"
    ) &
    pids+=($!)
done

# Wait for all writers.
for pid in "${pids[@]}"; do
    wait "$pid" || { echo "FAIL: writer pid=$pid exited non-zero"; exit 1; }
done

# Assertion 1: line count
actual_lines=$(wc -l < "$EVENTS_FILE" | tr -d ' ')
if [ "$actual_lines" != "$N" ]; then
    echo "FAIL: expected $N lines, got $actual_lines"
    echo "----- file contents -----"
    cat "$EVENTS_FILE"
    exit 1
fi

# Assertion 2: every line is well-formed JSON
if ! python3 -c "
import json, sys
with open('$EVENTS_FILE') as f:
    for n, raw in enumerate(f, 1):
        raw = raw.rstrip('\n')
        if not raw:
            print(f'FAIL: line {n} is empty')
            sys.exit(1)
        try:
            json.loads(raw)
        except json.JSONDecodeError as e:
            print(f'FAIL: line {n} not valid JSON: {e}')
            print('  content:', repr(raw))
            sys.exit(1)
print('OK: all lines valid JSON')
"; then
    exit 1
fi

# Assertion 3: every id 1..N appears exactly once
ids_found=$(python3 -c "
import json
ids = []
with open('$EVENTS_FILE') as f:
    for raw in f:
        ids.append(json.loads(raw)['id'])
print(','.join(str(i) for i in sorted(ids)))
")
expected=$(python3 -c "print(','.join(str(i) for i in range(1, $N + 1)))")
if [ "$ids_found" != "$expected" ]; then
    echo "FAIL: id set mismatch"
    echo "  expected: $expected"
    echo "  found:    $ids_found"
    exit 1
fi

echo "PASS: $N concurrent appends serialized correctly"
exit 0
