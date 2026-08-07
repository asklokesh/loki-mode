#!/usr/bin/env bash
# `loki readiness --fix` repairs what it can, and REFUSES what it cannot.
#
# WHY. A scorecard that only reports is a diagnosis with no treatment. Factory's
# insight is the pair: /readiness-report tells you the repo cannot verify an
# agent's work, /readiness-fix does something about it. Their docs are blunt
# that this is the precondition, not a nicety -- Missions require readiness
# Level 4+ because "without it, the mission cannot reliably verify its own
# work". Readiness is a property of the ENVIRONMENT, not of the agent.
#
# TEST 2 IS THE LOAD-BEARING ONE, and it is a refusal.
#
# The tempting version of --fix generates everything, so the score goes green.
# For three criteria that is a LIE with a specific mechanism: writing
# `"test": "npm test"` into a repo with no runner produces a command that fails
# forever, and this very check would then report test_command PRESENT. The score
# improves while the capability it stands for is still absent -- a false green
# manufactured by the tool meant to detect one. A lockfile must come from the
# real package manager; a CI config that runs a nonexistent command is worse
# than none.
#
# So --fix writes only files whose correct content is derivable from the repo
# itself (README.md, AGENTS.md, .gitignore, as TODO stubs) and names the rest as
# skipped with the reason.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AR="$REPO_ROOT/autonomy/lib/agent_readiness.py"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: readiness --fix repairs what it can and refuses what it cannot"

[ -f "$AR" ] || { echo "  FAIL: $AR missing"; exit 1; }

_bare() { local d; d="$(mktemp -d)"; git init -q "$d" 2>/dev/null; printf '%s' "$d"; }

# --- 1. It actually repairs -------------------------------------------------
T="$(_bare)"
_before="$(python3 "$AR" "$T" --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["criteria_present"])')"
python3 "$AR" "$T" --fix >/dev/null 2>&1
_after="$(python3 "$AR" "$T" --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["criteria_present"])')"
if [ "${_before:-9}" -lt "${_after:-0}" ]; then
    ok "--fix raised readiness from $_before to $_after of 6"
else
    bad "--fix changed nothing ($_before -> $_after)"
fi

# --- 2. THE REFUSAL: it must NOT fabricate a test command -------------------
# The whole point. If a generated package.json made test_command "present", the
# tool would be manufacturing the false green it exists to detect.
if [ -f "$T/package.json" ]; then
    bad "--fix wrote a package.json -- an invented test command reports present for something that does not run"
else
    ok "--fix refused to invent a package.json / test command"
fi
_tc="$(python3 "$AR" "$T" --json 2>/dev/null \
       | python3 -c 'import json,sys;print("no" if "test_command" in json.load(sys.stdin)["missing"] else "yes")')"
if [ "$_tc" = "no" ]; then
    ok "test_command is still reported MISSING after --fix (honest)"
else
    bad "test_command reads present after --fix -- the score went green on a capability that is absent"
fi
for f in package-lock.json .github; do
    if [ -e "$T/$f" ]; then
        bad "--fix fabricated $f"
    else
        ok "--fix refused to fabricate $f"
    fi
done

# --- 3. The skips are NAMED, not silent -------------------------------------
# An unexplained non-fix teaches the user nothing. Each refusal states why.
_out="$(python3 "$AR" "$T" --fix 2>&1)"
if printf '%s' "$_out" | grep -q "skipped  test_command"; then
    ok "the refusal is reported with its reason, not silently dropped"
else
    bad "--fix skipped a criterion without saying so"
fi

# --- 4. Idempotent: a second --fix does not rewrite or duplicate ------------
_readme_before="$(cat "$T/README.md" 2>/dev/null | wc -c | tr -d ' ')"
printf 'EDITED BY A HUMAN\n' >> "$T/README.md"
_edited="$(cat "$T/README.md" | wc -c | tr -d ' ')"
python3 "$AR" "$T" --fix >/dev/null 2>&1
_after2="$(cat "$T/README.md" | wc -c | tr -d ' ')"
if [ "$_after2" = "$_edited" ]; then
    ok "a second --fix does not clobber a file the user has edited"
else
    bad "--fix overwrote an existing README ($_edited -> $_after2 bytes)"
fi
rm -rf "$T"

# --- 5. Re-measures AFTER fixing, not before --------------------------------
# Reporting the pre-fix score beside "wrote README.md" would be internally
# contradictory, and the number is the thing users act on.
T="$(_bare)"
_json="$(python3 "$AR" "$T" --fix --json 2>/dev/null)"
if printf '%s' "$_json" | python3 -c '
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if "readme" not in d.get("missing",[]) and d.get("fix",{}).get("written") else 1)' 2>/dev/null; then
    ok "the reported score reflects the state AFTER the fix"
else
    bad "--fix reports the pre-fix score alongside its own writes"
fi
rm -rf "$T"

# --- 6. Without --fix it stays read-only ------------------------------------
T="$(_bare)"
python3 "$AR" "$T" >/dev/null 2>&1
_n="$(find "$T" -mindepth 1 -not -path '*/.git*' | wc -l | tr -d ' ')"
if [ "${_n:-1}" -eq 0 ]; then
    ok "a plain readiness run writes nothing"
else
    bad "readiness wrote $_n path(s) without --fix"
fi
rm -rf "$T"

# --- 7. The CLI passes --fix through, and its help does not lie -------------
# Captured to a variable first, NOT piped into `grep -q`. Under `set -o
# pipefail`, grep -q exits on the first match, the upstream `loki --help` dies
# of SIGPIPE, and the pipeline reports non-zero even though the pattern MATCHED
# -- so this read "undocumented" while the help plainly contained the flag.
# Same inversion that bit the mutation-probe suite this morning.
_help="$(bash "$LOKI" readiness --help 2>&1)"
if printf '%s' "$_help" | grep -qF -- "--fix"; then
    ok "loki readiness --help documents --fix"
else
    bad "--fix is undocumented"
fi
if printf '%s' "$_help" | grep -qF "Read-only: it never writes"; then
    bad "help still claims read-only, which --fix makes false"
else
    ok "help no longer claims unconditional read-only"
fi

# --- 8. Syntax --------------------------------------------------------------
python3 -c "import ast;ast.parse(open('$AR').read())" 2>/dev/null \
    && ok "agent_readiness.py parses" || bad "agent_readiness.py has a syntax error"
bash -n "$LOKI" 2>/dev/null && ok "autonomy/loki parses" || bad "autonomy/loki has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
