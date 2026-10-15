import ast
import unittest

import invoice
import pricing
import quote

LINES = [(19.99, 3, 10), (5.0, 1, 0), (100.0, 2, 12.5)]


def _imports_pricing(path):
    tree = ast.parse(open(path).read())
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module == "pricing":
            return True
        if isinstance(n, ast.Import) and any(a.name == "pricing" for a in n.names):
            return True
    return False


def _has_discount_arithmetic(path):
    tree = ast.parse(open(path).read())
    return any(isinstance(n, ast.Constant) and n.value == 100.0
               for n in ast.walk(tree))


class T(unittest.TestCase):
    def test_behavior_preserved(self):
        self.assertEqual(invoice.invoice_total(LINES, 8.25), EXPECTED)
        self.assertEqual(quote.quote_total(LINES, 8.25), EXPECTED)
        self.assertEqual(invoice.invoice_total([], 5), 0.0)

    def test_pricing_api(self):
        self.assertAlmostEqual(pricing.line_total(10, 3, 10), 27.0)
        self.assertEqual(pricing.with_tax(100.0, 7.5), 107.5)

    def test_modules_use_pricing(self):
        for path in ("invoice.py", "quote.py"):
            self.assertTrue(_imports_pricing(path), path)
            self.assertFalse(_has_discount_arithmetic(path), path)


EXPECTED = round((19.99 * 3 * 0.9 + 5.0 + 200.0 * 0.875) * 1.0825, 2)

if __name__ == "__main__":
    unittest.main()
