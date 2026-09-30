#!/usr/bin/env bash
# E-133: release_dist_maps_clean must refuse loki-ts/dist/*.map files whose
# "sources" hold an absolute path or climb out of the repo (v10.5.4 incident:
# a node_modules symlink wrote 133 /Users/... entries). Comment text inside
# sourcesContent must not trip it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# Run-owned temp dir (repo CLAUDE.md pattern, reduced: marker-checked rm).
temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || exit 2
chmod 700 "$RUN_TMP"
printf '%s\n' "$RUN_TMP" >"$RUN_TMP/.loki-run-owned"
cleanup() {
    if [ "$(cat "$RUN_TMP/.loki-run-owned" 2>/dev/null)" = "$RUN_TMP" ]; then
        rm -rf -- "$RUN_TMP"
    fi
}
trap cleanup EXIT

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/release.sh"
set +e  # release.sh sets -e; this test inspects exit codes

# guard_rc <root>: exit status of the guard against <root>/loki-ts/dist
guard_rc() {
    if ! declare -F release_dist_maps_clean >/dev/null; then return 99; fi
    ROOT_DIR="$1" release_dist_maps_clean 2>"$RUN_TMP/err"
}

mkfix() { # name, sources-json, sourcesContent-json
    local d="$RUN_TMP/$1"
    mkdir -p "$d/loki-ts/dist"
    printf '{"version":3,"sources":%s,"sourcesContent":%s}\n' "$2" "$3" >"$d/loki-ts/dist/loki.js.map"
    echo "$d"
}

D=$(mkfix abs '["../src/a.ts","/Users/x/git/repo/node_modules/pkg/index.js"]' '["",""]')
guard_rc "$D"; [ $? -eq 1 ] && ok "absolute source refused" || bad "absolute source not refused"
grep -q "/Users/x/git" "$RUN_TMP/err" && ok "message names the offending entry" || bad "no offending entry in message"

D=$(mkfix climb '["../src/a.ts","../../../outside/node_modules/p.js"]' '["",""]')
guard_rc "$D"; [ $? -eq 1 ] && ok "source climbing above the repo refused" || bad "repo-escaping source not refused"

D=$(mkfix inside '["../src/a.ts","../node_modules/pkg/index.js"]' '["",""]')
guard_rc "$D" && ok "relative in-repo sources accepted" || bad "in-repo sources refused"

D=$(mkfix comment '["../src/a.ts"]' '["// see ~/.claude/plans/x.md and ../../../../etc"]')
guard_rc "$D" && ok "path text inside sourcesContent ignored" || bad "sourcesContent comment tripped the guard"

if guard_rc "$REPO_ROOT"; then ok "committed maps in the working tree pass"; else bad "committed maps refused"; cat "$RUN_TMP/err"; fi

# Maps as committed one release before 10.5.4 (the pre-symlink file).
PRE="$RUN_TMP/pre"; mkdir -p "$PRE/loki-ts/dist"
for f in loki.js.map cockpit.js.map; do
    git -C "$REPO_ROOT" show "8ee273f6^:loki-ts/dist/$f" >"$PRE/loki-ts/dist/$f" 2>/dev/null || rm -f "$PRE/loki-ts/dist/$f"
