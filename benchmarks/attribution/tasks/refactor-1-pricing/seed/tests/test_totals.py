import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import invoice
import quote


class TotalsTest(unittest.TestCase):
    def test_discount_and_zero_tax(self):
        lines = [(10, 3, 10)]
        self.assertEqual(invoice.invoice_total(lines, 0), 27.0)
        self.assertEqual(quote.quote_total(lines, 0), 27.0)

    def test_tax_rounding(self):
        lines = [(2.5, 4, 0)]
        self.assertEqual(invoice.invoice_total(lines, 10), 11.0)
        self.assertEqual(quote.quote_total(lines, 10), 11.0)

    def test_empty_lines(self):
        self.assertEqual(invoice.invoice_total([], 8), 0.0)
        self.assertEqual(quote.quote_total([], 8), 0.0)


if __name__ == "__main__":
    unittest.main()
