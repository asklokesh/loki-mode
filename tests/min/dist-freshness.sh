#!/usr/bin/env bash
# loki-ts/dist is built, never committed: npm (prepack), Docker, the Homebrew asset and bin/loki
# on a git clone all build it. This test (name kept for the gate lists that name it) proves the
# build works from the current source in a temp copy of the tree and yields loki.js and
# cockpit.js (plus maps) that embed VERSION, that nothing under loki-ts/dist is tracked in git.
# The packed-tarball half (dist is inside `npm pack`) lives in pack-contents.sh.
# Needs `bun install --cwd loki-ts --frozen-lockfile` first and the pinned Bun (see
# bun-version in .github/workflows/release.yml).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/cli.ts: add a syntax error, the build step must fail.
#   2. `git add -f loki-ts/dist/loki.js`: the untracked check must fail.
#   3. loki-ts/scripts/build.ts: skip writing cockpit.js, the output check must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need tar
cd "$ROOT" || exit 2

echo "TEST: dist build"

[ -d loki-ts/node_modules ] || { echo "dist-freshness: run 'bun install --cwd loki-ts --frozen-lockfile' first" >&2; exit 2; }

B="$T/tree"
mkdir -p "$B"
tar -cf - --exclude=.git --exclude=node_modules --exclude=./loki-ts/dist \
    --exclude=./docs --exclude=./benchmarks --exclude=./tests --exclude=./wiki . | tar -xf - -C "$B"
ln -s "$ROOT/loki-ts/node_modules" "$B/loki-ts/node_modules"
if [ -d "$ROOT/packages/control-plane/node_modules" ]; then
    ln -s "$ROOT/packages/control-plane/node_modules" "$B/packages/control-plane/node_modules"
fi

(cd "$B/loki-ts" && bun run scripts/build.ts) > "$T/build.out" 2>&1 \
    && ok "loki-ts builds from source" || { bad "loki-ts build failed: $(tail -5 "$T/build.out")"; finish; exit $?; }

want="$(tr -d '\n' < VERSION)"
for f in loki.js loki.js.map cockpit.js cockpit.js.map; do
    [ -s "$B/loki-ts/dist/$f" ] && ok "fresh build wrote loki-ts/dist/$f" || bad "fresh build did not write loki-ts/dist/$f"
done
grep -qF "\"$want\"" "$B/loki-ts/dist/loki.js" 2>/dev/null \
    && ok "fresh loki.js embeds VERSION $want" || bad "fresh loki.js does not embed VERSION $want"

tracked="$(git ls-files loki-ts/dist 2>/dev/null)"
[ -z "$tracked" ] && ok "no file under loki-ts/dist is tracked" \
    || bad "loki-ts/dist is built at publish time and must not be committed; run: git rm -r --cached loki-ts/dist ($(printf '%s' "$tracked" | tr '\n' ' '))"

finish
