#!/usr/bin/env bash
# E-35 (ENGINE.md section 24): the legacy-engine deprecation notice text and
# its CHANGELOG entry. The notice file is read by E-31's `legacy)` arm in
# bin/loki (not built yet), so the "notice reaches stderr" assertion below
# reports SKIP until that arm exists.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NOTICE="$ROOT/autonomy/lib/engine10-legacy-notice.txt"
CHANGELOG="$ROOT/CHANGELOG.md"
LOKI="$ROOT/bin/loki"

PASS=0
FAIL=0
SKIP=0
pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP: %s\n' "$1"; }

if [ -f "$NOTICE" ]; then
    pass "notice file exists"
else
    fail "notice file missing: $NOTICE"
fi

if [ -f "$NOTICE" ]; then
    lines=$(wc -l < "$NOTICE" | tr -d ' ')
    if [ "$lines" -le 3 ]; then
        pass "notice is 3 lines or fewer ($lines)"
    else
        fail "notice has $lines lines, expected 3 or fewer"
    fi

    if grep -q 'LOKI_ENGINE=legacy' "$NOTICE"; then
        pass "notice names LOKI_ENGINE=legacy"
    else
        fail "notice does not mention LOKI_ENGINE=legacy"
    fi

    if grep -q 'removed in' "$NOTICE"; then
        fail "notice contains the literal phrase 'removed in'"
    else
        pass "notice avoids the literal phrase 'removed in'"
    fi

    if grep -q 'autonomy/loki' "$NOTICE"; then
        fail "notice references the no-edit autonomy/loki path"
    else
        pass "notice avoids autonomy/loki"
    fi
else
    skip "notice content checks (file missing)"
fi

if [ -f "$CHANGELOG" ]; then
    # The Deprecated entry names loki legacy. It starts under Unreleased and
    # moves into its release section when it ships, so read every
    # "### Deprecated" block instead of pinning Unreleased (pinning broke
    # this test at the first release after the entry was written).
    block=$(awk '/^### Deprecated/{f=1; print; next} /^##/{f=0} f{print}' "$CHANGELOG")

    if printf '%s' "$block" | grep -q '### Deprecated'; then
        pass "CHANGELOG has a Deprecated entry"
    else
        fail "CHANGELOG has no Deprecated entry"
    fi

    if printf '%s' "$block" | grep -q 'loki legacy'; then
        pass "CHANGELOG Deprecated entry names loki legacy"
    else
        fail "CHANGELOG Deprecated entry does not name loki legacy"
    fi

    # The flip moves from Unreleased into its release section when it ships,
    # so look for it anywhere in the changelog, not only under Unreleased.
    if grep -qiE 'Loki 10.*now the default' "$CHANGELOG"; then
        pass "CHANGELOG records the v10 default flip (D48)"
    else
        fail "CHANGELOG does not record the v10 default flip"
    fi
else
    fail "CHANGELOG.md missing"
fi

# E-31 landed once bin/loki has a `legacy)` case arm. Until then, this stays SKIP.
if [ -f "$LOKI" ] && grep -qE '^[[:space:]]*legacy(\)|\|)' "$LOKI"; then
    first_line=$(head -n 1 "$NOTICE" 2>/dev/null || true)
    out=$("$LOKI" legacy --help 2>&1 1>/dev/null)
    if [ -n "$first_line" ] && printf '%s' "$out" | grep -qF "$first_line"; then
        pass "loki legacy --help stderr contains the notice's first line"
    else
        fail "loki legacy --help stderr does not contain the notice's first line"
    fi
else
    skip "loki legacy --help notice (E-31's legacy) arm not present yet)"
fi

echo
printf 'Results: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
