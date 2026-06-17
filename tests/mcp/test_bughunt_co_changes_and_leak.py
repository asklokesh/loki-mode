"""
tests/mcp/test_bughunt_co_changes_and_leak.py

Regression tests for two real bugs found by an adversarial bug-hunt of
mcp/server.py:

BUG-1 (resource leak + corrupted telemetry): loki_code_search emits a
'start' tool event, but its early `return` when ChromaDB is unavailable
(the common default path) used to skip the matching 'complete' event. That
leaked one entry per call into the module-global _tool_call_start_times
stack and made a later successful call pop a stale start time, producing a
wildly wrong execution_time_ms learning signal.

BUG-2 (robustness + correctness): loki_get_co_changes used tuple-unpack
`for pair_files, count in pairs` plus `pair_files[1]` with no shape check.
The co-changes.json producer lives outside this repo, so a single malformed
row (not a 2-element pair) raised IndexError/ValueError and aborted the whole
tool. A self-pair (a file paired with itself) was also reported as the file's
own co-change partner.

Harness mirrors tests/mcp/test_phase1_tools.py: stub FastMCP so mcp.server
imports without the SDK, chdir into a tempdir, seed .loki/ state, invoke the
async tools via asyncio.run().
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import site
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


_STUB_DIR: str | None = None


def _ensure_fastmcp_stub() -> None:
    global _STUB_DIR
    if _STUB_DIR is not None:
        return
    stub_root = tempfile.mkdtemp(prefix="loki-mcp-bughunt-stub-")
    pkg_dir = os.path.join(stub_root, "mcp", "server")
    os.makedirs(pkg_dir, exist_ok=True)
    Path(os.path.join(stub_root, "mcp", "__init__.py")).write_text("")
    Path(os.path.join(stub_root, "mcp", "server", "__init__.py")).write_text("")
    Path(os.path.join(pkg_dir, "fastmcp.py")).write_text(textwrap.dedent("""
        class FastMCP:
            def __init__(self, *args, **kwargs):
                pass
            def tool(self, *a, **kw):
                def deco(fn):
                    return fn
                return deco
            def prompt(self, *a, **kw):
                def deco(fn):
                    return fn
                return deco
            def resource(self, *a, **kw):
                def deco(fn):
                    return fn
                return deco
            def run(self, *a, **kw):
                pass
    """))
    Path(os.path.join(stub_root, "mcp", "types.py")).write_text("")
    lowlevel_dir = os.path.join(pkg_dir, "lowlevel")
    os.makedirs(lowlevel_dir, exist_ok=True)
    Path(os.path.join(lowlevel_dir, "__init__.py")).write_text("")
    _orig = site.getsitepackages
    site.getsitepackages = lambda *a, **kw: [stub_root] + _orig(*a, **kw)  # type: ignore[assignment]
    _STUB_DIR = stub_root


def _import_server():
    _ensure_fastmcp_stub()
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for _p in (repo_root, _STUB_DIR):
        while _p in sys.path:
            sys.path.remove(_p)
    sys.path.insert(0, _STUB_DIR)
    sys.path.insert(0, repo_root)
    for k in list(sys.modules.keys()):
        if k == "mcp.server" or k.startswith("mcp.server."):
            del sys.modules[k]
    from mcp import server as _server  # type: ignore
    return _server


def _run(coro):
    return asyncio.run(coro)


class _ChdirToTmp:
    def __init__(self, tmp: str):
        self.tmp = tmp
        self._prev: str | None = None

    def __enter__(self):
        self._prev = os.getcwd()
        os.chdir(self.tmp)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._prev is not None:
            os.chdir(self._prev)


class BugHuntTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _import_server()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mcp-bughunt-")
        os.makedirs(os.path.join(self.tmp, ".loki"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_co_changes(self, data):
        intel = os.path.join(self.tmp, ".loki", "intelligence")
        os.makedirs(intel, exist_ok=True)
        with open(os.path.join(intel, "co-changes.json"), "w") as f:
            json.dump(data, f)

    # ---- BUG-2: loki_get_co_changes robustness + correctness -----------

    def test_co_changes_skips_malformed_row_instead_of_aborting(self):
        # A 1-element pair is malformed. Pre-fix this raised IndexError and the
        # whole tool returned {"error": "list index out of range"}, hiding the
        # valid b.py co-change. Non-vacuity: assert the valid partner IS
        # returned AND there is no top-level error key.
        self._write_co_changes([
            [["a.py", "b.py"], 5],
            [["a.py"], 3],           # malformed: not a 2-element pair
        ])
        with _ChdirToTmp(self.tmp):
            body = json.loads(_run(self.server.loki_get_co_changes("a.py")))
        self.assertNotIn("error", body)
        partners = {r["partner"] for r in body["co_changed_with"]}
        self.assertEqual(partners, {"b.py"})

    def test_co_changes_does_not_report_file_as_its_own_partner(self):
        # A self-pair ["a.py","a.py"] used to surface a.py as its own co-change
        # partner (meaningless noise). Non-vacuity: c.py and b.py ARE returned,
        # proving the filter is selective rather than dropping everything.
        self._write_co_changes([
            [["a.py", "b.py"], 5],
            [["a.py", "a.py"], 2],   # self-pair: must be filtered out
            [["c.py", "a.py"], 9],
        ])
        with _ChdirToTmp(self.tmp):
            body = json.loads(_run(self.server.loki_get_co_changes("a.py")))
        partners = {r["partner"] for r in body["co_changed_with"]}
        self.assertEqual(partners, {"b.py", "c.py"})
        self.assertNotIn("a.py", partners)

    # ---- BUG-1: loki_code_search start/complete event balance ----------

    def test_code_search_balances_events_when_chroma_unavailable(self):
        srv = self.server
        # Force the ChromaDB-unavailable path (the common default).
        orig = srv._get_chroma_collection
        srv._get_chroma_collection = lambda: None
        # Reset the shared timing stack so the assertion is about THIS test.
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.pop("loki_code_search", None)
        try:
            with _ChdirToTmp(self.tmp):
                for _ in range(5):
                    body = json.loads(_run(srv.loki_code_search("anything")))
                    self.assertIn("error", body)  # confirms the early-return path
            # The 'start' events must be drained by matching 'complete' events.
            # _emit_tool_event_async runs the event-bus emit in a daemon thread,
            # but the start-time stack push/pop happens synchronously in the
            # caller, so it is settled by the time loki_code_search returns.
            remaining = srv._tool_call_start_times.get("loki_code_search", [])
            self.assertEqual(
                len(remaining), 0,
                f"start-time stack leaked {len(remaining)} entries; expected 0",
            )
        finally:
            srv._get_chroma_collection = orig
            with srv._tool_call_times_lock:
                srv._tool_call_start_times.pop("loki_code_search", None)


if __name__ == "__main__":
    unittest.main()
