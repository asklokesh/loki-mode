#!/usr/bin/env bash
# M-30 (docs/v10/GUIDE-MODERNIZE.md): pins the `loki modernize` user guide to
# its ground truth, loki-ts/src/engine10/modernize/cli.ts, so the doc can
# never claim a flag the CLI does not have, or omit a flag the CLI does have.
# Also bans emoji/em dash/en dash per the repo-wide style rule.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUIDE="${MODERNIZE_DOCS_GUIDE:-$REPO_ROOT/docs/v10/GUIDE-MODERNIZE.md}"
CLI="$REPO_ROOT/loki-ts/src/engine10/modernize/cli.ts"

PASS=0
FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo "T1 -- required files exist"
if [ -f "$GUIDE" ]; then
    ok "docs/v10/GUIDE-MODERNIZE.md exists"
else
    bad "$GUIDE is missing"
    echo "  Passed: $PASS  Failed: $FAIL"
    exit 1
fi
if [ -f "$CLI" ]; then
    ok "modernize/cli.ts exists"
else
    bad "modernize/cli.ts is missing; nothing to check the docs against"
    echo "  Passed: $PASS  Failed: $FAIL"
    exit 1
fi

echo
echo "T2 -- 150 lines or fewer"
LINES=$(wc -l < "$GUIDE" | tr -d ' ')
if [ "$LINES" -le 150 ]; then
    ok "guide is $LINES lines"
else
    bad "guide is $LINES lines, want 150 or fewer"
fi

# Ground truth: the flags parseArgs actually switches on ("case "--foo":"),
# which is also exactly the flag set cli.ts's own USAGE string documents.
CLI_FLAGS="$(grep -oE 'case "--[a-zA-Z-]+"' "$CLI" | sed -E 's/case "(--[a-zA-Z-]+)"/\1/' | sort -u)"
GUIDE_FLAGS="$(grep -oE -- '--[a-zA-Z][a-zA-Z-]*' "$GUIDE" | sort -u)"

if [ -n "$CLI_FLAGS" ]; then
    ok "extracted $(printf '%s\n' "$CLI_FLAGS" | wc -l | tr -d ' ') flag(s) from cli.ts"
else
    bad "could not extract any flags from cli.ts; test is inert"
fi

echo
echo "T3 -- every flag the guide mentions exists in cli.ts"
while IFS= read -r flag; do
    [ -z "$flag" ] && continue
    if printf '%s\n' "$CLI_FLAGS" | grep -qxF -- "$flag"; then
        ok "guide flag $flag is a real cli.ts flag"
    else
        bad "guide mentions $flag, which is not a flag cli.ts parses"
    fi
done <<< "$GUIDE_FLAGS"

echo
echo "T4 -- every cli.ts flag is documented in the guide"
while IFS= read -r flag; do
    [ -z "$flag" ] && continue
    if printf '%s\n' "$GUIDE_FLAGS" | grep -qxF -- "$flag"; then
        ok "cli.ts flag $flag is documented"
    else
        bad "cli.ts has $flag, but the guide never mentions it"
    fi
done <<< "$CLI_FLAGS"

echo
echo "T5 -- no emoji, em dash or en dash in the guide"
EMDASH=$'\xe2\x80\x94'
ENDASH=$'\xe2\x80\x93'
if grep -qF -- "$EMDASH" "$GUIDE"; then
    bad "guide contains an em dash"
else
    ok "no em dash"
fi
if grep -qF -- "$ENDASH" "$GUIDE"; then
    bad "guide contains an en dash"
else
    ok "no en dash"
fi
# Emoji: any codepoint in the common emoji blocks (pictographs, symbols,
# transport, dingbats, supplemental symbols/pictographs). Checked with
# python3 (already a portability dependency elsewhere in tests/), not
# `grep -P`: BSD grep has no -P at all, and this host's PATH resolves to
# BSD grep outside an interactive shell, so a -P pattern is not portable
# here.
if python3 -c "
import sys
text = open('$GUIDE', encoding='utf-8').read()
for ch in text:
    cp = ord(ch)
    if 0x1F300 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF:
        sys.exit(1)
sys.exit(0)
"; then
    ok "no emoji"
else
    bad "guide contains an emoji"
fi

echo
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
