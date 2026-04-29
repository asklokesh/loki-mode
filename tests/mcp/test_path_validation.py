"""
tests/mcp/test_path_validation.py

Path-traversal regression tests for v7.5.8 hardening of mcp/server.py.

Covers two attack surfaces:
  1. `loki_findings` previously used os.path.join(review_path, entry) where
     `entry` came from os.listdir(); a malicious filename like
     "../../etc/passwd" would have escaped the validated review dir. The
     fix replaces the bare join with safe_path_join(), which resolves and
     validates the result against ALLOWED_BASE_DIRS.
  2. `safe_path_join` itself must reject "../"-style traversal entries
     even when the base is a valid validated directory.

These tests reuse the FastMCP stub + chdir-into-tempdir machinery from
test_phase1_tools.py.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Reuse the stub bootstrap + helpers from the sibling test module.
from tests.mcp.test_phase1_tools import (  # type: ignore[import-not-found]
    _ChdirToTmp,
    _import_server,
    _run,
)


class PathTraversalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _import_server()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mcp-pathval-")
        os.makedirs(os.path.join(self.tmp, ".loki"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_safe_path_join_rejects_dotdot_entry(self):
        """safe_path_join must reject components that escape via '..'."""
        srv = self.server
        with _ChdirToTmp(self.tmp):
            review_path = srv.safe_path_join(
                ".loki", "quality", "reviews", "review-xyz-5"
            )
            # A malicious listdir entry trying to escape the project root.
            # review_path is .loki/quality/reviews/review-xyz-5 (4 levels deep
            # under project_root), so we need >=5 '..' segments to land
            # outside ALLOWED_BASE_DIRS.
            with self.assertRaises(srv.PathTraversalError):
                srv.safe_path_join(
                    review_path, "../../../../../../../etc/passwd"
                )

    def test_findings_skips_malicious_listdir_entry(self):
        """loki_findings must not read paths produced by joining a
        '../'-style listdir entry onto review_path. We seed a real,
        legitimate finding alongside a fake listdir result whose name
        traverses out of the review dir; the malicious one must be
        silently skipped while the legitimate finding is returned."""
        srv = self.server

        reviews_dir = os.path.join(
            self.tmp, ".loki", "quality", "reviews", "review-xyz-5"
        )
        os.makedirs(reviews_dir, exist_ok=True)
        # Legitimate reviewer file with a Critical finding.
        Path(os.path.join(reviews_dir, "eng-qa.txt")).write_text(
            "- [Critical] boom at src/x.ts:42\n"
        )
        # We do NOT create the traversal file on disk; we only need
        # os.listdir to *return* the name so the safe_path_join check
        # is the gate that has to reject it.

        real_listdir = os.listdir

        def fake_listdir(path):
            # Only intercept the review dir listing; pass everything else
            # through (server.py also lists .loki/state).
            base = os.path.realpath(path)
            if base == os.path.realpath(reviews_dir):
                # 7 '..' segments are enough to escape .loki/ from a
                # 4-deep review dir, landing outside ALLOWED_BASE_DIRS.
                return ["eng-qa.txt", "../../../../../../../etc/passwd.txt"]
            return real_listdir(path)

        with _ChdirToTmp(self.tmp), mock.patch("os.listdir", side_effect=fake_listdir):
            raw = _run(srv.loki_findings(iteration=5))
        body = json.loads(raw)

        # Legitimate finding survived; malicious entry was skipped, not
        # crashed-on, and definitely not read.
        self.assertEqual(body["review_id"], "review-xyz-5")
        self.assertEqual(len(body["findings"]), 1)
        self.assertEqual(body["findings"][0]["severity"], "Critical")
        self.assertEqual(body["findings"][0]["file"], "src/x.ts")


if __name__ == "__main__":
    unittest.main()
