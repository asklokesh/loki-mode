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
# Anchored to the exact verified line: a bare "VERIFIED" also matches
# "NOT VERIFIED", so an unanchored grep could pass on the opposite verdict.
_v1="$(_verdict r1 "$W/jwks.json")"
if grep -qxF "attestation: VERIFIED against $W/jwks.json" <<<"$_v1"; then
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
# which read as FAILED (an accusation for a check that never ran). The
# verifiers run with python3 -E, which ignores PYTHONPATH, so the missing
# dependency is simulated by a python3 shim on PATH that runs the real
# interpreter with -S (no site-packages, where cryptography lives).
_real_py="$(command -v python3)"
mkdir -p "$W/nocrypto"
printf '#!/bin/sh\nexec "%s" -S "$@"\n' "$_real_py" >"$W/nocrypto/python3"
chmod +x "$W/nocrypto/python3"
NOCRYPTO_PATH="$W/nocrypto:$PATH"
if PATH="$NOCRYPTO_PATH" python3 -E -c "import cryptography" 2>/dev/null \
   || ! PATH="$NOCRYPTO_PATH" python3 -E -c "import json" 2>/dev/null; then
  bad "harness: the shim did not hide cryptography (or broke python); dependency case inconclusive"
else
  _expect 2 "$(PATH="$NOCRYPTO_PATH" _rc "$R" g1 --jwks "$W/gjwks.json")" \
    "NOT CHECKED (verifier dependency missing) exits 2"
  if grep -q "attestation: FAILED" "$W/rc.err"; then
    bad "a missing dependency was reported as FAILED"
  fi
fi

# NOT CHECKED must never soften a drift finding into 'could not check'.
cp -R "$R" "$W/drifted" && printf 'edited after sealing\n' >>"$W/drifted/a.txt"
_expect 1 "$(_rc "$W/drifted" g1 --jwks "$W/missing.json")" "drift + NOT CHECKED keeps the drift exit"

# --- 9. A malformed attestation is REFUSED, never "could not check" ----------
# Whoever builds the receipt controls verification.attestation. A token whose
# header decodes to a non-object, or an attestation that is not a string at
# all, used to crash the check after the key set had loaded; the crash read as
# NOT CHECKED (exit 2), so a forger could turn FAILED into "could not check".
# The integrity hash excludes verification.*, so each forged receipt still
# passes the base verifier and only the attestation rule can decide the code.
python3 - "$R/.loki/proofs" <<'PY'
import base64, json, os, sys
d = sys.argv[1]
p = json.load(open(os.path.join(d, "g1", "proof.json")))
b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
forms = {
    "g1hdr": b([1]) + "." + b({"receipt_sha256": "x"}) + "." + b("sig"),
    "g1dict": {"alg": "EdDSA", "kid": "k"},
    "g1num": 7,
}
for name, att in forms.items():
    q = json.loads(json.dumps(p))
    q["verification"]["attestation"] = att
    os.makedirs(os.path.join(d, name), exist_ok=True)
    json.dump(q, open(os.path.join(d, name, "proof.json"), "w"))
PY
# _refused <label> <id>: exit 1 and the FAILED line, never NOT CHECKED.
_refused() {
  local label="$1" id="$2" rc
  rc="$(_rc "$R" "$id" --jwks "$W/gjwks.json")"
  if [ "$rc" = 1 ] && grep -q "attestation: FAILED" "$W/rc.err" \
     && ! grep -q "NOT CHECKED" "$W/rc.err"; then
    ok "$label: FAILED, exit 1"
  else
    bad "$label: exit $rc, want 1 with attestation: FAILED ($(grep "attestation:" "$W/rc.err" | head -1))"
  fi
}
_expect 0 "$(_rc "$R" g1hdr)" "control: the header-[1] receipt passes the base verifier without --jwks"
_refused "a token whose header decodes to [1]" g1hdr
_refused "a dict attestation" g1dict
_refused "a numeric attestation" g1num
# A non-string attestation is malformed on inspection, so it stays FAILED even
# with the verifier dependency missing (the $W/nocrypto shim hides cryptography).
if ! PATH="$NOCRYPTO_PATH" python3 -E -c "import cryptography" 2>/dev/null; then
  _rcs="$(PATH="$NOCRYPTO_PATH" _rc "$R" g1dict --jwks "$W/gjwks.json")"
  if [ "$_rcs" = 1 ] && grep -q "attestation: FAILED" "$W/rc.err"; then
    ok "a dict attestation is FAILED without cryptography too (no crypto needed to refuse it)"
  else
    bad "a dict attestation without cryptography: exit $_rcs, want 1 with attestation: FAILED"
  fi
