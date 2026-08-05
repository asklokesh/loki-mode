#!/usr/bin/env python3
"""Turn a receipt into a portable ATTESTATION a third party can check.

WHY THIS EXISTS. `loki proof verify` answers "is this receipt good, here, in
this workspace". That answer is not portable: it needs the original repository.
The commercial position is being the NOTARY for the category -- verifying
receipts, including ones this machine did not produce. A notary that needs the
original workspace is not a notary.

So this emits a compact record of WHAT WAS ACTUALLY CHECKED, and by
construction it cannot claim more than that.

THE DEFECT THIS PREVENTS. Three states exist and most systems ship two:

    VERIFIED      checked, passed
    FAILED        checked, failed
    UNVERIFIABLE  could not be checked here, with the reason

Collapsing the third into either of the first two is the whole defect. Folded
into FAILED, an honest receipt looks forged whenever you read it from the wrong
directory. Folded into VERIFIED -- the dangerous direction -- an unchecked axis
acquires a credential it never earned. That is not a missing feature; it is
laundering uncertainty into a signed-looking claim, which is strictly worse
than issuing no attestation at all.

Nothing here re-implements verification. `verify()` in autonomy/lib/
proof-verify.py is the single source of truth (it calls verify_integrity()
internally at line 726 and spreads its fields), and this module's only job is
to project that result onto the three states without losing the third.

Usage:
    tools/receipt-attest.py <proof.json> [--json]

Exit codes:
    0  every scored axis was checked here and passed
    1  at least one axis FAILED
    2  nothing failed, but at least one axis was UNVERIFIABLE -- including a
       receipt that could not be loaded at all

An UNSIGNED receipt does not by itself sink the verdict (see _signature_axis:
there is nothing to check, and verify() makes the same call upstream), but the
caveat is carried on the summary line of every verdict so an exit 0 can never
be mistaken for proof of origin.
"""

import hashlib
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE failures (the probe edits the source, the loader serves the old
# bytecode). Must be set before the loader below runs.
sys.dont_write_bytecode = True

_LIB = pathlib.Path(__file__).resolve().parents[1] / "autonomy" / "lib"
_spec = importlib.util.spec_from_file_location(
    "proof_verify", _LIB / "proof-verify.py")
_pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pv)

VERIFIED = "VERIFIED"
FAILED = "FAILED"
UNVERIFIABLE = "UNVERIFIABLE"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_UNVERIFIABLE = 2


def _tri(value, reason_if_unverifiable):
    """Project a three-valued verifier field onto the three states.

    True -> VERIFIED, False -> FAILED, None -> UNVERIFIABLE. `is` comparisons
    are load-bearing: the verifier also uses the truthy string "n/a", and `if
    value:` would read that as a pass.
    """
    if value is True:
        return {"state": VERIFIED, "reason": ""}
    if value is False:
        return {"state": FAILED, "reason": ""}
    return {"state": UNVERIFIABLE, "reason": reason_if_unverifiable}


def _pick(reasons, *needles):
    """First verifier reason mentioning any needle, so an UNVERIFIABLE axis
    carries the verifier's own explanation rather than a generic one."""
    for reason in reasons or []:
        low = reason.lower()
        if any(n in low for n in needles):
            return reason
    return ""


def _signature_axis(proof, gpg_ok):
    """Signature status as three states, never a boolean.

    THE TRAP. _verify_gpg (proof-verify.py:477) returns "n/a" for TWO
    different situations: no signature recorded, AND a signature recorded
    while gpg is absent from PATH. Reading gpg_ok alone therefore reports a
    signed receipt as "unsigned" on any machine without gpg -- the exact
    collapse this file exists to prevent, one layer down. So presence of the
    signature is read from the receipt itself, and only the no-signature case
    is allowed to mean unsigned.

    WHY UNSIGNED DOES NOT SINK THE VERDICT. "No signature exists" is not "a
    check I could not run" -- there is nothing to verify, so scoring it as
    UNVERIFIABLE would make VERIFIED unreachable for every receipt produced
    without LOKI_PROOF_GPG_KEY, which is the default. verify() already made
    this call upstream: its rollup is `gpg_ok in (True, "n/a")`, and it
    surfaces the caveat as generator_trusted rather than as a failure. This
    projects that decision instead of inventing a stricter one.

    signed_uncheckable is the opposite case and IS scored: a signature is
    recorded and we genuinely could not evaluate it. Keeping those two apart
    is the whole point of reading the receipt rather than gpg_ok alone.
    """
    verification = proof.get("verification")
    signature = (verification or {}).get("gpg_signature") if isinstance(
        verification, dict) else None

    if not signature:
        # Stated, never scored. scored=False keeps this out of the verdict
        # rollup while the caveat still rides along in the summary line, so an
        # exit 0 on an unsigned receipt can never be read as "origin proven".
        return {
            "state": "UNSIGNED",
            "status": "unsigned",
            "scored": False,
            "reason": "the receipt carries no gpg signature, so its origin "
                      "rests on the generator that produced it, not on "
                      "cryptographic proof",
        }
    if gpg_ok is True:
        return {"state": VERIFIED, "status": "signed_valid", "scored": True,
                "reason": ""}
    if gpg_ok is False:
        return {
            "state": FAILED,
            "status": "signed_invalid",
            "scored": True,
            "reason": "a gpg signature is recorded but does not verify "
                      "against the canonical receipt bytes",
        }
    return {
        "state": UNVERIFIABLE,
        "status": "signed_uncheckable",
        "scored": True,
        "reason": "a gpg signature is recorded but gpg is not available "
                  "here, so it could be neither confirmed nor refuted",
    }


