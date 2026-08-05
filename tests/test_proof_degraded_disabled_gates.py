"""A switched-off trust gate belongs in the honesty ledger.

_compute_degraded's own docstring states the point of the ledger: "a reader sees
exactly what was NOT verified rather than inferring it from silence". A gate the
operator switched off is exactly that, and it was missing.

Measured through the REAL generator, not a hand-built proof: a run with code
review and security disabled listed only "build" as its gap, while two
correctness checks had not run at all. The receipt was accurate about what it
mentioned and silent about what mattered most.

WHY THIS DOES NOT CHANGE THE HEADLINE, which is the load-bearing design choice:
the entries are appended AFTER _compute_headline runs. Feeding them in would
change what "Verified" MEANS, and this file already records that kind of change
as a trust-semantics decision for the council and founder rather than something
to infer (see the FV-2 note on the functional fact, which is deliberately
recorded but not gated on). This is the record half. The gap becomes visible
without the verdict moving under anyone.
"""

import importlib.util
import json
import os
import unittest

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:  # pragma: no cover - CLI entry point
        pass
    return mod


class DegradedListsDisabledGatesTests(unittest.TestCase):
    """Drives the real proof generator over a real git repo."""

    @classmethod
    def setUpClass(cls):
        cls.tpg = _load("tpg", os.path.join(_TESTS_DIR, "test_proof_generator.py"))

    def setUp(self):
        class _Harness(self.tpg.IncludeDiffsTests):
            def runTest(self):  # pragma: no cover - harness only
                pass

        self.h = _Harness()
        self.h.setUp()
        self.proj = self.h._git_repo_with_change()
        self.loki = os.path.join(self.proj, ".loki")
        os.makedirs(os.path.join(self.loki, "quality"), exist_ok=True)
        with open(os.path.join(self.loki, "quality", "test-results.json"), "w") as f:
            json.dump({"status": "verified", "command": "npm test",
                       "exit_code": 0}, f)
        self._n = 0

    def _run(self, **phases):
        self._n += 1
        env = {"_LOKI_RUN_START_SHA": "HEAD~1"}
        env.update(phases)
        return self.tpg._run_generator(
            self.loki, os.path.join(self.h.tmp, "out%d" % self._n), env_extra=env)

    @staticmethod
    def _gaps(proof):
        return [g.get("item") for g in ((proof.get("honesty") or {}).get("degraded") or [])
                if isinstance(g, dict)]

    def test_disabled_trust_gates_appear_as_gaps(self):
        proof = self._run(LOKI_PHASE_CODE_REVIEW="false",
                          LOKI_PHASE_SECURITY="false")
        gaps = self._gaps(proof)
        self.assertIn("code_review", gaps)
        self.assertIn("security", gaps)

    def test_the_gap_entry_explains_itself(self):
        proof = self._run(LOKI_PHASE_CODE_REVIEW="false")
        entry = next(g for g in proof["honesty"]["degraded"]
                     if g.get("item") == "code_review")
        self.assertEqual(entry.get("status"), "disabled")
        self.assertIn("never ran", entry.get("reason", ""))

    def test_an_ordinary_run_gains_no_extra_gaps(self):
        """No phantom entries: the ledger must not cry wolf on a normal run."""
        gaps = self._gaps(self._run())
        self.assertNotIn("code_review", gaps)
        self.assertNotIn("security", gaps)

    def test_non_trust_phases_are_not_listed_as_gaps(self):
        """Performance and research do not bear on correctness.

        Listing them would pad the honesty ledger with entries that do not mean
        the work is less verified, and a padded ledger gets skimmed.
        """
        gaps = self._gaps(self._run(LOKI_PHASE_PERFORMANCE="false",
                                    LOKI_PHASE_WEB_RESEARCH="false"))
        self.assertNotIn("performance", gaps)
        self.assertNotIn("web_research", gaps)

    def test_the_headline_is_unchanged_by_the_added_gaps(self):
        """THE LOAD-BEARING PROPERTY.

        Changing what "Verified" means is a founder/council decision. This is
        the record half only: the same run must produce the same headline
        whether or not the gate entries were appended.
        """
        base = self._run()
        off = self._run(LOKI_PHASE_CODE_REVIEW="false",
                        LOKI_PHASE_SECURITY="false")
        self.assertEqual(base["honesty"]["headline"], off["honesty"]["headline"],
                         "the verdict moved; that is a trust-semantics change "
                         "this commit deliberately does not make")

    def test_existing_gaps_are_preserved(self):
        """The added entries must append, not replace."""
        base_gaps = self._gaps(self._run())
        off_gaps = self._gaps(self._run(LOKI_PHASE_SECURITY="false"))
        for item in base_gaps:
            self.assertIn(item, off_gaps)


