#!/usr/bin/env python3
"""
Loki Mode MCP Server

Exposes Loki Mode capabilities via Model Context Protocol:
- Task queue management
- Memory retrieval
- State management
- Metrics tracking

Uses StateManager for centralized state access with caching.

Usage:
    python -m mcp.server                    # STDIO mode (default)
    python -m mcp.server --transport http   # HTTP mode
"""

import sys
import os
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import event bus for tool call events
try:
    from events.bus import EventBus, EventType, EventSource, LokiEvent
    EVENT_BUS_AVAILABLE = True
except ImportError:
    EVENT_BUS_AVAILABLE = False

# Import learning collector for cross-tool learning
try:
    from mcp.learning_collector import get_mcp_learning_collector, MCPLearningCollector
    LEARNING_COLLECTOR_AVAILABLE = True
except ImportError:
    LEARNING_COLLECTOR_AVAILABLE = False
    get_mcp_learning_collector = None
    MCPLearningCollector = None

# Import StateManager for centralized state access
try:
    from state.manager import StateManager, ManagedFile, get_state_manager
    STATE_MANAGER_AVAILABLE = True
except ImportError:
    STATE_MANAGER_AVAILABLE = False
    StateManager = None
    ManagedFile = None
    get_state_manager = None


# Module-level StateManager instance
_state_manager = None

# Module-level LearningCollector instance
_learning_collector = None


def _get_learning_collector():
    """Get or create the LearningCollector instance for MCP server."""
    global _learning_collector
    if not LEARNING_COLLECTOR_AVAILABLE:
        return None
    if _learning_collector is None:
        from pathlib import Path
        loki_dir = Path(os.getcwd()) / '.loki'
        _learning_collector = get_mcp_learning_collector(loki_dir=loki_dir)
    return _learning_collector


def _get_mcp_state_manager():
    """Get or create the StateManager instance for MCP server."""
    global _state_manager
    if not STATE_MANAGER_AVAILABLE:
        return None
    if _state_manager is None:
        loki_dir = os.path.join(os.getcwd(), '.loki')
        _state_manager = get_state_manager(
            loki_dir=loki_dir,
            enable_watch=False,  # MCP server doesn't need file watching
            enable_events=False
        )
    return _state_manager


# ============================================================
# PATH SECURITY - Prevent path traversal attacks
# ============================================================

# Allowed base directories relative to project root
ALLOWED_BASE_DIRS = ['.loki', 'memory']


class PathTraversalError(Exception):
    """Raised when a path traversal attempt is detected"""
    pass


def get_project_root() -> str:
    """Get the project root directory (current working directory)"""
    return os.path.realpath(os.getcwd())


def validate_path(path: str, allowed_dirs: List[str] = None) -> str:
    """
    Validate that a path is within allowed directories.

    Args:
        path: The path to validate (can be relative or absolute)
        allowed_dirs: List of allowed base directories relative to project root.
                      Defaults to ALLOWED_BASE_DIRS.

    Returns:
        The canonicalized absolute path if valid

    Raises:
        PathTraversalError: If the path attempts to escape allowed directories
    """
    if allowed_dirs is None:
        allowed_dirs = ALLOWED_BASE_DIRS

    project_root = get_project_root()

    # Resolve to absolute path, following symlinks
    if os.path.isabs(path):
        resolved_path = os.path.realpath(path)
    else:
        resolved_path = os.path.realpath(os.path.join(project_root, path))

    # Check if path is within any of the allowed directories
    for allowed_dir in allowed_dirs:
        allowed_base = os.path.realpath(os.path.join(project_root, allowed_dir))

        # Ensure allowed base ends with separator for proper prefix matching
        if not allowed_base.endswith(os.sep):
            allowed_base_check = allowed_base + os.sep
        else:
            allowed_base_check = allowed_base

        # Check if resolved path is the allowed base or a subdirectory of it
        if resolved_path == allowed_base or resolved_path.startswith(allowed_base_check):
            return resolved_path

    # Path is not within allowed directories
    raise PathTraversalError(
        f"Access denied: Path '{path}' resolves outside allowed directories. "
        f"Allowed: {', '.join(allowed_dirs)}"
    )


