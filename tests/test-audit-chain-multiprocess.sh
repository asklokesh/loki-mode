#!/usr/bin/env bash
# tests/test-audit-chain-multiprocess.sh -- the audit chain must survive
# CONCURRENT WRITER PROCESSES, not just concurrent threads.
#
# THE BUG THIS PINS (found 2026-07-27, via an orphaned suite that had never run):
#
# dashboard/audit.py serialized its tamper-evident chain append with a
# threading.Lock and resolved the chain tip (_last_hash) ONCE at module import.
# threading.Lock has no meaning across processes, so every concurrently-live
# writer PROCESS chained from its own frozen import-time tip. The chain forked
# at WRITE time with no tampering involved.
#
# Measured on a real machine before the fix: 25 of 67 audit files internally
# chain-broken, 10163 entries, spanning months and still occurring that day.
#
# WHY IT MATTERS MORE THAN A COSMETIC BUG: this chain IS the tamper evidence. A
# verifier cannot distinguish "two writers raced" from "someone edited the log",
# so a self-inflicted fork burns the exact signal the chain exists to provide.
# It fails LOUD rather than silent -- verify reports invalid, it never reports a
# forged log as clean -- but the guarantee is destroyed either way.
#
# HERMETIC BY CONSTRUCTION: AUDIT_DIR derives from Path.home(), so overriding
# HOME gives each run a private audit dir. This test never reads, writes, or
# depends on the developer's real ~/.loki state. (Its sibling
# tests/test-audit-chain-cross-file.sh Test 1 DOES assert against the production
# dir and self-skips on CI, which is why that one cannot serve as this guard.)
#
# NON-VACUITY: reverting the fix in dashboard/audit.py makes case 1 report
# valid=False with 3 of 10 entries chained. Verified before this file was
# committed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not available"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-audit-mp.XXXXXX")"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

cat > "$WORK/writer.py" <<PYEOF
import sys, time
sys.path.insert(0, "$REPO_ROOT")
from dashboard.audit import log_event
tag = sys.argv[1]
for i in range(5):
    log_event(action=tag + str(i), resource_type="t", resource_id=str(i), success=True)
    time.sleep(0.03)
PYEOF

cat > "$WORK/verify.py" <<PYEOF
import sys
sys.path.insert(0, "$REPO_ROOT")
from dashboard.audit import verify_all_logs
r = verify_all_logs()
print("VALID=%s ENTRIES=%s" % (r.get("valid"), r.get("entries_checked")))
PYEOF

echo "Audit chain: concurrent writer PROCESSES"
echo "========================================"
echo ""

# ---------------------------------------------------------------------------
# Case 1 (HEADLINE): two overlapping writer processes must produce ONE valid
# chain. The stagger is deliberate -- the second process must start while the
# first is still writing, which is exactly when it would inherit a stale tip.
# ---------------------------------------------------------------------------
H1="$WORK/h1"
mkdir -p "$H1"
( HOME="$H1" python3 "$WORK/writer.py" A >/dev/null 2>&1 ) &
sleep 0.05
( HOME="$H1" python3 "$WORK/writer.py" B >/dev/null 2>&1 ) &
wait

RESULT="$(HOME="$H1" python3 "$WORK/verify.py" 2>&1)"
LOGFILE="$(find "$H1/.loki" -name 'audit-*.jsonl' 2>/dev/null | head -1)"
WRITTEN="$(wc -l < "$LOGFILE" 2>/dev/null | tr -d ' ')"

case "$RESULT" in
    VALID=True*)
        ok "two concurrent writer processes produce a valid chain ($RESULT)"
        ;;
    *)
        bad "concurrent writers broke the chain: $RESULT (log had ${WRITTEN:-0} lines)"
        ;;
esac

# Both halves matter: a "valid" chain that dropped entries is not a fix. Every
# line either process wrote must be present AND chained.
if [ "${WRITTEN:-0}" = "10" ]; then
    ok "all 10 entries from both processes were written (none dropped)"
else
    bad "expected 10 written entries, got ${WRITTEN:-0} (entries lost under contention)"
fi

# And the verifier must have actually inspected them, not skipped the file.
case "$RESULT" in
    *ENTRIES=10*) ok "verifier checked all 10 entries" ;;
    *)            bad "verifier did not check 10 entries: $RESULT" ;;
esac

# ---------------------------------------------------------------------------
# Case 2: the single-process path must stay valid. A cross-process lock that
# broke the ordinary case would be a bad trade.
# ---------------------------------------------------------------------------
H2="$WORK/h2"
mkdir -p "$H2"
HOME="$H2" python3 "$WORK/writer.py" S >/dev/null 2>&1
RESULT2="$(HOME="$H2" python3 "$WORK/verify.py" 2>&1)"
case "$RESULT2" in
    VALID=True*ENTRIES=5*) ok "single-process chain still valid ($RESULT2)" ;;
    *)                     bad "single-process chain regressed: $RESULT2" ;;
esac

# ---------------------------------------------------------------------------
# Case 3: a torn final line (a process killed mid-append) must not become the
# chain TIP. The next writer must skip it and chain from the last WELL-FORMED
# entry.
#
# Scope note, deliberately narrow: this asserts the WRITER's tip selection, not
# the verifier's overall verdict. verify_all_logs correctly reports invalid when
# a log contains an unparseable line -- that is tamper-evidence doing its job,
# and this test does not try to soften it. What is being pinned is that the
# writer does not COMPOUND the damage by re-rooting the chain from garbage,
# which would break every subsequent entry rather than just the torn one.
# ---------------------------------------------------------------------------
H3="$WORK/h3"
mkdir -p "$H3"
HOME="$H3" python3 "$WORK/writer.py" T >/dev/null 2>&1
TORN="$(find "$H3/.loki" -name 'audit-*.jsonl' 2>/dev/null | head -1)"
if [ -n "$TORN" ]; then
    GOOD_TIP="$(python3 -c "
import json,sys
h=None
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    try: h=json.loads(l).get('_integrity_hash')
    except Exception: pass
print(h or '')
" "$TORN")"
    printf '{\"action\":\"torn\",\"resource_ty' >> "$TORN"
    printf '\n' >> "$TORN"
    HOME="$H3" python3 "$WORK/writer.py" U >/dev/null 2>&1

    # The first entry written AFTER the torn line must chain from the last
    # well-formed entry that preceded it.
    CHAINED_OK="$(python3 -c "
import json,sys,hashlib
path,good=sys.argv[1],sys.argv[2]
lines=[l.strip() for l in open(path) if l.strip()]
seen_torn=False
for l in lines:
    try: e=json.loads(l)
    except Exception:
        seen_torn=True; continue
    if seen_torn:
        # recompute what this entry's hash would be if chained from good tip
        body={k:v for k,v in e.items() if k!='_integrity_hash'}
        j=json.dumps(body,sort_keys=True,default=str)
        want=hashlib.sha256((good+j).encode()).hexdigest()
        print('YES' if e.get('_integrity_hash')==want else 'NO')
        break
else:
    print('NONE')
" "$TORN" "$GOOD_TIP")"

    case "$CHAINED_OK" in
        YES)  ok "writer chained past the torn line from the last good entry" ;;
        NONE) bad "no entry was written after the torn line" ;;
        *)    bad "writer re-rooted the chain after a torn line (got $CHAINED_OK)" ;;
    esac
else
    bad "could not locate the audit log for the torn-line case"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
