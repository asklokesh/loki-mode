#!/usr/bin/env bash
# `report cost` must not contradict its own budget state file.
#
# THE DEFECT. The budget block read only the CAP from .loki/metrics/budget.json
# and then overwrote spend with the current run's figure, which is None when no
# iteration has a measured cost. It fell back to 0.0 and printed
# "Used: $0.00 (0.0%) ... Status: OK" over a file reading
# "budget_used": 0.7992, "exceeded": true -- while `loki status` showed 160%.
#
# The --json surface is the sharp end: it asserted "exceeded": false, and that
# is what automation gates on. A product whose thesis is "no false greens"
# printed a green over its own red data.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-report-cost-budget"

# The exact live condition: an exceeded budget and NO efficiency records, so
# the current-run cost is unmeasured.
mkdir -p "$WORK/metrics"
cat > "$WORK/metrics/budget.json" <<'EOF'
{"limit":0.5,"budget_limit":0.5,"budget_used":0.7992,"exceeded":true}
EOF

jq_budget() {
    LOKI_DIR="$WORK" bash "$REPO_ROOT/autonomy/loki" report cost --json 2>/dev/null \
        | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_FAIL'); raise SystemExit(0)
b = d.get('budget') or {}
print('%s|%s|%s' % (b.get('used'), b.get('status'), b.get('exceeded')))
"
}

B="$(jq_budget)"
USED="${B%%|*}"; REST="${B#*|}"; STATUS="${REST%%|*}"; EXC="${REST#*|}"

# 1. The recorded spend, not a fabricated zero.
if [ "$USED" = "0.7992" ]; then
    pass "json used reports the recorded spend (0.7992), not 0.0"
else
    fail "json used = $USED, expected 0.7992 (the file's budget_used)"
fi

# 2/3. Status and the machine-readable boolean must both say exceeded. The
#      boolean is what a CI gate reads, so it gets its own assertion.
if [ "$STATUS" = "exceeded" ]; then
    pass "json status is exceeded"
else
    fail "json status = $STATUS, expected exceeded"
fi
if [ "$EXC" = "True" ] || [ "$EXC" = "true" ]; then
    pass "json exceeded is true (the flag automation gates on)"
else
    fail "json exceeded = $EXC, expected true"
fi

# 4. CROSS-SURFACE AGREEMENT. Neither surface alone proves one source of truth.
SOUT="$(LOKI_DIR="$WORK" bash "$REPO_ROOT/autonomy/loki" status 2>/dev/null || true)"
if printf '%s' "$SOUT" | grep -q '160%'; then
    pass "loki status agrees with report cost (both ~160%)"
else
    fail "loki status disagrees: $(printf '%s' "$SOUT" | grep -i budget | head -1)"
fi

# 5. The unmeasured-current-run contract must survive. `loki cost --help`
#    promises "Unmeasured is never reported as \$0.00" -- the fix must not
#    trade one false green for another.
HOUT="$(LOKI_DIR="$WORK" bash "$REPO_ROOT/autonomy/loki" report cost 2>&1 || true)"
if printf '%s' "$HOUT" | grep -q 'Cost not recorded for this run'; then
    pass "unmeasured current-run cost is still reported as not recorded"
else
    fail "lost the 'Cost not recorded' contract"
fi

# 6. Exit code must stay 0: tests/cli/test-alias-forwarding.sh asserts parity.
rc=0
LOKI_DIR="$WORK" bash "$REPO_ROOT/autonomy/loki" report cost >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
    pass "report cost still exits 0 when the budget is exceeded"
else
    fail "report cost exit code changed to $rc (breaks alias parity)"
fi

# 7. A budget file with NO recorded spend must not invent one: used is null
#    (unknown), never 0.0, and it claims no overrun (S-179, BACKLOG 106).
mkdir -p "$WORK/nb/metrics"
echo '{"limit":1.0,"budget_limit":1.0}' > "$WORK/nb/metrics/budget.json"
NB="$(LOKI_DIR="$WORK/nb" bash "$REPO_ROOT/autonomy/loki" report cost --json 2>/dev/null \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('PARSE_FAIL'); raise SystemExit(0)
b=d.get('budget') or {}
print('%s|%s' % (b.get('used'), b.get('exceeded')))
")"
if [ "$NB" = "None|False" ]; then
    pass "absent budget_used reads null without claiming an overrun"