def attest(proof_path, repo_dir="."):
    """Build the attestation record. Pure: no writes, no network."""
    try:
        proof = _pv._load_proof(proof_path)
    except _pv.ProofLoadError as exc:
        return {
            "attestation": "loki-receipt-attestation/v1",
            "receipt": os.path.basename(str(proof_path)),
            "receipt_sha256": None,
            "checked_from": os.path.abspath(repo_dir),
            "axes": {},
            "signature": {
                "state": UNVERIFIABLE,
                "status": "unsigned",
                "reason": "the receipt could not be loaded",
            },
            "verdict": UNVERIFIABLE,
            "summary": "UNVERIFIABLE -- %s" % exc,
        }

    result = _pv.verify(proof_path, repo_dir)
    reasons = result.get("reasons") or []

    # The receipt's own identity. Hash the canonical bytes the verifier
    # hashes (verification stripped), so an attestation is comparable across
    # machines regardless of key ordering or whitespace in the file.
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    receipt_sha = hashlib.sha256(
        _pv._canonical(unsigned).encode("utf-8")).hexdigest()

    axes = {}

    # Integrity: hash_ok is a plain bool from the verifier -- always checked.
    axes["integrity"] = _tri(bool(result.get("hash_ok")), "")
    if axes["integrity"]["state"] == FAILED:
        axes["integrity"]["reason"] = _pick(
            reasons, "hash mismatch", "integrity hash") or \
            "the recorded integrity hash does not match the receipt bytes"

    # Drift: the axis that genuinely cannot be checked away from the repo.
    axes["drift"] = _tri(
        result.get("diff_drift") is False if result.get("diff_drift") is not None
        else None,
        _pick(reasons, "drift unverifiable") or
        "the recorded diff could not be re-derived here",
    )
    if result.get("diff_drift") is True:
        axes["drift"] = {
            "state": FAILED,
            "reason": _pick(reasons, "diff drift") or
            "the recorded diff no longer matches the repository",
        }

    # Headline consistency and cost coherence are None when not derivable.
    axes["headline"] = _tri(
        result.get("headline_consistent"),
        "the receipt records no headline or no facts to re-derive it from",
    )
    if axes["headline"]["state"] == FAILED:
        axes["headline"]["reason"] = _pick(reasons, "headline") or \
            "the headline disagrees with the recorded facts"

    axes["cost"] = _tri(
        result.get("cost_coherent"),
        "the receipt records no cost block to check for coherence",
    )
    if axes["cost"]["state"] == FAILED:
        axes["cost"]["reason"] = _pick(reasons, "cost claim") or \
            "the recorded cost contradicts itself"

    # Workspace tree. Every real receipt carries one (proof-generator.py:1190
    # writes tree_sha256 unconditionally), and verify() scores it. Dropping it
    # here meant a receipt verify() REJECTED for tree drift still attested
    # VERIFIED with exit 0 -- an axis silently defaulting to "passed" purely
    # because the projection forgot it, which is the exact laundering this
    # tool exists to prevent.
    #
    # tree_drift is None both when nothing was recorded and when the digest
    # could not be recomputed, so disambiguate on the recorded value: no
    # recorded digest is not an axis at all (nothing to check, like unsigned),
    # while a recorded digest we could not recompute is genuinely
    # UNVERIFIABLE.
    recorded_tree = (result.get("tree_recheck") or {}).get("recorded")
    if recorded_tree:
        axes["tree"] = _tri(
            result.get("tree_drift") is False
            if result.get("tree_drift") is not None else None,
            _pick(reasons, "tree unverifiable", "workspace tree unverifiable")
            or "the receipt records a workspace tree digest, but the current "
               "tree could not be re-derived here",
        )
        if result.get("tree_drift") is True:
            axes["tree"] = {
                "state": FAILED,
                "reason": _pick(reasons, "workspace tree drift") or
                "the recorded workspace tree digest no longer matches",
            }

    signature = _signature_axis(proof, result.get("gpg_ok"))

    scored = dict(axes)
    if signature.get("scored"):
        scored["signature"] = signature

    states = [a["state"] for a in scored.values()]
    if FAILED in states:
        verdict = FAILED
    elif UNVERIFIABLE in states:
        verdict = UNVERIFIABLE
    else:
        verdict = VERIFIED

    failed = sorted(k for k, a in scored.items() if a["state"] == FAILED)
    unchecked = sorted(k for k, a in scored.items()
                       if a["state"] == UNVERIFIABLE)
    passed = sorted(k for k, a in scored.items() if a["state"] == VERIFIED)

    # The unsigned caveat rides on every verdict, including a passing one. An
    # exit 0 is only honest if the thing it does NOT cover is impossible to
    # miss on the line a human actually reads.
    caveat = ("; receipt is UNSIGNED, so origin rests on its generator"
              if signature["status"] == "unsigned" else "")

    if verdict == FAILED:
        summary = "FAILED -- %s did not pass here%s" % (
            ", ".join(failed), caveat)
    elif verdict == UNVERIFIABLE:
        summary = "UNVERIFIABLE -- %s passed, but %s could not be checked here%s" % (
            ", ".join(passed) or "nothing", ", ".join(unchecked), caveat)
    else:
        summary = "VERIFIED -- every axis checked here passed%s" % caveat

    return {
        "attestation": "loki-receipt-attestation/v1",
        "receipt": os.path.basename(str(proof_path)),
        "receipt_sha256": receipt_sha,
        "checked_from": os.path.abspath(repo_dir),
        "axes": axes,
        "signature": signature,
        # Carried straight from verify(): True means the facts are taken at
        # face value because no valid signature vouches for them.
        "generator_trusted": bool(result.get("generator_trusted")),
        "verdict": verdict,
        "summary": summary,
    }


