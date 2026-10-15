import unittest
from unittest import mock

from api import orders
from web import client


def make(n):
    return [{"id": i * 3, "amount": i} for i in range(1, n + 1)]


class CoordTest(unittest.TestCase):
    def test_api_pages(self):
        with mock.patch.object(orders, "ORDERS", make(5)):
            p1 = orders.list_orders()
            self.assertEqual([o["id"] for o in p1["items"]], [3, 6])
            self.assertEqual(p1["next_cursor"], 6)
            p3 = orders.list_orders(cursor=12)
            self.assertEqual([o["id"] for o in p3["items"]], [15])
            self.assertIsNone(p3["next_cursor"])

    def test_api_exact_last_page_has_no_cursor(self):
        with mock.patch.object(orders, "ORDERS", make(4)):
            p = orders.list_orders(cursor=3, limit=3)
            self.assertEqual([o["id"] for o in p["items"]], [6, 9, 12])
            self.assertIsNone(p["next_cursor"])
            self.assertIsNone(orders.list_orders(limit=4)["next_cursor"])

    def test_api_limit_validation(self):
        for bad in (0, 101, -1, "2", None):
            with self.assertRaises(ValueError):
                orders.list_orders(limit=bad)
        orders.list_orders(limit=100)

    def test_web_collects_all_pages(self):
        with mock.patch.object(orders, "ORDERS", make(7)):
            self.assertEqual(client.fetch_all_orders(), make(7))
            self.assertEqual(client.total_amount(), sum(range(1, 8)))

    def test_web_empty(self):
        with mock.patch.object(orders, "ORDERS", []):
            self.assertEqual(client.fetch_all_orders(), [])
            self.assertEqual(client.total_amount(), 0)


if __name__ == "__main__":
    unittest.main()
