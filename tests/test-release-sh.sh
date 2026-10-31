#!/usr/bin/env bash
# Guards scripts/release.sh's version-bump path.
#
# WHY THIS EXISTS. bump_all_version_files() rewrites every file the release
# checklist (docs/dev/release-checklist.md / CLAUDE.md "Release Workflow"
# section 1) lists via apply_sed()'s mktemp+sed>tmp+mv. mktemp always creates
# its file at mode 600 regardless of umask, and a same-directory `mv` keeps
# the temp file's own mode rather than the original's -- so every real
# release silently narrowed all 14 touched files from their tracked mode
# (644) down to 600 (BACKLOG 22, confirmed live). Git does not track
# non-exec mode bits, so the commit looked clean while the working tree's
# permissions quietly regressed on every single release.
#
# This test reproduces a full bump in a throwaway temp copy (never the real
# repo's tracked files) and checks: every checklist file actually changed,
# every file's original mode survived the bump, and running the bump again
# at the same target version is a no-op.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-release-sh.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Every file bump_all_version_files() touches (the checklist minus
# CHANGELOG.md, which update-changelog.sh handles separately, and
# vscode-extension/package.json, which is deliberately skipped as DEPRECATED).
FILES="VERSION package.json SKILL.md docker/Dockerfile docker/Dockerfile.sandbox plugins/loki-mode/.claude-plugin/plugin.json server.json CLAUDE.md dashboard/__init__.py mcp/__init__.py docs/INSTALLATION.md wiki/Home.md wiki/_Sidebar.md wiki/API-Reference.md web-app/src/components/Footer.tsx web-app/src/components/WhatsNew.tsx"

mkdir -p "$WORK/scripts"
cp "$REPO_ROOT/scripts/release.sh" "$WORK/scripts/release.sh"
for f in $FILES; do
    mkdir -p "$WORK/$(dirname "$f")"
    cp "$REPO_ROOT/$f" "$WORK/$f"
done

# Read one file's mode portably (GNU stat -c, BSD stat -f; see the matching
# helper in CLAUDE.md for why both are tried).
mode_of() {
    local v
    v="$(stat -c '%a' "$1" 2>/dev/null)" || v=""
    case "$v" in '' | *[!0-9]*) v="$(stat -f '%Lp' "$1" 2>/dev/null)" || v="" ;; esac
    printf '%s' "$v"
}

# Distinctive, non-default modes (never the umask-default 644/755) so this
# can't pass by accident -- if apply_sed silently drops to 600, this must
# both differ from the umask default AND differ from 600 to be caught.
snapshot() {
    for f in $FILES; do
        printf '%s %s\n' "$f" "$(mode_of "$WORK/$f")"
    done
}

i=0
for f in $FILES; do
    if [ $((i % 2)) -eq 0 ]; then chmod 640 "$WORK/$f"; else chmod 664 "$WORK/$f"; fi
    i=$((i + 1))
done
MODES_BEFORE="$(snapshot)"

NEW_VERSION="99.99.99"

run_bump() {
    (
        cd "$WORK" || exit 1
        # shellcheck disable=SC1091
        . ./scripts/release.sh
        DRY_RUN=false
        bump_all_version_files "$1"
    )
}

echo "T1 -- bump_all_version_files bumps every checklist file"
if run_bump "$NEW_VERSION" >"$WORK/run1.log" 2>&1; then
    ok "bump_all_version_files exited 0"
else
    bad "bump_all_version_files failed: $(tail -3 "$WORK/run1.log")"
fi

missing=""
for f in $FILES; do
    # CLAUDE.md's slot is checklist-optional ("if present"): current CLAUDE.md
    # points at VERSION rather than carrying its own literal, so it correctly
    # has nothing to bump. apply_sed still runs on it (mode check above still
    # covers it); only the content assertion is skipped here.
    [ "$f" = "CLAUDE.md" ] && continue
    grep -q "$NEW_VERSION" "$WORK/$f" || missing="$missing $f"
done
if [ -z "$missing" ]; then
    ok "all required checklist files carry $NEW_VERSION"
else
    bad "not bumped:$missing"
fi

echo
echo "T2 -- file modes survive the bump (BACKLOG 22)"
MODES_AFTER="$(snapshot)"
if [ "$MODES_BEFORE" = "$MODES_AFTER" ]; then
    ok "all modes unchanged"
else
    bad "modes changed: $(diff <(echo "$MODES_BEFORE") <(echo "$MODES_AFTER") | tr '\n' ' ')"
fi

expected="scripts/release.sh run1.log run2.log help.log dryrun.log"
for f in $FILES; do expected="$expected $f"; done
leftover=""
for af in $(cd "$WORK" && find . -type f | sed 's#^\./##'); do
    case " $expected " in
        *" $af "*) ;;
        *) leftover="$leftover $af" ;;
    esac
done
if [ -z "$leftover" ]; then
    ok "no stray apply_sed temp files left behind"
else
    bad "stray temp files: $leftover"
fi

echo
echo "T3 -- a second run at the same version is a no-op"
CONTENT_AFTER_1="$(for f in $FILES; do cat "$WORK/$f"; done)"
if run_bump "$NEW_VERSION" >"$WORK/run2.log" 2>&1; then
    ok "second bump_all_version_files exited 0"
else
    bad "second run failed: $(tail -3 "$WORK/run2.log")"
fi
CONTENT_AFTER_2="$(for f in $FILES; do cat "$WORK/$f"; done)"
if [ "$CONTENT_AFTER_1" = "$CONTENT_AFTER_2" ]; then
    ok "second run changed no file content"
else
    bad "second run at the same version was not a no-op"
fi
MODES_AFTER_2="$(snapshot)"
if [ "$MODES_BEFORE" = "$MODES_AFTER_2" ]; then
    ok "modes still unchanged after the second run"
else
    bad "modes drifted on the second run"
fi

echo
echo "T4 -- --dry-run and --help still work (subshell-scoping fix)"
if bash "$REPO_ROOT/scripts/release.sh" --help >/dev/null 2>"$WORK/help.log"; then
    ok "--help exits 0"
else
    bad "--help failed: $(cat "$WORK/help.log")"
fi
if ( cd "$WORK" && bash ./scripts/release.sh patch --dry-run >"$WORK/dryrun.log" 2>&1 ); then
    ok "patch --dry-run exits 0"
else
    bad "--dry-run failed: $(tail -3 "$WORK/dryrun.log")"
fi

echo
echo "T5-T11 -- release gate = global guard rows, always run + --bump-only"
echo "  no workflow run is required and gh is never consulted for the gate."
echo "  Real gh is never called: a stub gh (and a"
echo "  stub bun, plus a placeholder loki-ts/node_modules, so the rebuild"
echo "  step needs no real install or network)"
echo "  are put first on PATH for a throwaway git repo, never this repo."

WORK2="$(mktemp -d "${TMPDIR:-/tmp}/test-release-sh-gate.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup2() { rm -rf "$WORK2"; }
trap 'cleanup; cleanup2' EXIT

