#!/usr/bin/env bash
# tests/test-agents-md-walker.sh -- AGENTS.md precedence regression test for
# the layered doc walker (`load_app_graph_context` /  `_lpg_memory_file` in
# autonomy/lib/project-graph.sh).
#
# The agents.md standard is plain Markdown at a repo/dir root, nearest-file-wins,
# read natively by Claude Code/Codex/etc. Loki prefers AGENTS.md and falls back
# to CLAUDE.md only when AGENTS.md is absent in that directory. The two are
# never merged.
#
# Verifies:
# - A dir with BOTH AGENTS.md and CLAUDE.md emits AGENTS.md content; CLAUDE.md
#   content is ignored (precedence: AGENTS.md wins, never merged).
# - A dir with ONLY CLAUDE.md falls back to CLAUDE.md content.
# - An empty-but-present AGENTS.md still wins over a populated CLAUDE.md (the
#   resolver keys on file existence, not content; even an empty AGENTS.md
#   suppresses the CLAUDE.md fallback for that directory).
#
# This walker is BASH-ONLY by design (see the route-asymmetry note on
# load_app_graph_context); there is no TS port to test.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/project-graph.sh"

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

TMPROOT=$(mktemp -d -t loki-agents-md-walker-XXXX)

# ---------- 1. Direct resolver unit checks (_lpg_memory_file) ----------
# Both files present -> AGENTS.md.
D_BOTH="$TMPROOT/both"
mkdir -p "$D_BOTH"
printf '%s\n' '# AGENTS conventions both' > "$D_BOTH/AGENTS.md"
printf '%s\n' '# CLAUDE conventions both' > "$D_BOTH/CLAUDE.md"
got=$(_lpg_memory_file "$D_BOTH")
if [ "$got" = "$D_BOTH/AGENTS.md" ]; then
    ok "_lpg_memory_file: both present -> AGENTS.md"
else
    bad "_lpg_memory_file: both present resolved to '$got' (expected AGENTS.md)"
fi

# Only CLAUDE.md -> fallback CLAUDE.md.
D_CLAUDE="$TMPROOT/claudeonly"
mkdir -p "$D_CLAUDE"
printf '%s\n' '# CLAUDE conventions only' > "$D_CLAUDE/CLAUDE.md"
got=$(_lpg_memory_file "$D_CLAUDE")
if [ "$got" = "$D_CLAUDE/CLAUDE.md" ]; then
    ok "_lpg_memory_file: only CLAUDE.md -> CLAUDE.md fallback"
else
    bad "_lpg_memory_file: only CLAUDE.md resolved to '$got' (expected CLAUDE.md)"
fi

# Empty-but-present AGENTS.md -> AGENTS.md (existence, not content).
D_EMPTY="$TMPROOT/emptyagents"
mkdir -p "$D_EMPTY"
: > "$D_EMPTY/AGENTS.md"
printf '%s\n' '# CLAUDE conventions empties' > "$D_EMPTY/CLAUDE.md"
got=$(_lpg_memory_file "$D_EMPTY")
if [ "$got" = "$D_EMPTY/AGENTS.md" ]; then
    ok "_lpg_memory_file: empty-but-present AGENTS.md still wins"
else
    bad "_lpg_memory_file: empty AGENTS.md resolved to '$got' (expected AGENTS.md)"
fi

# Neither present -> CLAUDE.md path (the _append_layer reader no-ops on missing).
D_NONE="$TMPROOT/none"
mkdir -p "$D_NONE"
got=$(_lpg_memory_file "$D_NONE")
if [ "$got" = "$D_NONE/CLAUDE.md" ]; then
    ok "_lpg_memory_file: neither present -> CLAUDE.md path (reader no-ops)"
else
    bad "_lpg_memory_file: neither present resolved to '$got' (expected CLAUDE.md)"
fi

# ---------- 2. End-to-end walker: BOTH files -> AGENTS wins ----------
# Two-member logical app. Scope dir (ui) has BOTH; parent has ONLY CLAUDE.md.
APP="$TMPROOT/app"
mkdir -p "$APP/.loki" "$APP/ui/.loki" "$APP/api/.loki"
printf '%s\n' '{"schema_version":1,"app_id":"app"}' > "$APP/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"app"}' > "$APP/ui/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"app"}' > "$APP/api/.loki/app.json"

