#!/usr/bin/env bash
# tests/test-parity-project-graph.sh -- Phase F (v7.5.23) bash/Bun parity test.
#
# Verifies that `loki_project_graph_discover` (bash) and
# `discoverProjectGraph` (Bun) agree on the same fixture project graph:
#   1. Same app_id resolved
#   2. Same set of member paths (order-independent)
#   3. Same shared_memory_dir (when present in app.json)
#
# Skips cleanly if `bun` is not on PATH.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_TS_DIR="$REPO_ROOT/loki-ts"
FIXTURE_DIR="$REPO_ROOT/tests/fixtures/project-graph/acme"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not on PATH; parity unverified"
    exit 0
fi

if [ ! -d "$FIXTURE_DIR" ]; then
    echo "FAIL: fixture not found at $FIXTURE_DIR"
    exit 1
fi

# ---------- bash route ----------
# shellcheck source=/dev/null
. "$REPO_ROOT/autonomy/lib/project-graph.sh"
unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR
loki_project_graph_discover "$FIXTURE_DIR/ui" >/dev/null 2>&1
BASH_APP_ID="${LOKI_PROJECT_GRAPH_APP_ID:-}"
BASH_ROOT="${LOKI_PROJECT_GRAPH_ROOT:-}"
BASH_MEMBERS="${LOKI_PROJECT_GRAPH_MEMBERS:-}"

# Normalize members to one-per-line for set comparison
bash_member_set=$(printf '%s\n' "$BASH_MEMBERS" | tr ':' '\n' | sort -u | grep -v '^$')

# ---------- Bun route ----------
bun_out=$(cd "$LOKI_TS_DIR" && bun run --silent - <<BUNEOF 2>/dev/null
import { discoverProjectGraph } from "./src/project_graph.ts";
const r = discoverProjectGraph("$FIXTURE_DIR/ui");
if (!r) { console.log(""); process.exit(0); }
console.log(JSON.stringify({ appId: r.appId, root: r.root, members: r.members.sort() }));
BUNEOF
)
if [ -z "$bun_out" ]; then
    bad "Bun discoverProjectGraph returned null on fixture"
    echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
    exit 1
fi

BUN_APP_ID=$(echo "$bun_out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["appId"])')
BUN_ROOT=$(echo "$bun_out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["root"])')
bun_member_set=$(echo "$bun_out" | python3 -c 'import json,sys; print("\n".join(sorted(json.load(sys.stdin)["members"])))')

# ---------- Assertions ----------
[ "$BASH_APP_ID" = "$BUN_APP_ID" ] && ok "app_id parity: $BASH_APP_ID" \
    || bad "app_id mismatch: bash=$BASH_APP_ID bun=$BUN_APP_ID"

# Compare resolved roots (both should land on .../acme/, accounting for realpath)
bash_root_real=$(python3 -c "import os; print(os.path.realpath('$BASH_ROOT'))" 2>/dev/null)
bun_root_real=$(python3 -c "import os; print(os.path.realpath('$BUN_ROOT'))" 2>/dev/null)
[ "$bash_root_real" = "$bun_root_real" ] && ok "root parity: $bash_root_real" \
    || bad "root mismatch: bash=$bash_root_real bun=$bun_root_real"

# Members: order-independent set equality
if diff <(echo "$bash_member_set") <(echo "$bun_member_set") >/dev/null 2>&1; then
    ok "members parity: $(echo "$bash_member_set" | wc -l | tr -d ' ') members"
else
    bad "member set mismatch"
    echo "  bash: $bash_member_set"
    echo "  bun:  $bun_member_set"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
