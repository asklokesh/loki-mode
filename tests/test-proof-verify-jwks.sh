#!/usr/bin/env bash
# A third party can check WHO produced a receipt, offline, without Loki.
#
# WHY THIS EXISTS. The product claim is "a receipt you can check yourself." That
# claim is false if checking requires our API token, our infrastructure, or a
# gpg key import over a side channel. `loki proof verify <id> --jwks <url|file>`
# is the surface that makes it true: hand an auditor proof.json and jwks.json
# and they verify integrity AND provenance on their own machine.
#
# TEST 1 IS THE CAPABILITY. A local jwks.json file, no network. An air-gapped
# reviewer is exactly the person who most needs to verify and would be excluded
# by a network-only design.
#
# TEST 5 IS THE REGRESSION GUARD AND IT IS THE REASON THIS FILE EXISTS. This
# script runs under `set -e` (loki:22) and proof-verify.py exits 1 on drift --
# its NORMAL result. A bare call therefore aborts the command before the
# attestation block runs, and the feature is silently dead while every unit test
# of the underlying function still passes. The bug presents as SILENCE, not an
# error, so it is asserted on directly here.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: loki proof verify --jwks (third-party, offline)"

[ -f "$LOKI_BIN" ] || { echo "  FAIL: $LOKI_BIN missing"; exit 1; }
if ! python3 -c "import cryptography" 2>/dev/null; then
  echo "  SKIP: cryptography not installed -- not measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-pvjwks.XXXXXX")"
trap 'rm -rf "$W" 2>/dev/null || true' EXIT INT TERM
mkdir -p "$W/.loki/proofs/r1"

python3 - "$W" "$REPO_ROOT" <<'PY' || { echo "  FAIL: fixture setup failed"; exit 1; }
import sys, json, hashlib
w, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, root + "/autonomy")
import receipt_jwt as rj
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
k = Ed25519PrivateKey.generate(); kid = rj.compute_kid(k.public_key())
body = {"run_id": "r1", "schema_version": 1, "facts": {"tests": "passed"}}
h = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
body["verification"] = {
    "hash": h, "algo": "sha256", "scope": "integrity",
    "attestation": rj.sign_attestation(k, kid, job_id="j1", run_id="r1", receipt_hash=h),
    "attestation_kid": kid}
json.dump(body, open(w + "/.loki/proofs/r1/proof.json", "w"))
json.dump(rj.build_jwks(private_key=k), open(w + "/jwks.json", "w"))
# An attacker's key set: the token must NOT verify against keys we did not sign with.
json.dump(rj.build_jwks(private_key=Ed25519PrivateKey.generate()), open(w + "/evil.json", "w"))
# Same receipt with the attestation removed, for the ABSENT case.
body["verification"].pop("attestation")
json.dump(body, open(w + "/plain.json", "w"))
PY

# stderr carries the attestation verdict; stdout is the machine-readable JSON
# and must stay uncontaminated for piping consumers.
# Captured to a FILE rather than through a pipeline. Under `set -o pipefail`,
# `... | grep | head -1` makes head close the pipe early, grep dies on SIGPIPE,
# and the whole pipeline reports failure even when grep MATCHED. That inverts
# every assertion below into a false red -- the exact trap recorded in
# feedback-pipefail-sigpipe-inverts-probe.
_verdict() {
  LOKI_DIR="$W/.loki" bash "$LOKI_BIN" proof verify "$1" --jwks "$2" \
    >/dev/null 2>"$W/err.txt" || true
  grep -i "attestation:" "$W/err.txt" 2>/dev/null || true
}

# --- 1. THE CAPABILITY: offline, file-based, no network ---------------------
if _verdict r1 "$W/jwks.json" | grep -q "VERIFIED"; then
  ok "an auditor verifies provenance from a local jwks.json (no network, no token)"
else
  bad "offline verification failed -- the third-party claim does not hold"
fi

