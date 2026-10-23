import unittest

from duration import parse_duration


class VisibleDuration(unittest.TestCase):
    def test_hours_and_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_single_parts(self):
        self.assertEqual(parse_duration("45s"), 45)
        self.assertEqual(parse_duration("2d"), 172800)

    def test_all_units(self):
        self.assertEqual(parse_duration("1d2h3m4s"), 86400 + 7200 + 180 + 4)


if __name__ == "__main__":
    unittest.main()
