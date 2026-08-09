"""Per-job receipt attestation: a signed JWT plus a public JWKS.

WHY THIS EXISTS, given receipts are ALREADY gpg-signable.

`LOKI_PROOF_GPG_KEY` proves a receipt was produced by a holder of that gpg key,
and for a LOCAL build that is the whole story: the operator already has the
keyring. It does not survive the remote path. A submitter who ran
`loki start --remote https://loki.corp` never had local access to the cluster,
so "fetch our public key out of band and import it into gpg" is the step where
independent verification actually stops happening.

JWKS closes exactly that gap and nothing else: the verifier fetches
`/.well-known/jwks.json` over the same TLS connection it already trusts for the
API, and checks the signature with a stdlib-shaped algorithm. The receipt gains
per-job identity binding gpg never carried -- job id, submitter and issue time
as SIGNED claims, not prose in the body.

TWO DESIGN CONSTRAINTS, both decided by code that already exists rather than by
preference.

1. THE RECEIVER SIGNS. NEVER THE WORKER. The worker executes model-directed
   code and already holds ANTHROPIC_API_KEY and GITHUB_TOKEN
   (helm/loki-mode/templates/worker-deployment.yaml). A signing key there would
   let a build sign its own receipt, and a self-attested receipt attests to
   nothing. The private key lives only in the receiver Deployment, matching the
   rule stated at the top of templates/secret.yaml.

2. `kid` AND A MULTI-KEY JWKS FROM DAY ONE. This is the half-built failure the
   whole item was deferred over. With a single unlabeled key, the first rotation
   makes every previously-issued receipt fail verification -- and a receipt that
   fails verification is INDISTINGUISHABLE from a tampered one. That collapses
   TAMPERED into UNCHECKED and destroys the four-verdict separation the trust
   core is built on. So JWKS serves current AND retired keys, and every token
   carries the `kid` that signed it.

Ed25519 (EdDSA), not RSA: fixed-size keys, no parameter choices to get wrong,
and `cryptography` is already a dependency. Signing is OPTIONAL and fail-open
in the sense that matters -- no key configured means no `attestation` field and
the receipt keeps its existing UNSIGNED verdict. It never means an unsigned
receipt is presented as signed.
"""

import base64
import json
import logging
import os
from pathlib import Path

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
    _CRYPTO_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only on a stripped install
    _CRYPTO_AVAILABLE = False


