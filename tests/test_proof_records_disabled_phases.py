"""A receipt must be able to say what was NOT checked.

The proof recorded gates that ran and their pass counts. A gate that never ran
was simply absent from the list, so "3 of 3 gates passed" read identically
whether every gate executed or code review and security were switched off and
three lesser gates ran instead.

For a product whose central claim is verification, that is the failure that
matters most: recording only successes is how a green badge stops meaning
anything. A reader of the receipt could not distinguish a fully verified run
from one that skipped verification, and nothing in the artifact was false --
the information was simply missing.

Phases are legitimately configurable, and this does not change that. It records
the choice so the receipt reflects the run that actually happened.

THE PROPERTY: an ordinary run records an EMPTY list, not a misleading one.
If a normal run reported phantom disabled phases, the field would be noise and
would be ignored, which is worse than not having it.
"""

import importlib.util
import os
import tempfile
import unittest

_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "autonomy", "lib", "proof-generator.py")


def _load():
    spec = importlib.util.spec_from_file_location("proof_generator", _SRC)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:  # pragma: no cover - module has a CLI entry point
        pass
    return mod


class ProofDisabledPhaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def setUp(self):
        self._saved = {k: v for k, v in os.environ.items()
                       if k.startswith("LOKI_PHASE_")}
        for key in list(self._saved):
            os.environ.pop(key, None)
        self._dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self._dir, "quality"), exist_ok=True)

    def tearDown(self):
        for key in [k for k in os.environ if k.startswith("LOKI_PHASE_")]:
            os.environ.pop(key, None)
        os.environ.update(self._saved)

    def _collect(self, **env):
        os.environ.update(env)
        return self.mod._collect_quality_gates(self._dir)

    def test_ordinary_run_records_an_empty_list(self):
        """THE PROPERTY. A phantom entry here would make the field noise."""
        result = self._collect()
        self.assertEqual(result["disabled_phases"], [])
        self.assertTrue(result["all_phases_enabled"])

    def test_a_disabled_trust_gate_is_recorded(self):
        result = self._collect(LOKI_PHASE_CODE_REVIEW="false")
        self.assertIn(
            "code_review", result["disabled_phases"],
            "a receipt cannot claim verification while hiding that code review "
            "was switched off")
        self.assertFalse(result["all_phases_enabled"])

    def test_multiple_disabled_phases_are_all_recorded(self):
        result = self._collect(LOKI_PHASE_CODE_REVIEW="false",
                               LOKI_PHASE_SECURITY="0")
        self.assertEqual(
            sorted(result["disabled_phases"]), ["code_review", "security"])

    def test_the_off_vocabulary_is_honoured(self):
        """false / 0 / no / off all mean off, and this repo uses several."""
        for value in ("false", "FALSE", "0", "no", "off"):
            with self.subTest(value=value):
                for key in [k for k in os.environ if k.startswith("LOKI_PHASE_")]:
                    os.environ.pop(key, None)
                result = self._collect(LOKI_PHASE_SECURITY=value)
                self.assertIn("security", result["disabled_phases"])

    def test_an_explicitly_enabled_phase_is_not_recorded_as_disabled(self):
        """Setting a phase to true must not read as turning it off."""
        result = self._collect(LOKI_PHASE_SECURITY="true")
        self.assertEqual(result["disabled_phases"], [])
        self.assertTrue(result["all_phases_enabled"])

    def test_existing_gate_fields_are_untouched(self):
        """Adding provenance must not disturb what the receipt already says."""
        result = self._collect()
        for field in ("passed", "total", "gates"):
            self.assertIn(field, result)


class ProofInterventionDetailTests(unittest.TestCase):
    """interventions_detail rides along only when the counter file has it."""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def _journey(self, iv):
        import json
        d = tempfile.mkdtemp()
        st = os.path.join(d, "state")
        os.makedirs(st)
        with open(os.path.join(st, "issue-context.json"), "w") as f:
            json.dump({"issue": {"ref": "o/r#1"}}, f)
        if iv is not None:
            with open(os.path.join(st, "interventions.json"), "w") as f:
                json.dump(iv, f)
        return self.mod._collect_journey(d)

    def test_detail_present_when_file_has_it(self):
        out = self._journey({"count": 2, "by_type": {"input": 1, "authorization": 1},
                             "waited_s": 240})
        self.assertEqual(out["interventions"], 2)
        self.assertEqual(out["interventions_detail"]["waited_s"], 240)
        self.assertEqual(out["interventions_detail"]["by_type"],
                         {"steer": 0, "input": 1, "authorization": 1, "repair": 0})

    def test_active_s_reaches_detail_when_recorded(self):
        out = self._journey({"count": 1, "by_type": {"input": 1}, "waited_s": 60,
                             "active_s": 45})
        self.assertEqual(out["interventions_detail"]["active_s"], 45)

    def test_active_s_absent_stays_absent_not_zero(self):
        out = self._journey({"count": 1, "by_type": {"input": 1}, "waited_s": 60})
        self.assertNotIn("active_s", out["interventions_detail"])

    def test_legacy_count_only_file_has_no_detail(self):
        out = self._journey({"count": 1})
        self.assertEqual(out["interventions"], 1)
        self.assertNotIn("interventions_detail", out)

    def test_absent_file_is_unmeasured_not_zero(self):
        out = self._journey(None)
        self.assertNotIn("interventions", out)
        self.assertNotIn("interventions_detail", out)


if __name__ == "__main__":
    unittest.main()
