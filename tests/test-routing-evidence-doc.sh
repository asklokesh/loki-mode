#!/usr/bin/env bash
# Guards docs/ROUTING-EVIDENCE.md: the doc exists, carries the cost-parity
# numbers with source and date, and the provider comment cites its real path.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOC_REL="docs/ROUTING-EVIDENCE.md"
DOC="$REPO_ROOT/$DOC_REL"
SRC="$REPO_ROOT/providers/opencode.sh"

PASS=0
FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

if [ -f "$DOC" ]; then ok "$DOC_REL exists"; else bad "$DOC_REL missing"; fi

cited="$(grep -o 'docs/[A-Za-z0-9_-]*\.md' "$SRC" | grep 'ROUTING-EVIDENCE' | head -1)"
if [ "$cited" = "$DOC_REL" ]; then
    ok "providers/opencode.sh cites $DOC_REL"
else
    bad "providers/opencode.sh does not cite $DOC_REL (found: ${cited:-none})"
fi
if [ -n "$cited" ] && [ -f "$REPO_ROOT/$cited" ]; then
    ok "cited path resolves to a file"
else
    bad "cited path does not resolve to a file"
fi

for tok in '75.8' '36.64' '75.6' '275.76' '7.5x' 'mini-swe-agent v2.0.0' '2026-02-17' \
           '190,871' 'v1.18.9' 'v0.86.0' '2025-08-09' '2026-07-29/30'; do
    if [ -f "$DOC" ] && grep -qF -- "$tok" "$DOC"; then
        ok "doc carries $tok"
    else
        bad "doc missing $tok"
    fi
done

if [ -f "$DOC" ] && grep -q 'Source' "$DOC" && grep -q 'Date' "$DOC"; then
    ok "doc records source and date"
else
    bad "doc lacks source or date lines"
fi

# en dash e2 80 93, em dash e2 80 94, 4-byte emoji lead bytes f0
if [ -f "$DOC" ] && LC_ALL=C grep -q $'\xe2\x80[\x93\x94]\|\xf0' "$DOC"; then
    bad "doc contains en dash, em dash or emoji bytes"
else
    ok "doc has no emoji, em dash or en dash"
fi

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
