#!/usr/bin/env bash
# The PACKAGED MCP server must expose the exact tool surface, by name.
#
# THE DEFECT THIS EXISTS FOR (A-004, contract drift). Published v9.12.6 Docker
# discovery returns 36 tools. README.md, wiki/, COMPONENTS.md, CLAUDE.md and
# server.json all said 34. Nothing in the repo or in CI could tell which number
# was true, because the only existing MCP handshake check (scripts/local-ci.sh)
# asserts `len(tools) > 0`. A minimum-count assertion cannot detect drift in
# either direction: it passes at 34, at 36, and at 1.
#
# Per CLAUDE.md ("assert each required thing individually, never a count"), a
# threshold cannot say WHICH tool vanished. A user whose client silently lost
# loki_verify_fast sees a count of 35 and no name.
#
# WHY THE REPO CHECK IS NOT ENOUGH. The existing handshake runs mcp/server.py
# from the git checkout. Everything works from a checkout. The blind spot named
# in CLAUDE.md is the SHIPPED ARTIFACT: four gate detectors were absent from
# files[] for months while every in-repo test passed. So this builds the real
# tarball with `npm pack`, extracts it, and handshakes against the server.py
# inside the extracted package tree -- the file an npm user actually executes.
#
# THE CONTRACT IS FROZEN HERE, NOT DERIVED. An earlier revision of this test
# derived the expected names by AST-scanning mcp/*.py. That is circular: the
# mutable source is both the claim and its own proof. Renaming a tool in
# server.py moves the expectation with it, so a same-count rename passes and
# the published contract silently breaks for every existing client. The 36
# names below are a reviewed, source-controlled constant. Changing this list is
# a deliberate, reviewable contract change; changing server.py alone is drift
# and MUST fail here. Both sides are asserted against the frozen list:
#   source registration names  == CONTRACT
#   packaged initialize/tools-list names == CONTRACT
# so drift on either side is named, and drift on both at once cannot cancel out.
#
# FAIL-CLOSED. This is a required FAST-tier release gate. Absent npm, absent
# MCP SDK, an unbuildable tarball or an empty handshake are UNAVAILABLE
# MEASUREMENTS, not evidence of a healthy surface, and each exits nonzero.
# Nothing here installs anything or touches the network beyond `npm pack`,
# which packs the local working tree.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
die() { bad "$1"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }

echo "TEST: packaged MCP server exposes the exact tool surface"

WORK=""
# ponytail: cleanup guarded on $$ so the trap is a no-op in subshells.
cleanup() { [ "$$" = "$MAIN_PID" ] && [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
MAIN_PID=$$
trap cleanup EXIT

# --- 0. THE FROZEN CONTRACT -------------------------------------------------
# The 36 published tool names, sorted. Reviewed constant -- see header.
# A tool added or renamed in mcp/*.py without an accompanying reviewed edit
# here is contract drift and fails below, by name, on both sides.
CONTRACT="$(cat <<'CONTRACT_EOF'
loki_agent_metrics
loki_checkpoint_restore
loki_code_search
loki_code_search_stats
loki_complete_task
loki_consolidate_memory
loki_counter_evidence_template
loki_findings
loki_get_co_changes
loki_get_doc_coverage
loki_get_hotspots
loki_graph_query
loki_learnings
loki_magic_debate
loki_magic_generate
loki_magic_get
loki_magic_list
loki_magic_stats
loki_magic_tokens_extract
loki_magic_update
loki_memory_capture_session_summary
loki_memory_redact
loki_memory_retrieve
loki_memory_store_pattern
loki_metrics_efficiency
loki_project_status
loki_quality_report
loki_start_project
loki_state_get
loki_task_queue_add
loki_task_queue_list
loki_task_queue_update
loki_verify_fast
mem_get
mem_search
mem_timeline
CONTRACT_EOF
)"
CONTRACT_N="$(printf '%s\n' "$CONTRACT" | wc -l | tr -d ' ')"

# Self-check: the frozen list must be sorted and duplicate-free, or the comm(1)
# set comparisons below silently under-report differences.
#
# Compare the LITERAL to its own sorted-unique form. Comparing `sort -u` to
# `sort` (an earlier revision) sorts BOTH sides, so it detects a duplicate but
# is blind to misordering -- the exact property comm(1) depends on. Against the
# literal, either defect differs and is caught.
if [ "$(printf '%s\n' "$CONTRACT")" != "$(printf '%s\n' "$CONTRACT" | LC_ALL=C sort -u)" ]; then
    die "frozen CONTRACT list is not sorted/unique -- set comparison would be unsound"
fi
ok "frozen contract lists $CONTRACT_N tool names (sorted, unique)"

# --- 1. SOURCE side: registered names must equal the frozen contract ---------
# Decorator scan of server.py + the magic module's _TOOLS tuple + the managed
# tool. Parsed with ast, not regex, so a commented-out decorator cannot inflate
# the result. This is the CLAIM being checked, never the expectation.
SOURCE="$(python3 - <<'PYDERIVE'
import ast, sys

names = []

# in-file: every @mcp.tool()-decorated coroutine in mcp/server.py
tree = ast.parse(open("mcp/server.py").read())
for node in ast.walk(tree):
    if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
        continue
    for dec in node.decorator_list:
        # matches @mcp.tool()
        f = dec.func if isinstance(dec, ast.Call) else dec
        if isinstance(f, ast.Attribute) and f.attr == "tool":
            names.append(node.name)
            break

# magic: the _TOOLS tuple names them explicitly
mtree = ast.parse(open("mcp/magic_tools.py").read())
for node in ast.walk(mtree):
    if isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == "_TOOLS" for t in node.targets
    ):
        for elt in node.value.elts:
            names.append(elt.elts[1].value)

