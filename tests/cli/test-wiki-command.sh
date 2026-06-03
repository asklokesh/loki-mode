#!/usr/bin/env bash
# tests/cli/test-wiki-command.sh
# Test: `loki wiki generate|show|ask` (R5 auto-wiki + cited Q&A CLI surface).
#
# Exercises the bash route against a small fixture git repo. The LLM is mocked
# via LOKI_WIKI_LLM_STUB (no network, no paid calls). LOKI_LEGACY_BASH=1 forces
# the bash route so this test is independent of bun being installed.
#
# Assertions:
#   - generate  writes .loki/wiki/{wiki.json,index.md,architecture.md,...}
#   - generate  citations point at REAL files only.
#   - generate  re-run with no change reports "up to date" (incremental skip).
#   - show      prints a section; errors on an unknown section.
#   - ask       returns a grounded answer with a real file:line citation.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d -t loki-wiki-cli-XXXX)
trap 'rm -rf "$TMP"' EXIT

PROJECT="$TMP/project"
mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/server.py" <<'PY'
def start(port):
    return listen(port)


def listen(port):
    return port
PY
( cd "$PROJECT" && git init -q && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm init ) >/dev/null 2>&1

export LOKI_LEGACY_BASH=1

# --- generate ---------------------------------------------------------------
gen_out=$( cd "$PROJECT" && LOKI_WIKI_LLM_STUB="Server starts here [1]." \
    bash "$LOKI" wiki generate 2>&1 )
if [ -f "$PROJECT/.loki/wiki/wiki.json" ] \
    && [ -f "$PROJECT/.loki/wiki/index.md" ] \
    && [ -f "$PROJECT/.loki/wiki/architecture.md" ]; then
    log_pass "generate writes wiki.json + rendered md"
else
    log_fail "generate writes wiki.json + rendered md" "$gen_out"
fi

# --- citations are real -----------------------------------------------------
bad=$(python3 - "$PROJECT" <<'PY'
import json, os, sys
root = sys.argv[1]
wiki = json.load(open(os.path.join(root, ".loki", "wiki", "wiki.json")))
bad = 0
total = 0
for sec in wiki["sections"]:
    for c in sec["citations"]:
        total += 1
        p = os.path.join(root, c["file"])
        if not os.path.isfile(p):
            bad += 1
        else:
            n = sum(1 for _ in open(p))
            if not (1 <= c["line"] <= max(n, 1)):
                bad += 1
print("%d %d" % (bad, total))
PY
)
read -r bad_count total_count <<< "$bad"
if [ "$bad_count" = "0" ] && [ "$total_count" -gt 0 ]; then
    log_pass "all citations point at real files ($total_count checked)"
else
    log_fail "all citations point at real files" "bad=$bad_count total=$total_count"
fi

# --- positional path (documented as `loki wiki generate [path]`) ------------
pos_out=$( cd /tmp && LOKI_WIKI_LLM_STUB="Server starts here [1]." \
    bash "$LOKI" wiki generate "$PROJECT" --force 2>&1 )
if echo "$pos_out" | grep -qi "wiki written\|sections"; then
    log_pass "generate accepts a positional project path"
else
    log_fail "generate accepts a positional project path" "$pos_out"
fi

# --- incremental skip -------------------------------------------------------
skip_out=$( cd "$PROJECT" && bash "$LOKI" wiki generate 2>&1 )
if echo "$skip_out" | grep -qi "up to date"; then
    log_pass "incremental regen skips when unchanged"
else
    log_fail "incremental regen skips when unchanged" "$skip_out"
fi

# --- show -------------------------------------------------------------------
show_out=$( cd "$PROJECT" && bash "$LOKI" wiki show architecture 2>&1 )
if echo "$show_out" | grep -q "Architecture Overview"; then
    log_pass "show architecture prints the section"
else
    log_fail "show architecture prints the section" "$show_out"
fi

bad_show=$( cd "$PROJECT" && bash "$LOKI" wiki show nope 2>&1 )
bad_rc=$?
if [ "$bad_rc" != "0" ]; then
    log_pass "show rejects an unknown section"
else
    log_fail "show rejects an unknown section" "$bad_show"
fi

# --- ask --------------------------------------------------------------------
ask_out=$( cd "$PROJECT" && LOKI_WIKI_LLM_STUB="The start function is at [1]." \
    bash "$LOKI" wiki ask "where does the server start" 2>&1 )
if echo "$ask_out" | grep -q "src/server.py:"; then
    log_pass "ask returns a grounded file:line citation"
else
    log_fail "ask returns a grounded file:line citation" "$ask_out"
fi

echo ""
echo "Wiki CLI tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
