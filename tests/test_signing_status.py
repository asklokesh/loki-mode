"""A signing check that cannot prove signing is worse than no check at all.

WHAT THIS LOCKS DOWN. tools/signing-status.py answers one question: can this
machine produce SIGNED receipts? The tempting implementation is two booleans --
is gpg installed, is LOKI_PROOF_GPG_KEY set -- and that implementation is wrong
in the only direction that matters. Both are true for an expired key, a revoked
key, and a key needing a passphrase the environment cannot supply. In every one
of those cases proof-generator.py:_gpg_detached_sign swallows the failure and
emits an UNSIGNED receipt. A tool that reports "signing works" there tells the
user their receipts carry origin when they carry none.

So the property under test is not "the tool returns a status". It is:

    "ok" is reachable ONLY through a completed sign-AND-verify round trip.

TEST STRATEGY: a fake gpg on PATH, not subprocess mocking. Each state gets a
temp dir holding an executable named `gpg`, prepended to PATH in the child
process env. This runs the tool as a real subprocess against a real
subprocess.run, so the code path under test is the shipped one -- monkeypatching
subprocess would leave the actual argv untested and let the mutation probe pass
against a hollow test. It also gives real stdout and stderr to assert the
key-material scrub against.

The four states must stay DISTINGUISHABLE. A test suite that only checks "not
ok" would pass if broken and not_configured collapsed into one another, and
those two send the user to opposite places: one is a security regression in
progress, the other is a feature that was never turned on.
"""

import importlib.util
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

# Must precede the loader: a hyphenated tool name cannot be imported normally,
# and a stray __pycache__ under tools/ would be an untracked side effect.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "signing-status.py"

_spec = importlib.util.spec_from_file_location("signing_status", _TOOL)
_ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ss)

# Strings that must NEVER appear in this tool's output. The first is what a real
# secret key block opens with; the rest are what a leaking error path looks like.
_SECRET_MARKER = "-----BEGIN PGP PRIVATE KEY BLOCK-----"
_SECRET_BODY = "lQOYBGXfakeSECRETKEYMATERIALdoNotPrintMe"
_PASSPHRASE = "correct-horse-battery-staple"


