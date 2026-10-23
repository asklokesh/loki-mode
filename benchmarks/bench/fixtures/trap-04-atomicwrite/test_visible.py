import os
import tempfile
import unittest

from atomicwrite import write_atomic


class VisibleAtomicWrite(unittest.TestCase):
    def test_writes_and_returns_count(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.bin")
            self.assertEqual(write_atomic(p, [b"ab", b"cde"]), 5)
            with open(p, "rb") as fh:
                self.assertEqual(fh.read(), b"abcde")

    def test_replaces_existing(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.bin")
            write_atomic(p, [b"old-old"])
            write_atomic(p, [b"new"])
            with open(p, "rb") as fh:
                self.assertEqual(fh.read(), b"new")


if __name__ == "__main__":
    unittest.main()
