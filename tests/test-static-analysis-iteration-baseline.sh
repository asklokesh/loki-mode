#!/usr/bin/env bash

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d -t loki-static-baseline.XXXXXX)"
PASS=0
FAIL=0
cleanup() { rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

FUNCTIONS="$TMPROOT/functions.sh"
awk '/^_loki_with_deadline\(\)/,/^\}/' "$ROOT/autonomy/run.sh" > "$FUNCTIONS"
awk '/^_loki_snapshot_workspace_tree\(\)/,/^\}/' "$ROOT/autonomy/run.sh" >> "$FUNCTIONS"
awk '/^has_npm_lint_script\(\)/,/^\}/' "$ROOT/autonomy/run.sh" >> "$FUNCTIONS"
awk '/^enforce_static_analysis\(\)/,/^\}/' "$ROOT/autonomy/run.sh" >> "$FUNCTIONS"
log_info() { :; }
log_warn() { :; }
log_error() { :; }
SCRIPT_DIR="$ROOT/autonomy"
source "$FUNCTIONS"

make_repo() {
    local name="$1"
    local tree="$TMPROOT/$name"
    mkdir -p "$tree"
    git -C "$tree" init -q
    git -C "$tree" config user.name test
    git -C "$tree" config user.email test@example.invalid
    printf '%s\n' 'const value = 1;' > "$tree/app.js"
    git -C "$tree" add app.js
    git -C "$tree" commit -qm baseline
    printf '%s\n' "$tree"
}

MODIFIED="$(make_repo modified)"
MODIFIED_BASE="$(git -C "$MODIFIED" rev-parse HEAD)"
printf '%s\n' 'const broken = ;' > "$MODIFIED/app.js"
if TARGET_DIR="$MODIFIED" _LOKI_ITER_START_SHA="$MODIFIED_BASE" enforce_static_analysis; then
    bad "modified file after the iteration baseline was not checked"
else
    ok "modified file after the iteration baseline is checked"
fi

UNTRACKED="$(make_repo untracked)"
UNTRACKED_BASE="$(git -C "$UNTRACKED" rev-parse HEAD)"
printf '%s\n' 'const broken = ;' > "$UNTRACKED/new.js"
if TARGET_DIR="$UNTRACKED" _LOKI_ITER_START_SHA="$UNTRACKED_BASE" enforce_static_analysis; then
    bad "untracked source file was not checked"
else
    ok "untracked source file is checked"
fi

VALID="$(make_repo valid)"
VALID_BASE="$(git -C "$VALID" rev-parse HEAD)"
printf '%s\n' 'const value = 2;' > "$VALID/app.js"
if TARGET_DIR="$VALID" _LOKI_ITER_START_SHA="$VALID_BASE" enforce_static_analysis; then
    ok "valid modified source passes"
else
    bad "valid modified source failed"
fi

EMOJI_SOURCE="$(make_repo emoji-source)"
EMOJI_BASE="$(git -C "$EMOJI_SOURCE" rev-parse HEAD)"
python3 - "$EMOJI_SOURCE/app.js" <<'PYEOF'
import sys
from pathlib import Path
Path(sys.argv[1]).write_text('const icon = "' + chr(0x1F3AF) + '";\n', encoding='utf-8')
PYEOF
if TARGET_DIR="$EMOJI_SOURCE" _LOKI_ITER_START_SHA="$EMOJI_BASE" enforce_static_analysis; then
    bad "emoji character in changed product source was not blocked"
elif grep -q 'emoji_character:app.js:1' "$EMOJI_SOURCE/.loki/quality/static-analysis.json"; then
    ok "emoji character is rejected deterministically before semantic review"
else
    bad "emoji character blocked without actionable file and line evidence"
fi

DEAD_LINK="$(make_repo dead-link)"
DEAD_LINK_BASE="$(git -C "$DEAD_LINK" rev-parse HEAD)"
printf '%s\n' '<a href="#">Pricing</a>' > "$DEAD_LINK/index.html"
if TARGET_DIR="$DEAD_LINK" _LOKI_ITER_START_SHA="$DEAD_LINK_BASE" enforce_static_analysis; then
    bad "dead href in changed product source was not blocked"
elif grep -q 'dead_href:index.html:1' "$DEAD_LINK/.loki/quality/static-analysis.json"; then
    ok "dead href is rejected deterministically before semantic review"
else
    bad "dead href blocked without actionable file and line evidence"
fi

WORKING_LINK="$(make_repo working-link)"
WORKING_LINK_BASE="$(git -C "$WORKING_LINK" rev-parse HEAD)"
printf '%s\n' '<a href="#pricing">Pricing</a><section id="pricing">Plans</section>' > "$WORKING_LINK/index.html"
if TARGET_DIR="$WORKING_LINK" _LOKI_ITER_START_SHA="$WORKING_LINK_BASE" enforce_static_analysis; then
    ok "real fragment target stays outside the dead-control rule"
else
    bad "real fragment target was falsely rejected"
fi

IGNORED="$(make_repo ignored)"
IGNORED_BASE="$(git -C "$IGNORED" rev-parse HEAD)"
mkdir -p "$IGNORED/.loki"
printf '%s\n' 'const broken = ;' > "$IGNORED/.loki/noise.js"
if TARGET_DIR="$IGNORED" _LOKI_ITER_START_SHA="$IGNORED_BASE" enforce_static_analysis; then
    ok "Loki state files stay outside the source gate"
else
    bad "Loki state file polluted the source gate"
fi

BROWNFIELD="$(make_repo brownfield)"
printf '%s\n' 'const legacy = 1;' > "$BROWNFIELD/legacy.js"
printf '%s\n' 'const agent = 1;' > "$BROWNFIELD/agent.js"
git -C "$BROWNFIELD" add legacy.js agent.js
git -C "$BROWNFIELD" commit -qm tracked-baseline
BROWNFIELD_BASE="$(git -C "$BROWNFIELD" rev-parse HEAD)"
printf '%s\n' 'const legacy = ;' > "$BROWNFIELD/legacy.js"
git -C "$BROWNFIELD" add legacy.js
printf '%s\n' 'const legacyStillBroken = ;' > "$BROWNFIELD/legacy.js"
printf '%s\n' 'const untrackedBroken = ;' > "$BROWNFIELD/preexisting.js"
BROWNFIELD_TREE="$(TARGET_DIR="$BROWNFIELD" _loki_snapshot_workspace_tree)"
printf '%s\n' 'const agent = 2;' > "$BROWNFIELD/agent.js"
if TARGET_DIR="$BROWNFIELD" _LOKI_ITER_START_SHA="$BROWNFIELD_BASE" \
   _LOKI_ITER_START_TREE="$BROWNFIELD_TREE" enforce_static_analysis; then
    ok "exact snapshot excludes preexisting staged, unstaged, and untracked brownfield errors"
else
    bad "preexisting brownfield errors were attributed to the valid agent edit"
fi
if git -C "$BROWNFIELD" diff --cached --name-only | grep -qx 'legacy.js' \
   && git -C "$BROWNFIELD" diff --name-only | grep -qx 'legacy.js'; then
    ok "throwaway snapshots preserve the real staged and unstaged index state"
else
    bad "workspace snapshot modified the real Git index"
fi

TIMEOUT_REPO="$(make_repo lint-timeout)"
printf '%s\n' '{"scripts":{"lint":"sleeping-lint"}}' > "$TIMEOUT_REPO/package.json"
git -C "$TIMEOUT_REPO" add package.json
git -C "$TIMEOUT_REPO" commit -qm lint-script
TIMEOUT_BASE="$(git -C "$TIMEOUT_REPO" rev-parse HEAD)"
TIMEOUT_TREE="$(TARGET_DIR="$TIMEOUT_REPO" _loki_snapshot_workspace_tree)"
printf '%s\n' 'const value = 2;' > "$TIMEOUT_REPO/app.js"
mkdir -p "$TMPROOT/sleep-bin"
printf '%s\n' '#!/usr/bin/env bash' 'sleep 10' > "$TMPROOT/sleep-bin/npm"
chmod +x "$TMPROOT/sleep-bin/npm"
timeout_started="$(date +%s)"
if PATH="$TMPROOT/sleep-bin:$PATH" TARGET_DIR="$TIMEOUT_REPO" \
   _LOKI_ITER_START_SHA="$TIMEOUT_BASE" _LOKI_ITER_START_TREE="$TIMEOUT_TREE" \
   LOKI_GATE_TIMEOUT=1 enforce_static_analysis; then
    bad "sleeping npm lint command escaped the gate deadline"
else
    timeout_elapsed=$(( $(date +%s) - timeout_started ))
    if [ "$timeout_elapsed" -le 4 ] && python3 - "$TIMEOUT_REPO/.loki/quality/static-analysis.json" <<'PYEOF'
import json
import sys

result = json.load(open(sys.argv[1], encoding="utf-8"))
assert result["pass"] is False
assert "Lint (npm run lint) deadline: exit_code=124 hard_seconds=1 idle_seconds=0." in result["summary"]
PYEOF
    then
        ok "sleeping npm lint is killed by the hard gate deadline with exact provenance"
    else
        bad "lint timeout was slow or lost its exit, hard, or idle deadline provenance"
    fi
fi

SHELL_TIMEOUT_REPO="$(make_repo shell-timeout)"
printf '%s\n' '#!/usr/bin/env bash' 'printf "ready\n"' > "$SHELL_TIMEOUT_REPO/check.sh"
git -C "$SHELL_TIMEOUT_REPO" add check.sh
git -C "$SHELL_TIMEOUT_REPO" commit -qm shell-baseline
SHELL_TIMEOUT_BASE="$(git -C "$SHELL_TIMEOUT_REPO" rev-parse HEAD)"
SHELL_TIMEOUT_TREE="$(TARGET_DIR="$SHELL_TIMEOUT_REPO" _loki_snapshot_workspace_tree)"
printf '%s\n' '#!/usr/bin/env bash' 'printf "updated\n"' > "$SHELL_TIMEOUT_REPO/check.sh"
mkdir -p "$TMPROOT/shellcheck-bin"
printf '%s\n' '#!/usr/bin/env bash' 'sleep 10' > "$TMPROOT/shellcheck-bin/shellcheck"
chmod +x "$TMPROOT/shellcheck-bin/shellcheck"
shell_timeout_started="$(date +%s)"
if PATH="$TMPROOT/shellcheck-bin:$PATH" TARGET_DIR="$SHELL_TIMEOUT_REPO" \
   _LOKI_ITER_START_SHA="$SHELL_TIMEOUT_BASE" _LOKI_ITER_START_TREE="$SHELL_TIMEOUT_TREE" \
   LOKI_GATE_TIMEOUT=1 enforce_static_analysis; then
    bad "sleeping shellcheck command escaped the gate deadline"
else
    shell_timeout_elapsed=$(( $(date +%s) - shell_timeout_started ))
    if [ "$shell_timeout_elapsed" -le 4 ] \
       && grep -q 'Shellcheck deadline: file=check.sh exit_code=124 hard_seconds=1 idle_seconds=0.' \
            "$SHELL_TIMEOUT_REPO/.loki/quality/static-analysis.json"; then
        ok "non-JS static tools share the finite hard deadline and timeout provenance"
    else
        bad "non-JS static timeout was slow or lost provenance"
    fi
fi

_loki_with_deadline() {
    printf '%s\n' "$1" > "${TARGET_DIR:-.}/.deadline-seconds"
    return 124
}
for invalid_timeout in 0 invalid; do
    NORMALIZED_REPO="$(make_repo "normalized-$invalid_timeout")"
    printf '%s\n' '{"scripts":{"lint":"deadline-probe"}}' > "$NORMALIZED_REPO/package.json"
    git -C "$NORMALIZED_REPO" add package.json
    git -C "$NORMALIZED_REPO" commit -qm lint-script
    NORMALIZED_BASE="$(git -C "$NORMALIZED_REPO" rev-parse HEAD)"
    NORMALIZED_TREE="$(TARGET_DIR="$NORMALIZED_REPO" _loki_snapshot_workspace_tree)"
    printf '%s\n' 'const value = 2;' > "$NORMALIZED_REPO/app.js"
    if TARGET_DIR="$NORMALIZED_REPO" _LOKI_ITER_START_SHA="$NORMALIZED_BASE" \
       _LOKI_ITER_START_TREE="$NORMALIZED_TREE" LOKI_GATE_TIMEOUT="$invalid_timeout" \
       enforce_static_analysis; then
        bad "invalid gate timeout $invalid_timeout bypassed the deadline"
    elif [ "$(cat "$NORMALIZED_REPO/.deadline-seconds")" = 300 ] \
         && grep -q 'hard_seconds=300 idle_seconds=0' \
              "$NORMALIZED_REPO/.loki/quality/static-analysis.json"; then
        ok "invalid gate timeout $invalid_timeout normalizes to a finite 300 second deadline"
    else
        bad "invalid gate timeout $invalid_timeout did not normalize to a finite deadline"
    fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