STUBBIN="$WORK2/bin"
mkdir -p "$STUBBIN"

# Stub gh: only understands `gh run list --workflow <name> --commit <sha>
# --json ...`. It does NOT filter by --commit itself -- the whole point of
# these tests is that release.sh's own headSha comparison does that
# filtering, so the stub stays dumb and just returns $GH_MODE's canned
# answer per workflow. Every invocation is logged so a test can assert the
# script actually asked for the right --commit.
cat > "$STUBBIN/gh" << 'GHEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_CALL_LOG:-/dev/null}"
wf="" prev=""
for a in "$@"; do
    [ "$prev" = "--workflow" ] && wf="$a"
    prev="$a"
done
green() { printf '[{"status":"completed","conclusion":"success","headSha":"%s"}]\n' "$STUB_SHA"; }
red()   { printf '[{"status":"completed","conclusion":"failure","headSha":"%s"}]\n' "$STUB_SHA"; }
# --ship's bounded wait asks about the Release workflow: the first
# $GH_RELEASE_BUSY calls (counted in $GH_RELEASE_COUNT) report a run in flight.
if [ "$wf" = "Release" ]; then
    n=0
    if [ -n "${GH_RELEASE_COUNT:-}" ] && [ -f "$GH_RELEASE_COUNT" ]; then n="$(cat "$GH_RELEASE_COUNT")"; fi
    n=$((n + 1))
    if [ -n "${GH_RELEASE_COUNT:-}" ]; then echo "$n" > "$GH_RELEASE_COUNT"; fi
    if [ "$n" -le "${GH_RELEASE_BUSY:-0}" ]; then
        echo '[{"status":"in_progress","databaseId":7}]'
    else
        echo '[{"status":"completed","databaseId":7}]'
    fi
    exit 0
fi
case "$GH_MODE" in
    green) green ;;
    green_head) printf '[{"status":"completed","conclusion":"success","headSha":"%s"}]\n' "$(git rev-parse HEAD)" ;;
    empty) echo '[]' ;;
    diffsha) printf '[{"status":"completed","conclusion":"success","headSha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}]\n' ;;
    ghfail) exit 7 ;;
    *) exit 9 ;;
esac
GHEOF
chmod +x "$STUBBIN/gh"

# Stub bun: only understands `bun run build`, invoked with cwd=loki-ts/. It
# does not perform a real build (no network calls) -- it models the one
# property run_bump_only actually checks: the freshly-bumped VERSION ends
# up embedded in dist/loki.js. run_bump_only now fails fast unless
# loki-ts/node_modules exists, so the fixture below creates a placeholder
# directory for it even though this stub never reads it.
cat > "$STUBBIN/bun" << 'BUNEOF'
#!/usr/bin/env bash
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
    mkdir -p dist
    printf 'stub build, version %s\n' "$(cat ../VERSION)" > dist/loki.js
    printf '{"version":3,"sources":[],"names":[],"mappings":"","x":"%s"}\n' "$(cat ../VERSION)" > dist/loki.js.map
    # --ship race fixture: move origin/main mid-ship (after the preflight).
    if [ -n "${BUN_RACE_SCRIPT:-}" ]; then bash "$BUN_RACE_SCRIPT" >/dev/null 2>&1; fi
    exit 0
fi
exit 1
BUNEOF
chmod +x "$STUBBIN/bun"

# Build a throwaway git repo with release.sh + every file it bumps + a
# placeholder loki-ts/dist/loki.js, and one commit. STUB_SHA is that commit's
# real SHA, so "gh says green for STUB_SHA" and "HEAD is STUB_SHA" agree by
# construction; the diffsha case deliberately breaks that agreement.
REPO2="$WORK2/repo"
mkdir -p "$REPO2/scripts" "$REPO2/loki-ts/dist" "$REPO2/loki-ts/node_modules"
# git tracks no empty dir; a placeholder file keeps node_modules present
# across reset_repo2()'s `git checkout -- .` / `git clean -fd` below.
: > "$REPO2/loki-ts/node_modules/.placeholder"
cp "$REPO_ROOT/scripts/release.sh" "$REPO2/scripts/release.sh"
for f in $FILES; do
    mkdir -p "$REPO2/$(dirname "$f")"
    cp "$REPO_ROOT/$f" "$REPO2/$f"
done
# Guard-row fixtures (REL-GUARD): the real runner and selector, a stub row list.
mkdir -p "$REPO2/eval/loki10" "$REPO2/tests"
cp "$REPO_ROOT/scripts/impacted-gate.sh" "$REPO_ROOT/scripts/select-tests.sh" "$REPO_ROOT/scripts/release-notes.sh" "$REPO2/scripts/"
cp "$REPO_ROOT/eval/loki10/lib-tmp.sh" "$REPO2/eval/loki10/"
printf 'shell_test\ttests/stub-guard.sh\n' > "$REPO2/scripts/global-guards.tsv"
printf '#!/usr/bin/env bash\nexit "${GUARD_STUB_RC:-0}"\n' > "$REPO2/tests/stub-guard.sh"
echo "0.0.1" > "$REPO2/loki-ts/dist/loki.js"
# Pin a known baseline so `patch` produces a predictable, hardcodable new
# version regardless of this real repo's current VERSION.
printf '1.2.3\n' > "$REPO2/VERSION"

git -c init.defaultBranch=main init -q "$REPO2"
git -C "$REPO2" -c user.name=test -c user.email=test@example.com \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    add -A >/dev/null
git -C "$REPO2" -c user.name=test -c user.email=test@example.com \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q -m "initial" >/dev/null
STUB_SHA="$(git -C "$REPO2" rev-parse HEAD)"

# Snapshot content once, right after the commit, to compare a refused run's
# working tree against (must be byte-identical: the gate refuses BEFORE
# bump_all_version_files ever runs).
snapshot2() { for f in $FILES loki-ts/dist/loki.js; do cat "$REPO2/$f"; done; }
log2() { git -C "$REPO2" log --format=%H; }
CONTENT_BEFORE="$(snapshot2)"
LOG_BEFORE="$(log2)"

reset_repo2() {
    git -C "$REPO2" checkout -q -- . >/dev/null 2>&1
    git -C "$REPO2" clean -qfd >/dev/null 2>&1
}

run_gate_case() {
    # $1 = GH_MODE, $2 = extra env assignment ("VAR=val") or ""
    local mode="$1" extra="${2:-}" rc
    reset_repo2
    # `env` (not a bare `VAR=val cmd` prefix) because $extra's assignment-ness
    # is decided at PARSE time in bash, before expansion -- a variable that
    # merely expands to "NAME=val" is never recognized as an assignment word
    # and would instead be run as the command itself ("NAME=val: command not
    # found"). `env` parses each argument's NAME=val form at run time, so an
    # expanded $extra works there.
    ( cd "$REPO2" \
        && env PATH="$STUBBIN:$PATH" GH_MODE="$mode" STUB_SHA="$STUB_SHA" \
           GH_CALL_LOG="$WORK2/gh-calls.log" $extra \
           bash ./scripts/release.sh patch --bump-only \
           >"$WORK2/case.log" 2>&1 </dev/null )
    rc=$?
    return $rc
}

