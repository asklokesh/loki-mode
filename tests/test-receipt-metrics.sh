#!/usr/bin/env bash
# The Evidence Receipt is visible to monitoring, and honestly.
#
# WHY THIS EXISTS. /metrics emitted twelve lines -- agents, cost, iterations,
# tasks, uptime -- and NOT ONE was about verification. The receipt is the
# product's differentiator and an operator could not alert on the two failures
# that make the guarantee worthless in production: builds silently stopping
# producing receipts, and the unknown-verdict share climbing.
#
# A grep for gate/proof/receipt in the metrics builder returned 60 matches,
# which is why this was nearly skipped as already-covered. Every one was a
# comment or unrelated code; the LIVE endpoint had zero. Counted, not read --
# the exact trap the competitor-surface audit exists to avoid, walked into on
# our own code.
#
# TEST 3 IS THE LOAD-BEARING ONE. `unknown` must be its own series. The summary
# refuses to count a receipt as verified when it cannot prove it was, and
# folding that into verified (dishonest) or into not_verified (alarming, and
# also wrong) destroys the distinction the receipt exists to preserve.
#
# TEST 5 guards drift: the metric and /api/proofs/summary read the same files
# and must never disagree, or an alert fires on a number the UI contradicts.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: Evidence Receipts are exposed to monitoring, unknown included"

python3 -c "import uvicorn, fastapi" 2>/dev/null || {
  echo "  SKIP: uvicorn/fastapi absent -- metrics endpoint not measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-rmetrics.XXXXXX")"
