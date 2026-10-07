#!/usr/bin/env bash
# FC-30: a provider skill link that Loki created must follow the running
# install (dangling or pointing at another Loki install), and nothing else.
set -uo pipefail
export LOKI_NO_BROWSER=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/autonomy/lib/skill-link-heal.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup || true' EXIT
T="$LOKI_RUN_TMP"

PASS=0
FAIL=0
ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

if [ ! -f "$LIB" ]; then
    bad "autonomy/lib/skill-link-heal.sh exists"
    printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
    exit 1
fi

# The running install: a fake Loki install named like an npm one.
RUN="$T/new/node_modules/loki-mode"
mkdir -p "$RUN/autonomy"
: >"$RUN/SKILL.md"
: >"$RUN/autonomy/run.sh"
OLD="$T/old/node_modules/loki-mode"
mkdir -p "$OLD/autonomy"
: >"$OLD/SKILL.md"
: >"$OLD/autonomy/run.sh"

heal() { # home -> stderr to $T/err, stdout to $T/out
    HOME="$1" bash -c '. "$1"; loki_skill_link_heal "$2"' _ "$LIB" "$RUN" 2>"$T/err" >"$T/out"
}
resolved() { (cd "$1" 2>/dev/null && pwd -P); }
RUN_P="$(resolved "$RUN")"

# 1. dangling Loki link is repointed, one stderr line
H1="$T/h1"; mkdir -p "$H1/.claude/skills"
ln -s "$T/gone/node_modules/loki-mode" "$H1/.claude/skills/loki-mode"
heal "$H1"
if [ "$(resolved "$H1/.claude/skills/loki-mode")" = "$RUN_P" ] && [ "$(wc -l <"$T/err" | tr -d ' ')" = "1" ] && [ ! -s "$T/out" ]; then
    ok "dangling Loki link repointed with exactly one stderr line"
else
    bad "dangling Loki link repointed with exactly one stderr line"
fi
heal "$H1"
if [ ! -s "$T/err" ]; then ok "second run is a no-op with no log line"; else bad "second run is a no-op with no log line"; fi

# 2. link to a different Loki install is repointed
H2="$T/h2"; mkdir -p "$H2/.codex/skills"
ln -s "$OLD" "$H2/.codex/skills/loki-mode"
heal "$H2"
if [ "$(resolved "$H2/.codex/skills/loki-mode")" = "$RUN_P" ] && [ "$(wc -l <"$T/err" | tr -d ' ')" = "1" ]; then
    ok "link to a different Loki install repointed"
else
    bad "link to a different Loki install repointed"
fi

# 3. real directory untouched
H3="$T/h3"; mkdir -p "$H3/.claude/skills/loki-mode"
printf 'keep\n' >"$H3/.claude/skills/loki-mode/KEEP.txt"
heal "$H3"
if [ -d "$H3/.claude/skills/loki-mode" ] && [ ! -L "$H3/.claude/skills/loki-mode" ] \
    && [ -f "$H3/.claude/skills/loki-mode/KEEP.txt" ] && [ ! -s "$T/err" ]; then
    ok "real directory untouched"
else
    bad "real directory untouched"
fi

# 4. foreign links untouched (live and dangling)
H4="$T/h4"; mkdir -p "$H4/.claude/skills" "$H4/.codex/skills" "$T/foreign"
ln -s "$T/foreign" "$H4/.claude/skills/loki-mode"
ln -s /usr/share/nonexistent-x "$H4/.codex/skills/loki-mode"
heal "$H4"
if [ "$(readlink "$H4/.claude/skills/loki-mode")" = "$T/foreign" ] \
    && [ "$(readlink "$H4/.codex/skills/loki-mode")" = "/usr/share/nonexistent-x" ] && [ ! -s "$T/err" ]; then
    ok "foreign links untouched"
else
    bad "foreign links untouched"
fi

# 5. correct link is a no-op
H5="$T/h5"; mkdir -p "$H5/.claude/skills"
ln -s "$RUN" "$H5/.claude/skills/loki-mode"
heal "$H5"
if [ "$(readlink "$H5/.claude/skills/loki-mode")" = "$RUN" ] && [ ! -s "$T/err" ]; then
    ok "correct link is a no-op with no log line"
else
    bad "correct link is a no-op with no log line"
fi

# 6. opt-out
H6="$T/h6"; mkdir -p "$H6/.claude/skills"
ln -s "$T/gone/node_modules/loki-mode" "$H6/.claude/skills/loki-mode"
LOKI_NO_SKILL_LINK_HEAL=1 heal "$H6"
if [ "$(readlink "$H6/.claude/skills/loki-mode")" = "$T/gone/node_modules/loki-mode" ]; then
    ok "LOKI_NO_SKILL_LINK_HEAL=1 opts out"
else
    bad "LOKI_NO_SKILL_LINK_HEAL=1 opts out"
fi

# 7. a dev checkout as the running install never hijacks a link
H7="$T/h7"; mkdir -p "$H7/.claude/skills" "$T/devco/autonomy"
: >"$T/devco/SKILL.md"; : >"$T/devco/autonomy/run.sh"
ln -s "$T/gone/node_modules/loki-mode" "$H7/.claude/skills/loki-mode"
HOME="$H7" bash -c '. "$1"; loki_skill_link_heal "$2"' _ "$LIB" "$T/devco" 2>/dev/null
if [ "$(readlink "$H7/.claude/skills/loki-mode")" = "$T/gone/node_modules/loki-mode" ]; then
    ok "non-install running root does not repoint"
else
    bad "non-install running root does not repoint"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
