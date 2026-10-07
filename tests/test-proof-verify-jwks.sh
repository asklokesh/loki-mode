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
    "attestation": rj.sign_attestation(k, kid, job_id="j1", run_id="r1", receipt_hash=h,
                                       verification={"hash": h, "algo": "sha256", "scope": "integrity"}),
    "attestation_kid": kid}
json.dump(body, open(w + "/.loki/proofs/r1/proof.json", "w"))
# A legacy seal.v1 receipt (token without signed metadata) in the wild.
import os
os.makedirs(w + "/.loki/proofs/r2", exist_ok=True)
legacy = json.loads(json.dumps(body)); legacy["run_id"] = "r2"
lh = hashlib.sha256(json.dumps({x: y for x, y in legacy.items() if x != "verification"}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
legacy["verification"] = {"hash": lh, "algo": "sha256", "scope": "integrity", "attestation_kid": kid,
    "attestation": rj.sign_attestation(k, kid, job_id="j2", run_id="r2", receipt_hash=lh)}
json.dump(legacy, open(w + "/.loki/proofs/r2/proof.json", "w"))
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
  LOKI_DIR="$W/.loki" TARGET_DIR="$W" bash "$LOKI_BIN" proof verify "$1" --jwks "$2" \
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

# --- 1b. A legacy seal.v1 receipt still verifies but says its metadata is unsigned
_v1b="$(_verdict r2 "$W/jwks.json")"
if grep -qF "attestation: VERIFIED against $W/jwks.json (metadata not signed (legacy seal.v1)" <<<"$_v1b"; then
  ok "a legacy seal.v1 receipt verifies and states: metadata not signed (legacy seal.v1)"
else
  bad "legacy seal.v1 receipt did not state that its metadata is not signed: $_v1b"
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
# BACKLOG 51: the verifier runs python3 -E, so a cryptography install reachable
# only through PYTHONPATH is invisible. The NOT CHECKED text must say so, or the
# user "installs cryptography" and sees the same verdict. -E does NOT hide the
# user site (site.py reads PYTHONUSERBASE from os.environ), so the text must not
# claim PYTHONUSERBASE is ignored.
if grep -q "python3 -E" "$W/err.txt" && grep -q "PYTHONPATH" "$W/err.txt" \
   && ! grep -q "PYTHONUSERBASE" "$W/err.txt"; then
  ok "NOT CHECKED names python3 -E and PYTHONPATH, and does not blame PYTHONUSERBASE"
else
  bad "NOT CHECKED misstates which environment the python3 -E verifier ignores"
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
LOKI_DIR="$W/.loki" TARGET_DIR="$W" bash "$LOKI_BIN" proof verify r1 --jwks "$W/jwks.json" \
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
  LOKI_DIR="$W/.loki" TARGET_DIR="$W" bash "$LOKI_BIN" proof verify plain "$@" >/dev/null 2>"$W/e6.txt"
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
LOKI_DIR="$W/.loki" TARGET_DIR="$W" bash "$LOKI_BIN" proof verify r1 --jwks "$W/jwks.json" \
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

# g1tamper: the body is edited and the hash is left STALE (not recomputed),
# a genuine hash mismatch -- hash_ok: false. Distinct from section 2b's
# "rehash" fixture, which recomputes the hash so hash_ok stays true; that one
# exists to prove a rewritten hash still fails on the SIGNATURE. This one is
# for BACKLOG 49's TAMPERED label: it must fire only on a real hash mismatch,
# never merely because base_rc != 0 (drift is base_rc != 0 too, and must stay
# FAILED, not TAMPERED).
mkdir -p "$R/.loki/proofs/g1tamper"
python3 -c "
import json; p=json.load(open('$R/.loki/proofs/g1/proof.json'))
p['facts']['git']['head_sha'] = '0' * 40
json.dump(p, open('$R/.loki/proofs/g1tamper/proof.json', 'w'))" 2>/dev/null

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

# <file> <field>: read one field out of a verify-command JSON report.
_json_field() {
  python3 -c "
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    print('<unparseable>'); sys.exit(0)
print(doc.get(sys.argv[2], '<absent>'))
" "$1" "$2"
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
    "g1boolfalse": False,
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

# --- 9b. BACKLOG 39: `attestation: false` is ABSENT, never FAILED -----------
# `false` is the JSON value a broken client or a hand-edited receipt uses to
# say "not attested" -- it is not a JWT string, but it is also not the
# malformed-on-inspection shape the section-9 forms are (a header decoding to
# [1], a dict, a bare number all imply a check was ATTEMPTED and failed). A
# `false` reads exactly like a missing field: nothing was ever attested, so it
# must fall into the same ABSENT bucket a stripped/omitted field uses, exit 1
# (a key set was supplied and the receipt is unsigned), never FAILED.
_expect 1 "$(_rc "$R" g1boolfalse --jwks "$W/gjwks.json")" "attestation: false reads ABSENT (1), not FAILED"
grep -q "attestation: ABSENT" "$W/rc.err" \
  || bad "attestation: false did not render ABSENT ($(grep "attestation:" "$W/rc.err" | head -1))"
if grep -q "attestation: FAILED" "$W/rc.err"; then
  bad "attestation: false was reported as FAILED -- a receipt with no attestation is not tampering"
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

# --- 10b. BACKLOG 39: an EMPTY key set is NOT CHECKED, never FAILED ----------
# {"keys": []} is a well-shaped key set (a JSON list of objects, vacuously
# true) so it slipped past the section-10 shape guard and fell all the way
# through to verify_attestation, which found no matching kid and printed
# "bad" -- FAILED (exit 1), reading as tampering. An empty keyset is an
# inability to check (nothing was published to check against), the same fact
# as a malformed key set, not evidence against the receipt.
printf '%s' '{"keys": []}' >"$W/ks-empty.json"
_expect 2 "$(_rc "$R" g1 --jwks "$W/ks-empty.json")" "an empty key set ({\"keys\": []}) is NOT CHECKED"
if grep -q "attestation: FAILED" "$W/rc.err"; then
  bad "an empty key set was reported as FAILED -- an inability to check read as tampering"
fi

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

# --- 13b. S-14 shadow checkout: the JSON/human PATCH step must resist it too --
# Section 13 proves the ATTESTATION check (loki_proof_attestation_check) is
# immune to a checkout that ships its own hashlib.py/json.py. BACKLOG 49 added
# a SECOND python3 invocation after that check -- the one that rewrites
# ok/verdict onto stdout -- and it runs from the same invocation cwd. A shadow
# json.py that raises (or lies) during that rewrite must not silently fall
# back to the base verifier's own possibly-stale "ok" via the `|| printf
# '%s\n' "$_pv_out"` escape hatch.
#
# The shadow json.py must be committed BEFORE the receipt is generated (same
# rule as section 13's s1/s1strip): swapping it in afterward would itself be
# workspace-tree drift and produce exit 1 for the wrong reason, masking
# whether the patch step's own sys.path strip holds.
{
  gs rm -q hashlib.py json.py \
    && cat >"$S/json.py" <<'SHADOW14'
open("shadow14.ran", "a").write("ran\n")
raise ImportError("shadow json.py must never load for the S-14 patch step")
SHADOW14
  gs add json.py && gs commit -qm "shadow json.py raises (S-14)" \
    && _sbase14="$(gs rev-parse HEAD~1)"
} >/dev/null 2>&1
(cd "$S" && _LOKI_RUN_START_SHA="${_sbase14:-}" LOKI_RECEIPT_SIGNING_KEY_FILE="$W/s.pem" \
  python3 "$REPO_ROOT/autonomy/lib/proof-generator.py" --loki-dir "$S/.loki" \
  --out-dir "$S/.loki/proofs/s1hostile" --run-id s1hostile --quiet) >/dev/null 2>&1
mkdir -p "$S/.loki/proofs/s1hostilestrip"
python3 -c "
import json; p=json.load(open('$S/.loki/proofs/s1hostile/proof.json'))
p['verification'].pop('attestation', None)
json.dump(p, open('$S/.loki/proofs/s1hostilestrip/proof.json', 'w'))" 2>/dev/null
if [ ! -f "$S/.loki/proofs/s1hostile/proof.json" ]; then
  bad "harness: S-14 hostile-json.py fixture produced no receipt; shadow-patch case inconclusive"
else
  rm -f "$S/shadow14.ran"
  (cd "$S" && PYTHONDONTWRITEBYTECODE=1 LOKI_DIR="$S/.loki" TARGET_DIR="$S" \
    bash "$LOKI_BIN" proof verify s1hostilestrip --jwks "$W/gjwks.json" \
    >"$W/s14_shadow.json" 2>"$W/rc.err")
  _s14_rc=$?
  if [ -f "$S/shadow14.ran" ]; then
    bad "S-14 shadow checkout: the planted json.py loaded during the patch step -- sys.path strip failed"
  else
    ok "S-14 shadow checkout: the planted json.py never loaded during the patch step"
  fi
  if [ "$_s14_rc" = 1 ]; then
    ok "S-14 shadow checkout: verify still exits 1 (ABSENT) with a hostile json.py in the cwd"
  else
    bad "S-14 shadow checkout: exit $_s14_rc, want 1 -- a raising shadow json.py changed the outcome"
  fi
  _s14_ok="$(_json_field "$W/s14_shadow.json" ok)"
  _s14_verdict="$(_json_field "$W/s14_shadow.json" verdict)"
  if [ "$_s14_ok" = "False" ] && [ "$_s14_verdict" = "ABSENT" ]; then
    ok "S-14 shadow checkout: ok=false and verdict=ABSENT survive a hostile cwd json.py"
  else
    bad "S-14 shadow checkout: ok=$_s14_ok verdict=$_s14_verdict, want ok=False verdict=ABSENT -- the shadow module (or the || printf fallback) leaked the stale base-check opinion"
  fi
  [ ! -f "$S/shadow14.ran" ] || bad "S-14 shadow checkout: the planted json.py loaded at some point during the run"
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

# --- 14. BACKLOG 49: stdout JSON must agree with the exit code ---------------
# On ABSENT (exit 1) and NOT CHECKED (exit 2) the base verifier's OWN JSON
# report -- computed before the attestation check ever runs -- can still be a
# clean "ok": true, because the base check only re-hashes and re-diffs; it
# never sees the attestation. A consumer reading stdout alone (never the exit
# code) would misread a stripped signature, or an unreadable key set, as a
# pass. Fixed by patching ok/verdict onto the JSON after the exit code is
# final, so the two can never disagree again by construction.
#
# A malformed proof.json for the rc=2 row: the base verifier itself cannot
# even compute hash_ok there (ProofLoadError), so this also pins that a
# verifier-side error never gets labelled TAMPERED.
mkdir -p "$W/.loki/proofs/malformed"
printf 'not json at all {{{' >"$W/.loki/proofs/malformed/proof.json"

# <label> <repo> <id> <jwks-or-empty> <want-exit>
# For each row: run it, then assert the invariant BACKLOG 49 is about --
# ok/verdict must agree with the exit code that same run produced, never a
# stale opinion from the base hash/drift check alone.
_row() {
  local label="$1" repo="$2" id="$3" jwks="$4" want="$5" runner="${6:-bash}" rc ok_val verdict
  if [ "$runner" = "bun" ]; then
    LOKI_DIR="$repo/.loki" TARGET_DIR="$repo" "$REPO_ROOT/bin/loki" proof verify "$id" \
      --jwks "$jwks" >"$W/row.json" 2>"$W/row.err"
  elif [ -n "$jwks" ]; then
    LOKI_DIR="$repo/.loki" TARGET_DIR="$repo" bash "$LOKI_BIN" proof verify "$id" \
      --jwks "$jwks" >"$W/row.json" 2>"$W/row.err"
  else
    LOKI_DIR="$repo/.loki" TARGET_DIR="$repo" bash "$LOKI_BIN" proof verify "$id" \
      >"$W/row.json" 2>"$W/row.err"
  fi
  rc=$?
  if [ "$rc" != "$want" ]; then
    bad "$label: harness exit $rc, want $want -- row inconclusive"
    return
  fi
  ok_val="$(_json_field "$W/row.json" ok)"
  verdict="$(_json_field "$W/row.json" verdict)"
  case "$want" in
    0)
      if [ "$ok_val" = "True" ]; then ok "$label: ok=true at exit 0"
      else bad "$label: ok=$ok_val at exit 0, want True"; fi
      ;;
    *)
      if [ "$ok_val" = "False" ]; then ok "$label: ok=false at exit $want (not the stale base-check true)"
      else bad "$label: ok=$ok_val at exit $want, want False -- stdout still contradicts the exit code"; fi
      ;;
  esac
  # verdict is required (never skipped) on every --jwks row: a regression
  # that stopped emitting the field must fail here, not silently pass because
  # there was nothing to compare. 0 must read VERIFIED, 2 must read NOT
  # CHECKED (never an accusation), and 1 must read neither of those two words
  # (it is a real finding, named specifically per row below).
  if [ -n "$jwks" ]; then
    case "$want" in
      0)
        if [ "$verdict" = "VERIFIED" ]; then ok "$label: verdict=VERIFIED at exit 0"
        else bad "$label: verdict=$verdict at exit 0, want VERIFIED"; fi
        ;;
      2)
        if [ "$verdict" = "NOT CHECKED" ]; then ok "$label: verdict='NOT CHECKED' at exit 2"
        else bad "$label: verdict=$verdict at exit 2, want 'NOT CHECKED' -- exit 2 must never accuse"; fi
        ;;
      1)
        if [ "$verdict" != "VERIFIED" ] && [ "$verdict" != "NOT CHECKED" ] && [ "$verdict" != "<absent>" ]; then
          ok "$label: verdict='$verdict' at exit 1 (a real finding, not VERIFIED or NOT CHECKED)"
        else
          bad "$label: verdict=$verdict at exit 1 -- exit 1 must never read as a pass, as unmeasured, or carry no verdict at all"
        fi
        ;;
    esac
  fi
}

