"""
Loki Mode MCP Server Package

NAMESPACE NOTE:
    This local 'mcp/' package provides the Loki Mode MCP server tools
    (loki_memory_retrieve, loki_task_queue, etc.). It intentionally uses
    the 'mcp' namespace, which shadows the pip-installed 'mcp' SDK
    (FastMCP) when imported from the project root.

    The server module (mcp/server.py) works around this by loading
    FastMCP directly from site-packages via importlib.util, bypassing
    Python's normal package resolution. This means:

      - The pip 'mcp' SDK MUST be installed for the server to start.
        Install with: pip install mcp
      - Importing 'mcp' from the project root yields THIS package,
        not the pip SDK. This is the intended behavior.
      - The server runs correctly via 'python -m mcp.server' as long
        as the pip SDK is installed in site-packages.

    This is a known limitation documented in the integrity audit.
"""

import logging as _logging

_logger = _logging.getLogger('loki-mcp')

# LAZY (PEP 562): `from .server import mcp` at package-import time dragged in
# the whole pip MCP SDK (fastmcp + mcp.types + client.session) -- ~1.4s of the
# ~1.9s it cost to `import mcp.lsp_proxy`. That is paid by EVERY consumer of
# the package, including the one-shot `python3 -m mcp.lsp_proxy
# --write-diagnostics` the lsp_diagnostics quality gate spawns once per
# iteration, which never starts a server. The autonomous loop spent ~2.7s per
# iteration on a writer that reported `measured: false`. Resolving `mcp` and
# `_SERVER_AVAILABLE` through __getattr__ keeps both names working (same
# values, same SystemExit fallback) while charging the SDK load only to code
# that actually touches them. Submodule imports (`from mcp import server`,
# `import mcp.lsp_proxy`) are unaffected -- Python resolves those directly.
_LAZY_SERVER = ('mcp', '_SERVER_AVAILABLE')


def __getattr__(name):
    if name in _LAZY_SERVER:
        try:
            from .server import mcp as _server_mcp
            values = {'mcp': _server_mcp, '_SERVER_AVAILABLE': True}
        except SystemExit:
            values = {'mcp': None, '_SERVER_AVAILABLE': False}
            _logger.warning(
                "MCP server not available: pip 'mcp' SDK not installed. "
                "Install with: pip install mcp"
            )
        globals().update(values)
        return values[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Import learning collector if available
try:
    from .learning_collector import (
        MCPLearningCollector,
        get_mcp_learning_collector,
        ToolStats,
        ToolCallTracker,
        with_learning,
    )
    __all__ = [
        'mcp',
        'MCPLearningCollector',
        'get_mcp_learning_collector',
        'ToolStats',
        'ToolCallTracker',
        'with_learning',
    ]
except ImportError:
    __all__ = ['mcp']

__version__ = '9.22.13'