def safe_path_join(base_dir: str, *paths: str) -> str:
    """
    Safely join paths and validate the result is within allowed directories.

    Args:
        base_dir: Base directory (should be one of the allowed dirs)
        *paths: Additional path components to join

    Returns:
        The validated absolute path

    Raises:
        PathTraversalError: If the resulting path escapes allowed directories
    """
    project_root = get_project_root()

    # Build the full path
    full_path = os.path.join(project_root, base_dir, *paths)

    # Validate it stays within allowed directories
    return validate_path(full_path)


def safe_open(path: str, mode: str = 'r', allowed_dirs: List[str] = None, encoding: str = 'utf-8'):
    """
    Safely open a file after validating the path.

    Args:
        path: Path to the file
        mode: File open mode
        allowed_dirs: Allowed directories (defaults to ALLOWED_BASE_DIRS)
        encoding: File encoding (default: utf-8, ignored for binary modes)

    Returns:
        File handle

    Raises:
        PathTraversalError: If path escapes allowed directories
    """
    validated_path = validate_path(path, allowed_dirs)
    # Only pass encoding for text modes, not binary modes
    if 'b' in mode:
        return open(validated_path, mode)
    return open(validated_path, mode, encoding=encoding)


def safe_makedirs(path: str, exist_ok: bool = True, allowed_dirs: List[str] = None):
    """
    Safely create directories after validating the path.

    Args:
        path: Path to create
        exist_ok: If True, don't raise error if directory exists
        allowed_dirs: Allowed directories (defaults to ALLOWED_BASE_DIRS)

    Raises:
        PathTraversalError: If path escapes allowed directories
    """
    validated_path = validate_path(path, allowed_dirs)
    os.makedirs(validated_path, exist_ok=exist_ok)


def safe_exists(path: str, allowed_dirs: List[str] = None) -> bool:
    """
    Safely check if a path exists after validating it.

    Args:
        path: Path to check
        allowed_dirs: Allowed directories (defaults to ALLOWED_BASE_DIRS)

    Returns:
        True if path exists and is within allowed directories, False otherwise
    """
    try:
        validated_path = validate_path(path, allowed_dirs)
        return os.path.exists(validated_path)
    except PathTraversalError:
        return False


# Configure logging to stderr (critical for STDIO transport)
# Must be configured before using logger in event emission
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger('loki-mcp')


# ============================================================
# EVENT EMISSION - Non-blocking tool call events
# ============================================================

# Track tool call start times for duration calculation (per-tool stack)
_tool_call_start_times: Dict[str, List[float]] = {}


def _emit_tool_event_async(tool_name: str, action: str, **kwargs) -> None:
    """
    Emit a tool event asynchronously (non-blocking).

    Args:
        tool_name: Name of the MCP tool being called
        action: 'start' or 'complete'
        **kwargs: Additional payload fields (parameters, result_status, error)
    """
    import time

    # Track timing for learning signals using a per-tool-name stack
    if action == 'start':
        _tool_call_start_times.setdefault(tool_name, []).append(time.time())
    elif action == 'complete':
        # Pop the most recent start time for this tool
        start_time = None
        times = _tool_call_start_times.get(tool_name)
        if times:
            start_time = times.pop()
        if start_time:
            execution_time_ms = int((time.time() - start_time) * 1000)
            _emit_learning_signal_async(
                tool_name=tool_name,
                execution_time_ms=execution_time_ms,
                result_status=kwargs.get('result_status', 'unknown'),
                error=kwargs.get('error'),
                parameters=kwargs.get('parameters', {})
            )

    if not EVENT_BUS_AVAILABLE:
        return

    def emit():
        try:
            bus = EventBus()
            payload = {
                'action': action,
                'tool_name': tool_name,
                **kwargs
            }
            event = LokiEvent(
                type=EventType.COMMAND,
                source=EventSource.MCP,
                payload=payload
            )
            bus.emit(event)
        except Exception as e:
            # Never block the tool call for event emission failures
            logger.debug(f"Event emission failed (non-fatal): {e}")

    # Run in background thread to not block the tool call
    thread = threading.Thread(target=emit, daemon=True)
    thread.start()


