"""
Loki Mode MCP Learning Collector

Collects learning signals from MCP tool calls for cross-tool learning.
Emits signals for:
- Tool efficiency (timing, success rates)
- Error patterns (tool failures)
- Success patterns (tool successes)
- Context relevance (memory/resource access)

Non-blocking emission ensures MCP tool performance is not impacted.

See docs/SYNERGY-ROADMAP.md for full architecture documentation.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TypeVar

# Add parent directory to path for learning imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import learning emitter
try:
    from learning import (
        SignalSource,
        Outcome,
        emit_tool_efficiency,
        emit_error_pattern,
        emit_success_pattern,
        emit_context_relevance,
    )
    LEARNING_AVAILABLE = True
except ImportError:
    LEARNING_AVAILABLE = False
    SignalSource = None
    Outcome = None

logger = logging.getLogger('loki-mcp-learning')


# -----------------------------------------------------------------------------
# Tool Statistics Tracking
# -----------------------------------------------------------------------------


@dataclass
class ToolStats:
    """
    Statistics for a single MCP tool.

    Tracks call counts, success/failure rates, and timing information
    for learning signal generation.
    """
    tool_name: str
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    total_execution_time_ms: int = 0
    last_call_time: Optional[datetime] = None

    @property
    def success_rate(self) -> float:
        """Calculate success rate (0.0-1.0)."""
        if self.total_calls == 0:
            return 1.0
        return self.successful_calls / self.total_calls

    @property
    def avg_execution_time_ms(self) -> int:
        """Calculate average execution time in milliseconds."""
        if self.total_calls == 0:
            return 0
        return self.total_execution_time_ms // self.total_calls

    def record_call(self, success: bool, execution_time_ms: int) -> None:
        """Record a tool call."""
        self.total_calls += 1
        if success:
            self.successful_calls += 1
        else:
            self.failed_calls += 1
        self.total_execution_time_ms += execution_time_ms
        self.last_call_time = datetime.now(timezone.utc)


# -----------------------------------------------------------------------------
# Learning Collector Class
# -----------------------------------------------------------------------------


class MCPLearningCollector:
    """
    Collects and emits learning signals from MCP tool calls.

    Provides non-blocking signal emission with statistics tracking.
    Designed to wrap MCP tool handlers without impacting performance.

    Usage:
        collector = MCPLearningCollector()

        # Manual emission
        collector.emit_tool_efficiency(
            tool_name='loki_memory_retrieve',
            action='retrieve memory',
            execution_time_ms=150,
            success=True
        )

        # Context manager for timing
        with collector.track_tool_call('loki_memory_retrieve', {'query': 'test'}):
            # Tool execution
            result = await some_tool_function()

    Attributes:
        loki_dir: Path to .loki directory for signal storage
        tool_stats: Dictionary mapping tool names to ToolStats
        enabled: Whether signal emission is enabled
    """

    def __init__(
        self,
        loki_dir: Optional[Path] = None,
        enabled: bool = True
    ):
        """
        Initialize the learning collector.

        Args:
            loki_dir: Path to .loki directory. Defaults to ./.loki
            enabled: Whether to emit signals (can be disabled for testing)
        """
        self.loki_dir = loki_dir or Path('.loki')
        self.enabled = enabled and LEARNING_AVAILABLE
        self.tool_stats: Dict[str, ToolStats] = {}
        self._lock = threading.Lock()

    def _get_or_create_stats(self, tool_name: str) -> ToolStats:
        """Get or create statistics for a tool."""
        with self._lock:
            if tool_name not in self.tool_stats:
                self.tool_stats[tool_name] = ToolStats(tool_name=tool_name)
            return self.tool_stats[tool_name]

    def _emit_async(self, emit_func: Callable, **kwargs) -> None:
        """
        Emit a signal asynchronously (non-blocking).

        Args:
            emit_func: The emit function to call
            **kwargs: Arguments to pass to the emit function
        """
        if not self.enabled:
            return

        def emit():
            try:
                emit_func(**kwargs, loki_dir=self.loki_dir)
            except Exception as e:
                # Never fail the tool call for signal emission failures
                logger.debug(f"Learning signal emission failed (non-fatal): {e}")

        thread = threading.Thread(target=emit, daemon=True)
        thread.start()

    # -------------------------------------------------------------------------
    # Tool Efficiency Signals
    # -------------------------------------------------------------------------

    def emit_tool_efficiency(
        self,
        tool_name: str,
        action: str,
        execution_time_ms: int,
        success: bool,
        context: Optional[Dict[str, Any]] = None,
        tokens_used: int = 0,
    ) -> None:
        """
        Emit a tool efficiency learning signal.

        Args:
            tool_name: Name of the MCP tool
            action: Description of the action performed
            execution_time_ms: Execution time in milliseconds
            success: Whether the tool call succeeded
            context: Additional context about the call
            tokens_used: Number of tokens used (if applicable)
        """
        # Update statistics
        stats = self._get_or_create_stats(tool_name)
        stats.record_call(success, execution_time_ms)

        # Emit signal asynchronously
        outcome = Outcome.SUCCESS if success else Outcome.FAILURE
        self._emit_async(
            emit_tool_efficiency,
            source=SignalSource.MCP,
            action=action,
            tool_name=tool_name,
            context=context or {},
            tokens_used=tokens_used,
            execution_time_ms=execution_time_ms,
            success_rate=stats.success_rate,
            outcome=outcome,
            confidence=0.9,
        )

    # -------------------------------------------------------------------------
    # Error Pattern Signals
    # -------------------------------------------------------------------------

    def emit_error_pattern(
        self,
        tool_name: str,
        action: str,
        error_type: str,
        error_message: str,
        context: Optional[Dict[str, Any]] = None,
        resolution: str = '',
        stack_trace: Optional[str] = None,
    ) -> None:
        """
        Emit an error pattern learning signal.

        Args:
            tool_name: Name of the MCP tool that failed
            action: Description of the action that failed
            error_type: Category of the error
            error_message: The error message
            context: Additional context about the error
            resolution: How the error was resolved (if known)
            stack_trace: Optional stack trace
        """
        ctx = context or {}
        ctx['tool_name'] = tool_name

        self._emit_async(
            emit_error_pattern,
            source=SignalSource.MCP,
            action=action,
            error_type=error_type,
            error_message=error_message,
            context=ctx,
            resolution=resolution,
            stack_trace=stack_trace,
            confidence=0.85,
        )

    # -------------------------------------------------------------------------
    # Success Pattern Signals
    # -------------------------------------------------------------------------

    def emit_success_pattern(
        self,
        tool_name: str,
        action: str,
        pattern_name: str,
        context: Optional[Dict[str, Any]] = None,
        duration_seconds: int = 0,
        action_sequence: Optional[List[str]] = None,
    ) -> None:
        """
        Emit a success pattern learning signal.

        Args:
            tool_name: Name of the MCP tool
            action: Description of the successful action
            pattern_name: Human-readable name for the pattern
            context: Additional context
            duration_seconds: How long the pattern took
            action_sequence: Ordered list of actions in the pattern
        """
        ctx = context or {}
        ctx['tool_name'] = tool_name

        self._emit_async(
            emit_success_pattern,
            source=SignalSource.MCP,
            action=action,
            pattern_name=pattern_name,
            action_sequence=action_sequence or [action],
            context=ctx,
            duration_seconds=duration_seconds,
            confidence=0.85,
        )

    # -------------------------------------------------------------------------
    # Context Relevance Signals
    # -------------------------------------------------------------------------

    def emit_context_relevance(
        self,
        tool_name: str,
        action: str,
        query: str,
        retrieved_ids: List[str],
        context: Optional[Dict[str, Any]] = None,
        relevant_ids: Optional[List[str]] = None,
        irrelevant_ids: Optional[List[str]] = None,
    ) -> None:
        """
        Emit a context relevance learning signal.

        Used when memory or resources are accessed to track relevance.

        Args:
            tool_name: Name of the MCP tool
            action: Description of the retrieval action
            query: The query used for retrieval
            retrieved_ids: IDs of retrieved items
            context: Additional context
            relevant_ids: IDs marked as relevant (optional)
            irrelevant_ids: IDs marked as irrelevant (optional)
        """
        ctx = context or {}
        ctx['tool_name'] = tool_name

        # Calculate precision if relevance info is provided
        precision = 0.0
        recall = 0.0
        if relevant_ids is not None and retrieved_ids:
            relevant_set = set(relevant_ids)
            retrieved_set = set(retrieved_ids)
            if retrieved_set:
                precision = len(relevant_set & retrieved_set) / len(retrieved_set)
            # Recall requires knowing total relevant, which we may not have

        self._emit_async(
            emit_context_relevance,
            source=SignalSource.MCP,
            action=action,
            query=query,
            retrieved_context_ids=retrieved_ids,
            context=ctx,
            relevant_ids=relevant_ids or [],
            irrelevant_ids=irrelevant_ids or [],
            precision=precision,
            recall=recall,
            confidence=0.8,
        )

    # -------------------------------------------------------------------------
    # Statistics Methods
    # -------------------------------------------------------------------------

    def get_tool_stats(self, tool_name: str) -> Optional[ToolStats]:
        """Get statistics for a specific tool."""
        return self.tool_stats.get(tool_name)

    def get_all_stats(self) -> Dict[str, ToolStats]:
        """Get statistics for all tools."""
        return dict(self.tool_stats)

    def get_stats_summary(self) -> Dict[str, Any]:
        """Get a summary of all tool statistics."""
        summary = {
            'total_tools': len(self.tool_stats),
            'total_calls': 0,
            'total_successful': 0,
            'total_failed': 0,
            'tools': {}
        }

        for name, stats in self.tool_stats.items():
            summary['total_calls'] += stats.total_calls
            summary['total_successful'] += stats.successful_calls
            summary['total_failed'] += stats.failed_calls
            summary['tools'][name] = {
                'calls': stats.total_calls,
                'success_rate': stats.success_rate,
                'avg_time_ms': stats.avg_execution_time_ms,
            }

        return summary

    # -------------------------------------------------------------------------
    # Context Manager for Timing
    # -------------------------------------------------------------------------

    def track_tool_call(
        self,
        tool_name: str,
        parameters: Optional[Dict[str, Any]] = None
    ) -> 'ToolCallTracker':
        """
        Create a context manager to track a tool call.

        Usage:
            with collector.track_tool_call('loki_memory_retrieve', {'query': 'test'}) as tracker:
                result = await tool_function()
                tracker.set_result(result, success=True)

        Args:
            tool_name: Name of the tool being called
            parameters: Parameters passed to the tool

        Returns:
            ToolCallTracker context manager
        """
        return ToolCallTracker(self, tool_name, parameters)


class ToolCallTracker:
    """
    Context manager for tracking MCP tool calls.

    Automatically tracks timing and emits signals on exit.
    """

    def __init__(
        self,
        collector: MCPLearningCollector,
        tool_name: str,
        parameters: Optional[Dict[str, Any]] = None
    ):
        self.collector = collector
        self.tool_name = tool_name
        self.parameters = parameters or {}
        self.start_time: Optional[float] = None
        self.success: bool = True
        self.error_type: Optional[str] = None
        self.error_message: Optional[str] = None
        self.result: Any = None

    def __enter__(self) -> 'ToolCallTracker':
        self.start_time = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        end_time = time.time()
        execution_time_ms = int((end_time - self.start_time) * 1000)

        # Check if there was an exception
        if exc_type is not None:
            self.success = False
            self.error_type = exc_type.__name__
            self.error_message = str(exc_val)

        # Emit tool efficiency signal
        self.collector.emit_tool_efficiency(
            tool_name=self.tool_name,
            action=f"call_{self.tool_name}",
            execution_time_ms=execution_time_ms,
            success=self.success,
            context={'parameters': self.parameters},
        )

        # Emit error pattern if failed
        if not self.success and self.error_type:
            self.collector.emit_error_pattern(
                tool_name=self.tool_name,
                action=f"call_{self.tool_name}",
                error_type=self.error_type,
                error_message=self.error_message or 'Unknown error',
                context={'parameters': self.parameters},
            )

        # Don't suppress exceptions
        return False

    def set_result(self, result: Any, success: bool = True) -> None:
        """
        Set the result of the tool call.

        Args:
            result: The result of the tool call
            success: Whether the call was successful
        """
        self.result = result
        self.success = success

    def set_error(self, error_type: str, error_message: str) -> None:
        """
        Set an error for the tool call.

        Args:
            error_type: Category of the error
            error_message: The error message
        """
        self.success = False
        self.error_type = error_type
        self.error_message = error_message


# -----------------------------------------------------------------------------
# Module-level Collector Instance
# -----------------------------------------------------------------------------


_collector: Optional[MCPLearningCollector] = None


def get_mcp_learning_collector(
    loki_dir: Optional[Path] = None
) -> MCPLearningCollector:
    """
    Get or create the module-level MCP learning collector.

    Args:
        loki_dir: Path to .loki directory

    Returns:
        MCPLearningCollector instance
    """
    global _collector
    # Recreate when the requested loki_dir differs from the cached collector's
    # directory. The module-level singleton would otherwise return a collector
    # bound to a PREVIOUS project's .loki dir on cwd change, contaminating one
    # project's learnings into another in a multi-project session. Compare by
    # realpath so symlinked/relative paths to the same dir do not churn.
    if _collector is not None and loki_dir is not None:
        try:
            cached = os.path.realpath(str(getattr(_collector, "loki_dir", "")))
            requested = os.path.realpath(str(loki_dir))
            if cached != requested:
                close = getattr(_collector, "close", None)
                if callable(close):
                    close()
                _collector = None
        except Exception:
            # On any path-resolution error, fall through and reuse the cache
            # rather than risk losing the collector.
            pass
    if _collector is None:
        _collector = MCPLearningCollector(loki_dir=loki_dir)
    return _collector


# -----------------------------------------------------------------------------
# Decorator for Tool Wrapping
# -----------------------------------------------------------------------------

T = TypeVar('T')


def with_learning(
    tool_name: str,
    emit_success: bool = True
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Decorator to wrap an MCP tool handler with learning signal emission.

    Usage:
        @mcp.tool()
        @with_learning('loki_memory_retrieve')
        async def loki_memory_retrieve(query: str) -> str:
            ...

    Args:
        tool_name: Name of the tool for signal emission
        emit_success: Whether to emit success patterns (default True)

    Returns:
        Decorator function
    """
    import functools
    import asyncio

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs) -> T:
            collector = get_mcp_learning_collector()
            start_time = time.time()
            success = True
            error_type = None
            error_message = None
            result = None

            try:
                result = await func(*args, **kwargs)
                return result
            except Exception as e:
                success = False
                error_type = type(e).__name__
                error_message = str(e)
                raise
            finally:
                end_time = time.time()
                execution_time_ms = int((end_time - start_time) * 1000)

                # Emit tool efficiency
                collector.emit_tool_efficiency(
                    tool_name=tool_name,
                    action=f"call_{tool_name}",
                    execution_time_ms=execution_time_ms,
                    success=success,
                    context={'args': str(args)[:200], 'kwargs': str(kwargs)[:200]},
                )

                # Emit error pattern if failed
                if not success and error_type:
                    collector.emit_error_pattern(
                        tool_name=tool_name,
                        action=f"call_{tool_name}",
                        error_type=error_type,
                        error_message=error_message or 'Unknown error',
                        context={'args': str(args)[:200], 'kwargs': str(kwargs)[:200]},
                    )

                # Emit success pattern if enabled and successful
                if success and emit_success:
                    collector.emit_success_pattern(
                        tool_name=tool_name,
                        action=f"call_{tool_name}",
                        pattern_name=f"mcp_{tool_name}_success",
                        duration_seconds=execution_time_ms // 1000,
                    )

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs) -> T:
            collector = get_mcp_learning_collector()
            start_time = time.time()
            success = True
            error_type = None
            error_message = None

            try:
                result = func(*args, **kwargs)
                return result
            except Exception as e:
                success = False
                error_type = type(e).__name__
                error_message = str(e)
                raise
            finally:
                end_time = time.time()
                execution_time_ms = int((end_time - start_time) * 1000)

                collector.emit_tool_efficiency(
                    tool_name=tool_name,
                    action=f"call_{tool_name}",
                    execution_time_ms=execution_time_ms,
                    success=success,
                    context={'args': str(args)[:200], 'kwargs': str(kwargs)[:200]},
                )

                if not success and error_type:
                    collector.emit_error_pattern(
                        tool_name=tool_name,
                        action=f"call_{tool_name}",
                        error_type=error_type,
                        error_message=error_message or 'Unknown error',
                    )

        # Return appropriate wrapper based on function type
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator
