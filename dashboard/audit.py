"""
Optional Audit Logging Module for Loki Mode Dashboard.

Enterprise feature - disabled by default.
Enable with LOKI_ENTERPRISE_AUDIT=true environment variable.

Audit logs: ~/.loki/dashboard/audit/
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Configuration
ENTERPRISE_AUDIT_ENABLED = os.environ.get("LOKI_ENTERPRISE_AUDIT", "").lower() in ("true", "1", "yes")
AUDIT_DIR = Path.home() / ".loki" / "dashboard" / "audit"

# Log rotation settings
MAX_LOG_SIZE_MB = int(os.environ.get("LOKI_AUDIT_MAX_SIZE_MB", "10"))
MAX_LOG_FILES = int(os.environ.get("LOKI_AUDIT_MAX_FILES", "10"))


def _ensure_audit_dir() -> None:
    """Ensure the audit directory exists."""
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)


def _get_current_log_file() -> Path:
    """Get the current audit log file (date-based)."""
    _ensure_audit_dir()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return AUDIT_DIR / f"audit-{today}.jsonl"


def _rotate_logs_if_needed(log_file: Path) -> None:
    """Rotate log file if it exceeds max size."""
    if not log_file.exists():
        return

    size_mb = log_file.stat().st_size / (1024 * 1024)
    if size_mb < MAX_LOG_SIZE_MB:
        return

    # Rotate: rename current file with timestamp
    timestamp = datetime.now(timezone.utc).strftime("%H%M%S")
    rotated = log_file.with_suffix(f".{timestamp}.jsonl")
    log_file.rename(rotated)

    # Clean up old logs
    _cleanup_old_logs()


def _cleanup_old_logs() -> None:
    """Remove oldest log files if we exceed max count."""
    if not AUDIT_DIR.exists():
        return

    log_files = sorted(AUDIT_DIR.glob("audit-*.jsonl"), key=lambda p: p.stat().st_mtime)

    while len(log_files) > MAX_LOG_FILES:
        oldest = log_files.pop(0)
        oldest.unlink()


def log_event(
    action: str,
    resource_type: str,
    resource_id: Optional[str] = None,
    user_id: Optional[str] = None,
    token_id: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    success: bool = True,
    error: Optional[str] = None,
) -> Optional[dict]:
    """
    Log an audit event.

    Args:
        action: The action performed (create, read, update, delete, login, etc.)
        resource_type: Type of resource (project, task, token, etc.)
        resource_id: ID of the affected resource
        user_id: User identifier (if known)
        token_id: API token ID used (if any)
        details: Additional details about the action
        ip_address: Client IP address
        user_agent: Client user agent
        success: Whether the action succeeded
        error: Error message if action failed

    Returns:
        The audit entry if logging is enabled, None otherwise
    """
    if not ENTERPRISE_AUDIT_ENABLED:
        return None

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "user_id": user_id,
        "token_id": token_id,
        "ip_address": ip_address,
        "user_agent": user_agent,
        "success": success,
        "error": error,
        "details": details or {},
    }

    log_file = _get_current_log_file()
    _rotate_logs_if_needed(log_file)

    with open(log_file, "a") as f:
        f.write(json.dumps(entry) + "\n")

    return entry


def query_logs(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    action: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    user_id: Optional[str] = None,
    token_id: Optional[str] = None,
    success: Optional[bool] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    """
    Query audit logs with filters.

    Args:
        start_date: Filter from date (YYYY-MM-DD)
        end_date: Filter to date (YYYY-MM-DD)
        action: Filter by action type
        resource_type: Filter by resource type
        resource_id: Filter by resource ID
        user_id: Filter by user ID
        token_id: Filter by token ID
        success: Filter by success status
        limit: Maximum results to return
        offset: Number of results to skip

    Returns:
        List of matching audit entries
    """
    if not AUDIT_DIR.exists():
        return []

    results = []

    # Get relevant log files based on date range
    log_files = sorted(AUDIT_DIR.glob("audit-*.jsonl"), reverse=True)

    if start_date:
        log_files = [f for f in log_files if f.stem >= f"audit-{start_date}"]
    if end_date:
        log_files = [f for f in log_files if f.stem.split(".")[0] <= f"audit-{end_date}"]

    for log_file in log_files:
        try:
            with open(log_file, "r") as f:
                for line in f:
                    try:
                        entry = json.loads(line.strip())

                        # Apply filters
                        if action and entry.get("action") != action:
                            continue
                        if resource_type and entry.get("resource_type") != resource_type:
                            continue
                        if resource_id and entry.get("resource_id") != resource_id:
                            continue
                        if user_id and entry.get("user_id") != user_id:
                            continue
                        if token_id and entry.get("token_id") != token_id:
                            continue
                        if success is not None and entry.get("success") != success:
                            continue

                        results.append(entry)

                    except json.JSONDecodeError:
                        continue

        except IOError:
            continue

    # Sort by timestamp descending
    results.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    # Apply pagination
    return results[offset:offset + limit]


def get_audit_summary(days: int = 7) -> dict:
    """
    Get a summary of audit activity.

    Args:
        days: Number of days to summarize

    Returns:
        Summary statistics
    """
    from datetime import timedelta

    start_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    entries = query_logs(start_date=start_date, limit=10000)

    summary = {
        "period_days": days,
        "total_events": len(entries),
        "successful_events": sum(1 for e in entries if e.get("success")),
        "failed_events": sum(1 for e in entries if not e.get("success")),
        "by_action": {},
        "by_resource_type": {},
        "by_user": {},
        "recent_failures": [],
    }

    for entry in entries:
        # Count by action
        action = entry.get("action", "unknown")
        summary["by_action"][action] = summary["by_action"].get(action, 0) + 1

        # Count by resource type
        resource_type = entry.get("resource_type", "unknown")
        summary["by_resource_type"][resource_type] = summary["by_resource_type"].get(resource_type, 0) + 1

        # Count by user
        user_id = entry.get("user_id") or entry.get("token_id") or "anonymous"
        summary["by_user"][user_id] = summary["by_user"].get(user_id, 0) + 1

        # Track recent failures
        if not entry.get("success") and len(summary["recent_failures"]) < 10:
            summary["recent_failures"].append({
                "timestamp": entry.get("timestamp"),
                "action": action,
                "resource_type": resource_type,
                "error": entry.get("error"),
            })

    return summary


def is_audit_enabled() -> bool:
    """Check if audit logging is enabled."""
    return ENTERPRISE_AUDIT_ENABLED
