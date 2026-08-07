"""Quality gates read from the receipt, and NEVER invent a result.

THE DEFECT, found by running the shipping dashboard. The Quality page showed
all 8 gates as PENDING with "Last checked: Never" on a repo holding 9 receipts.
That was not a display bug: /api/council/gate falls back to
_DEFAULT_QUALITY_GATES when .loki/council/gate-block.json is absent, and those
entries carry no last_checked, so the UI honestly rendered "Never" for every
gate while .loki/proofs/ held the real per-gate results the whole time.

TEST test_absent_gates_stay_pending IS THE ONE THAT MATTERS. Receipts here name
only 3 of the 8 gates (static_analysis, code_review, doc_coverage). The
tempting fix -- mark everything green because "the run passed" -- is the exact
false-green this codebase exists to prevent. A gate that never ran must keep
status "pending" and carry NO timestamp: an absent measurement is not a result.

Also pinned: the snake_case -> display-name mapping is explicit, not derived. A
lower()/replace() heuristic silently mis-maps "Test Suite" onto "test_coverage"
and "Test Mutation" onto "mutation_integrity", which are different gates.
"""

import json
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
SERVER = REPO / "dashboard" / "server.py"


def _load():
    """Exec the three real definitions out of server.py.

    Reads the shipped source rather than importing the whole FastAPI app (which
    needs optional deps), and rather than copying the logic -- a copy would
    drift from the implementation without failing.
    """
    src = SERVER.read_text()
    ns = {"json": json}
    for pattern in (
        r"_RECEIPT_GATE_NAMES = \{.*?\n\}\n",
        r"_RECEIPT_GATE_STATUS = \{.*?\n\}\n",
        r"_DEFAULT_QUALITY_GATES = \[.*?\n\]\n",
        r"def _receipt_backed_gates\(\):.*?\n    return gates\n",
    ):
        match = re.search(pattern, src, re.S)
        assert match, f"could not extract {pattern!r} from server.py"
        exec(match.group(0), ns)  # noqa: S102 - reading our own source
    return ns


