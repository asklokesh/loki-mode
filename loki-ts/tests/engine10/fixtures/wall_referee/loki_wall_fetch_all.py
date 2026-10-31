import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from service import InventoryService, ServiceUnavailable
from client import fetch_all


def _recording(service, fail_calls=(), always=False):
    log = []
    original = service.get_page

    def get_page(cursor):
        index = len(log)
        if always or index in fail_calls:
            log.append((cursor, False))
            raise ServiceUnavailable(str(index))
        result = original(cursor)
        log.append((cursor, True))
        return result

    service.get_page = get_page
    return log


class TestFetchAll(unittest.TestCase):
    def test_transient_failure_retries_same_cursor_and_matches_clean_walk(self):
        clean = fetch_all(InventoryService())
        self.assertIsInstance(clean, list)
        self.assertGreater(len(clean), 0)

        service = InventoryService()
        sleeps = []
        log = _recording(service, fail_calls={1})
        got = fetch_all(service, sleep=sleeps.append)

        self.assertEqual(got, clean)
        self.assertEqual(sleeps, [0.1])
        self.assertFalse(log[1][1])
        self.assertEqual(log[1][0], log[2][0])
        successes = [cursor for cursor, ok in log if ok]
        self.assertEqual(len(successes), len(set(successes)))

    def test_exhausted_retries_back_off_exponentially_and_reraise_last_error(self):
        service = InventoryService()
        sleeps = []
        log = _recording(service, always=True)

        with self.assertRaises(ServiceUnavailable) as ctx:
            fetch_all(service, max_retries=3, sleep=sleeps.append)

        self.assertEqual(sleeps, [0.1, 0.2, 0.4])
        self.assertEqual(len(log), 4)
        self.assertEqual({cursor for cursor, _ in log}, {log[0][0]})
        self.assertFalse(any(ok for _, ok in log))
        self.assertEqual(str(ctx.exception), "3")

    def test_zero_retries_raises_immediately_without_sleeping(self):
        service = InventoryService()
        sleeps = []
        log = _recording(service, always=True)

        with self.assertRaises(ServiceUnavailable):
            fetch_all(service, max_retries=0, sleep=sleeps.append)

        self.assertEqual(sleeps, [])
        self.assertEqual(len(log), 1)


if __name__ == "__main__":
    unittest.main()
