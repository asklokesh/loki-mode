#!/usr/bin/env bash
# The committed bundles (loki-ts/dist/loki.js, cockpit.js) are what npm, Docker and
# Homebrew run, and nothing else rebuilds them. This rebuilds loki-ts from the
# current source in a temp copy of the tree (the committed dist is never touched)
# and requires the output to equal the committed bundles, ignoring the debugId line
# (it is derived from a source map whose paths depend on where node_modules sits).
# Also requires web-app/dist/index.html to reference only assets that exist.
# Needs `bun install --cwd loki-ts --frozen-lockfile` first, and the pinned Bun
# (see .github/workflows/pr-fast.yml): a different Bun can emit different bytes.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/cli.ts: change any string literal without rebuilding dist.
#   2. web-app/dist/index.html: point a script src at /assets/missing-plant.js.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need tar
cd "$ROOT" || exit 2

echo "TEST: dist freshness"

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

norm() { sed -E 's/^\/\/# debugId=[A-F0-9]{32}$/\/\/# debugId=X/' "$1"; }
for f in loki.js cockpit.js; do
    if [ -f "loki-ts/dist/$f" ] && [ "$(norm "$B/loki-ts/dist/$f" | shasum -a 256)" = "$(norm "loki-ts/dist/$f" | shasum -a 256)" ]; then
        ok "committed loki-ts/dist/$f equals a fresh build"
    else
        bad "committed loki-ts/dist/$f is stale: run 'cd loki-ts && bun run build' and commit"
    fi
done

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
