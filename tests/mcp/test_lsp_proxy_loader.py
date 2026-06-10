"""
tests/mcp/test_lsp_proxy_loader.py

Task 566 regression suite for the LSP proxy FastMCP loader.

THE BUG: mcp/lsp_proxy.py used to load FastMCP via its own importlib.util
shim. Under MCP SDK 1.x (FastMCP shipped as a package DIRECTORY), that shim
failed on the local-vs-SDK `mcp` namespace collision and SILENTLY degraded to
a no-op shim, so the proxy's LSP tools never loaded for real consumers even
with the SDK installed.

THE FIX: lsp_proxy.py now loads FastMCP through the SAME shared loader that
mcp/server.py uses (mcp/_sdk_loader.py), which resolves the collision under
both SDK layouts. When the SDK is genuinely absent it degrades to a no-op
shim, but LOUDLY (one warning line naming the cause), never silently.

These tests:
  1. proxy loads the REAL FastMCP (not _NoopFastMCP) under a package-DIR SDK
     fixture -- this is the exact layout the bug degraded on;
  2. proxy degrades to _NoopFastMCP and emits exactly one loud warning naming
     the cause when the SDK is genuinely absent.

server.py behavior-unchanged is covered by tests/mcp/test_phase1_tools.py.

The pip-installed `mcp` SDK is not available for every interpreter that runs
this suite (e.g. python3.12 on this Mac lacks it), so -- exactly like the
phase1 suite -- we stub a minimal FastMCP via a fake site-packages directory
in the 1.x package-DIR layout and point the shared loader's site search at it.
"""

from __future__ import annotations

import importlib
import logging
import os
import shutil
import site
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _make_pkg_dir_sdk_stub() -> str:
    """Create a fake site-packages dir holding a minimal MCP SDK in the 1.x
    package-DIRECTORY layout (mcp/server/fastmcp/__init__.py), plus the
    mcp.types and mcp.server.lowlevel submodules the shared loader eagerly
    imports. Returns the stub root.

    HONEST SCOPE NOTE: this stub is NOT enough to make
    test_loads_real_fastmcp_under_package_dir_sdk discriminate old-vs-new
    loader. Importing mcp.lsp_proxy triggers mcp/__init__.py -> `from .server
    import mcp`, so server.py's loader runs FIRST and pre-caches the same
    mcp.* subtree FastMCP touches; by the time the proxy's own loader runs,
    those imports are already satisfied from sys.modules regardless of which
    loader the proxy uses. So the full-import test below is a SMOKE test of
    the new wiring, not a red-on-old guard. The faithful old-vs-new guard is
    the real-SDK stdio handshake (see this module's docstring and
    scripts/local-ci.sh): new code serves 7 LSP tools from a non-repo cwd;
    the old code logged "MCP SDK not found" and served none."""
    # Prefix deliberately avoids the `loki-` family so it never matches the
    # standing `/tmp/loki-*` cleanup glob (which can kill live loki-run-*
    # scripts). Caller registers shutil.rmtree cleanup; see addCleanup below.
    stub_root = tempfile.mkdtemp(prefix="t566-lsp-loader-stub-")
    server_dir = os.path.join(stub_root, "mcp", "server")
    fastmcp_dir = os.path.join(server_dir, "fastmcp")
    lowlevel_dir = os.path.join(server_dir, "lowlevel")
    os.makedirs(fastmcp_dir, exist_ok=True)
    os.makedirs(lowlevel_dir, exist_ok=True)
    Path(os.path.join(stub_root, "mcp", "__init__.py")).write_text("")
    Path(os.path.join(stub_root, "mcp", "types.py")).write_text("")
    Path(os.path.join(server_dir, "__init__.py")).write_text("")
    Path(os.path.join(lowlevel_dir, "__init__.py")).write_text("")
    # The FastMCP stub mirrors the real SDK shape: tool/resource/prompt
    # decorators (server.py registers resources + prompts, so its import under
    # this stub needs them) and a no-op run(). Not load-bearing for the loader
    # path itself; just enough for a clean import.
    Path(os.path.join(fastmcp_dir, "__init__.py")).write_text(textwrap.dedent("""
        class FastMCP:
            def __init__(self, *args, **kwargs):
                self._args = args
                self._kwargs = kwargs
            def tool(self, *a, **kw):
                def deco(fn):
                    return fn
                return deco
            def resource(self, *a, **kw):
                def deco(fn):
                    return fn
                return deco
            def prompt(self, *a, **kw):
                def deco(fn):
                    return fn
                return deco
            def run(self, *a, **kw):
                pass
    """))
    return stub_root


