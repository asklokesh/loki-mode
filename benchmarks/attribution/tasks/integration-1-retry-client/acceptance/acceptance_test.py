import unittest

from client import fetch_all
from service import InventoryService, ServiceUnavailable

DATA = list(range(8))


class T(unittest.TestCase):
    def test_all_pages(self):
        svc = InventoryService(DATA)
        self.assertEqual(fetch_all(svc, sleep=lambda s: None), DATA)
        self.assertEqual(svc.calls, 3)

    def test_retry_then_success(self):
        slept = []
        svc = InventoryService(DATA, fail_calls={2, 3})
        self.assertEqual(fetch_all(svc, sleep=slept.append), DATA)
        self.assertEqual(slept, [0.1, 0.2])
        self.assertEqual(svc.calls, 5)

    def test_exhausted(self):
        slept = []
        svc = InventoryService(DATA, fail_calls={1, 2, 3, 4, 5})
        with self.assertRaises(ServiceUnavailable):
            fetch_all(svc, max_retries=3, sleep=slept.append)
        self.assertEqual(slept, [0.1, 0.2, 0.4])
        self.assertEqual(svc.calls, 4)

    def test_backoff_resets_per_page(self):
        slept = []
        svc = InventoryService(DATA, fail_calls={1, 3})
        self.assertEqual(fetch_all(svc, sleep=slept.append), DATA)
        self.assertEqual(slept, [0.1, 0.1])

    def test_empty(self):
        self.assertEqual(fetch_all(InventoryService([]), sleep=lambda s: None), [])


if __name__ == "__main__":
    unittest.main()