echo "T5 -- green guard rows, no ALLOW_RED: --bump-only succeeds"
: > "$WORK2/gh-calls.log"
if run_gate_case green "GUARD_STUB_RC=0"; then
    ok "exit 0 on green"
else
    bad "expected exit 0, got $? ($(tail -3 "$WORK2/case.log"))"
fi
missing=""
for f in $FILES; do
    [ "$f" = "CLAUDE.md" ] && continue
    grep -q "1.2.4" "$REPO2/$f" 2>/dev/null || missing="$missing $f"
done
[ -z "$missing" ] && ok "green: all checklist files bumped" || bad "green: not bumped:$missing"
grep -q "1.2.4" "$REPO2/loki-ts/dist/loki.js" 2>/dev/null \
    && ok "green: loki-ts/dist/loki.js embeds the new version" \
    || bad "green: dist not rebuilt with new version"
grep -q "1.2.4" "$REPO2/web-app/src/components/Footer.tsx" 2>/dev/null \
    && ok "green: web-app/src/components/Footer.tsx version badge bumped" \
    || bad "green: web-app/src/components/Footer.tsx not bumped"
if [ ! -s "$WORK2/gh-calls.log" ]; then
    ok "green: the gate never consulted gh (no workflow run is required)"
else
    bad "green: gh was consulted by the gate: $(cat "$WORK2/gh-calls.log")"
fi
PORCELAIN_AFTER_GREEN="$(git -C "$REPO2" status --porcelain)"
[ -n "$PORCELAIN_AFTER_GREEN" ] && ok "green: a successful bump-only does dirty the tree (sanity check)" \
    || bad "green: nothing changed -- the bump silently no-op'd"
if [ -z "$(git -C "$REPO2" status --porcelain -- loki-ts/dist/loki.js)" ]; then
    bad "green: dist rebuild step never ran (no diff on loki-ts/dist/loki.js)"
fi

echo
echo "T6 -- red guard row: refuses, exit 3, nothing changed"
run_gate_case green "GUARD_STUB_RC=1"
rc6=$?
[ "$rc6" -eq 3 ] && ok "exit 3 on a red guard row" || bad "expected exit 3, got $rc6 ($(tail -8 "$WORK2/case.log"))"
grep -q "tests/stub-guard.sh" "$WORK2/case.log" \
    && ok "red guard row is named in the output" || bad "row not named: $(tail -5 "$WORK2/case.log")"
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "red row: no file content changed" || bad "red row: files were modified despite the refusal"
[ -z "$(git -C "$REPO2" status --porcelain)" ] && ok "red row: git status is clean" || bad "red row: git status --porcelain not empty: $(git -C "$REPO2" status --porcelain)"
[ "$(log2)" = "$LOG_BEFORE" ] && ok "red row: git log unchanged (no commit made)" || bad "red row: a commit was created"

echo
echo "T8 -- a failing gh does not matter: the gate does not use gh"
if run_gate_case ghfail "GUARD_STUB_RC=0"; then
    ok "exit 0 with gh exiting 7 and green guard rows"
else
    bad "expected exit 0, got $? ($(tail -3 "$WORK2/case.log"))"
fi
grep -q "1.2.4" "$REPO2/VERSION" && ok "ghfail: VERSION bumped" || bad "ghfail: VERSION not bumped"

echo
echo "T9 -- no run history at all (empty run list) does not block the bump"
if run_gate_case empty "GUARD_STUB_RC=0"; then
    ok "exit 0 with an empty run list"
else
    bad "expected exit 0, got $?"
fi

echo
echo "T11 -- LOKI_RELEASE_ALLOW_RED=1 is not a bypass of the guard rows"
run_gate_case green "LOKI_RELEASE_ALLOW_RED=1 GUARD_STUB_RC=1"
rc11=$?
[ "$rc11" -eq 3 ] && ok "red guard row still aborts with ALLOW_RED=1 (exit 3)" || bad "expected exit 3, got $rc11 ($(tail -8 "$WORK2/case.log"))"
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "ALLOW_RED red row: VERSION and files untouched" || bad "ALLOW_RED red row: files were modified"
grep -q "SKIPPING the green-CI" "$WORK2/case.log" && bad "stale green-CI banner still printed" || ok "no stale green-CI banner"

echo
echo "T12 -- no environment variable skips a red guard row"
for skipvar in LOKI_RELEASE_SKIP_GUARDS LOKI_SKIP_GUARDS SKIP_GUARDS; do
    run_gate_case green "${skipvar}=1 GUARD_STUB_RC=1"
    rc12=$?
    [ "$rc12" -eq 3 ] && ok "$skipvar=1 does not skip a red row (exit 3)" || bad "$skipvar=1: expected exit 3, got $rc12"
done
grep -q "SKIPPING" "$WORK2/case.log" && bad "a skip banner was printed" || ok "no skip banner exists"
if run_gate_case green "GUARD_STUB_RC=0"; then
    ok "green row proceeds"
else
    bad "expected exit 0 with a green row, got $?"
fi

echo "T13 -- guard rows run against a clean worktree of HEAD, not the dirty tree (REL-GUARD-b)"
# (a) dirty tracked file would make the row red; HEAD is green, so the guard stays green.
reset_repo2
printf '#!/usr/bin/env bash\nexit 1\n' > "$REPO2/tests/stub-guard.sh"
( cd "$REPO2" && env PATH="$STUBBIN:$PATH" GH_MODE=green STUB_SHA="$STUB_SHA" GH_CALL_LOG="$WORK2/gh-calls.log" \
    bash ./scripts/release.sh patch --bump-only >"$WORK2/case.log" 2>&1 </dev/null )
rc13=$?
[ "$rc13" -eq 0 ] && ok "dirty-but-red working edit does not turn the guard red (reads HEAD)" || bad "expected exit 0, got $rc13 ($(tail -4 "$WORK2/case.log"))"
grep -q "RELEASE_GUARD_DIRTY" "$WORK2/case.log" && bad "dirty refusal still present" || ok "no dirty-tree refusal"
[ -z "$(git -C "$REPO2" worktree list | grep guard-wt)" ] && ok "no leftover guard worktree (a)" || bad "leftover guard worktree: $(git -C "$REPO2" worktree list)"
# (b) committed red row with a green-looking working edit: guard is red, exit 3.
reset_repo2
printf '#!/usr/bin/env bash\nexit 1\n' > "$REPO2/tests/stub-guard.sh"
git -C "$REPO2" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q -am "red guard" >/dev/null
B_SHA="$(git -C "$REPO2" rev-parse HEAD)"
printf '#!/usr/bin/env bash\nexit 0\n' > "$REPO2/tests/stub-guard.sh"
( cd "$REPO2" && env PATH="$STUBBIN:$PATH" GH_MODE=green STUB_SHA="$B_SHA" GH_CALL_LOG="$WORK2/gh-calls.log" \
    bash ./scripts/release.sh patch --bump-only >"$WORK2/case.log" 2>&1 </dev/null )
