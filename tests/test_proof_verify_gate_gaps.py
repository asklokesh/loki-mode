"""An honest receipt must not be accused of forgery.

proof-verify re-derives the headline from the recorded facts and reports any
mismatch as "the headline was edited to misrepresent the facts". That is the
strongest claim this tool makes, and it must only ever fire on a proof that was
actually edited.

v8.19.0 appended a degraded entry for every disabled trust gate. The generator
appends them AFTER computing the headline, deliberately, so the verdict does not
move. The verifier re-derived WITH them, and _compute_headline only cares whether
the degraded list is non-empty -- so a run with security switched off recorded
"VERIFIED" and re-derived "VERIFIED WITH GAPS".

Measured end to end through the real generator before the fix:

    gates ON       recorded='VERIFIED'  re-derived='VERIFIED'            consistent
    security OFF   recorded='VERIFIED'  re-derived='VERIFIED WITH GAPS'  MISMATCH

The user was told their honest proof had been edited to misrepresent the facts.
For a product whose whole claim is verifiable trust, a false accusation of
tampering is worse than the gap it was trying to surface.

THE PROPERTY THAT MUST NOT REGRESS: excluding those entries must not blind the
verifier. A genuinely tampered proof, and a genuine gap recorded by the
generator BEFORE the headline, both still count.
"""

import importlib.util
import json
import os
import unittest

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_TESTS_DIR)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:  # pragma: no cover - CLI entry point
        pass
    return mod


_CLEAN_FACTS = {
    "tests": {"status": "verified", "command": "npm test"},
    "build": {"ran": True, "status": "passed"},
    "git": {"diff": {"count": 2}},
}


class HeadlineRederivationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pv = _load("pv", os.path.join(_ROOT, "autonomy", "lib", "proof-verify.py"))

    def test_disabled_gate_entries_are_filtered_before_rederivation(self):
        """The bug: they were never an input to the recorded value.

        The filter lives in _recorded_degraded_raw (what the verifier feeds to
        _compute_headline), not in _compute_headline itself -- that function is
        shared with the generator and must keep treating every list it is given
        as real. Asserting at the wrong layer would test the wrong contract.
        """
        proof = {"honesty": {"degraded": [
            {"item": "security", "status": "disabled"},
        ]}}
        self.assertEqual(
            self.pv._recorded_degraded_raw(proof), [],
            "a post-hoc gate entry reached the re-derivation, which moves the "
            "headline and makes the verifier report a forged proof")

    def test_the_post_headline_flag_is_filtered(self):
        """The PRIMARY condition, and it was untested.

        The filter has two arms: the explicit post_headline flag, and a legacy
        status=="disabled" check kept for proofs written before the flag
        existed. Every fixture in this file used the legacy shape, so the arm
        that real generator output actually takes was never exercised --
        breaking it left this suite green.

        Found by mutation probe, not by reading: probing the primary arm
        reported MUTATION SURVIVED while probing the legacy arm reported it
        caught. Two arms, one covered.
        """
        proof = {"honesty": {"degraded": [
            {"item": "security", "status": "not_run", "post_headline": True},
        ]}}
        self.assertEqual(
            self.pv._recorded_degraded_raw(proof), [],
            "a flagged post-headline entry reached the re-derivation; the "
            "verifier will report this honest proof as forged")

    def test_both_filter_arms_are_exercised(self):
        """A post-headline entry whose status is NOT 'disabled' must still go.

        This is the case the legacy arm cannot catch, so it pins the two arms
        apart: if someone removes the flag check and keeps only the status
        check, this fails while the legacy test still passes.
        """
        proof = {"honesty": {"degraded": [
            {"item": "future_check", "status": "brand_new_status",
             "post_headline": True},
            {"item": "build", "status": "not_run"},
        ]}}
        kept = self.pv._recorded_degraded_raw(proof)
        self.assertEqual([g.get("item") for g in kept], ["build"])

    def test_the_filter_keeps_real_gaps(self):
        proof = {"honesty": {"degraded": [
            {"item": "security", "status": "disabled"},
            {"item": "build", "status": "not_run"},
        ]}}
        kept = self.pv._recorded_degraded_raw(proof)
        self.assertEqual([g.get("item") for g in kept], ["build"])

    # --- THE PROPERTY: the verifier must not go blind -----------------------
    def test_a_genuinely_tampered_proof_is_still_caught(self):
        """Facts say not_run; a headline claiming VERIFIED must not re-derive."""
        tampered = {"tests": {"status": "not_run"}, "build": {"ran": False},
                    "git": {"diff": {"count": 0}}}
        self.assertEqual(self.pv._compute_headline(tampered, []), "NOT VERIFIED")

    def test_a_real_gap_still_counts(self):
        """Only status=disabled is excluded, not every degraded entry."""
        self.assertEqual(
            self.pv._compute_headline(
                _CLEAN_FACTS, [{"item": "build", "status": "not_run"}]),
            "VERIFIED WITH GAPS")

    def test_a_non_dict_degraded_entry_still_counts(self):
        """Legacy proofs store bare strings; those are real gaps."""
        self.assertEqual(
            self.pv._compute_headline(_CLEAN_FACTS, ["build"]),
            "VERIFIED WITH GAPS")

    def test_mixed_entries_keep_the_real_one(self):
        self.assertEqual(
            self.pv._compute_headline(
                _CLEAN_FACTS,
                [{"item": "security", "status": "disabled"},
                 {"item": "build", "status": "not_run"}]),
            "VERIFIED WITH GAPS")


