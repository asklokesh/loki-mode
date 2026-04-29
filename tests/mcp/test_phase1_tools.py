"""
tests/mcp/test_phase1_tools.py

Tests for the 3 MCP tools added in v7.5.3:
    - loki_findings(iteration=-1)
    - loki_learnings(limit=50)
    - loki_counter_evidence_template(iteration)

The MCP tools resolve `.loki/` relative to os.getcwd() (see safe_path_join in
mcp/server.py line ~206), so each test chdir()s into a tempdir, seeds the
relevant state files, and invokes the async tool via asyncio.run().

The pip-installed `mcp` SDK on this machine ships FastMCP as a *package*
(mcp/server/fastmcp/__init__.py) but mcp/server.py's importlib loader looks
for fastmcp.py as a *file*. We stub a minimal FastMCP module via a fake
site-packages directory so server.py can import cleanly under test.
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


# ----- One-time stub of FastMCP so `from mcp import server` succeeds --------

_STUB_DIR: str | None = None


def _ensure_fastmcp_stub() -> None:
    """Create a fake site-packages dir with a minimal mcp/server/fastmcp.py
    file and prepend it to site.getsitepackages so mcp/server.py's loader
    finds it. Idempotent."""
    global _STUB_DIR
    if _STUB_DIR is not None:
        return
    stub_root = tempfile.mkdtemp(prefix="loki-mcp-stub-")
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
    _orig = site.getsitepackages
    site.getsitepackages = lambda *a, **kw: [stub_root] + _orig(*a, **kw)  # type: ignore[assignment]
    _STUB_DIR = stub_root


# ----- Helper -------------------------------------------------------------

def _import_server():
    """Import mcp.server (with FastMCP stubbed). Adds repo root to sys.path."""
    _ensure_fastmcp_stub()
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    # Force reimport so the fastmcp loader runs against our stub.
    for k in list(sys.modules.keys()):
        if k == "mcp.server" or k.startswith("mcp.server."):
            del sys.modules[k]
    from mcp import server as _server  # type: ignore
    return _server


def _run(coro):
    return asyncio.run(coro)


class _ChdirToTmp:
    """Context manager: chdir into tmpdir for the duration of the block."""

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


# ----- Tests --------------------------------------------------------------

class Phase1ToolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = _import_server()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mcp-phase1-")
        # Pre-create .loki/ since safe_path_join validates it stays inside it.
        os.makedirs(os.path.join(self.tmp, ".loki"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- loki_findings -------------------------------------------------

    def test_findings_empty_when_no_review_dir(self):
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_findings(iteration=-1))
        body = json.loads(raw)
        self.assertEqual(body.get("findings"), [])
        # review_id is None when nothing exists.
        self.assertIsNone(body.get("review_id"))

    def test_findings_persisted_file_returned_verbatim(self):
        state_dir = os.path.join(self.tmp, ".loki", "state")
        os.makedirs(state_dir, exist_ok=True)
        payload = {
            "iteration": 5,
            "review_id": "review-abc-5",
            "findings": [
                {"severity": "Critical", "reviewer": "eng-qa",
                 "description": "boom at src/x.ts:42",
                 "file": "src/x.ts", "line": 42, "raw": "[Critical] boom at src/x.ts:42"}
            ],
        }
        Path(os.path.join(state_dir, "findings-5.json")).write_text(json.dumps(payload))

        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_findings(iteration=5))
        body = json.loads(raw)
        self.assertEqual(body, payload)

    def test_findings_parses_review_dir_when_no_persisted_file(self):
        reviews_dir = os.path.join(self.tmp, ".loki", "quality", "reviews", "review-xyz-5")
        os.makedirs(reviews_dir, exist_ok=True)
        # eng-qa.txt with a severity-tagged finding referencing a file:line.
        Path(os.path.join(reviews_dir, "eng-qa.txt")).write_text(
            "Some preamble.\n- [Critical] foo at src/x.ts:42\nOther noise.\n"
        )

        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_findings(iteration=5))
        body = json.loads(raw)
        self.assertEqual(body["review_id"], "review-xyz-5")
        findings = body["findings"]
        self.assertEqual(len(findings), 1)
        f = findings[0]
        self.assertEqual(f["severity"], "Critical")
        self.assertEqual(f["reviewer"], "eng-qa")
        self.assertEqual(f["file"], "src/x.ts")
        self.assertEqual(f["line"], 42)

    def test_findings_iter_negative_picks_most_recent(self):
        state_dir = os.path.join(self.tmp, ".loki", "state")
        os.makedirs(state_dir, exist_ok=True)
        # Two persisted findings files; -1 must pick the higher iteration.
        Path(os.path.join(state_dir, "findings-2.json")).write_text(
            json.dumps({"iteration": 2, "review_id": "old", "findings": []})
        )
        Path(os.path.join(state_dir, "findings-9.json")).write_text(
            json.dumps({"iteration": 9, "review_id": "new", "findings": [
                {"severity": "High", "reviewer": "x", "description": "d",
                 "file": None, "line": None, "raw": "[High] d"}
            ]})
        )

        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_findings(iteration=-1))
        body = json.loads(raw)
        self.assertEqual(body["iteration"], 9)
        self.assertEqual(body["review_id"], "new")

    # ---- loki_learnings ------------------------------------------------

    def test_learnings_missing_file(self):
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_learnings(limit=50))
        body = json.loads(raw)
        self.assertEqual(body, {"version": 1, "learnings": [], "total": 0})

    def test_learnings_newest_first_clamped_to_limit(self):
        state_dir = os.path.join(self.tmp, ".loki", "state")
        os.makedirs(state_dir, exist_ok=True)
        learnings = [{"id": i, "msg": f"l{i}"} for i in range(1, 6)]  # oldest..newest
        Path(os.path.join(state_dir, "relevant-learnings.json")).write_text(
            json.dumps({"version": 1, "learnings": learnings})
        )

        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_learnings(limit=3))
        body = json.loads(raw)
        self.assertEqual(body["total"], 5)
        self.assertEqual(body["version"], 1)
        # Newest-first, clamped to 3 -> ids 5, 4, 3.
        self.assertEqual([x["id"] for x in body["learnings"]], [5, 4, 3])

    def test_learnings_tolerates_corrupt_json(self):
        state_dir = os.path.join(self.tmp, ".loki", "state")
        os.makedirs(state_dir, exist_ok=True)
        Path(os.path.join(state_dir, "relevant-learnings.json")).write_text("{ not json")

        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_learnings(limit=10))
        body = json.loads(raw)
        # v7.5.8: corruption now surfaces as an explicit structured envelope
        # rather than being silently masked as an empty result.
        self.assertEqual(body.get("code"), "LEARNINGS_CORRUPT")
        self.assertEqual(body.get("error"), "Learning file corrupted")
        self.assertEqual(body.get("entries"), [])
        self.assertIn("path", body)
        self.assertTrue(body["path"].endswith("relevant-learnings.json"))

    def test_code_search_chroma_exception_returns_generic_envelope(self):
        """Simulated ChromaDB exception must yield the generic CHROMA_QUERY_ERROR
        envelope and must NOT propagate raw exception text to the client."""
        secret_msg = "ConnectionRefusedError: tcp://internal-host:8100/super-secret"

        class _BoomCollection:
            def query(self, *a, **kw):
                raise RuntimeError(secret_msg)

        # Monkey-patch the chroma collection getter used inside loki_code_search.
        orig = self.server._get_chroma_collection
        self.server._get_chroma_collection = lambda: _BoomCollection()
        try:
            with _ChdirToTmp(self.tmp):
                raw = _run(self.server.loki_code_search(query="foo", n_results=1))
        finally:
            self.server._get_chroma_collection = orig

        body = json.loads(raw)
        self.assertEqual(body.get("code"), "CHROMA_QUERY_ERROR")
        self.assertEqual(body.get("error"), "Code search failed")
        self.assertIn("hint", body)
        # Crucial: no raw exception text or internal endpoint leaks to client.
        self.assertNotIn(secret_msg, raw)
        self.assertNotIn("ConnectionRefusedError", raw)
        self.assertNotIn("internal-host", raw)

    # ---- loki_counter_evidence_template --------------------------------

    def test_counter_evidence_no_findings(self):
        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_counter_evidence_template(iteration=7))
        body = json.loads(raw)
        self.assertEqual(body["iteration"], 7)
        self.assertIsNone(body["template"])
        self.assertIn("message", body)
        self.assertIn("No findings", body["message"])

    def test_counter_evidence_filters_critical_high_with_canonical_ids(self):
        state_dir = os.path.join(self.tmp, ".loki", "state")
        os.makedirs(state_dir, exist_ok=True)
        Path(os.path.join(state_dir, "findings-3.json")).write_text(json.dumps({
            "iteration": 3,
            "review_id": "review-abc-3",
            "findings": [
                {"severity": "Critical", "reviewer": "eng-qa",
                 "description": "boom at src/x.ts:42",
                 "file": "src/x.ts", "line": 42,
                 "raw": "[Critical] boom at src/x.ts:42"},
                {"severity": "High", "reviewer": "security",
                 "description": "leak at src/y.ts:7",
                 "file": "src/y.ts", "line": 7,
                 "raw": "[High] leak at src/y.ts:7"},
                {"severity": "Medium", "reviewer": "perf",
                 "description": "slow at src/z.ts:1",
                 "file": "src/z.ts", "line": 1,
                 "raw": "[Medium] slow at src/z.ts:1"},
                {"severity": "Low", "reviewer": "style",
                 "description": "nit at src/w.ts:3",
                 "file": "src/w.ts", "line": 3,
                 "raw": "[Low] nit at src/w.ts:3"},
            ],
        }))

        with _ChdirToTmp(self.tmp):
            raw = _run(self.server.loki_counter_evidence_template(iteration=3))
        body = json.loads(raw)
        self.assertEqual(body["iteration"], 3)
        tpl = body["template"]
        self.assertIsNotNone(tpl)
        self.assertEqual(tpl["iteration"], 3)
        evidence = tpl["evidence"]
        # Only Critical + High survive.
        self.assertEqual(len(evidence), 2)

        ids = [e["findingId"] for e in evidence]
        self.assertIn("eng-qa::[Critical] boom at src/x.ts:42", ids)
        self.assertIn("security::[High] leak at src/y.ts:7", ids)

        # Schema sanity: each entry has the canonical fields.
        for e in evidence:
            self.assertIn("claim", e)
            self.assertIn("proofType", e)
            self.assertIn("artifacts", e)
            self.assertIn("_finding_for_reference", e)
            self.assertIn(e["_finding_for_reference"]["severity"], ("Critical", "High"))

        self.assertIn("usage", body)
        self.assertIn("counter-evidence-3.json", body["usage"])


if __name__ == "__main__":
    unittest.main()
