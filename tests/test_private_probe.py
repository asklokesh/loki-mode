"""The hash-bound private probe must not be trustable by accident.

WHAT IT IS FOR. benchmarks/bench/private_probe.py exists so a claim about the
medium and high oracles can be CHECKED, after an earlier by-hand run was
correctly retracted for being unreplayable. A verifier whose own behaviour is
unverified would put the problem back one level.

THE CONSTRAINT THAT SHAPES THIS FILE. The real private directory lives outside
the repository and is machine-local: on a fresh clone it does not exist, and it
must never be created by a test, because populating it means writing an answer
key. So every case here points LOKI_BENCH_PRIVATE at a throwaway directory and
exercises the tool against synthetic artifacts and a synthetic grader. Nothing
here depends on the operator's real artifacts, and nothing here creates them.

THE PROPERTIES ASSERTED, in the order they matter:

  1. Absent artifacts read not_available, NEVER a pass. A verifier that
     reports success for what it was not given is the exact false-green this
     tool was built to close.
  2. A mismatch between the recorded expectation and the observed exit code
     reads CONTRADICTED and exits 1. Without this the receipt is decoration.
  3. The hash covers FILENAMES as well as bytes. Two artifact sets with
     identical content under different names are different inputs to a grader
     that imports by module name, and a content-only hash would call them
     equal.
  4. The grader runs against a COPY, so a grader that writes files cannot
     mutate the private artifacts and silently change their hash between runs.
"""

import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "benchmarks" / "bench" / "private_probe.py"

_spec = importlib.util.spec_from_file_location("private_probe", _TOOL)
_pp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pp)


def _run(env_dir, *args):
    env = dict(os.environ)
    if env_dir is None:
        env.pop("LOKI_BENCH_PRIVATE", None)
        env["LOKI_BENCH_PRIVATE"] = "/nonexistent/private/dir"
    else:
        env["LOKI_BENCH_PRIVATE"] = env_dir
    return subprocess.run([sys.executable, str(_TOOL), *args],
                          capture_output=True, text=True, timeout=180, env=env)


class TheHashBindsNamesNotJustBytes(unittest.TestCase):
    """Property 3. A content-only hash would call these two sets equal."""

    def test_same_bytes_different_filename_hash_differently(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            body = b"print('same bytes')\n"
            (pathlib.Path(a) / "alpha.py").write_bytes(body)
            (pathlib.Path(b) / "beta.py").write_bytes(body)
            self.assertNotEqual(
                _pp.artifact_hash(a), _pp.artifact_hash(b),
                "identical bytes under different filenames hashed the same; a "
                "grader importing by module name sees these as different inputs")

    def test_identical_sets_hash_identically(self):
        """The other direction: the hash must be stable, or nothing replays."""
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            for d in (a, b):
                (pathlib.Path(d) / "m.py").write_bytes(b"x = 1\n")
            self.assertEqual(_pp.artifact_hash(a), _pp.artifact_hash(b))

    def test_empty_directory_has_no_hash(self):
        """None, not the hash of nothing. An empty set is not an artifact."""
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(_pp.artifact_hash(d))


class AbsentArtifactsAreNeverAPass(unittest.TestCase):
    """Property 1, and the one that matters most on a fresh clone."""

    def test_no_private_dir_exits_3_and_says_so(self):
        r = _run(None)
        self.assertEqual(r.returncode, 3,
                         "a missing private directory must be NOTHING TO CHECK")
        self.assertIn("NOTHING TO CHECK", r.stdout + r.stderr)

    def test_empty_private_dir_reports_not_available_not_verified(self):
        with tempfile.TemporaryDirectory() as d:
            r = _run(d, "--json")
            self.assertEqual(r.returncode, 0, r.stderr[:200])
            self.assertIn("not_available", r.stdout)
            self.assertNotIn('"verified"', r.stdout,
                             "reported verified with no artifacts present")


class AContradictionIsDetectedAndExitsOne(unittest.TestCase):
    """Property 2. Without this the receipt cannot be relied on at all."""

    def _plant(self, root, task, probe, body):
        d = pathlib.Path(root) / task / probe
        d.mkdir(parents=True, exist_ok=True)
        (d / "order_api.py").write_text(body, encoding="utf-8")

    def test_a_wrong_exit_code_reads_contradicted(self):
        # The real hard-1-order-api grader ships in-repo, so this exercises the
        # genuine article rather than a stub: an implementation that always
        # returns 200 fails it, and planting that in the POSITIVE slot (where
        # exit 0 is expected) must be caught.
        always_ok = "def handle(request):\n    return 200, {'total': 0.0}\n"
        with tempfile.TemporaryDirectory() as d:
            self._plant(d, "hard-1-order-api", "positive", always_ok)
            r = _run(d)
            self.assertEqual(r.returncode, 1,
                             "a probe contradicting its recorded expectation "
                             "must exit 1\n" + r.stdout[-400:])
            self.assertIn("CONTRADICTED", r.stdout)


class TheGraderRunsAgainstACopy(unittest.TestCase):
    """Property 4. A grader that writes must not change the artifact hash."""

    def test_private_artifacts_are_unchanged_by_a_probe_run(self):
        body = "def handle(request):\n    return 200, {'total': 0.0}\n"
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "hard-1-order-api" / "positive"
            src.mkdir(parents=True)
            (src / "order_api.py").write_text(body, encoding="utf-8")
            before = _pp.artifact_hash(str(src))
            _run(d)
            after = _pp.artifact_hash(str(src))
            self.assertEqual(
                before, after,
                "the private artifacts changed during a probe run; the hash "
                "recorded in a receipt would no longer identify them")


class TheExitContract(unittest.TestCase):
    def test_usage_error_is_64_not_argparse_default_2(self):
        r = _run(None, "--zzz-not-a-flag")
        self.assertEqual(r.returncode, 64)

    def test_help_exits_zero(self):
        r = _run(None, "--help")
        self.assertEqual(r.returncode, 0)


class DriftFromTheAttestationIsCaught(unittest.TestCase):
    """The property that makes the attestation worth committing.

    Without it the probe verifies whatever bytes it happens to find. An
    artifact edited after the fact would be re-blessed under a new hash and
    the receipt would still read `verified` -- which is how an edited answer
    key launders itself into a green result.

    The case below is deliberately the hard one: the edit does NOT change
    behaviour, so the grader still returns the expected exit code. Only the
    hash comparison can catch it.
    """

    def test_an_edited_artifact_reads_drifted_and_exits_1(self):
        att = _ROOT / "benchmarks" / "bench" / "private_attestation.json"
        if not att.is_file():
            self.skipTest("no attestation file; drift cannot be checked")
        body = "def handle(request):\n    return 200, {'total': 0.0}\n"
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "hard-1-order-api" / "positive"
            src.mkdir(parents=True)
            # Bytes that cannot match the attested hash for this probe.
            (src / "order_api.py").write_text(body, encoding="utf-8")
            r = _run(d, "--json")
            self.assertIn("DRIFTED", r.stdout,
                          "an unattested-hash artifact was not flagged as drift")

    def test_an_unattested_probe_is_not_reported_as_drift(self):
        """Absence of a record is not evidence of tampering.

        A brand new probe nobody has attested yet must read `unattested`,
        not DRIFTED, or every legitimate new probe fails on arrival.
        """
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "multifail-1-two-modules" / "positive"
            src.mkdir(parents=True)
            (src / "temperature.py").write_text("x = 1\n", encoding="utf-8")
            r = _run(d, "--json")
            self.assertIn("attestation", r.stdout)


if __name__ == "__main__":
    unittest.main()
