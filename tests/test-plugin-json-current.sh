#!/usr/bin/env bash
# shellcheck disable=SC2015
# plugin.json must track VERSION, or plugin updates pin users to a stale build.
#
# WHY THIS EXISTS. plugins/loki-mode/.claude-plugin/plugin.json carries the
# version Claude Code reads to decide whether an installed plugin is out of
# date. It was added to the release checklist in v7.39.0 precisely because it
# "pins plugin updates, must track VERSION" -- and then drifted anyway: it sat
# at 9.22.10 while the repo shipped 9.22.11, 9.22.12 and 9.22.13. Three
# consecutive releases bumped VERSION and left this file behind.
#
# The failure mode is the same quiet one that let server.json drift past thirty
# releases: nothing breaks locally, no gate goes red, and the cost lands on
# users whose plugin never offers the update. A checklist entry did not prevent
# it, which is the whole argument for testing the invariant instead of
# documenting it. See tests/test-server-json-current.sh for the sibling case.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

PLUGIN_JSON="$REPO_ROOT/plugins/loki-mode/.claude-plugin/plugin.json"
VERSION_FILE="$REPO_ROOT/VERSION"

if [ ! -f "$PLUGIN_JSON" ]; then
    echo "  [SKIP] plugin.json not present"
    echo "Results: 0 passed, 0 failed, 0 total"
    exit 0
fi

want="$(tr -d ' \n' < "$VERSION_FILE")"

echo "T1 -- plugin.json tracks VERSION"

# Assert the value individually rather than counting matches: a threshold
# cannot say WHICH file drifted, and picks up slack it was never meant to have.
got=$(python3 -c "import json;print(json.load(open('$PLUGIN_JSON'))['version'])" 2>/dev/null)
if [ -z "$got" ]; then
    bad "plugin.json version could not be read -- an empty result is an absent measurement, not a pass"
elif [ "$got" = "$want" ]; then
    ok "plugin.json version ($got) matches VERSION"
else
    bad "plugin.json version is $got but VERSION is $want -- plugin updates would pin users to a stale build"
fi

echo
echo "T2 -- the manifest stays installable"

# A malformed manifest is unusable regardless of its version, and this file is
# edited by release automation on every bump.
if python3 -c "import json;json.load(open('$PLUGIN_JSON'))" >/dev/null 2>&1; then
    ok "plugin.json is valid JSON"
else
    bad "plugin.json is not valid JSON"
fi

name=$(python3 -c "import json;print(json.load(open('$PLUGIN_JSON')).get('name',''))" 2>/dev/null)
if [ "$name" = "loki-mode" ]; then
    ok "plugin name is loki-mode"
else
    bad "plugin name is '$name', expected loki-mode"
fi

echo
echo "T3 -- the manifest does not re-declare auto-loaded components"

# WHY: Claude Code loads hooks/hooks.json from the plugin root automatically.
# Naming that same standard path in manifest.hooks registers it TWICE and the
# loader rejects the whole plugin:
#   "Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file"
# Every skill, command and the MCP server die with it, so the plugin is inert
# for every marketplace user while `claude plugin install` still reports success
# (issue #195, reported against 9.22.10). manifest.hooks is only for hook files
# BEYOND the standard one. Assert the standard path is not re-declared, rather
# than asserting the key is absent outright, so a genuine EXTRA hook file stays
# legal.
hooks_decl=$(python3 -c "
import json
d=json.load(open('$PLUGIN_JSON'))
h=d.get('hooks')
if h is None: print('')
elif isinstance(h,str): print(h)
elif isinstance(h,list): print('\\n'.join(x for x in h if isinstance(x,str)))
else: print('INLINE')
" 2>/dev/null)

if [ -f "$REPO_ROOT/plugins/loki-mode/hooks/hooks.json" ]; then
    ok "the standard hooks/hooks.json exists (auto-loaded by Claude Code)"
    case "$hooks_decl" in
        *"hooks/hooks.json"*)
            bad "manifest re-declares the auto-loaded hooks/hooks.json -- plugin will fail to load (issue #195)" ;;
        *)
            ok "manifest does not re-declare the auto-loaded hooks path" ;;
    esac
else
    ok "no standard hooks/hooks.json present; nothing to double-register"
fi

