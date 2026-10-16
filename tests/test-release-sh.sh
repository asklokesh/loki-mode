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
echo "T5-T11 -- RELEASE_ON_RED release gate + --bump-only (S-108)"
echo "  founder rule: never bump a tree without a green Tests"
echo "  run at HEAD's exact SHA. Real gh is never called: a stub gh (and a"
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
case "$GH_MODE" in
    green) green ;;
    tests_red)      [ "$wf" = "Tests" ] && red || green ;;
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
# up embedded in dist/loki.js. run_bump_only now fails fast (E-102) unless
# loki-ts/node_modules exists, so the fixture below creates a placeholder
# directory for it even though this stub never reads it.
cat > "$STUBBIN/bun" << 'BUNEOF'
#!/usr/bin/env bash
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
    mkdir -p dist
    printf 'stub build, version %s\n' "$(cat ../VERSION)" > dist/loki.js
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
cp "$REPO_ROOT/scripts/impacted-gate.sh" "$REPO_ROOT/scripts/select-tests.sh" "$REPO2/scripts/"
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

echo "T5 -- green Tests: --bump-only succeeds"
: > "$WORK2/gh-calls.log"
if run_gate_case green; then
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
if grep -q -- "--commit $STUB_SHA" "$WORK2/gh-calls.log" \
    && grep -q -- "--workflow Tests" "$WORK2/gh-calls.log"; then
    ok "green: gate actually queried Tests at HEAD's SHA"
else
    bad "green: gh was not queried for the required workflow at HEAD: $(cat "$WORK2/gh-calls.log")"
fi
PORCELAIN_AFTER_GREEN="$(git -C "$REPO2" status --porcelain)"
[ -n "$PORCELAIN_AFTER_GREEN" ] && ok "green: a successful bump-only does dirty the tree (sanity check)" \
    || bad "green: nothing changed -- the bump silently no-op'd"
if [ -z "$(git -C "$REPO2" status --porcelain -- loki-ts/dist/loki.js)" ]; then
    bad "green: dist rebuild step never ran (no diff on loki-ts/dist/loki.js)"
fi

echo
echo "T6 -- Tests red: refuses, exit 3, nothing changed"
if run_gate_case tests_red; then
    bad "expected exit 3, got 0"
else
    [ $? -eq 3 ] && ok "exit 3 on Tests-red" || bad "expected exit 3, got $?"
fi
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "Tests-red: no file content changed" || bad "Tests-red: files were modified despite the refusal"
[ -z "$(git -C "$REPO2" status --porcelain)" ] && ok "Tests-red: git status is clean" || bad "Tests-red: git status --porcelain not empty: $(git -C "$REPO2" status --porcelain)"
[ "$(log2)" = "$LOG_BEFORE" ] && ok "Tests-red: git log unchanged (no commit made)" || bad "Tests-red: a commit was created"

echo
echo "T8 -- no run found for the required workflow: refuses, exit 3"
if run_gate_case empty; then
    bad "expected exit 3, got 0"
else
    [ $? -eq 3 ] && ok "exit 3 on empty run list" || bad "expected exit 3, got $?"
fi
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "empty: no file content changed" || bad "empty: files were modified"

echo
echo "T9 -- green run exists but at a different SHA: refuses, exit 3"
if run_gate_case diffsha; then
    bad "expected exit 3, got 0"
else
    [ $? -eq 3 ] && ok "exit 3 when the only green run is on a different SHA" || bad "expected exit 3, got $?"
fi
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "diffsha: no file content changed" || bad "diffsha: files were modified"

echo
echo "T10 -- gh itself fails (network/auth error): refuses, exit 3, no crash"
if run_gate_case ghfail; then
    bad "expected exit 3, got 0"
else
    [ $? -eq 3 ] && ok "exit 3 when gh exits non-zero (not 1 from an uncaught set -e death)" || bad "expected exit 3, got $?"
fi
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "ghfail: no file content changed" || bad "ghfail: files were modified"

echo
echo "T11 -- LOKI_RELEASE_ALLOW_RED=1 bypasses the gate (test-only escape hatch)"
if run_gate_case tests_red "LOKI_RELEASE_ALLOW_RED=1"; then
    ok "exit 0 with the escape hatch set, even though Tests is red"
else
    bad "expected exit 0 with LOKI_RELEASE_ALLOW_RED=1, got $?"
fi
grep -qi "SKIPPING the green-CI release gate" "$WORK2/case.log" \
    && ok "escape hatch prints a loud warning" \
    || bad "escape hatch did not print the expected warning: $(cat "$WORK2/case.log")"

echo
echo "T12 -- ALLOW_RED still runs the global guard rows (REL-GUARD)"
run_gate_case tests_red "LOKI_RELEASE_ALLOW_RED=1 GUARD_STUB_RC=1"
rc12=$?
[ "$rc12" -eq 3 ] && ok "red guard row aborts the release (exit 3)" || bad "expected exit 3, got $rc12 ($(tail -8 "$WORK2/case.log"))"
grep -q "tests/stub-guard.sh" "$WORK2/case.log" \
    && ok "red guard row is named in the output" || bad "row not named: $(tail -5 "$WORK2/case.log")"
[ "$(snapshot2)" = "$CONTENT_BEFORE" ] && ok "red guard: VERSION and files untouched" || bad "red guard: files were modified"

if run_gate_case tests_red "LOKI_RELEASE_ALLOW_RED=1 GUARD_STUB_RC=0"; then
    ok "green guard row proceeds to the bump"