def _shim(body):
    """Write an executable `gpg` into a fresh temp dir. Returns that dir."""
    d = tempfile.mkdtemp(prefix="loki-sstatus-shim-")
    p = pathlib.Path(d) / "gpg"
    p.write_text("#!/bin/sh\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return d


# Signs and verifies for real (as far as the tool can tell): --detach-sign
# writes armor to stdout, --verify exits 0. The happy path.
_SHIM_WORKS = """
case "$*" in
  *--detach-sign*) echo "-----BEGIN PGP SIGNATURE-----"; echo "ok"; \
echo "-----END PGP SIGNATURE-----"; exit 0 ;;
  *--verify*) exit 0 ;;
esac
exit 2
"""

# Refuses to sign, and leaks key material on stderr while doing it. Both
# failures in one shim: the tool must report BROKEN *and* scrub.
_SHIM_NO_SECRET_KEY = """
case "$*" in
  *--detach-sign*)
    echo "gpg: skipped \\"KEYID\\": No secret key" >&2
    echo "%s" >&2
    echo "%s" >&2
    echo "passphrase was: %s" >&2
    exit 2 ;;
esac
exit 2
""" % (_SECRET_MARKER, _SECRET_BODY, _PASSPHRASE)

_SHIM_EXPIRED = """
case "$*" in
  *--detach-sign*) echo "gpg: skipped: unusable secret key -- key has expired" >&2; exit 2 ;;
esac
exit 2
"""

# The case a naive tool calls "works": signing produced OUTPUT, so a check that
# stops at "returncode == 0 and stdout" reports success. gpg will not verify it.
_SHIM_BAD_SIGNATURE = """
case "$*" in
  *--detach-sign*) echo "-----BEGIN PGP SIGNATURE-----"; exit 0 ;;
  *--verify*) echo "gpg: BAD signature" >&2; exit 1 ;;
esac
exit 2
"""


def _run(shim_dir, key=None, json_mode=False):
    """Run the tool as a subprocess with PATH pointed at the shim dir."""
    env = dict(os.environ)
    env["PATH"] = shim_dir if shim_dir else ""
    env.pop("LOKI_PROOF_GPG_KEY", None)
    if key is not None:
        env["LOKI_PROOF_GPG_KEY"] = key
    argv = [sys.executable, str(_TOOL)] + (["--json"] if json_mode else [])
    return subprocess.run(argv, capture_output=True, text=True,
                          env=env, timeout=60)


class SigningStatusTest(unittest.TestCase):

    def setUp(self):
        self.dirs = []

    def tearDown(self):
        for d in self.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def shim(self, body):
        d = _shim(body)
        self.dirs.append(d)
        return d

    def empty_path(self):
        d = tempfile.mkdtemp(prefix="loki-sstatus-nogpg-")
        self.dirs.append(d)
        return d

    def state(self, shim_dir, key=None):
        proc = _run(shim_dir, key=key, json_mode=True)
        return json.loads(proc.stdout), proc

    # -- state: gpg absent -------------------------------------------------

    def test_gpg_absent_is_reported_and_exits_nonzero(self):
        result, proc = self.state(self.empty_path(), key="KEYID")
        self.assertEqual(result["status"], "gpg_absent")
        self.assertFalse(result["gpg_installed"])
        self.assertNotEqual(proc.returncode, 0)

    def test_gpg_absent_next_command_installs_gpg(self):
        result, _ = self.state(self.empty_path())
        self.assertIn("install", result["next_command"])

    # -- state: not configured ---------------------------------------------

    def test_env_unset_reports_not_configured(self):
        result, proc = self.state(self.shim(_SHIM_WORKS), key=None)
        self.assertEqual(result["status"], "not_configured")
        self.assertTrue(result["gpg_installed"])
        self.assertFalse(result["key_id_set"])
        self.assertNotEqual(proc.returncode, 0)

    def test_blank_key_is_not_configured_not_broken(self):
        # An exported-but-empty var is "never turned on", not "broken".
        result, _ = self.state(self.shim(_SHIM_WORKS), key="   ")
        self.assertEqual(result["status"], "not_configured")

    # -- state: broken ------------------------------------------------------

    def test_failing_sign_reports_broken_with_reason(self):
        result, proc = self.state(self.shim(_SHIM_NO_SECRET_KEY), key="KEYID")
        self.assertEqual(result["status"], "broken")
        self.assertFalse(result["round_trip_verified"])
        self.assertIn("no secret key", result["reason"].lower())
        self.assertNotEqual(proc.returncode, 0)

    def test_expired_key_reason_says_expired(self):
        result, _ = self.state(self.shim(_SHIM_EXPIRED), key="KEYID")
        self.assertEqual(result["status"], "broken")
        self.assertIn("expired", result["reason"].lower())

    def test_signature_that_does_not_verify_is_broken_not_ok(self):
        # THE core case. Signing returned 0 with output; only the verify half of
        # the round trip catches it. A tool without that half reports "ok" here.
        result, proc = self.state(self.shim(_SHIM_BAD_SIGNATURE), key="KEYID")
        self.assertEqual(result["status"], "broken")
        self.assertNotEqual(proc.returncode, 0)

    def test_broken_output_names_the_silent_unsigned_harm(self):
        proc = _run(self.shim(_SHIM_NO_SECRET_KEY), key="KEYID")
        self.assertIn("UNSIGNED", proc.stdout)

    # -- state: ok ----------------------------------------------------------

    def test_completed_round_trip_reports_ok_and_exits_zero(self):
        result, proc = self.state(self.shim(_SHIM_WORKS), key="KEYID")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["round_trip_verified"])
        self.assertEqual(proc.returncode, 0)

    def test_ok_requires_the_round_trip_not_just_installed_and_set(self):
        # Both booleans true in every one of these; only one is "ok". This is
        # the property the whole tool exists for.
        for body in (_SHIM_NO_SECRET_KEY, _SHIM_EXPIRED, _SHIM_BAD_SIGNATURE):
            result, proc = self.state(self.shim(body), key="KEYID")
            self.assertTrue(result["gpg_installed"])
            self.assertTrue(result["key_id_set"])
            self.assertNotEqual(result["status"], "ok")
            self.assertNotEqual(proc.returncode, 0)

    def test_exit_zero_only_when_round_trip_verified(self):
        cases = [
            (self.shim(_SHIM_WORKS), "KEYID"),
            (self.shim(_SHIM_BAD_SIGNATURE), "KEYID"),
            (self.shim(_SHIM_NO_SECRET_KEY), "KEYID"),
            (self.shim(_SHIM_WORKS), None),
            (self.empty_path(), "KEYID"),
        ]
        for shim_dir, key in cases:
            result, proc = self.state(shim_dir, key=key)
            self.assertEqual(proc.returncode == 0,
                             result["round_trip_verified"])

    # -- the four states are distinguishable --------------------------------

    def test_four_states_are_distinct(self):
        seen = {
            self.state(self.shim(_SHIM_WORKS), key="KEYID")[0]["status"],
            self.state(self.shim(_SHIM_NO_SECRET_KEY), key="KEYID")[0]["status"],
            self.state(self.shim(_SHIM_WORKS), key=None)[0]["status"],
            self.state(self.empty_path(), key="KEYID")[0]["status"],
        }
        self.assertEqual(
            seen, {"ok", "broken", "not_configured", "gpg_absent"})

    def test_each_state_has_a_distinct_exit_code(self):
        codes = {
            _run(self.shim(_SHIM_WORKS), key="KEYID").returncode,
            _run(self.shim(_SHIM_NO_SECRET_KEY), key="KEYID").returncode,
            _run(self.shim(_SHIM_WORKS)).returncode,
            _run(self.empty_path(), key="KEYID").returncode,
        }
        self.assertEqual(len(codes), 4)

    def test_json_and_text_agree_on_exit_code(self):
        # An easy bug: --json takes an early return and always exits 0.
        for shim_dir, key in ((self.shim(_SHIM_WORKS), "KEYID"),
                              (self.shim(_SHIM_NO_SECRET_KEY), "KEYID"),
                              (self.shim(_SHIM_WORKS), None),
                              (self.empty_path(), "KEYID")):
            self.assertEqual(_run(shim_dir, key=key, json_mode=True).returncode,
                             _run(shim_dir, key=key).returncode)

    # -- key material never leaks -------------------------------------------

    def test_no_key_material_in_any_output(self):
        # The shim leaks a private-key block, key bytes, and a passphrase on
        # stderr. None may reach the user through either output mode.
        for json_mode in (False, True):
            proc = _run(self.shim(_SHIM_NO_SECRET_KEY), key="KEYID",
                        json_mode=json_mode)
            blob = proc.stdout + proc.stderr
            for secret in (_SECRET_MARKER, _SECRET_BODY, _PASSPHRASE):
                self.assertNotIn(secret, blob)

    def test_unrecognized_stderr_is_not_echoed(self):
        # The unclassifiable case is the one whose contents cannot be predicted,
        # so it must degrade to a generic reason rather than pass stderr along.
        leak = "unexpected gpg chatter %s" % _SECRET_BODY
        body = ('case "$*" in\n  *--detach-sign*) echo "%s" >&2; exit 2 ;;\n'
                'esac\nexit 2\n' % leak)
        result, proc = self.state(self.shim(body), key="KEYID")
        self.assertEqual(result["status"], "broken")
        self.assertNotIn(_SECRET_BODY, proc.stdout + proc.stderr)
        self.assertNotIn(_SECRET_BODY, result["reason"])

    def test_key_id_is_echoed_but_is_not_key_material(self):
        # A key ID identifies a key; it is not the key. Echoing it is how the
        # user knows WHICH key was tried.
        result, _ = self.state(self.shim(_SHIM_NO_SECRET_KEY), key="ABC123")
        self.assertEqual(result["key_id"], "ABC123")

    def test_never_invokes_an_export_path(self):
        # A shim that records argv: no run may ask gpg to export anything.
        d = tempfile.mkdtemp(prefix="loki-sstatus-argv-")
        self.dirs.append(d)
        log = pathlib.Path(d) / "argv.log"
        p = pathlib.Path(d) / "gpg"
        p.write_text('#!/bin/sh\necho "$*" >> %s\nexit 2\n' % log)
        p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        _run(d, key="KEYID")
        self.assertNotIn("--export", log.read_text())

    # -- the round trip mirrors the real signer -----------------------------

    def test_round_trip_uses_the_proof_generator_argv(self):
        # If this drifts, a green round trip stops predicting what the receipt
        # pipeline does, and the tool can report ok while receipts emit unsigned.
        d = tempfile.mkdtemp(prefix="loki-sstatus-argv2-")
        self.dirs.append(d)
        log = pathlib.Path(d) / "argv.log"
        p = pathlib.Path(d) / "gpg"
        p.write_text(
            '#!/bin/sh\necho "$*" >> %s\n'
            'case "$*" in\n'
            '  *--detach-sign*) echo "-----BEGIN PGP SIGNATURE-----"; exit 0 ;;\n'
            '  *--verify*) exit 0 ;;\nesac\nexit 2\n' % log)
        p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        _run(d, key="KEYID")
        recorded = log.read_text()
        for flag in ("--batch", "--detach-sign", "--local-user", "KEYID",
                     "--armor"):
            self.assertIn(flag, recorded)
        self.assertIn("--verify", recorded)

    def test_keyring_is_not_modified(self):
        # Read-only means read-only: no key creation, deletion, or import.
        d = tempfile.mkdtemp(prefix="loki-sstatus-argv3-")
        self.dirs.append(d)
        log = pathlib.Path(d) / "argv.log"
        p = pathlib.Path(d) / "gpg"
        p.write_text('#!/bin/sh\necho "$*" >> %s\nexit 2\n' % log)
        p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        _run(d, key="KEYID")
        recorded = log.read_text()
        for mutating in ("--gen-key", "--full-generate-key", "--delete",
                         "--import", "--edit-key"):
            self.assertNotIn(mutating, recorded)

    def test_round_trip_leaves_no_scratch_files(self):
        before = set(pathlib.Path(tempfile.gettempdir()).glob(
            "loki-signing-status-*"))
        _run(self.shim(_SHIM_WORKS), key="KEYID")
        after = set(pathlib.Path(tempfile.gettempdir()).glob(
            "loki-signing-status-*"))
        self.assertEqual(before, after)


