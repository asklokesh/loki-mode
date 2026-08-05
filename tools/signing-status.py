#!/usr/bin/env python3
"""Can this machine produce SIGNED receipts? Prove it, do not assume it.

WHY THIS EXISTS. An unsigned Evidence Receipt proves INTEGRITY but not ORIGIN.
The hash says the bytes were not tampered with; it says nothing about who
produced them, and anyone can generate a receipt with a valid hash. Origin is
the part a third party is actually buying. GPG signing closes that gap and has
shipped since the proof generator learned LOKI_PROOF_GPG_KEY -- default OFF,
undiscoverable, and silent when broken.

Silent is the dangerous word. autonomy/lib/proof-generator.py:_gpg_detached_sign
swallows EVERY failure and returns None: missing key, expired key, revoked key,
a passphrase this environment cannot supply. Signing is best-effort by design so
a gpg problem never blocks proof emission. The cost of that design is that a
user who set LOKI_PROOF_GPG_KEY, believes receipts are signed, and has a broken
key gets UNSIGNED receipts forever with no error anywhere. This tool is the only
place that failure becomes visible.

So the bar here is higher than "gpg is installed and a key id is set". That
sentence is compatible with every one of the failures above. The only honest
evidence that this machine can sign is a real detached-sign of a real payload
followed by a real verify of the resulting signature -- with the SAME argv the
receipt pipeline uses, or the round trip predicts nothing about the pipeline.

FOUR STATES, NEVER A BOOLEAN. Collapsing these sends a user to debug the wrong
thing, which for a security control is worse than saying nothing:

    ok              round trip signed AND verified. Receipts carry origin.
    broken          configured, and signing FAILED. Receipts silently unsigned.
    not_configured  gpg works, LOKI_PROOF_GPG_KEY unset. Nothing is wrong.
    gpg_absent      no gpg on PATH. Signing is impossible until installed.

KEY MATERIAL NEVER LEAVES. A key ID is an identifier and is safe to print.
Secret key bytes and passphrases are not, and gpg writes diagnostics to stderr
that can quote them. Raw gpg stderr is therefore NEVER printed: it is
classified into a known reason and only the classification is emitted. No
--export path is invoked anywhere in this file. Requirement and implementation
are the same line: print the reason, not the transcript.

Read-only against the keyring: no key is created, deleted, imported, or
modified. The round trip signs a scratch file in a temp dir that is removed
afterwards, and uses the caller's real GNUPGHOME because the question being
answered is whether the REAL keyring can sign.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

# The payload is arbitrary: the round trip proves the KEY works, not that any
# particular bytes are special. Fixed and tiny so a signature is fast.
_SCRATCH_PAYLOAD = b"loki-signing-status round-trip probe\n"

_TIMEOUT = 30

# Ordered: the first match wins, so the more specific pattern precedes the
# general one. Left side is matched against LOWERCASED gpg stderr; right side is
# what the user is told. Never the raw stderr -- see the module docstring.
_REASONS = (
    ("no secret key", "no secret key for that key id in this keyring"),
    ("secret key not available", "no secret key for that key id in this keyring"),
    ("no default secret key", "no secret key for that key id in this keyring"),
    ("unusable secret key", "the secret key is unusable (expired or revoked)"),
    ("key has expired", "the key has expired"),
    ("expired", "the key has expired"),
    ("has been revoked", "the key has been revoked"),
    ("revoked", "the key has been revoked"),
    ("bad passphrase", "the passphrase was rejected"),
    ("passphrase", "the key needs a passphrase this environment cannot supply"),
    ("pinentry", "the key needs a passphrase this environment cannot supply"),
    ("inappropriate ioctl", "the key needs a passphrase this environment cannot supply"),
    ("no such file", "the key id does not resolve to a key in this keyring"),
    ("not found", "the key id does not resolve to a key in this keyring"),
)


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _classify(stderr, fallback):
    """Map gpg stderr onto a known reason. NEVER returns the stderr itself.

    Anything unrecognized degrades to a generic fallback rather than leaking the
    transcript, because the unrecognized case is exactly the one whose contents
    cannot be predicted -- and therefore the one most likely to quote key
    material or a passphrase prompt.
    """
    low = (stderr or "").lower()
    for needle, reason in _REASONS:
        if needle in low:
            return reason
    return fallback


def _round_trip(key_id):
    """Sign a scratch payload with key_id and verify the signature.

    Returns (True, None) when the signature verified, else (False, reason).

    The argv MUST mirror autonomy/lib/proof-generator.py:_gpg_detached_sign and
    autonomy/lib/proof-verify.py:_verify_gpg. A round trip that signs some other
    way can succeed while the receipt pipeline still emits unsigned, which would
    make this tool confidently wrong in the one direction that matters.
    """
    tmp = tempfile.mkdtemp(prefix="loki-signing-status-")
    try:
        data_path = os.path.join(tmp, "payload.bin")
        with open(data_path, "wb") as fh:
            fh.write(_SCRATCH_PAYLOAD)

        try:
            signed = subprocess.run(
                ["gpg", "--batch", "--yes", "--armor", "--detach-sign",
                 "--local-user", key_id, "--output", "-"],
                input=_SCRATCH_PAYLOAD, capture_output=True, timeout=_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            # --batch should make gpg fail rather than prompt, but a wedged
            # agent or a pinentry that ignores batch mode hangs instead. Never
            # let this tool hang: a timeout IS a signing failure.
            return False, "gpg timed out (a passphrase prompt is the usual cause)"
        except OSError as exc:
            return False, "gpg could not be executed (%s)" % type(exc).__name__

        if signed.returncode != 0 or not signed.stdout:
            stderr = signed.stderr.decode("utf-8", errors="replace")
            return False, _classify(stderr, "gpg refused to sign with that key")

        sig_path = os.path.join(tmp, "payload.sig")
        with open(sig_path, "wb") as fh:
            fh.write(signed.stdout)

        try:
            checked = subprocess.run(
                ["gpg", "--verify", sig_path, data_path],
                capture_output=True, timeout=_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return False, "gpg timed out verifying its own signature"
        except OSError as exc:
            return False, "gpg could not be executed (%s)" % type(exc).__name__

        if checked.returncode != 0:
            # gpg produced bytes that gpg itself will not accept. A naive
            # "signing worked, we got output" check calls this state OK.
            stderr = checked.stderr.decode("utf-8", errors="replace")
            return False, _classify(
                stderr, "gpg produced a signature it could not verify")

        return True, None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def evaluate(env=None):
    """Resolve the signing state. Returns a JSON-safe dict.

    Pure with respect to the keyring: reads it, changes nothing.
    """
    env = os.environ if env is None else env
    gpg_path = shutil.which("gpg")
    key_id = (env.get("LOKI_PROOF_GPG_KEY") or "").strip()

    result = {
        "gpg_installed": gpg_path is not None,
        "gpg_path": gpg_path,
        "key_id_set": bool(key_id),
        # A key ID is an identifier, not key material: safe to echo back so the
        # user can see WHICH key was tried.
        "key_id": key_id or None,
        "round_trip_verified": False,
    }

    if gpg_path is None:
        result["status"] = "gpg_absent"
        result["reason"] = "gpg is not on PATH"
        result["next_command"] = "brew install gnupg   # or: apt-get install gnupg"
        return result

    if not key_id:
        result["status"] = "not_configured"
        result["reason"] = "LOKI_PROOF_GPG_KEY is not set"
        result["next_command"] = (
            "gpg --list-secret-keys --keyid-format=long   "
            "# then: export LOKI_PROOF_GPG_KEY=<key-id>")
        return result

    verified, reason = _round_trip(key_id)
    result["round_trip_verified"] = verified

    # The single load-bearing line in this file. "ok" is reachable ONLY through
    # a completed sign-and-verify round trip; every other path is a failure with
    # a reason. Deriving status from gpg_installed and key_id_set instead would
    # report ok for an expired key, which is the exact lie this tool exists to
    # prevent.
    result["status"] = "ok" if verified else "broken"

    if verified:
        result["reason"] = None
        result["next_command"] = None
    else:
        result["reason"] = reason
        result["next_command"] = (
            "gpg --list-secret-keys --keyid-format=long   "
            "# confirm %s is present and usable" % key_id)
    return result


# Exit codes are distinct per state so a caller can branch without parsing.
# 0 means, and only means, a round trip completed.
_EXIT = {"ok": 0, "broken": 1, "not_configured": 2, "gpg_absent": 3}

_HEADLINE = {
    "ok": "SIGNED    receipts from this machine carry a verifiable origin",
    "broken": "BROKEN    receipts are being emitted UNSIGNED, silently",
    "not_configured": "UNSIGNED  receipts prove integrity but NOT origin",
    "gpg_absent": "UNSIGNED  signing is unavailable on this machine",
}


def render(result):
    """Human-readable report. Contains no gpg transcript, by construction."""
    status = result["status"]
    lines = ["Receipt signing: %s" % _HEADLINE[status], ""]

    lines.append("  gpg installed:      %s" % (
        result["gpg_path"] if result["gpg_installed"] else "NO"))
    lines.append("  LOKI_PROOF_GPG_KEY: %s" % (
        result["key_id"] if result["key_id_set"] else "not set"))
    lines.append("  sign+verify proof:  %s" % (
        "PASS (round trip completed)" if result["round_trip_verified"]
        else "not proven"))

    if result.get("reason"):
        lines += ["", "  Why: %s" % result["reason"]]

    if status == "broken":
        lines += [
            "",
            "  A key is configured but cannot sign. The proof generator treats",
            "  signing as best-effort and swallows this failure, so receipts",
            "  keep emitting UNSIGNED with no error. Nothing else reports it.",
        ]
    elif status == "not_configured":
        lines += [
            "",
            "  Nothing is broken. Signing is opt-in and off. Turn it on to prove",
            "  a receipt came from you and not merely that its bytes are intact.",
        ]

    if result.get("next_command"):
        lines += ["", "  Next: %s" % result["next_command"]]

    return "\n".join(lines)


def main(argv=None):
    parser = _Parser(
        description="Report whether this machine can produce SIGNED receipts.")
    parser.add_argument("--json", action="store_true",
                        help="emit the result as JSON")
    args = parser.parse_args(argv)

    result = evaluate()
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(render(result))
    return _EXIT[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
