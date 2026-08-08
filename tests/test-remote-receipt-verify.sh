#!/usr/bin/env bash
# A remote build's Evidence Receipt is verified on the machine that did NOT
# produce it, and the verdict states exactly what was proven.
#
# WHY THIS EXISTS. docs/COMPETITOR-DEPLOYMENT-MODELS.md found no vendor
# documents an output-verification artifact a customer can check themselves.
# A receipt you can only validate by asking the builder whether it is good
# proves nothing, so `loki start --remote` fetches the receipt and re-checks
# it locally before reporting success.
#
# THE LOAD-BEARING PROPERTY IS THE HONESTY OF THE LABEL, not the checking.
# docs/VERIFICATION-COST.md:48 records that the unsigned path is FORGEABLE:
# whoever rewrites the facts and the headline into a mutually consistent lie
# and recomputes the hash passes every check we can run. So an unsigned
# receipt proves INTEGRITY (these bytes are self-consistent) and says nothing
# about PROVENANCE (who produced them). Printing "verified" there would be
# worse than shipping nothing: a user who trusts a label that means nothing
# stops looking for the proof they do not have.
#
# Three outcomes, never collapsed into two:
#   VERIFIED  signature present and valid
#   UNSIGNED  hash matches, no signature -- integrity ONLY
#   TAMPERED  hash mismatch or bad signature -> exit non-zero
#
# And a fourth that must not be folded into UNSIGNED: a signature is present
# but gpg is unavailable here, so nothing about provenance was checked.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/loki"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
VERIFIER="$REPO_ROOT/autonomy/lib/proof-verify.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: remote Evidence Receipt is verified locally, and labelled honestly"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
[ -f "$VERIFIER" ] || { echo "  FAIL: $VERIFIER missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  SKIPPED: python3 not installed (not a pass)"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "  SKIPPED: jq not installed (not a pass)"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- harness ---------------------------------------------------------------
# Source ONLY the two functions under test out of autonomy/loki. The file is a
# ~32k-line CLI that dispatches on argv, so sourcing it whole would run a
# command. Extracting the functions keeps this a unit test of the verdict
# logic. Written to a file and sourced rather than eval'd: our own quality gate
# flags eval as a HIGH finding (see tests/test-verify-runner-selection.sh).
sed -n '/^loki_remote_gpg_status()/,/^}/p' "$SRC" > "$TMP/fn.sh"
sed -n '/^loki_remote_verify_receipt()/,/^}/p' "$SRC" >> "$TMP/fn.sh"
for _f in loki_remote_gpg_status loki_remote_verify_receipt; do
  # A helper that failed to extract would silently return empty and the
  # verdict would fall through to the wrong branch, so assert both landed
  # rather than discovering it as a confusing assertion failure later.
  grep -q "^$_f()" "$TMP/fn.sh" || {
    bad "could not extract $_f from autonomy/loki"
    echo "RESULT: $PASS passed, $FAIL failed"; exit 1
  }
done

# Build a real receipt with a real integrity hash, canonicalized EXACTLY the
# way proof-generator does, so the hash check under test is the genuine one
# rather than a re-implementation that could agree with a broken verifier.
make_proof() {
  # $1 = output path, $2 = optional armored signature to embed
  python3 - "$1" "${2:-}" <<'PY'
import hashlib, json, sys
out, sig = sys.argv[1], sys.argv[2]
proof = {
    "run_id": "run-test-1",
    "facts": {"files_changed": {"count": 2}, "iterations": {"count": 3}},
    "honesty": {"headline": "not_run", "degraded": []},
}
canonical = json.dumps(proof, sort_keys=True, separators=(",", ":")).encode()
proof["verification"] = {
    "hash": hashlib.sha256(canonical).hexdigest(),
    "algo": "sha256",
    "scope": "integrity",
}
if sig:
    proof["verification"]["gpg_signature"] = open(sig).read()
with open(out, "w") as f:
    json.dump(proof, f, indent=2)
PY
}

run_verify() {
  # Runs the extracted function against a proof path. Echoes combined output;
  # returns its exit code.
  (
    RED=''; GREEN=''; YELLOW=''; NC=''
    _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy"
    TARGET_DIR="$TMP/norepo"
    # shellcheck disable=SC1090
    . "$TMP/fn.sh"
    loki_remote_verify_receipt "$1" 2>&1
  )
}

mkdir -p "$TMP/norepo"

# --- 1. UNSIGNED: hash matches, no signature -------------------------------
make_proof "$TMP/unsigned.json"
out="$(run_verify "$TMP/unsigned.json")"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'UNSIGNED'; then
  ok "an unsigned receipt whose hash matches reports UNSIGNED and exits 0"
else
  bad "unsigned receipt did not report UNSIGNED (rc=$rc): $out"
fi

# --- 2. THE HONESTY REQUIREMENT: never the word "verified" when unsigned ----
# Matched case-insensitively on the whole output. This is the assertion that
# separates a useful receipt from a decorative one.
if printf '%s' "$out" | grep -iq 'verified'; then
  bad "an UNSIGNED receipt used the word 'verified' -- the label would be a lie"
else
  ok "an UNSIGNED receipt never uses the word 'verified'"
fi

# --- 3. It says what it does NOT prove --------------------------------------
if printf '%s' "$out" | grep -qi 'forgeable' \
   && printf '%s' "$out" | grep -qi 'provenance'; then
  ok "the UNSIGNED verdict states that provenance is unproven and the path is forgeable"
else
  bad "the UNSIGNED verdict does not disclose its limits: $out"
fi

# --- 4. THE LOAD-BEARING TEST: a tampered receipt exits non-zero ------------
# Edit a FACT and leave the recorded hash alone -- exactly what a forger who
# does not recompute would produce.
python3 - "$TMP/unsigned.json" "$TMP/tampered.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["facts"]["files_changed"]["count"] = 999
json.dump(p, open(sys.argv[2], "w"), indent=2)
PY
out="$(run_verify "$TMP/tampered.json")"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'TAMPERED'; then
  ok "a tampered proof.json is detected and exits non-zero"
else
  bad "TAMPER NOT DETECTED (rc=$rc) -- the receipt is decorative: $out"
fi

# --- 5. The tamper verdict never reads as success --------------------------
if printf '%s' "$out" | grep -qi 'VERIFIED:'; then
  bad "a TAMPERED receipt printed a VERIFIED line"
else
  ok "a TAMPERED receipt never prints a VERIFIED line"
fi

# --- 6/7/8. Signed paths (need a real gpg keyring) -------------------------
GPGOK=0
if command -v gpg >/dev/null 2>&1; then
  export GNUPGHOME="$TMP/gnupg"
  mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
  # --pinentry-mode loopback + an empty passphrase is required: without it gpg
  # 2.x tries to prompt via pinentry and dies with "Inappropriate ioctl for
  # device" under a non-TTY test runner, which would silently skip every
  # signed-path assertion below on CI.
  if gpg --batch --pinentry-mode loopback --passphrase '' \
        --quick-generate-key "loki-receipt-test@example.invalid" \
        default default never >/dev/null 2>&1; then
    GPGOK=1
  fi
fi

if [ "$GPGOK" -ne 1 ]; then
  # Not a pass. A silently-skipped signature test would let the whole signed
  # path rot while the suite stayed green.
  echo "  SKIPPED: gpg unavailable or key generation failed (not a pass)"
  echo "    signed-receipt assertions (VERIFIED, and signature-over-other-content) did not run"
else
  # Sign the canonical bytes the same way proof-generator does: over the proof
  # with `verification` stripped, sort_keys + compact separators.
  sign_canonical() {
    # $1 = proof json to derive canonical bytes from, $2 = signature out path
    python3 - "$1" "$TMP/canon.bin" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p.pop("verification", None)
open(sys.argv[2], "wb").write(
    json.dumps(p, sort_keys=True, separators=(",", ":")).encode())
PY
    gpg --batch --yes --pinentry-mode loopback --passphrase '' --armor \
        --detach-sign --local-user "loki-receipt-test@example.invalid" \
        --output "$2" "$TMP/canon.bin" >/dev/null 2>&1
  }

  # 6. VERIFIED: a signature over THIS receipt's own canonical bytes.
  make_proof "$TMP/base.json"
  sign_canonical "$TMP/base.json" "$TMP/good.asc"
  make_proof "$TMP/signed.json" "$TMP/good.asc"
  out="$(run_verify "$TMP/signed.json")"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'VERIFIED'; then
    ok "a validly signed receipt reports VERIFIED"
  else
    bad "a validly signed receipt did not report VERIFIED (rc=$rc): $out"
  fi

  # 7. THE DISCRIMINATING TEST: a signature over DIFFERENT content is
  # REJECTED. A verifier that merely checks "a signature field exists" would
  # pass test 6 and fail here, which is why 6 alone is not enough.
  python3 - "$TMP/other.json" <<'PY'
import hashlib, json, sys
proof = {"run_id": "run-OTHER", "facts": {"files_changed": {"count": 42}}}
canonical = json.dumps(proof, sort_keys=True, separators=(",", ":")).encode()
proof["verification"] = {"hash": hashlib.sha256(canonical).hexdigest(),
                         "algo": "sha256", "scope": "integrity"}
json.dump(proof, open(sys.argv[1], "w"), indent=2)
PY
  sign_canonical "$TMP/other.json" "$TMP/other.asc"
  # Embed the OTHER receipt's signature into our receipt, and repair the
  # integrity hash so hash_ok passes: the ONLY thing that can reject this is
  # genuine signature verification.
  python3 - "$TMP/base.json" "$TMP/other.asc" "$TMP/wrongsig.json" <<'PY'
import hashlib, json, sys
p = json.load(open(sys.argv[1]))
p.pop("verification", None)
canonical = json.dumps(p, sort_keys=True, separators=(",", ":")).encode()
p["verification"] = {"hash": hashlib.sha256(canonical).hexdigest(),
                     "algo": "sha256", "scope": "integrity",
                     "gpg_signature": open(sys.argv[2]).read()}
json.dump(p, open(sys.argv[3], "w"), indent=2)
PY
  out="$(run_verify "$TMP/wrongsig.json")"; rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'TAMPERED'; then
    ok "a signature over DIFFERENT content is rejected (not merely 'a signature exists')"
  else
    bad "a signature over other content was ACCEPTED (rc=$rc): $out"
  fi

  # 7b. THE ACCUSATION BOUNDARY. gpg RUNS but the signing key is not in the
  # keyring. gpg exits non-zero here exactly as it does for a forged
  # signature, so a verifier reading only the exit code calls this TAMPERED --
  # accusing the publisher of altering a receipt whose content is fine. That is
  # the same class of error as calling an unsigned receipt verified, pointed
  # the other way: it sends a user hunting a forgery that never happened, and
  # trains them to shrug at a real TAMPERED.
  _empty_ring="$TMP/emptyring"
  mkdir -p "$_empty_ring"; chmod 700 "$_empty_ring"
  out="$(GNUPGHOME="$_empty_ring" run_verify "$TMP/signed.json")"; rc=$?
  if printf '%s' "$out" | grep -q 'TAMPERED'; then
    bad "a missing public key was reported as TAMPERED -- a false accusation of forgery"
  elif printf '%s' "$out" | grep -qi 'not checked\|keyring'; then
    ok "a signature that gpg cannot evaluate (no public key) is NOT called TAMPERED"
  else
    bad "unexpected verdict for a signature with no public key (rc=$rc): $out"
  fi

  # 7c. ...and it must not read as VERIFIED either: provenance was not
  # established, so both directions of the false label are closed off.
  if printf '%s' "$out" | grep -q 'VERIFIED'; then
    bad "an unevaluated signature was reported as VERIFIED"
  else
    ok "an unevaluated signature is never reported as VERIFIED"
  fi

  # 8. A signed receipt must never be labelled UNSIGNED.
  out="$(run_verify "$TMP/signed.json")"
  if printf '%s' "$out" | grep -q 'UNSIGNED'; then
    bad "a SIGNED receipt was labelled UNSIGNED"
  else
    ok "a signed receipt is never labelled UNSIGNED"
  fi
fi

# --- 9. gpg_ok='n/a' with a signature present is NOT reported as UNSIGNED ---
# proof-verify.py returns "n/a" for TWO situations: no signature, and gpg
# unavailable on this machine. Collapsing them would call a signed receipt
# UNSIGNED, which is false about the receipt. Simulated by putting a signature
# gpg cannot parse in front of a verifier with no gpg on PATH.
make_proof "$TMP/base2.json"
python3 - "$TMP/base2.json" "$TMP/nogpg.json" <<'PY'
import hashlib, json, sys
p = json.load(open(sys.argv[1]))
p.pop("verification", None)
canonical = json.dumps(p, sort_keys=True, separators=(",", ":")).encode()
p["verification"] = {"hash": hashlib.sha256(canonical).hexdigest(),
                     "algo": "sha256", "scope": "integrity",
                     "gpg_signature": "-----BEGIN PGP SIGNATURE-----\nx\n-----END PGP SIGNATURE-----\n"}
json.dump(p, open(sys.argv[2], "w"), indent=2)
PY
#
# Removing gpg from PATH must actually bite. An earlier form of this test kept
# `dirname $(command -v python3)` on PATH, which on Homebrew is the SAME
# directory as gpg -- so gpg stayed reachable, ran, correctly rejected the
# garbage signature, and the test reported a failure that was really a broken
# premise. Shim python3 into a scrubbed dir instead, so the only thing on PATH
# is the interpreter.
mkdir -p "$TMP/emptybin"
for _t in python3 jq basename grep sed cat; do
  _p="$(command -v "$_t" 2>/dev/null)" || continue
  printf '#!/bin/sh\nexec %s "$@"\n' "$_p" > "$TMP/emptybin/$_t"
  chmod +x "$TMP/emptybin/$_t"
done
if PATH="$TMP/emptybin" command -v gpg >/dev/null 2>&1; then
  bad "test setup: gpg is still reachable, the uncheckable-signature case cannot be exercised"
  out=""; rc=0
else
  out="$(PATH="$TMP/emptybin" run_verify "$TMP/nogpg.json")"; rc=$?
fi
if printf '%s' "$out" | grep -q 'UNSIGNED'; then
  bad "a signed receipt whose signature could not be checked was labelled UNSIGNED"
elif [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'not checked\|NOT VERIFIED'; then
  ok "a signature that could not be checked is reported as unchecked, not UNSIGNED"
else
  bad "unexpected verdict for an uncheckable signature (rc=$rc): $out"
fi

# --- 9b/9c/9d. DRIFT ON A REMOTE RECEIPT IS EXPECTED, NOT TAMPERING --------
# A receipt produced inside a cluster pod is verified against a DIFFERENT tree
# (a laptop checkout). The recorded diff cannot re-derive there, so drift is
# the normal result and says nothing about whether anyone edited the receipt.
# Presenting it as a failure would train users to ignore a signal that means
# something real locally. docs/VERIFICATION-COST.md states the split: hash_ok
# is integrity; `ok` folds in tree_drift and false-alarms exactly here.
#
# Real drift, not a simulated field: a git repo whose tree genuinely differs
# from the base sha the receipt records.
if command -v git >/dev/null 2>&1; then
  _dr="$TMP/driftrepo"
  mkdir -p "$_dr"
  (
    cd "$_dr" || exit 1
    git init -q . && git config user.email t@t.invalid && git config user.name t
    echo one > f.txt && git add f.txt && git commit -qm base
    echo two >> f.txt && git add f.txt && git commit -qm later
  ) >/dev/null 2>&1
  _base="$(git -C "$_dr" rev-parse HEAD~1 2>/dev/null)"

  make_drift_proof() {
    # $1 = out path. Records a base sha and a diff stat that the CURRENT tree
    # cannot reproduce, which is what a pod-produced receipt looks like here.
    python3 - "$1" "$_base" <<'PY'
import hashlib, json, sys
out, base = sys.argv[1], sys.argv[2]
proof = {
    "run_id": "run-remote-1",
    "facts": {"git": {"base_sha": base, "head_sha": base,
                      "diff": {"count": 7, "insertions": 70, "deletions": 7}}},
}
c = json.dumps(proof, sort_keys=True, separators=(",", ":")).encode()
proof["verification"] = {"hash": hashlib.sha256(c).hexdigest(),
                         "algo": "sha256", "scope": "integrity"}
json.dump(proof, open(out, "w"), indent=2)
PY
  }

  run_verify_in_repo() {
    (
      RED=''; GREEN=''; YELLOW=''; NC=''
      _LOKI_SCRIPT_DIR="$REPO_ROOT/autonomy"
      TARGET_DIR="$_dr"
      # shellcheck disable=SC1090
      . "$TMP/fn.sh"
      loki_remote_verify_receipt "$1" 2>&1
    )
  }

  make_drift_proof "$TMP/drift.json"
  # Confirm the fixture actually drifts, or the assertions below are vacuous.
  _dstate="$(python3 "$VERIFIER" "$TMP/drift.json" "$_dr" 2>/dev/null \
             | jq -r '[.hash_ok,(.diff_drift//.tree_drift)]|tostring')"
  if [ "$_dstate" != '["true",true]' ] && [ "$_dstate" != '[true,true]' ]; then
    bad "drift fixture did not produce hash_ok+drift (got $_dstate); assertions would be vacuous"
  else
    out="$(run_verify_in_repo "$TMP/drift.json")"; rc=$?
    # THE ASSERTION: drift alone is neither TAMPERED nor a non-zero exit.
    if printf '%s' "$out" | grep -q 'TAMPERED'; then
      bad "a drifted remote receipt with a MATCHING hash was reported as TAMPERED"
    elif [ "$rc" -ne 0 ]; then
      bad "a drifted remote receipt exited $rc; drift alone must not fail the verdict"
    else
      ok "a remote receipt with drift but a matching hash is not TAMPERED and exits 0"
    fi

    # Reported, not suppressed. A user must be able to tell "no drift" from
    # "drift, expected because this ran remotely" -- dropping a true fact
    # because it is inconvenient is the error this whole verdict layer avoids.
    if printf '%s' "$out" | grep -qi 'drift'; then
      ok "the drift is stated in the output, not silently suppressed"
    else
      bad "drift was suppressed entirely; the user cannot tell it from no-drift"
    fi

    # THE CONTROL. Without this, "ignore drift" could quietly become "ignore
    # everything": same drifted repo, but the recorded hash no longer matches.
    python3 - "$TMP/drift.json" "$TMP/drift-bad.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["facts"]["git"]["diff"]["count"] = 999
json.dump(p, open(sys.argv[2], "w"), indent=2)
PY
    out="$(run_verify_in_repo "$TMP/drift-bad.json")"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'TAMPERED'; then
      ok "a drifted remote receipt with a BAD hash still reports TAMPERED and exits non-zero"
    else
      bad "tamper went undetected on a drifted receipt (rc=$rc): $out"
    fi
  fi
else
  echo "  SKIPPED: git not installed, drift assertions did not run (not a pass)"
fi

# --- 10. The verdict is not gated on the verifier's own exit code ----------
# `ok` in proof-verify.py includes diff_drift, re-derived against the LOCAL
# repo -- which is not the machine that built a remote job. Gating on it would
# report TAMPERED on every honest remote receipt, the false-BLOCK direction
# docs/VERIFICATION-COST.md names as the more damaging one.
_fn="$(cat "$TMP/fn.sh")"
if printf '%s' "$_fn" | grep -q 'hash_ok' && printf '%s' "$_fn" | grep -q 'gpg_ok' \
   && ! printf '%s' "$_fn" | grep -q '\.ok //'; then
  ok "the verdict reads hash_ok and gpg_ok, never the drift-inclusive ok field"
else
  bad "the verdict depends on the verifier's drift-inclusive ok field"
fi

# --- 11. The client fetches the path the server actually serves ------------
if grep -q 'jobs/\$job_id/proof' "$SRC"; then
  ok "the client fetches /jobs/<id>/proof (the served spelling)"
else
  bad "the client fetches a path the trigger-server does not serve"
fi

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
