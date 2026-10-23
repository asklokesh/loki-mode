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
export LOKI_FAST_VERIFY_CACHE_DIR="$TMP/user-cache"

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

# ---- CACHE BINDING: an agent-writable entry must never decide a verdict ---
# The agent can compute blake2b(content) and plant "[]" for a file with a high
# finding. Neither a repo-local file nor an unauthenticated entry in the real
# cache location may suppress it.
PW="$TMP/planted"; mkdir -p "$PW/src"
git init -q "$PW" 2>/dev/null
cp "$W/src/Orders.tsx" "$PW/src/Orders.tsx"
git -C "$PW" add -A >/dev/null 2>&1
rm -rf "$LOKI_FAST_VERIFY_CACHE_DIR"
python3 - "$FV" "$PW" <<'PYEOF'
import hashlib, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("fv", sys.argv[1])
fv = importlib.util.module_from_spec(spec)
sys.modules["fv"] = fv
spec.loader.exec_module(fv)
root = sys.argv[2]
raw = open(os.path.join(root, "src", "Orders.tsx"), "rb").read()
key = fv.cache_key("src/Orders.tsx", raw)
legacy = os.path.join(root, ".loki", "cache", "fast-verify.json")
os.makedirs(os.path.dirname(legacy), exist_ok=True)
json.dump({"schema": 1, "entries": {key: []}}, open(legacy, "w"))
real = fv.cache_path(root)
os.makedirs(os.path.dirname(real), exist_ok=True)
json.dump({"producer": fv.PRODUCER, "entries": {key: {"findings": [], "mac": "00" * 32}}}, open(real, "w"))
PYEOF
PV="$(cd "$PW" && timeout 120 python3 "$FV" . --json 2>/dev/null)"
if printf '%s' "$PV" | python3 -c "
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d['verdict']=='FAIL' and any(f['rule']=='mock_render' for f in d['findings']) and d['files_from_cache']==0 else 1)"; then
    ok "a planted empty-list cache entry (repo-local or forged MAC) does not suppress a high finding"
else
    bad "a planted cache entry suppressed or replaced a finding -- the cache is trusted without a binding"
fi
PV2="$(cd "$PW" && timeout 120 python3 "$FV" . --json 2>/dev/null)"
if printf '%s' "$PV2" | python3 -c "
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d['verdict']=='FAIL' and d['files_from_cache']>0 else 1)"; then
    ok "after the rescan the authenticated entry is cached and hit with the same verdict"
else
    bad "the authenticated cache was not reused after a rescan"
fi

# ---- CACHE KEY: the verdict is derived from the content AND the path -----
# is_test picks which rules run, so a file cached under a test path must not
# replay its PASS after a move to a product path.
verdict_of() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d['verdict'], d['files_from_cache'])"; }
MW="$TMP/moved"; mkdir -p "$MW/src"
git init -q "$MW" 2>/dev/null
cp "$W/src/Orders.tsx" "$MW/src/Orders.test.tsx"
git -C "$MW" add -A >/dev/null 2>&1
M1="$(cd "$MW" && timeout 120 python3 "$FV" . --json 2>/dev/null | verdict_of)"
git -C "$MW" mv src/Orders.test.tsx src/Orders.tsx
M2="$(cd "$MW" && timeout 120 python3 "$FV" . --json 2>/dev/null | verdict_of)"
M3="$(cd "$MW" && timeout 120 python3 "$FV" . --no-cache --json 2>/dev/null | verdict_of)"
if [ "${M1%% *}" = "PASS" ] && [ "${M2%% *}" = "FAIL" ] && [ "${M2##* }" = "0" ] && [ "${M3%% *}" = "FAIL" ]; then
    ok "test-path content moved to a product path is rescanned and FAILs (cached == --no-cache)"
else
    bad "a path move replayed a cached verdict: test-path='$M1' moved='$M2' no-cache='$M3'"
fi

# ---- CACHE KEY: a rule change must orphan every cached verdict -----------
# Cache a PASS under a copy whose rules are disabled, then run the real rules
# against the same cache: the entry must not be replayed.
WEAK="$TMP/fv-weak.py"
sed 's/got\.extend(rule(rel, text))/pass/' "$FV" > "$WEAK"
RW="$TMP/rules"; mkdir -p "$RW/src"
git init -q "$RW" 2>/dev/null
cp "$W/src/Orders.tsx" "$RW/src/Orders.tsx"
git -C "$RW" add -A >/dev/null 2>&1
R1="$(cd "$RW" && timeout 120 python3 "$WEAK" . --json 2>/dev/null | verdict_of)"
R1b="$(cd "$RW" && timeout 120 python3 "$WEAK" . --json 2>/dev/null | verdict_of)"
R2="$(cd "$RW" && timeout 120 python3 "$FV" . --json 2>/dev/null | verdict_of)"
if [ "${R1%% *}" = "PASS" ] && [ "${R1b##* }" != "0" ] && [ "${R2%% *}" = "FAIL" ] && [ "${R2##* }" = "0" ]; then
    ok "a cache written under different rules is not replayed (fingerprint derived from fast_verify.py)"
