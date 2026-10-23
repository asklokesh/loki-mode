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
if [ "${M1%% *}" = "INCONCLUSIVE" ] && [ "${M2%% *}" = "FAIL" ] && [ "${M2##* }" = "0" ] && [ "${M3%% *}" = "FAIL" ]; then
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
if [ "${R1%% *}" = "INCONCLUSIVE" ] && [ "${R1b##* }" != "0" ] && [ "${R2%% *}" = "FAIL" ] && [ "${R2##* }" = "0" ]; then
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

# ---- FC-FAST-VERIFY-PASS-WITHOUT-DETECTION: a verdict names its signals ----
# Seeded-defect cases (benchmarks/seeded-defects): the visible tests pass on the buggy src.
SEED="$SCRIPT_DIR/../benchmarks/seeded-defects/cases"
seed_repo() {  # $1=case id, $2=dest
    mkdir -p "$2"; cp "$SEED/$1"/src.py "$SEED/$1"/spec.md "$SEED/$1"/test_visible.py "$2/"
    git init -q "$2" 2>/dev/null; git -C "$2" add src.py spec.md test_visible.py >/dev/null 2>&1
}
jfield() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
S1="$TMP/seed-logic"; seed_repo SD-0001 "$S1"
J1="$(cd "$S1" && python3 "$FV" . --no-cache --json 2>/dev/null)"
if [ "$(printf '%s' "$J1" | jfield "d['verdict']")" = "INCONCLUSIVE" ] \
   && [ "$(printf '%s' "$J1" | jfield "d['static_clean'], d['signals']['behavioral'], d['signals']['wall_files_run'], d['signals']['tests_run']")" = "(True, False, 0, 0)" ] \
   && printf '%s' "$J1" | jfield "d['signals']['rules']" | grep -q mock_target; then
    ok "a seeded logic defect with no behavioral signal is INCONCLUSIVE (never PASS) and signals lists what ran"
else
    bad "no-behavioral-signal case did not return INCONCLUSIVE with signals: $J1"
fi
cat > "$S1/loki_wall_spec.py" <<'PY'
from src import *
def test_wall():
    assert False, "wall says the change is wrong"
PY
J2="$(cd "$S1" && python3 "$FV" . --no-cache --json 2>/dev/null)"
if [ "$(printf '%s' "$J2" | jfield "d['verdict']")" = "FAIL" ] && printf '%s' "$J2" | grep -q wall_failed; then
    ok "a present loki_wall_* file that fails flips the verdict to FAIL"
else
    bad "failing Wall file did not FAIL: $J2"
fi
# Provenance: an agent can write `assert True` into a loki_wall_* file, so only a tracked, unchanged Wall whose
# sha256 matches an engine10 `wall.sealed` event may earn PASS. Anything else can FAIL but never PASS.
printf 'from src import *\ndef test_wall():\n    assert True\n' > "$S1/loki_wall_spec.py"
fvj() { (cd "$1" && python3 "${2:-$FV}" . --no-cache --json 2>/dev/null); }
verdict_trusted() { printf '%s' "$1" | jfield "(d['verdict'], d['signals']['wall_files_run'], d['signals']['wall_files_trusted'])"; }
J3="$(fvj "$S1")"
if [ "$(verdict_trusted "$J3")" = "('INCONCLUSIVE', 1, 0)" ]; then
    ok "an untracked trivial Wall file that passes is INCONCLUSIVE (ran, not trusted)"
else bad "untracked passing Wall did not stay INCONCLUSIVE: $J3"; fi
G="git -C $S1 -c user.name=t -c user.email=t@t.invalid"
git -C "$S1" add src.py spec.md test_visible.py loki_wall_spec.py >/dev/null 2>&1; $G commit -qm base >/dev/null 2>&1
J3b="$(fvj "$S1")"
if [ "$(verdict_trusted "$J3b")" = "('INCONCLUSIVE', 1, 0)" ]; then
    ok "a committed trivial Wall with no matching engine10 seal hash is INCONCLUSIVE"
