#!/usr/bin/env bash
#===============================================================================
# Regression test for tests/check-heredoc-dollar-digit.sh's CLOSER detection.
#
# The checker tracks whether it is "inside" a multi-line `python3 -c "..."`
# body by looking for a line whose closing double quote sits at column 0. A
# python source line that ends with code AFTER the closing quote (e.g.
# `print('')" "$var" 2>/dev/null)"`) never matches that anchor, so the checker
# stays "in block" forever and starts flagging ordinary bash positionals
# (`local x="$1"`) later in the file as if they were unescaped python-source
# dollar-digits. This happened for real at autonomy/run.sh:5548.
#
# Strategy: build two small fixture files under a temp dir and run the real
# checker script against them via its `[file ...]` argv form.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-heredoc-dollar-digit.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() { [ -n "$TMPROOT" ] && rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT

[ -f "$CHECKER" ] || { echo "FATAL: checker not found at $CHECKER"; exit 2; }

TMPROOT="$(mktemp -d -t loki-heredocdigit.XXXXXX)"

# Fixture 1: the run.sh:5548 shape. A multi-line python3 -c "..." body whose
# last line closes with `print('')" ... )"` (quote NOT at column 0), followed
# by a bash function using ordinary `local x="$1"` positionals. Must NOT flag.
FIXTURE_CLEAN="$TMPROOT/clean.sh"
cat >"$FIXTURE_CLEAN" <<'EOF'
_get_url() {
    local _url
    _url="$(python3 -c "import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('url','') if d.get('status')=='running' else '')
except Exception:
    print('')" "$_app_state" 2>/dev/null)" || _url=""
}

_loki_restore_one_token() {
    local _var="$1" _had="$2" _val="$3"
    if [ -n "$_had" ]; then
        export "$_var=$_val"
    else
        unset "$_var"
    fi
}
EOF

# Fixture 2: a real unescaped $1 inside a python3 -c "..." body. Must still
# be flagged.
FIXTURE_DIRTY="$TMPROOT/dirty.sh"
cat >"$FIXTURE_DIRTY" <<'EOF'
_bad() {
    python3 -c "
print('cost is $1 dollars')
" 2>/dev/null || true
}
EOF

# --- Red-first: show both fixtures under the pre-fix checker logic would
# have disagreed with what we assert now (documented here, not re-run,
# since git history is the pre-fix state). Assert against the CURRENT
# (fixed) checker script on disk.

out_clean="$("$CHECKER" "$FIXTURE_CLEAN" 2>&1)"
rc_clean=$?
if [ "$rc_clean" -eq 0 ]; then
    ok "clean fixture (run.sh:5548 shape) not flagged"
else
    bad "clean fixture wrongly flagged (rc=$rc_clean): $out_clean"
fi

out_dirty="$("$CHECKER" "$FIXTURE_DIRTY" 2>&1)"
rc_dirty=$?
if [ "$rc_dirty" -eq 1 ] && printf '%s' "$out_dirty" | grep -q 'dirty.sh:3'; then
    ok "dirty fixture (real unescaped \$1 in python3 -c) flagged at line 3"
else
    bad "dirty fixture not flagged as expected (rc=$rc_dirty): $out_dirty"
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
