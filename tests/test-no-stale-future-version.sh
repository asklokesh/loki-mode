#!/usr/bin/env bash
# D26 guard 16: a hardcoded "far-future" latest-version literal in tests/
# must stay far in the future relative to the CURRENT VERSION major, so a
# real major release doesn't overtake it (the 9.99.0 vs v10.0.0 incident,
# 306b6b0c). Also serves as the test that proves the scanner fires: it runs
# the scanner against the real tests/ tree (must be clean) and against a
# synthetic fixture dir that plants a stale version alongside a fresh one
# (must catch exactly the stale one).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF_BASENAME="$(basename "${BASH_SOURCE[0]}")"

version_major() { printf '%s\n' "${1%%.*}"; }

REPO_VERSION="$(cat "$REPO_ROOT/VERSION")"
THRESHOLD=$(( $(version_major "$REPO_VERSION") + 10 ))

# Matches "latest":"X.Y.Z", latest=X.Y.Z, latest: 'X.Y.Z' (quotes/spacing
# optional). The literal "latest" keyword anchors the match, so a sibling
# key on the same line (e.g. "current":"...") is never mistaken for it.
PATTERN="latest[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[0-9]+\.[0-9]+\.[0-9]+"

# Scans $1 (a directory; sh/py/ts files) for stale "latest" version
# literals and prints one "file:line: latest=X.Y.Z (major <= threshold N)"
# line per violation to stdout. $2=1 skips this guard's own file (it
# legitimately contains fixture text that matches $PATTERN). Always run
# over a directory, never a single file path: GNU grep -r on a lone
# regular-file operand omits the filename from its output.
scan_stale_latest() {
    local dir="$1" skip_self="$2" file lineno content m ver major
    while IFS=: read -r file lineno content; do
        [ -n "$file" ] || continue
        if [ "$skip_self" = "1" ] && [ "$(basename "$file")" = "$SELF_BASENAME" ]; then
            continue
        fi
        while IFS= read -r m; do
            [ -n "$m" ] || continue
            # Strip everything up to and including the last non-digit,
            # non-dot character, leaving just the trailing X.Y.Z -- so a
            # match is scored on ITS OWN version, not the first number
            # anywhere on the line.
            ver="${m##*[!0-9.]}"
            major="${ver%%.*}"
            if [ "$major" -le "$THRESHOLD" ]; then
                printf '%s:%s: latest=%s (major %s <= threshold %s)\n' \
                    "$file" "$lineno" "$ver" "$major" "$THRESHOLD"
            fi
        done < <(printf '%s\n' "$content" | grep -oE "$PATTERN" || true)
    done < <(grep -rnE "$PATTERN" --include='*.sh' --include='*.py' --include='*.ts' "$dir" 2>/dev/null || true)
}

fail=0

# 1. Guard proper: the real tests/ tree must be clean on main.
echo "=== scanning $REPO_ROOT/tests (threshold: major > $THRESHOLD) ==="
out_real="$(mktemp)"
scan_stale_latest "$REPO_ROOT/tests" 1 > "$out_real"
if [ -s "$out_real" ]; then
    echo "FAIL: stale future-version literal(s) found in tests/:"
    cat "$out_real"
    fail=1
else
    echo "PASS: no stale future-version literals in tests/"
fi
rm -f "$out_real"

# 2. Self-test: the scanner must catch a planted stale version (red case),
#    must not flag a genuinely far-future one on an adjacent line (green
#    case), and must score each "latest" occurrence on its OWN version even
#    when another version number shares the line.
fixture_dir="$(mktemp -d)"

cat > "$fixture_dir/test-fixture-stale.sh" <<'EOF'
_cache=/tmp/x
printf '{"checkedAt":0,"latest":"9.99.0"}\n' > "$_cache"
EOF
cat > "$fixture_dir/test-fixture-fresh.sh" <<'EOF'
_cache=/tmp/x
printf '{"checkedAt":0,"latest":"999.0.0"}\n' > "$_cache"
EOF
cat > "$fixture_dir/test-fixture-mixed.sh" <<'EOF'
# "latest" is stale even though a bigger, fresher number sits earlier on
# the same line under a different key -- must still be caught.
printf '{"current":"999.0.0","latest":"9.99.0"}\n' > /tmp/x
# "latest" is fresh even though a smaller, staler number sits earlier on
# the same line under a different key -- must NOT be flagged.
printf '{"version":"10.0.1","latest":"999.0.0"}\n' > /tmp/x
EOF

echo "=== scanning fixture dir (stale + fresh + mixed-line fixtures) ==="
out_fix="$(mktemp)"
scan_stale_latest "$fixture_dir" 0 > "$out_fix"
cat "$out_fix"

if ! grep -q 'test-fixture-stale\.sh:2:' "$out_fix"; then
    echo "FAIL: scanner did not catch the planted stale version in test-fixture-stale.sh"
    fail=1
else
    echo "PASS: scanner caught the planted stale fixture"
fi

if grep -q 'test-fixture-fresh\.sh' "$out_fix"; then
    echo "FAIL: scanner false-flagged the far-future fixture"
    fail=1
else
    echo "PASS: scanner left the far-future fixture alone"
fi

if ! grep -q 'test-fixture-mixed\.sh:3:' "$out_fix"; then
    echo "FAIL: scanner missed the stale 'latest' on a line with a fresher sibling number"
    fail=1
else
    echo "PASS: scanner scored the stale 'latest' on its own line, ignoring the sibling number"
fi

if grep -q 'test-fixture-mixed\.sh:5:' "$out_fix"; then
    echo "FAIL: scanner false-flagged the fresh 'latest' on a line with a staler sibling number"
    fail=1
else
    echo "PASS: scanner scored the fresh 'latest' on its own line, ignoring the sibling number"
fi

rm -f "$out_fix"
rm -rf "$fixture_dir"

if [ "$fail" -ne 0 ]; then
    echo "RESULT: FAIL"
    exit 1
fi
echo "RESULT: PASS"