_row "VERIFIED"                       "$R"          g1        "$W/gjwks.json"  0
_row "FAILED (wrong key set)"         "$R"          g1        "$W/evil.json"   1
_row "ABSENT (stripped signature)"    "$R"          g1strip   "$W/gjwks.json"  1
_row "NOT CHECKED (missing key set)"  "$R"          g1        "$W/missing.json" 2
_row "malformed key set"              "$R"          g1        "$W/ks-dict.json" 2
_row "drift + NOT CHECKED"            "$W/drifted"  g1        "$W/missing.json" 1
_row "malformed proof.json + --jwks"  "$W"          malformed "$W/gjwks.json"  2
_row "malformed proof.json, no --jwks" "$W"         malformed ""               2
_row "TAMPERED (hash mismatch)"       "$R"          g1tamper  "$W/gjwks.json"  1
# _row's want=1 branch only asserts "not VERIFIED/NOT CHECKED/absent" -- it
# would not catch a base_rc != 0 case being mislabelled FAILED when it should
# be TAMPERED (or the reverse). Pin the exact word here, BEFORE any later
# _row call overwrites $W/row.json: a real hash mismatch is TAMPERED, a wrong
# key set on an otherwise-good receipt is ALSO TAMPERED (attestation failed
# against known-good bytes), and the two must not be confused with each
# other's mechanism.
_tamper_verdict="$(_json_field "$W/row.json" verdict)"
if [ "$_tamper_verdict" = "TAMPERED" ]; then
  ok "TAMPERED (hash mismatch): verdict is exactly TAMPERED, not FAILED -- a real integrity failure must not be downgraded"