def _emit_learning_signal_async(
    tool_name: str,
    execution_time_ms: int,
    result_status: str,
    error: Optional[str] = None,
    parameters: Optional[Dict[str, Any]] = None
) -> None:
    """
    Emit a learning signal asynchronously (non-blocking).

    Emits ToolEfficiencySignal on every call, and ErrorPatternSignal on failures.

    Args:
        tool_name: Name of the MCP tool
        execution_time_ms: Execution time in milliseconds
        result_status: 'success' or 'error'
        error: Error message if failed
        parameters: Tool parameters for context
    """
    if not LEARNING_COLLECTOR_AVAILABLE:
        return

    def emit():
        try:
            collector = _get_learning_collector()
            if not collector:
                return

            success = result_status == 'success'

            # Emit tool efficiency signal
            collector.emit_tool_efficiency(
                tool_name=tool_name,
                action=f"mcp_tool_call",
                execution_time_ms=execution_time_ms,
                success=success,
                context={'parameters': parameters or {}},
            )

            # Emit error pattern if failed
            if not success and error:
                collector.emit_error_pattern(
                    tool_name=tool_name,
                    action=f"mcp_tool_call",
                    error_type='MCPToolError',
                    error_message=error,
                    context={'parameters': parameters or {}},
                )

            # Emit success pattern for successful calls
            if success:
                collector.emit_success_pattern(
                    tool_name=tool_name,
                    action=f"mcp_tool_call",
                    pattern_name=f"mcp_{tool_name}_success",
                    duration_seconds=execution_time_ms / 1000,
                    context={'parameters': parameters or {}},
                )

        except Exception as e:
            # Never block the tool call for learning signal emission failures
            logger.debug(f"Learning signal emission failed (non-fatal): {e}")

    # Run in background thread to not block the tool call
    thread = threading.Thread(target=emit, daemon=True)
    thread.start()


def _emit_context_relevance_signal(
    tool_name: str,
    query: str,
    retrieved_ids: List[str],
    context: Optional[Dict[str, Any]] = None
) -> None:
    """
    Emit a context relevance learning signal for memory/resource access.

    Args:
        tool_name: Name of the MCP tool
        query: The query used for retrieval
        retrieved_ids: IDs of retrieved items
        context: Additional context
    """
    if not LEARNING_COLLECTOR_AVAILABLE:
        return

    def emit():
        try:
            collector = _get_learning_collector()
            if not collector:
                return

            collector.emit_context_relevance(
                tool_name=tool_name,
                action='memory_retrieval',
                query=query,
                retrieved_ids=retrieved_ids,
                context=context or {},
            )
        except Exception as e:
            logger.debug(f"Context relevance signal emission failed (non-fatal): {e}")

    thread = threading.Thread(target=emit, daemon=True)
    thread.start()


# BUG #3 FIX: The local mcp/ package shadows the pip-installed mcp SDK.
# Load FastMCP directly from site-packages using importlib.util to bypass
# Python's package name resolution entirely (avoids infinite recursion).
import importlib.util
import site

_fastmcp_found = False
_search_paths = []
try:
    _search_paths.extend(site.getsitepackages())
except AttributeError:
    pass
try:
    _search_paths.append(site.getusersitepackages())
except AttributeError:
    pass

for _site_dir in _search_paths:
    _fastmcp_path = os.path.join(_site_dir, "mcp", "server", "fastmcp.py")
    if os.path.isfile(_fastmcp_path):
        _spec = importlib.util.spec_from_file_location(
            "mcp_pip_sdk.server.fastmcp", _fastmcp_path,
            submodule_search_locations=[]
        )
        if _spec and _spec.loader:
            _fastmcp_mod = importlib.util.module_from_spec(_spec)
            _spec.loader.exec_module(_fastmcp_mod)
            FastMCP = _fastmcp_mod.FastMCP
            _fastmcp_found = True
            break

