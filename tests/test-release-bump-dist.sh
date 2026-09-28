#!/usr/bin/env bash
# Guards run_bump_only()'s handling of a failed loki-ts build (E-102).
#
# INCIDENT. In a fresh worktree with no loki-ts/node_modules,
# `bash scripts/release.sh patch --bump-only` ran `bun run build`, which
# failed resolving "@anthropic-ai/sdk". Because release.sh runs under
# `set -euo pipefail`, that failure exited the script immediately -- but
# only AFTER bun had already deleted the tracked dist files it was about to
# rebuild (cockpit.js, cockpit.js.map, loki.js, loki.js.map), leaving the
# tree with a byte-deleted loki-ts/dist and no rebuild to replace it.
#
# This test proves two things against a throwaway git repo (no network, no
# real release):
#   1. A missing node_modules fails fast, before any build attempt.
#   2. A build that fails anyway (bun stubbed to delete dist then exit 1,
#      matching the real incident) exits non-zero AND leaves loki-ts/dist
#      byte-identical to HEAD.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-release-bump-dist.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/scripts" "$WORK/loki-ts/dist"
cp "$REPO_ROOT/scripts/release.sh" "$WORK/scripts/release.sh"

git -C "$WORK" init -q
git -C "$WORK" config user.name "test"
git -C "$WORK" config user.email "test@example.com"

cat >"$WORK/loki-ts/dist/cockpit.js" <<'EOF'
var cockpit = "render";
EOF
cat >"$WORK/loki-ts/dist/loki.js" <<'EOF'
let $="1.0.0";
EOF
git -C "$WORK" add loki-ts/dist scripts/release.sh
git -C "$WORK" commit -q -m "initial dist"

# --- Case 1: node_modules missing -> fail fast, no build attempted. ---
mkdir -p "$WORK/bin"
cat >"$WORK/bin/bun" <<'EOF'
#!/usr/bin/env bash
echo "BUN SHOULD NOT HAVE RUN" >&2
exit 1
EOF
chmod +x "$WORK/bin/bun"

(
    cd "$WORK" || exit 1
    export PATH="$WORK/bin:$PATH"
    export BUMP_TYPE="patch"
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    get_current_version() { echo "1.0.0"; }
    bump_version() { echo "1.0.1"; }
    bump_all_version_files() { :; }
    run_bump_only >/dev/null 2>"$WORK/case1.err"
)
RC1=$?

[ "$RC1" -ne 0 ] && ok "missing node_modules: exits non-zero (case 1)" \
    || bad "missing node_modules: exited 0, should have failed (case 1)"

grep -q "bun install" "$WORK/case1.err" \
    && ok "missing node_modules: error hints bun install (case 1)" \
    || bad "missing node_modules: no bun install hint in error (case 1)"

grep -q "BUN SHOULD NOT HAVE RUN" "$WORK/case1.err" \
    && bad "missing node_modules: build ran anyway (case 1)" \
    || ok "missing node_modules: build never invoked (case 1)"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/loki.js) "$WORK/loki-ts/dist/loki.js" >/dev/null 2>&1 \
    && ok "missing node_modules: dist untouched (case 1)" \
    || bad "missing node_modules: dist was modified (case 1)"

# --- Case 2: node_modules present, build fails and deletes dist (the real
# incident: bun deletes tracked outputs mid-bundle, then exits non-zero). ---
mkdir -p "$WORK/loki-ts/node_modules"
cat >"$WORK/bin/bun" <<'EOF'
#!/usr/bin/env bash
rm -f dist/cockpit.js dist/loki.js
echo "Could not resolve: \"@anthropic-ai/sdk\"" >&2
exit 1
EOF
chmod +x "$WORK/bin/bun"

(
    cd "$WORK" || exit 1
    export PATH="$WORK/bin:$PATH"
    export BUMP_TYPE="patch"
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    get_current_version() { echo "1.0.0"; }
    bump_version() { echo "1.0.1"; }
    bump_all_version_files() { :; }
    run_bump_only >/dev/null 2>"$WORK/case2.err"
)
RC2=$?

[ "$RC2" -ne 0 ] && ok "build failure: exits non-zero (case 2)" \
    || bad "build failure: exited 0, should have failed (case 2)"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/loki.js) "$WORK/loki-ts/dist/loki.js" >/dev/null 2>&1 \
    && ok "build failure: loki.js restored byte-identical to HEAD (case 2)" \
    || bad "build failure: loki.js NOT restored to HEAD (case 2)"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/cockpit.js) "$WORK/loki-ts/dist/cockpit.js" >/dev/null 2>&1 \
    && ok "build failure: cockpit.js restored byte-identical to HEAD (case 2)" \
    || bad "build failure: cockpit.js NOT restored to HEAD (case 2)"

# --- Case 3: node_modules present, build exits 0 and DOES write dist, but
# never embeds the new version (a stale or silently-broken build -- the
# version write is the part that broke). Must be treated like a build
# failure: restore dist from HEAD, exit non-zero. The stub writes garbage
# so a no-op restore would be caught by the diff below. ---
cat >"$WORK/bin/bun" <<'EOF'
#!/usr/bin/env bash
echo 'let $="STALE-BUILD-NO-VERSION";' > dist/loki.js
exit 0
EOF
chmod +x "$WORK/bin/bun"

