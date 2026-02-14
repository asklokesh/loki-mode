"""Loki Mode MCP Server Package"""
from .server import mcp

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

__version__ = '5.42.1'