if not _fastmcp_found:
    logger.error("MCP SDK (pip package 'mcp') not found in site-packages. Install with: pip install mcp")
    sys.exit(1)

# Read version from VERSION file instead of hardcoding
try:
    with open(os.path.join(os.path.dirname(__file__), '..', 'VERSION')) as _vf:
        _version = _vf.read().strip()
except Exception:
    _version = "unknown"

# Initialize FastMCP server
mcp = FastMCP(
    "loki-mode",
    version=_version,
    description="Loki Mode autonomous agent orchestration"
)

# ============================================================
# TOOLS - Functions Claude can call
# ============================================================

@mcp.tool()
async def loki_memory_retrieve(
    query: str,
    task_type: str = "implementation",
    top_k: int = 5
) -> str:
    """
    Retrieve relevant memories for a task using task-aware retrieval.

    Args:
        query: Search query describing what you're looking for
        task_type: Type of task (exploration, implementation, debugging, review, refactoring)
        top_k: Maximum number of results to return

    Returns:
        JSON array of relevant memory entries with summaries
    """
    _emit_tool_event_async(
        'loki_memory_retrieve', 'start',
        parameters={'query': query, 'task_type': task_type, 'top_k': top_k}
    )
    try:
        from memory.retrieval import MemoryRetrieval
        from memory.storage import MemoryStorage

        base_path = safe_path_join('.loki', 'memory')
        if not os.path.exists(base_path):
            result = json.dumps({"memories": [], "message": "Memory system not initialized"})
            _emit_tool_event_async('loki_memory_retrieve', 'complete', result_status='success')
            return result

        storage = MemoryStorage(base_path)
        retriever = MemoryRetrieval(storage)

        context = {"goal": query, "task_type": task_type}
        results = retriever.retrieve_task_aware(context, top_k=top_k)

        # Extract IDs for context relevance signal
        retrieved_ids = [r.get('id', '') for r in results if isinstance(r, dict)]

        # Emit context relevance signal for memory retrieval
        _emit_context_relevance_signal(
            tool_name='loki_memory_retrieve',
            query=query,
            retrieved_ids=retrieved_ids,
            context={'task_type': task_type, 'top_k': top_k}
        )

        result = json.dumps({
            "memories": results,
            "task_type": task_type,
            "count": len(results)
        }, default=str)
        _emit_tool_event_async('loki_memory_retrieve', 'complete', result_status='success')
        return result
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_memory_retrieve', 'complete', result_status='error', error='Access denied')
        return json.dumps({"error": "Access denied", "memories": []})
    except Exception as e:
        logger.error(f"Memory retrieval failed: {e}")
        _emit_tool_event_async('loki_memory_retrieve', 'complete', result_status='error', error=str(e))
        return json.dumps({"error": str(e), "memories": []})


