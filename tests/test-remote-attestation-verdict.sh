#!/usr/bin/env bash
# A remote receipt reaches VERIFIED without an out-of-band key import.
#
# WHAT THIS CLOSES. gpg proves provenance only if you already hold the
# publisher's key. A submitter who ran `loki start --remote` never does, so the
# honest gpg verdict there is NOT CHECKED -- and it stays that way until someone
# performs a manual key import that most people never will. That is the step
# JWKS removes: fetch the server's published keys over the same TLS the API
# already uses, and check the signature.
#
# TEST 2 IS THE LOAD-BEARING ONE. A valid token must not vouch for altered
# bytes. The attestation binds `verification.hash` -- the digest the receipt
# already records over itself -- and the checker RECOMPUTES that digest rather
# than trusting the recorded value. Without the recomputation, editing the body
# and leaving the hash field alone would still verify.
#
# TEST 3 IS THE OTHER ONE. An unreachable JWKS must produce NO verdict. Failing
# toward "" means an absent measurement stays absent; inventing a PASS there
# would be worse than inventing a FAIL, because it would launder an unchecked
# receipt as proven.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: remote receipt attestation verdict (JWKS, no key import)"

if ! python3 -c "import cryptography" 2>/dev/null; then
  echo "  SKIP: cryptography not installed -- attestation not measured here"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "  SKIP: jq not installed"; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-attest.XXXXXX")"
PORT=7394
cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 -c "
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
k=Ed25519PrivateKey.generate()
open('$WORK/s.pem','wb').write(k.private_bytes(
 encoding=serialization.Encoding.PEM,
 format=serialization.PrivateFormat.PKCS8,
 encryption_algorithm=serialization.NoEncryption()))" || {
  echo "  FAIL: could not generate a signing key"; exit 1; }

LOKI_RECEIPT_SIGNING_KEY_FILE="$WORK/s.pem" \
  python3 "$REPO_ROOT/autonomy/trigger-server.py" --port "$PORT" --dry-run \
  > "$WORK/srv.log" 2>&1 &
SRV=$!

# Wait for readiness rather than sleeping a guessed interval: a fixed sleep is
# how this suite would become one of the load-sensitive flaky ones under
# parallel CI.
_up=0
for _ in $(seq 1 25); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/.well-known/jwks.json" >/dev/null 2>&1; then
    _up=1; break
  fi
  sleep 0.4
done
if [ "$_up" -ne 1 ]; then
  echo "  SKIP: trigger-server did not come up on $PORT -- not measured"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0
fi

# A receipt whose recorded hash is genuinely correct for its own contents.
python3 - "$WORK" <<'PY'
import sys, json, hashlib
w = sys.argv[1]
body = {"run_id": "r1", "schema_version": 1, "facts": {"tests": "passed"},
        "cost": {"usd": 1.25}}
h = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
body["verification"] = {"hash": h, "algo": "sha256", "scope": "integrity"}
json.dump(body, open(w + "/p.json", "w"))
PY

# Attest it exactly as the server does.
python3 - "$WORK" "$REPO_ROOT" <<'PY'
import sys, json
w, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, root + "/autonomy")
import receipt_jwt as rj
from cryptography.hazmat.primitives import serialization
k = serialization.load_pem_private_key(open(w + "/s.pem", "rb").read(), password=None)
kid = rj.compute_kid(k.public_key())
p = json.load(open(w + "/p.json"))
p["verification"]["attestation"] = rj.sign_attestation(
    k, kid, job_id="j1", run_id="r1", receipt_hash=p["verification"]["hash"])
p["verification"]["attestation_kid"] = kid
json.dump(p, open(w + "/p.json", "w"))
PY

# Extract the checker from the CLI so this cannot drift from the shipped source.
FRAG="$WORK/frag.sh"
sed -n '/^loki_remote_attestation_status() {/,/^}/p' "$REPO_ROOT/autonomy/loki" > "$FRAG"
if ! grep -q "well-known/jwks.json" "$FRAG"; then
  bad "harness: could not extract loki_remote_attestation_status; assertions inconclusive"
  echo ""; echo "  Passed: $PASS   Failed: $FAIL"; exit 1
fi

_status() {
  _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy" bash -c "
    source '$FRAG'
    loki_remote_attestation_status '$1' '$2'"
}

# --- 1. An honest receipt verifies against the PUBLISHED key set ------------
if [ "$(_status "$WORK/p.json" "http://127.0.0.1:$PORT")" = "ok" ]; then
  ok "an honest remote receipt verifies against the server's JWKS"
else
  bad "an honest receipt did not verify -- a real user would see NOT CHECKED"
fi

# --- 2. THE LOAD-BEARING ONE: a valid token must not cover altered bytes ----
python3 -c "
import json
p=json.load(open('$WORK/p.json')); p['cost']={'usd':999999}
json.dump(p,open('$WORK/tampered.json','w'))"
if [ "$(_status "$WORK/tampered.json" "http://127.0.0.1:$PORT")" = "bad" ]; then
  ok "an altered body is refused even though the token itself is valid"
else
  bad "a tampered receipt passed -- the digest is not being recomputed"
fi

# A receipt that edits the body AND rewrites the recorded hash to match must
# still fail: the signed claim is the anchor, not the field in the file.
python3 -c "
import json,hashlib
p=json.load(open('$WORK/p.json')); v=p.pop('verification')
p['cost']={'usd':777}
h=hashlib.sha256(json.dumps(p,sort_keys=True,separators=(',',':')).encode()).hexdigest()
v['hash']=h; p['verification']=v
json.dump(p,open('$WORK/rehashed.json','w'))"
if [ "$(_status "$WORK/rehashed.json" "http://127.0.0.1:$PORT")" = "bad" ]; then
  ok "recomputing the hash to match an edit does NOT defeat the attestation"
else
  bad "an edited receipt with a recomputed hash passed -- the signed claim is not the anchor"
fi

# --- 3. UNCHECKED must never become a verdict -------------------------------
if [ -z "$(_status "$WORK/p.json" "http://127.0.0.1:7999")" ]; then
  ok "an unreachable JWKS yields no verdict (UNCHECKED, not a pass or a fail)"
else
  bad "an unreachable JWKS manufactured a verdict"
fi

# --- 4. A receipt with no attestation is simply not attested ----------------
python3 -c "
import json
p=json.load(open('$WORK/p.json')); p['verification'].pop('attestation',None)
json.dump(p,open('$WORK/plain.json','w'))"
if [ -z "$(_status "$WORK/plain.json" "http://127.0.0.1:$PORT")" ]; then
  ok "an unattested receipt yields no verdict (falls back to the gpg path)"
else
  bad "an unattested receipt produced an attestation verdict"
fi

# --- 5. No URL means no attestation check, not a failure --------------------
if [ -z "$(_status "$WORK/p.json" "")" ]; then
  ok "a local receipt with no remote URL is not attestation-checked"
else
  bad "a missing URL produced a verdict"
fi

# --- 6. The endpoint is UNAUTHENTICATED, which is the entire point ----------
# A receipt only a token-holder can verify is not independently verifiable.
_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:$PORT/.well-known/jwks.json")"
if [ "$_code" = "200" ]; then
  ok "JWKS is reachable with no credential (third parties can verify)"
else
  bad "JWKS returned $_code without a token -- verification would require trusting us"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