fi

# The Bun entry point (bin/loki) delegates any flagged verify to this bash
# verifier. Measured through it too, so the delegation cannot drop the verdict.
HAVE_BUN=0
command -v bun >/dev/null 2>&1 && HAVE_BUN=1
_rc_bun() {
  local repo="$1"; shift
  LOKI_DIR="$repo/.loki" TARGET_DIR="$repo" "$REPO_ROOT/bin/loki" proof verify "$@" \
    >/dev/null 2>"$W/rc.err"
  echo "$?"
}
if [ "$HAVE_BUN" -eq 1 ]; then
  for _id in g1hdr g1dict; do
    _rcb="$(_rc_bun "$R" "$_id" --jwks "$W/gjwks.json")"
    if [ "$_rcb" = 1 ] && grep -q "attestation: FAILED" "$W/rc.err"; then
      ok "bun entry point delegating to the bash verifier: $_id FAILED, exit 1"
    else
      bad "bun entry point delegating to the bash verifier: $_id exit $_rcb, want 1 with attestation: FAILED"
    fi
  done
else
  echo "  SKIP: bun not installed -- Bun delegation not measured"
fi

# --- 10. A malformed KEY SET is NOT CHECKED, never an accusation -------------
# The key set is the auditor's own input. If it is not {"keys": [{...}, ...]}
# nothing can be said about the receipt, so the answer is NOT CHECKED (2) on a
# receipt the base verifier accepts. {"keys": {}} used to read FAILED; [1] and
# {"keys": [1]} pin that the malformed-token catch-all runs only AFTER the
# shape check, so it can never turn a bad key set into FAILED.
printf '%s' '{"keys": {}}' >"$W/ks-dict.json"
printf '%s' '[1]' >"$W/ks-list.json"
printf '%s' '{"keys": [1]}' >"$W/ks-entry.json"
for _ks in ks-dict ks-list ks-entry; do
  _expect 2 "$(_rc "$R" g1 --jwks "$W/$_ks.json")" "a malformed key set ($_ks) is NOT CHECKED"
  if grep -q "attestation: FAILED" "$W/rc.err"; then
    bad "a malformed key set ($_ks) was reported as FAILED"
  fi
done

# --- 11. A mistyped flag is a usage error, not a skipped check ---------------
# "--jwk keys.json" and "-jwks keys.json" used to be read as extra positionals
# and ignored, so an unsigned receipt exited 0 as if its signature had been
# checked. An unknown option, or a second proof id, exits 64 and names it.
# g1strip is unsigned and passes the base verifier, so 0 was the old answer.
_expect 0 "$(_rc "$R" g1strip)" "control: the unsigned receipt passes with no flags"
_usage() {  # <label> <want-in-stderr> <runner> <args...>
  local label="$1" want="$2" runner="$3" rc; shift 3
  rc="$("$runner" "$R" "$@")"
  if [ "$rc" = 64 ] && grep -qF -- "$want" "$W/rc.err"; then
    ok "$label exits 64 and names it"
  else
    bad "$label: exit $rc, want 64 naming $want"
  fi
}
_usage "--jwk <file>" "'--jwk'" _rc g1strip --jwk "$W/gjwks.json"
_usage "-jwks <file>" "'-jwks'" _rc g1strip -jwks "$W/gjwks.json"
_usage "--jwk before the id" "'--jwk'" _rc --jwk "$W/gjwks.json" g1strip
_usage "two proof ids" "one proof id" _rc g1strip g1
if [ "$HAVE_BUN" -eq 1 ]; then
  _usage "bun entry point delegating to the bash verifier: --jwk <file>" "'--jwk'" _rc_bun g1strip --jwk "$W/gjwks.json"
  _usage "bun entry point delegating to the bash verifier: -jwks <file>" "'-jwks'" _rc_bun g1strip -jwks "$W/gjwks.json"
  _usage "bun entry point: two proof ids" "one proof id" _rc_bun g1strip g1
fi