@mcp.tool()
async def loki_memory_store_pattern(
    pattern: str,
    category: str,
    correct_approach: str,
    incorrect_approach: str = "",
    confidence: float = 0.8
) -> str:
    """
    Store a new semantic pattern learned during this session.

    Args:
        pattern: Brief description of the pattern
        category: Category (api, testing, security, performance, architecture, etc.)
        correct_approach: The correct way to handle this situation
        incorrect_approach: What to avoid (optional)
        confidence: Confidence level 0.0-1.0

    Returns:
        Pattern ID if successful
    """
    _emit_tool_event_async(
        'loki_memory_store_pattern', 'start',
        parameters={'pattern': pattern, 'category': category, 'confidence': confidence}
    )
    try:
        from memory.engine import MemoryEngine
        from memory.schemas import SemanticPattern

        base_path = safe_path_join('.loki', 'memory')
        engine = MemoryEngine(base_path)
        engine.initialize()

        pattern_obj = SemanticPattern(
            id=f"pattern-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            pattern=pattern,
            category=category,
            conditions=[],
            correct_approach=correct_approach,
            incorrect_approach=incorrect_approach,
            confidence=confidence,
            source_episodes=[],
            usage_count=0,
            last_used=None,
            links=[]
        )

        pattern_id = engine.store_pattern(pattern_obj)
        _emit_tool_event_async('loki_memory_store_pattern', 'complete', result_status='success')
        return json.dumps({"success": True, "pattern_id": pattern_id})
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_memory_store_pattern', 'complete', result_status='error', error='Access denied')
        return json.dumps({"success": False, "error": "Access denied"})
    except Exception as e:
        logger.error(f"Pattern storage failed: {e}")
        _emit_tool_event_async('loki_memory_store_pattern', 'complete', result_status='error', error=str(e))
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def loki_task_queue_list() -> str:
    """
    List all tasks in the Loki Mode task queue.

    Returns:
        JSON array of tasks with status, priority, and description
    """
    _emit_tool_event_async('loki_task_queue_list', 'start', parameters={})
    try:
        # Use StateManager if available
        manager = _get_mcp_state_manager()
        if manager and STATE_MANAGER_AVAILABLE:
            queue = manager.get_state("state/task-queue.json")
            if queue:
                _emit_tool_event_async('loki_task_queue_list', 'complete', result_status='success')
                return json.dumps(queue, default=str)
            # If no queue found via StateManager, return empty
            result = json.dumps({"tasks": [], "message": "No task queue found"})
            _emit_tool_event_async('loki_task_queue_list', 'complete', result_status='success')
            return result

        # Fallback to direct file read
        queue_path = safe_path_join('.loki', 'state', 'task-queue.json')
        if not os.path.exists(queue_path):
            result = json.dumps({"tasks": [], "message": "No task queue found"})
            _emit_tool_event_async('loki_task_queue_list', 'complete', result_status='success')
            return result

        with safe_open(queue_path, 'r') as f:
            queue = json.load(f)

        _emit_tool_event_async('loki_task_queue_list', 'complete', result_status='success')
        return json.dumps(queue, default=str)
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_task_queue_list', 'complete', result_status='error', error='Access denied')
        return json.dumps({"error": "Access denied", "tasks": []})
    except Exception as e:
        logger.error(f"Task queue list failed: {e}")
        _emit_tool_event_async('loki_task_queue_list', 'complete', result_status='error', error=str(e))
        return json.dumps({"error": str(e), "tasks": []})


