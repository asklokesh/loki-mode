"""An index that guesses is worse than no index.

Eleven tools shipped with no way to discover them from the CLI. That is this
repo's most-repeated defect class -- built, tested, packaged, unreachable:

    v5.0.0 -> v8.64.0  auto_detect_provider() called only by its own test
    v8.73.0 -> v8.84.0 the receipt's --human explanation reached no CLI path
    v8.87.0 -> v8.89.0 preflight.sh shipped to a directory not in files[]

The index that fixes it must not introduce a softer version of the same
dishonesty. Two properties carry that weight:

  1. A tool with no description reads "(no description)". A summary guessed
     from a filename is indistinguishable, to the reader, from one the author
     wrote -- so guessing is strictly worse than the gap it fills.

  2. SHIPPED is derived from package.json files[], the same source npm reads.
     A tool present in the checkout but absent from the tarball is the v8.87.0
     defect exactly; an index that listed it alongside the reachable ones would
     have helped that release lie.

Both directions are asserted: real descriptions must survive, and a real
absence must be reported rather than filled in.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

# A stale .pyc against a hyphenated module makes mutation probes report FALSE
# failures on correct source. Set before the loader, not after.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "tool-index.py"

_spec = importlib.util.spec_from_file_location("tool_index", _TOOL)
_ti = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ti)


class DescriptionsAreReadNeverGuessed(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def _write(self, name, body):
        p = pathlib.Path(self.dir) / name
        p.write_text(body, encoding="utf-8")
        return p

    def test_python_docstring_is_read_verbatim(self):
        self._write("alpha.py", '"""Does a specific thing.\n\nMore detail.\n"""\n')
        rows = _ti.collect(self.dir)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["description"], "Does a specific thing.")

    def test_shell_header_comment_is_read(self):
        self._write("beta.sh", "#!/usr/bin/env bash\n# Beta does a thing.\n\necho hi\n")
        rows = _ti.collect(self.dir)
        self.assertEqual(rows[0]["description"], "Beta does a thing.")

    def test_a_tool_with_no_description_says_so(self):
        """The direction that matters: absence must not be filled in."""
        self._write("gamma.py", "import os\nprint(os)\n")
        rows = _ti.collect(self.dir)
        self.assertEqual(
            rows[0]["description"], _ti.NO_DESC,
            "a missing description was invented; a guessed summary is "
            "indistinguishable from an authored one to the reader")

    def test_a_hash_inside_a_string_is_not_mistaken_for_a_comment(self):
        """Parsed, not regexed. A regex would report '# not a comment'."""
        self._write("delta.py", 'x = "# not a comment"\n')
        rows = _ti.collect(self.dir)
        self.assertEqual(rows[0]["description"], _ti.NO_DESC)

    def test_a_syntactically_broken_tool_does_not_crash_the_index(self):
        self._write("broken.py", "def (:\n")
        rows = _ti.collect(self.dir)
        self.assertEqual(rows[0]["description"], _ti.NO_DESC)


class ShippingIsDerivedNeverAssumed(unittest.TestCase):
    def test_a_covering_directory_entry_ships(self):
        self.assertTrue(_ti.ships("tools/x.py", ["tools/"]))

    def test_an_exact_entry_ships(self):
        self.assertTrue(_ti.ships("tools/x.py", ["tools/x.py"]))

    def test_an_uncovered_tool_is_reported_not_shipped(self):
        """v8.87.0 in miniature: present in the checkout, absent from npm."""
        self.assertFalse(_ti.ships("scripts/x.sh", ["tools/"]))

    def test_an_unreadable_manifest_reads_unknown_not_unshipped(self):
        """Absent measurement is UNKNOWN. Reporting False would be a claim."""
        self.assertIsNone(_ti.ships("tools/x.py", None))


class TheRealToolsAreListed(unittest.TestCase):
    def test_this_repos_tools_are_found_and_described(self):
        rows = _ti.collect()
        self.assertGreater(len(rows), 5, "the real tools/ dir was not read")
        named = {r["name"]: r for r in rows}
        for expected in ("cost-guard.py", "receipt-diff.py", "preflight.sh"):
            with self.subTest(tool=expected):
                self.assertIn(expected, named)
                self.assertNotEqual(
                    named[expected]["description"], _ti.NO_DESC,
                    "%s lost its description" % expected)

    def test_every_listed_tool_reports_a_shipping_state(self):
        for r in _ti.collect():
            with self.subTest(tool=r["name"]):
                self.assertIn(r["shipped"], (True, False, None))


class EmptyIsNotSuccess(unittest.TestCase):
    def test_no_tools_exits_non_zero(self):
        empty = tempfile.mkdtemp()
        rc = subprocess.run(
            [sys.executable, str(_TOOL), "--tools-dir", empty],
            capture_output=True, text=True, timeout=60).returncode
        self.assertEqual(rc, 2, "an empty tools/ dir reported success")

    def test_json_mode_is_parseable(self):
        r = subprocess.run(
            [sys.executable, str(_TOOL), "--json"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["count"], len(payload["tools"]))


if __name__ == "__main__":
    unittest.main()
