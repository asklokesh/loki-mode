import unittest

from lru import LRUCache


class VisibleLRU(unittest.TestCase):
    def test_evicts_least_recently_used(self):
        c = LRUCache(2)
        c.put("a", 1)
        c.put("b", 2)
        c.put("c", 3)
        self.assertIsNone(c.get("a"))
        self.assertEqual(c.get("b"), 2)
        self.assertEqual(c.get("c"), 3)

    def test_get_refreshes(self):
        c = LRUCache(2)
        c.put("a", 1)
        c.put("b", 2)
        self.assertEqual(c.get("a"), 1)
        c.put("c", 3)
        self.assertIsNone(c.get("b"))
        self.assertEqual(c.get("a"), 1)

    def test_default_and_len(self):
        c = LRUCache(3)
        self.assertEqual(c.get("x", "dflt"), "dflt")
        c.put("x", 1)
        self.assertEqual(len(c), 1)


if __name__ == "__main__":
    unittest.main()
