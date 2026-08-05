"""The index must not depend on WHERE the repo is checked out.

A worktree living under `.claude/worktrees/<name>/` produced an EMPTY python
index. `SKIP_DIRS` holds `.claude`, and the filter was a substring test against
the ABSOLUTE path, so every file under that checkout matched a skip entry.

The failure mode is the dangerous kind: no error, no warning, just a code
search that quietly returns nothing. It surfaced only because a test asserted
a known token was findable -- and even then only on Python 3.12, since on 3.14
chromadb fails to import and hybrid_search silently falls back to a different
file list that happens to include memory/.

Asserted in both directions: real skip dirs are still skipped.
"""

import importlib.util
import pathlib
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _indexer():
    """Load the indexer, or skip when its deps cannot import here.

    index-codebase.py imports chromadb, which fails on Python 3.14 (pydantic
    v1 incompatibility). That is an environment limit, not a defect -- CI runs
    3.12, where it loads. Skipping keeps the guard honest instead of turning an
    absent measurement into a red build.
    """
    spec = importlib.util.spec_from_file_location(
        "loki_index_codebase", _ROOT / "tools" / "index-codebase.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - any import failure is a skip
        raise unittest.SkipTest(
            "indexer deps unavailable on this interpreter: {}".format(exc))
    return mod


class SkipDirsMatchComponentsNotSubstrings(unittest.TestCase):
    def setUp(self):
        self.m = _indexer()

    def test_the_checkout_location_does_not_empty_the_index(self):
        """The exact regression: this repo may itself sit under a skip name."""
        offenders = [d for d in self.m.SKIP_DIRS if d in str(self.m.PROJECT_ROOT)]
        files = [str(f) for f, _ in self.m.collect_files()]
        self.assertTrue(
            files,
            "collect_files() returned NOTHING. The checkout path contains "
            "{} and the skip filter matched the absolute path."
            .format(offenders or "a skip entry"))
        self.assertTrue(
            any("/memory/" in f for f in files),
            "memory/*.py is in PYTHON_GLOBS but nothing under memory/ was "
            "collected -- the skip filter is eating the whole tree")

    def test_real_skip_dirs_are_still_skipped(self):
        """The opposite error: a loosened filter that indexes node_modules."""
        files = [str(f) for f, _ in self.m.collect_files()]
        for bad in ("node_modules", "__pycache__", "dashboard-ui"):
            with self.subTest(skip=bad):
                self.assertFalse(
                    [f for f in files if "/{}/".format(bad) in f],
                    "{} is in SKIP_DIRS but its files got indexed".format(bad))

    def test_helper_judges_by_component(self):
        """Directly: a skip NAME inside a longer component must not match."""
        root = self.m.PROJECT_ROOT
        self.assertFalse(
            self.m._is_skipped(root / "memory" / "engine.py"),
            "a normal source file was skipped")
        self.assertTrue(
            self.m._is_skipped(root / "node_modules" / "x" / "y.py"),
            "a genuinely skipped directory was allowed through")
        # "distribution" contains "dist", which a substring test would drop.
        self.assertFalse(
            self.m._is_skipped(root / "distribution" / "y.py"),
            "a directory merely CONTAINING a skip name was skipped")


if __name__ == "__main__":
    unittest.main()