rc13b=$?
[ "$rc13b" -eq 3 ] && ok "committed red row stays red despite a green working edit (exit 3)" || bad "expected exit 3, got $rc13b ($(tail -4 "$WORK2/case.log"))"
grep -q "RELEASE_GUARD_RED" "$WORK2/case.log" && ok "RELEASE_GUARD_RED printed" || bad "no RED message"
[ -z "$(git -C "$REPO2" worktree list | grep guard-wt)" ] && ok "no leftover guard worktree (b)" || bad "leftover guard worktree: $(git -C "$REPO2" worktree list)"
# restore the fixture to the baseline commit for later cases
git -C "$REPO2" reset -q --hard "$STUB_SHA" >/dev/null 2>&1
reset_repo2

echo
echo "T14 -- caller-exported LOKI_RUN_TMP does not turn the guard red (REL-GUARD-b)"
if run_gate_case green "GUARD_STUB_RC=0 LOKI_RUN_TMP=/nonexistent-run-tmp"; then
    ok "guard green with LOKI_RUN_TMP preset"
else
    bad "preset LOKI_RUN_TMP broke the guard ($(tail -5 "$WORK2/case.log"))"
fi

echo
echo "T15 -- default guard timeout is not 170 (REL-GUARD-b)"
grep -q 'LOKI_RELEASE_GUARD_TIMEOUT:-900' "$REPO_ROOT/scripts/release.sh" && ok "default 900" || bad "default not 900"
grep -q ':-170' "$REPO_ROOT/scripts/release.sh" && bad "170 default still present" || ok "no 170 default"

echo
echo "T16 -- stale loki-guard.*/guard-wt registrations are reclaimed; unrelated worktrees untouched (REL-GUARD-c)"
reset_repo2
T16_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
T16_STALE="$(mktemp -d "${T16_ROOT}/loki-guard.XXXXXXXX")"
chmod 700 "$T16_STALE"
T16_NEST="$(mktemp -d "${T16_ROOT}/loki-guard.XXXXXXXX")"
mkdir -p "$T16_NEST/y"
git -C "$REPO2" worktree add --detach "$T16_NEST/y/loki-guard.z/guard-wt" HEAD >/dev/null 2>&1
git -C "$REPO2" worktree add --detach "$T16_STALE/guard-wt" HEAD >/dev/null 2>&1
T16_OTHER="$WORK2/unrelated-wt"
git -C "$REPO2" worktree add --detach "$T16_OTHER" HEAD >/dev/null 2>&1
git -C "$REPO2" worktree list | grep -q "$T16_STALE/guard-wt" && ok "fixture: stale registration present" || bad "fixture: stale registration missing"
if run_gate_case green "GUARD_STUB_RC=0"; then
    ok "guard run stays green with a stale registration present"
else
    bad "guard run failed with stale registration ($(tail -5 "$WORK2/case.log"))"
fi
if git -C "$REPO2" worktree list | grep -q "$T16_STALE/guard-wt"; then
    bad "stale guard worktree still registered: $(git -C "$REPO2" worktree list)"
else
    ok "stale guard registration removed"
fi
if git -C "$REPO2" worktree list | grep -q "/y/loki-guard.z/guard-wt" && [ -d "$T16_NEST/y/loki-guard.z/guard-wt" ]; then
    ok "nested loki-guard.a/y/loki-guard.z/guard-wt survives"
else
    bad "nested registration was swept"
fi
[ ! -e "$T16_STALE" ] && ok "stale loki-guard parent dir removed" || bad "stale parent dir remains: $T16_STALE"
if git -C "$REPO2" worktree list | grep -q "/unrelated-wt " && [ -d "$T16_OTHER" ]; then
    ok "unrelated worktree untouched"
else
    bad "unrelated worktree was removed"
fi
git -C "$REPO2" worktree remove --force "$T16_OTHER" >/dev/null 2>&1 || true
git -C "$REPO2" worktree remove --force "$T16_NEST/y/loki-guard.z/guard-wt" >/dev/null 2>&1 || true
rm -rf -- "$T16_STALE" "$T16_NEST"
git -C "$REPO2" worktree prune >/dev/null 2>&1 || true

