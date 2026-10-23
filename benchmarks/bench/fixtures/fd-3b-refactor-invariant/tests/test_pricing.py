import os
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pricing import invoice_total


class InvoiceTest(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(invoice_total([("10.00", 2)], "0.10"), Decimal("22.00"))

    def test_negative_quantity(self):
        with self.assertRaises(ValueError):
            invoice_total([("1.00", -1)], "0.1")


if __name__ == "__main__":
    unittest.main()
