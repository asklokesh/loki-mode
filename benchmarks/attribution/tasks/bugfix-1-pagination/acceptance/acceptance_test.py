import unittest
from paginate import page_count, paginate


class T(unittest.TestCase):
    def test_full_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_middle_page(self):
        self.assertEqual(paginate(list(range(10)), 2, 3), [3, 4, 5])

    def test_last_partial(self):
        self.assertEqual(paginate(list(range(10)), 4, 3), [9])

    def test_out_of_range(self):
        self.assertEqual(paginate(list(range(10)), 5, 3), [])
        self.assertEqual(paginate(list(range(10)), 0, 3), [])

    def test_counts(self):
        self.assertEqual(page_count(10, 3), 4)
        self.assertEqual(page_count(9, 3), 3)
        self.assertEqual(page_count(0, 3), 0)

    def test_invalid(self):
        with self.assertRaises(ValueError):
            paginate([1], 1, 0)
        with self.assertRaises(ValueError):
            page_count(1, 0)


if __name__ == "__main__":
    unittest.main()