(
    cd "$WORK" || exit 1
    export PATH="$WORK/bin:$PATH"
    export BUMP_TYPE="patch"
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    get_current_version() { echo "1.0.0"; }
    bump_version() { echo "1.0.1"; }
    bump_all_version_files() { :; }
    run_bump_only >/dev/null 2>"$WORK/case3.err"
)
RC3=$?

[ "$RC3" -ne 0 ] && ok "build exits 0 without new version: exits non-zero (case 3)" \
    || bad "build exits 0 without new version: exited 0, should have failed (case 3)"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/loki.js) "$WORK/loki-ts/dist/loki.js" >/dev/null 2>&1 \
    && ok "build exits 0 without new version: loki.js restored byte-identical to HEAD (case 3)" \
    || bad "build exits 0 without new version: loki.js NOT restored to HEAD (case 3)"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/cockpit.js) "$WORK/loki-ts/dist/cockpit.js" >/dev/null 2>&1 \
    && ok "build exits 0 without new version: cockpit.js restored byte-identical to HEAD (case 3)" \
    || bad "build exits 0 without new version: cockpit.js NOT restored to HEAD (case 3)"

# --- Case 4 (E-108): build succeeds and embeds the new version, but the
# rebuild gives loki.js a FRESH debugId trailer while loki.js.map's only
# diff from HEAD is that same debugId churn (like cockpit.js.map above).
# release_restore_debugid_only_dist restores loki.js.map to HEAD verbatim.
# loki.js keeps its real diff (the version literal) but must ALSO have its
# debugId trailer restored to HEAD's value, so it matches the restored map.
cat >"$WORK/loki-ts/dist/loki.js" <<'EOF'
let $="1.0.1";
//# debugId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
EOF
cat >"$WORK/loki-ts/dist/loki.js.map" <<'EOF'
{"version":3,"sources":["cli.ts"],"debugId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
EOF
git -C "$WORK" add loki-ts/dist
git -C "$WORK" commit -q -m "case4 HEAD: loki.js 1.0.1 with matching debugId pair"

cat >"$WORK/bin/bun" <<'EOF'
#!/usr/bin/env bash
cat > dist/loki.js <<'JS'
let $="1.0.2";
//# debugId=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
JS
cat > dist/loki.js.map <<'MAP'
{"version":3,"sources":["cli.ts"],"debugId":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
MAP
exit 0
EOF
chmod +x "$WORK/bin/bun"

(
    cd "$WORK" || exit 1
    export PATH="$WORK/bin:$PATH"
    export BUMP_TYPE="patch"
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    get_current_version() { echo "1.0.1"; }
    bump_version() { echo "1.0.2"; }
    bump_all_version_files() { :; }
    run_bump_only >/dev/null 2>"$WORK/case4.err"
)
RC4=$?

[ "$RC4" -eq 0 ] && ok "version-only rebuild: exits 0 (case 4)" \
    || bad "version-only rebuild: exited $RC4 (case 4)"

grep -q "1.0.2" "$WORK/loki-ts/dist/loki.js" \
    && ok "version-only rebuild: loki.js keeps the new version literal (case 4)" \
    || bad "version-only rebuild: loki.js lost the new version literal (case 4)"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/loki.js.map) "$WORK/loki-ts/dist/loki.js.map" >/dev/null 2>&1 \
    && ok "version-only rebuild: loki.js.map restored to HEAD (debugId-only diff) (case 4)" \
    || bad "version-only rebuild: loki.js.map NOT restored to HEAD (case 4)"

DIFF4="$(git -C "$WORK" diff -- loki-ts/dist/loki.js)"
CHANGED4="$(printf '%s\n' "$DIFF4" | grep -E '^[+-]' | grep -Ev '^(\+\+\+|---)')"
if printf '%s\n' "$CHANGED4" | grep -q '1\.0\.2' && ! printf '%s\n' "$CHANGED4" | grep -q 'debugId'; then
    ok "version-only rebuild: git diff of loki.js changes only the version literal (case 4)"
else
    bad "version-only rebuild: git diff of loki.js touches more than the version literal (case 4)"
    printf '%s\n' "$DIFF4" | sed 's/^/    /'
fi

JS_ID4="$(grep -o 'debugId=[0-9A-Fa-f]*' "$WORK/loki-ts/dist/loki.js" | sed 's/debugId=//')"
MAP_ID4="$(grep -o '"debugId":"[0-9A-Fa-f]*"' "$WORK/loki-ts/dist/loki.js.map" | sed -E 's/.*:"([0-9A-Fa-f]+)"/\1/')"
if [ -n "$JS_ID4" ] && [ "$JS_ID4" = "$MAP_ID4" ]; then
    ok "version-only rebuild: loki.js debugId trailer matches loki.js.map's debugId (case 4)"
else
    bad "version-only rebuild: loki.js debugId ($JS_ID4) != loki.js.map debugId ($MAP_ID4) (case 4)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