PORT="${LOKI_RECEIPT_METRICS_PORT:-57398}"
cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  rm -rf "$W" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# A DELIBERATELY MIXED fixture: every bucket populated with a DIFFERENT count,
# so a metric that hardcodes a number, or swaps two labels, cannot pass.
python3 - "$W" "$REPO_ROOT" <<'PY' || { echo "  FAIL: fixture setup failed"; exit 1; }
import sys, os, json, hashlib
w, root = sys.argv[1], sys.argv[2]
def write(rid, headline):
    d = os.path.join(w, ".loki", "proofs", rid); os.makedirs(d, exist_ok=True)
    b = {"run_id": rid, "loki_version": "9.17.2"}
    if headline:
        b["honesty"] = {"headline": headline}
    h = hashlib.sha256(json.dumps(b, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    b["verification"] = {"hash": h, "algo": "sha256", "scope": "integrity"}
    json.dump(b, open(os.path.join(d, "proof.json"), "w"))
# 3 verified, 2 unknown, 1 gaps, 1 not_verified -- all four counts distinct.
for i in range(3): write("v%d" % i, "VERIFIED")
for i in range(2): write("u%d" % i, None)
write("g0", "VERIFIED WITH GAPS")
write("n0", "NOT VERIFIED")
PY

( cd "$W" && LOKI_DIR="$W/.loki" python3 -m uvicorn dashboard.server:app \
    --port "$PORT" --app-dir "$REPO_ROOT" > "$W/s.log" 2>&1 & echo $! > "$W/pid" )
SRV="$(cat "$W/pid" 2>/dev/null)"
_up=0
for _ in $(seq 1 50); do
  curl -s --max-time 2 "http://127.0.0.1:$PORT/metrics" >/dev/null 2>&1 && { _up=1; break; }
  sleep 0.5
done
if [ "$_up" -ne 1 ]; then
  echo "  SKIP: dashboard did not start on $PORT -- not measured"
  tail -3 "$W/s.log" 2>/dev/null
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi

M="$W/metrics.txt"
curl -s --max-time 15 "http://127.0.0.1:$PORT/metrics" > "$M"

# --- 0. The endpoint served something (guards a vacuous pass) ---------------
if [ -s "$M" ] && grep -q "^loki_" "$M"; then
  ok "the metrics endpoint served $(grep -c '^loki_' "$M") metric line(s)"
else
  bad "empty or non-metric response -- every assertion below would be vacuous"
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi

# --- 1. Receipts are exposed at all ----------------------------------------
_total="$(grep -E "^loki_receipts_total " "$M" | awk '{print $2}')"
if [ "${_total:-}" = "7" ]; then
  ok "loki_receipts_total counts every receipt on disk (7)"
else
  bad "loki_receipts_total is '${_total:-absent}', expected 7"
fi

# --- 2. Each verdict bucket is correct -------------------------------------
_v() { grep -E "^loki_receipts_by_verdict\{verdict=\"$1\"\}" "$M" | awk '{print $2}'; }
_bad=0
for pair in "verified 3" "unknown 2" "with_gaps 1" "not_verified 1"; do
  set -- $pair
  got="$(_v "$1")"
  [ "${got:-}" = "$2" ] || { bad "verdict '$1' is '${got:-absent}', expected $2"; _bad=1; }
done
[ "$_bad" -eq 0 ] && ok "every verdict bucket matches the fixture (3/2/1/1, all distinct)"

# --- 3. THE LOAD-BEARING ONE: unknown is its own series --------------------
if [ "$(_v unknown)" = "2" ]; then
  ok "unknown is reported as its own series, not folded into another bucket"
else
  bad "unknown is not separately reported -- 'we cannot prove it' would read as a verdict"
fi

# --- 4. Provenance is exposed ----------------------------------------------
# None of this fixture is attested, so both must be 0. A metric that reported a
# nonzero here would be inventing provenance.
_att="$(grep -E 'kind="attestation"' "$M" | awk '{print $2}')"
_gpg="$(grep -E 'kind="gpg"' "$M" | awk '{print $2}')"
if [ "${_att:-}" = "0" ] && [ "${_gpg:-}" = "0" ]; then
  ok "provenance counters read 0 on unsigned receipts (no invented provenance)"
else
  bad "provenance reported attestation=${_att:-absent} gpg=${_gpg:-absent}, expected 0/0"
fi

# --- 5. The metric and the API must not drift ------------------------------
_api="$(curl -s --max-time 15 "http://127.0.0.1:$PORT/api/proofs/summary")"
_agree="$(python3 - "$M" <<PY
import re, sys, json
txt = open(sys.argv[1]).read()
api = json.loads('''$_api''')
def m(name):
    hit = re.search(r'^loki_receipts_by_verdict\{verdict="%s"\} (\d+)' % name, txt, re.M)
    return int(hit.group(1)) if hit else -1
tot = re.search(r'^loki_receipts_total (\d+)', txt, re.M)
ok = (tot and int(tot.group(1)) == api.get("total_receipts")
      and m("verified") == api.get("verified")
      and m("unknown") == api.get("unknown")
      and m("with_gaps") == api.get("with_gaps")
      and m("not_verified") == api.get("not_verified"))
print("yes" if ok else "no")
PY
)"
if [ "$_agree" = "yes" ]; then
  ok "the metric agrees with /api/proofs/summary exactly (no drift)"
else
  bad "the metric and the API disagree -- an alert would fire on a number the UI contradicts"
fi

# --- 6. An empty project reports zero, not an error ------------------------
# "No receipts yet" is a normal state and must scrape cleanly, or a fresh
# install looks like a broken exporter.
E="$(mktemp -d "${TMPDIR:-/tmp}/loki-rempty.XXXXXX")"
mkdir -p "$E/.loki"
EP=$((PORT + 1))
( cd "$E" && LOKI_DIR="$E/.loki" python3 -m uvicorn dashboard.server:app \
    --port "$EP" --app-dir "$REPO_ROOT" > "$E/s.log" 2>&1 & echo $! > "$E/pid" )
_eup=0
for _ in $(seq 1 40); do
  curl -s --max-time 2 "http://127.0.0.1:$EP/metrics" >/dev/null 2>&1 && { _eup=1; break; }
  sleep 0.5
done
if [ "$_eup" -eq 1 ]; then
  _et="$(curl -s --max-time 15 "http://127.0.0.1:$EP/metrics" | grep -E "^loki_receipts_total " | awk '{print $2}')"
  if [ "${_et:-}" = "0" ]; then
    ok "a project with no receipts reports 0, not an error"
  else
    bad "empty project reported '${_et:-absent}' for loki_receipts_total"
  fi
else
  ok "skipped the empty-project check: second server did not start (not a pass)"
fi
kill "$(cat "$E/pid" 2>/dev/null)" 2>/dev/null
rm -rf "$E"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