# managed: registered unconditionally inside register_managed_tools
gtree = ast.parse(open("mcp/managed_tools.py").read())
for node in ast.walk(gtree):
    if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
        continue
    for dec in node.decorator_list:
        f = dec.func if isinstance(dec, ast.Call) else dec
        if isinstance(f, ast.Attribute) and f.attr == "tool":
            names.append(node.name)
            break

if not names:
    sys.exit(1)
print("\n".join(sorted(set(names))))
PYDERIVE
)"

# Vacuity guard: an empty scan is an absent measurement, not a clean surface.
[ -n "$SOURCE" ] || die "AST scan of mcp/*.py registered NO tools -- measurement unavailable"

diff_surface() {  # $1=label  $2=expected(contract)  $3=actual
    local label="$1" missing extra
    missing="$(comm -23 <(printf '%s\n' "$2") <(printf '%s\n' "$3"))"
    extra="$(comm -13 <(printf '%s\n' "$2") <(printf '%s\n' "$3"))"
    if [ -n "$missing" ]; then
        while IFS= read -r t; do
            [ -n "$t" ] && bad "$label: contract tool MISSING: $t"
        done <<< "$missing"
    fi
    if [ -n "$extra" ]; then
        while IFS= read -r t; do
            [ -n "$t" ] && bad "$label: tool present but NOT in the frozen contract: $t"
        done <<< "$extra"
    fi
    [ -z "$missing" ] && [ -z "$extra" ]
}

SOURCE_N="$(printf '%s\n' "$SOURCE" | wc -l | tr -d ' ')"
if diff_surface "source registration" "$CONTRACT" "$SOURCE"; then
    ok "source registers exactly the $CONTRACT_N contract tools, by name"
else
    bad "source registration ($SOURCE_N names) does not match the frozen contract ($CONTRACT_N)"
fi

# --- 2. build and extract the real tarball ----------------------------------
# FAIL-CLOSED: no npm means the artifact cannot be measured. A required release
# gate that cannot measure must not report green.
command -v npm >/dev/null 2>&1 \
    || die "npm unavailable -- cannot build the packaged artifact; required gate fails closed"

WORK="$(mktemp -d -t loki-mcp-pkg-XXXX)" || die "could not create a work directory"

# npm pack writes the tarball NAME to stdout and its progress chatter to stderr.
# Keep them separate: `2>&1 >file` would capture chatter as the filename.
TARBALL="$(npm pack --pack-destination "$WORK" 2>/dev/null | tail -1)"
[ -n "$TARBALL" ] && [ -f "$WORK/$TARBALL" ] || die "npm pack produced no tarball"
ok "npm pack produced $TARBALL"

tar xzf "$WORK/$TARBALL" -C "$WORK" || die "could not extract tarball"

PKG_SERVER="$WORK/package/mcp/server.py"
# Vacuity guard: a missing server.py must FAIL, never skip. An absent file is
# not evidence of a healthy surface; it is the exact packaging defect.
[ -f "$PKG_SERVER" ] || die "packaged tarball has no mcp/server.py -- MCP server is not shipped"
ok "packaged tarball contains mcp/server.py"

# --- 3. real initialize -> tools/list against the PACKAGED server ------------
# Same spawn shape as the shipped launcher (autonomy/mcp-launch.sh): file-exec
# of server.py with PYTHONPATH set to the package root, from a NON-package cwd.
#
# FAIL-CLOSED: an absent MCP SDK means the handshake cannot run, so the shipped
# surface is UNMEASURED. Previously this exited 0, which is the false-green this
# gate exists to prevent. Nothing is installed here -- the host must provide the
# SDK for the gate to be satisfiable.
python3 -c 'import mcp' >/dev/null 2>&1 \
    || die "MCP SDK not importable -- packaged handshake unmeasurable; required gate fails closed"

