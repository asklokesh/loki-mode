"""tests/test-checklist-determine-item-status.py

Wave-B #5 trust gate: autonomy/checklist-verify.py determine_item_status().

This is the ONLY code mapping an item's per-check verification results to a
status string (verified/failing/pending), and every completion gate keys off
it. Its None-handling is LOAD-BEARING: a check returning None (inconclusive)
must set all_passed=False so the item resolves to "pending", NEVER "verified".
If a refactor let an inconclusive become verified, an item with no passing
evidence would read verified and the council would ship the build done -- a
fake-green.

The function is called directly with a list of {"passed": ...} dicts (the
shape run_check() returns). Status strings asserted are the REAL return
values read from source: "pending", "verified", "failing".
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load_module():
    here = Path(__file__).resolve().parent.parent
    path = here / "autonomy" / "checklist-verify.py"
    spec = importlib.util.spec_from_file_location("loki_checklist_verify", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _checks(*passed_values):
    return [{"passed": p} for p in passed_values]


class DetermineItemStatus(unittest.TestCase):
    def setUp(self):
        self.determine = _load_module().determine_item_status

    def test_empty_is_pending(self):
        # No verification checks at all -> no evidence -> pending, never verified.
        self.assertEqual(self.determine([]), "pending")

    def test_all_true_is_verified(self):
        self.assertEqual(self.determine(_checks(True, True)), "verified")

    def test_true_then_none_is_pending(self):
        # LOAD-BEARING: one passing check plus one inconclusive (None) must be
        # pending, never verified. A None is not passing evidence; letting it
        # resolve verified would be the fake-green this gate exists to catch.
        self.assertEqual(self.determine(_checks(True, None)), "pending")

    def test_true_then_false_is_failing(self):
        self.assertEqual(self.determine(_checks(True, False)), "failing")

    def test_single_none_is_pending(self):
        self.assertEqual(self.determine(_checks(None)), "pending")

    def test_single_false_is_failing(self):
        self.assertEqual(self.determine(_checks(False)), "failing")


if __name__ == "__main__":
    unittest.main()