# --- 2. An attacker's key set must NOT verify -------------------------------
if _verdict r1 "$W/evil.json" | grep -q "FAILED"; then
  ok "a token does not verify against a key set that did not sign it"
else
  bad "a receipt verified against the wrong keys -- provenance proves nothing"
fi

# --- 3. ABSENT is a fact about the receipt ----------------------------------
mkdir -p "$W/.loki/proofs/plain" && cp "$W/plain.json" "$W/.loki/proofs/plain/proof.json"
if _verdict plain "$W/jwks.json" | grep -q "ABSENT"; then
  ok "a receipt with no attestation reports ABSENT"
else
  bad "an unattested receipt did not report ABSENT"
fi

# --- 2b. THE DIGEST MUST BE RECOMPUTED, not read from the file --------------
# Edit the body AND rewrite verification.hash to match. The signature still
# verifies (the token is untouched and the key set is correct), so ONLY the
# recomputed-digest comparison can catch this. Added after mutation testing
# showed that replacing the compare with a bare `print("ok")` left every other
# assertion green -- test 2 fails at the signature check and never reaches it.
python3 - "$W" <<'PY'
import sys, json, hashlib
w = sys.argv[1]
p = json.load(open(w + "/.loki/proofs/r1/proof.json"))
v = p.pop("verification")
p["facts"] = {"tests": "FAILED but the receipt claims passed"}
v["hash"] = hashlib.sha256(
    json.dumps(p, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
p["verification"] = v
import os
os.makedirs(w + "/.loki/proofs/rehash", exist_ok=True)
json.dump(p, open(w + "/.loki/proofs/rehash/proof.json", "w"))
PY
if _verdict rehash "$W/jwks.json" | grep -q "FAILED"; then
  ok "an edited body with a recomputed hash is still refused (digest is recomputed)"
else
  bad "a rewritten hash defeated the attestation -- the signed claim is not the anchor"
fi

# --- 4. NOT CHECKED must stay distinct from ABSENT --------------------------
# Collapsing these would report an UNMEASURED receipt as an unattested one.
if _verdict r1 "$W/missing.json" | grep -q "NOT CHECKED"; then
  ok "an absent key set reports NOT CHECKED, not a verdict"
else
  bad "an absent measurement was reported as a fact about the receipt"
fi

# A key set that EXISTS but does not parse takes a different branch than a
# missing path -- it fails inside the read, not the path test. Mutation testing
# showed the missing-file case alone left that branch unguarded, so a corrupt
# key set could have been reported as ABSENT: an unmeasured receipt laundered
# into a fact about the receipt itself.
printf 'not json at all {{{' > "$W/corrupt.json"
if _verdict r1 "$W/corrupt.json" | grep -q "NOT CHECKED"; then
  ok "a corrupt key set reports NOT CHECKED, never ABSENT"
else
  bad "a corrupt key set was reported as a fact about the receipt"
fi

# --- 5. THE set -e REGRESSION GUARD -----------------------------------------
# The bug presented as SILENCE: proof-verify.py exits 1 on drift, `set -e`
# aborted the command, and the attestation block never ran. Asserted on the
# observable symptom -- any attestation line at all on a receipt that carries
# one -- so it catches the failure however it is reintroduced.
LOKI_DIR="$W/.loki" bash "$LOKI_BIN" proof verify r1 --jwks "$W/jwks.json" \
  >/dev/null 2>"$W/e5.txt" || true
if grep -qi "attestation:" "$W/e5.txt"; then
  ok "the attestation block runs even when the base verifier exits non-zero"
else
  bad "no attestation output at all -- set -e is aborting before the check (see loki:22)"
fi

# --- 6. A malformed flag is an error, not a silent no-op --------------------
# Exit 64 (usage), pinned exactly. A dangling --jwks used to exit 2, which
# claims "could not check" for a question that was never asked. An EMPTY value
# ("--jwks ''", "--jwks=") used to skip the attestation check entirely and exit
# 0 on an unsigned receipt, and a later empty --jwks cancelled an earlier real
# one; each form is a usage error now, in any order.
# "plain" is the unsigned receipt from test 3.
_m6() {  # <label> <args...>
  local label="$1" rc; shift
  LOKI_DIR="$W/.loki" bash "$LOKI_BIN" proof verify plain "$@" >/dev/null 2>"$W/e6.txt"
  rc=$?
  if [ "$rc" = 64 ] && ! grep -q "attestation: VERIFIED" "$W/e6.txt"; then
    ok "$label exits 64 (usage)"
  else
    bad "$label exited $rc, want 64 -- a typo would look like a check"
  fi
}
_m6 "--jwks with no value" --jwks
_m6 "--jwks ''" --jwks ''
_m6 "--jwks=" --jwks=
_m6 "--jwks <real> --jwks ''" --jwks "$W/jwks.json" --jwks ''
_m6 "--jwks '' --jwks <real>" --jwks '' --jwks "$W/jwks.json"

# --- 7. stdout stays machine-readable ---------------------------------------
# Machine consumers pipe this verbatim. A verdict leaking into stdout would
# break every one of them.
LOKI_DIR="$W/.loki" bash "$LOKI_BIN" proof verify r1 --jwks "$W/jwks.json" \
  >"$W/out.json" 2>/dev/null || true
if python3 -c "import json,sys; json.load(open('$W/out.json'))" 2>/dev/null; then
  ok "stdout remains valid JSON with --jwks in play"
else
  bad "the attestation verdict contaminated stdout -- machine consumers would break"
fi

# --- 8. EXIT CODES ------------------------------------------------------------
# Every call above ends in `|| true`, so no exit code was pinned. The rule:
# VERIFIED 0 (only if the base verifier passed too), FAILED 1, ABSENT 1 (a key
# set was supplied and the receipt is unsigned: a stripped signature must not
# pass a CI step that asked for provenance; it used to exit 0), NOT CHECKED 2
# (could not check; it used to exit 0), and NOT CHECKED never softens a
# drift 1. These need a receipt the base verifier ACCEPTS, so the attestation
# rule is the only thing that can move the code: a real generator run in a
# real repo, with TARGET_DIR explicit.
R="$W/repo"
g() { git -C "$R" -c user.email=t@example.invalid -c user.name=t \
        -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
mkdir -p "$R"
python3 - "$W" <<'PY'
import sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
open(sys.argv[1] + "/s.pem", "wb").write(Ed25519PrivateKey.generate().private_bytes(
    encoding=serialization.Encoding.PEM, format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption()))
PY
python3 - "$W" "$REPO_ROOT" <<'PY'
import sys, json
w, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, root + "/autonomy")
import receipt_jwt as rj
from cryptography.hazmat.primitives import serialization
k = serialization.load_pem_private_key(open(w + "/s.pem", "rb").read(), password=None)
json.dump(rj.build_jwks(private_key=k), open(w + "/gjwks.json", "w"))
PY
{
  g init -q && printf 'one\n' >"$R/a.txt" && g add a.txt && g commit -qm base \
    && _base="$(g rev-parse HEAD)" && printf 'two\n' >>"$R/a.txt" \
    && g add a.txt && g commit -qm change && mkdir -p "$R/.loki"
} >/dev/null 2>&1
(cd "$R" && _LOKI_RUN_START_SHA="${_base:-}" LOKI_RECEIPT_SIGNING_KEY_FILE="$W/s.pem" \
  python3 "$REPO_ROOT/autonomy/lib/proof-generator.py" --loki-dir "$R/.loki" \
  --out-dir "$R/.loki/proofs/g1" --run-id g1 --quiet) >/dev/null 2>&1
mkdir -p "$R/.loki/proofs/g1strip"
python3 -c "
import json; p=json.load(open('$R/.loki/proofs/g1/proof.json'))
p['verification'].pop('attestation', None)
json.dump(p, open('$R/.loki/proofs/g1strip/proof.json', 'w'))" 2>/dev/null

# _rc <repo> <args...>: exit code of `loki proof verify`, stderr in $W/rc.err
_rc() {
  local repo="$1"; shift
  LOKI_DIR="$repo/.loki" TARGET_DIR="$repo" bash "$LOKI_BIN" proof verify "$@" \
    >/dev/null 2>"$W/rc.err"
  echo "$?"
}
_expect() {  # <want> <got> <label>
  if [ "$2" = "$1" ]; then ok "$3 (exit $2)"; else bad "$3: exit $2, want $1"; fi
}

# The control that makes every code below attributable to the attestation rule.
_expect 0 "$(_rc "$R" g1)" "control: the base verifier accepts the fixture receipt"
_expect 0 "$(_rc "$R" g1 --jwks "$W/gjwks.json")" "VERIFIED exits 0"
_expect 1 "$(_rc "$R" g1 --jwks "$W/evil.json")" "FAILED (wrong key set) exits 1"
_expect 1 "$(_rc "$R" g1strip --jwks "$W/gjwks.json")" "ABSENT (stripped signature) exits 1"
grep -q "attestation: ABSENT" "$W/rc.err" \
  || bad "the ABSENT exit was not produced by the ABSENT branch"
_expect 2 "$(_rc "$R" g1 --jwks "$W/missing.json")" "NOT CHECKED (missing key set) exits 2"

# A missing verifier dependency must be NOT CHECKED, not FAILED. receipt_jwt
# imports without `cryptography` and verify_attestation then returns False,
# which read as FAILED (an accusation for a check that never ran). A shadow
# package that raises ImportError simulates the missing dependency.
mkdir -p "$W/shadow/cryptography"
echo 'raise ImportError("shadowed by test-proof-verify-jwks.sh")' \
  >"$W/shadow/cryptography/__init__.py"
if PYTHONPATH="$W/shadow" python3 -c "import cryptography" 2>/dev/null; then
  bad "harness: the shadow did not hide cryptography; dependency case inconclusive"
else
  _expect 2 "$(PYTHONPATH="$W/shadow" _rc "$R" g1 --jwks "$W/gjwks.json")" \
    "NOT CHECKED (verifier dependency missing) exits 2"
  if grep -q "attestation: FAILED" "$W/rc.err"; then
    bad "a missing dependency was reported as FAILED"
  fi
fi

# NOT CHECKED must never soften a drift finding into 'could not check'.
cp -R "$R" "$W/drifted" && printf 'edited after sealing\n' >>"$W/drifted/a.txt"
_expect 1 "$(_rc "$W/drifted" g1 --jwks "$W/missing.json")" "drift + NOT CHECKED keeps the drift exit"

# The remote copy of the check carries the same dependency guard (the two copies
# must not diverge). file:// reaches its "<url>/.well-known/jwks.json" fetch
# with no server.
if command -v jq >/dev/null 2>&1; then
  mkdir -p "$W/srv/.well-known" && cp "$W/gjwks.json" "$W/srv/.well-known/jwks.json"
  sed -n '/^loki_remote_attestation_status() {/,/^}/p' "$LOKI_BIN" >"$W/remote.sh"
  _remote() {
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" bash -c "
      source '$W/remote.sh'; loki_remote_attestation_status '$R/.loki/proofs/g1/proof.json' 'file://$W/srv'"
  }
  _r_ok="$(_remote)"
  _r_dep="$(PYTHONPATH="$W/shadow" _remote)"
  if [ "$_r_ok" = "ok" ] && [ -z "$_r_dep" ]; then
    ok "remote check: 'ok' with cryptography, no verdict without it (not TAMPERED)"
  else
    bad "remote check: got '$_r_ok' with cryptography and '$_r_dep' without (want 'ok' and '')"
  fi
else
  echo "  SKIP: jq not installed -- remote dependency guard not measured"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