else
  bad "TAMPERED (hash mismatch): verdict is '$_tamper_verdict', want exactly TAMPERED"
fi
if [ "$HAVE_BUN" -eq 1 ]; then
  _row "bun entry point: ABSENT (stripped signature)" "$R" g1strip "$W/gjwks.json" 1 bun
fi
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1 --jwks "$W/evil.json" \
  >"$W/wrongkeys_row.json" 2>/dev/null
_wrongkeys_verdict="$(_json_field "$W/wrongkeys_row.json" verdict)"
if [ "$_wrongkeys_verdict" = "TAMPERED" ]; then
  ok "FAILED (wrong key set): verdict is exactly TAMPERED (bad signature against known-good bytes)"
else
  bad "FAILED (wrong key set): verdict is '$_wrongkeys_verdict', want exactly TAMPERED"
fi

# S-08/BACKLOG 39 x S-14/BACKLOG 49 composability: S-08 changed WHICH exit
# code/label an empty keyset or attestation:false produces; S-14 patches
# stdout's ok/verdict to agree with whatever exit code the run actually
# produced. These two rows pin that the composition is not just assumed --
# both of S-08's relabeled cases must ALSO carry a stdout verdict that agrees
# with their (S-08-corrected) exit code, not a stale opinion from either fix
# alone.
_row "empty keyset (BACKLOG 39) reads NOT CHECKED (BACKLOG 49)" "$R" g1 "$W/ks-empty.json" 2
_row "attestation:false (BACKLOG 39) reads ABSENT (BACKLOG 49)" "$R" g1boolfalse "$W/gjwks.json" 1
# _row's want=1 branch only asserts "not VERIFIED/NOT CHECKED/absent" -- it
# would not catch a regression to the PRE-S-08 "bad" (TAMPERED) verdict for
# attestation:false, since TAMPERED also satisfies that same loose check.
# Pin the exact word: $W/row.json still holds the last _row call's output.
_verdict_boolfalse="$(_json_field "$W/row.json" verdict)"
if [ "$_verdict_boolfalse" = "ABSENT" ]; then
  ok "attestation:false verdict is exactly ABSENT, not TAMPERED (pre-S-08 regression guard)"
