import unittest

from slugify import slugify


class VisibleSlugify(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_accent(self):
        self.assertEqual(slugify("Cr\u00e8me Br\u00fbl\u00e9e"), "creme-brulee")

    def test_digits(self):
        self.assertEqual(slugify("Python 3.12 Release"), "python-3-12-release")


if __name__ == "__main__":
    unittest.main()