# --- 12. Help never skips a check -----------------------------------------------
# verify never exits 0 without a verdict: -h/--help is a usage error (64) alone
# or combined. The documented call is "loki proof verify <id>", so an id taken
# from untrusted content could be "-h"; an exit-0 help would pass a forged
# receipt through a provenance gate. g1strip is unsigned, so with --jwks the
# honest answer is 1 (ABSENT), never 0.
_expect 1 "$(_rc "$R" g1strip --jwks "$W/gjwks.json")" "control: unsigned + --jwks is ABSENT (1)"
_usage "bare --help (verify never exits 0 without a verdict)" "Nothing was checked" _rc --help
_usage "bare -h" "Nothing was checked" _rc -h
_usage "id plus --help" "Nothing was checked" _rc g1strip --jwks "$W/gjwks.json" --help
_usage "-h before the id" "Nothing was checked" _rc -h g1strip --jwks "$W/gjwks.json"
_usage "id plus -h" "Nothing was checked" _rc g1strip -h
if [ "$HAVE_BUN" -eq 1 ]; then
  _usage "bun entry point: id plus --help" "Nothing was checked" _rc_bun g1strip --jwks "$W/gjwks.json" --help
  _usage "bun entry point: bare -h" "Nothing was checked" _rc_bun -h
fi
# "--" ends option parsing, so an id that is literally "-h" is looked up as an
# id (66 unknown), not taken as help, and a real id after "--" is verified.
_expect 66 "$(_rc "$R" -- -h)" "'-- -h' treats -h as a proof id (unknown, 66)"
_expect 1 "$(_rc "$R" --jwks "$W/gjwks.json" -- g1strip)" "'--jwks k -- id' still checks the attestation (ABSENT, 1)"

