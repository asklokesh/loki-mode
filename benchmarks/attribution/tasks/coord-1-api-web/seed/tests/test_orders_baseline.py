import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from api import orders
from web import client


class UnchangedBehaviorTest(unittest.TestCase):
    def test_seed_orders_data_shape(self):
        self.assertEqual([o["id"] for o in orders.ORDERS], [1, 2, 3, 4, 5])
        self.assertTrue(all(set(o) == {"id", "amount"} for o in orders.ORDERS))

    def test_total_amount_sums_all_orders(self):
        self.assertEqual(client.total_amount(), 150)

    def test_fetch_all_returns_every_order_in_id_order(self):
        got = client.fetch_all_orders()
        self.assertEqual([o["id"] for o in got], [1, 2, 3, 4, 5])
        self.assertEqual(got, orders.ORDERS)


if __name__ == "__main__":
    unittest.main()
