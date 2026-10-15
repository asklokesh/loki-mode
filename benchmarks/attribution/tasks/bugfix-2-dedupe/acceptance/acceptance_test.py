import unittest
from dedupe import dedupe


class T(unittest.TestCase):
    def test_order(self):
        self.assertEqual(dedupe([3, 1, 3, 2, 1]), [3, 1, 2])

    def test_case_sensitive(self):
        self.assertEqual(dedupe(["a", "A", "a"]), ["a", "A"])

    def test_case_insensitive(self):
        self.assertEqual(dedupe(["B", "b", "a", "A"], case_sensitive=False), ["B", "a"])

    def test_mixed_types(self):
        self.assertEqual(dedupe([1, "1", "x", "X"], case_sensitive=False), [1, "1", "x"])

    def test_unhashable(self):
        self.assertEqual(dedupe([[1], [1], [2]]), [[1], [2]])

    def test_empty(self):
        self.assertEqual(dedupe([]), [])


if __name__ == "__main__":
    unittest.main()