echo
echo "T17-T26 -- --ship one-command release (TEN-RELEASE-FAST)"
echo "  fixture: a clone of a LOCAL bare origin; stub gh, gitleaks and bun on"
echo "  PATH; an empty global git config. The real remote is never touched."
SHIPW="$WORK2/ship"
mkdir -p "$SHIPW"
: > "$SHIPW/empty-gitconfig"
# Stub gitleaks: logs its argv, exits $GITLEAKS_RC (0 = clean).
cat > "$STUBBIN/gitleaks" << 'GLEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GITLEAKS_LOG:-/dev/null}"
exit "${GITLEAKS_RC:-0}"
GLEOF
chmod +x "$STUBBIN/gitleaks"
gitq() { git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

# Template: REPO2's baseline + a CHANGELOG whose line 8 is '## v1.2.3', a
# tracked-but-ignored dist pair (as in the real repo) and a tracked
# docs/v10/CONTROL.md (the usage governor's always-dirty file).
SHIP_TPL="$SHIPW/tpl"
git clone -q "$REPO2" "$SHIP_TPL"
{
    printf '# Changelog\n\nAll notable changes.\n\nKeep a Changelog.\n\nSemver.\n'
    printf '## v1.2.3 (2026-01-01)\n\n### Fixed\n- baseline\n'
} > "$SHIP_TPL/CHANGELOG.md"
printf 'loki-ts/dist/\n' > "$SHIP_TPL/.gitignore"
printf '{"version":3,"sources":[],"names":[],"mappings":"","x":"1.2.3"}\n' > "$SHIP_TPL/loki-ts/dist/loki.js.map"
mkdir -p "$SHIP_TPL/docs/v10"
printf 'control\n' > "$SHIP_TPL/docs/v10/CONTROL.md"
mkdir -p "$SHIP_TPL/loki-ts/src"
printf 'export const x = 1;\n' > "$SHIP_TPL/loki-ts/src/index.ts"
# Stub generator, shaped like scripts/generate-stale-zero.sh: --outputs lists its
# pathspecs; a run stamps 'still ships in X' on every wiki page (the real one's
# wiki loop), including pages outside RELEASE_COMMIT_FILES.
printf 'wiki pages still ships in 1.2.3\n' > "$SHIP_TPL/wiki/Extra-A.md"
printf 'wiki pages still ships in 1.2.3\n' > "$SHIP_TPL/wiki/Extra-B.md"
printf 'my page still ships in 1.2.3\n' > "$SHIP_TPL/wiki/Mine.md"
cat > "$SHIP_TPL/scripts/generate-stale-zero.sh" << 'GENEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
if [ "${1:-}" = "--outputs" ]; then printf 'wiki\n'; exit 0; fi
v="$(tr -d '\n' < VERSION)"
for p in wiki/*.md; do
    sed -E "s/(still ships in )[0-9]+\.[0-9]+\.[0-9]+/\1${v}/" "$p" > "$p.tmp" && mv "$p.tmp" "$p"
done
GENEOF
chmod +x "$SHIP_TPL/scripts/generate-stale-zero.sh"
gitq -C "$SHIP_TPL" add CHANGELOG.md .gitignore docs/v10/CONTROL.md loki-ts/src/index.ts scripts/generate-stale-zero.sh wiki/Extra-A.md wiki/Extra-B.md wiki/Mine.md
gitq -C "$SHIP_TPL" add -f loki-ts/dist/loki.js.map
gitq -C "$SHIP_TPL" commit -q -m "ship fixture"
SHIP_BASE="$(git -C "$SHIP_TPL" rev-parse HEAD)"
printf '## v1.2.4 (2026-10-17)\n\n### Added\n- one-command ship\n\n\n' > "$SHIPW/notes.md"

SHIP_ORIGIN="$SHIPW/origin.git"
SHIP_REPO="$SHIPW/repo"
new_ship_fixture() {
    rm -rf -- "$SHIP_ORIGIN" "$SHIP_REPO" "$SHIPW/other"
    git clone -q --bare "$SHIP_TPL" "$SHIP_ORIGIN"
    git clone -q "$SHIP_ORIGIN" "$SHIP_REPO"
    : > "$SHIPW/gitleaks.log"
    rm -f "$SHIPW/release-count"
}
origin_main() { git -C "$SHIP_ORIGIN" rev-parse refs/heads/main; }
# Push one unrelated commit to origin from a second clone (origin moves on).
cat > "$SHIPW/race.sh" << RACEEOF
#!/usr/bin/env bash
rm -rf "$SHIPW/other"
git clone -q "$SHIP_ORIGIN" "$SHIPW/other"
echo other > "$SHIPW/other/other.txt"
git -C "$SHIPW/other" add other.txt
git -C "$SHIPW/other" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m other
git -C "$SHIPW/other" -c core.hooksPath=/dev/null push -q origin HEAD:refs/heads/main
RACEEOF

# Runs the real entry path: bash scripts/release.sh --ship from the repo root.
run_ship_case() {
    # $1 = extra env assignments ("A=1 B=2") or ""; $2 = notes file
    local extra="${1:-}" notes="${2:-$SHIPW/notes.md}"
    ( cd "$SHIP_REPO" \
        && env PATH="$STUBBIN:$PATH" GIT_CONFIG_GLOBAL="$SHIPW/empty-gitconfig" GIT_CONFIG_NOSYSTEM=1 \
           GH_MODE=green_head GH_RELEASE_COUNT="$SHIPW/release-count" GITLEAKS_LOG="$SHIPW/gitleaks.log" \
           LOKI_RELEASE_SHIP_POLL=1 $extra \
           bash ./scripts/release.sh --ship --notes "$notes" >"$SHIPW/case.log" 2>&1 </dev/null )
}
# A refused ship: exit 4, the named token, origin/main unchanged.
assert_refused() {
    local label="$1" rc="$2" token="$3" origin_before="$4"
    [ "$rc" -eq 4 ] && ok "$label: exit 4" || bad "$label: expected exit 4, got $rc ($(tail -4 "$SHIPW/case.log"))"
    grep -q "$token" "$SHIPW/case.log" && ok "$label: $token printed" || bad "$label: no $token ($(tail -4 "$SHIPW/case.log"))"
    [ "$(origin_main)" = "$origin_before" ] && ok "$label: origin/main untouched (no push)" || bad "$label: origin/main moved"
}

echo
echo "T17 -- --ship happy path completes every phase and pushes"
new_ship_fixture
printf 'governor append\n' >> "$SHIP_REPO/docs/v10/CONTROL.md"   # dirty, NOT staged
run_ship_case ""
rc=$?
[ "$rc" -eq 0 ] && ok "ship exit 0" || bad "ship expected exit 0, got $rc ($(tail -8 "$SHIPW/case.log"))"
LOCAL_HEAD="$(git -C "$SHIP_REPO" rev-parse HEAD)"
[ "$(origin_main)" = "$LOCAL_HEAD" ] && ok "origin/main equals the local release commit" || bad "origin/main != HEAD"
[ "$(git -C "$SHIP_REPO" log -1 --format=%s)" = "release: v1.2.4" ] && ok "commit subject 'release: v1.2.4'" || bad "subject: $(git -C "$SHIP_REPO" log -1 --format=%s)"
[ "$(git -C "$SHIP_REPO" log -1 --format='%an <%ae>')" = "asklokesh <lokeshmure@live.com>" ] && ok "commit identity asklokesh" || bad "identity: $(git -C "$SHIP_REPO" log -1 --format='%an <%ae>')"
[ "$(git -C "$SHIP_REPO" rev-parse HEAD~1)" = "$SHIP_BASE" ] && ok "exactly one commit on top of the base" || bad "unexpected history"
[ "$(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md | sed -n 8p)" = "## v1.2.4 (2026-10-17)" ] && ok "CHANGELOG line 8 is the new section" || bad "CHANGELOG line 8: $(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md | sed -n 8p)"
[ "$(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md | sed -n '11p')" = "- one-command ship" ] \
    && [ -z "$(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md | sed -n '12p')" ] \
    && [ "$(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md | sed -n 13p)" = "## v1.2.3 (2026-01-01)" ] \
    && ok "old section follows after exactly one blank line" || bad "CHANGELOG join wrong: $(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md | sed -n '8,16p' | tr '\n' '|')"
git -C "$SHIP_REPO" show HEAD:loki-ts/dist/loki.js | grep -q 1.2.4 && ok "committed dist/loki.js embeds 1.2.4" || bad "dist loki.js not in commit"
git -C "$SHIP_REPO" show HEAD:loki-ts/dist/loki.js.map | grep -q 1.2.4 && ok "committed dist/loki.js.map rebuilt" || bad "dist map not in commit"
git -C "$SHIP_REPO" show HEAD:VERSION | grep -qx 1.2.4 && ok "committed VERSION 1.2.4" || bad "VERSION not committed"
git -C "$SHIP_REPO" diff --name-only HEAD~1 HEAD | grep -qx docs/v10/CONTROL.md && bad "unstaged CONTROL.md edit was committed" || ok "dirty CONTROL.md left out of the commit"
grep -qF -- "--log-opts=origin/main..HEAD --diff-merges=first-parent" "$SHIPW/gitleaks.log" && ok "gitleaks ran on origin/main..HEAD first-parent" || bad "gitleaks args: $(cat "$SHIPW/gitleaks.log")"
ntime="$(grep -c '^\[TIME\] ' "$SHIPW/case.log")"
[ "$ntime" -ge 10 ] && ok "per-phase timings printed ($ntime [TIME] lines)" || bad "only $ntime [TIME] lines"
for ph in preflight "bump version files" "write CHANGELOG section" "rebuild loki-ts/dist" "stage and commit" "ancestry check" gitleaks "wait for an in-flight Release run" push "verify origin/main" total; do
    grep -q "^\[TIME\] $ph" "$SHIPW/case.log" || bad "no [TIME] line for phase: $ph"
done

echo
echo "T17b -- generator-stamped wiki pages ride the release commit; the user's own dirt does not"
new_ship_fixture
printf 'my own edit\n' >> "$SHIP_REPO/wiki/Mine.md"   # pre-existing dirt on a generator output
run_ship_case ""
rc=$?
[ "$rc" -eq 0 ] && ok "wiki ship exit 0" || bad "wiki ship expected exit 0, got $rc ($(tail -6 "$SHIPW/case.log"))"
for pg in wiki/Extra-A.md wiki/Extra-B.md; do
    git -C "$SHIP_REPO" show "HEAD:$pg" | grep -q 'still ships in 1.2.4' && ok "$pg stamp committed" || bad "$pg stamp not in the release commit"
done
git -C "$SHIP_REPO" diff --name-only HEAD~1 HEAD | grep -qx wiki/Mine.md && bad "pre-dirty wiki/Mine.md was swept into the release" || ok "pre-dirty wiki/Mine.md left out of the commit"
grep -q 'my own edit' "$SHIP_REPO/wiki/Mine.md" && ok "wiki/Mine.md edit still on disk" || bad "wiki/Mine.md edit lost"
left="$(git -C "$SHIP_REPO" diff --name-only HEAD -- wiki | grep -vx wiki/Mine.md || true)"
[ -z "$left" ] && ok "no release-produced wiki page left modified" || bad "left modified: $left"

echo
echo "T17c -- a release-produced file left modified after the commit fails the ship"
new_ship_fixture
# A post-commit hook re-dirties a page the generator stamped, standing in for any
# generated file the commit did not take.
printf '#!/usr/bin/env bash\nprintf late >> wiki/Extra-A.md\n' > "$SHIP_REPO/.git/hooks/post-commit"
chmod +x "$SHIP_REPO/.git/hooks/post-commit"
ORIG="$(origin_main)"
run_ship_case ""
assert_refused "generated file left modified" $? SHIP_DIRTY_AFTER_COMMIT "$ORIG"
grep -q 'wiki/Extra-A.md' "$SHIPW/case.log" && ok "refusal names wiki/Extra-A.md" || bad "refusal does not name the page"

echo
echo "T18 -- origin/main not an ancestor of HEAD: refuses before any write"
new_ship_fixture
bash "$SHIPW/race.sh"
ORIG="$(origin_main)"
run_ship_case ""
assert_refused "non-ancestor" $? SHIP_NOT_ANCESTOR "$ORIG"
[ "$(git -C "$SHIP_REPO" rev-parse HEAD)" = "$SHIP_BASE" ] && ok "non-ancestor: no local commit" || bad "non-ancestor: a commit was made"
grep -qx 1.2.3 "$SHIP_REPO/VERSION" && ok "non-ancestor: VERSION untouched (preflight)" || bad "non-ancestor: VERSION written"

echo
echo "T19 -- origin/main moves mid-ship: post-commit ancestry recheck refuses"
new_ship_fixture
run_ship_case "BUN_RACE_SCRIPT=$SHIPW/race.sh"
rc=$?
ORIG="$(origin_main)"
[ "$ORIG" != "$SHIP_BASE" ] && ok "race fixture moved origin/main" || bad "race fixture did not move origin"
assert_refused "mid-ship race" "$rc" SHIP_NOT_ANCESTOR "$ORIG"
grep -q "was NOT pushed" "$SHIPW/case.log" && ok "mid-ship race: says the local commit was not pushed" || bad "no not-pushed note"
[ ! -s "$SHIPW/gitleaks.log" ] && ok "mid-ship race: refused before gitleaks" || bad "gitleaks ran after a failed ancestry check"

echo
echo "T20 -- gitleaks finding: refuses before push"
new_ship_fixture
run_ship_case "GITLEAKS_RC=1"
assert_refused "gitleaks hit" $? SHIP_GITLEAKS "$SHIP_BASE"
# a range that adds .gitleaks.toml could disable the very scan it faces.
new_ship_fixture
printf 'title = "x"\n' > "$SHIP_REPO/.gitleaks.toml"
gitq -C "$SHIP_REPO" add .gitleaks.toml
gitq -C "$SHIP_REPO" commit -q -m "add zero-rule config"
run_ship_case ""
assert_refused "range adds .gitleaks.toml" $? SHIP_GITLEAKS_CONFIG "$SHIP_BASE"
[ ! -s "$SHIPW/gitleaks.log" ] && ok "range adds .gitleaks.toml: gitleaks never ran" || bad "gitleaks ran on a self-configured range"
# The repo's reviewed .gitleaksignore baseline is passed when present.
new_ship_fixture
: > "$SHIP_REPO/.gitleaksignore"
gitq -C "$SHIP_REPO" add .gitleaksignore
gitq -C "$SHIP_REPO" commit -q -m "add ignore baseline"
run_ship_case ""
rc=$?
[ "$rc" -eq 0 ] && grep -qF -- "--gitleaks-ignore-path $(cd "$SHIP_REPO" && pwd)/.gitleaksignore" "$SHIPW/gitleaks.log" \
    && ok ".gitleaksignore baseline passed to gitleaks" || bad ".gitleaksignore not passed (rc=$rc): $(cat "$SHIPW/gitleaks.log")"

echo
echo "T21 -- only HEAD plus this run's edits reach the release commit"
# T21a: anything already staged is refused in preflight, before any write.
new_ship_fixture
printf 'governor append\n' >> "$SHIP_REPO/docs/v10/CONTROL.md"
git -C "$SHIP_REPO" add docs/v10/CONTROL.md
run_ship_case ""
assert_refused "CONTROL.md pre-staged" $? SHIP_INDEX_NOT_EMPTY "$SHIP_BASE"
[ "$(git -C "$SHIP_REPO" rev-parse HEAD)" = "$SHIP_BASE" ] && ok "pre-staged: no commit made" || bad "pre-staged: a commit was made"
grep -qx 1.2.3 "$SHIP_REPO/VERSION" && ok "pre-staged: VERSION untouched (preflight)" || bad "pre-staged: VERSION written"
grep -q "docs/v10/CONTROL.md" "$SHIPW/case.log" && ok "pre-staged: file named" || bad "pre-staged file not named"
# T21b: an arbitrary staged file (not on the 5-name denylist) is refused too.
new_ship_fixture
printf 'x\n' > "$SHIP_REPO/docs/v10/CONTROL.md.orig"
git -C "$SHIP_REPO" add docs/v10/CONTROL.md.orig
run_ship_case ""
assert_refused "CONTROL.md.orig pre-staged" $? SHIP_INDEX_NOT_EMPTY "$SHIP_BASE"
# T21c: an unstaged edit to a release-list file is refused (reviewer probe).
new_ship_fixture
printf 'UNREVIEWED STRAY EDIT\n' >> "$SHIP_REPO/CHANGELOG.md"
run_ship_case ""
assert_refused "stray CHANGELOG.md edit" $? SHIP_DIRTY_RELEASE_FILES "$SHIP_BASE"
grep -qx 1.2.3 "$SHIP_REPO/VERSION" && ok "stray CHANGELOG edit: VERSION untouched (preflight)" || bad "stray CHANGELOG edit: VERSION written"
new_ship_fixture
printf 'stray\n' >> "$SHIP_REPO/CLAUDE.md"
run_ship_case ""
assert_refused "stray CLAUDE.md edit" $? SHIP_DIRTY_RELEASE_FILES "$SHIP_BASE"
grep -q "CLAUDE.md" "$SHIPW/case.log" && ok "stray CLAUDE.md edit: file named" || bad "dirty file not named"
# T21d: an unstaged edit to a build input would be bundled into dist.
new_ship_fixture
printf 'export const y = 2;\n' >> "$SHIP_REPO/loki-ts/src/index.ts"
run_ship_case ""
assert_refused "stray loki-ts/src edit" $? SHIP_DIRTY_RELEASE_FILES "$SHIP_BASE"
# Second line: files staged mid-run (after preflight, during the build).
printf '#!/usr/bin/env bash\nprintf "x\\n" >> "%s/docs/v10/CONTROL.md"\ngit -C "%s" add docs/v10/CONTROL.md\n' "$SHIP_REPO" "$SHIP_REPO" > "$SHIPW/stage-control.sh"
printf '#!/usr/bin/env bash\nprintf "x\\n" > "%s/docs/v10/CONTROL.md.orig"\ngit -C "%s" add docs/v10/CONTROL.md.orig\n' "$SHIP_REPO" "$SHIP_REPO" > "$SHIPW/stage-orig.sh"
# T21e: denylisted name staged mid-run.
new_ship_fixture
run_ship_case "BUN_RACE_SCRIPT=$SHIPW/stage-control.sh"
assert_refused "CONTROL.md staged mid-run" $? SHIP_FORBIDDEN_STAGED "$SHIP_BASE"
[ "$(git -C "$SHIP_REPO" rev-parse HEAD)" = "$SHIP_BASE" ] && ok "staged mid-run: no commit made" || bad "staged mid-run: a commit was made"
# T21f: a non-denylisted name staged mid-run hits the allowlist (exact match:
# CONTROL.md.orig contains a forbidden path but is not one).
new_ship_fixture
run_ship_case "BUN_RACE_SCRIPT=$SHIPW/stage-orig.sh"
assert_refused "CONTROL.md.orig staged mid-run" $? SHIP_UNEXPECTED_STAGED "$SHIP_BASE"
grep -q "SHIP_FORBIDDEN_STAGED" "$SHIPW/case.log" && bad "denylist matched a substring" || ok "denylist stays exact-path"
[ "$(git -C "$SHIP_REPO" rev-parse HEAD)" = "$SHIP_BASE" ] && ok "unexpected staged: no commit made" || bad "unexpected staged: a commit was made"
# T21g: allowlist boundary: 'CHANGELOG' is a substring of a release path
# (CHANGELOG.md) but not one, so the match must be whole-path.
printf '#!/usr/bin/env bash\nprintf "x\\n" > "%s/CHANGELOG"\ngit -C "%s" add CHANGELOG\n' "$SHIP_REPO" "$SHIP_REPO" > "$SHIPW/stage-sub.sh"
new_ship_fixture
run_ship_case "BUN_RACE_SCRIPT=$SHIPW/stage-sub.sh"
assert_refused "CHANGELOG (substring of a release path) staged mid-run" $? SHIP_UNEXPECTED_STAGED "$SHIP_BASE"

echo
echo "T22 -- CHANGELOG newest-header mismatch: refuses before any write"
new_ship_fixture
sed 's/^## v1.2.3 /## v1.2.30 /' "$SHIP_REPO/CHANGELOG.md" > "$SHIPW/cl" && cp "$SHIPW/cl" "$SHIP_REPO/CHANGELOG.md"
run_ship_case ""
assert_refused "newest header '## v1.2.30' for 1.2.3 (prefix boundary)" $? SHIP_CHANGELOG_MISMATCH "$SHIP_BASE"
grep -qx 1.2.3 "$SHIP_REPO/VERSION" && ok "newest header mismatch: VERSION untouched" || bad "c[7] mismatch: VERSION written"

# The newest section is found from its first '## v' header, not a fixed line.
# set_ship_preamble N: commit and push a CHANGELOG with an N-line preamble
# (sections kept from the template) so the ship starts from a clean tree.
set_ship_preamble() {
    local n="$1" i=1
    {
        while [ "$i" -le "$n" ]; do printf 'preamble line %s\n' "$i"; i=$((i + 1)); done
        sed -n '/^## v/,$p' "$SHIP_TPL/CHANGELOG.md"
    } > "$SHIPW/cl"
    cp "$SHIPW/cl" "$SHIP_REPO/CHANGELOG.md"
    commit_ship_changelog "changelog preamble $n"
}
commit_ship_changelog() {
    gitq -C "$SHIP_REPO" add CHANGELOG.md
    gitq -C "$SHIP_REPO" commit -q -m "$1"
    gitq -C "$SHIP_REPO" push -q origin HEAD:main
}
for plen in 2 0 5; do
    new_ship_fixture
    set_ship_preamble "$plen"
    pre_before="$(sed -n "1,${plen}p" "$SHIP_REPO/CHANGELOG.md")"
    run_ship_case ""
    rc=$?
    [ "$rc" -eq 0 ] && ok "$plen-line preamble: ship exit 0" || bad "$plen-line preamble: expected exit 0, got $rc ($(tail -4 "$SHIPW/case.log"))"
    committed="$(git -C "$SHIP_REPO" show HEAD:CHANGELOG.md)"
    [ "$(printf '%s\n' "$committed" | grep -n '^## v' | head -1)" = "$((plen + 1)):## v1.2.4 (2026-10-17)" ] \
        && ok "$plen-line preamble: new section is the first '## v' header" || bad "$plen-line preamble: first headers $(printf '%s\n' "$committed" | grep -n '^## v' | head -2 | tr '\n' '|')"
    if [ "$plen" -gt 0 ]; then
        [ "$(printf '%s\n' "$committed" | sed -n "1,${plen}p")" = "$pre_before" ] \
            && ok "$plen-line preamble: preamble unchanged" || bad "$plen-line preamble changed"
    fi
    [ "$(printf '%s\n' "$committed" | grep -c '^## v1.2.3 ')" -eq 1 ] \
        && ok "$plen-line preamble: old section kept once" || bad "$plen-line preamble: old section count"
done
new_ship_fixture
set_ship_preamble 3
sed 's/^## v1.2.3 /## v1.2.9 /' "$SHIP_REPO/CHANGELOG.md" > "$SHIPW/cl" && cp "$SHIPW/cl" "$SHIP_REPO/CHANGELOG.md"
commit_ship_changelog "wrong newest"
run_ship_case ""
assert_refused "wrong newest version after a 3-line preamble" $? SHIP_CHANGELOG_MISMATCH "$(git -C "$SHIP_REPO" rev-parse HEAD)"
grep -q "CHANGELOG.md line 4 is '## v1.2.9" "$SHIPW/case.log" && ok "mismatch message names the found line and header" || bad "mismatch message: $(tail -3 "$SHIPW/case.log")"
new_ship_fixture
printf '# Changelog\n\nno releases yet\n' > "$SHIP_REPO/CHANGELOG.md"
commit_ship_changelog "no sections"
run_ship_case ""
assert_refused "no '## v' header" $? SHIP_CHANGELOG_NO_HEADER "$(git -C "$SHIP_REPO" rev-parse HEAD)"

echo
echo "T23 -- notes header must name the new version"
new_ship_fixture
printf '## v1.2.5 (2026-10-17)\n\n- wrong\n' > "$SHIPW/bad-notes.md"
run_ship_case "" "$SHIPW/bad-notes.md"
assert_refused "notes header v1.2.5" $? SHIP_NOTES_HEADER "$SHIP_BASE"

echo
echo "T24 -- in-flight Release run: bounded wait, then push"
new_ship_fixture
run_ship_case "GH_RELEASE_BUSY=2"
rc=$?
[ "$rc" -eq 0 ] && ok "waited out 2 busy polls, exit 0" || bad "expected exit 0, got $rc ($(tail -5 "$SHIPW/case.log"))"
[ "$(grep -c 'Release run in flight' "$SHIPW/case.log")" -eq 2 ] && ok "two wait lines logged" || bad "wait lines: $(grep -c 'Release run in flight' "$SHIPW/case.log")"
[ "$(origin_main)" = "$(git -C "$SHIP_REPO" rev-parse HEAD)" ] && ok "pushed after the wait" || bad "not pushed after the wait"
new_ship_fixture
run_ship_case "GH_RELEASE_BUSY=999 LOKI_RELEASE_SHIP_WAIT=2"
assert_refused "Release never idle" $? SHIP_RELEASE_BUSY "$SHIP_BASE"
grep -q 'LOKI_RELEASE_SHIP_WAIT:-300' "$REPO_ROOT/scripts/release.sh" && grep -q 'max_wait=300' "$REPO_ROOT/scripts/release.sh" \
    && ok "wait default and cap are 300s" || bad "wait bound not 300s"

echo
echo "T25 -- --ship still runs the guard-row release gate"
new_ship_fixture
run_ship_case "GUARD_STUB_RC=1"
rc=$?
[ "$rc" -eq 3 ] && ok "red guard row at HEAD: exit 3" || bad "expected exit 3, got $rc"
[ "$(origin_main)" = "$SHIP_BASE" ] && grep -qx 1.2.3 "$SHIP_REPO/VERSION" && ok "gate refusal: nothing written or pushed" || bad "gate refusal wrote or pushed"

echo
echo "T17d -- notes with no '### ' subsection are refused before any write, with all guard rows green (FC-RELEASE-NOTES-FORMAT-UNCHECKED-LOCALLY)"
new_ship_fixture
printf '## v1.2.4 (2026-10-17)\n\n- bullets but no subsection\n' > "$SHIPW/notes-flat.md"
ORIG="$(origin_main)"
run_ship_case "GUARD_STUB_RC=0" "$SHIPW/notes-flat.md"
assert_refused "flat notes" $? SHIP_NOTES_FORMAT "$ORIG"
grep -qx 1.2.3 "$SHIP_REPO/VERSION" && ok "flat notes: nothing written (VERSION unchanged)" || bad "flat notes: VERSION was bumped"

echo
echo "T26 -- --ship argument validation"
( cd "$SHIP_REPO" && bash ./scripts/release.sh --ship >"$SHIPW/case.log" 2>&1 </dev/null )
[ $? -eq 1 ] && grep -q -- "--ship needs --notes FILE" "$SHIPW/case.log" && ok "--ship without --notes exits 1" || bad "missing --notes not rejected"
( cd "$SHIP_REPO" && bash ./scripts/release.sh patch --notes "$SHIPW/notes.md" >"$SHIPW/case.log" 2>&1 </dev/null )
[ $? -eq 1 ] && ok "--notes without --ship exits 1" || bad "--notes without --ship accepted"
( cd "$SHIP_REPO" && bash ./scripts/release.sh --ship --dry-run --notes "$SHIPW/notes.md" >"$SHIPW/case.log" 2>&1 </dev/null )
[ $? -eq 1 ] && ok "--ship --dry-run exits 1" || bad "--ship --dry-run accepted"

echo
echo "T27 -- --ship from a linked worktree is refused before any write"
new_ship_fixture
T27_WT="$SHIPW/linked-wt"
rm -rf -- "$T27_WT"
git -C "$SHIP_REPO" worktree add -q --detach "$T27_WT" HEAD >/dev/null 2>&1
T27_ORIGIN="$(origin_main)"
T27_HEAD="$(git -C "$T27_WT" rev-parse HEAD)"
( cd "$T27_WT" \
    && env PATH="$STUBBIN:$PATH" GIT_CONFIG_GLOBAL="$SHIPW/empty-gitconfig" GIT_CONFIG_NOSYSTEM=1 \
       GH_MODE=green_head GH_RELEASE_COUNT="$SHIPW/release-count" GITLEAKS_LOG="$SHIPW/gitleaks.log" \
       LOKI_RELEASE_SHIP_POLL=1 \
       bash ./scripts/release.sh --ship --notes "$SHIPW/notes.md" >"$SHIPW/case.log" 2>&1 </dev/null )
T27_RC=$?
[ "$T27_RC" -eq 4 ] && ok "linked worktree: exit 4" || bad "linked worktree: expected exit 4, got $T27_RC ($(tail -4 "$SHIPW/case.log"))"
grep -q "SHIP_LINKED_WORKTREE" "$SHIPW/case.log" && ok "linked worktree: SHIP_LINKED_WORKTREE printed" || bad "linked worktree: no SHIP_LINKED_WORKTREE"
grep -qF "main checkout: $(cd "$SHIP_REPO" && pwd -P)" "$SHIPW/case.log" && ok "linked worktree: names the main checkout path" || bad "linked worktree: main checkout path missing ($(tail -3 "$SHIPW/case.log"))"
grep -qx 1.2.3 "$T27_WT/VERSION" && ok "linked worktree: VERSION unchanged" || bad "linked worktree: VERSION was edited"
[ "$(git -C "$T27_WT" rev-parse HEAD)" = "$T27_HEAD" ] && ok "linked worktree: no commit made" || bad "linked worktree: a commit was made"
[ "$(origin_main)" = "$T27_ORIGIN" ] && ok "linked worktree: origin/main untouched" || bad "linked worktree: origin/main moved"
git -C "$SHIP_REPO" worktree remove --force "$T27_WT" >/dev/null 2>&1


echo
echo "==============================================================="
echo "Results:$PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