def _b64url(data: bytes) -> str:
    """base64url WITHOUT padding, per RFC 7515 section 2."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    """Inverse of _b64url, restoring the stripped padding."""
    pad = 4 - len(data) % 4
    if pad != 4:
        data += "=" * pad
    return base64.urlsafe_b64decode(data)


def compute_kid(public_key: "Ed25519PublicKey") -> str:
    """Stable key id: the RFC 7638 JWK thumbprint of the public key.

    Derived from the key itself rather than assigned by an operator, so the
    same key always yields the same kid across restarts and redeploys. An
    operator-chosen kid drifts between environments and silently breaks
    verification of receipts issued before the drift.
    """
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    # Members REQUIRED by RFC 7638 for OKP, lexicographic, no whitespace.
    canonical = json.dumps(
        {"crv": "Ed25519", "kty": "OKP", "x": _b64url(raw)},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    import hashlib

    return _b64url(hashlib.sha256(canonical).digest())


def _load_private_key(pem_bytes: bytes):
    """Load an unencrypted Ed25519 private key from PEM, or None.

    An encrypted key is rejected rather than prompted for: the receiver starts
    unattended in a pod and a passphrase prompt would hang startup rather than
    fail it, which is the worse of the two outcomes.
    """
    try:
        key = serialization.load_pem_private_key(pem_bytes, password=None)
    except (ValueError, TypeError) as e:
        logging.error("receipt signing: private key could not be loaded: %s", e)
        return None
    if not isinstance(key, Ed25519PrivateKey):
        logging.error(
            "receipt signing: key is %s, expected Ed25519 -- refusing to sign",
            type(key).__name__,
        )
        return None
    return key


def load_signing_key():
    """Return (private_key, kid) from env or a mounted file, or (None, "").

    Mirrors load_api_token's precedence deliberately: LOKI_RECEIPT_SIGNING_KEY
    then LOKI_RECEIPT_SIGNING_KEY_FILE, the normal Kubernetes mounted-secret
    path. Absence is NOT an error -- it is the default, and it means receipts
    stay UNSIGNED exactly as they were before this module existed.
    """
    if not _CRYPTO_AVAILABLE:
        return None, ""
    pem = os.environ.get("LOKI_RECEIPT_SIGNING_KEY", "").strip()
    if pem:
        key = _load_private_key(pem.encode("utf-8"))
    else:
        key_file = os.environ.get("LOKI_RECEIPT_SIGNING_KEY_FILE", "").strip()
        if not key_file:
            return None, ""
        try:
            key = _load_private_key(Path(key_file).read_bytes())
        except OSError as e:
            logging.error(
                "receipt signing: cannot read LOKI_RECEIPT_SIGNING_KEY_FILE %s: %s",
                key_file, e,
            )
            return None, ""
    if key is None:
        return None, ""
    return key, compute_kid(key.public_key())


def load_retired_public_keys():
    """Public keys that must stay in JWKS so OLD receipts still verify.

    THIS IS THE ROTATION STORY, and it is why the item was deferred until now.
    LOKI_RECEIPT_RETIRED_PUBKEYS is a colon-separated list of PEM file paths.
    After rotating, the operator moves the previous PUBLIC key here; receipts
    it signed keep verifying, while nothing new is signed with it. Without this
    a rotation would make every historical receipt read as unverifiable, which
    a checker cannot distinguish from tampering.

    A path that cannot be read is logged and skipped rather than fatal: one bad
    path must not take down the whole endpoint and with it verification of
    every OTHER key.
    """
    if not _CRYPTO_AVAILABLE:
        return []
    raw = os.environ.get("LOKI_RECEIPT_RETIRED_PUBKEYS", "").strip()
    if not raw:
        return []
    out = []
    for path in raw.split(":"):
        path = path.strip()
        if not path:
            continue
        try:
            pub = serialization.load_pem_public_key(Path(path).read_bytes())
        except (OSError, ValueError, TypeError) as e:
            logging.error("receipt signing: skipping retired key %s: %s", path, e)
            continue
        if not isinstance(pub, Ed25519PublicKey):
            logging.error("receipt signing: retired key %s is not Ed25519", path)
            continue
        out.append(pub)
    return out


def public_jwk(public_key: "Ed25519PublicKey", kid: str = "") -> dict:
    """One JWKS entry. `use`/`alg` are set so a verifier need not infer them."""
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": _b64url(raw),
        "use": "sig",
        "alg": "EdDSA",
        "kid": kid or compute_kid(public_key),
    }


def build_jwks(private_key=None, retired_public_keys=None) -> dict:
    """The full public key set: the active key first, then retired ones.

    Deduplicated by kid so listing a retired key that is still active does not
    publish it twice -- a duplicate kid makes key selection ambiguous for a
    verifier that stops at the first match.
    """
    keys, seen = [], set()
    if private_key is not None:
        jwk = public_jwk(private_key.public_key())
        keys.append(jwk)
        seen.add(jwk["kid"])
    for pub in retired_public_keys or []:
        jwk = public_jwk(pub)
        if jwk["kid"] in seen:
            continue
        keys.append(jwk)
        seen.add(jwk["kid"])
    return {"keys": keys}


def sign_attestation(private_key, kid, *, job_id, run_id, receipt_hash,
                     submitter="", issued_at=None, issuer=""):
    """Return a compact JWT binding a receipt hash to a job identity.

    The signed claims are what gpg could never carry: WHICH job produced this
    receipt, WHO submitted it, and WHEN. `receipt_hash` is the integrity hash
    the receipt already computes over itself with `verification` stripped, so
    the JWT attests to the same bytes a checker independently recomputes --
    signing a different digest would let the two disagree while both look
    valid.

    Returns "" when signing is not configured. The caller must treat that as
    UNSIGNED and must not present the receipt as attested.
    """
    if private_key is None or not kid:
        return ""
    if issued_at is None:
        import time
        issued_at = int(time.time())
    header = {"alg": "EdDSA", "typ": "JWT", "kid": kid}
    payload = {
        "job_id": job_id,
        "run_id": run_id,
        "receipt_sha256": receipt_hash,
        "iat": issued_at,
    }
    # Optional claims are omitted rather than emitted empty: a present-but-blank
    # `sub` reads as "an anonymous submitter was recorded" instead of "no
    # submitter identity was available".
    if submitter:
        payload["sub"] = submitter
    if issuer:
        payload["iss"] = issuer
    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":"), sort_keys=True).encode())
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    )
    try:
        sig = private_key.sign(signing_input.encode("ascii"))
    except Exception as e:  # pragma: no cover - key validated at load
        logging.error("receipt signing: sign failed: %s", e)
        return ""
    return signing_input + "." + _b64url(sig)


def verify_attestation(token: str, jwks: dict):
    """Verify a compact JWT against a JWKS. Returns (ok, claims_or_reason).

    Present so the CLI and tests check tokens the same way a third party would,
    against the published key set only -- never against the private key, which
    would pass even if JWKS published the wrong thing.

    Selection is by `kid`. A token whose kid is absent from the set is REFUSED
    rather than tried against every key: trying all of them would make a
    rotated-away receipt indistinguishable from one signed by an unpublished
    key.
    """
    if not _CRYPTO_AVAILABLE:
        return False, "cryptography is not installed"
    parts = token.split(".")
    if len(parts) != 3:
        return False, "malformed token"
    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
        sig = _b64url_decode(parts[2])
    except (ValueError, json.JSONDecodeError):
        return False, "malformed token"
    if header.get("alg") != "EdDSA":
        # Refusing an unexpected alg is what blocks the classic "alg: none" and
        # algorithm-substitution attacks.
        return False, "unexpected alg: %s" % header.get("alg")
    kid = header.get("kid", "")
    if not kid:
        return False, "token carries no kid"
    match = None
    for jwk in jwks.get("keys", []):
        if jwk.get("kid") == kid:
            match = jwk
            break
    if match is None:
        return False, "no published key with kid %s" % kid
    try:
        pub = Ed25519PublicKey.from_public_bytes(_b64url_decode(match["x"]))
        pub.verify(sig, (parts[0] + "." + parts[1]).encode("ascii"))
    except Exception:
        return False, "signature does not verify"
    return True, payload
