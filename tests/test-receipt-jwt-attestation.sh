#!/usr/bin/env bash
# A remotely-produced receipt can be verified WITHOUT trusting the server.
#
# WHY THIS EXISTS. Receipts have been gpg-signable for a while, which settles
# the local case: the operator already holds the keyring. It does not survive
# `loki start --remote` -- the submitter never had local access to the cluster,
# so "import our public key out of band" is where independent verification
# actually stops. JWKS closes that one gap: fetch the key set over the TLS the
# client already trusts, check the signature.
#
# TEST 4 IS THE LOAD-BEARING ONE AND IT IS THE REASON THIS WAS DEFERRED.
# Rotation. With a single unlabeled key, the first rotation makes every
# previously-issued receipt fail verification -- and a failed verification is
# indistinguishable from TAMPERED. That collapses two of the four verdicts the
# trust core depends on. A retired key must stay published, and a token must
# name the kid that signed it.
#
# TEST 5 is the other one that must not regress: alg confusion. Accepting
# "alg": "none" would make every assertion above meaningless.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOD="$REPO_ROOT/autonomy/receipt_jwt.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: per-job receipt attestation (signed JWT + public JWKS)"

[ -f "$MOD" ] || { echo "  FAIL: $MOD missing"; exit 1; }

# `cryptography` is a hard requirement for this module. If it is absent the
# suite SKIPS with a named reason rather than passing vacuously -- an absent
# measurement is not evidence of correctness.
if ! python3 -c "import cryptography" 2>/dev/null; then
  echo "  SKIP: cryptography not installed -- attestation not measured here"
  echo ""
  echo "  Passed: 0   Failed: 0 (skipped)"
  exit 0
fi

OUT="$(python3 - "$REPO_ROOT" <<'PY' 2>&1
import sys, json
sys.path.insert(0, sys.argv[1] + "/autonomy")
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import receipt_jwt as rj

def emit(name, cond):
    print(("OK " if cond else "NO ") + name)

k1 = Ed25519PrivateKey.generate()
kid1 = rj.compute_kid(k1.public_key())

# --- 1. A signed token verifies against the PUBLISHED key set --------------
# Verified against JWKS, never against the private key: checking against the
# private key would pass even if JWKS published something else entirely, which
# is precisely the failure a third-party verifier would hit.
jwks1 = rj.build_jwks(private_key=k1)
tok = rj.sign_attestation(k1, kid1, job_id="job-1", run_id="run-1",
                          receipt_hash="abc123", submitter="alice")
good, claims = rj.verify_attestation(tok, jwks1)
emit("a signed receipt verifies against the published JWKS", good)
emit("the JWT binds job id, run id and receipt hash as SIGNED claims",
     good and claims.get("job_id") == "job-1"
     and claims.get("run_id") == "run-1"
     and claims.get("receipt_sha256") == "abc123"
     and claims.get("sub") == "alice")

# --- 2. kid is derived from the key, stable across reloads ------------------
# An operator-assigned kid drifts between environments and silently breaks
# verification of receipts issued before the drift.
same = rj.compute_kid(k1.public_key())
emit("kid is derived from the key and is stable", same == kid1)
emit("the token names the kid that signed it",
     json.loads(rj._b64url_decode(tok.split(".")[0])).get("kid") == kid1)

# --- 3. TAMPER: a modified receipt hash must NOT verify ---------------------
# The whole point of the receipt. Rebuild the payload with a different hash and
# re-attach the original signature.
h, p, s = tok.split(".")
bad_payload = dict(claims); bad_payload["receipt_sha256"] = "deadbeef"
forged = h + "." + rj._b64url(json.dumps(bad_payload, separators=(",",":"), sort_keys=True).encode()) + "." + s
tampered_ok, _ = rj.verify_attestation(forged, jwks1)
emit("a tampered receipt hash does NOT verify", not tampered_ok)

# --- 4. ROTATION (the deferred-until-now requirement) ----------------------
k2 = Ed25519PrivateKey.generate()
kid2 = rj.compute_kid(k2.public_key())
# After rotating, the OLD PUBLIC key stays published.
rotated = rj.build_jwks(private_key=k2, retired_public_keys=[k1.public_key()])
old_still, _ = rj.verify_attestation(tok, rotated)
emit("a receipt signed BEFORE rotation still verifies after it", old_still)

new_tok = rj.sign_attestation(k2, kid2, job_id="job-2", run_id="run-2",
                              receipt_hash="xyz789")
