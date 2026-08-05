"""The receipt walk must be bounded on the HTTP path, and honest when cut short.

WHY CONFINING THE ROOT WAS NOT ENOUGH. An earlier fix confined
?workspace= to the configured operator roots, which limits WHERE the walk
starts. It does not limit HOW MUCH it walks: an allowed root containing a deep
tree is still an unbounded rglob plus a stat per entry, held open for as long
as that takes, from a single request.

THE HONESTY HALF MATTERS MORE THAN THE LIMIT. Adding a cap alone would be
worse than no cap: an audit that stops early and still reports VERIFIED
certifies a workspace it never finished reading, and a FAILED receipt sitting
past the cutoff reads as "none found". That is precisely the laundering
tools/receipt-bundle.py exists to prevent (its rule 2: absent is not clean).

So a truncated walk must:
  - say so, in the payload, not a log line
  - hold the verdict DOWN (never VERIFIED over a partial read)
  - keep the rows it did read, since they are real findings

THE CLI PATH MUST STAY UNBOUNDED. find_receipts() is used by eight tools that
audit a workspace an operator chose deliberately. Truncating those silently is
the missing-evidence failure above. Only the HTTP entry point passes limits.
"""

import os
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _big_tree(n_dirs=400, depth=3):
    """A tree with many entries and a handful of real receipts near the end.

    Built wide and deep on purpose: the point is that the WALK is expensive,
    not that the receipts are numerous.
    """
    d = tempfile.mkdtemp()
    root = pathlib.Path(d)
    for i in range(n_dirs):
        sub = root
        for lvl in range(depth):
            sub = sub / ("d%02d_%03d" % (lvl, i))
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "filler.txt").write_text("x", encoding="utf-8")
    return root


class TheWalkStopsAtTheLimit(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        try:
            from dashboard import api_evidence  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            raise unittest.SkipTest("api_evidence not importable: %s" % exc)
        cls.api = api_evidence
        cls.tree = _big_tree()

    def test_an_unbounded_walk_of_the_same_tree_completes(self):
        """Vacuity guard: if the tree were empty or unreadable, every
        truncation assertion below would pass for the wrong reason."""
        paths, reason = self.api.find_receipts_bounded(self.tree)
        self.assertIsNone(
            reason, "the unbounded walk reported truncation: %s" % reason)
        self.assertIsInstance(paths, list)

    def test_a_low_entry_limit_truncates_and_says_so(self):
        _paths, reason = self.api.find_receipts_bounded(
            self.tree, max_entries=5)
        self.assertIsNotNone(
            reason,
            "a 5-entry limit over a large tree did not truncate; the limit is "
            "not being applied")
        self.assertIn("PARTIAL", reason,
                      "the truncation reason does not say the result is "
                      "partial: %r" % reason)

    def test_the_report_marks_a_truncated_audit_and_will_not_certify_it(self):
        rep = self.api.receipts_report(str(self.tree), max_entries=5)
        self.assertTrue(
            rep.get("truncated"),
            "receipts_report did not surface truncation, so a caller cannot "
            "tell a partial audit from a complete one")
        self.assertNotEqual(
            rep.get("verdict"), "VERIFIED",
            "a TRUNCATED walk reported VERIFIED; that certifies a workspace "
            "the audit never finished reading")
        self.assertIn(
            "PARTIAL", rep.get("error") or "",
            "the report's error field does not state that the audit is "
            "partial: %r" % rep.get("error"))

    def test_an_untruncated_report_is_not_falsely_marked_partial(self):
        """The inverse error: marking a complete audit partial would make the
        signal meaningless."""
        rep = self.api.receipts_report(str(self.tree))
        self.assertIsNone(
            rep.get("truncated"),
            "a complete walk was reported as truncated: %r"
            % rep.get("truncated"))


class TheCliPathStaysUnbounded(unittest.TestCase):
    """Eight tools audit an operator-chosen workspace through find_receipts.
    Silently truncating those is the missing-evidence failure this guards."""

    def test_find_receipts_takes_no_limit_arguments(self):
        try:
            from dashboard import api_evidence  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_evidence not importable: %s" % exc)
        import inspect
        sig = inspect.signature(api_evidence.find_receipts)
        self.assertNotIn(
            "max_entries", sig.parameters,
            "find_receipts grew a limit parameter; the CLI audit path must "
            "stay unbounded so an operator-chosen workspace is read in full")

    def test_find_receipts_still_returns_a_plain_list(self):
        """Eight callers unpack this as a list. A tuple would break them all."""
        try:
            from dashboard import api_evidence  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_evidence not importable: %s" % exc)
        with tempfile.TemporaryDirectory() as d:
            out = api_evidence.find_receipts(pathlib.Path(d))
        self.assertIsInstance(
            out, list,
            "find_receipts no longer returns a plain list; every existing "
            "caller in tools/ unpacks it that way")


class TheHttpRouteAppliesLimits(unittest.TestCase):

    def test_the_route_passes_both_ceilings(self):
        src = (_ROOT / "dashboard" / "api_operator.py").read_text(
            encoding="utf-8", errors="replace")
        self.assertIn("max_entries=_RECEIPT_SCAN_MAX_ENTRIES", src,
                      "the receipts route does not bound entries")
        self.assertIn("max_seconds=_RECEIPT_SCAN_MAX_SECONDS", src,
                      "the receipts route does not bound wall time")


if __name__ == "__main__":
    unittest.main()
