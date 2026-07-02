#!/usr/bin/env bash
# shellcheck disable=SC2164  # cd in throwaway test subshells; failure is fatal anyway
# tests/test-expectation-ledger.sh - tests for the annotate-before-act
# expected-outcome ledger (autonomy/lib/expectation-ledger.py) and its
# verify.sh gate (verify_expectation_ledger_gate).
#
# Covers:
#   Library (expectation-ledger.py):
#     L1 write seals a ledger whose recorded hash matches its own entries
#     L2 a MET expectation compares clean
#     L3 a CONTRADICTED expectation is flagged
#     L4 a DROPPED (never-executed) expectation is flagged
#     L5 an UNEVALUABLE expectation -> inconclusive (never met)
#     L6 editing the ledger after write BREAKS the embedded hash (tamper)
#     L7 canonicalization is byte-identical to proof-verify._canonical (reuse)
#   verify.sh gate:
#     V1 no ledger present -> evidence.json is BYTE-IDENTICAL to no-gate run
#     V2 contradicted+dropped ledger -> not VERIFIED + findings emitted
#     V3 unevaluable-only ledger -> CONCERNS (inconclusive gate)
#     V4 tampered ledger -> High finding + hash_ok:false embedded in evidence
#
# Exit-code semantics (build-task ordering): 0 VERIFIED, 1 CONCERNS, 2 BLOCKED.

set -uo pipefail

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SH="$SCRIPT_DIR/../autonomy/verify.sh"
LEDGER_PY="$SCRIPT_DIR/../autonomy/lib/expectation-ledger.py"
PROOF_VERIFY_PY="$SCRIPT_DIR/../autonomy/lib/proof-verify.py"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d -t loki-ledger-tests.XXXXXX)"
cleanup() { rm -rf "$TMP_ROOT" 2>/dev/null || true; }
trap cleanup EXIT

_ok() { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "=== test-expectation-ledger.sh ==="

# Pre-flight: syntax.
if bash -n "$VERIFY_SH" 2>/dev/null; then _ok "verify.sh passes bash -n"; else _no "verify.sh failed bash -n"; fi
if python3 -c "import ast; ast.parse(open('$LEDGER_PY').read())" 2>/dev/null; then
    _ok "expectation-ledger.py parses"
else
    _no "expectation-ledger.py failed to parse"
fi

# ---------------------------------------------------------------------------
# Library tests (single python3 process drives L1-L7).
# ---------------------------------------------------------------------------
LIB_DIR="$TMP_ROOT/lib"
mkdir -p "$LIB_DIR/.loki"
LIB_OUT="$(
    _LK_MOD="$LEDGER_PY" _LK_PV="$PROOF_VERIFY_PY" _LK_DIR="$LIB_DIR/.loki" \
    python3 - <<'PYEOF' 2>&1
import importlib.util, os, json

def load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m

led = load("led", os.environ["_LK_MOD"])
pv = load("pv", os.environ["_LK_PV"])
loki = os.environ["_LK_DIR"]

# L7: canonicalization identical to proof-verify (which mirrors proof-generator).
sample = {"b": 2, "a": [3, 1, {"z": 9, "y": 8}], "c": "x"}
print("L7 %s" % ("PASS" if led._canonical(sample) == pv._canonical(sample) else "FAIL"))

# L1: write three expectations, hash self-consistent.
led.write_entry(loki, "5", {"id": "health-200", "statement": "GET /health -> 200",
                            "check_ref": "tests", "expected": {"status": 200}})
led.write_entry(loki, "5", {"id": "endpoint-y", "statement": "endpoint Y exists",
                            "check_ref": "build", "expected": True})
led.write_entry(loki, "5", {"id": "test-x", "statement": "test X passes",
                            "check_ref": "tests", "expected": "pass"})
ok, rec, recomp = led.ledger_hash_ok(loki, "5")
print("L1 %s" % ("PASS" if ok and rec == recomp and rec else "FAIL"))

# L2/L3/L4: met + contradicted + dropped.
res = led.compare(loki, "5", {
    "health-200": {"status": 200},   # met
    "endpoint-y": False,             # expected True -> contradicted
    # test-x absent -> dropped
})
outc = {r["id"]: r["outcome"] for r in res["results"]}
print("L2 %s" % ("PASS" if outc.get("health-200") == "met" else "FAIL"))
print("L3 %s" % ("PASS" if outc.get("endpoint-y") == "contradicted" else "FAIL"))
print("L4 %s" % ("PASS" if outc.get("test-x") == "dropped" else "FAIL"))

# L5: unevaluable -> inconclusive, never met.
res2 = led.compare(loki, "5", {
    "health-200": {"status": 200},
    "endpoint-y": True,
    "test-x": {"evaluable": False},
})
outc2 = {r["id"]: r["outcome"] for r in res2["results"]}
print("L5 %s" % ("PASS" if outc2.get("test-x") == "inconclusive" and res2["inconclusive"] == 1 else "FAIL"))

# L6: tamper -> hash mismatch.
p = led.ledger_path(loki, "5")
d = json.load(open(p))
d["entries"][0]["expected"] = "tampered-value"
json.dump(d, open(p, "w"))
ok2, _, _ = led.ledger_hash_ok(loki, "5")
print("L6 %s" % ("PASS" if ok2 is False else "FAIL"))
PYEOF
)"
echo "$LIB_OUT" | while IFS= read -r ln; do :; done
for t in L1 L2 L3 L4 L5 L6 L7; do
    if printf '%s\n' "$LIB_OUT" | grep -q "^$t PASS$"; then
        _ok "$t"
    else
        _no "$t (output: $(printf '%s' "$LIB_OUT" | tr '\n' '|'))"
    fi
