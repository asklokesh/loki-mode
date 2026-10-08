#!/usr/bin/env bash
# WF-GATE-DEDUP: the two release-gate checks that the Tests workflow cannot make.
#
#   build   rebuild loki-ts/dist from the checked-out release SHA (the caller
#           has already run `bun install --frozen-lockfile`) and require it to
#           be byte-identical to the dist committed at HEAD, ignoring only the
#           per-checkout debugId (the "//# debugId=" trailer of a bundle and the
#           top-level "debugId" key of a map).
#   tarball <tgz>
#           require the loki-ts/dist files inside a packed npm tarball to match
#           the dist committed at HEAD under the same debugId rule.
#
# Tests already runs tsc and the impacted bun tests on this tree (or on the
# bump-only parent, FC-70); required-ci enforces that verdict before publish.
# Neither belongs here. Exit 0 = match, 1 = mismatch, 2 = usage or tool error.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
DIST_FILES="loki.js loki.js.map cockpit.js cockpit.js.map"

# normalize <file>: the bytes with only the debugId removed.
normalize() {
    python3 -I - "$1" <<'PYEOF'
import re, sys
b = open(sys.argv[1], "rb").read()
if sys.argv[1].endswith(".map"):
    b = re.sub(rb'("debugId"\s*:\s*")[0-9A-Fa-f-]+(")', rb"\1\2", b)
else:
    b = re.sub(rb"(?:\r\n|\r|\n)?//# debugId=[0-9A-Fa-f-]+[ \t]*(?:\r\n|\r|\n)?\Z", b"", b)
sys.stdout.buffer.write(b)
PYEOF
}

# compare_set <dir holding the candidate dist files> <label>
compare_set() {
    local dir="$1" label="$2" f rc=0 tmp
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-dist.XXXXXXXX")" || return 2
    for f in $DIST_FILES; do
        if ! git show "HEAD:loki-ts/dist/$f" >"$tmp/committed.$f" 2>/dev/null; then
            echo "FATAL: loki-ts/dist/$f is not committed at HEAD"; rc=1; continue
        fi
        if [ ! -f "$dir/$f" ]; then
            echo "FATAL: $label has no loki-ts/dist/$f"; rc=1; continue
        fi
        normalize "$tmp/committed.$f" >"$tmp/a" || { rm -rf "$tmp"; return 2; }
        normalize "$dir/$f" >"$tmp/b" || { rm -rf "$tmp"; return 2; }
        if cmp -s "$tmp/a" "$tmp/b"; then
            echo "OK: $label loki-ts/dist/$f matches the committed dist"
        else
            echo "FATAL: $label loki-ts/dist/$f differs from the committed dist (beyond debugId)"
            rc=1
        fi
    done
    rm -rf "$tmp"
    return "$rc"
}

case "${1:-}" in
    build)
        ( cd "$REPO_ROOT/loki-ts" && bun run build ) || { echo "FATAL: loki-ts build failed"; exit 1; }
        compare_set "$REPO_ROOT/loki-ts/dist" "built" ;;
    tarball)
        tgz="${2:-}"
        [ -f "$tgz" ] || { echo "usage: $0 tarball <file.tgz>" >&2; exit 2; }
        out="$(mktemp -d "${TMPDIR:-/tmp}/verify-tgz.XXXXXXXX")" || exit 2
        # package.json "files" ships the two bundles; the .map files stay out.
        DIST_FILES="loki.js cockpit.js"
        for f in $DIST_FILES; do
            tar -xzf "$tgz" -C "$out" "package/loki-ts/dist/$f" 2>/dev/null \
                || { echo "FATAL: packed tarball has no loki-ts/dist/$f"; rm -rf "$out"; exit 1; }
        done
        compare_set "$out/package/loki-ts/dist" "packed"; rc=$?
        rm -rf "$out"
        exit "$rc" ;;
    *) echo "usage: $0 build | tarball <file.tgz>" >&2; exit 2 ;;
esac