else bad "committed Wall without a seal hash was trusted: $J3b"; fi
SHA="$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$S1/loki_wall_spec.py")"
mkdir -p "$S1/.loki/runs/r1"
printf '{"v":1,"seq":1,"ts":"t","run":"r1","type":"wall.sealed","stage":"wall","data":{"files":[{"path":"%s/loki_wall_spec.py","sha256":"%s"}]}}\n' "$S1" "$SHA" > "$S1/.loki/runs/r1/events.jsonl"
J3c="$(fvj "$S1")"
if [ "$(printf '%s' "$J3c" | jfield "d['verdict']")" = "PASS" ] && [ "$(verdict_trusted "$J3c")" = "('PASS', 1, 1)" ]; then
    ok "a tracked, unchanged Wall file matching an engine10 wall.sealed hash is the behavioral signal that earns PASS"
else bad "sealed, tracked Wall did not PASS: $J3c"; fi
printf '# edited\n' >> "$S1/loki_wall_spec.py"
J3d="$(fvj "$S1")"
if [ "$(printf '%s' "$J3d" | jfield "d['verdict']")" = "INCONCLUSIVE" ]; then
    ok "a modified tracked Wall file loses its trust (INCONCLUSIVE)"
else bad "modified Wall still trusted: $J3d"; fi
git -C "$S1" checkout -q -- loki_wall_spec.py 2>/dev/null || git -C "$S1" restore loki_wall_spec.py
NOPROV="$TMP/fv-noprov.py"
sed 's/behavioral = wall_trusted > 0/behavioral = wall_ran > 0/' "$FV" > "$NOPROV"
S3="$TMP/seed-noprov"; seed_repo SD-0001 "$S3"; printf 'from src import *\ndef test_wall():\n    assert True\n' > "$S3/loki_wall_spec.py"
J3e="$(fvj "$S3" "$NOPROV")"
if cmp -s "$FV" "$NOPROV"; then bad "provenance mutant did not change fast_verify.py (sed pattern stale)"
elif [ "$(printf '%s' "$J3e" | jfield "d['verdict']")" = "PASS" ]; then ok "mutant that drops the provenance check turns the untracked-Wall case into PASS (guard bites)"
else bad "provenance mutant still INCONCLUSIVE; the test does not depend on the check"; fi
# Provenance is bound to the diff and fails closed (rev-a, CoS B1): a Wall earns PASS only if the run that sealed it
# (same events.jsonl: intake base_sha, commit head_sha) changed every file of the verified diff; a git error is never
# read as "unchanged"; a Wall added after the base is never trusted.
seal_event() { # repo wall [base_sha head_sha]
    mkdir -p "$1/.loki/runs/r1"
    python3 - "$@" <<'PY'
import hashlib, json, os, sys
repo, wall = sys.argv[1], sys.argv[2]
base = sys.argv[3] if len(sys.argv) > 3 else None
head = sys.argv[4] if len(sys.argv) > 4 else None
sha = hashlib.sha256(open(os.path.join(repo, wall), "rb").read()).hexdigest()
ev = lambda seq, typ, stage, data: json.dumps({"v": 1, "seq": seq, "ts": "t", "run": "r1", "type": typ, "stage": stage, "data": data})
lines = []
if base:
    lines.append(ev(1, "stage.completed", "intake", {"base_sha": base}))
lines.append(ev(2, "wall.sealed", "wall", {"files": [{"path": wall, "sha256": sha}]}))
if head:
    lines.append(ev(3, "stage.completed", "commit", {"committed": True, "head_sha": head}))
open(os.path.join(repo, ".loki/runs/r1/events.jsonl"), "w").write("\n".join(lines) + "\n")
PY
}
fvd() { (cd "$1" && python3 "${3:-$FV}" . --no-cache --json --diff-base "$2" 2>/dev/null); }
sha_of() { git -C "$1" rev-parse "$2"; }
D1="$TMP/diffbind"; mkdir -p "$D1"; git -C "$D1" init -q; GD="git -C $D1 -c user.name=t -c user.email=t@t.invalid"
printf 'def price(x):\n    return x * 2\n' > "$D1/price.py"; printf 'from price import price\ndef test_price():\n    assert price(2) == 4\n' > "$D1/test_price.py"
git -C "$D1" add price.py test_price.py; $GD commit -qm base
B0="$(sha_of "$D1" HEAD)"
printf 'def add(a, b):\n    return a + b\n' > "$D1/add.py"; printf 'from price import price\ndef test_add():\n    assert price(1) == 2\n' > "$D1/loki_wall_add.py"
git -C "$D1" add add.py loki_wall_add.py; $GD commit -qm "run: add.py plus a Wall that names price"
B1="$(sha_of "$D1" HEAD)"
seal_event "$D1" loki_wall_add.py "$B0" "$B1"
printf 'def price(x):\n    return x * 2  # edit outside the sealing run\n' > "$D1/price.py"; git -C "$D1" add price.py; $GD commit -qm "later price edit"
JD1="$(fvd "$D1" HEAD~1)"
if [ "$(verdict_trusted "$JD1")" = "('INCONCLUSIVE', 1, 0)" ] && printf '%s' "$JD1" | grep -q 'no run record lists changed files'; then
    ok "a Wall naming price whose sealing run changed only add.py is INCONCLUSIVE with a NOT PROVEN line"