@mcp.tool()
async def loki_task_queue_add(
    title: str,
    description: str,
    priority: str = "medium",
    phase: str = "development"
) -> str:
    """
    Add a new task to the Loki Mode task queue.

    Args:
        title: Brief task title
        description: Detailed task description
        priority: Priority level (low, medium, high, critical)
        phase: SDLC phase (discovery, architecture, development, testing, deployment)

    Returns:
        Task ID if successful
    """
    _emit_tool_event_async(
        'loki_task_queue_add', 'start',
        parameters={'title': title, 'priority': priority, 'phase': phase}
    )
    try:
        manager = _get_mcp_state_manager()

        # Load existing queue or create new - use StateManager if available
        if manager and STATE_MANAGER_AVAILABLE:
            queue = manager.get_state("state/task-queue.json", default={"tasks": [], "version": "1.0"})
        else:
            queue_path = safe_path_join('.loki', 'state', 'task-queue.json')
            state_dir = safe_path_join('.loki', 'state')
            safe_makedirs(state_dir, exist_ok=True)

            if os.path.exists(queue_path):
                with safe_open(queue_path, 'r') as f:
                    queue = json.load(f)
            else:
                queue = {"tasks": [], "version": "1.0"}

        # Create new task
        task_id = f"task-{len(queue['tasks']) + 1:04d}"
        task = {
            "id": task_id,
            "title": title,
            "description": description,
            "priority": priority,
            "phase": phase,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat()
        }

        queue["tasks"].append(task)

        # Save using StateManager if available
        if manager and STATE_MANAGER_AVAILABLE:
            manager.set_state("state/task-queue.json", queue, source="mcp-server")
        else:
            queue_path = safe_path_join('.loki', 'state', 'task-queue.json')
            with safe_open(queue_path, 'w') as f:
                json.dump(queue, f, indent=2)

        _emit_tool_event_async('loki_task_queue_add', 'complete', result_status='success')
        return json.dumps({"success": True, "task_id": task_id})
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_task_queue_add', 'complete', result_status='error', error='Access denied')
        return json.dumps({"success": False, "error": "Access denied"})
    except Exception as e:
        logger.error(f"Task add failed: {e}")
        _emit_tool_event_async('loki_task_queue_add', 'complete', result_status='error', error=str(e))
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def loki_task_queue_update(
    task_id: str,
    status: str = None,
    priority: str = None
) -> str:
    """
    Update a task's status or priority.

    Args:
        task_id: ID of the task to update
        status: New status (pending, in_progress, completed, blocked)
        priority: New priority (low, medium, high, critical)

    Returns:
        Updated task if successful
    """
    _emit_tool_event_async(
        'loki_task_queue_update', 'start',
        parameters={'task_id': task_id, 'status': status, 'priority': priority}
    )
    try:
        manager = _get_mcp_state_manager()

        # Load queue using StateManager if available
        if manager and STATE_MANAGER_AVAILABLE:
            queue = manager.get_state("state/task-queue.json")
            if not queue:
                _emit_tool_event_async('loki_task_queue_update', 'complete', result_status='error', error='Task queue not found')
                return json.dumps({"success": False, "error": "Task queue not found"})
        else:
            queue_path = safe_path_join('.loki', 'state', 'task-queue.json')
            if not os.path.exists(queue_path):
                _emit_tool_event_async('loki_task_queue_update', 'complete', result_status='error', error='Task queue not found')
                return json.dumps({"success": False, "error": "Task queue not found"})

            with safe_open(queue_path, 'r') as f:
                queue = json.load(f)

        # Find and update task
        for task in queue["tasks"]:
            if task["id"] == task_id:
                if status:
                    task["status"] = status
                if priority:
                    task["priority"] = priority
                task["updated_at"] = datetime.now(timezone.utc).isoformat()

                # Save using StateManager if available
                if manager and STATE_MANAGER_AVAILABLE:
                    manager.set_state("state/task-queue.json", queue, source="mcp-server")
                else:
                    queue_path = safe_path_join('.loki', 'state', 'task-queue.json')
                    with safe_open(queue_path, 'w') as f:
                        json.dump(queue, f, indent=2)

                _emit_tool_event_async('loki_task_queue_update', 'complete', result_status='success')
                return json.dumps({"success": True, "task": task})

        _emit_tool_event_async('loki_task_queue_update', 'complete', result_status='error', error=f'Task {task_id} not found')
        return json.dumps({"success": False, "error": f"Task {task_id} not found"})
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_task_queue_update', 'complete', result_status='error', error='Access denied')
        return json.dumps({"success": False, "error": "Access denied"})
    except Exception as e:
        logger.error(f"Task update failed: {e}")
        _emit_tool_event_async('loki_task_queue_update', 'complete', result_status='error', error=str(e))
        return json.dumps({"success": False, "error": str(e)})