ACTUAL="$(cd "$WORK" && LOKI_PKG="$WORK/package" python3 - <<'PYHS' 2>/dev/null
import asyncio, os, sys
pkg = os.environ["LOKI_PKG"]
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def run():
    env = dict(os.environ)
    env["PYTHONPATH"] = pkg + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    params = StdioServerParameters(
        command=sys.executable,
        args=[os.path.join(pkg, "mcp", "server.py"), "--transport", "stdio"],
        env=env,
    )
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tl = await s.list_tools()
            return sorted(t.name for t in tl.tools)

print("\n".join(asyncio.run(run())))
PYHS
)"

[ -n "$ACTUAL" ] || die "packaged MCP handshake returned NO tools (initialize or tools/list failed)"
ACTUAL_N="$(printf '%s\n' "$ACTUAL" | wc -l | tr -d ' ')"
ok "packaged server completed initialize -> tools/list ($ACTUAL_N tools)"

# --- 4. PACKAGE side: assert the EXACT frozen surface, naming every diff -----
if diff_surface "packaged server" "$CONTRACT" "$ACTUAL"; then
    ok "packaged surface matches the frozen contract exactly, all $CONTRACT_N tools by name"
else
    bad "packaged surface ($ACTUAL_N names) does not match the frozen contract ($CONTRACT_N)"
fi

# --- 5. the public docs must state the frozen count, and ONLY it -------------
# The drift that started A-004: source shipped 36, every doc said 34, and no
# check compared them. Assert against the FROZEN count, so a doc edit and a
# source edit cannot agree with each other while both diverge from the contract.
#
# ONE list, TWO assertions per entry. An earlier revision ran two loops over two
# DIFFERENT file lists: all eight surfaces were checked for the PRESENCE of 36,
# but only three were checked for the ABSENCE of a stale count. That false-greens
# on a contradictory document -- a README carrying both a correct "36 tools" and
# a leftover "34 tools" satisfied the presence check and was never residual-
# scanned. Presence and absence are not the same claim, and every current surface
# needs both: the correct count being SOMEWHERE on the page says nothing about
# what else the page still tells a reader.
#
# The walkthrough pages are here because they are CURRENT public surfaces: the
# rendered architecture diagram and the competitor comparison table both
# advertise a tool count. They also state it in several places each (SVG label,
# tooltip description, tooltip tags, table cell), which is how a partial fix
# hides. Historical surfaces (CHANGELOG, artifacts/, dated plans such as
# docs/V8-AGENT-SDK-PLAN.md and the dated docs/competitive/ reports) are
# deliberately NOT listed -- a past snapshot describing the surface AT THAT TIME
# is accurate and must not be rewritten. docs/RARV-C-CHANGE-MAP.md is historical
# for the same reason: its own line 3 reads "SUPERSEDED ... Kept as history", so
# its ~34-tool anchors are a correct v7.121.5 snapshot, not drift.
#
# ponytail: a newline-delimited string, not an array -- bash 3.2 has no mapfile
# and this reads the same as the CONTRACT list above. Iterated with `<<<` and
# never `printf | while`, which would subshell the body and lose PASS/FAIL.
CURRENT_SURFACES="$(cat <<'SURFACES_EOF'
README.md
wiki/Home.md
wiki/CLI-Reference.md
server.json
COMPONENTS.md
CLAUDE.md
docs/walkthrough/architecture.html
docs/walkthrough/comparison.html
docs/WANG-PRINCIPLES-PLAN.md
SURFACES_EOF
)"

while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || die "$f is missing -- documented public surface unmeasurable"

    # 5a. PRESENCE: the frozen count must be stated.
    if grep -qE "(^|[^0-9])${CONTRACT_N}([ -]tools?| MCP tools)" "$f"; then
        ok "$f states the frozen tool count ($CONTRACT_N)"
    else
        bad "$f does not state the frozen tool count ($CONTRACT_N) -- doc drift"
    fi

    # 5b. ABSENCE: no OTHER tool count may survive on a current surface.
    # Detector and exclusion cover the same two phrasings, so a stale count
    # cannot hide behind the phrasing the detector does not read.
    STALE="$(grep -nE "[0-9]+([ -]tools?| MCP tools)" "$f" \
             | grep -vE "(^|[^0-9])${CONTRACT_N}([ -]tools?| MCP tools)")"
    if [ -n "$STALE" ]; then
        while IFS= read -r line; do
            [ -n "$line" ] && bad "$f states a tool count other than the frozen $CONTRACT_N: $line"
        done <<< "$STALE"
    else
        ok "$f states no tool count other than the frozen $CONTRACT_N"
    fi
done <<< "$CURRENT_SURFACES"

echo "  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