else
  bad "attestation:false verdict is '$_verdict_boolfalse', want exactly ABSENT -- pre-S-08 'bad'/TAMPERED regression"
fi

# The drift row is the one that would have caught the label bug on its own:
# drift is not tampering, and an earlier draft of this fix (rc==1 with a
# clean attestation treated as always TAMPERED) mislabelled it. Pinned
# directly to the exact word, not only "neither VERIFIED nor NOT CHECKED".
LOKI_DIR="$W/drifted/.loki" TARGET_DIR="$W/drifted" bash "$LOKI_BIN" proof verify g1 \
  --jwks "$W/missing.json" >"$W/drift_row.json" 2>/dev/null
_drift_verdict="$(_json_field "$W/drift_row.json" verdict)"
if [ "$_drift_verdict" = "FAILED" ]; then
  ok "drift + NOT CHECKED: verdict is FAILED, not TAMPERED (drift is not a tamper finding)"
else
  bad "drift + NOT CHECKED: verdict is '$_drift_verdict', want FAILED -- drift was mislabelled or the field is missing"
fi

# --- 14b. S-14 REWORK: drift (base_rc != 0, hash_ok True) + a WRONG-KEY
# attestation (a real signature failure, not merely absent/unreadable) must
# still read TAMPERED. This is the exact combination the 1/2 CONCERN found
# missing: the base_rc != 0 branch used to consult ONLY hash_ok, so a drifted
# tree checked against an unrelated key (attestation: FAILED) read FAILED
# instead of TAMPERED -- the receipt's signature genuinely does not check out,
# which is a tamper finding, not merely "drift, nothing more to say."
LOKI_DIR="$W/drifted/.loki" TARGET_DIR="$W/drifted" bash "$LOKI_BIN" proof verify g1 \
  --jwks "$W/evil.json" >"$W/drift_badkey_row.json" 2>"$W/rc.err"
