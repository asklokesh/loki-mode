#!/usr/bin/env bash
#===============================================================================
# Regression test for scripts/check-inline-scripts.js.
#
# The gate parses every inline <script> block with vm.Script. It exists because
# a build once corrupted backslash escapes inside an inline script and shipped
# a dead SPA that still returned HTTP 200. Covered here: valid inline script
# exits 0, a syntax error exits 1, <script src=...> blocks are ignored, and the
# escaped-backslash regression (valid '\\n' passes, a corrupted lone-backslash
# string literal fails).
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/../scripts/check-inline-scripts.js"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() { [ -n "$TMPROOT" ] && rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT

[ -f "$CHECKER" ] || { echo "FATAL: checker not found at $CHECKER"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node not installed"; exit 0; }

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-inline-scripts.XXXXXXXX")" || exit 2

expect_rc() {
    local label="$1" want="$2" file="$3" rc
    timeout -k 5 30 node "$CHECKER" "$file" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq "$want" ]; then ok "$label (rc=$rc)"; else bad "$label (want rc=$want, got rc=$rc)"; fi
}

# 1. valid inline script
cat >"$TMPROOT/valid.html" <<'HTML'
<html><body><script>var a = 1; function f(x) { return x + a; }</script></body></html>
HTML
expect_rc "valid inline script exits 0" 0 "$TMPROOT/valid.html"

# 2. syntax error
cat >"$TMPROOT/syntax.html" <<'HTML'
<html><body><script>function f( { return 1; </script></body></html>
HTML
expect_rc "syntax error exits 1" 1 "$TMPROOT/syntax.html"

# 3. src blocks ignored: an external block with a broken body must not fail
cat >"$TMPROOT/src.html" <<'HTML'
<html><body>
<script src="app.js">this is not ( valid javascript {{</script>
<script>var ok = true;</script>
</body></html>
HTML
expect_rc "script src block with bad body is ignored" 0 "$TMPROOT/src.html"

cat >"$TMPROOT/src-only.html" <<'HTML'
<html><body><script src="app.js"></script></body></html>
HTML
expect_rc "src-only file has no inline blocks and exits 1" 1 "$TMPROOT/src-only.html"

# 4. escaped-backslash regression
cat >"$TMPROOT/bs-good.html" <<'HTML'
<html><body><script>var s = "line1\\nline2"; var r = /\d+\\/; var p = 'C:\\dir';</script></body></html>
HTML
expect_rc "escaped backslashes in inline script exit 0" 0 "$TMPROOT/bs-good.html"

# A build that unescapes "\\" to "\" turns the closing quote into an escaped
# quote and leaves the string literal unterminated.
cat >"$TMPROOT/bs-bad.html" <<'HTML'
<html><body><script>var p = 'C:\'; var q = 2;</script></body></html>
HTML
expect_rc "corrupted backslash escape exits 1" 1 "$TMPROOT/bs-bad.html"

# 5. usage error
expect_rc "missing file exits 2" 2 "$TMPROOT/missing.html"

printf '\nPassed: %d  Failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
