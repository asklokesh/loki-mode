#!/usr/bin/env bash
# tests/test-claude-md-walker.sh -- Phase F (v7.5.23) regression test for
# the layered CLAUDE.md walker (`load_app_graph_context` in
# autonomy/lib/project-graph.sh).
#
# Verifies:
# - Concatenated output contains parent + member fragments wrapped in
#   <!-- LOKI_LAYER:... --> ... <!-- /LOKI_LAYER --> markers
# - Total output capped at 32KB; truncation happens at section boundary
#   (no LOKI_LAYER block is split mid-content)
# - Per-layer cap of 16KB truncates with a `<!-- truncated -->` suffix
# - When LOKI_PROJECT_GRAPH_ROOT is unset, walker emits empty string
#   (backward compat -- existing single-project workflows untouched)

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/project-graph.sh"
FIXTURE_SRC="$REPO_ROOT/tests/fixtures/project-graph/acme"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

# shellcheck disable=SC1090
. "$HELPER"

TMPROOT=$(mktemp -d -t loki-claude-md-walker-XXXX)

# ---------- 1. Backward compat: unset env -> empty output ----------
(
    unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
    out=$(load_app_graph_context)
    if [ -z "$out" ]; then
        printf 'OK\n'
    else
        printf 'BAD %s\n' "$out"
    fi
) > "$TMPROOT/case1.txt"
if grep -q '^OK$' "$TMPROOT/case1.txt"; then
    ok "walker: unset LOKI_PROJECT_GRAPH_ROOT -> empty output"
else
    bad "walker: unset env did NOT emit empty (got $(cat "$TMPROOT/case1.txt"))"
fi

# ---------- 2. Layered output from happy-path fixture ----------
cp -R "$FIXTURE_SRC" "$TMPROOT/acme"
ACME="$TMPROOT/acme"

# Prime discovery to set the env vars, then call the walker from the ui dir.
loki_project_graph_discover "$ACME/ui"
TARGET_DIR="$ACME/ui" load_app_graph_context > "$TMPROOT/walker.out"

if grep -q "<!-- LOKI_LAYER:parent path=$ACME/CLAUDE.md -->" "$TMPROOT/walker.out"; then
    ok "walker: parent layer marker emitted"
else
    bad "walker: parent layer marker missing"
fi

# member layers (api + service should appear; ui is the scope, not a member layer)
if grep -q "<!-- LOKI_LAYER:member path=$ACME/api/CLAUDE.md -->" "$TMPROOT/walker.out"; then
    ok "walker: api member layer marker emitted"
else
    bad "walker: api member layer marker missing"
fi
if grep -q "<!-- LOKI_LAYER:member path=$ACME/service/CLAUDE.md -->" "$TMPROOT/walker.out"; then
    ok "walker: service member layer marker emitted"
else
    bad "walker: service member layer marker missing"
fi

# scope layer (target dir CLAUDE.md)
if grep -q "<!-- LOKI_LAYER:scope path=$ACME/ui/CLAUDE.md -->" "$TMPROOT/walker.out"; then
    ok "walker: scope (target) layer marker emitted"
else
    bad "walker: scope layer marker missing"
fi

# Closing markers should match opening markers (count parity).
open_count=$(grep -c '<!-- LOKI_LAYER:' "$TMPROOT/walker.out")
close_count=$(grep -c '<!-- /LOKI_LAYER -->' "$TMPROOT/walker.out")
if [ "$open_count" -eq 4 ] && [ "$close_count" -eq 4 ]; then
    ok "walker: 4 open + 4 close markers (parent + 2 members + scope)"
else
    bad "walker: marker mismatch open=$open_count close=$close_count"
fi

# Content from each CLAUDE.md should appear inside the appropriate block.
if grep -q "Cross-cutting conventions for the Acme logical app" "$TMPROOT/walker.out"; then
    ok "walker: parent content present"
else
    bad "walker: parent content missing"
fi
if grep -q "FastAPI service" "$TMPROOT/walker.out"; then
    ok "walker: api member content present"
else
    bad "walker: api content missing"
