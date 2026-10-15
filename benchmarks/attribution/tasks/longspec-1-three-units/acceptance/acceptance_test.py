import unittest

from units.duration import format_duration, parse_duration
from units.money import format_cents, split_cents
from units.wrap import wrap_text


class DurationTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration(" 1D2h3M4s "), 93784)
        self.assertEqual(parse_duration("1h 30m"), 5400)
        self.assertEqual(parse_duration("45s"), 45)

    def test_parse_rejects(self):
        for bad in ("", "  ", "30", "1x", "-1h", "1h2h", "h", "1h!", "1.5h"):
            with self.assertRaises(ValueError, msg=bad):
                parse_duration(bad)

    def test_format(self):
        self.assertEqual(format_duration(5400), "1h30m")
        self.assertEqual(format_duration(0), "0s")
        self.assertEqual(format_duration(90061), "1d1h1m1s")
        for bad in (-1, 1.5, "3", True):
            with self.assertRaises(ValueError):
                format_duration(bad)

    def test_roundtrip(self):
        for n in (0, 1, 59, 60, 3599, 3600, 86399, 86400, 1234567):
            self.assertEqual(parse_duration(format_duration(n)), n)


class MoneyTest(unittest.TestCase):
    def test_format(self):
        self.assertEqual(format_cents(1234567), "$12,345.67")
        self.assertEqual(format_cents(5), "$0.05")
        self.assertEqual(format_cents(0), "$0.00")
        self.assertEqual(format_cents(-250), "-$2.50")
        self.assertEqual(format_cents(100000, "EUR"), "EUR 1,000.00")
        self.assertEqual(format_cents(99, "GBP"), "GBP 0.99")

    def test_format_errors(self):
        with self.assertRaises(ValueError):
            format_cents(1, "JPY")
        for bad in (1.5, True, "5", None):
            with self.assertRaises(TypeError):
                format_cents(bad)

    def test_split(self):
        self.assertEqual(split_cents(100, 3), [34, 33, 33])
        self.assertEqual(split_cents(10, 4), [3, 3, 2, 2])
        self.assertEqual(split_cents(0, 2), [0, 0])
        self.assertEqual(split_cents(7, 1), [7])
        for total, parts in ((-1, 2), (5, 0), (5, 1.5), (1.5, 2)):
            with self.assertRaises(ValueError):
                split_cents(total, parts)


class WrapTest(unittest.TestCase):
    def test_wrap(self):
        self.assertEqual(wrap_text("the quick brown fox", 9), ["the quick", "brown fox"])
        self.assertEqual(wrap_text("  a   b\n\tc ", 10), ["a b c"])
        self.assertEqual(wrap_text("abcdefghij kl", 4), ["abcdefghij", "kl"])
        self.assertEqual(wrap_text("aa bb cc", 5), ["aa bb", "cc"])

    def test_wrap_edges(self):
        self.assertEqual(wrap_text("", 5), [])
        self.assertEqual(wrap_text(" \n ", 5), [])
        for bad in (0, -1, 2.5, "3"):
            with self.assertRaises(ValueError):
                wrap_text("x", bad)


if __name__ == "__main__":
    unittest.main()
