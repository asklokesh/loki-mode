import unittest

from dedupe import dedupe


class VisibleDedupe(unittest.TestCase):
    def test_keeps_first_occurrence_in_order(self):
        self.assertEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2])

    def test_key_function(self):
        self.assertEqual(dedupe(["a", "B", "A", "b"], key=str.lower), ["a", "B"])


if __name__ == "__main__":
    unittest.main()
