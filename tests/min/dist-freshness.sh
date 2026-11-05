#!/usr/bin/env bash
# loki-ts/dist is built, never committed: npm (prepack), Docker, the Homebrew asset and bin/loki
# on a git clone all build it. This test (name kept for the gate lists that name it) proves the
# build works from the current source in a temp copy of the tree and yields loki.js and
# cockpit.js (plus maps) that embed VERSION, that nothing under loki-ts/dist is tracked in git,
# and that web-app/dist/index.html references only assets that exist. The packed-tarball half
# (dist is inside `npm pack`) lives in pack-contents.sh.
# Needs `bun install --cwd loki-ts --frozen-lockfile` first and the pinned Bun (see
# .github/workflows/pr-fast.yml).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/cli.ts: add a syntax error, the build step must fail.
#   2. `git add -f loki-ts/dist/loki.js`: the untracked check must fail.
#   3. loki-ts/scripts/build.ts: skip writing cockpit.js, the output check must fail.
#   4. web-app/dist/index.html: point a script src at /assets/missing-plant.js.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need tar
cd "$ROOT" || exit 2

echo "TEST: dist build"

[ -d loki-ts/node_modules ] || { echo "dist-freshness: run 'bun install --cwd loki-ts --frozen-lockfile' first" >&2; exit 2; }

B="$T/tree"
mkdir -p "$B"
tar -cf - --exclude=.git --exclude=node_modules --exclude=./loki-ts/dist --exclude=./web-app \
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

missing="$(python3 -I - "$ROOT/web-app/dist" <<'PY'
import os, re, sys
d = sys.argv[1]
html = open(os.path.join(d, "index.html"), encoding="utf-8").read()
refs = re.findall(r'(?:src|href)="(/[^"#?]+)"', html)
def local(r):  # the app is served under /lab/, so /lab/assets/x maps to dist/assets/x
    return r[len("/lab/"):] if r.startswith("/lab/") else r.lstrip("/")
missing = [r for r in refs if local(r).startswith("assets/") and not os.path.exists(os.path.join(d, local(r)))]
print(len(refs), " ".join(missing))
PY
)"
n_refs="${missing%% *}"; rest="${missing#"$n_refs"}"
[ "${n_refs:-0}" -gt 0 ] && ok "web-app/dist/index.html references $n_refs paths" || bad "web-app/dist/index.html references nothing"
[ -z "${rest# }" ] && ok "every referenced web-app asset exists" || bad "web-app/dist/index.html references missing assets:$rest"

finish
