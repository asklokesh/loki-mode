"""Regression test for the MCP mem_search collection filter.

BUG (mcp/server.py): mem_search filtered results by the requested collection
using r.get('_type', r.get('type','unknown')). retrieve_task_aware tags every
item with _source in {episodic, semantic, skills, anti_patterns} and never emits
_type/type, so result_type was always 'unknown' and EVERY result was dropped
whenever collection != 'all'. collection=patterns|episodes|skills returned
count:0; only collection='all' worked.

The fix maps _source to the public collection vocabulary
(episodic->episode, semantic->pattern, skills->skill, anti_patterns->pattern)
before applying the filter, keeping _type/type as a fallback.

This test stubs retrieve_task_aware to return items carrying _source and
asserts the collection filter selects the right subset.

Harness mirrors tests/mcp/test_mcp_wave5_w5.py: stub FastMCP so mcp.server
imports without the SDK, chdir into a tempdir with a .loki/memory dir, and call
the async mem_search tool via asyncio.run().
"""

from __future__ import annotations

import asyncio
import json
import os
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
    stub_root = tempfile.mkdtemp(prefix="loki-mcp-memsearch-stub-")
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


# Items as retrieve_task_aware actually emits them: tagged with _source, never
# _type/type.
_FAKE_RESULTS = [
    {"id": "ep1", "_source": "episodic", "goal": "build the api", "_score": 0.9},
    {"id": "ep2", "_source": "episodic", "goal": "fix the bug", "_score": 0.8},
    {"id": "sem1", "_source": "semantic", "pattern": "retry with backoff", "_score": 0.7},
    {"id": "sk1", "_source": "skills", "name": "deploy_to_k8s", "_score": 0.6},
    {"id": "anti1", "_source": "anti_patterns", "description": "never sleep in a loop", "_score": 0.5},
]


class _FakeRetriever:
    def __init__(self, *a, **kw):
        pass

    def retrieve_task_aware(self, context, top_k=5, **kw):
        return list(_FAKE_RESULTS)


class _FakeStorage:
    def __init__(self, *a, **kw):
        pass


class MemSearchCollectionFilterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-memsearch-")
        os.makedirs(os.path.join(self.tmp, ".loki", "memory"), exist_ok=True)
        self._prev_cwd = os.getcwd()
        os.chdir(self.tmp)
        self.server = _import_server()
        # Patch the retrieval/storage classes the tool imports lazily.
        import memory.retrieval as retrieval_mod
        import memory.storage as storage_mod
        self._orig_retriever = retrieval_mod.MemoryRetrieval
        self._orig_storage = storage_mod.MemoryStorage
        retrieval_mod.MemoryRetrieval = _FakeRetriever
        storage_mod.MemoryStorage = _FakeStorage

    def tearDown(self):
        import memory.retrieval as retrieval_mod
        import memory.storage as storage_mod
        retrieval_mod.MemoryRetrieval = self._orig_retriever
        storage_mod.MemoryStorage = self._orig_storage
        os.chdir(self._prev_cwd)

    def _search(self, collection):
        out = asyncio.run(self.server.mem_search(query="anything", collection=collection, limit=10))
        return json.loads(out)

    def test_all_returns_everything(self):
        data = self._search("all")
        self.assertEqual(data["count"], 5, data)

    def test_episodes_returns_only_episodes(self):
        data = self._search("episodes")
        ids = {r["id"] for r in data["results"]}
        self.assertEqual(ids, {"ep1", "ep2"}, data)
        self.assertEqual(data["count"], 2, data)

    def test_skills_returns_only_skills(self):
        data = self._search("skills")
        ids = {r["id"] for r in data["results"]}
        self.assertEqual(ids, {"sk1"}, data)

    def test_patterns_includes_semantic_and_anti_patterns(self):
        # Both semantic and anti_patterns map to the public 'pattern' type.
        data = self._search("patterns")
        ids = {r["id"] for r in data["results"]}
        self.assertEqual(ids, {"sem1", "anti1"}, data)
        # Pre-fix this returned count:0; the bug regression guard.
        self.assertEqual(data["count"], 2, data)


if __name__ == "__main__":
    unittest.main()