_drift_badkey_rc=$?
_drift_badkey_verdict="$(_json_field "$W/drift_badkey_row.json" verdict)"
if [ "$_drift_badkey_rc" = 1 ] && grep -q "attestation: FAILED" "$W/rc.err"; then
  if [ "$_drift_badkey_verdict" = "TAMPERED" ]; then
    ok "drift + wrong-key attestation: verdict is TAMPERED, not FAILED -- a real signature failure must not be downgraded just because the tree also drifted"
  else
    bad "drift + wrong-key attestation: verdict is '$_drift_badkey_verdict', want exactly TAMPERED (a genuine bad-signature finding was reported as mere drift)"
  fi
else
  bad "harness: drift + evil.json did not produce the expected exit 1 / attestation: FAILED setup (exit $_drift_badkey_rc); drift+bad-signature case inconclusive"
fi

# --- 14c. Guard against double-counting: hash_ok False AND attestation
# FAILED together (a tampered receipt ALSO checked against the wrong key)
# must still read exactly TAMPERED once, never a different label and never
# a crash from the `or` somehow firing twice.
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1tamper \
  --jwks "$W/evil.json" >"$W/tamper_badkey_row.json" 2>"$W/rc.err"
_tamper_badkey_rc=$?
_tamper_badkey_verdict="$(_json_field "$W/tamper_badkey_row.json" verdict)"
if [ "$_tamper_badkey_rc" = 1 ] && [ "$_tamper_badkey_verdict" = "TAMPERED" ]; then
  ok "hash_ok False AND attestation FAILED together: verdict is exactly TAMPERED (no double-counting)"
