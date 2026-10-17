import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from dedupe import dedupe


class UnchangedBehaviorTest(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(dedupe([]), [])

    def test_returns_list_without_duplicates(self):
        out = dedupe([4, 5, 4, 6, 5])
        self.assertIsInstance(out, list)
        self.assertEqual(sorted(out), [4, 5, 6])

    def test_all_unique_keeps_every_value(self):
        self.assertEqual(sorted(dedupe([9, 7, 8])), [7, 8, 9])


if __name__ == "__main__":
    unittest.main()