class EndToEndConsistencyTests(unittest.TestCase):
    """Generator and verifier must agree on a REAL proof.

    The per-function tests above would pass against a verifier that never saw a
    real generator payload. This drives both halves.
    """

    @classmethod
    def setUpClass(cls):
        cls.tpg = _load("tpg", os.path.join(_TESTS_DIR, "test_proof_generator.py"))
        cls.pv = _load("pv", os.path.join(_ROOT, "autonomy", "lib", "proof-verify.py"))

    def setUp(self):
        class _Harness(self.tpg.IncludeDiffsTests):
            def runTest(self):  # pragma: no cover - harness only
                pass

        self.h = _Harness()
        self.h.setUp()
        proj = self.h._git_repo_with_change()
        self.loki = os.path.join(proj, ".loki")
        os.makedirs(os.path.join(self.loki, "quality"), exist_ok=True)
        with open(os.path.join(self.loki, "quality", "test-results.json"), "w") as f:
            json.dump({"status": "verified", "command": "npm test",
                       "exit_code": 0}, f)
        with open(os.path.join(self.loki, "quality", "build-results.json"), "w") as f:
            json.dump({"ran": True, "status": "passed", "exit_code": 0}, f)
        self._n = 0

    def _run(self, **phases):
        self._n += 1
        env = {"_LOKI_RUN_START_SHA": "HEAD~1"}
        env.update(phases)
        return self.tpg._run_generator(
            self.loki, os.path.join(self.h.tmp, "e%d" % self._n), env_extra=env)

    def _consistent(self, proof):
        recorded = (proof.get("honesty") or {}).get("headline")
        derived = self.pv._compute_headline(
            proof.get("facts") or {}, self.pv._recorded_degraded_raw(proof))
        return recorded, derived, recorded == derived

    def test_a_clean_run_is_consistent(self):
        rec, der, ok = self._consistent(self._run())
        self.assertTrue(ok, "recorded %r vs re-derived %r" % (rec, der))

    def test_a_run_with_gates_off_is_not_accused_of_forgery(self):
        for phases in ({"LOKI_PHASE_SECURITY": "false"},
                       {"LOKI_PHASE_CODE_REVIEW": "false",
                        "LOKI_PHASE_SECURITY": "false"}):
            with self.subTest(phases=sorted(phases)):
                rec, der, ok = self._consistent(self._run(**phases))
                self.assertTrue(
                    ok,
                    "an honest proof re-derives differently (%r vs %r), so the "
                    "verifier tells the user it was edited to misrepresent the "
                    "facts" % (rec, der))


if __name__ == "__main__":
    unittest.main()