echo
# CCHOOKS additions: Stop hook and command checks (stub verifier, no model calls).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
PLUGIN="$REPO_ROOT/plugins/loki-mode"
HOOK="$PLUGIN/scripts/loki-stop-verify.sh"
HT="$(mktemp -d -t loki-plugin-hook-XXXXXX)"
trap 'rm -rf "$HT"' EXIT
export LOKI_NO_BROWSER=1

echo "T4 -- plugin JSON and commands (Claude Code interop)"
for f in "$PLUGIN/.claude-plugin/plugin.json" "$PLUGIN/.mcp.json" "$PLUGIN/hooks/hooks.json"; do
    if python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$f" 2>/dev/null; then
        ok "parses: ${f#"$REPO_ROOT"/}"
    else
        bad "does not parse: $f"
    fi
done
if python3 - "$PLUGIN/hooks/hooks.json" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))["hooks"]
cmd = h["Stop"][0]["hooks"][0]
assert "loki-stop-verify.sh" in cmd["command"] and cmd["timeout"] <= 60
PY
then ok "Stop hook registered with a short timeout"; else bad "Stop hook missing or timeout too long"; fi
for c in start loki-verify handoff; do
    [ -f "$PLUGIN/commands/$c.md" ] && ok "command $c.md present" || bad "command $c.md missing"
done

echo "T5 -- Stop hook fails open, blocks only on verifier FAIL"
# A git repo with one tracked file and an uncommitted change.
R="$HT/repo"; mkdir -p "$R"
git -C "$R" init -q
git -C "$R" config user.email t@example.com
git -C "$R" config user.name t
echo one > "$R/a.txt"
git -C "$R" add a.txt
git -C "$R" commit -q -m init
echo two >> "$R/a.txt"

# Stub verifier dirs. PATH keeps system tools so git and python3 resolve.
mkdir -p "$HT/stub-fail" "$HT/stub-pass" "$HT/stub-slow"
printf '#!/bin/sh\necho "FAIL in 1ms (1 files, 0 cached)"\necho "  [high] secret a.txt:1 - hardcoded secret"\nexit 1\n' > "$HT/stub-fail/loki"
printf '#!/bin/sh\necho "PASS in 1ms"\nexit 0\n' > "$HT/stub-pass/loki"
printf '#!/bin/sh\nsleep 30\nexit 1\n' > "$HT/stub-slow/loki"
chmod +x "$HT/stub-fail/loki" "$HT/stub-pass/loki" "$HT/stub-slow/loki"

# Build a PATH with git/python3/tools but no real loki.
SAFE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
for tool in git python3; do
    d="$(dirname "$(command -v "$tool")")"
    case ":$SAFE_PATH:" in *":$d:"*) ;; *) SAFE_PATH="$SAFE_PATH:$d" ;; esac
done
if PATH="$SAFE_PATH" command -v loki >/dev/null 2>&1; then
    echo "  [SKIP] a real loki is on the minimal PATH; fail-open check skipped"
else
    out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$SAFE_PATH" bash "$HOOK")"; rc=$?
    { [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "fails open without loki on PATH" || bad "no-loki: rc=$rc out=$out"
fi

out="$(cd "$R" && echo '{}' | env -u LOKI_STOP_VERIFY -u CLAUDE_PLUGIN_OPTION_STOP_VERIFY PATH="$HT/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "no-op when not opted in" || bad "not opted in: rc=$rc out=$out"

out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$HT/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["decision"] == "block" and "hardcoded secret" in d["reason"]
' 2>/dev/null; then ok "blocks with failing stub verifier and names the finding"; else bad "block: rc=$rc out=$out"; fi

out="$(cd "$R" && echo '{"stop_hook_active": true}' | LOKI_STOP_VERIFY=1 PATH="$HT/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "allows when stop_hook_active (no loop)" || bad "active: rc=$rc out=$out"

out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$HT/stub-pass:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "allows on PASS" || bad "pass: rc=$rc out=$out"

out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 LOKI_STOP_VERIFY_TIMEOUT=1 PATH="$HT/stub-slow:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "fails open on timeout" || bad "timeout: rc=$rc out=$out"

git -C "$R" checkout -q -- a.txt
out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$HT/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "allows on a clean tree" || bad "clean: rc=$rc out=$out"

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