else
    fail "absent budget_used produced used=${NB%%|*}"
fi

# 8. `report cost --month YYYY-MM --csv`: one row per run, 6 columns, usd sum
#    equals the ledger total, unmeasured is a word never 0, fields escaped, and
#    no prompt or secret from the proof leaks into the export.
CWS="$WORK/csvws"
python3 - "$CWS" <<'PYEOF'
import json, os, sys
ws = sys.argv[1]
for i in range(12):
    rid = 'run-%02d' % i
    if i == 3:
        rid = 'run,03 "q"\nx'
    d = os.path.join(ws, '.loki', 'proofs', 'dir%02d' % i)
    os.makedirs(d)
    proof = {'run_id': rid, 'generated_at': '2026-09-%02dT10:00:00Z' % (i + 1),
             'council': {'final_verdict': 'APPROVE' if i % 2 else 'REJECT'},
             'prompt': 'SECRET-PROMPT-TEXT', 'token': 'LEAKME-credential'}
    if i not in (5, 9):
        proof['cost'] = {'usd': round(0.1 * (i + 1), 4)}
    json.dump(proof, open(os.path.join(d, 'proof.json'), 'w'))
d = os.path.join(ws, '.loki', 'proofs', 'aug')
os.makedirs(d)
json.dump({'run_id': 'aug-run', 'generated_at': '2026-08-30T10:00:00Z', 'cost': {'usd': 9.0}},
          open(os.path.join(d, 'proof.json'), 'w'))
PYEOF
CSV="$(LOKI_DIR="$CWS/.loki" bash "$REPO_ROOT/autonomy/loki" report cost --month 2026-09 --csv 2>/dev/null)"
CHK="$(printf '%s' "$CSV" | python3 -c "
import csv, io, sys
rows = list(csv.reader(io.StringIO(sys.stdin.read())))
hdr, body = rows[0], rows[1:]
ok_cols = all(len(r) == 6 for r in rows)
tot = sum(float(r[2]) for r in body if r[2] != 'unmeasured')
unm = sum(1 for r in body if r[2] == 'unmeasured')
zero = sum(1 for r in body if r[2] in ('0', '0.0', '0.000000'))
esc = any(r[4] == 'run,03 \"q\"\nx' for r in body)
print('%s|%d|%s|%.4f|%d|%d|%s' % (','.join(hdr), len(body), ok_cols, tot, unm, zero, esc))
")"
LEDGER="$(LOKI_DIR="$CWS/.loki" bash "$REPO_ROOT/autonomy/loki" report cost --month 2026-09 --json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['project_total_usd'])")"
IFS='|' read -r C_HDR C_N C_COLS C_SUM C_UNM C_ZERO C_ESC <<EOF
$CHK
EOF
if [ "$C_HDR" = "repo,user,usd,verdict,run_id,date" ] && [ "$C_N" = "12" ]; then
    pass "csv has header and 12 rows (month filter drops the August run)"
else
    fail "csv shape: hdr=$C_HDR rows=$C_N"
fi
[ "$C_COLS" = "True" ] && pass "every csv row has 6 columns" || fail "csv column count broke"
if python3 -c "import sys; sys.exit(0 if abs(float('$C_SUM') - float('${LEDGER:-x}')) <= 0.01 else 1)" 2>/dev/null; then
    pass "csv usd sum $C_SUM equals ledger total $LEDGER"
else
    fail "csv usd sum $C_SUM != ledger $LEDGER"
fi
if [ "$C_UNM" = "2" ] && [ "$C_ZERO" = "0" ]; then
    pass "2 unmeasured runs print 'unmeasured', none print 0"
else
    fail "unmeasured=$C_UNM zero=$C_ZERO"
fi
[ "$C_ESC" = "True" ] && pass "comma, quote and newline in a field round-trip through csv quoting" \
    || fail "csv escaping lost the special-character run id"
if printf '%s' "$CSV" | grep -qE 'SECRET-PROMPT-TEXT|LEAKME'; then
    fail "csv leaked a prompt or secret"
else
    pass "redaction: 0 prompts or secrets in the csv"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