else
    bad "expected exit 0 with a green guard row, got $? ($(tail -3 "$WORK2/case.log"))"
fi
grep -q "1.2.4" "$REPO2/VERSION" && ok "green guard: VERSION bumped" || bad "green guard: VERSION not bumped"

if run_gate_case tests_red "LOKI_RELEASE_ALLOW_RED=1 LOKI_RELEASE_SKIP_GUARDS=1 GUARD_STUB_RC=1"; then
    ok "SKIP_GUARDS=1 proceeds despite a red row"
else
    bad "expected exit 0 with SKIP_GUARDS=1, got $?"
fi
grep -q "SKIPPING the global guard rows" "$WORK2/case.log" \
    && ok "SKIP_GUARDS prints a loud warning" || bad "no skip warning"

echo
echo "T13 -- guard rows run against a clean worktree of HEAD, not the dirty tree (REL-GUARD-b)"
# (a) dirty tracked file would make the row red; HEAD is green, so the guard stays green.
reset_repo2
printf '#!/usr/bin/env bash\nexit 1\n' > "$REPO2/tests/stub-guard.sh"
( cd "$REPO2" && env PATH="$STUBBIN:$PATH" GH_MODE=tests_red STUB_SHA="$STUB_SHA" GH_CALL_LOG="$WORK2/gh-calls.log" \
    LOKI_RELEASE_ALLOW_RED=1 bash ./scripts/release.sh patch --bump-only >"$WORK2/case.log" 2>&1 </dev/null )
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
( cd "$REPO2" && env PATH="$STUBBIN:$PATH" GH_MODE=tests_red STUB_SHA="$B_SHA" GH_CALL_LOG="$WORK2/gh-calls.log" \
    LOKI_RELEASE_ALLOW_RED=1 bash ./scripts/release.sh patch --bump-only >"$WORK2/case.log" 2>&1 </dev/null )
rc13b=$?
[ "$rc13b" -eq 3 ] && ok "committed red row stays red despite a green working edit (exit 3)" || bad "expected exit 3, got $rc13b ($(tail -4 "$WORK2/case.log"))"
grep -q "RELEASE_GUARD_RED" "$WORK2/case.log" && ok "RELEASE_GUARD_RED printed" || bad "no RED message"
[ -z "$(git -C "$REPO2" worktree list | grep guard-wt)" ] && ok "no leftover guard worktree (b)" || bad "leftover guard worktree: $(git -C "$REPO2" worktree list)"
# restore the fixture to the baseline commit for later cases
git -C "$REPO2" reset -q --hard "$STUB_SHA" >/dev/null 2>&1
reset_repo2

echo
echo "T14 -- caller-exported LOKI_RUN_TMP does not turn the guard red (REL-GUARD-b)"
if run_gate_case tests_red "LOKI_RELEASE_ALLOW_RED=1 GUARD_STUB_RC=0 LOKI_RUN_TMP=/nonexistent-run-tmp"; then
    ok "guard green with LOKI_RUN_TMP preset"
else
    bad "preset LOKI_RUN_TMP broke the guard ($(tail -5 "$WORK2/case.log"))"
fi

echo
echo "T15 -- default guard timeout is 300s, not 170 (REL-GUARD-b)"
grep -q 'LOKI_RELEASE_GUARD_TIMEOUT:-300' "$REPO_ROOT/scripts/release.sh" && ok "default 300" || bad "default not 300"
grep -q ':-170' "$REPO_ROOT/scripts/release.sh" && bad "170 default still present" || ok "no 170 default"

echo
echo "T16 -- stale loki-guard.*/guard-wt registrations are reclaimed; unrelated worktrees untouched (REL-GUARD-c)"
reset_repo2
T16_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
T16_STALE="$(mktemp -d "${T16_ROOT}/loki-guard.XXXXXXXX")"
chmod 700 "$T16_STALE"
git -C "$REPO2" worktree add --detach "$T16_STALE/guard-wt" HEAD >/dev/null 2>&1
T16_OTHER="$WORK2/unrelated-wt"
git -C "$REPO2" worktree add --detach "$T16_OTHER" HEAD >/dev/null 2>&1
git -C "$REPO2" worktree list | grep -q "$T16_STALE/guard-wt" && ok "fixture: stale registration present" || bad "fixture: stale registration missing"
if run_gate_case tests_red "LOKI_RELEASE_ALLOW_RED=1 GUARD_STUB_RC=0"; then
    ok "guard run stays green with a stale registration present"
else
    bad "guard run failed with stale registration ($(tail -5 "$WORK2/case.log"))"
fi
if git -C "$REPO2" worktree list | grep -q "loki-guard\."; then
    bad "stale guard worktree still registered: $(git -C "$REPO2" worktree list)"
else
    ok "stale guard registration removed"
fi
[ ! -e "$T16_STALE" ] && ok "stale loki-guard parent dir removed" || bad "stale parent dir remains: $T16_STALE"
if git -C "$REPO2" worktree list | grep -q "/unrelated-wt " && [ -d "$T16_OTHER" ]; then
    ok "unrelated worktree untouched"
else
    bad "unrelated worktree was removed"
fi
git -C "$REPO2" worktree remove --force "$T16_OTHER" >/dev/null 2>&1 || true
rm -rf -- "$T16_STALE"
git -C "$REPO2" worktree prune >/dev/null 2>&1 || true

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