@mcp.tool()
async def loki_state_get() -> str:
    """
    Get the current Loki Mode state including phase, metrics, and status.

    Returns:
        JSON object with current state information
    """
    _emit_tool_event_async('loki_state_get', 'start', parameters={})
    try:
        continuity_path = safe_path_join('.loki', 'CONTINUITY.md')
        loki_dir = safe_path_join('.loki')

        state = {
            "initialized": os.path.exists(loki_dir),
            "autonomy_state": None,
            "continuity_exists": os.path.exists(continuity_path),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

        # Use StateManager for autonomy state if available
        manager = _get_mcp_state_manager()
        if manager and STATE_MANAGER_AVAILABLE:
            autonomy_data = manager.get_state(ManagedFile.AUTONOMY)
            if autonomy_data:
                state["autonomy_state"] = autonomy_data
        else:
            # Fallback to direct file read
            state_path = safe_path_join('.loki', 'state', 'autonomy-state.json')
            if os.path.exists(state_path):
                with safe_open(state_path, 'r') as f:
                    state["autonomy_state"] = json.load(f)

        # Get memory stats
        try:
            from memory.engine import MemoryEngine
            memory_path = safe_path_join('.loki', 'memory')
            engine = MemoryEngine(memory_path)
            state["memory_stats"] = engine.get_stats()
        except Exception:
            state["memory_stats"] = None

        _emit_tool_event_async('loki_state_get', 'complete', result_status='success')
        return json.dumps(state, default=str)
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_state_get', 'complete', result_status='error', error='Access denied')
        return json.dumps({"error": "Access denied"})
    except Exception as e:
        logger.error(f"State get failed: {e}")
        _emit_tool_event_async('loki_state_get', 'complete', result_status='error', error=str(e))
        return json.dumps({"error": str(e)})


@mcp.tool()
async def loki_metrics_efficiency() -> str:
    """
    Get efficiency metrics for the current session.

    Returns:
        JSON object with token usage, tool calls, and efficiency ratios
    """
    _emit_tool_event_async('loki_metrics_efficiency', 'start', parameters={})
    try:
        metrics_path = safe_path_join('.loki', 'metrics', 'tool-usage.jsonl')

        if not os.path.exists(metrics_path):
            result = json.dumps({"message": "No metrics collected yet", "tool_calls": 0})
            _emit_tool_event_async('loki_metrics_efficiency', 'complete', result_status='success')
            return result

        tool_counts = {}
        total_calls = 0

        with safe_open(metrics_path, 'r') as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    tool = entry.get("tool", "unknown")
                    tool_counts[tool] = tool_counts.get(tool, 0) + 1
                    total_calls += 1
                except json.JSONDecodeError:
                    continue

        _emit_tool_event_async('loki_metrics_efficiency', 'complete', result_status='success')
        return json.dumps({
            "total_tool_calls": total_calls,
            "tool_breakdown": tool_counts,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_metrics_efficiency', 'complete', result_status='error', error='Access denied')
        return json.dumps({"error": "Access denied"})
    except Exception as e:
        logger.error(f"Metrics get failed: {e}")
        _emit_tool_event_async('loki_metrics_efficiency', 'complete', result_status='error', error=str(e))
        return json.dumps({"error": str(e)})


@mcp.tool()
async def loki_consolidate_memory(since_hours: int = 24) -> str:
    """
    Run memory consolidation to extract patterns from recent episodes.

    Args:
        since_hours: Process episodes from the last N hours

    Returns:
        Consolidation results with patterns created/merged
    """
    _emit_tool_event_async(
        'loki_consolidate_memory', 'start',
        parameters={'since_hours': since_hours}
    )
    try:
        from memory.consolidation import ConsolidationPipeline
        from memory.storage import MemoryStorage

        base_path = safe_path_join('.loki', 'memory')
        storage = MemoryStorage(base_path)
        pipeline = ConsolidationPipeline(storage)

        result = pipeline.consolidate(since_hours=since_hours)
        _emit_tool_event_async('loki_consolidate_memory', 'complete', result_status='success')
        return json.dumps(result, default=str)
    except PathTraversalError as e:
        logger.error(f"Path traversal attempt blocked: {e}")
        _emit_tool_event_async('loki_consolidate_memory', 'complete', result_status='error', error='Access denied')
        return json.dumps({"error": "Access denied"})
    except Exception as e:
        logger.error(f"Consolidation failed: {e}")
        _emit_tool_event_async('loki_consolidate_memory', 'complete', result_status='error', error=str(e))
        return json.dumps({"error": str(e)})


# ============================================================
# RESOURCES - Data that can be read
# ============================================================

@mcp.resource("loki://state/continuity")
async def get_continuity() -> str:
    """Get the current CONTINUITY.md content"""
    try:
        continuity_path = safe_path_join('.loki', 'CONTINUITY.md')
        if os.path.exists(continuity_path):
            with safe_open(continuity_path, 'r') as f:
                return f.read()
        return "# CONTINUITY.md not found"
    except PathTraversalError:
        return "# Access denied"


@mcp.resource("loki://memory/index")
async def get_memory_index() -> str:
    """Get the memory index (Layer 1)"""
    try:
        # Use StateManager if available
        manager = _get_mcp_state_manager()
        if manager and STATE_MANAGER_AVAILABLE:
            index_data = manager.get_state(ManagedFile.MEMORY_INDEX)
            if index_data:
                return json.dumps(index_data)
            return json.dumps({"topics": [], "message": "Index not initialized"})

        # Fallback to direct file read
        index_path = safe_path_join('.loki', 'memory', 'index.json')
        if os.path.exists(index_path):
            with safe_open(index_path, 'r') as f:
                return f.read()
        return json.dumps({"topics": [], "message": "Index not initialized"})
    except PathTraversalError:
        return json.dumps({"error": "Access denied", "topics": []})


@mcp.resource("loki://queue/pending")
async def get_pending_tasks() -> str:
    """Get all pending tasks from the queue"""
    try:
        # Use StateManager if available
        manager = _get_mcp_state_manager()
        if manager and STATE_MANAGER_AVAILABLE:
            queue = manager.get_state("state/task-queue.json")
            if queue:
                pending = [t for t in queue.get("tasks", []) if t.get("status") == "pending"]
                return json.dumps({"pending_tasks": pending, "count": len(pending)})
            return json.dumps({"pending_tasks": [], "count": 0})

        # Fallback to direct file read
        queue_path = safe_path_join('.loki', 'state', 'task-queue.json')
        if os.path.exists(queue_path):
            with safe_open(queue_path, 'r') as f:
                queue = json.load(f)
                pending = [t for t in queue.get("tasks", []) if t.get("status") == "pending"]
                return json.dumps({"pending_tasks": pending, "count": len(pending)})
        return json.dumps({"pending_tasks": [], "count": 0})
    except PathTraversalError:
        return json.dumps({"error": "Access denied", "pending_tasks": [], "count": 0})


# ============================================================
# PROMPTS - Pre-built prompt templates
# ============================================================

@mcp.prompt()
async def loki_start(prd_path: str = "") -> str:
    """Initialize a Loki Mode session with optional PRD"""
    return f"""You are now operating in Loki Mode - autonomous agent orchestration.

RARV Cycle: Reason -> Act -> Reflect -> Verify

Current PRD: {prd_path or 'None specified'}

Steps:
1. Analyze the PRD and extract requirements
2. Break down into actionable tasks
3. Execute tasks following RARV cycle
4. Verify completion against acceptance criteria

Use loki_* tools to manage tasks and memory.
Begin by analyzing the requirements."""


@mcp.prompt()
async def loki_phase_report() -> str:
    """Generate a status report for the current phase"""
    return """Generate a comprehensive status report including:

1. Current SDLC Phase
2. Tasks Completed / In Progress / Pending
3. Quality Gate Status
4. Key Decisions Made
5. Blockers or Risks
6. Next Steps

Use loki_state_get and loki_task_queue_list to gather data."""


# ============================================================
# MAIN
# ============================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Loki Mode MCP Server')
    parser.add_argument('--transport', choices=['stdio', 'http'], default='stdio',
                       help='Transport mechanism (default: stdio)')
    parser.add_argument('--port', type=int, default=8421,
                       help='Port for HTTP transport (default: 8421)')
    args = parser.parse_args()

    logger.info(f"Starting Loki Mode MCP server (transport: {args.transport})")

    if args.transport == 'http':
        mcp.run(transport='http', port=args.port)
    else:
        mcp.run(transport='stdio')


if __name__ == '__main__':
    main()