class QualityGatesFromReceiptTest(unittest.TestCase):
    def setUp(self):
        self.ns = _load()

    def _gates(self, loki_dir):
        self.ns["_get_loki_dir"] = lambda: pathlib.Path(loki_dir)
        return {g["name"]: g for g in self.ns["_receipt_backed_gates"]()}

    def _write_receipt(self, tmp, gates, generated_at="2026-01-01T00:00:00Z"):
        d = pathlib.Path(tmp) / "proofs" / "20260101T000000Z-test"
        d.mkdir(parents=True, exist_ok=True)
        (d / "proof.json").write_text(json.dumps({
            "generated_at": generated_at,
            "quality_gates": {"gates": gates},
        }))

    def test_receipt_results_reach_the_page(self):
        """THE DEFECT: a real result must replace 'pending'/'Never'.

        Status is asserted in the CLIENT's vocabulary. Receipts say
        "passed"/"failed"; loki-quality-gates.js:51 switches on "pass"/"fail".
        Passing the receipt's word through unchanged matched nothing, so every
        gate fell back to "pending" -- the page showed real timestamps beside
        eight PENDING badges and a "0 Pass, 0 Fail, 8 Pending" summary. Half
        fixed, and only visible by loading the page, which is why this asserts
        the translated value rather than the receipt's.
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self._write_receipt(tmp, [
                {"name": "static_analysis", "status": "passed"},
                {"name": "code_review", "status": "failed"},
            ])
            g = self._gates(tmp)
            self.assertEqual(g["Static Analysis"]["status"], "pass")
            self.assertEqual(g["Blind Code Review"]["status"], "fail")
            self.assertEqual(g["Static Analysis"]["last_checked"],
                             "2026-01-01T00:00:00Z")

    def test_unknown_status_word_stays_pending(self):
        """An unrecognised status must NOT be guessed into a pass.

        Treating any unknown word as a pass is how a future status string
        silently becomes a green badge.
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self._write_receipt(tmp, [
                {"name": "static_analysis", "status": "quantum"},
            ])
            g = self._gates(tmp)
            self.assertEqual(g["Static Analysis"]["status"], "pending")
            self.assertNotIn("last_checked", g["Static Analysis"])

    def test_client_vocabulary_matches_the_ui(self):
        """Every mapped status must be one the UI actually switches on."""
        self.assertEqual(set(self.ns["_RECEIPT_GATE_STATUS"].values()),
                         {"pass", "fail"})

    def test_absent_gates_stay_pending(self):
        """THE GUARD AGAINST FALSE GREEN.

        A receipt naming 2 gates must not colour the other 6. They keep
        "pending" AND carry no timestamp -- claiming a check time for a check
        that never ran is the more dangerous half.
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self._write_receipt(tmp, [
                {"name": "static_analysis", "status": "passed"},
                {"name": "code_review", "status": "passed"},
            ])
            g = self._gates(tmp)
            for name in ("Test Suite", "Anti-Sycophancy", "Mock Integrity",
                         "Test Mutation", "Documentation Coverage",
                         "Magic Modules Debate"):
                self.assertEqual(g[name]["status"], "pending",
                                 f"{name} inherited a result it never earned")
                self.assertNotIn("last_checked", g[name],
                                 f"{name} claims a check time but never ran")

    def test_no_receipts_degrades_to_defaults(self):
        """An empty .loki/ must not raise; it must read as pending."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            g = self._gates(tmp)
            self.assertEqual(len(g), 8)
            self.assertTrue(all(x["status"] == "pending" for x in g.values()))

    def test_malformed_receipt_fails_open(self):
        """A corrupt receipt degrades to pending, never breaks the page."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            d = pathlib.Path(tmp) / "proofs" / "bad"
            d.mkdir(parents=True)
            (d / "proof.json").write_text("{not json")
            g = self._gates(tmp)
            self.assertEqual(len(g), 8)
            self.assertTrue(all(x["status"] == "pending" for x in g.values()))

    def test_newest_receipt_wins(self):
        """Two receipts: the latest result is the current one."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            for run, status in (("20260101T000000Z-a", "failed"),
                                ("20260202T000000Z-b", "passed")):
                d = pathlib.Path(tmp) / "proofs" / run
                d.mkdir(parents=True)
                (d / "proof.json").write_text(json.dumps({
                    "generated_at": run[:8],
                    "quality_gates": {"gates": [
                        {"name": "static_analysis", "status": status}]},
                }))
            self.assertEqual(self._gates(tmp)["Static Analysis"]["status"],
                             "pass")

    def test_mapping_is_explicit_and_total(self):
        """Every display row must have exactly one receipt key, and vice versa.

        Guards the mis-map: "Test Suite" and "Test Mutation" both lower() to
        strings that a naive heuristic would collide with the wrong gate.
        """
        names = self.ns["_RECEIPT_GATE_NAMES"]
        displays = {g["name"] for g in self.ns["_DEFAULT_QUALITY_GATES"]}
        self.assertEqual(set(names.values()), displays,
                         "mapping and UI rows disagree")
        self.assertEqual(len(set(names.values())), len(names),
                         "two receipt keys map to the same display row")
        self.assertEqual(names["test_coverage"], "Test Suite")
        self.assertEqual(names["mutation_integrity"], "Test Mutation")

    def test_unknown_gate_name_is_ignored(self):
        """A receipt naming a gate we do not display must not crash or leak."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self._write_receipt(tmp, [
                {"name": "some_future_gate", "status": "passed"},
                {"name": "static_analysis", "status": "passed"},
            ])
            g = self._gates(tmp)
            self.assertEqual(len(g), 8)
            self.assertEqual(g["Static Analysis"]["status"], "pass")


if __name__ == "__main__":
    unittest.main()