else
  bad "hash_ok False AND attestation FAILED together: exit $_tamper_badkey_rc verdict='$_tamper_badkey_verdict', want exit 1 verdict TAMPERED"
fi

# A stdout-only consumer (parses JSON, never looks at $?) reading "ok" must
# now see the correct outcome for the two BACKLOG 49 cases specifically.
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1strip \
  --jwks "$W/gjwks.json" >"$W/absent_final.json" 2>/dev/null
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1 \
  --jwks "$W/missing.json" >"$W/notchecked_final.json" 2>/dev/null
if [ "$(_json_field "$W/absent_final.json" ok)" = "False" ] \
   && [ "$(_json_field "$W/notchecked_final.json" ok)" = "False" ]; then
  ok "a stdout-only consumer reads the correct outcome for ABSENT and NOT CHECKED"
else
  bad "a stdout-only consumer would still misread at least one case as a pass"
fi

# Unflagged output (no --jwks) is untouched: same fields, no "verdict"/
# "attestation" added, matching what the Bun route (proof.ts verifyProof)
# still passes through unmodified.
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1 \
  >"$W/unflagged.json" 2>/dev/null
if [ "$(_json_field "$W/unflagged.json" verdict)" = "<absent>" ] \
   && [ "$(_json_field "$W/unflagged.json" ok)" = "True" ]; then
  ok "unflagged verify (no --jwks) carries no verdict field -- unchanged on both routes"
else
  bad "unflagged verify gained a verdict field or lost ok -- diverges from the Bun route"
fi

# stdout must stay valid JSON (test 7's rule) even after the patch, across
# every row this section produced.
if python3 -c "
import json, glob
for f in ['absent_final.json','notchecked_final.json','unflagged.json','drift_row.json']:
    json.load(open('$W/' + f))
" 2>/dev/null; then
  ok "patched stdout remains valid JSON across every BACKLOG 49 row"
else
  bad "patched stdout is not valid JSON -- machine consumers would break"
fi

# --human's header must agree with the exit code too, the same invariant as
# the JSON verdict field, since --human bypasses the JSON branch entirely.
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1strip --human \
  --jwks "$W/gjwks.json" >"$W/absent_human.txt" 2>/dev/null
_absent_human_header="$(head -1 "$W/absent_human.txt")"
if [ "$_absent_human_header" = "FAILED" ]; then
  ok "--human header reads FAILED (not VERIFIED) for an ABSENT (exit 1) receipt"
else
  bad "--human header is '$_absent_human_header', want FAILED -- a stripped signature would still print VERIFIED to a human reader"
fi
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1 --human \
  --jwks "$W/missing.json" >"$W/notchecked_human.txt" 2>/dev/null
_notchecked_human_header="$(head -1 "$W/notchecked_human.txt")"
if [ "$_notchecked_human_header" = "COULD NOT CHECK" ]; then
  ok "--human header reads COULD NOT CHECK for a NOT CHECKED (exit 2) key set"
