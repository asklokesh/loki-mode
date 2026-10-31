import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from dedupe import dedupe


class TestDedupe(unittest.TestCase):
    def test_keeps_first_occurrence_in_original_order(self):
        self.assertEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2])
        self.assertNotEqual(dedupe([3, 1, 3, 2, 1]), [1, 2, 3])

    def test_default_is_case_sensitive(self):
        self.assertEqual(dedupe(["a", "A", "a"]), ["a", "A"])
        self.assertNotEqual(dedupe(["a", "A", "a"]), ["a"])

    def test_case_insensitive_keeps_first_spelling(self):
        self.assertEqual(
            dedupe(["Apple", "apple", "APPLE", "banana"], case_sensitive=False),
            ["Apple", "banana"],
        )
        self.assertNotEqual(dedupe(["Apple", "apple"], case_sensitive=False), ["apple"])

    def test_non_strings_are_compared_by_equality_not_case_folded(self):
        self.assertEqual(
            dedupe([1, 1, "x", "X", None, None], case_sensitive=False),
            [1, "x", "X", None],
        )
        self.assertNotEqual(dedupe(["x", "X"], case_sensitive=False), ["x"])

    def test_unhashable_values_are_deduplicated(self):
        self.assertEqual(dedupe([[1], {"a": 1}, [1], [2]]), [[1], {"a": 1}, [2]])
        self.assertNotEqual(dedupe([[1], [1], [2]]), [[1], [2], [1]])
        self.assertEqual(
            dedupe([["A"], ["a"], ["A"]], case_sensitive=False),
            [["A"], ["a"]],
        )


if __name__ == "__main__":
    unittest.main()
