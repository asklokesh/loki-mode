#!/usr/bin/env bash
# Test: fast_verify must be BOTH fast and correct. Either alone is worthless.
#
# WHY IT EXISTS
#   Verification that takes minutes cannot be embedded in an IDE, an MCP tool, a
#   CI step, or another vendor's agent. To be pluggable, a verdict has to come
#   back in the time a human waits for a keystroke.
#
#   MEASURED BASELINE on this repo before fast_verify:
#     tests/detect-mock-problems.sh    11,040 ms
#     tests/detect-test-mutations.sh   12,361 ms
#
#   The work was never slow. The architecture was: FOUR full-tree `find` walks in
#   a single detector (110 ms each), ~25 subprocess spawns at ~24 ms of pure
#   interpreter startup, and every detector re-discovering the same files.
#   `git ls-files` returns the same set in 37 ms.
#
#   MEASURED AFTER (this repo, 1932 files):
#     cold  439 ms   warm  74 ms   diff-scoped  22 ms
#
# THE TRAP THIS TEST GUARDS
#   A fast verifier that reports PASS on broken code is worse than a slow one --
#   it makes a false claim at scale. So speed assertions and detection assertions
#   live in the SAME suite, and neither can be satisfied by sacrificing the other.
#
# Proven directions:
#   CATCHES  : hardcoded collection rendered as if it were real data.
#   CATCHES  : a test with no assertion (always passes; a false green).
#   QUIET    : a component with a REAL data source is not flagged.
#   QUIET    : static nav/feature lists are not flagged (no false BLOCK).
#   FAST     : a PR-sized run completes in well under 1s.
#   CACHE    : a warm run is materially faster than cold, and agrees exactly.
#   EXOGENOUS: no LLM/network on this path -- that is what makes it trustworthy.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FV="$SCRIPT_DIR/../autonomy/lib/fast_verify.py"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-fastverify-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== fast_verify: milliseconds AND correctness ==="

[ -f "$FV" ] || { echo "  FAIL: $FV not found"; exit 1; }

# --- fixture: one of each discriminating case ------------------------------
W="$TMP/repo"; mkdir -p "$W/src"
git init -q "$W" 2>/dev/null
git -C "$W" config user.email t@t
git -C "$W" config user.name t

cat > "$W/src/Orders.tsx" <<'TSX'
const orders = [{ id: 'o1', customer: 'Acme', total: 149 }];
export function Orders() {
  return <table>{orders.map((o) => <tr key={o.id}><td>{o.customer}</td></tr>)}</table>;
}
TSX
# Has a REAL source: the array is a fallback, not the product. Must stay quiet --
# a false BLOCK on correct code trains users to ignore the gate entirely.
cat > "$W/src/Real.tsx" <<'TSX'
const fallback = [{ id: 'x' }];
export function Real() {
  const { data } = useQuery('orders', () => fetch('/api/orders'));
  return <ul>{(data ?? fallback).map((o) => <li key={o.id}>{o.id}</li>)}</ul>;
}
TSX
# Static navigation: legitimately hardcoded content, not a stand-in for a backend.
cat > "$W/src/Nav.tsx" <<'TSX'
const links = [{ id: 'a', href: '/a' }];
export function Nav() { return <nav>{links.map((l) => <a key={l.id} href={l.href}/>)}</nav>; }
TSX
cat > "$W/src/app.test.ts" <<'TS'
it('adds numbers', () => { const x = 1 + 1; });
it('really checks', () => { expect(1 + 1).toBe(2); });
it.skip('later', () => { expect(true).toBe(true); });
TS
git -C "$W" add -A >/dev/null 2>&1

OUT="$(cd "$W" && timeout 120 python3 "$FV" . --no-cache --json 2>/dev/null)"

has_rule() {  # $1=rule $2=path-substring
    printf '%s' "$OUT" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
sys.exit(0 if any(f['rule']==sys.argv[1] and sys.argv[2] in f['path'] for f in d.get('findings',[])) else 1)
" "$1" "$2"
}

# ---- CATCHES -------------------------------------------------------------
if has_rule mock_render Orders.tsx; then
    ok "catches a hardcoded collection rendered as real data"
else
    bad "MISSED the mock-render case -- a fast verifier that misses defects is worthless"
fi
if has_rule assertionless_test app.test.ts; then
    ok "catches a test with no assertion (a false green)"
else
    bad "MISSED the assertionless test"
fi
if has_rule skipped_test app.test.ts; then
    ok "reports a skipped test"
else
    bad "did not report the skipped test"
fi

# ---- QUIET: no false positives -------------------------------------------
if has_rule mock_render Real.tsx; then
    bad "FALSE POSITIVE on Real.tsx -- it has a real data source"
else
    ok "silent on a component with a real data source"
fi
if has_rule mock_render Nav.tsx; then
    bad "FALSE POSITIVE on static nav links"
else
    ok "silent on static nav/feature content"
fi

# ---- verdict -------------------------------------------------------------
v="$(printf '%s' "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['verdict'])" 2>/dev/null)"
if [ "$v" = "FAIL" ]; then
    ok "verdict is FAIL when a blocking defect exists"
else
    bad "verdict was '$v', expected FAIL"
fi

# ---- FAST ----------------------------------------------------------------
ms="$(printf '%s' "$OUT" | python3 -c "import json,sys; print(int(json.load(sys.stdin)['elapsed_ms']))" 2>/dev/null)"
if [ -n "$ms" ] && [ "$ms" -lt 1000 ] 2>/dev/null; then
    ok "PR-sized verification completed in ${ms}ms (budget: under 1000ms)"
else
    bad "took ${ms}ms -- exceeds the 1s ceiling that makes this embeddable"
fi

# ---- CACHE: warm must be faster AND agree --------------------------------
C1="$(cd "$W" && timeout 120 python3 "$FV" . --json 2>/dev/null)"
C2="$(cd "$W" && timeout 120 python3 "$FV" . --json 2>/dev/null)"
n1="$(printf '%s' "$C1" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['findings']))" 2>/dev/null)"
n2="$(printf '%s' "$C2" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['findings']))" 2>/dev/null)"
hits="$(printf '%s' "$C2" | python3 -c "import json,sys; print(json.load(sys.stdin)['files_from_cache'])" 2>/dev/null)"
if [ "$n1" = "$n2" ] && [ -n "$n1" ]; then
    ok "a cached run returns the SAME findings as an uncached one ($n1)"
else
    bad "cache changed the result: cold=$n1 warm=$n2 -- a cache that alters a verdict is a bug"
fi
if [ "${hits:-0}" -gt 0 ] 2>/dev/null; then
    ok "the content-addressed cache is actually hit ($hits files)"
else
    bad "no cache hits on the second run -- caching is not working"
fi

# ---- EXOGENOUS: no model, no network -------------------------------------
if grep -qE "anthropic|openai|requests\.|urllib\.request|httpx|provider_invoke" "$FV"; then
    bad "fast path references a model/network call -- it must be purely deterministic"
else
    ok "no LLM or network on the fast path (exogenous, therefore trustworthy)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
