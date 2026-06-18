"""
tests/mcp/test_bughunt_event_balance.py

Regression tests for a resource leak + telemetry-correctness bug class in
mcp/server.py.

BUG (start/complete event imbalance): every @mcp.tool emits a 'start' tool
event, which synchronously PUSHES a timestamp onto the module-global
_tool_call_start_times[tool_name] stack. The matching 'complete' event POPS
it. Several tools had early-return paths (file-not-found, no-input,
PathTraversalError handlers) that returned WITHOUT emitting 'complete', so
each such return leaked one entry onto the stack. The guaranteed harm is
unbounded growth of _tool_call_start_times in a long-running server; under
concurrent calls a later 'complete' can also pop a stale start time and
report a wildly wrong execution_time_ms learning signal.

loki_code_search was fixed in isolation (see test_bughunt_co_changes_and_leak)
but the same omission survived in:
  loki_start_project, loki_project_status, loki_agent_metrics,
  loki_checkpoint_restore, loki_quality_report, mem_get, loki_learnings.

The headline test here is a GLOBAL balance invariant: it iterates every
@mcp.tool defined in mcp/server.py, exercises a reachable early-return path
for each, and asserts no orphan entry remains in _tool_call_start_times. That
invariant is what guards against the next missed path, not a per-tool check
of only the tools that happened to be fixed.

Harness mirrors tests/mcp/test_bughunt_co_changes_and_leak.py: stub FastMCP
so mcp.server imports without the SDK, chdir into a tempdir, invoke async
tools via asyncio.run().
"""

from __future__ import annotations

import asyncio
import inspect
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
    stub_root = tempfile.mkdtemp(prefix="loki-mcp-balance-stub-")
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


# Tool-call args that drive each in-file @mcp.tool down a reachable early
# return on a fresh (empty .loki/) tempdir. The point is to exercise a path
# OTHER than the single happy-path 'complete' so a leak would be observed.
# Tools whose only reachable path on a fresh repo is the success path (which
# already emits 'complete') still get exercised here and must also balance.
_FRESH_REPO_CALLS = {
    "loki_memory_retrieve": dict(query="x"),
    "loki_memory_store_pattern": dict(pattern="p", category="c", correct_approach="a"),
    "loki_task_queue_list": dict(),
    "loki_task_queue_add": dict(title="t", description="d"),
    "loki_task_queue_update": dict(task_id="task-0001", status="completed"),
    "loki_state_get": dict(),
    "loki_metrics_efficiency": dict(),
    "loki_memory_capture_session_summary": dict(goal="g"),
    "loki_consolidate_memory": dict(),
    "loki_complete_task": dict(completion_statement="s", evidence="e"),
    "loki_start_project": dict(),  # no content/path -> early error return
    "loki_project_status": dict(),
    "loki_agent_metrics": dict(),
    "loki_checkpoint_restore": dict(),  # no checkpoints dir -> early return
    "loki_quality_report": dict(),
    "mem_search": dict(query="x"),
    "mem_timeline": dict(),
    "mem_get": dict(ids=""),  # no ids -> early error return
    "loki_get_hotspots": dict(),  # no hotspots file -> early return
    "loki_get_co_changes": dict(file_path="a.py"),  # no co-changes file
    "loki_get_doc_coverage": dict(),  # no manifest -> early return
    "loki_findings": dict(),
    "loki_learnings": dict(),  # no learnings file -> early return
    "loki_counter_evidence_template": dict(iteration=0),
}


class EventBalanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _import_server()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mcp-balance-")
        os.makedirs(os.path.join(self.tmp, ".loki"), exist_ok=True)
        # Force ChromaDB-unavailable so loki_code_search* take the known path.
        self._orig_chroma = self.server._get_chroma_collection
        self.server._get_chroma_collection = lambda: None

    def tearDown(self):
        self.server._get_chroma_collection = self._orig_chroma
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _discover_in_file_tools(self):
        """Return {name: callable} for every async @mcp.tool defined IN
        mcp/server.py (not the managed/magic tools registered from other
        modules, which the FastMCP stub does not retain references to)."""
        srv = self.server
        tools = {}
        for name, obj in vars(srv).items():
            if (inspect.iscoroutinefunction(obj)
                    and getattr(obj, "__module__", "") == srv.__name__
                    and name in _FRESH_REPO_CALLS):
                tools[name] = obj
        return tools

    def test_every_in_file_tool_balances_start_complete_events(self):
        srv = self.server
        tools = self._discover_in_file_tools()
        # Non-vacuity: we must actually be exercising a meaningful set of tools.
        self.assertGreaterEqual(
            len(tools), 20,
            f"expected to discover >=20 in-file tools, found {len(tools)}: "
            f"{sorted(tools)}",
        )

        # Airtight guard: every in-file @mcp.tool coroutine must have a call
        # recipe here, EXCEPT the code-search tools (event balance covered in
        # test_bughunt_co_changes_and_leak; they take a different stub path).
        # A future tool added without a _FRESH_REPO_CALLS entry fails here, so
        # the invariant cannot silently skip a newly-introduced leak path.
        srv = self.server
        all_in_file = {
            name
            for name, obj in vars(srv).items()
            if inspect.iscoroutinefunction(obj)
            and getattr(obj, "__module__", "") == srv.__name__
            and name.startswith(("loki_", "mem_"))
        }
        # loki_start / loki_phase_report are @mcp.prompt handlers (not tools):
        # they return a static string and never touch the timing stack.
        exempt = {
            "loki_code_search", "loki_code_search_stats",
            "loki_start", "loki_phase_report",
        }
        unexercised = all_in_file - set(_FRESH_REPO_CALLS) - exempt
        self.assertEqual(
            unexercised, set(),
            f"in-file @mcp.tool coroutines with no _FRESH_REPO_CALLS recipe: "
            f"{sorted(unexercised)} -- add a call recipe so the balance "
            f"invariant exercises them.",
        )

        # Clean slate for the whole stack.
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.clear()

        with _ChdirToTmp(self.tmp):
            for name, fn in sorted(tools.items()):
                kwargs = _FRESH_REPO_CALLS[name]
                # Call each tool TWICE so a per-call leak accumulates and is
                # unmistakable (1 leaked vs 0 expected, then 2 vs 0).
                for _ in range(2):
                    out = _run(fn(**kwargs))
                    # Every tool must return a JSON string envelope, never raise.
                    self.assertIsInstance(out, str)
                    json.loads(out)

        leaks = {
            n: len(v)
            for n, v in srv._tool_call_start_times.items()
            if v
        }
        self.assertEqual(
            leaks, {},
            "start-time stack leaked entries (start emitted without a matching "
            f"complete) for: {leaks}. Each early-return path must emit a "
            "'complete' event before returning.",
        )

    def test_targeted_start_project_no_input_does_not_leak(self):
        # Direct repro for the loki_start_project early-error path.
        srv = self.server
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.pop("loki_start_project", None)
        with _ChdirToTmp(self.tmp):
            for _ in range(3):
                body = json.loads(_run(srv.loki_start_project(prd_content="", prd_path="")))
                self.assertIn("error", body)  # confirms early-return path taken
        remaining = srv._tool_call_start_times.get("loki_start_project", [])
        self.assertEqual(
            len(remaining), 0,
            f"loki_start_project leaked {len(remaining)} start times",
        )

    def test_targeted_checkpoint_restore_no_dir_does_not_leak(self):
        srv = self.server
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.pop("loki_checkpoint_restore", None)
        with _ChdirToTmp(self.tmp):
            for _ in range(3):
                body = json.loads(_run(srv.loki_checkpoint_restore("")))
                self.assertIn("checkpoints", body)  # no-dir early return
        remaining = srv._tool_call_start_times.get("loki_checkpoint_restore", [])
        self.assertEqual(len(remaining), 0)

    def test_targeted_mem_get_no_ids_does_not_leak(self):
        srv = self.server
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.pop("mem_get", None)
        with _ChdirToTmp(self.tmp):
            # mem_get returns early on no-ids only if base_path exists; seed it.
            os.makedirs(os.path.join(self.tmp, ".loki", "memory"), exist_ok=True)
            for _ in range(3):
                body = json.loads(_run(srv.mem_get(ids="")))
                self.assertEqual(body.get("error"), "No IDs provided")
        remaining = srv._tool_call_start_times.get("mem_get", [])
        self.assertEqual(len(remaining), 0)

    def test_targeted_learnings_no_file_does_not_leak(self):
        srv = self.server
        with srv._tool_call_times_lock:
            srv._tool_call_start_times.pop("loki_learnings", None)
        with _ChdirToTmp(self.tmp):
            for _ in range(3):
                body = json.loads(_run(srv.loki_learnings()))
                self.assertEqual(body.get("learnings"), [])
        remaining = srv._tool_call_start_times.get("loki_learnings", [])
        self.assertEqual(len(remaining), 0)


if __name__ == "__main__":
    unittest.main()
