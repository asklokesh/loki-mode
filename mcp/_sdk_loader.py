#!/usr/bin/env python3
"""
mcp/_sdk_loader.py -- shared pip-MCP-SDK FastMCP loader.

Extracted verbatim from mcp/server.py (task 566) so BOTH the main server
(mcp/server.py) and the LSP proxy (mcp/lsp_proxy.py) load the genuine pip
MCP SDK's FastMCP through one battle-tested code path. Importing this module
has NO side effects (no FastMCP instantiation, no sys.exit, no tool
registration), so consumers can pull the helpers in without booting a server.

============================================================
Loading the pip MCP SDK's FastMCP under a NAMESPACE COLLISION
============================================================

Root cause (task 562, re-applied to the proxy in task 566): this repo ships
a local package named `mcp/` (this module is mcp/_sdk_loader.py). That local
package SHADOWS the pip-installed MCP SDK, which is also named `mcp`. The two
cannot both own the top-level `mcp` name in one interpreter.

The pre-task code tried to sidestep this by loading mcp/server/fastmcp.py
directly from site-packages via importlib. That worked for the SDK's old
single-FILE layout, but MCP SDK 1.x ships FastMCP as a PACKAGE DIRECTORY
(mcp/server/fastmcp/__init__.py) whose own code does absolute imports like
`from mcp.types import Icon` and `from mcp.server.lowlevel import Server`.
Under shadowing those resolve to the LOCAL package and raise
`ModuleNotFoundError: No module named 'mcp.types'`, so FastMCP never loads.
mcp/server.py used to sys.exit(1) on that; mcp/lsp_proxy.py used to silently
degrade to a no-op shim, so its LSP tools never loaded for consumers.

So the real fix is NOT file-vs-directory detection: it is resolving the
namespace collision so the genuine SDK can import its own `mcp.*` subtree.
We do this by temporarily letting the REAL SDK own the `mcp` name:
  1. snapshot + evict the local `mcp` / `mcp.*` modules from sys.modules,
  2. drop the repo root (and "" / ".") from sys.path so the next import of
     `mcp` resolves to site-packages, not the local package,
  3. import the real `mcp.server.fastmcp` (and eagerly `mcp.types`), which
     transitively caches the real `mcp.*` subtree in sys.modules,
  4. restore the LOCAL `mcp` and `mcp.server` entries so the rest of this
     codebase keeps using the local package for its own relative imports,
     while the real SDK submodules (mcp.types, mcp.shared.*,
     mcp.server.fastmcp.*, mcp.server.lowlevel.*) stay cached for the SDK's
     runtime use. FastMCP holds direct references to its dependencies once
     imported, so it does not re-resolve `mcp.server` by name at runtime.

This is the least-invasive fix (it does not rename the local package, which
mcp/__init__.py documents as intended behavior). It is inherently a bit
fragile because it juggles sys.modules; the regression test for this code
path is an END-TO-END one (start the server, complete an MCP stdio
handshake, list tools), not a file-exists check, because only a real
handshake proves FastMCP actually loaded and the subtree resolved.
"""

from __future__ import annotations

import importlib
import logging
import os
import site
import sys

logger = logging.getLogger('loki-mcp-sdk-loader')


def _real_mcp_search_dirs():
    """Ordered site directories to search for the pip MCP SDK."""
    dirs = []
    try:
        dirs.extend(site.getsitepackages())
    except AttributeError:
        pass
    try:
        dirs.append(site.getusersitepackages())
    except AttributeError:
        pass
    return dirs


def _mcp_sdk_present(search_dirs=None):
    """True if the pip MCP SDK appears installed in any site dir, accepting
    both the legacy single-file layout and the 1.x package-directory layout.

    Pure filesystem probe (no import side effects), kept standalone so the
    both-layouts behaviour can be unit-tested against mktemp fixture dirs.
    """
    if search_dirs is None:
        search_dirs = _real_mcp_search_dirs()
    for _site_dir in search_dirs:
        if not _site_dir:
            continue
        _file_layout = os.path.join(_site_dir, "mcp", "server", "fastmcp.py")
        _pkg_layout = os.path.join(
            _site_dir, "mcp", "server", "fastmcp", "__init__.py"
        )
        if os.path.isfile(_file_layout) or os.path.isfile(_pkg_layout):
            return True
    return False


def _load_real_fastmcp():
    """Import the genuine pip MCP SDK's FastMCP class, resolving the local-vs-
    SDK `mcp` namespace collision. Returns the FastMCP class, or None if the
    SDK cannot be loaded. Restores the local `mcp`/`mcp.server` modules before
    returning so the rest of this module keeps working unchanged.
    """
    if not _mcp_sdk_present():
        return None

    # 1. Snapshot every currently-loaded local `mcp`/`mcp.*` module so we can
    #    restore the ones this codebase depends on afterwards.
    _saved_local = {
        _k: _v for _k, _v in list(sys.modules.items())
        if _k == "mcp" or _k.startswith("mcp.")
    }
    # 2. Evict them so the real SDK can claim the `mcp` name on import.
    for _k in list(_saved_local):
        del sys.modules[_k]

    # 3. Drop repo-root / cwd entries from sys.path for the SDK import so
    #    `mcp` resolves to site-packages rather than the local package.
    _repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _saved_path = sys.path[:]
    sys.path[:] = [
        _p for _p in sys.path
        if _p not in ("", ".")
        and os.path.abspath(_p) != os.path.abspath(_repo_root)
    ]

    _fastmcp_cls = None
    try:
        _real_fastmcp = importlib.import_module("mcp.server.fastmcp")
        # Eagerly import the subtree FastMCP touches at runtime so the real
        # modules are cached before we restore the local `mcp` over the name.
        importlib.import_module("mcp.types")
        importlib.import_module("mcp.server.lowlevel")
        _fastmcp_cls = getattr(_real_fastmcp, "FastMCP", None)
    except Exception as _exc:  # pragma: no cover - defensive
        logger.error("Failed to import the pip MCP SDK FastMCP: %s", _exc)
        _fastmcp_cls = None
    finally:
        # 4. Restore sys.path and re-pin the LOCAL `mcp` + `mcp.server` modules
        #    so this codebase's own relative/absolute imports keep resolving
        #    locally. We intentionally leave the real `mcp.types`,
        #    `mcp.shared.*`, `mcp.server.fastmcp.*`, and `mcp.server.lowlevel.*`
        #    cached for the SDK's runtime use; the local package never defined
        #    those submodules, so there is nothing to clobber.
        sys.path[:] = _saved_path
        for _k in ("mcp", "mcp.server"):
            if _k in _saved_local:
                sys.modules[_k] = _saved_local[_k]
        for _k, _v in _saved_local.items():
            # Restore any other purely-local submodules that the SDK import did
            # not legitimately replace (e.g. mcp.magic_tools, mcp.tools).
            _real = sys.modules.get(_k)
            if _real is None:
                sys.modules[_k] = _v

    return _fastmcp_cls
