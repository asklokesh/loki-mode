"""
tests/mcp/test_mcp_wave5_w5.py

Regression tests for the Wave-5 bug-hunt findings fixed in mcp/server.py:

M3 (loki_findings) and M4 (loki_counter_evidence_template): both tools emit a
'start' tool event but their early `return` paths (no reviews dir / no
candidates / no findings) used to skip the matching 'complete' event. That
leaked one entry per call into the module-global _tool_call_start_times stack
and let a later call pop a stale start time, producing a wildly wrong
execution_time_ms learning signal. The fix emits 'complete' on every return
path. These tests drive the early-return paths on a fresh repo and assert the
per-tool start-time stack stays balanced (0 after the call).

M5 (loki_code_search): the async tool called the synchronous
_maybe_autoreindex_code (which runs a subprocess up to 300s) and the blocking
collection.query directly on the event loop. The fix offloads both via
asyncio.to_thread. The test installs a fake collection whose query records the
thread it ran on and asserts it ran off the main thread (proving the loop is
not blocked).

L3 (loki_get_co_changes): a co-changes.json with mixed-type counts (one row's
count a string, another's an int) used to raise TypeError when sorting and
abort the whole tool. The fix coerces counts to int (skipping non-numeric).
This test feeds a mixed-type file and asserts a sorted, crash-free result.

L4 (loki_task_queue_add): an existing-but-malformed task-queue.json dict that
lacks a "tasks" key used to raise KeyError on append. The fix uses
queue.setdefault. This test pre-writes a malformed queue and asserts the add
succeeds.

Harness mirrors tests/mcp/test_bughunt_co_changes_and_leak.py: stub FastMCP so
mcp.server imports without the SDK, chdir into a tempdir, seed .loki/ state,
invoke the async tools via asyncio.run().
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
import threading
import unittest
from pathlib import Path


_STUB_DIR: str | None = None


def _ensure_fastmcp_stub() -> None:
    global _STUB_DIR
    if _STUB_DIR is not None:
        return
    stub_root = tempfile.mkdtemp(prefix="loki-mcp-wave5-stub-")
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


class _RecordingCollection:
    """Fake Chroma collection whose query records the thread it ran on."""

    def __init__(self):
        self.query_thread_ident: int | None = None

    def query(self, **kwargs):
        self.query_thread_ident = threading.get_ident()
        # Minimal Chroma-shaped result: a single empty hit list per field.
        return {
            "ids": [[]],
            "metadatas": [[]],
            "documents": [[]],
            "distances": [[]],
        }


class Wave5Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _import_server()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mcp-wave5-")
        os.makedirs(os.path.join(self.tmp, ".loki"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _stack(self, tool: str):
        srv = self.server
        with srv._tool_call_times_lock:
            return list(srv._tool_call_start_times.get(tool, []))

    def _reset_stack(self, tool: str):
        srv = self.server
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.pop(tool, None)

    # ---- M3: loki_findings start/complete balance on early returns -----

    def test_findings_balances_events_on_fresh_repo(self):
        # Fresh repo: no .loki/quality/reviews dir -> hits the early return at
        # the top of the reviews path. Pre-fix this skipped 'complete' and
        # leaked a start time per call.
        self._reset_stack("loki_findings")
        with _ChdirToTmp(self.tmp):
            for _ in range(5):
                body = json.loads(_run(self.server.loki_findings(iteration=-1)))
                # Confirms the early-return path (empty findings, no error).
                self.assertNotIn("error", body)
                self.assertEqual(body["findings"], [])
        remaining = self._stack("loki_findings")
        self.assertEqual(
            len(remaining), 0,
            f"loki_findings start-time stack leaked {len(remaining)} entries; expected 0",
        )
        self._reset_stack("loki_findings")

    def test_findings_balances_when_reviews_dir_has_no_candidates(self):
        # reviews dir exists but contains no review-* dirs -> hits the second
        # early return ("no candidates"). Must also emit 'complete'.
        reviews = os.path.join(self.tmp, ".loki", "quality", "reviews")
        os.makedirs(reviews, exist_ok=True)
        self._reset_stack("loki_findings")
        with _ChdirToTmp(self.tmp):
            for _ in range(3):
                body = json.loads(_run(self.server.loki_findings(iteration=-1)))
                self.assertNotIn("error", body)
                self.assertEqual(body["findings"], [])
        remaining = self._stack("loki_findings")
        self.assertEqual(len(remaining), 0,
                         f"loki_findings leaked {len(remaining)} entries; expected 0")
        self._reset_stack("loki_findings")

    # ---- M4: loki_counter_evidence_template start/complete balance ------

    def test_counter_evidence_template_balances_events_on_fresh_repo(self):
        # On a fresh repo loki_findings returns empty findings, so
        # loki_counter_evidence_template hits its "no findings" early return.
        # Pre-fix this skipped 'complete'. Both tools' stacks must end at 0.
        self._reset_stack("loki_counter_evidence_template")
        self._reset_stack("loki_findings")
        with _ChdirToTmp(self.tmp):
            for _ in range(5):
                body = json.loads(
                    _run(self.server.loki_counter_evidence_template(iteration=-1))
                )
                # "no findings" path: template is None with a message.
                self.assertIsNone(body.get("template"))
        remaining = self._stack("loki_counter_evidence_template")
        self.assertEqual(
            len(remaining), 0,
            f"loki_counter_evidence_template start-time stack leaked "
            f"{len(remaining)} entries; expected 0",
        )
        # The nested loki_findings call must also stay balanced.
        nested = self._stack("loki_findings")
        self.assertEqual(len(nested), 0,
                         f"nested loki_findings leaked {len(nested)} entries; expected 0")
        self._reset_stack("loki_counter_evidence_template")
        self._reset_stack("loki_findings")

    # ---- M5: loki_code_search offloads blocking work off the loop --------

    def test_code_search_runs_query_off_the_event_loop(self):
        srv = self.server
        fake = _RecordingCollection()
        orig_collection = srv._get_chroma_collection
        orig_reindex = srv._maybe_autoreindex_code
        reindex_thread = {"ident": None}

        def _record_reindex():
            reindex_thread["ident"] = threading.get_ident()

        srv._get_chroma_collection = lambda: fake
        srv._maybe_autoreindex_code = _record_reindex
        self._reset_stack("loki_code_search")
        try:
            main_ident = threading.get_ident()
            with _ChdirToTmp(self.tmp):
                body = json.loads(_run(srv.loki_code_search("anything")))
            # The query ran and returned a (empty) result envelope, not an error.
            self.assertNotIn("error", body)
            self.assertEqual(body["results"], [])
            # The blocking query must have executed on a worker thread, not the
            # event loop's main thread. If it were called directly, the ident
            # would equal the main thread's.
            self.assertIsNotNone(fake.query_thread_ident,
                                 "collection.query was never invoked")
            self.assertNotEqual(
                fake.query_thread_ident, main_ident,
                "collection.query ran on the main/event-loop thread "
                "(asyncio.to_thread offload missing)",
            )
            # The autoreindex helper must also be offloaded off the loop.
            self.assertIsNotNone(reindex_thread["ident"],
                                 "_maybe_autoreindex_code was never invoked")
            self.assertNotEqual(
                reindex_thread["ident"], main_ident,
                "_maybe_autoreindex_code ran on the main/event-loop thread "
                "(asyncio.to_thread offload missing)",
            )
        finally:
            srv._get_chroma_collection = orig_collection
            srv._maybe_autoreindex_code = orig_reindex
            self._reset_stack("loki_code_search")

    # ---- L3: loki_get_co_changes survives mixed-type counts -------------

    def test_co_changes_handles_mixed_type_counts(self):
        intel = os.path.join(self.tmp, ".loki", "intelligence")
        os.makedirs(intel, exist_ok=True)
        # One row has a string count, another an int. Pre-fix the sort raised
        # TypeError comparing str < int and the whole tool returned an error.
        with open(os.path.join(intel, "co-changes.json"), "w") as f:
            json.dump([
                [["a.py", "b.py"], "5"],   # string count
                [["a.py", "c.py"], 9],     # int count
                [["a.py", "d.py"], "two"], # non-numeric: must be skipped
            ], f)
        with _ChdirToTmp(self.tmp):
            body = json.loads(_run(self.server.loki_get_co_changes("a.py")))
        self.assertNotIn("error", body)
        partners = [r["partner"] for r in body["co_changed_with"]]
        # Sorted by coerced count descending: c.py (9) before b.py (5);
        # d.py ("two") dropped as non-numeric.
        self.assertEqual(partners, ["c.py", "b.py"])
        counts = [r["co_changes"] for r in body["co_changed_with"]]
        self.assertEqual(counts, [9, 5])

    # ---- L4: loki_task_queue_add survives a malformed queue --------------

    def test_task_queue_add_on_malformed_queue_without_tasks_key(self):
        srv = self.server
        state = os.path.join(self.tmp, ".loki", "state")
        os.makedirs(state, exist_ok=True)
        # Existing queue dict that lacks the "tasks" key. Pre-fix the direct
        # queue["tasks"].append raised KeyError (caught -> error envelope).
        with open(os.path.join(state, "task-queue.json"), "w") as f:
            json.dump({"version": "1.0"}, f)
        # Force the direct file-read/write path (the one that does the
        # vulnerable append) rather than the StateManager path, which would
        # supply a default {"tasks": []} and never read our malformed file.
        orig_avail = srv.STATE_MANAGER_AVAILABLE
        srv.STATE_MANAGER_AVAILABLE = False
        try:
            with _ChdirToTmp(self.tmp):
                body = json.loads(_run(srv.loki_task_queue_add(
                    title="t1", description="d1",
                )))
            self.assertTrue(body.get("success"),
                            f"expected success, got {body}")
            self.assertIn("task_id", body)
            # The task must have actually landed in the (repaired) queue.
            with open(os.path.join(state, "task-queue.json")) as f:
                saved = json.load(f)
            self.assertEqual(len(saved["tasks"]), 1)
            self.assertEqual(saved["tasks"][0]["title"], "t1")
        finally:
            srv.STATE_MANAGER_AVAILABLE = orig_avail


if __name__ == "__main__":
    unittest.main()
