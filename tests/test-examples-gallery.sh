#!/usr/bin/env bash
# tests/test-examples-gallery.sh
# TEN-ADOPTION-07: every bundle in the examples/ receipt gallery must verify with
# its own pubkey.jwk through the real verifier (bin/loki verify), and the README
# must list exactly the bundles on disk, each with an allowed outcome. The UI demos
# must sit under the "UI demos (no receipt)" heading.
#
# GALLERY_DIR optionally overrides the examples dir.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/bin/loki"
GALLERY="${GALLERY_DIR:-$REPO_ROOT/examples}"

verify_gallery() {
    local dir="$1" readme="$1/README.md" name verdict bad=0 listed on_disk n=0
    if [ ! -f "$readme" ]; then echo "FAIL: $readme missing"; return 1; fi
    if [ ! -d "$dir/receipts" ]; then echo "FAIL: $dir/receipts missing"; return 1; fi
    grep -q '^## UI demos (no receipt)$' "$readme" || { echo "FAIL: README lacks the 'UI demos (no receipt)' heading"; bad=1; }
    listed=$(grep -o '](receipts/[^/)]*/)' "$readme" | sed 's|^](receipts/||; s|/)$||' | sort -u)
    on_disk=$(cd "$dir/receipts" && find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | sort)
    [ -n "$listed" ] || { echo "FAIL: README lists no receipt bundle"; return 1; }
    for name in $listed; do
        n=$((n + 1))
        if [ ! -d "$dir/receipts/$name" ]; then echo "FAIL: $name listed in README but receipts/$name does not exist"; bad=1; continue; fi
        local row
        row=$(grep -F "](receipts/$name/)" "$readme" | head -n 1)
        case "$row" in
            *"| VERIFIED |"*|*"| ALREADY_SATISFIED |"*) ;;
            *) echo "FAIL: $name README outcome is not VERIFIED or ALREADY_SATISFIED"; bad=1 ;;
        esac
        printf '%s' "$row" | grep -q '\$[0-9]' || { echo "FAIL: $name README row has no cost"; bad=1; }
        printf '%s' "$row" | grep -q 'verify --pubkey pubkey.jwk receipt.json' || { echo "FAIL: $name README row has no verify command"; bad=1; }
        for f in receipt.json events.jsonl pubkey.jwk; do
            [ -f "$dir/receipts/$name/$f" ] || { echo "FAIL: $name missing $f"; bad=1; }
        done
        [ -f "$dir/receipts/$name/pubkey.jwk" ] && [ -f "$dir/receipts/$name/receipt.json" ] || continue
        if grep -q '"d"' "$dir/receipts/$name/pubkey.jwk"; then echo "FAIL: $name pubkey.jwk carries a private member"; bad=1; fi
        verdict=$(cd "$dir/receipts/$name" && "$LOKI" verify --pubkey pubkey.jwk receipt.json 2>&1 | sed -n 's/^verdict: //p' | head -n 1)
        case "$verdict" in
            VERIFIED|ALREADY_SATISFIED) ;;
            *) echo "FAIL: $name verifier verdict is '${verdict:-none}'"; bad=1 ;;
        esac
    done
    for name in $on_disk; do
        printf '%s\n' "$listed" | grep -qx "$name" || { echo "FAIL: receipts/$name is on disk but not listed in README"; bad=1; }
    done
    [ "$bad" -eq 0 ] && echo "OK: $n gallery bundle(s) verified"
    return "$bad"
}

if ! command -v bun >/dev/null 2>&1; then
    echo "SKIP: bun not available; the verifier cannot run"
    exit 0
fi

PASS=0
FAIL=0
ok() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
no() { echo "[FAIL] $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/loki-gallerytest.XXXXXXXX")
trap 'rm -rf "$TMP"' EXIT

# 1. the real gallery
out=$(verify_gallery "$GALLERY"); rc=$?
[ "$rc" -eq 0 ] && ok "gallery verifies: $out" || no "gallery verifies" "$out"

# Mutation helper: copy the gallery, apply a change, expect red with a message.
mutate() {
    local label="$1" want="$2" fn="$3" d="$TMP/$1"
    mkdir -p "$d"
    cp -R "$GALLERY/README.md" "$GALLERY/receipts" "$d/"
    "$fn" "$d"
    local o r
    o=$(verify_gallery "$d"); r=$?
    if [ "$r" -ne 0 ] && printf '%s\n' "$o" | grep -q "$want"; then ok "mutation $label is red ($want)"; else no "mutation $label" "rc=$r out=$o"; fi
}

first=$(grep -o '](receipts/[^/)]*/)' "$GALLERY/README.md" | head -n 1 | sed 's|^](receipts/||; s|/)$||')

# (a) one byte edit in a receipt -> TAMPERED
m_tamper() { sed 's/"turns": 7/"turns": 8/' "$1/receipts/$first/receipt.json" > "$1/x" && mv "$1/x" "$1/receipts/$first/receipt.json"; }
mutate tamper "verdict is 'TAMPERED'" m_tamper

# (b) README entry whose directory does not exist
m_ghost() { printf '\n| [ghost](receipts/ghost/) | none | VERIFIED | $0.01 | `verify --pubkey pubkey.jwk receipt.json` |\n' >> "$1/README.md"; }
mutate ghost "receipts/ghost does not exist" m_ghost

# (c) a FAILED entry in the gallery (README outcome column)
m_failed() { sed "/](receipts\/$first\/)/s/| VERIFIED |/| FAILED |/" "$1/README.md" > "$1/x" && mv "$1/x" "$1/README.md"; }
mutate failed "outcome is not VERIFIED" m_failed

# (d) bundle on disk but not listed
m_orphan() { cp -R "$1/receipts/$first" "$1/receipts/orphan"; }
mutate orphan "on disk but not listed" m_orphan

# (e) wrong pubkey -> not VERIFIED
m_key() { printf '{"kty":"OKP","crv":"Ed25519","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","alg":"EdDSA","use":"sig"}\n' > "$1/receipts/$first/pubkey.jwk"; }
mutate wrongkey "verifier verdict is" m_key

# (f) UI demos heading removed
m_head() { sed 's/^## UI demos (no receipt)$/## Demo Apps/' "$1/README.md" > "$1/x" && mv "$1/x" "$1/README.md"; }
mutate heading "lacks the 'UI demos" m_head

# (g) receipts dir missing entirely (the red state before this slice)
nod="$TMP/norec"; mkdir -p "$nod"; cp "$GALLERY/README.md" "$nod/"
o=$(verify_gallery "$nod"); r=$?
{ [ "$r" -ne 0 ] && printf '%s\n' "$o" | grep -q 'receipts missing'; } && ok "missing receipts dir is red" || no "missing receipts dir" "rc=$r $o"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
