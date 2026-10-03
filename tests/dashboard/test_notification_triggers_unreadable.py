"""tests/dashboard/test_notification_triggers_unreadable.py
PO-DASH-HONEST-1 (S-223): GET /api/notifications/triggers must not report an
unreadable triggers.json as an empty trigger list. A corrupt file returns
{"triggers": None, "error": ...}; a missing file is a genuine [] .
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import unittest
from pathlib import Path


class NotificationTriggersUnreadableTests(unittest.TestCase):
    def _call(self, content):
        from dashboard import server as _server

        tmp = tempfile.mkdtemp(prefix="loki-run.")
        self.addCleanup(shutil.rmtree, tmp, True)
        if content is not None:
            nd = Path(tmp, "notifications")
            nd.mkdir()
            (nd / "triggers.json").write_text(content, encoding="utf-8")
        saved = _server._get_loki_dir
        _server._get_loki_dir = lambda: Path(tmp)
        try:
            return asyncio.run(_server.get_notification_triggers())
        finally:
            _server._get_loki_dir = saved

    def test_corrupt_file_is_unknown_with_error(self):
        out = self._call("{not json")
        self.assertIsNone(out["triggers"])
        self.assertTrue(out.get("error"))

    def test_missing_file_is_genuine_empty(self):
        out = self._call(None)
        self.assertEqual(out["triggers"], [])
        self.assertNotIn("error", out)

    def test_valid_file_passes_through(self):
        out = self._call('{"triggers": [{"id": "a", "type": "x"}]}')
        self.assertEqual(out["triggers"][0]["id"], "a")


if __name__ == "__main__":
    unittest.main()