done

# ---------------------------------------------------------------------------
# verify.sh gate tests.
# ---------------------------------------------------------------------------
init_repo() {
    local repo="$1"
    mkdir -p "$repo"
    ( cd "$repo"
      git init -q
      git config user.email "test@loki.local"
      git config user.name "loki test"
      git config commit.gpgsign false
      echo "# project" > README.md
      git add README.md
      git commit -qm base --no-gpg-sign --no-verify
      git branch -m main
      # A committed change so the diff is non-empty (verify needs a change set).
      echo "line" > file.txt
      git add file.txt
      git commit -qm change --no-gpg-sign --no-verify
    )
}

write_ledger() {  # $1 repo  $2 iter  ; reads stdin as: id<TAB>expected-json per line
    local repo="$1" iter="$2"
    while IFS=$'\t' read -r id exp; do
        [ -n "$id" ] || continue
        ( cd "$repo" && python3 "$LEDGER_PY" write --loki-dir .loki --iter "$iter" \
            --id "$id" --statement "$id" --check-ref tests --expected "$exp" ) >/dev/null 2>&1
    done
}

# --- V1: byte-identical evidence.json when NO ledger exists. ---
S_BASE="$TMP_ROOT/v1base"; init_repo "$S_BASE"
( cd "$S_BASE" && bash "$VERIFY_SH" main ) >/dev/null 2>&1
# Copy and strip run-timestamp fields (started/completed) which legitimately vary
# between runs, so the comparison isolates whether the LEDGER changed anything.
strip_ts() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d['produced_by'].pop('run_started_at',None); d['produced_by'].pop('run_completed_at',None); print(json.dumps(d,sort_keys=True))" "$1"; }
EV_NOLEDGER="$(strip_ts "$S_BASE/.loki/verify/evidence.json" 2>/dev/null || echo A)"
# Second run, still no ledger, LEDGER env at default -> must be identical.
( cd "$S_BASE" && bash "$VERIFY_SH" main ) >/dev/null 2>&1
EV_NOLEDGER2="$(strip_ts "$S_BASE/.loki/verify/evidence.json" 2>/dev/null || echo B)"
if [ "$EV_NOLEDGER" = "$EV_NOLEDGER2" ] \
   && ! printf '%s' "$EV_NOLEDGER" | grep -q "expectation_ledger"; then
    _ok "V1 no ledger -> evidence.json byte-identical, no expectation_ledger key/gate"