fi
if grep -q "React + TypeScript front-end" "$TMPROOT/walker.out"; then
    ok "walker: ui scope content present"
else
    bad "walker: ui content missing"
fi

# ---------- 3. Per-layer 16KB cap truncates with marker ----------
BIGFIX="$TMPROOT/bigfix"
mkdir -p "$BIGFIX/.loki" "$BIGFIX/ui/.loki" "$BIGFIX/api/.loki"
printf '%s\n' '{"schema_version":1,"app_id":"big"}' > "$BIGFIX/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"big"}' > "$BIGFIX/ui/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"big"}' > "$BIGFIX/api/.loki/app.json"
# Build a >16KB parent CLAUDE.md (20KB).
python3 -c "open('$BIGFIX/CLAUDE.md','w').write('# Big parent\n' + ('X'*20000) + '\n')"
printf '%s\n' '# UI member' > "$BIGFIX/ui/CLAUDE.md"
printf '%s\n' '# API member' > "$BIGFIX/api/CLAUDE.md"

unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
loki_project_graph_discover "$BIGFIX/ui"
TARGET_DIR="$BIGFIX/ui" load_app_graph_context > "$TMPROOT/walker-big.out"

# Parent layer should contain the truncation marker.
if grep -q '<!-- truncated -->' "$TMPROOT/walker-big.out"; then
    ok "walker: per-layer truncation marker emitted"
else
    bad "walker: expected <!-- truncated --> when layer exceeds cap"
fi

# Output total must be <= 32KB total (sanity bound for the test).
total_bytes=$(wc -c < "$TMPROOT/walker-big.out" | tr -d ' ')
if [ "$total_bytes" -le 33000 ]; then
    ok "walker: total output $total_bytes bytes (within ~32KB cap)"
else
    bad "walker: total output $total_bytes bytes exceeds 32KB cap"
fi

# ---------- 4. Total 32KB cap stops at section boundary ----------
# Each CLAUDE.md is 12KB (under per-layer cap), so 4 layers ~= 48KB.
# Walker must stop AFTER a complete block, never split one mid-content.
TOTFIX="$TMPROOT/totfix"
mkdir -p "$TOTFIX/.loki" "$TOTFIX/ui/.loki" "$TOTFIX/api/.loki" "$TOTFIX/service/.loki"
printf '%s\n' '{"schema_version":1,"app_id":"tot"}' > "$TOTFIX/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"tot"}' > "$TOTFIX/ui/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"tot"}' > "$TOTFIX/api/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"tot"}' > "$TOTFIX/service/.loki/app.json"
python3 -c "open('$TOTFIX/CLAUDE.md','w').write('# parent\n' + ('P'*12000) + '\n')"
python3 -c "open('$TOTFIX/ui/CLAUDE.md','w').write('# ui\n' + ('U'*12000) + '\n')"
python3 -c "open('$TOTFIX/api/CLAUDE.md','w').write('# api\n' + ('A'*12000) + '\n')"
python3 -c "open('$TOTFIX/service/CLAUDE.md','w').write('# service\n' + ('S'*12000) + '\n')"

unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
loki_project_graph_discover "$TOTFIX/ui"
TARGET_DIR="$TOTFIX/ui" load_app_graph_context > "$TMPROOT/walker-tot.out"

total_bytes=$(wc -c < "$TMPROOT/walker-tot.out" | tr -d ' ')
if [ "$total_bytes" -le 33000 ]; then
    ok "walker: total cap honored: $total_bytes bytes (<=33KB)"
else
    bad "walker: total cap blown: $total_bytes bytes"
fi

# Verify open/close marker parity -- no block split mid-content.
open_count=$(grep -c '<!-- LOKI_LAYER:' "$TMPROOT/walker-tot.out")
close_count=$(grep -c '<!-- /LOKI_LAYER -->' "$TMPROOT/walker-tot.out")
if [ "$open_count" -eq "$close_count" ] && [ "$open_count" -ge 1 ]; then
    ok "walker: open/close marker parity preserved ($open_count of each)"
else
    bad "walker: marker parity broken open=$open_count close=$close_count"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