class OwnerPageOnARealProofTests(DegradedListsDisabledGatesTests):
    """End-to-end: generator output through the owner-facing renderer.

    Every per-surface test in this area passed while the surfaces disagreed or
    duplicated each other. Only rendering a REAL generated proof showed the
    owner reading "code_review was switched off" three times in four lines --
    once from the summary line added in v8.18.1 and twice from the ledger
    entries added in v8.19.0. Repetition in a section about what went wrong
    reads as three separate problems.
    """

    def test_a_real_proof_names_each_disabled_gate_exactly_once(self):
        proof = self._run(LOKI_PHASE_CODE_REVIEW="false",
                          LOKI_PHASE_SECURITY="false")
        own = _load("own_render",
                    os.path.join(os.path.dirname(_TESTS_DIR),
                                 "autonomy", "lib", "own-render.py"))
        out = "\n".join(own._section_is_it_working(proof, "r1"))
        self.assertIn("code_review", out)
        self.assertIn("security", out)
        self.assertEqual(out.count("code_review"), 1,
                         "the owner reads the same gate more than once, which "
                         "looks like separate problems")
        self.assertEqual(out.count("security"), 1)

    def test_a_real_proof_still_blocks_the_ready_badge(self):
        proof = self._run(LOKI_PHASE_SECURITY="false")
        own = _load("own_render",
                    os.path.join(os.path.dirname(_TESTS_DIR),
                                 "autonomy", "lib", "own-render.py"))
        self.assertFalse(own._is_ready(proof))

    def test_a_real_clean_proof_says_nothing_about_gates(self):
        proof = self._run()
        own = _load("own_render",
                    os.path.join(os.path.dirname(_TESTS_DIR),
                                 "autonomy", "lib", "own-render.py"))
        out = "\n".join(own._section_is_it_working(proof, "r1"))
        self.assertNotIn("switched off for this run", out)


class PostHeadlineMarkerTests(DegradedListsDisabledGatesTests):
    """Post-headline entries carry an explicit marker, not a status string.

    The verifier must skip entries the generator appended AFTER computing the
    headline, or it re-derives a different verdict and reports an honest proof
    as forged (v8.19.2). That filter originally matched status == "disabled".

    A status-string filter is fragile in a specific way: it works until the next
    post-headline entry arrives with a different status, and then it fails
    silently and re-introduces the false forgery accusation. An explicit flag
    states the INTENT, so any future entry is covered by construction.
    """

    def test_disabled_gate_entries_carry_the_marker(self):
        proof = self._run(LOKI_PHASE_SECURITY="false")
        entry = next(g for g in proof["honesty"]["degraded"]
                     if g.get("item") == "security")
        self.assertIs(entry.get("post_headline"), True)

    def test_the_verifier_filters_on_the_marker(self):
        pv = _load("pv", os.path.join(os.path.dirname(_TESTS_DIR),
                                      "autonomy", "lib", "proof-verify.py"))
        # A future post-headline entry with a status the old filter never knew.
        proof = {"honesty": {"degraded": [
            {"item": "future_check", "status": "some_new_status",
             "post_headline": True},
        ]}}
        self.assertEqual(
            pv._recorded_degraded_raw(proof), [],
            "a post-headline entry with an unfamiliar status reached the "
            "re-derivation, which is how the false forgery accusation returns")

    def test_legacy_disabled_entries_are_still_filtered(self):
        """Proofs from v8.19.0-v8.19.2 predate the flag."""
        pv = _load("pv", os.path.join(os.path.dirname(_TESTS_DIR),
                                      "autonomy", "lib", "proof-verify.py"))
        proof = {"honesty": {"degraded": [
            {"item": "security", "status": "disabled"},
        ]}}
        self.assertEqual(pv._recorded_degraded_raw(proof), [])

    def test_real_gaps_are_never_filtered(self):
        pv = _load("pv", os.path.join(os.path.dirname(_TESTS_DIR),
                                      "autonomy", "lib", "proof-verify.py"))
        proof = {"honesty": {"degraded": [
            {"item": "build", "status": "not_run"},
        ]}}
        self.assertEqual(
            [g.get("item") for g in pv._recorded_degraded_raw(proof)], ["build"])


if __name__ == "__main__":
    unittest.main()
