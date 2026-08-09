#!/usr/bin/env bash
# A LOCAL build's receipt can carry provenance too, not just a cluster-served one.
#
# THE GAP THIS CLOSES. Attestation shipped on the remote path first: the
# receiver signs a receipt as it serves it. That left every `loki start` receipt
# on a laptop or in CI with provenance only if the user had configured gpg --
# and gpg proves provenance only to a verifier who already imported the public
# key, which a customer, auditor or downstream CI system handed a proof.json
# generally has not.
#
# TEST 2 IS THE LOAD-BEARING ONE. Attaching the attestation must not change the
# receipt's own integrity hash. The token is written INSIDE `verification`,
# which the hash excludes; anywhere else and every honest receipt would read as
# TAMPERED the moment it was signed -- the change would actively destroy the
# thing it was meant to strengthen.
#
# TEST 4 IS THE OTHER ONE. A signing failure must never cost the user their
# receipt. An unattested receipt is a valid state with an existing verdict; a
# lost receipt is not recoverable.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a locally-generated receipt can carry an attestation"

[ -f "$GEN" ] || { echo "  FAIL: $GEN missing"; exit 1; }
if ! python3 -c "import cryptography" 2>/dev/null; then
  echo "  SKIP: cryptography not installed -- attestation not measured here"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-localatt.XXXXXX")"
trap 'rm -rf "$W" 2>/dev/null || true' EXIT INT TERM

python3 - "$W" "$REPO_ROOT" <<'PY' || { echo "  FAIL: key setup failed"; exit 1; }
import sys, json
w, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, root + "/autonomy")
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
import receipt_jwt as rj
k = Ed25519PrivateKey.generate()
open(w + "/s.pem", "wb").write(k.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption()))
json.dump(rj.build_jwks(private_key=k), open(w + "/jwks.json", "w"))
PY

_find() { find "$1" -name proof.json 2>/dev/null | head -1; }

# --- 1. Configured: the receipt carries an attestation ----------------------
LOKI_RECEIPT_SIGNING_KEY_FILE="$W/s.pem" python3 "$GEN" --out-dir "$W/att" >/dev/null 2>&1
P="$(_find "$W/att")"
if [ -n "$P" ] && python3 -c "
import json,sys; v=json.load(open('$P')).get('verification',{})
sys.exit(0 if v.get('attestation') and v.get('attestation_kid') else 1)" 2>/dev/null; then
  ok "a locally-generated receipt carries an attestation and its kid"
else
  bad "no attestation on a local receipt -- provenance still needs gpg"
fi

# --- 2. THE LOAD-BEARING ONE: the integrity hash must survive ---------------
if [ -n "$P" ] && python3 - "$P" <<'PY' 2>/dev/null
import sys, json, hashlib
d = json.load(open(sys.argv[1]))
recorded = (d.get("verification") or {}).get("hash")
c = dict(d); c.pop("verification", None)
recomputed = hashlib.sha256(
    json.dumps(c, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
sys.exit(0 if recorded == recomputed else 1)
PY
then
  ok "attaching the attestation does not break the receipt's own hash"
else
  bad "the integrity hash no longer matches -- every honest receipt would read TAMPERED"
fi

# --- 3. It verifies against the PUBLISHED key set, binding the same digest --
# Checked against JWKS, never the private key: verifying against the private key
# would pass even if the published set were wrong, which is the exact failure a
# third-party verifier would hit.
if [ -n "$P" ] && python3 - "$P" "$W" "$REPO_ROOT" <<'PY' 2>/dev/null
import sys, json, hashlib
sys.path.insert(0, sys.argv[3] + "/autonomy")
import receipt_jwt as rj
d = json.load(open(sys.argv[1]))
tok = (d.get("verification") or {}).get("attestation") or ""
ok, claims = rj.verify_attestation(tok, json.load(open(sys.argv[2] + "/jwks.json")))
c = dict(d); c.pop("verification", None)
digest = hashlib.sha256(
    json.dumps(c, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
sys.exit(0 if ok and claims.get("receipt_sha256") == digest else 1)
PY
then
  ok "the attestation verifies against JWKS and binds the recomputed digest"
else
  bad "the local attestation does not verify against the published key set"
fi

# --- 4. A signing failure must not cost the user the receipt ---------------
LOKI_RECEIPT_SIGNING_KEY_FILE="$W/absent.pem" python3 "$GEN" --out-dir "$W/broken" >/dev/null 2>&1
B="$(_find "$W/broken")"
if [ -n "$B" ]; then
  if python3 -c "
import json,sys; v=json.load(open('$B')).get('verification',{})
sys.exit(0 if 'attestation' not in v and v.get('hash') else 1)" 2>/dev/null; then
    ok "an unreadable key yields a valid UNATTESTED receipt, not a lost one"
  else
    bad "a broken key produced a fake attestation or a hashless receipt"
  fi
else
  bad "a signing failure destroyed the receipt -- strictly worse than not signing"
fi

# --- 5. DEFAULT OFF: unconfigured receipts are unchanged -------------------
# The whole feature must be invisible to a user who did not opt in.
python3 "$GEN" --out-dir "$W/plain" >/dev/null 2>&1
N="$(_find "$W/plain")"
if [ -n "$N" ] && python3 -c "
import json,sys; v=json.load(open('$N')).get('verification',{})
sys.exit(0 if 'attestation' not in v and 'attestation_kid' not in v else 1)" 2>/dev/null; then
  ok "an unconfigured build emits no attestation fields (default off)"
else
  bad "an attestation appeared without the user opting in"
fi

# --- 6. The verify surface accepts it ---------------------------------------
# A receipt nobody can check is not provenance. Confirms the local receipt is
# checkable by the SAME third-party path a cluster receipt uses.
if [ -n "$P" ]; then
  _frag="$W/frag.sh"
  sed -n '/^loki_proof_attestation_check() {/,/^}/p' "$REPO_ROOT/autonomy/loki" > "$_frag"
  if grep -q "well-known/jwks.json" "$_frag"; then
    _r="$(_LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" bash -c "
      source '$_frag'; loki_proof_attestation_check '$P' '$W/jwks.json'")"
    if [ "$_r" = "ok" ]; then
      ok "the shipped verify path accepts a locally-attested receipt"
    else
      bad "the verify path returned '$_r' for a valid local attestation"
    fi
  else
    bad "harness: could not extract the checker; assertion inconclusive"
  fi
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