# --- 13. The checkout being verified cannot supply the verifier's modules --------
# The attestation check runs "python3 -" from inside the checkout, which put the
# cwd first on sys.path: a PR that commits hashlib.py or json.py printed
# "attestation: VERIFIED" for an unsigned receipt. The receipt is generated AFTER
# the shadow modules are committed, so the base verifier sees no drift and only
# the attestation rule decides.
S="$W/shadowrepo"
gs() { git -C "$S" -c user.email=t@example.invalid -c user.name=t \
        -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
mkdir -p "$S"
{
  gs init -q && printf 'one\n' >"$S/a.txt" && gs add a.txt && gs commit -qm base \
    && _sbase="$(gs rev-parse HEAD)" \
    && printf 'import sys\nprint("ok")\nsys.exit(0)\n' >"$S/hashlib.py" \
    && printf 'import sys\nprint("ok")\nsys.exit(0)\n' >"$S/json.py" \
    && gs add hashlib.py json.py && gs commit -qm "shadow the verifier" && mkdir -p "$S/.loki"
} >/dev/null 2>&1
(cd "$S" && _LOKI_RUN_START_SHA="${_sbase:-}" LOKI_RECEIPT_SIGNING_KEY_FILE="$W/s.pem" \
  python3 "$REPO_ROOT/autonomy/lib/proof-generator.py" --loki-dir "$S/.loki" \
  --out-dir "$S/.loki/proofs/s1" --run-id s1 --quiet) >/dev/null 2>&1
mkdir -p "$S/.loki/proofs/s1strip"
python3 -c "
import json; p=json.load(open('$S/.loki/proofs/s1/proof.json'))
p['verification'].pop('attestation', None)
json.dump(p, open('$S/.loki/proofs/s1strip/proof.json', 'w'))" 2>/dev/null
_rc_in() {  # <runner-cmd...>: run from INSIDE the shadow checkout
  # No bytecode: a shadow import writing __pycache__/ would drift the tree and
  # produce a 1 for the wrong reason, masking the attestation verdict.
  (cd "$S" && PYTHONDONTWRITEBYTECODE=1 LOKI_DIR="$S/.loki" TARGET_DIR="$S" "$@" >/dev/null 2>"$W/rc.err"); echo "$?"
}
if [ ! -f "$S/.loki/proofs/s1/proof.json" ]; then
  bad "harness: the shadow fixture produced no receipt; section 13 inconclusive"
else
  _expect 0 "$(_rc_in bash "$LOKI_BIN" proof verify s1strip)" "control: shadow-checkout unsigned receipt passes the base verifier"
  _expect 1 "$(_rc_in bash "$LOKI_BIN" proof verify s1strip --jwks "$W/gjwks.json")" "shadow hashlib.py/json.py in the cwd: unsigned receipt is ABSENT (1), not VERIFIED"
  grep -q "attestation: ABSENT" "$W/rc.err" || bad "shadow checkout: the ABSENT exit did not come from the ABSENT branch"
  _expect 0 "$(_rc_in bash "$LOKI_BIN" proof verify s1 --jwks "$W/gjwks.json")" "shadow checkout: a genuinely signed receipt still verifies (0)"
  if [ "$HAVE_BUN" -eq 1 ]; then
    _expect 1 "$(_rc_in "$REPO_ROOT/bin/loki" proof verify s1strip --jwks "$W/gjwks.json")" "bun entry point, shadow checkout: unsigned is ABSENT (1)"
    grep -q "attestation: ABSENT" "$W/rc.err" || bad "bun entry point, shadow checkout: the exit did not come from the ABSENT branch"
  fi
  [ ! -d "$S/__pycache__" ] || bad "shadow checkout gained __pycache__/: a shadow module was imported"
fi

# Same attack through the ENVIRONMENT: an empty PYTHONPATH component (what
# "export PYTHONPATH=x:$PYTHONPATH" leaves when it was unset) puts the cwd on
# sys.path as an absolute path, and a committed sitecustomize.py runs during
# site import, before any in-script guard. The verifiers run with python3 -E.
# The smart json.py answers for both the attestation heredoc and the base
# verifier, so only -E stands between it and a false pass.
S2="$W/shadowrepo2"
gs2() { git -C "$S2" -c user.email=t@example.invalid -c user.name=t \
        -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
mkdir -p "$S2"
{
  gs2 init -q && printf 'one\n' >"$S2/a.txt" && gs2 add a.txt && gs2 commit -qm base \
    && _s2base="$(gs2 rev-parse HEAD)" \
    && cat >"$S2/json.py" <<'SHADOW'
import sys, os
if sys.argv[:1] == ['-']:
    print("ok"); sys.exit(0)
if sys.argv[0].endswith('proof-verify.py'):
    sys.stdout.write('{"ok": true, "hash_ok": true}\n'); sys.exit(0)
here = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [p for p in sys.path if os.path.abspath(p or '.') != here]
del sys.modules['json']
import json as _real
sys.modules['json'] = _real
SHADOW
  printf 'import os\nopen(os.environ.get("MARK_FILE", "/dev/null"), "a").write("ran\\n")\n' >"$S2/sitecustomize.py" \
    && printf '__pycache__/\n.loki/\n' >"$S2/.gitignore" \
    && gs2 add json.py sitecustomize.py .gitignore && gs2 commit -qm "shadow via env" && mkdir -p "$S2/.loki"
} >/dev/null 2>&1
(cd "$S2" && _LOKI_RUN_START_SHA="${_s2base:-}" LOKI_RECEIPT_SIGNING_KEY_FILE="$W/s.pem" \
  python3 "$REPO_ROOT/autonomy/lib/proof-generator.py" --loki-dir "$S2/.loki" \
  --out-dir "$S2/.loki/proofs/e1" --run-id e1 --quiet) >/dev/null 2>&1
mkdir -p "$S2/.loki/proofs/e1strip" "$S2/.loki/proofs/e1tamper"
python3 -c "
import json; p=json.load(open('$S2/.loki/proofs/e1/proof.json'))
p['verification'].pop('attestation', None)
json.dump(p, open('$S2/.loki/proofs/e1strip/proof.json', 'w'))
t=json.load(open('$S2/.loki/proofs/e1/proof.json'))
t['facts']['git']['head_sha']='0'*40
json.dump(t, open('$S2/.loki/proofs/e1tamper/proof.json', 'w'))" 2>/dev/null
_rc_env() {  # <runner-cmd...>: inside the checkout, hostile PYTHONPATH, marker for sitecustomize
  (cd "$S2" && PYTHONPATH=":/nonexistent" MARK_FILE="$W/sitecustomize.ran" \
     LOKI_DIR="$S2/.loki" TARGET_DIR="$S2" "$@" >/dev/null 2>"$W/rc.err"); echo "$?"
}
if [ ! -f "$S2/.loki/proofs/e1/proof.json" ]; then
  bad "harness: the env-shadow fixture produced no receipt; env leg inconclusive"
else
  rm -f "$W/sitecustomize.ran"
  _expect 1 "$(_rc_env bash "$LOKI_BIN" proof verify e1strip --jwks "$W/gjwks.json")" "PYTHONPATH=':...' + shadow json/sitecustomize: unsigned is ABSENT (1), not VERIFIED"
  grep -q "attestation: ABSENT" "$W/rc.err" || bad "env leg: the exit did not come from the ABSENT branch"
  _expect 1 "$(_rc_env bash "$LOKI_BIN" proof verify e1tamper)" "PYTHONPATH=':...' + shadow json: a tampered receipt still exits 1"
  _expect 0 "$(_rc_env bash "$LOKI_BIN" proof verify e1 --jwks "$W/gjwks.json")" "PYTHONPATH=':...': a genuinely signed receipt still verifies (0)"
  if [ "$HAVE_BUN" -eq 1 ]; then
    _expect 1 "$(_rc_env "$REPO_ROOT/bin/loki" proof verify e1strip --jwks "$W/gjwks.json")" "bun entry point, hostile PYTHONPATH: unsigned is ABSENT (1)"
    _expect 1 "$(_rc_env "$REPO_ROOT/bin/loki" proof verify e1tamper)" "bun entry point, hostile PYTHONPATH: tampered exits 1 (unflagged Bun verifier)"
  fi
  [ ! -s "$W/sitecustomize.ran" ] || bad "a committed sitecustomize.py ran inside a verifier"
fi

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
  _r_dep="$(PATH="$NOCRYPTO_PATH" _remote)"
  if [ "$_r_ok" = "ok" ] && [ -z "$_r_dep" ]; then
    ok "remote check: 'ok' with cryptography, no verdict without it (not TAMPERED)"
  else
    bad "remote check: got '$_r_ok' with cryptography and '$_r_dep' without (want 'ok' and '')"
  fi
  # Render the CONSUMER, not only the helper: a signed receipt whose attestation
  # could not be checked must read NOT CHECKED, never UNSIGNED (which would
  # mislabel a signed build and point at the wrong fix) and never TAMPERED.
  sed -n '/^loki_remote_verify_receipt() {/,/^}/p' "$LOKI_BIN" >>"$W/remote.sh"
  _render() {
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" bash -c "
      source '$W/remote.sh'; loki_remote_verify_receipt '$R/.loki/proofs/g1/proof.json' 'file://$W/srv'"
  }
  _v_ok="$(_render 2>&1)"
  _v_dep="$(PATH="$NOCRYPTO_PATH" _render 2>&1)"
  # Anchored to the exact verified line (a bare "VERIFIED" also matches "NOT
  # VERIFIED"). Here-strings, not `printf | grep -q`: under pipefail grep -q
  # can close the pipe early and SIGPIPE inverts the assertion.
  if grep -qxF "  VERIFIED: integrity hash matches and the receipt's attestation is valid." <<<"$_v_ok" \
     && grep -q "NOT CHECKED" <<<"$_v_dep" \
     && ! grep -qE "UNSIGNED|TAMPERED" <<<"$_v_dep"; then
    ok "remote render: VERIFIED with cryptography, NOT CHECKED without it (not UNSIGNED)"
  else
    bad "remote render: with cryptography '$(printf '%s' "$_v_ok" | head -1)', without '$(printf '%s' "$_v_dep" | head -1)' (want VERIFIED, then NOT CHECKED)"
  fi
  # The forged receipts from test 9 on the remote render: a malformed
  # attestation is TAMPERED (return 1). It used to crash the helper, which read
  # as NOT CHECKED with "install python3 cryptography" (return 0).
  _render_id() {  # <id> -> return code; output in $W/render.out
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" bash -c "
      source '$W/remote.sh'; loki_remote_verify_receipt '$R/.loki/proofs/$1/proof.json' 'file://$W/srv'" \
      >"$W/render.out" 2>&1
    echo "$?"
  }
  for _id in g1hdr g1dict g1num; do
    _rr="$(_render_id "$_id")"
    if [ "$_rr" = 1 ] && grep -q "TAMPERED: the receipt's attestation does not verify" "$W/render.out" \
       && ! grep -q "NOT CHECKED" "$W/render.out"; then
      ok "remote render: $_id is TAMPERED (return 1)"
    else
      bad "remote render: $_id returned $_rr, want 1 TAMPERED ($(head -1 "$W/render.out"))"
    fi
  done
  # Malformed on inspection, so TAMPERED needs no crypto: with cryptography
  # hidden it must not fall back to "install python3 cryptography".
  _rr="$(PATH="$NOCRYPTO_PATH" _render_id g1dict)"
  if [ "$_rr" = 1 ] && grep -q "TAMPERED: the receipt's attestation does not verify" "$W/render.out"; then
    ok "remote render: a dict attestation is TAMPERED without cryptography too"
  else
    bad "remote render: dict attestation without cryptography returned $_rr, want 1 TAMPERED ($(head -1 "$W/render.out"))"
  fi
else
  echo "  SKIP: jq not installed -- remote dependency guard not measured"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
