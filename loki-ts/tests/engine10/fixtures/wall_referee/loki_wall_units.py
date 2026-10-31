import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from units.duration import parse_duration, format_duration
from units.money import format_cents, split_cents
from units.wrap import wrap_text


class TestParseDuration(unittest.TestCase):
    def test_compound_hours_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        with self.assertRaises(ValueError):
            parse_duration("1h30")

    def test_days_unit_is_86400(self):
        self.assertEqual(parse_duration("2d"), 172800)
        with self.assertRaises(ValueError):
            parse_duration("2w")

    def test_seconds_only(self):
        self.assertEqual(parse_duration("45s"), 45)
        with self.assertRaises(ValueError):
            parse_duration("-45s")

    def test_all_units_in_one_string(self):
        self.assertEqual(parse_duration("1d2h3m4s"), 93784)
        with self.assertRaises(ValueError):
            parse_duration("1d2h3m4s!")

    def test_whitespace_case_and_spaces_between_components(self):
        self.assertEqual(parse_duration("  1H 30M  "), 5430)
        self.assertEqual(parse_duration("1h 30m"), 5400)
        with self.assertRaises(ValueError):
            parse_duration("   ")

    def test_empty_and_unitless_raise(self):
        with self.assertRaises(ValueError):
            parse_duration("")
        with self.assertRaises(ValueError):
            parse_duration("5")

    def test_duplicate_unit_raises(self):
        with self.assertRaises(ValueError):
            parse_duration("1h2h")
        self.assertEqual(parse_duration("1h2m"), 3720)


class TestFormatDuration(unittest.TestCase):
    def test_omits_zero_components(self):
        self.assertEqual(format_duration(5400), "1h30m")
        with self.assertRaises(ValueError):
            format_duration(-5400)

    def test_zero_is_zero_seconds(self):
        self.assertEqual(format_duration(0), "0s")
        with self.assertRaises(ValueError):
            format_duration(-1)

    def test_all_components_largest_first(self):
        self.assertEqual(format_duration(90061), "1d1h1m1s")
        with self.assertRaises(ValueError):
            format_duration("90061")

    def test_non_int_raises(self):
        with self.assertRaises(ValueError):
            format_duration(1.0)
        self.assertEqual(format_duration(60), "1m")

    def test_round_trip(self):
        for n in (0, 1, 59, 3600, 5400, 86399, 90061, 1000000):
            self.assertEqual(parse_duration(format_duration(n)), n)
        with self.assertRaises(ValueError):
            format_duration(-60)


class TestFormatCents(unittest.TestCase):
    def test_thousands_separator_and_two_decimals(self):
        self.assertEqual(format_cents(1234567), "$12,345.67")
        with self.assertRaises(TypeError):
            format_cents(12.5)

    def test_small_amount_has_leading_zero(self):
        self.assertEqual(format_cents(5), "$0.05")
        with self.assertRaises(TypeError):
            format_cents("5")

    def test_negative_sign_before_symbol(self):
        self.assertEqual(format_cents(-250), "-$2.50")
        self.assertEqual(format_cents(-1234567, "EUR"), "-EUR 12,345.67")

    def test_currency_symbols(self):
        self.assertEqual(format_cents(1050, "EUR"), "EUR 10.50")
        self.assertEqual(format_cents(1050, "GBP"), "GBP 10.50")
        self.assertEqual(format_cents(1050), "$10.50")

    def test_unknown_currency_raises(self):
        with self.assertRaises(ValueError):
            format_cents(1050, "JPY")
        with self.assertRaises(TypeError):
            format_cents(True)


class TestSplitCents(unittest.TestCase):
    def test_even_split_larger_shares_first(self):
        self.assertEqual(split_cents(100, 3), [34, 33, 33])
        with self.assertRaises(ValueError):
            split_cents(100, 0)

    def test_shares_sum_exactly_and_differ_by_at_most_one(self):
        shares = split_cents(10, 4)
        self.assertEqual(shares, [3, 3, 2, 2])
        self.assertEqual(sum(shares), 10)
        with self.assertRaises(ValueError):
            split_cents(-1, 4)

    def test_zero_total(self):
        self.assertEqual(split_cents(0, 3), [0, 0, 0])
        with self.assertRaises(ValueError):
            split_cents(0, 2.5)

    def test_parts_must_be_int_at_least_one(self):
        self.assertEqual(split_cents(7, 1), [7])
        with self.assertRaises(ValueError):
            split_cents(7, -1)


class TestWrapText(unittest.TestCase):
    def test_greedy_wrap_within_width(self):
        self.assertEqual(wrap_text("the quick brown fox", 10), ["the quick", "brown fox"])
        with self.assertRaises(ValueError):
            wrap_text("the quick brown fox", 0)

    def test_whitespace_collapses_to_single_space(self):
        self.assertEqual(wrap_text("a   b\n\tc", 10), ["a b c"])
        with self.assertRaises(ValueError):
            wrap_text("a b", -3)

    def test_no_leading_or_trailing_space(self):
        lines = wrap_text("  alpha   beta gamma  ", 6)
        for line in lines:
            self.assertEqual(line, line.strip())
            self.assertLessEqual(len(line), 6)
        with self.assertRaises(ValueError):
            wrap_text("alpha", 2.5)

    def test_long_word_alone_unbroken(self):
        self.assertEqual(
            wrap_text("supercalifragilistic is long", 5),
            ["supercalifragilistic", "is", "long"],
        )
        with self.assertRaises(ValueError):
            wrap_text("x", "5")

    def test_empty_and_whitespace_only(self):
        self.assertEqual(wrap_text("", 5), [])
        self.assertEqual(wrap_text("  \n\t ", 5), [])
        self.assertNotEqual(wrap_text("ab", 5), [])


if __name__ == "__main__":
    unittest.main()
