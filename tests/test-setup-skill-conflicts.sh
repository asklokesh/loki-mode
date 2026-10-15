#!/usr/bin/env bash
# shellcheck disable=SC2015
# setup-skill must never overwrite or write inside an existing provider path
# that is not already a valid Loki skill installation.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$ROOT/autonomy/loki"
TMP="$(mktemp -d -t loki-setup-skill-conflict-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

run_setup() {
    local home="$1"
    HOME="$home" NO_COLOR=1 LOKI_LEGACY_BASH=1 bash "$LOKI" setup-skill
}

# An existing non-empty directory used to make ln create a nested `loki-mode`
# link and return success, even though target/SKILL.md remained absent.
DIR_HOME="$TMP/directory-home"
DIR_TARGET="$DIR_HOME/.codex/skills/loki-mode"
mkdir -p "$DIR_TARGET"
printf '%s\n' 'operator-owned directory' >"$DIR_TARGET/KEEP.txt"
DIR_BEFORE="$(shasum -a 256 "$DIR_TARGET/KEEP.txt" | awk '{print $1}')"
DIR_OUT="$(run_setup "$DIR_HOME" 2>&1)"; DIR_RC=$?
DIR_AFTER="$(shasum -a 256 "$DIR_TARGET/KEEP.txt" | awk '{print $1}')"
if [ "$DIR_RC" -eq 1 ] \
    && [ "$DIR_BEFORE" = "$DIR_AFTER" ] \
    && [ "$(find "$DIR_TARGET" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -eq 1 ] \
    && printf '%s' "$DIR_OUT" | grep -q 'FAIL.*Codex CLI.*exists without SKILL.md'; then
    pass "existing directory is preserved and reported as a failed conflict"
else
    fail "existing directory was mutated or reported as installed"
fi

# A regular file at the target path is more severe: ln -sf used to replace it.
FILE_HOME="$TMP/file-home"
FILE_TARGET="$FILE_HOME/.codex/skills/loki-mode"
mkdir -p "$(dirname "$FILE_TARGET")"
printf '%s\n' 'operator-owned file' >"$FILE_TARGET"
FILE_BEFORE="$(shasum -a 256 "$FILE_TARGET" | awk '{print $1}')"
FILE_OUT="$(run_setup "$FILE_HOME" 2>&1)"; FILE_RC=$?
FILE_AFTER="$(shasum -a 256 "$FILE_TARGET" | awk '{print $1}')"
if [ "$FILE_RC" -eq 1 ] \
    && [ -f "$FILE_TARGET" ] && [ ! -L "$FILE_TARGET" ] \
    && [ "$FILE_BEFORE" = "$FILE_AFTER" ] \
    && printf '%s' "$FILE_OUT" | grep -q 'FAIL.*Codex CLI.*exists without SKILL.md'; then
    pass "existing file is preserved and reported as a failed conflict"
else
    fail "existing file was replaced or reported as installed"
fi

# A live symlink to unrelated operator content is also owned, not broken.
LINK_HOME="$TMP/link-home"
LINK_SOURCE="$TMP/operator-skill"
LINK_TARGET="$LINK_HOME/.codex/skills/loki-mode"
mkdir -p "$LINK_SOURCE" "$(dirname "$LINK_TARGET")"
printf '%s\n' 'operator-owned linked directory' >"$LINK_SOURCE/KEEP.txt"
ln -s "$LINK_SOURCE" "$LINK_TARGET"
LINK_OUT="$(run_setup "$LINK_HOME" 2>&1)"; LINK_RC=$?
if [ "$LINK_RC" -eq 1 ] \
    && [ -L "$LINK_TARGET" ] \
    && [ "$(readlink "$LINK_TARGET")" = "$LINK_SOURCE" ] \
    && printf '%s' "$LINK_OUT" | grep -q 'FAIL.*Codex CLI.*exists without SKILL.md'; then
    pass "live operator symlink is preserved and reported as a failed conflict"
else
    fail "live operator symlink was replaced or reported as installed"
fi

# A dangling link remains repairable, and a clean home still installs all four.
BROKEN_HOME="$TMP/broken-home"
BROKEN_TARGET="$BROKEN_HOME/.codex/skills/loki-mode"
mkdir -p "$(dirname "$BROKEN_TARGET")"
ln -s "$TMP/missing" "$BROKEN_TARGET"
BROKEN_OUT="$(run_setup "$BROKEN_HOME" 2>&1)"; BROKEN_RC=$?
if [ "$BROKEN_RC" -eq 0 ] \
    && [ -f "$BROKEN_TARGET/SKILL.md" ] \
    && printf '%s' "$BROKEN_OUT" | grep -q 'NEW.*Codex CLI'; then
    pass "dangling symlink is repaired"
else
    fail "dangling symlink was not repaired"
fi

CLEAN_HOME="$TMP/clean-home"
CLEAN_OUT="$(run_setup "$CLEAN_HOME" 2>&1)"; CLEAN_RC=$?
VALID=0
for provider in .claude .codex .cline .aider; do
    [ -f "$CLEAN_HOME/$provider/skills/loki-mode/SKILL.md" ] && VALID=$((VALID + 1))
done
if [ "$CLEAN_RC" -eq 0 ] && [ "$VALID" -eq 4 ] \
    && printf '%s' "$CLEAN_OUT" | grep -q 'Created 4 new skill symlink'; then
    pass "clean home installs all four provider skills"
else
    fail "clean installation behavior regressed"
fi

echo "Claude Code settings merge (setup-skill --claude-code)"
S="$TMP/cc-settings.json"
printf '{"model":"opus","enabledPlugins":{"other@x":true},"env":{"FOO":"1"}}\n' > "$S"
NO_COLOR=1 LOKI_LEGACY_BASH=1 bash "$LOKI" setup-skill --claude-code --settings "$S" --stop-hook >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && python3 - "$S" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["model"] == "opus" and d["enabledPlugins"]["other@x"] is True and d["env"]["FOO"] == "1"
assert d["enabledPlugins"]["loki-mode@loki-mode"] is True
assert d["extraKnownMarketplaces"]["loki-mode"]["source"]["repo"] == "asklokesh/loki-mode"
assert d["env"]["LOKI_STOP_VERIFY"] == "1"
PY
then pass "merge keeps existing keys and adds Loki keys"; else fail "merge failed rc=$rc"; fi
before="$(cat "$S")"
msg="$(NO_COLOR=1 LOKI_LEGACY_BASH=1 bash "$LOKI" setup-skill --claude-code --settings "$S" --stop-hook 2>&1)"
{ [ "$before" = "$(cat "$S")" ] && printf '%s' "$msg" | grep -q UNCHANGED; } && pass "second run is idempotent" || fail "not idempotent"
printf '{"enabledPlugins":{"loki-mode@loki-mode":false}}\n' > "$S"
NO_COLOR=1 LOKI_LEGACY_BASH=1 bash "$LOKI" setup-skill --claude-code --settings "$S" >/dev/null 2>&1
python3 -c 'import json,sys;assert json.load(open(sys.argv[1]))["enabledPlugins"]["loki-mode@loki-mode"] is False' "$S" \
    && pass "never overwrites a user's explicit value" || fail "overwrote user value"
printf '{not json' > "$S"
NO_COLOR=1 LOKI_LEGACY_BASH=1 bash "$LOKI" setup-skill --claude-code --settings "$S" >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 3 ] && [ "$(cat "$S")" = "{not json" ]; } && pass "refuses invalid JSON, file untouched" || fail "invalid JSON handling rc=$rc"
bash "$LOKI" setup-skill --claude-code --print | python3 -c 'import json,sys;json.load(sys.stdin)' && pass "--print emits valid JSON" || fail "--print invalid"


printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