else
    _no "V1 absent-ledger not byte-identical or leaked expectation_ledger key"
fi

# --- V2: contradicted + dropped ledger -> not VERIFIED + findings. ---
S2="$TMP_ROOT/v2"; init_repo "$S2"
printf 'endpoint-y\ttrue\ntest-x\t"pass"\n' | write_ledger "$S2" 5
# observed: endpoint-y contradicted (false), test-x dropped (absent).
mkdir -p "$S2/.loki/expectations"
printf '{"endpoint-y": false}\n' > "$S2/.loki/expectations/5.observed.json"
( cd "$S2" && bash "$VERIFY_SH" main ) >/dev/null 2>&1
V2_VERDICT="$(python3 -c "import json; print(json.load(open('$S2/.loki/verify/evidence.json'))['verdict'])" 2>/dev/null || echo ERR)"
V2_HASFIND="$(python3 -c "import json; d=json.load(open('$S2/.loki/verify/evidence.json')); print('yes' if any(f['category']=='expectation_ledger' for f in d['findings']) else 'no')" 2>/dev/null || echo err)"
if [ "$V2_VERDICT" != "VERIFIED" ] && [ "$V2_HASFIND" = "yes" ]; then
    _ok "V2 contradicted+dropped ledger -> $V2_VERDICT (not VERIFIED) with ledger findings"
else
    _no "V2 verdict=$V2_VERDICT findings=$V2_HASFIND (expected not-VERIFIED + yes)"
fi

# --- V3: unevaluable-only ledger -> CONCERNS (inconclusive gate). ---
S3="$TMP_ROOT/v3"; init_repo "$S3"
printf 'flaky-check\t"maybe"\n' | write_ledger "$S3" 7
mkdir -p "$S3/.loki/expectations"
printf '{"flaky-check": {"evaluable": false}}\n' > "$S3/.loki/expectations/7.observed.json"
( cd "$S3" && bash "$VERIFY_SH" main ) >/dev/null 2>&1
V3_RC_VERDICT="$(python3 -c "import json; print(json.load(open('$S3/.loki/verify/evidence.json'))['verdict'])" 2>/dev/null || echo ERR)"
V3_GATE="$(python3 -c "import json; d=json.load(open('$S3/.loki/verify/evidence.json')); g=[x for x in d['deterministic_gates'] if x['gate']=='expectation_ledger']; print(g[0]['status'] if g else 'none')" 2>/dev/null || echo err)"
if [ "$V3_RC_VERDICT" = "CONCERNS" ] && [ "$V3_GATE" = "inconclusive" ]; then
    _ok "V3 unevaluable-only ledger -> CONCERNS with inconclusive expectation_ledger gate"
else
    _no "V3 verdict=$V3_RC_VERDICT gate=$V3_GATE (expected CONCERNS + inconclusive)"
fi