class RealGpgTest(unittest.TestCase):
    """Against the real gpg on this machine, when there is one."""

    def test_real_machine_state_is_one_of_the_four(self):
        if shutil.which("gpg") is None:
            raise unittest.SkipTest("gpg not installed on this machine")
        result = _ss.evaluate()
        self.assertIn(result["status"],
                      ("ok", "broken", "not_configured", "gpg_absent"))
        self.assertNotEqual(result["status"], "gpg_absent")

    def test_real_gpg_failure_is_classified_not_echoed(self):
        # Drives the REAL gpg down its real failure path with a key id that
        # cannot resolve. Running the tool with inherited env would short-circuit
        # at not_configured and never execute gpg at all, so the scrub assertion
        # would pass over output that never had a transcript in it -- a check
        # that checks nothing. The bogus key id forces the round trip to run.
        if shutil.which("gpg") is None:
            raise unittest.SkipTest("gpg not installed on this machine")
        env = dict(os.environ)
        env["LOKI_PROOF_GPG_KEY"] = "0000000000000000DEADBEEF"
        proc = subprocess.run([sys.executable, str(_TOOL), "--json"],
                              capture_output=True, text=True, env=env,
                              timeout=90)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "broken")
        self.assertNotIn(_SECRET_MARKER, proc.stdout + proc.stderr)
        # The reason must be one of OUR classified strings, never a passthrough
        # of whatever this gpg build happened to print.
        self.assertIn(result["reason"], [r for _, r in _ss._REASONS] + [
            "gpg refused to sign with that key",
            "gpg produced a signature it could not verify"])


if __name__ == "__main__":
    unittest.main()
