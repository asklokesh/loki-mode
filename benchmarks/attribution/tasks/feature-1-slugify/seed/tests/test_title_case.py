import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from textutil import title_case


class TitleCaseTest(unittest.TestCase):
    def test_capitalizes_each_word(self):
        self.assertEqual(title_case("foo BAR baz"), "Foo Bar Baz")

    def test_collapses_whitespace(self):
        self.assertEqual(title_case("  a   b "), "A B")

    def test_empty(self):
        self.assertEqual(title_case(""), "")


if __name__ == "__main__":
    unittest.main()
