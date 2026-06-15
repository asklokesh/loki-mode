"""
tests/mcp/test_resource_corrupt_state.py

Regression tests for the MCP @mcp.resource handlers (Bug A):
    - loki://state/continuity   (get_continuity)
    - loki://memory/index       (get_memory_index)
    - loki://queue/pending      (get_pending_tasks)

Before the fix, these three resource handlers caught ONLY PathTraversalError.
In a degraded install (STATE_MANAGER_AVAILABLE=False) they do a bare json.load
on .loki state files, so a corrupt JSON file raised an uncaught JSONDecodeError
into the MCP runtime (tools return an {"error": ...} envelope; resources did
not). get_memory_index additionally returned raw f.read() with no validation,
serving corrupt bytes as a successful response.

These tests force STATE_MANAGER_AVAILABLE=False, seed corrupt .loki state
files, and assert each handler returns an honest error envelope/string rather
than raising. Reuses the FastMCP-stub import helpers from test_phase1_tools so
the resource decorator returns the plain coroutine function (callable directly).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import unittest

from test_phase1_tools import _ChdirToTmp, _import_server, _run  # noqa: E402


class ResourceCorruptStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _import_server()
        # The bug only manifests on the degraded direct-file-read fallback.
        cls.server.STATE_MANAGER_AVAILABLE = False

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mcp-corrupt-")
        os.makedirs(os.path.join(self.tmp, ".loki", "state"), exist_ok=True)
        os.makedirs(os.path.join(self.tmp, ".loki", "memory"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, rel, content):
        path = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    # ---- get_pending_tasks --------------------------------------------

    def test_pending_tasks_corrupt_queue_returns_error_envelope(self):
        self._write(".loki/state/task-queue.json", "{ this is : not valid json,,, }")
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.get_pending_tasks())
        body = json.loads(raw)
        self.assertIn("error", body)
        # Envelope shape is preserved so consumers do not crash on missing keys.
        self.assertEqual(body.get("pending_tasks"), [])
        self.assertEqual(body.get("count"), 0)

    def test_pending_tasks_missing_file_is_not_an_error(self):
        # Negative control: absent file is the empty-queue success path.
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.get_pending_tasks())
        body = json.loads(raw)
        self.assertNotIn("error", body)
        self.assertEqual(body.get("count"), 0)

    # ---- get_memory_index ---------------------------------------------

    def test_memory_index_corrupt_returns_error_not_raw_bytes(self):
        self._write(".loki/memory/index.json", "{bad json not closed")
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.get_memory_index())
        # Must be valid JSON (parse-and-reserialize), and an error envelope,
        # never the raw corrupt bytes served as a success.
        body = json.loads(raw)
        self.assertIn("error", body)
        self.assertEqual(body.get("topics"), [])

    def test_memory_index_valid_passes_through(self):
        # Negative control: a well-formed index reserializes cleanly.
        self._write(".loki/memory/index.json", json.dumps({"topics": ["t1", "t2"]}))
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.get_memory_index())
        body = json.loads(raw)
        self.assertNotIn("error", body)
        self.assertEqual(body.get("topics"), ["t1", "t2"])

    # ---- get_continuity ------------------------------------------------

    def test_continuity_directory_in_place_of_file_returns_error_string(self):
        # A directory where CONTINUITY.md is expected makes the read raise
        # IsADirectoryError; the generic except must turn that into a string.
        os.makedirs(os.path.join(self.tmp, ".loki", "CONTINUITY.md"))
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.get_continuity())
        self.assertIsInstance(raw, str)
        self.assertIn("Error", raw)

    def test_continuity_missing_returns_not_found(self):
        # Negative control: absent file is the documented not-found message.
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.get_continuity())
        self.assertIn("not found", raw)


if __name__ == "__main__":
    unittest.main()