done
if ls "$PRE"/loki-ts/dist/*.map >/dev/null 2>&1; then
    guard_rc "$PRE" && ok "maps from before v10.5.4 pass" || bad "pre-10.5.4 maps refused"
else
    echo "  [SKIP] pre-10.5.4 maps unavailable (shallow clone)"
fi

# Wiring: run_bump_only must exit nonzero and restore dist when the build writes a bad map.
W="$RUN_TMP/wire"; mkdir -p "$W/scripts" "$W/loki-ts/dist" "$W/loki-ts/node_modules" "$W/bin"
cp "$REPO_ROOT/scripts/release.sh" "$W/scripts/release.sh"
echo 'let $="1.0.0";' >"$W/loki-ts/dist/loki.js"
echo '{"version":3,"sources":["../src/a.ts"]}' >"$W/loki-ts/dist/loki.js.map"
git -C "$W" init -q
git -C "$W" config user.name t
git -C "$W" config user.email t@example.com
git -C "$W" add loki-ts/dist scripts/release.sh
git -C "$W" commit -q -m init
cat >"$W/bin/bun" <<'B'
#!/usr/bin/env bash
echo 'let $="1.0.1";' > dist/loki.js
echo '{"version":3,"sources":["/Users/x/node_modules/p.js"]}' > dist/loki.js.map
B
chmod +x "$W/bin/bun"
(
    cd "$W" || exit 1
    export PATH="$W/bin:$PATH" BUMP_TYPE=patch
    # shellcheck disable=SC1091
    . ./scripts/release.sh
    get_current_version() { echo "1.0.0"; }
    bump_version() { echo "1.0.1"; }
    bump_all_version_files() { :; }
    run_bump_only >/dev/null 2>&1
)
RC=$?
[ "$RC" -ne 0 ] && ok "run_bump_only exits nonzero on a bad map" || bad "run_bump_only exited 0 on a bad map"
git -C "$W" diff --quiet -- loki-ts/dist && ok "bad-map dist restored from HEAD" || bad "bad-map dist left in tree"

# E-151: release_commit_clean refuses a release commit that left the stamped map modified.
C="$RUN_TMP/clean"; mkdir -p "$C/loki-ts/dist"
echo 'let $="10.5.9";' >"$C/loki-ts/dist/loki.js"; echo '{"m":"AAAA"}' >"$C/loki-ts/dist/loki.js.map"
git -C "$C" init -q; git -C "$C" config user.name t; git -C "$C" config user.email t@example.com
git -C "$C" add loki-ts/dist; git -C "$C" commit -q -m init
echo 'let $="10.5.10";' >"$C/loki-ts/dist/loki.js"; echo '{"m":"AAAAA"}' >"$C/loki-ts/dist/loki.js.map"
git -C "$C" add loki-ts/dist/loki.js; git -C "$C" commit -q -m "release: v10.5.10"
ROOT_DIR="$C" release_commit_clean 2>"$RUN_TMP/err"; rc=$?
{ [ "$rc" -eq 1 ] && grep -q "loki.js.map" "$RUN_TMP/err"; } && ok "check-clean fails naming the stale map" || bad "check-clean missed a stale map (rc=$rc)"
git -C "$C" add loki-ts/dist/loki.js.map; git -C "$C" commit -q --amend --no-edit
ROOT_DIR="$C" release_commit_clean 2>/dev/null && ok "check-clean passes once both files are committed" || bad "check-clean failed on a clean tree"

# E-152: the "stage these files" list prints `git add -f` for paths under an ignored dir.
S="$RUN_TMP/stage"; mkdir -p "$S/dist" "$S/src"
git -C "$S" init -q; git -C "$S" config user.name t; git -C "$S" config user.email t@example.com
echo 'dist/' >"$S/.gitignore"; echo a >"$S/src/a.txt"; echo b >"$S/dist/b.js"
git -C "$S" add .gitignore src/a.txt; git -C "$S" add -f dist/b.js; git -C "$S" commit -q -m init
echo a2 >"$S/src/a.txt"; echo b2 >"$S/dist/b.js"
if declare -F release_stage_lines >/dev/null; then
    OUT=$(ROOT_DIR="$S" release_stage_lines)
else OUT=""; fi
printf '%s\n' "$OUT" | grep -qx '  git add -f dist/b.js' && ok "ignored-dir path gets git add -f" || bad "no git add -f for ignored path: $OUT"
printf '%s\n' "$OUT" | grep -qx '  git add src/a.txt' && ok "normal path gets plain git add" || bad "plain path line missing: $OUT"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
