"""The receipt verifier enforces the schema_version the generator writes.

WHY THIS EXISTS. proof-generator.py has stamped schema_version on every receipt
since it shipped (1.1 today, line 31) and proof-verify.py NEVER READ IT -- a
version recorded on every artifact and enforced nowhere. A future receipt with
an incompatible shape would have been judged by rules written for a different
schema and reported as a clean pass, which is the one outcome a verification
product cannot survive.

FAIL CLOSED IS THE LOAD-BEARING CHOICE. A receipt whose schema cannot be placed
is not a receipt that can be verified, and "cannot tell" must never render as
"verified" -- the same rule the four-verdict receipt vocabulary already applies
to UNCHECKED vs UNSIGNED.

EVERY MINOR OF THE SUPPORTED MAJOR STILL VERIFIES, and test_legacy_minor proves
it. That is what keeps this from being a breaking change: all nine receipts on
disk are 1.1, minor bumps are additive by convention, and only a MAJOR bump
means the shape moved far enough that these checks no longer apply.
"""

import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "autonomy" / "lib"

_spec = importlib.util.spec_from_file_location(
    "proof_verify", LIB / "proof-verify.py")
pv = importlib.util.module_from_spec(_spec)
import sys
sys.path.insert(0, str(LIB))
_spec.loader.exec_module(pv)


def _receipt(tmp, schema_version, *, omit=False):
    """A minimal receipt whose integrity hash is genuinely correct.

    Hashed the way the generator does it -- canonical JSON with `verification`
    stripped -- so a failure in these tests is about the VERSION check and not
    about a fixture that never had a valid hash to begin with.
    """
    body = {
        "run_id": "r1",
        "generated_at": "2026-08-09T00:00:00Z",
        "loki_version": "9.19.1",
        "facts": {},
        "files_changed": {"count": 0},
    }
    if not omit:
        body["schema_version"] = schema_version
    import hashlib
    digest = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    body["verification"] = {"hash": digest, "algo": "sha256",
                            "scope": "integrity"}
    path = pathlib.Path(tmp) / "proof.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


class SchemaVersionGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        # A real git repo: the drift check is separate from the version check,
        # and a non-repo would make every case fail for the wrong reason.
        subprocess.run(["git", "init", "-q", self.dir], check=False,
                       capture_output=True)

    def tearDown(self):
        self.tmp.cleanup()

    # --- the unit, isolated from drift/gpg -------------------------------
    def test_current_version_is_supported(self):
        self.assertIsNone(pv.check_schema_version({"schema_version": "1.1"}))

    def test_legacy_minor_still_supported(self):
        """1.0 must keep verifying -- minor bumps are additive, not breaking."""
        self.assertIsNone(pv.check_schema_version({"schema_version": "1.0"}))
        self.assertIsNone(pv.check_schema_version({"schema_version": "1.7"}))

    def test_unknown_major_is_refused(self):
        reason = pv.check_schema_version({"schema_version": "2.0"})
        self.assertIsNotNone(reason)
        self.assertIn("major 2", reason)

    def test_missing_version_is_refused(self):
        reason = pv.check_schema_version({})
        self.assertIsNotNone(reason)
        self.assertIn("no schema_version", reason)

    def test_unparseable_version_is_refused(self):
        """A garbage value must fail closed, not crash and not pass."""
        for bad in ("", "abc", "v1", None, [], {}):
            with self.subTest(value=bad):
                self.assertIsNotNone(
                    pv.check_schema_version({"schema_version": bad}))

    # --- the wiring: it must reach the real verdict ----------------------
    def test_supported_version_does_not_block_verify(self):
        path = _receipt(self.dir, "1.1")
        result = pv.verify(str(path), self.dir)
        self.assertTrue(result["schema_supported"])
        self.assertEqual(result["schema_version"], "1.1")
        # ok may still be False for drift/gpg reasons in a bare repo; what must
        # be true is that NO schema reason was contributed.
        self.assertFalse([r for r in result["reasons"] if "schema_version" in r])

    def test_unknown_major_makes_verify_fail_closed(self):
        path = _receipt(self.dir, "2.0")
        result = pv.verify(str(path), self.dir)
        self.assertFalse(result["ok"])
        self.assertFalse(result["schema_supported"])
        self.assertTrue([r for r in result["reasons"] if "major 2" in r],
                        "the refusal must name the unsupported major")

    def test_missing_version_makes_verify_fail_closed(self):
        path = _receipt(self.dir, None, omit=True)
        result = pv.verify(str(path), self.dir)
        self.assertFalse(result["ok"])
        self.assertFalse(result["schema_supported"])

    def test_the_gate_is_wired_into_the_verdict_not_merely_reported(self):
        """The schema reason must be the DECIDING factor, not a passenger.

        Added after mutation testing: deleting `and schema_reason is None` from
        the verdict left all other assertions green, because `ok` was already
        False for unrelated reasons (a bare fixture repo has no diff to
        re-derive). Asserting "ok is False" therefore proved nothing about the
        wiring. This compares two receipts identical in every way EXCEPT the
        schema version, so only the gate can explain a difference in `ok`.
        """
        supported = pv.verify(str(_receipt(self.dir, "1.1")), self.dir)
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        subprocess.run(["git", "init", "-q", other.name], check=False,
                       capture_output=True)
        unsupported = pv.verify(str(_receipt(other.name, "2.0")), other.name)

        # Both share every non-schema property, so any ok/reasons difference is
        # attributable to the version alone.
        self.assertEqual(supported["hash_ok"], unsupported["hash_ok"])
        self.assertTrue(supported["schema_supported"])
        self.assertFalse(unsupported["schema_supported"])
        self.assertFalse(unsupported["ok"])
        # The decisive assertion: the unsupported receipt carries a schema
        # reason the supported one does not.
        self.assertEqual(
            [r for r in supported["reasons"] if "schema_version" in r], [])
        self.assertTrue(
            [r for r in unsupported["reasons"] if "schema_version" in r],
            "the refusal must appear in reasons, or the gate is unwired")

        # AND the verdict expression itself must consume it. Asserted by
        # reading the source rather than by fixture, and the reason is worth
        # recording: `ok` is ALSO False for `diff_drift is None` on any
        # synthetic receipt (no base_sha to re-derive a diff from), so no
        # fixture reachable from this test can isolate the schema term. A
        # behavioural assertion on `ok` therefore proves nothing here --
        # mutation testing showed deleting the term from the verdict left every
        # other assertion green. This check is narrow but honest about what it
        # can and cannot establish.
        source = (ROOT / "autonomy" / "lib" / "proof-verify.py").read_text()
        # rindex: verify_integrity() has its OWN result["ok"] = bool(...)
        # earlier in the file, and slicing from the FIRST match read that one
        # instead -- the assertion failed against correct code until this was
        # corrected. The verdict under test is the LAST such expression.
        verdict = source[source.rindex('result["ok"] = bool('):]
        # Terminate on the closing paren at the expression's OWN indent
        # ("\n    )"), not the first ")\n" -- the inner
        # "(not recorded_tree or ...)" line contains one and truncated the
        # slice before the schema term, failing against correct code.
        verdict = verdict[:verdict.index("\n    )")]
        self.assertIn("schema_reason is None", verdict,
                      "the schema check must be ANDed into result['ok'], not "
                      "merely appended to reasons")

    def test_a_valid_hash_cannot_rescue_an_unsupported_schema(self):
        """Integrity passing must NOT override the version refusal.

        The hash proves the bytes were not edited. It says nothing about
        whether these rules are the right ones to judge them by, so the two
        checks are ANDed rather than either-or.
        """
        path = _receipt(self.dir, "2.0")
        result = pv.verify(str(path), self.dir)
        self.assertTrue(result["hash_ok"], "fixture hash must be valid")
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
