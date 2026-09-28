#!/usr/bin/env bash
# Guards release_restore_debugid_only_dist() in scripts/release.sh (E-72).
#
# WHY THIS EXISTS. loki-ts/scripts/build.ts hashes cockpit.js/cockpit.js.map
# content into a deterministic "//# debugId=" identity, but that hash still
# shifts across checkouts for bundles whose bytes never depend on VERSION.
# A version-only `release.sh --bump-only` rebuild therefore rewrites
# cockpit.js/cockpit.js.map even though nothing but that identity line
# changed -- pure git churn on every bump. release_restore_debugid_only_dist
# restores a dist file from HEAD when its ONLY diff is the debugId text, and
# leaves alone any file (loki.js) whose content genuinely changed.
#
# This test builds a throwaway temp git repo (no network, no real release)
# with a synthetic loki-ts/dist/, sources release.sh to call the helper
# directly, and checks each case.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-release-bump-only.XXXXXX")" || {
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

# HEAD state: a version-independent bundle (cockpit) and a version-carrying
# one (loki), each with a bundle + external map, like the real build.
cat >"$WORK/loki-ts/dist/cockpit.js" <<'EOF'
var cockpit = "render";
//# debugId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
EOF
cat >"$WORK/loki-ts/dist/cockpit.js.map" <<'EOF'
{"version":3,"sources":["cli.ts"],"debugId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
EOF
cat >"$WORK/loki-ts/dist/loki.js" <<'EOF'
var VERSION = "1.0.0";
//# debugId=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
EOF
cat >"$WORK/loki-ts/dist/loki.js.map" <<'EOF'
{"version":3,"sources":["cli.ts"],"sourcesContent":["VERSION 1.0.0"],"debugId":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
EOF
git -C "$WORK" add loki-ts/dist scripts/release.sh
git -C "$WORK" commit -q -m "initial dist"

# Simulate the rebuild a version-only bump produces:
#   - cockpit.js / cockpit.js.map: identical bytes except a fresh debugId
#     (the case this helper must clean up).
#   - loki.js / loki.js.map: the version literal changed too, so debugId is
#     not the only diff (must be left alone).
cat >"$WORK/loki-ts/dist/cockpit.js" <<'EOF'
var cockpit = "render";
//# debugId=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
EOF
cat >"$WORK/loki-ts/dist/cockpit.js.map" <<'EOF'
{"version":3,"sources":["cli.ts"],"debugId":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}
EOF
cat >"$WORK/loki-ts/dist/loki.js" <<'EOF'
var VERSION = "1.0.1";
//# debugId=DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
EOF
cat >"$WORK/loki-ts/dist/loki.js.map" <<'EOF'
{"version":3,"sources":["cli.ts"],"sourcesContent":["VERSION 1.0.1"],"debugId":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}
EOF

# A brand-new dist file with no HEAD counterpart must be skipped, not error.
cat >"$WORK/loki-ts/dist/new.js" <<'EOF'
var brandNew = true;
//# debugId=EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE
EOF

# Run the helper in a subshell so set -euo pipefail from the sourced script
# (and its unrelated `main` guard) can't affect this test runner. Call
# through the sourced script's OWN $ROOT_DIR (as the real --bump-only call
# site does) rather than $WORK: mktemp under a $TMPDIR that ends in a slash
# returns a path with a doubled slash, which textually differs from the
# canonical `cd && pwd` form release.sh computes for ROOT_DIR even though
# both name the same directory -- passing $WORK would defeat the helper's
# plain prefix-strip on that spelling mismatch alone.
(
    cd "$WORK" || exit 1
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    release_restore_debugid_only_dist "$ROOT_DIR/loki-ts/dist"
)
RC=$?

[ "$RC" -eq 0 ] && ok "helper exits 0" || bad "helper exited $RC"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/cockpit.js) "$WORK/loki-ts/dist/cockpit.js" >/dev/null 2>&1 \
    && ok "cockpit.js restored to HEAD (debugId-only diff)" \
    || bad "cockpit.js was NOT restored to HEAD"

diff -q <(git -C "$WORK" show HEAD:loki-ts/dist/cockpit.js.map) "$WORK/loki-ts/dist/cockpit.js.map" >/dev/null 2>&1 \
    && ok "cockpit.js.map restored to HEAD (debugId-only diff)" \
    || bad "cockpit.js.map was NOT restored to HEAD"

if grep -q "1.0.1" "$WORK/loki-ts/dist/loki.js" && ! grep -q "1.0.0" "$WORK/loki-ts/dist/loki.js"; then
    ok "loki.js keeps its real version change"
else
    bad "loki.js was altered/reverted -- version change lost"
fi

if grep -q "1.0.1" "$WORK/loki-ts/dist/loki.js.map"; then
    ok "loki.js.map keeps its real content change"
else
    bad "loki.js.map was altered/reverted -- content change lost"
fi

if [ -f "$WORK/loki-ts/dist/new.js" ] && grep -q "brandNew" "$WORK/loki-ts/dist/new.js"; then
    ok "new dist file with no HEAD counterpart is left untouched"
else
    bad "new dist file was unexpectedly removed/altered"
fi


# E-74: prove run_bump_only() itself calls release_restore_debugid_only_dist,
# not just that the helper works in isolation (the checks above call it
# directly). Stub out the unrelated steps (version-file bumping, the real
# `bun run build`) so this leg isolates the one call site at issue: if that
# call is ever deleted from run_bump_only, MARKER is never written and this
# leg alone goes red.
MARKER="$WORK/.debugid-helper-called"
rm -f "$MARKER"
mkdir -p "$WORK/bin"
cat >"$WORK/bin/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$WORK/bin/bun"

(
    cd "$WORK" || exit 1
    export PATH="$WORK/bin:$PATH"
    export BUMP_TYPE="patch"
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    # Stub the steps around the call site under test so this leg exercises
    # only "does run_bump_only invoke release_restore_debugid_only_dist",
    # not version-file bumping or a real bun build.
    get_current_version() { echo "1.0.1"; }
    bump_version() { echo "1.0.2"; }
    bump_all_version_files() { :; }
    release_restore_debugid_only_dist() { : >"$MARKER"; }
    echo "1.0.2" >"$ROOT_DIR/loki-ts/dist/loki.js"
    run_bump_only >/dev/null
)
RC2=$?

[ "$RC2" -eq 0 ] && ok "run_bump_only exits 0 (E-74)" || bad "run_bump_only exited $RC2 (E-74)"

[ -f "$MARKER" ] \
    && ok "run_bump_only calls release_restore_debugid_only_dist (E-74)" \
    || bad "run_bump_only did NOT call release_restore_debugid_only_dist (E-74)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
