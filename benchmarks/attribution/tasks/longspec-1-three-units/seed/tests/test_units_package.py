import importlib
import inspect
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


class PackageLayoutTest(unittest.TestCase):
    """Seed units are stubs; only the package layout and public signatures are stable."""

    def test_modules_import(self):
        for name in ("duration", "money", "wrap"):
            importlib.import_module("units." + name)

    def test_public_signatures(self):
        from units import duration, money, wrap

        def names(f):
            return list(inspect.signature(f).parameters)

        self.assertEqual(names(duration.parse_duration), ["text"])
        self.assertEqual(names(duration.format_duration), ["seconds"])
        self.assertEqual(names(money.format_cents), ["cents", "currency"])
        self.assertEqual(names(money.split_cents), ["total", "parts"])
        self.assertEqual(names(wrap.wrap_text), ["text", "width"])
        default = inspect.signature(money.format_cents).parameters["currency"].default
        self.assertEqual(default, "USD")


if __name__ == "__main__":
    unittest.main()