class _SitePatch:
    """Prepend a stub dir to site.getsitepackages and put it on sys.path
    (behind repo_root so the repo's own mcp package keeps winning at
    test-import time). Restores both on exit. Mirrors the phase1 suite's
    contract so the shared loader resolves the stub SDK."""

    def __init__(self, stub_root: str):
        self.stub_root = stub_root
        self._orig_getsite = site.getsitepackages
        self._added_path = False

    def __enter__(self):
        stub = self.stub_root
        _orig = self._orig_getsite
        site.getsitepackages = lambda *a, **kw: [stub] + _orig(*a, **kw)  # type: ignore[assignment]
        repo_root = _repo_root()
        for _p in (repo_root, stub):
            while _p in sys.path:
                sys.path.remove(_p)
        sys.path.insert(0, stub)
        sys.path.insert(0, repo_root)
        self._added_path = True
        return self

    def __exit__(self, exc_type, exc, tb):
        site.getsitepackages = self._orig_getsite  # type: ignore[assignment]
        if self._added_path:
            while self.stub_root in sys.path:
                sys.path.remove(self.stub_root)


def _import_lsp_proxy_fresh():
    """Import mcp.lsp_proxy with the repo root on sys.path, forcing a fresh
    import so the module-level loader re-runs against whatever stub/state the
    caller set up."""
    repo_root = _repo_root()
    while repo_root in sys.path:
        sys.path.remove(repo_root)
    sys.path.insert(0, repo_root)
    for k in list(sys.modules.keys()):
        if k == "mcp.lsp_proxy" or k == "mcp._sdk_loader":
            del sys.modules[k]
    return importlib.import_module("mcp.lsp_proxy")


