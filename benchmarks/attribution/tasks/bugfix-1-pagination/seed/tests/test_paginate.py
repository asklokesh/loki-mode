import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from paginate import page_count, paginate


class UnchangedBehaviorTest(unittest.TestCase):
    def test_invalid_per_page_raises(self):
        for bad in (0, -2):
            with self.assertRaises(ValueError):
                paginate([1, 2], 1, bad)
            with self.assertRaises(ValueError):
                page_count(2, bad)

    def test_empty_items_give_empty_page_and_zero_pages(self):
        self.assertEqual(paginate([], 1, 3), [])
        self.assertEqual(page_count(0, 5), 0)

    def test_far_out_of_range_page_is_empty(self):
        self.assertEqual(paginate(list(range(4)), 50, 2), [])

    def test_exact_multiple_page_count(self):
        self.assertEqual(page_count(6, 2), 3)


if __name__ == "__main__":
    unittest.main()