def exit_code(record):
    """Exit 0 ONLY when nothing failed and nothing was left unchecked.

    An UNVERIFIABLE axis must not exit 0: a confident 0 is what a caller in a
    `&&` chain reads as "attested", which would re-collapse the third state at
    the shell boundary after this module worked to keep it separate. It gets
    its own code rather than sharing 1, so a consumer can distinguish "this
    receipt is bad" (1) from "fetch the repo and re-run" (2).
    """
    if record.get("verdict") == FAILED:
        return EXIT_FAILED
    if record.get("verdict") == UNVERIFIABLE:
        return EXIT_UNVERIFIABLE
    return EXIT_OK


def render(record):
    lines = [record["summary"], ""]
    lines.append("receipt      %s" % record["receipt"])
    lines.append("sha256       %s" % (record["receipt_sha256"] or "unknown"))
    lines.append("checked from %s" % record["checked_from"])
    lines.append("")
    for name, axis in record["axes"].items():
        lines.append("%-10s %s" % (name, axis["state"]))
        if axis.get("reason"):
            lines.append("           %s" % axis["reason"])
    sig = record["signature"]
    lines.append("%-10s %s (%s)" % ("signature", sig["state"], sig["status"]))
    if sig.get("reason"):
        lines.append("           %s" % sig["reason"])
    return "\n".join(lines)


_USAGE = """usage: receipt-attest.py <proof.json> [--json]

Turn a receipt into a portable ATTESTATION a third party can check without the
original workspace.

  --json    emit the attestation record as JSON
  --help    show this message

States, which are never collapsed into one another:
  VERIFIED      the axis was checked and passed
  FAILED        the axis was checked and failed
  UNVERIFIABLE  the axis could NOT be checked here, with the reason

Exit: 0 all scored axes verified, 1 something FAILED, 2 something was
UNVERIFIABLE, 64 usage error.
"""


def main(argv):
    rest = argv[1:]

    # --help must print usage, NOT be read as a filename. It previously fell
    # through to the positional slot and produced
    # "UNVERIFIABLE -- proof file not found: --help", which is a verification
    # verdict about a file the user never named: a fabricated answer to a
    # question they did not ask.
    if "--help" in rest or "-h" in rest:
        sys.stdout.write(_USAGE)
        return 0

    as_json = "--json" in rest
    args = [a for a in rest if a != "--json"]

    # An unrecognized flag is an ERROR, never a path. Treating "--jsonn" as a
    # proof file reports UNVERIFIABLE for a typo, which reads as a finding
    # about the receipt rather than about the command line.
    unknown = [a for a in args if a.startswith("-")]
    if unknown:
        sys.stderr.write("unknown option(s): %s\n" % " ".join(unknown))
        sys.stderr.write(_USAGE)
        return 64

    if len(args) != 1:
        sys.stderr.write(_USAGE)
        return 64
    record = attest(args[0])
    print(json.dumps(record, indent=2, sort_keys=True) if as_json
          else render(record))
    return exit_code(record)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