class LspProxyLoaderTests(unittest.TestCase):
    def test_loads_real_fastmcp_under_package_dir_sdk(self):
        """Smoke test: under a 1.x package-DIR SDK fixture, the proxy wires
        through _sdk_loader and _build_lsp_fastmcp to load the REAL FastMCP
        (not the no-op shim) and instantiate `mcp` from it. See
        _make_pkg_dir_sdk_stub's HONEST SCOPE NOTE: this does NOT discriminate
        old-vs-new loader (server.py's import pre-caches the subtree); the
        faithful old-vs-new guard is the real-SDK stdio handshake."""
        stub_root = _make_pkg_dir_sdk_stub()
        self.addCleanup(shutil.rmtree, stub_root, ignore_errors=True)
        try:
            with _SitePatch(stub_root):
                proxy = _import_lsp_proxy_fresh()
                self.assertIsNot(
                    proxy.FastMCP, proxy._NoopFastMCP,
                    "proxy wiring degraded to _NoopFastMCP under a present "
                    "package-dir SDK fixture -- the _sdk_loader path is broken",
                )
                self.assertEqual(proxy.FastMCP.__name__, "FastMCP")
                # mcp instance must be built from the real class, not the shim.
                self.assertIsInstance(proxy.mcp, proxy.FastMCP)
                self.assertNotIsInstance(proxy.mcp, proxy._NoopFastMCP)
        finally:
            _cleanup_stub_modules()

    def test_degrades_loudly_when_sdk_absent(self):
        """When the SDK is genuinely absent, the proxy degrades to
        _NoopFastMCP AND logs exactly one warning naming the cause -- never
        a silent degrade."""
        # Force the absent branch deterministically: the real SDK is installed
        # for some interpreters on this machine, so monkeypatch the shared
        # loader's presence probe to False rather than relying on absence.
        loader = importlib.import_module("mcp._sdk_loader")
        orig_present = loader._mcp_sdk_present
        loader._mcp_sdk_present = lambda *a, **kw: False  # type: ignore[assignment]

        proxy_logger = logging.getLogger("loki-mcp-lsp-proxy")
        records = []

        class _Capture(logging.Handler):
            def emit(self, record):
                records.append(record)

        handler = _Capture()
        proxy_logger.addHandler(handler)
        try:
            for k in list(sys.modules.keys()):
                if k == "mcp.lsp_proxy":
                    del sys.modules[k]
            repo_root = _repo_root()
            while repo_root in sys.path:
                sys.path.remove(repo_root)
            sys.path.insert(0, repo_root)
            proxy = importlib.import_module("mcp.lsp_proxy")
            self.assertIs(
                proxy.FastMCP, proxy._NoopFastMCP,
                "proxy did not degrade to _NoopFastMCP when SDK absent",
            )
            self.assertIsInstance(proxy.mcp, proxy._NoopFastMCP)
            # run() on the noop must raise a clear, actionable error.
            with self.assertRaises(RuntimeError):
                proxy.mcp.run()
            # Exactly one WARNING naming the cause (the SDK), not silent.
            warnings = [r for r in records if r.levelno == logging.WARNING]
            self.assertEqual(
                len(warnings), 1,
                f"expected exactly one loud warning, got {len(warnings)}: "
                f"{[r.getMessage() for r in warnings]}",
            )
            msg = warnings[0].getMessage()
            self.assertIn("MCP SDK", msg)
            self.assertIn("not found", msg)
        finally:
            proxy_logger.removeHandler(handler)
            loader._mcp_sdk_present = orig_present  # type: ignore[assignment]
            _cleanup_stub_modules()


def _cleanup_stub_modules():
    """Drop the freshly-imported proxy/loader so later suites re-import
    cleanly against the real environment."""
    for k in list(sys.modules.keys()):
        if k == "mcp.lsp_proxy" or k == "mcp._sdk_loader":
            del sys.modules[k]


class TestLspProxyDocstringConsistency(unittest.TestCase):
    """v7.31 finding 9: the module docstring's 'Tools:' section must enumerate
    exactly the tools actually registered via @mcp.tool(). Static source parse;
    no SDK or interpreter import needed, so it runs on every host."""

    def test_docstring_tool_count_matches_registered_tools(self):
        import re

        src = open(
            os.path.join(_repo_root(), "mcp", "lsp_proxy.py"), encoding="utf-8"
        ).read()

        # Registered tools: every `@mcp.tool()`-decorated `async def lsp_...`.
        registered = re.findall(
            r"@mcp\.tool\(\)\s*\n\s*async def (lsp_[A-Za-z0-9_]+)", src
        )
        self.assertEqual(
            len(registered), 7,
            f"expected 7 registered lsp tools, found {len(registered)}: {registered}",
        )

        # Docstring header must declare the same count.
        header = re.search(r"Tools \((\d+)\):", src)
        self.assertIsNotNone(
            header, "module docstring is missing a 'Tools (N):' header"
        )
        self.assertEqual(
            int(header.group(1)), len(registered),
            "docstring 'Tools (N)' count does not match registered tool count",
        )

        # Each registered tool name must appear in the docstring Tools section.
        doc = re.search(r"Tools \(\d+\):\n(.*?)\n\nUsage:", src, re.S)
        self.assertIsNotNone(doc, "could not isolate the docstring Tools section")
        doc_body = doc.group(1)
        for name in registered:
            self.assertIn(
                name, doc_body,
                f"registered tool '{name}' is not documented in the docstring",
            )


if __name__ == "__main__":
    unittest.main()