else
  bad "--human header is '$_notchecked_human_header', want COULD NOT CHECK"
fi
LOKI_DIR="$R/.loki" TARGET_DIR="$R" bash "$LOKI_BIN" proof verify g1 --human \
  --jwks "$W/gjwks.json" >"$W/verified_human.txt" 2>/dev/null
_verified_human_header="$(head -1 "$W/verified_human.txt")"
if [ "$_verified_human_header" = "VERIFIED" ]; then
  ok "--human header still reads VERIFIED at exit 0"
else
  bad "--human header is '$_verified_human_header', want VERIFIED"
fi

# The remote copy of the check carries the same dependency guard (the two copies
# must not diverge). file:// reaches its "<url>/.well-known/jwks.json" fetch
# with no server.
if command -v jq >/dev/null 2>&1; then
  mkdir -p "$W/srv/.well-known" && cp "$W/gjwks.json" "$W/srv/.well-known/jwks.json"
  sed -n '/^loki_remote_attestation_status() {/,/^}/p' "$LOKI_BIN" >"$W/remote.sh"
  _remote() {
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" TARGET_DIR="$R" bash -c "
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
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" TARGET_DIR="$R" bash -c "
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
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" TARGET_DIR="$R" bash -c "
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

  # --- BACKLOG 39, remote route: an EMPTY key set is NOT CHECKED ------------
  # {"keys": []} is well-shaped (a list of objects, vacuously) so it slipped
  # past the shape guard in loki_remote_attestation_status and fell through to
  # verify_attestation, which found no matching kid and printed "bad" -- the
  # CONSUMER (loki_remote_verify_receipt) then rendered TAMPERED for an
  # inability to check, not evidence against the receipt.
  mkdir -p "$W/srv-empty/.well-known"
  printf '%s' '{"keys": []}' >"$W/srv-empty/.well-known/jwks.json"
  _r_empty="$(_LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" TARGET_DIR="$R" bash -c "
    source '$W/remote.sh'; loki_remote_attestation_status '$R/.loki/proofs/g1/proof.json' 'file://$W/srv-empty'")"
  if [ -z "$_r_empty" ]; then
    ok "remote check: an empty key set yields no verdict (not 'bad')"
  else
    bad "remote check: an empty key set produced '$_r_empty', want '' (NOT CHECKED)"
  fi
  _render_srv() {  # <id> <srv-dir> -> return code; output in $W/render.out
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" TARGET_DIR="$R" bash -c "
      source '$W/remote.sh'; loki_remote_verify_receipt '$R/.loki/proofs/$1/proof.json' 'file://$2'" \
      >"$W/render.out" 2>&1
    echo "$?"
  }
  _rr="$(_render_srv g1 "$W/srv-empty")"
  if grep -q "NOT CHECKED" "$W/render.out" && ! grep -qE "TAMPERED|FAILED" "$W/render.out"; then
    ok "remote render: an empty key set is NOT CHECKED, never TAMPERED (return $_rr)"
  else
    bad "remote render: empty key set returned $_rr ($(head -1 "$W/render.out")), want NOT CHECKED"
  fi

  # --- BACKLOG 39, remote route: attestation: false reads consistently -----
  # jq's `// empty` already treats JSON false as missing, short-circuiting
  # loki_remote_attestation_status to '' before Python runs -- so the render
  # falls through to the same UNSIGNED branch a genuinely absent attestation
  # takes. Measured through the CONSUMER so a future change to either copy is
  # caught here, matching the local route's g1boolfalse case in section 9b.
  _rr="$(_render_srv g1boolfalse "$W/srv")"
  if grep -q "UNSIGNED" "$W/render.out" && ! grep -qE "TAMPERED|FAILED" "$W/render.out"; then
    ok "remote render: attestation: false reads UNSIGNED, never TAMPERED (return $_rr)"
  else
    bad "remote render: attestation: false returned $_rr ($(head -1 "$W/render.out")), want UNSIGNED"
  fi
else
  echo "  SKIP: jq not installed -- remote dependency guard not measured"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