# Parent: only CLAUDE.md (fallback path).
printf '%s\n' 'PARENT_CLAUDE_MARKER parent conventions' > "$APP/CLAUDE.md"
# api member: BOTH; AGENTS.md must win.
printf '%s\n' 'API_AGENTS_MARKER api agents conventions' > "$APP/api/AGENTS.md"
printf '%s\n' 'API_CLAUDE_MARKER should be ignored' > "$APP/api/CLAUDE.md"
# ui scope: BOTH; AGENTS.md must win.
printf '%s\n' 'UI_AGENTS_MARKER ui agents conventions' > "$APP/ui/AGENTS.md"
printf '%s\n' 'UI_CLAUDE_MARKER should be ignored' > "$APP/ui/CLAUDE.md"

unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
loki_project_graph_discover "$APP/ui"
TARGET_DIR="$APP/ui" load_app_graph_context > "$TMPROOT/walker.out"

# Parent: fallback CLAUDE.md path emitted, content present.
if grep -q "<!-- LOKI_LAYER:parent path=$APP/CLAUDE.md -->" "$TMPROOT/walker.out" \
   && grep -q 'PARENT_CLAUDE_MARKER' "$TMPROOT/walker.out"; then
    ok "walker: parent falls back to CLAUDE.md (no AGENTS.md present)"
else
    bad "walker: parent CLAUDE.md fallback layer/content missing"
fi

# api member: AGENTS.md path + content present; CLAUDE.md content ignored.
if grep -q "<!-- LOKI_LAYER:member path=$APP/api/AGENTS.md -->" "$TMPROOT/walker.out" \
   && grep -q 'API_AGENTS_MARKER' "$TMPROOT/walker.out"; then
    ok "walker: api member prefers AGENTS.md"
else
    bad "walker: api AGENTS.md member layer/content missing"
fi
if grep -q 'API_CLAUDE_MARKER' "$TMPROOT/walker.out"; then
    bad "walker: api CLAUDE.md content leaked (should be ignored when AGENTS.md present)"
else
    ok "walker: api CLAUDE.md ignored when AGENTS.md present (never merged)"
fi

# ui scope: AGENTS.md path + content present; CLAUDE.md content ignored.
if grep -q "<!-- LOKI_LAYER:scope path=$APP/ui/AGENTS.md -->" "$TMPROOT/walker.out" \
   && grep -q 'UI_AGENTS_MARKER' "$TMPROOT/walker.out"; then
    ok "walker: ui scope prefers AGENTS.md"
else
    bad "walker: ui AGENTS.md scope layer/content missing"
fi
if grep -q 'UI_CLAUDE_MARKER' "$TMPROOT/walker.out"; then
    bad "walker: ui CLAUDE.md content leaked (should be ignored when AGENTS.md present)"
else
    ok "walker: ui CLAUDE.md ignored when AGENTS.md present (never merged)"
fi

# ---------- 3. End-to-end walker: empty AGENTS.md still suppresses CLAUDE.md ----------
APP2="$TMPROOT/app2"
mkdir -p "$APP2/.loki" "$APP2/ui/.loki"
printf '%s\n' '{"schema_version":1,"app_id":"app2"}' > "$APP2/.loki/app.json"
printf '%s\n' '{"schema_version":1,"app_id":"app2"}' > "$APP2/ui/.loki/app.json"
# Scope: empty AGENTS.md (existence wins) + populated CLAUDE.md.
: > "$APP2/ui/AGENTS.md"
printf '%s\n' 'UI2_CLAUDE_MARKER should be suppressed by empty AGENTS.md' > "$APP2/ui/CLAUDE.md"
# Give the parent something so the walker has at least one emitting layer.
printf '%s\n' 'PARENT2_AGENTS_MARKER parent agents' > "$APP2/AGENTS.md"

unset LOKI_PROJECT_GRAPH_ROOT LOKI_PROJECT_GRAPH_APP_ID LOKI_PROJECT_GRAPH_MEMBERS
loki_project_graph_discover "$APP2/ui"
TARGET_DIR="$APP2/ui" load_app_graph_context > "$TMPROOT/walker2.out"

# The empty AGENTS.md emits no scope block (reader no-ops on empty content),
# but it MUST NOT fall through to CLAUDE.md content -- precedence is by file.
if grep -q 'UI2_CLAUDE_MARKER' "$TMPROOT/walker2.out"; then
    bad "walker: empty AGENTS.md did NOT suppress CLAUDE.md fallback"
else
    ok "walker: empty-but-present AGENTS.md suppresses CLAUDE.md fallback"
fi
# Sanity: parent AGENTS.md content present so we know the walker ran.
if grep -q 'PARENT2_AGENTS_MARKER' "$TMPROOT/walker2.out"; then
    ok "walker: parent AGENTS.md content emitted (walker exercised)"
else
    bad "walker: parent AGENTS.md content missing (walker did not run)"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
