#!/usr/bin/env bash
# Guard (D26): no unvetted image under docs/v10/cp-redesign/, and no competitor
# or research screenshot tracked anywhere. Incident: a third-party product
# screenshot with a real person's name and customer data was committed there.
#
# Usage:
#   test-cp-redesign-images.sh            run the check on tracked files + self-test
#   test-cp-redesign-images.sh --staged   check staged files only (pre-commit)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMG_RE='\.(png|jpg|jpeg|gif|webp|svg|avif)$'
BAD_NAME_RE='vorflux|lovable|bolt|v0-|competitor'
DOC_DIR="docs/v10/cp-redesign"

# check_paths ROOT: read repo-relative paths on stdin, print one line per violation.
check_paths() {
    local root="$1" path base
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        printf '%s\n' "$path" | grep -Eiq "$IMG_RE" || continue
        base="${path##*/}"
        case "$path" in
            "$DOC_DIR"/*)
                if ! grep -v '^#' "$root/$DOC_DIR/ALLOWED-IMAGES.txt" 2>/dev/null \
                    | cut -d'|' -f1 | sed 's/[[:space:]]*$//' | grep -Fxq -- "$base"; then
                    echo "unlisted image: $path"
                fi
                ;;
        esac
        if printf '%s\n' "$base" | grep -Eiq "$BAD_NAME_RE"; then
            echo "banned image name: $path"
        fi
        case "$path" in
            *ui-refs*|*research/*) echo "banned image path: $path" ;;
        esac
    done
}

if [ "${1:-}" = "--staged" ]; then
    out="$(git -C "$REPO_ROOT" diff --cached --name-only --diff-filter=ACMR | check_paths "$REPO_ROOT")"
    if [ -n "$out" ]; then
        printf '%s\n' "$out" >&2
        echo "[cp-redesign-images] REFUSED: see docs/v10/cp-redesign/ALLOWED-IMAGES.txt" >&2
        exit 1
    fi
    exit 0
fi

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# 1. Real repo, tracked files only
out="$(git -C "$REPO_ROOT" ls-files | check_paths "$REPO_ROOT")"
if [ -z "$out" ]; then ok "tracked images pass the allowlist and name rules"; else bad "violations: $out"; fi

# 2. Manifest lists only files that exist
while IFS= read -r name; do
    if [ -f "$REPO_ROOT/$DOC_DIR/$name" ]; then ok "manifest entry exists: $name"; else bad "manifest entry missing on disk: $name"; fi
done < <(grep -v '^#' "$REPO_ROOT/$DOC_DIR/ALLOWED-IMAGES.txt" | cut -d'|' -f1 | sed 's/[[:space:]]*$//' | grep -v '^$')

# 3. Self-test against a fixture
FIX="$(mktemp -d "${TMPDIR:-/tmp}/cp-images-fixture.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$FIX"' EXIT
mkdir -p "$FIX/$DOC_DIR" "$FIX/ui-refs"
printf 'good.png | generated\n' > "$FIX/$DOC_DIR/ALLOWED-IMAGES.txt"
: > "$FIX/$DOC_DIR/good.png"
: > "$FIX/$DOC_DIR/stray.png"
: > "$FIX/ui-refs/shot.png"
: > "$FIX/Lovable-home.jpg"
out="$(cd "$FIX" && find . -type f | sed 's|^\./||' | check_paths "$FIX")"
case "$out" in *"unlisted image: $DOC_DIR/stray.png"*) ok "self-test: unlisted image fails" ;; *) bad "self-test: unlisted image not caught: $out" ;; esac
case "$out" in *"$DOC_DIR/good.png"*) bad "self-test: listed image flagged" ;; *) ok "self-test: listed image passes" ;; esac
case "$out" in *"banned image path: ui-refs/shot.png"*) ok "self-test: ui-refs path fails" ;; *) bad "self-test: ui-refs not caught" ;; esac
case "$out" in *"banned image name: Lovable-home.jpg"*) ok "self-test: banned name fails" ;; *) bad "self-test: banned name not caught" ;; esac

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
