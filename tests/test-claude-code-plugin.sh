#!/usr/bin/env bash
# CCHOOKS: Claude Code plugin JSON validity, Stop hook fail-open / block
# behavior (stub verifier, no model calls), and idempotent settings merge.
# ok() only echoes and always succeeds, so `cond && ok || bad` is safe here.
# shellcheck disable=SC2015
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=/dev/null
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

PLUGIN="$REPO_ROOT/plugins/loki-mode"
HOOK="$PLUGIN/scripts/loki-stop-verify.sh"
SETUP="$REPO_ROOT/autonomy/claude-code-setup.sh"

echo "T1 -- JSON files parse"
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
for c in start verify handoff; do
    [ -f "$PLUGIN/commands/$c.md" ] && ok "command $c.md present" || bad "command $c.md missing"
done

echo "T2 -- Stop hook"
# A git repo with one tracked file and an uncommitted change.
R="$T/repo"; mkdir -p "$R"
git -C "$R" init -q
git -C "$R" config user.email t@example.com
git -C "$R" config user.name t
echo one > "$R/a.txt"
git -C "$R" add a.txt
git -C "$R" commit -q -m init
echo two >> "$R/a.txt"

# Stub verifier dirs. PATH keeps system tools so git and python3 resolve.
mkdir -p "$T/stub-fail" "$T/stub-pass" "$T/stub-slow"
printf '#!/bin/sh\necho "FAIL in 1ms (1 files, 0 cached)"\necho "  [high] secret a.txt:1 - hardcoded secret"\nexit 1\n' > "$T/stub-fail/loki"
printf '#!/bin/sh\necho "PASS in 1ms"\nexit 0\n' > "$T/stub-pass/loki"
printf '#!/bin/sh\nsleep 30\nexit 1\n' > "$T/stub-slow/loki"
chmod +x "$T/stub-fail/loki" "$T/stub-pass/loki" "$T/stub-slow/loki"

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

out="$(cd "$R" && echo '{}' | env -u LOKI_STOP_VERIFY -u CLAUDE_PLUGIN_OPTION_STOP_VERIFY PATH="$T/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "no-op when not opted in" || bad "not opted in: rc=$rc out=$out"

out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$T/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert d["decision"] == "block" and "hardcoded secret" in d["reason"]
' 2>/dev/null; then ok "blocks with failing stub verifier and names the finding"; else bad "block: rc=$rc out=$out"; fi

out="$(cd "$R" && echo '{"stop_hook_active": true}' | LOKI_STOP_VERIFY=1 PATH="$T/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "allows when stop_hook_active (no loop)" || bad "active: rc=$rc out=$out"

out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$T/stub-pass:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "allows on PASS" || bad "pass: rc=$rc out=$out"

out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 LOKI_STOP_VERIFY_TIMEOUT=1 PATH="$T/stub-slow:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "fails open on timeout" || bad "timeout: rc=$rc out=$out"

git -C "$R" checkout -q -- a.txt
out="$(cd "$R" && echo '{}' | LOKI_STOP_VERIFY=1 PATH="$T/stub-fail:$SAFE_PATH" bash "$HOOK")"; rc=$?
{ [ "$rc" -eq 0 ] && [ -z "$out" ]; } && ok "allows on a clean tree" || bad "clean: rc=$rc out=$out"

echo "T3 -- settings merge"
S="$T/settings.json"
printf '{"model":"opus","enabledPlugins":{"other@x":true},"env":{"FOO":"1"}}\n' > "$S"
bash "$SETUP" --settings "$S" --stop-hook >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && python3 - "$S" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["model"] == "opus" and d["enabledPlugins"]["other@x"] is True and d["env"]["FOO"] == "1"
assert d["enabledPlugins"]["loki-mode@loki-mode"] is True
assert d["extraKnownMarketplaces"]["loki-mode"]["source"]["repo"] == "asklokesh/loki-mode"
assert d["env"]["LOKI_STOP_VERIFY"] == "1"
PY
then ok "merge keeps existing keys and adds Loki keys"; else bad "merge failed rc=$rc"; fi
before="$(cat "$S")"
msg="$(bash "$SETUP" --settings "$S" --stop-hook 2>&1)"
{ [ "$before" = "$(cat "$S")" ] && printf '%s' "$msg" | grep -q UNCHANGED; } && ok "second run is idempotent" || bad "not idempotent"
printf '{"enabledPlugins":{"loki-mode@loki-mode":false}}\n' > "$S"
bash "$SETUP" --settings "$S" >/dev/null 2>&1
python3 -c 'import json,sys;assert json.load(open(sys.argv[1]))["enabledPlugins"]["loki-mode@loki-mode"] is False' "$S" \
    && ok "never overwrites a user's explicit value" || bad "overwrote user value"
printf '{not json' > "$S"
bash "$SETUP" --settings "$S" >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 3 ] && [ "$(cat "$S")" = "{not json" ]; } && ok "refuses invalid JSON, file untouched" || bad "invalid JSON handling rc=$rc"
bash "$SETUP" --print | python3 -c 'import json,sys;json.load(sys.stdin)' && ok "--print emits valid JSON" || bad "--print invalid"

echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
