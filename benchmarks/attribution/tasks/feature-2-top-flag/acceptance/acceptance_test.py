import os
import subprocess
import sys
import tempfile
import unittest

TEXT = "the cat the dog the end cat apple apple zebra"


def run(*args):
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "in.txt")
        with open(f, "w") as fh:
            fh.write(TEXT)
        return subprocess.run([sys.executable, "wordcount.py", f] + list(args),
                              capture_output=True, text=True, timeout=30)


class T(unittest.TestCase):
    def test_default_unchanged(self):
        r = run()
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.splitlines(),
                         ["3 the", "2 apple", "2 cat", "1 dog", "1 end", "1 zebra"])

    def test_top(self):
        r = run("--top", "2")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.splitlines(), ["3 the", "2 apple"])

    def test_top_larger_than_vocab(self):
        r = run("--top", "50")
        self.assertEqual(len(r.stdout.splitlines()), 6)

    def test_top_invalid(self):
        for bad in ("0", "-3"):
            r = run("--top", bad)
            self.assertEqual(r.returncode, 2)
            self.assertTrue(r.stderr.strip())

    def test_api_kept(self):
        import wordcount
        self.assertEqual(wordcount.count_words("a a b")["a"], 2)


if __name__ == "__main__":
    unittest.main()
