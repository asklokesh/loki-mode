#!/usr/bin/env bash
# Receipt verdicts on the shipped demo receipt, through the real CLI:
#   VERIFIED (rc 0), TAMPERED when one hash digit changes (rc 1), TAMPERED when
#   events.jsonl changes, UNSIGNED when the attestation is stripped, UNCHECKED when
#   the key is absent. Then the JWKS attestation module (autonomy/receipt_jwt.py):
#   sign then verify against the published key set, a changed receipt hash must
#   fail, and alg "none" must be refused (skipped, reported, if `cryptography`
#   is not installed).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. autonomy/receipt_jwt.py: make verify_attestation return (True, claims)
#      before the signature check; the JWKS cases must fail.
#   2. loki-ts/dist/loki.js: replace every `verdict:"TAMPERED"` with
#      `verdict:"VERIFIED"` (a verifier that never says TAMPERED); the
#      flipped-digit and appended-event cases must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need python3
cd "$ROOT" || exit 2

echo "TEST: receipt sign / verify round trip"

export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
FX="$ROOT/skills/fixtures/demo-receipt"
W="$T/r"
mkdir -p "$W"
cp "$FX/receipt.json" "$FX/events.jsonl" "$FX/pubkey.jwk" "$W/"

verdict() { # verdict <receipt> [extra args] -> prints "<rc> <verdict line>"
    local out rc
    out="$(bash "$ROOT/bin/loki" verify "$@" 2>&1)"; rc=$?
    printf '%s %s\n' "$rc" "$(printf '%s\n' "$out" | sed -n 's/^verdict: //p' | head -1)"
}

r="$(verdict --pubkey "$W/pubkey.jwk" "$W/receipt.json")"
[ "$r" = "0 VERIFIED" ] && ok "untouched receipt: VERIFIED rc 0" || bad "untouched receipt gave: $r"

r="$(verdict "$W/receipt.json")"
[ "$r" = "2 UNCHECKED" ] && ok "no key available: UNCHECKED rc 2 (never VERIFIED)" || bad "keyless verify gave: $r"

python3 -I - "$W" <<'PY'
import json, sys
w = sys.argv[1]
raw = open(w + "/receipt.json").read()
d = json.loads(raw)
h = d["diff_sha256"]
last = "0" if h[-1] != "0" else "1"
open(w + "/flipped.json", "w").write(raw.replace(h, h[:-1] + last, 1))
d["verification"] = {"jwt": None, "kid": None}
json.dump(d, open(w + "/unsigned.json", "w"), indent=2)
PY
cp "$W/events.jsonl" "$W/events.orig"

r="$(verdict --pubkey "$W/pubkey.jwk" "$W/flipped.json")"
[ "$r" = "1 TAMPERED" ] && ok "one changed hash digit: TAMPERED rc 1" || bad "flipped receipt gave: $r"

# unsigned and events edits are judged next to events.jsonl, so give each its own dir
mkdir -p "$W/u" "$W/e"
cp "$W/unsigned.json" "$W/u/receipt.json"; cp "$W/events.orig" "$W/u/events.jsonl"
r="$(verdict --pubkey "$W/pubkey.jwk" "$W/u/receipt.json")"
[ "$r" = "3 UNSIGNED" ] && ok "stripped attestation: UNSIGNED rc 3 (never VERIFIED)" || bad "unsigned receipt gave: $r"

cp "$W/receipt.json" "$W/e/receipt.json"
{ cat "$W/events.orig"; echo '{"v":1,"type":"forged"}'; } > "$W/e/events.jsonl"
r="$(verdict --pubkey "$W/pubkey.jwk" "$W/e/receipt.json")"
[ "$r" = "1 TAMPERED" ] && ok "appended event: TAMPERED rc 1" || bad "edited events gave: $r"

if python3 -c "import cryptography" 2>/dev/null; then
    out="$(python3 -I - "$ROOT/autonomy" <<'PY' 2>&1
import sys, json, base64
sys.path.insert(0, sys.argv[1])
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import receipt_jwt as rj

def emit(name, cond):
    print(("OK " if cond else "NO ") + name)

k = Ed25519PrivateKey.generate()
kid = rj.compute_kid(k.public_key())
jwks = rj.build_jwks(private_key=k)
tok = rj.sign_attestation(k, kid, job_id="j", run_id="r", receipt_hash="abc", submitter="a")
good, claims = rj.verify_attestation(tok, jwks)
emit("signed token verifies against published JWKS", good and claims.get("receipt_sha256") == "abc")

h, p, s = tok.split(".")
claims_d = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
claims_d["receipt_sha256"] = "def"
p2 = base64.urlsafe_b64encode(json.dumps(claims_d).encode()).rstrip(b"=").decode()
bad_ok, _ = rj.verify_attestation(".".join([h, p2, s]), jwks)
emit("changed receipt hash does not verify", not bad_ok)

hn = base64.urlsafe_b64encode(json.dumps({"alg": "none", "kid": kid, "typ": "JWT"}).encode()).rstrip(b"=").decode()
none_ok, _ = rj.verify_attestation(hn + "." + p + ".", jwks)
emit("alg none is refused", not none_ok)
PY
)"
    for want in "signed token verifies against published JWKS" "changed receipt hash does not verify" "alg none is refused"; do
        case "$out" in *"OK $want"*) ok "jwks: $want" ;; *) bad "jwks: $want ($out)" ;; esac
    done
else
    echo "  SKIP: cryptography not installed, JWKS attestation not measured here"
fi

finish