else
    bad "a rule change did not invalidate the cache: weak='$R1' weak-warm='$R1b' real='$R2'"
fi
if grep -q "CACHE_SCHEMA" "$FV"; then
    bad "a hand-bumped CACHE_SCHEMA constant is back; the fingerprint must come from the source bytes"
else
    ok "no manual cache-schema constant"
fi

# ---- CACHE FILES: private modes, outside the repo (the planted repo is excluded:
# its legacy file is the test's own plant) --------------------------
modes="$(python3 - "$LOKI_FAST_VERIFY_CACHE_DIR" "$FV" "$RW" <<'PYEOF'
import importlib.util, os, stat, sys
cdir, fvp, root = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("fvm", fvp)
fv = importlib.util.module_from_spec(spec); sys.modules["fvm"] = fv; spec.loader.exec_module(fv)
m = lambda p: oct(stat.S_IMODE(os.stat(p).st_mode))
print(m(cdir), m(os.path.join(cdir, "key")), m(fv.cache_path(root)))
PYEOF
)"
if [ "$modes" = "0o700 0o600 0o600" ]; then
    ok "cache dir 0700, key 0600, cache json 0600"
else
    bad "cache file modes are '$modes', expected '0o700 0o600 0o600'"
fi
LOOSE="$TMP/loose-cache"; mkdir -m 777 "$LOOSE"
(cd "$RW" && LOKI_FAST_VERIFY_CACHE_DIR="$LOOSE" timeout 120 python3 "$FV" . --json >/dev/null 2>&1)
lmode="$(python3 -c "import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))" "$LOOSE")"
if [ "$lmode" = "0o700" ]; then ok "a pre-existing 0777 cache dir is tightened to 0700"; else bad "pre-existing cache dir stayed $lmode"; fi
if [ -z "$(find "$LOOSE" -name '.tmp-*' 2>/dev/null)" ]; then ok "no temp files left behind by the atomic writes"; else bad "temp files left in the cache dir"; fi
stray="$(find "$W" "$MW" "$RW" \( -name 'fast-verify*.json' -o -path '*/.loki/cache*' \) -not -path '*/.git/*' 2>/dev/null | head -3)"
if [ -z "$stray" ]; then ok "no verify cache file is written inside any repo"; else bad "cache file inside a repo: $stray"; fi

# ---- EXIT CODES: INCONCLUSIVE=3, unknown flag=64, missing root=2 ----------
E="$TMP/empty"; mkdir -p "$E"
rc=0; python3 "$FV" "$E" --no-cache >/dev/null 2>&1 || rc=$?
if [ "$rc" = "3" ]; then ok "nothing scanned (INCONCLUSIVE) exits 3"; else bad "INCONCLUSIVE exited $rc, expected 3"; fi
rc=0; python3 "$FV" "$E" --no-cache --no-such-flag >/dev/null 2>&1 || rc=$?
if [ "$rc" = "64" ]; then ok "unknown flag exits 64"; else bad "unknown flag exited $rc, expected 64"; fi
rc=0; python3 "$FV" "$TMP/absent-root" --no-cache >/dev/null 2>&1 || rc=$?
if [ "$rc" = "2" ]; then ok "missing root exits 2"; else bad "missing root exited $rc, expected 2"; fi
rc=0; (cd "$W" && python3 "$FV" . --no-cache >/dev/null 2>&1) || rc=$?
if [ "$rc" = "1" ]; then ok "FAIL still exits 1 (control)"; else bad "FAIL exited $rc, expected 1"; fi

rc=0; python3 "$FV" --path "$E" --no-cache >/dev/null 2>&1 || rc=$?
if [ "$rc" = "3" ]; then ok "--path DIR is accepted as the root (INCONCLUSIVE exits 3)"; else bad "--path exited $rc, expected 3"; fi
rc=0; python3 "$FV" --path "$TMP/absent-root" >/dev/null 2>&1 || rc=$?
if [ "$rc" = "2" ]; then ok "--path to a missing dir exits 2"; else bad "--path missing exited $rc, expected 2"; fi
rc=0; hout="$(python3 "$FV" --help 2>/dev/null)" || rc=$?
if [ "$rc" = "0" ] && printf '%s' "$hout" | grep -q "usage:"; then ok "--help exits 0 with usage on stdout"; else bad "--help exited $rc"; fi

# ---- EXOGENOUS: no model, no network -------------------------------------
if grep -qE "anthropic|openai|requests\.|urllib\.request|httpx|provider_invoke" "$FV"; then
    bad "fast path references a model/network call -- it must be purely deterministic"
else
    ok "no LLM or network on the fast path (exogenous, therefore trustworthy)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
