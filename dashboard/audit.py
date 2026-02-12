"""
Audit Logging Module for Loki Mode Dashboard.

Enabled by default. Disable with LOKI_AUDIT_DISABLED=true environment variable.
Legacy env var LOKI_ENTERPRISE_AUDIT=true always enables audit (backward compat).

Audit logs: ~/.loki/dashboard/audit/

Syslog forwarding (optional):
  Set LOKI_AUDIT_SYSLOG_HOST to enable forwarding to a centralized syslog server.
  LOKI_AUDIT_SYSLOG_PORT defaults to 514.
  LOKI_AUDIT_SYSLOG_PROTO defaults to "udp" (also supports "tcp").
"""

import hashlib
import json
import logging
import logging.handlers
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Configuration
# Audit is ON by default. Disable with LOKI_AUDIT_DISABLED=true.
# Backward compat: LOKI_ENTERPRISE_AUDIT=true always forces audit ON.
_audit_disabled = os.environ.get("LOKI_AUDIT_DISABLED", "").lower() in ("true", "1", "yes")
_enterprise_force_on = os.environ.get("LOKI_ENTERPRISE_AUDIT", "").lower() in ("true", "1", "yes")
ENTERPRISE_AUDIT_ENABLED = _enterprise_force_on or (not _audit_disabled)
AUDIT_DIR = Path.home() / ".loki" / "dashboard" / "audit"

# Log rotation settings
MAX_LOG_SIZE_MB = int(os.environ.get("LOKI_AUDIT_MAX_SIZE_MB", "10"))
MAX_LOG_FILES = int(os.environ.get("LOKI_AUDIT_MAX_FILES", "10"))

# Syslog forwarding (optional, off by default)
_SYSLOG_HOST = os.environ.get("LOKI_AUDIT_SYSLOG_HOST", "").strip()
_SYSLOG_PORT = int(os.environ.get("LOKI_AUDIT_SYSLOG_PORT", "514"))
_SYSLOG_PROTO = os.environ.get("LOKI_AUDIT_SYSLOG_PROTO", "udp").lower().strip()

# Integrity chain hashing (tamper-evident logging)
# Disable with LOKI_AUDIT_NO_INTEGRITY=true
INTEGRITY_ENABLED = os.environ.get("LOKI_AUDIT_NO_INTEGRITY", "").lower() not in ("true", "1", "yes")
_last_hash: str = "0" * 64  # Genesis hash

# Actions considered security-relevant (logged at WARNING level in syslog)
_SECURITY_ACTIONS = frozenset({
    "delete", "kill", "stop", "login", "logout",
    "create_token", "revoke_token",
})

_syslog_handler: logging.handlers.SysLogHandler | None = None
SYSLOG_ENABLED: bool = False

if _SYSLOG_HOST:
    try:
        _socktype = socket.SOCK_STREAM if _SYSLOG_PROTO == "tcp" else socket.SOCK_DGRAM
        _syslog_handler = logging.handlers.SysLogHandler(
            address=(_SYSLOG_HOST, _SYSLOG_PORT),
            facility=logging.handlers.SysLogHandler.LOG_LOCAL0,
            socktype=_socktype,
        )
        _syslog_handler.setFormatter(logging.Formatter("loki-audit: %(message)s"))
        SYSLOG_ENABLED = True
    except Exception as _exc:
        print(
            f"[loki-audit] WARNING: Failed to configure syslog handler "
            f"({_SYSLOG_HOST}:{_SYSLOG_PORT}/{_SYSLOG_PROTO}): {_exc}",
            file=sys.stderr,
        )
        _syslog_handler = None


def _ensure_audit_dir() -> None:
    """Ensure the audit directory exists."""
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)


def _compute_chain_hash(entry_json: str, prev_hash: str) -> str:
    """Compute a SHA-256 chain hash linking this entry to the previous one.

    Each hash depends on the previous entry's hash, creating a tamper-evident
    chain. If any entry is modified, all subsequent hashes will be invalid.
    """
    return hashlib.sha256((prev_hash + entry_json).encode("utf-8")).hexdigest()


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


def _forward_to_syslog(entry: dict) -> None:
    """Forward an audit entry to syslog if configured. Fire-and-forget."""
    if _syslog_handler is None:
        return
    try:
        message = json.dumps(entry, separators=(",", ":"))
        action = entry.get("action", "")
        is_security = action in _SECURITY_ACTIONS or not entry.get("success", True)
        level = logging.WARNING if is_security else logging.INFO
        record = logging.LogRecord(
            name="loki-audit",
            level=level,
            pathname="",
            lineno=0,
            msg=message,
            args=(),
            exc_info=None,
        )
        _syslog_handler.emit(record)
    except Exception:
        # Fire-and-forget: never block the main audit write path
        pass


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

    # Tamper-evident chain hash
    global _last_hash
    if INTEGRITY_ENABLED:
        entry_json = json.dumps(entry, sort_keys=True, default=str)
        entry["_integrity_hash"] = _compute_chain_hash(entry_json, _last_hash)
        _last_hash = entry["_integrity_hash"]

    log_file = _get_current_log_file()
    _rotate_logs_if_needed(log_file)

    with open(log_file, "a") as f:
        f.write(json.dumps(entry) + "\n")

    # Forward to syslog if configured
    _forward_to_syslog(entry)

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
    """Check if audit logging is enabled (on by default, disable with LOKI_AUDIT_DISABLED=true)."""
    return ENTERPRISE_AUDIT_ENABLED


def verify_log_integrity(log_file: str) -> dict:
    """Verify the integrity chain of a JSONL audit log file.

    Reads each line, recomputes the chain hash from the genesis hash,
    and compares it to the stored _integrity_hash. If any entry has been
    tampered with, all subsequent hashes will also fail to match.

    Args:
        log_file: Path to the JSONL audit log file to verify.

    Returns:
        A dict with:
          - valid (bool): True if the entire chain is intact.
          - entries_checked (int): Number of entries verified.
          - first_tampered_line (int | None): 1-based line number of the
            first entry where the hash chain broke, or None if valid.
    """
    prev_hash = "0" * 64  # Genesis hash
    entries_checked = 0

    try:
        with open(log_file, "r") as f:
            for line_num, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue

                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    return {
                        "valid": False,
                        "entries_checked": entries_checked,
                        "first_tampered_line": line_num,
                    }

                stored_hash = entry.pop("_integrity_hash", None)
                if stored_hash is None:
                    # Entry has no integrity hash -- chain is broken
                    return {
                        "valid": False,
                        "entries_checked": entries_checked,
                        "first_tampered_line": line_num,
                    }

                entry_json = json.dumps(entry, sort_keys=True, default=str)
                expected_hash = _compute_chain_hash(entry_json, prev_hash)

                if stored_hash != expected_hash:
                    return {
                        "valid": False,
                        "entries_checked": entries_checked,
                        "first_tampered_line": line_num,
                    }

                prev_hash = stored_hash
                entries_checked += 1

    except FileNotFoundError:
        return {"valid": True, "entries_checked": 0, "first_tampered_line": None}

    return {"valid": True, "entries_checked": entries_checked, "first_tampered_line": None}
