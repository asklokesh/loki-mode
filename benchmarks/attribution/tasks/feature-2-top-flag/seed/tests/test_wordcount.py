import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import wordcount


class UnchangedBehaviorTest(unittest.TestCase):
    def test_count_words_lowercases_and_keeps_apostrophes(self):
        c = wordcount.count_words("Don't STOP don't")
        self.assertEqual(c["don't"], 2)
        self.assertEqual(c["stop"], 1)

    def test_count_words_empty(self):
        self.assertEqual(len(wordcount.count_words("")), 0)

    def test_main_prints_sorted_rows_and_returns_zero(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "in.txt")
            with open(f, "w", encoding="utf-8") as fh:
                fh.write("b a b c a b")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = wordcount.main([f])
        self.assertEqual(rc, 0)
        self.assertEqual(buf.getvalue().splitlines(), ["3 b", "2 a", "1 c"])


if __name__ == "__main__":
    unittest.main()
