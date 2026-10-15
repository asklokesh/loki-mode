import unittest
from textutil import slugify, title_case


class T(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_accents(self):
        self.assertEqual(slugify("Caf\u00e9 cr\u00e8me"), "cafe-creme")

    def test_runs_and_edges(self):
        self.assertEqual(slugify("  --a__b  c--  "), "a-b-c")

    def test_empty(self):
        self.assertEqual(slugify("!!!"), "")

    def test_max_len(self):
        self.assertEqual(slugify("hello world again", max_len=8), "hello-wo")
        self.assertEqual(slugify("hello world again", max_len=6), "hello")

    def test_title_case_untouched(self):
        self.assertEqual(title_case("hELLO wORLD"), "Hello World")


if __name__ == "__main__":
    unittest.main()
