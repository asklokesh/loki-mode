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

# Gracefully handle server import -- requires pip 'mcp' SDK installed
try:
    from .server import mcp
    _SERVER_AVAILABLE = True
except SystemExit:
    mcp = None
    _SERVER_AVAILABLE = False
    _logger.warning(
        "MCP server not available: pip 'mcp' SDK not installed. "
        "Install with: pip install mcp"
    )

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

__version__ = '5.52.1'
