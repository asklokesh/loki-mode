#!/usr/bin/env bash
# server.json must track VERSION, or the MCP registry advertises a stale build.
#
# WHY THIS EXISTS. server.json is the MCP registry submission manifest -- the
# entry that puts Loki Mode in front of people already browsing for MCP servers,
# which is a distribution channel we do not otherwise have. It was pinned at
# 7.34.1 while the repo shipped 8.2.0: more than thirty releases of drift,
# silently, because nothing checked it.
#
# The failure mode is quiet and expensive. Nothing breaks locally, no gate goes
# red, and the cost only lands at submission time when the registry advertises a
# build from weeks ago -- to exactly the audience evaluating whether this project
# is maintained. A version-drift bug on the shop window is worse than one in the
# engine.
#
# The release checklist in CLAUDE.md lists every file carrying a version string.
# server.json was not on it. A test enforces the invariant whether or not anyone
# remembers to update a checklist, which is the whole argument for testing this
# rather than documenting it.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

SERVER_JSON="$REPO_ROOT/server.json"
VERSION_FILE="$REPO_ROOT/VERSION"

if [ ! -f "$SERVER_JSON" ]; then
    echo "  [SKIP] server.json not present"
    echo "Results: 0 passed, 0 failed, 0 total"
    exit 0
fi

want="$(tr -d ' \n' < "$VERSION_FILE")"

echo "T1 -- server.json tracks VERSION"

got=$(python3 -c "import json;print(json.load(open('$SERVER_JSON'))['version'])" 2>/dev/null)
if [ "$got" = "$want" ]; then
    ok "server.json version ($got) matches VERSION"
else
    bad "server.json version is $got but VERSION is $want -- registry would advertise a stale build"
fi

# The package entry carries its own version and drifts independently of the
# top-level one. Both were 7.34.1 when this was written, but they are separate
# fields and a partial bump is the likelier future mistake.
pkg=$(python3 -c "
import json
d=json.load(open('$SERVER_JSON'))
print(next((p.get('version','') for p in d.get('packages',[]) if p.get('identifier')=='loki-mode'), 'MISSING'))
" 2>/dev/null)
if [ "$pkg" = "$want" ]; then
    ok "packages[loki-mode].version ($pkg) matches VERSION"
else
    bad "packages[loki-mode].version is $pkg but VERSION is $want"
fi

echo
echo "T2 -- the submission would be accepted"

# The registry enforces a 100-char description cap SERVER-SIDE. Exceeding it
# fails the submission after the founder has already done the interactive OAuth
# device-code dance, so it is worth catching here rather than there.
dlen=$(python3 -c "import json;print(len(json.load(open('$SERVER_JSON')).get('description','')))" 2>/dev/null)
if [ -n "$dlen" ] && [ "$dlen" -le 100 ] && [ "$dlen" -gt 0 ]; then
    ok "description is $dlen chars (server-side cap is 100)"
else
    bad "description length $dlen violates the 100-char registry cap"
fi

# The ownership marker in package.json is what proves to the registry that we
# control this namespace. Without it the submission is rejected outright.
mcpname=$(python3 -c "import json;print(json.load(open('$REPO_ROOT/package.json')).get('mcpName',''))" 2>/dev/null)
sname=$(python3 -c "import json;print(json.load(open('$SERVER_JSON')).get('name',''))" 2>/dev/null)
if [ -n "$mcpname" ] && [ "$mcpname" = "$sname" ]; then
    ok "package.json mcpName matches server.json name ($mcpname)"
else
    bad "ownership marker mismatch: package.json mcpName='$mcpname' vs server.json name='$sname'"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