else bad "Wall from a run that did not change the verified file was trusted: $JD1"; fi
TXT1="$(cd "$D1" && python3 "$FV" . --no-cache --diff-base HEAD~1 2>/dev/null || true)"; printf '%s' "$TXT1" | grep -q "NOT PROVEN" && ok "the text output prints the NOT PROVEN line" || bad "text output lacks the NOT PROVEN line"
JD2="$(fvd "$D1" nosuchref)"
if [ "$(printf '%s' "$JD2" | jfield "d['verdict']")" = "INCONCLUSIVE" ]; then ok "an unreadable --diff-base fails closed (INCONCLUSIVE), never trusts the Wall"
else bad "bad diff base still trusted the Wall: $JD2"; fi
NOCOV="$TMP/fv-nocov.py"
python3 - "$FV" "$NOCOV" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = "if not any(_run_covers(root, b, h, changed) for b, h in runs):"
assert a in s
open(sys.argv[2], "w").write(s.replace(a, "if False:", 1))
PY
JD1m="$(fvd "$D1" HEAD~1 "$NOCOV")"
if [ "$(printf '%s' "$JD1m" | jfield "d['verdict']")" = "PASS" ]; then ok "mutant that drops the run-coverage check trusts the unrelated run (guard bites)"
else bad "coverage mutant still INCONCLUSIVE; the fixture does not depend on the check: $JD1m"; fi
# A seal with no base_sha/head_sha in its events.jsonl is a missing record: NOT PROVEN, not trusted.
seal_event "$D1" loki_wall_add.py
JD1n="$(fvd "$D1" HEAD~1)"
if [ "$(verdict_trusted "$JD1n")" = "('INCONCLUSIVE', 1, 0)" ]; then ok "a seal whose run records no base_sha/head_sha is INCONCLUSIVE"
else bad "seal without a run changed-file record was trusted: $JD1n"; fi
# Wall added after the base, covering the changed module, run record covering the diff, seal matching its bytes: still
# untrusted because the Wall itself changed against the diff base.
D3="$TMP/diffbind3"; mkdir -p "$D3"; git -C "$D3" init -q; G3="git -C $D3 -c user.name=t -c user.email=t@t.invalid"
printf 'def price(x):\n    return x * 2\n' > "$D3/price.py"; git -C "$D3" add price.py; $G3 commit -qm base
C0="$(sha_of "$D3" HEAD)"
printf 'def price(x):\n    return x * 3\n' > "$D3/price.py"; printf 'from price import price\ndef test_cover():\n    assert price(1) == 3\n' > "$D3/loki_wall_cover.py"
git -C "$D3" add price.py loki_wall_cover.py; $G3 commit -qm "price plus an agent-added Wall"
C1="$(sha_of "$D3" HEAD)"; seal_event "$D3" loki_wall_cover.py "$C0" "$C1"
JD3="$(fvd "$D3" "$C0")"
if [ "$(printf '%s' "$JD3" | jfield "d['verdict']")" = "INCONCLUSIVE" ]; then ok "a Wall added after the diff base is untrusted even when sealed, covering and run-covered"
else bad "Wall added after the base was trusted: $JD3"; fi
NODIFF="$TMP/fv-nodiff.py"
python3 - "$FV" "$NODIFF" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = '    for ref in {diff_base or "HEAD", "HEAD"}:'
assert a in s
open(sys.argv[2], "w").write(s.replace(a, '    for ref in ():', 1))
PY
JD4="$(fvd "$D3" "$C0" "$NODIFF")"
if [ "$(printf '%s' "$JD4" | jfield "d['verdict']")" = "PASS" ]; then ok "mutant that drops the changed-vs-base check trusts the post-base Wall (guard bites)"
else bad "diff-check mutant still INCONCLUSIVE; the fixture does not depend on the check: $JD4"; fi
# The run record must be a real ancestry: head not descending from base (amend/rebase after the seal) or an
# unreachable SHA is never trusted.
D5="$TMP/diffbind5"; mkdir -p "$D5"; git -C "$D5" init -q; G5="git -C $D5 -c user.name=t -c user.email=t@t.invalid"
printf '# base\n' > "$D5/README.md"; git -C "$D5" add README.md; $G5 commit -qm base
F0="$(sha_of "$D5" HEAD)"
printf 'def price(x):\n    return x * 2\n' > "$D5/price.py"; printf 'from price import price\ndef test_cover():\n    assert price(1) == 2\n' > "$D5/loki_wall_cover.py"
git -C "$D5" add price.py loki_wall_cover.py; $G5 commit -qm "run output"
F1="$(sha_of "$D5" HEAD)"
printf 'def price(x):\n    return x * 2  # tweak\n' > "$D5/price.py"; git -C "$D5" add price.py; $G5 commit -qm change
git -C "$D5" checkout -q -b side "$F0"; printf 'x\n' > "$D5/other.txt"; git -C "$D5" add other.txt; $G5 commit -qm side
F2="$(sha_of "$D5" HEAD)"; git -C "$D5" checkout -q -
seal_event "$D5" loki_wall_cover.py "$F0" "$F1"
JD6="$(fvd "$D5" HEAD~1)"
[ "$(verdict_trusted "$JD6")" = "('PASS', 1, 1)" ] && ok "ancestry control: base..head that descends from the base earns PASS" || bad "ancestry control did not PASS: $JD6"
seal_event "$D5" loki_wall_cover.py "$F2" "$F1"
JD7="$(fvd "$D5" HEAD~1)"
[ "$(verdict_trusted "$JD7")" = "('INCONCLUSIVE', 1, 0)" ] && ok "a run whose head does not descend from its base is INCONCLUSIVE" || bad "non-descendant head was trusted: $JD7"
seal_event "$D5" loki_wall_cover.py "$F0" "0123456789012345678901234567890123456789"
JD8="$(fvd "$D5" HEAD~1)"
[ "$(verdict_trusted "$JD8")" = "('INCONCLUSIVE', 1, 0)" ] && ok "a run record with an unreachable SHA is INCONCLUSIVE" || bad "unreachable SHA was trusted: $JD8"
NOANC="$TMP/fv-noanc.py"
python3 - "$FV" "$NOANC" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = 'if _git_strict(["merge-base", "--is-ancestor", base, head], root) is None:'
assert a in s
open(sys.argv[2], "w").write(s.replace(a, "if False:", 1))
PY
seal_event "$D5" loki_wall_cover.py "$F2" "$F1"
JD9="$(fvd "$D5" HEAD~1 "$NOANC")"
[ "$(verdict_trusted "$JD9")" = "('PASS', 1, 1)" ] && ok "mutant that drops the ancestry check trusts a non-descendant head (guard bites)" || bad "ancestry mutant still INCONCLUSIVE; fixture does not depend on the check: $JD9"
# An amended-away run head still resolves until gc, so existence is not reachability: the sealed head must be an
# ancestor of HEAD (rev-a rq64i B1).
DA="$TMP/diffbind-amend"; mkdir -p "$DA"; git -C "$DA" init -q; GA="git -C $DA -c user.name=t -c user.email=t@t.invalid"
printf '# base\n' > "$DA/README.md"; git -C "$DA" add README.md; $GA commit -qm base
A0="$(sha_of "$DA" HEAD)"
printf 'def price(x):\n    return x * 2\n' > "$DA/price.py"; printf 'from price import price\ndef test_cover():\n    assert price(1) == 2\n' > "$DA/loki_wall_cover.py"
git -C "$DA" add price.py loki_wall_cover.py; $GA commit -qm "run output"
A1="$(sha_of "$DA" HEAD)"; seal_event "$DA" loki_wall_cover.py "$A0" "$A1"
printf 'def price(x):\n    return x + 1\n' > "$DA/price.py"; git -C "$DA" add price.py; $GA commit -q --amend -m "amended run output"
printf 'def price(x):\n    return x + 1  # tweak\n' > "$DA/price.py"; git -C "$DA" add price.py; $GA commit -qm change
git -C "$DA" cat-file -e "$A1" 2>/dev/null && ok "amend fixture: the sealed head object still exists before gc" || bad "amend fixture: sealed head object missing"
JDA="$(fvd "$DA" HEAD~1)"
[ "$(verdict_trusted "$JDA")" = "('INCONCLUSIVE', 1, 0)" ] && ok "a run whose head was amended away (object present, not in HEAD history) is INCONCLUSIVE" || bad "amended-away run head was trusted: $JDA"
NOHEADANC="$TMP/fv-noheadanc.py"
python3 - "$FV" "$NOHEADANC" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = 'if _git_strict(["merge-base", "--is-ancestor", head, "HEAD"], root) is None:'
assert a in s
open(sys.argv[2], "w").write(s.replace(a, "if False:", 1))
PY
JDB="$(fvd "$DA" HEAD~1 "$NOHEADANC")"
[ "$(verdict_trusted "$JDB")" = "('PASS', 1, 1)" ] && ok "mutant that drops the head-in-HEAD-history check trusts an amended-away head (guard bites)" || bad "head-ancestry mutant still INCONCLUSIVE; fixture does not depend on the check: $JDB"
# A planted core.fsmonitor in the repo's own config must never execute during provenance checks (rev-a rq64j J3):
# _git_strict runs with the same `-c core.fsmonitor= -c core.hooksPath=/dev/null` hardening as _git.
DF="$TMP/diffbind-fsmon"; mkdir -p "$DF"; git -C "$DF" init -q; GF="git -C $DF -c user.name=t -c user.email=t@t.invalid"
printf '# base\n' > "$DF/README.md"; git -C "$DF" add README.md; $GF commit -qm base
F0="$(sha_of "$DF" HEAD)"
printf 'def price(x):\n    return x * 2\n' > "$DF/price.py"; printf 'from price import price\ndef test_cover():\n    assert price(1) == 2\n' > "$DF/loki_wall_cover.py"
git -C "$DF" add price.py loki_wall_cover.py; $GF commit -qm "run output"
F1="$(sha_of "$DF" HEAD)"; seal_event "$DF" loki_wall_cover.py "$F0" "$F1"
printf 'def price(x):\n    return x * 2  # tweak\n' > "$DF/price.py"; git -C "$DF" add price.py; $GF commit -qm change
FSM_MARK="$TMP/fsmon-ran"; printf '#!/bin/sh\ntouch "%s"\nprintf "\\0"\n' "$FSM_MARK" > "$TMP/fsmon-hook.sh"; chmod +x "$TMP/fsmon-hook.sh"
git -C "$DF" config core.fsmonitor "$TMP/fsmon-hook.sh"
rm -f "$FSM_MARK"; git -C "$DF" diff --name-only HEAD~1 -- price.py >/dev/null 2>&1; git -C "$DF" ls-files --error-unmatch -- price.py >/dev/null 2>&1
[ -e "$FSM_MARK" ] && ok "fsmonitor control: the planted hook fires on a plain git call in this repo" || bad "fsmonitor control: planted hook never fired on plain git; the fixture cannot detect the escape"
rm -f "$FSM_MARK"; JDF="$(fvd "$DF" HEAD~1)"
[ ! -e "$FSM_MARK" ] && ok "a planted core.fsmonitor does not execute during fast_verify provenance checks" || bad "planted core.fsmonitor executed during fast_verify"
NOFSM="$TMP/fv-nofsm.py"
python3 - "$FV" "$NOFSM" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = 'p = subprocess.run(["git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"] + args,\n'
assert s.count(a) == 1
open(sys.argv[2], "w").write(s.replace(a, 'p = subprocess.run(["git"] + args,\n', 1))
PY
rm -f "$FSM_MARK"; fvd "$DF" HEAD~1 "$NOFSM" >/dev/null
[ -e "$FSM_MARK" ] && ok "mutant that drops the fsmonitor/hooksPath flags from _git_strict runs the planted hook (guard bites)" || bad "fsmonitor mutant did not fire the hook; fixture does not depend on the flags"
# Positive control: Wall present at the base, sealed by a run that changed the verified file, naming it, earns PASS.
D2="$TMP/diffbind2"; mkdir -p "$D2"; git -C "$D2" init -q; G2="git -C $D2 -c user.name=t -c user.email=t@t.invalid"
printf '# base\n' > "$D2/README.md"; git -C "$D2" add README.md; $G2 commit -qm base
E0="$(sha_of "$D2" HEAD)"
printf 'def price(x):\n    return x * 2\n' > "$D2/price.py"; printf 'from price import price\ndef test_cover():\n    assert price(1) == 2\n' > "$D2/loki_wall_cover.py"
git -C "$D2" add price.py loki_wall_cover.py; $G2 commit -qm "run output"
E1="$(sha_of "$D2" HEAD)"; seal_event "$D2" loki_wall_cover.py "$E0" "$E1"
printf 'def price(x):\n    return x * 2  # tweak\n' > "$D2/price.py"; git -C "$D2" add price.py; $G2 commit -qm change
JD5="$(fvd "$D2" HEAD~1)"
if [ "$(verdict_trusted "$JD5")" = "('PASS', 1, 1)" ]; then ok "a sealed Wall from a run that changed the verified file and names it earns PASS"
else bad "covering sealed Wall from a covering run did not PASS: $JD5"; fi
[ -z "$(find "$S1" -name .pytest_cache -maxdepth 2)" ] && ok "verify --fast leaves no .pytest_cache in the target repo" || bad ".pytest_cache written into the target repo"
S2="$TMP/seed-mock"; seed_repo SD-0061 "$S2"
J4="$(cd "$S2" && python3 "$FV" . --no-cache --json 2>/dev/null)"
if [ "$(printf '%s' "$J4" | jfield "d['verdict']")" = "FAIL" ] && printf '%s' "$J4" | grep -q '"mock_target"'; then
    ok "SD-0061 style mock.patch on the function under test is a blocking mock_target finding"
else
    bad "mock-abuse case not caught: $J4"
fi
NOMT="$TMP/fv-nomock.py"
sed 's/^RULES = (_rule_mock_render, _rule_toothless_test, _rule_mock_target)/RULES = (_rule_mock_render, _rule_toothless_test)/' "$FV" > "$NOMT"
J5="$(cd "$S2" && python3 "$NOMT" . --no-cache --json 2>/dev/null)"
if cmp -s "$FV" "$NOMT"; then bad "mutant did not change fast_verify.py (sed pattern stale)"
elif [ "$(printf '%s' "$J5" | jfield "d['verdict']")" != "FAIL" ]; then ok "mutant with the mock_target rule removed no longer FAILs the mock-abuse case (guard bites)"
else bad "mutant still FAILs; the test does not depend on the rule"; fi

# ---- EXOGENOUS: no model, no network -------------------------------------
if grep -qE "anthropic|openai|requests\.|urllib\.request|httpx|provider_invoke" "$FV"; then
    bad "fast path references a model/network call -- it must be purely deterministic"
else
    ok "no LLM or network on the fast path (exogenous, therefore trustworthy)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