new_ok, _ = rj.verify_attestation(new_tok, rotated)
emit("a receipt signed with the NEW key verifies", new_ok)
emit("JWKS publishes both the active and the retired key",
     len(rotated["keys"]) == 2)
emit("the active key is listed first", rotated["keys"][0]["kid"] == kid2)

# A key that was never published must NOT verify -- otherwise "rotation" would
# just mean "accept anything".
k3 = Ed25519PrivateKey.generate()
rogue = rj.sign_attestation(k3, rj.compute_kid(k3.public_key()),
                            job_id="j", run_id="r", receipt_hash="h")
rogue_ok, reason = rj.verify_attestation(rogue, rotated)
emit("a token from an UNPUBLISHED key is refused", not rogue_ok)
emit("the refusal names the unknown kid rather than a generic error",
     (not rogue_ok) and "kid" in str(reason))

# Duplicate kid must not be published twice: an ambiguous key set makes
# selection order-dependent for a verifier that stops at the first match.
dup = rj.build_jwks(private_key=k1, retired_public_keys=[k1.public_key()])
emit("listing the active key as retired does not duplicate it",
     len(dup["keys"]) == 1)

# --- 5. ALG CONFUSION -------------------------------------------------------
# HONEST NOTE ON WHAT THESE TWO ASSERTIONS PROVE. Mutation-testing this pair
# showed that deleting the `alg` check does NOT turn them red, and the reason
# is worth recording rather than hiding: the header is part of the JWT signing
# input, so swapping `alg` invalidates the Ed25519 signature by itself.
# verify_attestation hardcodes Ed25519 instead of selecting an algorithm from
# the header, which is what makes it structurally immune to the classic
# confusion attack -- the vulnerable shape is a verifier that trusts the header
# to choose the algorithm, and this one never asks.
#
# So the explicit `alg` check is defense-in-depth, not the load-bearing
# control, and these assertions pin the OBSERVABLE behaviour (both shapes are
# refused) rather than a mutation-proof that cannot exist here. They would
# still catch a future refactor that introduced header-driven algorithm
# selection, which is the regression actually worth guarding.
none_hdr = rj._b64url(json.dumps({"alg":"none","typ":"JWT","kid":kid1},
                                 separators=(",",":"), sort_keys=True).encode())
none_ok, _ = rj.verify_attestation(none_hdr + "." + p + ".", jwks1)
emit("alg=none with a stripped signature is refused", not none_ok)

# Algorithm SUBSTITUTION: a valid Ed25519 signature relabelled as HS256. The
# bytes verify; only the alg check stands between this and acceptance.
hs_hdr = rj._b64url(json.dumps({"alg":"HS256","typ":"JWT","kid":kid1},
                               separators=(",",":"), sort_keys=True).encode())
sub_ok, _ = rj.verify_attestation(hs_hdr + "." + p + "." + s, jwks1)
emit("a token relabelled to a different alg is refused", not sub_ok)

# --- 6. UNCONFIGURED means UNSIGNED, never silently-signed ------------------
# Absence of a key is the DEFAULT, not an error. What must never happen is an
# unsigned receipt being presented as attested.
emit("no key configured yields an empty token (receipt stays UNSIGNED)",
     rj.sign_attestation(None, "", job_id="j", run_id="r", receipt_hash="h") == "")
emit("an empty JWKS verifies nothing", not rj.verify_attestation(tok, {"keys": []})[0])
emit("a malformed token is refused", not rj.verify_attestation("not.a.jwt", jwks1)[0])
PY
)"

echo "$OUT" | while IFS= read -r line; do
  case "$line" in
    "OK "*) echo "  PASS: ${line#OK }" ;;
    "NO "*) echo "  FAIL: ${line#NO }" ;;
    *) [ -n "$line" ] && echo "  note: $line" ;;
  esac
done

# Counted outside the pipe: a `while` in a pipeline runs in a subshell and its
# counter increments would be discarded, reporting 0/0 no matter what happened.
PASS="$(printf '%s\n' "$OUT" | grep -c '^OK ')"
FAIL="$(printf '%s\n' "$OUT" | grep -c '^NO ')"

# Guard against a vacuous run: a python traceback produces neither OK nor NO,
# and 0/0 would otherwise read as success.
if [ "$((PASS + FAIL))" -lt 17 ]; then
  echo "  FAIL: harness produced $((PASS + FAIL)) assertions, expected 17 -- python likely errored"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
