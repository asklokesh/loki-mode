import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from service import InventoryService, ServiceUnavailable


class ProvidedServiceTest(unittest.TestCase):
    def test_pages_follow_cursor(self):
        svc = InventoryService(list("abcdefg"), page_size=3)
        p1 = svc.get_page()
        self.assertEqual(p1, {"items": ["a", "b", "c"], "next": "3"})
        p2 = svc.get_page(p1["next"])
        self.assertEqual(p2["items"], ["d", "e", "f"])
        p3 = svc.get_page(p2["next"])
        self.assertEqual(p3, {"items": ["g"], "next": None})
        self.assertEqual(svc.calls, 3)

    def test_fail_calls_raise_then_recover(self):
        svc = InventoryService([1, 2], page_size=5, fail_calls={1})
        with self.assertRaises(ServiceUnavailable):
            svc.get_page()
        self.assertEqual(svc.get_page()["items"], [1, 2])
        self.assertEqual(svc.calls, 2)

    def test_empty_service(self):
        self.assertEqual(InventoryService([]).get_page(), {"items": [], "next": None})


if __name__ == "__main__":
    unittest.main()