# --- V4: tampered ledger -> High finding + hash_ok:false in evidence. ---
S4="$TMP_ROOT/v4"; init_repo "$S4"
printf 'health-200\t{"status":200}\n' | write_ledger "$S4" 9
# Tamper: edit the sealed expected value without re-sealing the hash.
python3 -c "import json; p='$S4/.loki/expectations/9.json'; d=json.load(open(p)); d['entries'][0]['expected']={'status':500}; json.dump(d,open(p,'w'))"
mkdir -p "$S4/.loki/expectations"
printf '{"health-200": {"status":200}}\n' > "$S4/.loki/expectations/9.observed.json"
( cd "$S4" && bash "$VERIFY_SH" main ) >/dev/null 2>&1
V4_TAMPERFIND="$(python3 -c "import json; d=json.load(open('$S4/.loki/verify/evidence.json')); print('yes' if any('tamper' in f['source'] or 'hash mismatch' in f['message'] for f in d['findings']) else 'no')" 2>/dev/null || echo err)"
V4_HASHOK="$(python3 -c "import json; d=json.load(open('$S4/.loki/verify/evidence.json')); e=d.get('expectation_ledger',{}); print(e.get('hash_ok'))" 2>/dev/null || echo err)"
V4_SHA="$(python3 -c "import json; d=json.load(open('$S4/.loki/verify/evidence.json')); e=d.get('expectation_ledger',{}); print('yes' if e.get('ledger_sha256') else 'no')" 2>/dev/null || echo err)"
if [ "$V4_TAMPERFIND" = "yes" ] && [ "$V4_HASHOK" = "False" ] && [ "$V4_SHA" = "yes" ]; then
    _ok "V4 tampered ledger -> tamper finding + hash_ok:false + ledger_sha256 embedded"
else
    _no "V4 tamperfind=$V4_TAMPERFIND hash_ok=$V4_HASHOK sha_present=$V4_SHA (expected yes/False/yes)"
fi

# --- V5: LOKI_EXPECTATION_LEDGER=0 disables the gate even when a ledger exists. ---
S5="$TMP_ROOT/v5"; init_repo "$S5"
printf 'endpoint-y\ttrue\n' | write_ledger "$S5" 3
mkdir -p "$S5/.loki/expectations"
printf '{"endpoint-y": false}\n' > "$S5/.loki/expectations/3.observed.json"
( cd "$S5" && LOKI_EXPECTATION_LEDGER=0 bash "$VERIFY_SH" main ) >/dev/null 2>&1
V5_HASKEY="$(python3 -c "import json; d=json.load(open('$S5/.loki/verify/evidence.json')); print('yes' if 'expectation_ledger' in d or any(g['gate']=='expectation_ledger' for g in d['deterministic_gates']) else 'no')" 2>/dev/null || echo err)"
if [ "$V5_HASKEY" = "no" ]; then
    _ok "V5 LOKI_EXPECTATION_LEDGER=0 disables the gate (no key, no gate row)"
else
    _no "V5 opt-out did not disable the gate (key/gate present)"
fi

# --- V6: clean (untampered, all-met) ledger embeds hash_ok:true and a
#         ledger_sha256 that EQUALS the ledger file's -- the positive half of
#         the criterion-4 embed (V4 only proved the tamper/negative half). ---
S6="$TMP_ROOT/v6"; init_repo "$S6"
printf 'endpoint-y\ttrue\n' | write_ledger "$S6" 2
mkdir -p "$S6/.loki/expectations"
printf '{"endpoint-y": true}\n' > "$S6/.loki/expectations/2.observed.json"
( cd "$S6" && bash "$VERIFY_SH" main ) >/dev/null 2>&1
V6_HASHOK="$(python3 -c "import json; e=json.load(open('$S6/.loki/verify/evidence.json')).get('expectation_ledger',{}); print(e.get('hash_ok'))" 2>/dev/null || echo err)"
V6_MATCH="$(python3 -c "import json; ev=json.load(open('$S6/.loki/verify/evidence.json')).get('expectation_ledger',{}); lg=json.load(open('$S6/.loki/expectations/2.json')); print('yes' if ev.get('ledger_sha256') and ev.get('ledger_sha256')==lg.get('ledger_sha256') else 'no')" 2>/dev/null || echo err)"
if [ "$V6_HASHOK" = "True" ] && [ "$V6_MATCH" = "yes" ]; then
    _ok "V6 clean ledger embeds hash_ok:true and ledger_sha256 matching the ledger file"
else
    _no "V6 hash_ok=$V6_HASHOK sha_match=$V6_MATCH (expected True/yes)"
fi

echo ""
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
