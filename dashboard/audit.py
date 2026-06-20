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

from __future__ import annotations

import hashlib
import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
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

# Serializes the chain read-modify-write + file append in log_event(). Without
# it, concurrent callers (the dashboard fans audit writes out across async
# handlers / asyncio.to_thread workers) interleave the unsynchronized
# _last_hash RMW with the file append: lines get written in a different order
# than the hashes were chained, which breaks the tamper-evident chain so
# verify_all_logs() reports valid:False even though no entry was tampered with.
# Holding this lock makes "compute hash, update _last_hash, append the line" a
# single atomic step so on-disk line order always matches chain order.
_hash_lock = threading.Lock()


def _recover_last_hash() -> str:
    """Recover the last integrity hash from the most recent audit log file.

    On server restart, the in-memory _last_hash resets to the genesis hash.
    This function reads the last entry from the most recent log file and
    extracts its _integrity_hash so the chain continues unbroken.

    Returns:
        The last hash found, or the genesis hash if no log entries exist.
    """
    genesis = "0" * 64
    if not AUDIT_DIR.exists():
        return genesis

    log_files = sorted(AUDIT_DIR.glob("audit-*.jsonl"), reverse=True)
    for log_file in log_files:
        try:
            # Read the last non-empty line from the file
            last_line = ""
            with open(log_file, "rb") as f:
                # Seek to end and scan backward for last line
                f.seek(0, 2)  # Seek to end
                pos = f.tell()
                if pos == 0:
                    continue
                # Read from end to find last non-empty line
                lines = []
                while pos > 0:
                    read_size = min(4096, pos)
                    pos -= read_size
                    f.seek(pos)
                    chunk = f.read(read_size).decode("utf-8", errors="replace")
                    lines = chunk.split("\n") + lines
                    # Check if we have at least one non-empty line
                    non_empty = [ln for ln in lines if ln.strip()]
                    if non_empty:
                        last_line = non_empty[-1].strip()
                        break

            if not last_line:
                continue

            entry = json.loads(last_line)
            stored_hash = entry.get("_integrity_hash")
            if stored_hash:
                return stored_hash
        except (json.JSONDecodeError, IOError, OSError):
            continue

    return genesis


# Recover chain hash from existing logs on startup
if INTEGRITY_ENABLED:
    _last_hash = _recover_last_hash()

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

    # Tamper-evident chain hash + file append, serialized as one atomic step.
    #
    # The chain hash is a read-modify-write of the module-global _last_hash, and
    # the line must land in the file in the same order the hashes were chained.
    # _hash_lock guards the whole "compute hash -> update _last_hash -> append"
    # critical section so concurrent callers cannot interleave and break the
    # chain (see _hash_lock definition above).
    #
    # NOTE for async callers: log_event() does blocking file I/O while holding
    # this lock. When called from an asyncio handler it SHOULD be offloaded with
    # `await asyncio.to_thread(audit.log_event, ...)` so a slow disk does not
    # stall the dashboard event loop. The thread-safety here is what makes that
    # offload safe; rewriting every call site to async is a separate, larger
    # change and is intentionally not done here.
    global _last_hash
    with _hash_lock:
        if INTEGRITY_ENABLED:
            entry_json = json.dumps(entry, sort_keys=True, default=str)
            entry["_integrity_hash"] = _compute_chain_hash(entry_json, _last_hash)
            _last_hash = entry["_integrity_hash"]

        log_file = _get_current_log_file()
        _rotate_logs_if_needed(log_file)

        with open(log_file, "a") as f:
            f.write(json.dumps(entry) + "\n")

    # Forward to syslog if configured (outside the lock: fire-and-forget and
    # must never extend the critical section / block other writers).
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


def verify_log_integrity(log_file: str, start_hash: Optional[str] = None) -> dict:
    """Verify the integrity chain of a JSONL audit log file.

    Reads each line, recomputes the chain hash, and compares to the
    stored _integrity_hash. If any entry has been tampered with, all
    subsequent hashes will also fail to match.

    v7.7.15 fix: now accepts an optional `start_hash`. Audit logs rotate
    daily and `_recover_last_hash()` carries the chain across file
    boundaries at WRITE time. Without `start_hash`, verifying any log
    file beyond the first-ever produces a false-negative (the file's
    first entry was hashed against the PREVIOUS file's last hash, not
    against the genesis "0"*64). Pass the previous file's final hash to
    verify correctly, or use the new `verify_all_logs()` wrapper to
    verify the entire chain across all rotated files.

    Args:
        log_file: Path to the JSONL audit log file to verify.
        start_hash: Optional 64-hex starting hash for the chain. If
            omitted, uses the genesis hash "0"*64 (correct only for the
            very first audit log ever created on this machine).

    Returns:
        A dict with:
          - valid (bool): True if the entire chain is intact.
          - entries_checked (int): Number of entries verified.
          - first_tampered_line (int | None): 1-based line number of the
            first entry where the hash chain broke, or None if valid.
          - last_hash (str): The final hash in this file (caller chains
            this into the next file's verification).
    """
    prev_hash = start_hash if start_hash is not None else ("0" * 64)
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
                        "last_hash": prev_hash,
                    }

                stored_hash = entry.pop("_integrity_hash", None)
                if stored_hash is None:
                    # Entry has no integrity hash -- chain is broken
                    return {
                        "valid": False,
                        "entries_checked": entries_checked,
                        "first_tampered_line": line_num,
                        "last_hash": prev_hash,
                    }

                entry_json = json.dumps(entry, sort_keys=True, default=str)
                expected_hash = _compute_chain_hash(entry_json, prev_hash)

                if stored_hash != expected_hash:
                    return {
                        "valid": False,
                        "entries_checked": entries_checked,
                        "first_tampered_line": line_num,
                        "last_hash": prev_hash,
                    }

                prev_hash = stored_hash
                entries_checked += 1

    except FileNotFoundError:
        return {"valid": True, "entries_checked": 0, "first_tampered_line": None,
                "last_hash": prev_hash}

    # Normal exit (no rows or all rows passed): valid + carry last_hash forward
    return {"valid": True, "entries_checked": entries_checked,
            "first_tampered_line": None, "last_hash": prev_hash}


def _file_has_integrity(log_file: str) -> bool:
    """Return True iff the first non-empty entry in `log_file` has an
    `_integrity_hash` field. Used by `verify_all_logs` to skip
    pre-integrity-era files entirely (integrity hashing was introduced
    after some audit logs already existed)."""
    try:
        with open(log_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    return False
                return "_integrity_hash" in entry
    except OSError:
        return False
    return False


def verify_all_logs_in_dir(audit_dir) -> dict:
    """Verify the entire audit chain across all rotated log files in
    an explicit directory.

    This is the directory-parameterized core of :func:`verify_all_logs`.
    The default :func:`verify_all_logs` delegates here with the module
    ``AUDIT_DIR`` so existing callers are unaffected. The explicit-dir
    form lets the unified cross-chain verifier (see ``src/audit/crosslink.js``)
    validate an arbitrary audit directory without mutating module globals.

    Args:
        audit_dir: Path (str or pathlib.Path) to a directory containing
            ``audit-*.jsonl`` files.

    Returns:
        Same shape as :func:`verify_all_logs`.
    """
    audit_dir = Path(audit_dir)
    if not audit_dir.exists():
        return {"valid": True, "files_checked": 0, "files_skipped": 0,
                "entries_checked": 0, "first_tampered_file": None,
                "first_tampered_line": None, "genesis_file": None}
    # v7.7.15 council fix (Opus 2): rotated files have name shape
    # `audit-YYYY-MM-DD.HHMMSS.jsonl` (from `_rotate_logs_if_needed` at
    # line 167). Lexicographic sort puts `audit-2026-05-04.123456.jsonl`
    # BEFORE `audit-2026-05-04.jsonl` (because `.1` < `.j` ASCII), which
    # would break chain ordering and false-negative on any user who hit
    # size-based rotation. Sort by mtime instead -- mirrors what
    # `_cleanup_old_logs` already does at line 178.
    files = sorted(audit_dir.glob("audit-*.jsonl"), key=lambda p: p.stat().st_mtime)
    prev_hash = "0" * 64
    total_entries = 0
    files_checked = 0
    files_skipped = 0
    genesis_file = None
    for log_file in files:
        if genesis_file is None and not _file_has_integrity(str(log_file)):
            files_skipped += 1
            continue
        if genesis_file is None:
            genesis_file = str(log_file)
        result = verify_log_integrity(str(log_file), start_hash=prev_hash)
        files_checked += 1
        total_entries += result.get("entries_checked", 0)
        if not result.get("valid", False):
            return {
                "valid": False,
                "files_checked": files_checked,
                "files_skipped": files_skipped,
                "entries_checked": total_entries,
                "first_tampered_file": str(log_file),
                "first_tampered_line": result.get("first_tampered_line"),
                "genesis_file": genesis_file,
            }
        prev_hash = result.get("last_hash", prev_hash)
    return {
        "valid": True,
        "files_checked": files_checked,
        "files_skipped": files_skipped,
        "entries_checked": total_entries,
        "first_tampered_file": None,
        "first_tampered_line": None,
        "genesis_file": genesis_file,
    }


def verify_all_logs() -> dict:
    """v7.7.15: verify the entire audit chain across all rotated log files.

    Walks `AUDIT_DIR/audit-*.jsonl` in chronological order, threading
    the chain hash from one file to the next via `start_hash`. Skips
    files from the pre-integrity era (files whose first entry has no
    `_integrity_hash` field, because integrity hashing was introduced
    after some audit logs already existed).

    Returns:
        A dict with:
          - valid (bool): True if the entire cross-file chain is intact.
          - files_checked (int): Count of integrity-bearing files inspected.
          - files_skipped (int): Count of pre-integrity files skipped.
          - entries_checked (int): Total entries verified across all files.
          - first_tampered_file (str | None): Path to the first file
            whose chain broke, or None if valid.
          - first_tampered_line (int | None): 1-based line number in
            that file where the chain broke, or None if valid.
          - genesis_file (str | None): Path to the first integrity-bearing
            log file (the chain's genesis on this machine), or None if
            no integrity-bearing files exist.
    """
    return verify_all_logs_in_dir(AUDIT_DIR)


def compute_chain_tip_in_dir(audit_dir) -> dict:
    """Return the current tip (last hash) of the Python audit chain in
    an explicit directory, plus a verification verdict for that chain.

    Used by the unified cross-chain verifier to anchor the Python chain
    state into the JS (``src/audit/log.js``) tamper-evident chain via a
    cross-link record, and to reconcile a previously recorded anchor
    against the live chain.

    Args:
        audit_dir: Path (str or pathlib.Path) to the Python audit dir.

    Returns:
        A dict with:
          - genesis (str): The genesis hash for this chain ("0"*64).
          - tip_hash (str): The last integrity hash, or the genesis hash
            if the chain is empty.
          - entries (int): Total integrity-bearing entries in the chain.
          - valid (bool): Whether the chain verifies end-to-end.
          - chain_id (str): Stable identifier for this chain family.
    """
    result = verify_all_logs_in_dir(audit_dir)
    audit_dir = Path(audit_dir)
    genesis = "0" * 64
    tip_hash = genesis
    if audit_dir.exists():
        files = sorted(audit_dir.glob("audit-*.jsonl"), key=lambda p: p.stat().st_mtime)
        prev = genesis
        for log_file in files:
            if not _file_has_integrity(str(log_file)):
                continue
            r = verify_log_integrity(str(log_file), start_hash=prev)
            prev = r.get("last_hash", prev)
        tip_hash = prev
    return {
        "genesis": genesis,
        "tip_hash": tip_hash,
        "entries": result.get("entries_checked", 0),
        "valid": bool(result.get("valid", False)),
        "chain_id": "loki-dashboard-audit",
    }


def compute_prefix_hash_in_dir(audit_dir, n_entries: int) -> dict:
    """Recompute the dashboard chain hash after exactly the first
    ``n_entries`` integrity-bearing entries, walking files in mtime
    order across rotations.

    This is what lets the unified cross-chain verifier distinguish
    legitimate append-only GROWTH from TAMPER. A cross-link anchor pins
    ``(tip_hash, entries)`` at link time; later the live chain may have
    grown. Reconciliation recomputes the hash of the first ``n_entries``
    (the anchored prefix) and checks it still reproduces the anchored
    ``tip_hash``. Growth keeps the prefix intact (reproducible); any
    mutation at-or-before the anchor, or truncation below it, makes the
    prefix unreproducible.

    Args:
        audit_dir: Path (str or pathlib.Path) to the Python audit dir.
        n_entries: Number of leading integrity-bearing entries to hash.

    Returns:
        A dict with:
          - found (bool): True if at least ``n_entries`` entries exist
            and the prefix was hashed without a chain break inside it.
          - prefix_hash (str): The chain hash after ``n_entries`` entries
            (or the running hash reached if fewer entries exist / a break
            occurred -- in which case ``found`` is False).
          - entries_available (int): Total integrity-bearing entries seen.
    """
    audit_dir = Path(audit_dir)
    genesis = "0" * 64
    if n_entries <= 0:
        return {"found": True, "prefix_hash": genesis, "entries_available": 0}
    if not audit_dir.exists():
        return {"found": False, "prefix_hash": genesis, "entries_available": 0}
    files = sorted(audit_dir.glob("audit-*.jsonl"), key=lambda p: p.stat().st_mtime)
    prev_hash = genesis
    seen = 0
    started = False
    for log_file in files:
        if not started and not _file_has_integrity(str(log_file)):
            continue
        started = True
        try:
            with open(log_file, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        return {"found": False, "prefix_hash": prev_hash,
                                "entries_available": seen}
                    stored_hash = entry.pop("_integrity_hash", None)
                    if stored_hash is None:
                        return {"found": False, "prefix_hash": prev_hash,
                                "entries_available": seen}
                    entry_json = json.dumps(entry, sort_keys=True, default=str)
                    expected = _compute_chain_hash(entry_json, prev_hash)
                    if stored_hash != expected:
                        # Chain broke inside the prefix -> not reproducible.
                        return {"found": False, "prefix_hash": prev_hash,
                                "entries_available": seen}
                    prev_hash = stored_hash
                    seen += 1
                    if seen == n_entries:
                        return {"found": True, "prefix_hash": prev_hash,
                                "entries_available": seen}
        except OSError:
            return {"found": False, "prefix_hash": prev_hash,
                    "entries_available": seen}
    # Fewer than n_entries entries exist (truncation below the anchor).
    return {"found": False, "prefix_hash": prev_hash, "entries_available": seen}


def _unified_cli() -> int:
    """Tiny CLI shim so the Node-side unified verifier (or an operator)
    can fetch the Python chain tip / verdict for a given directory as
    JSON. Invoked as:

        python3 dashboard/audit.py tip <audit_dir>
        python3 dashboard/audit.py verify <audit_dir>

    Prints a single JSON object to stdout. Returns process exit code 0
    on a valid chain, 1 on an invalid chain, 2 on usage error.
    """
    argv = sys.argv[1:]
    if len(argv) < 2 or argv[0] not in ("tip", "verify", "prefix"):
        print(json.dumps(
            {"error": "usage: audit.py {tip|verify} <audit_dir> "
                      "| prefix <audit_dir> <n_entries>"}))
        return 2
    cmd, audit_dir = argv[0], argv[1]
    if cmd == "tip":
        out = compute_chain_tip_in_dir(audit_dir)
        print(json.dumps(out))
        return 0 if out.get("valid", False) else 1
    if cmd == "prefix":
        if len(argv) < 3:
            print(json.dumps({"error": "prefix requires <n_entries>"}))
            return 2
        try:
            n = int(argv[2])
        except ValueError:
            print(json.dumps({"error": "n_entries must be an integer"}))
            return 2
        out = compute_prefix_hash_in_dir(audit_dir, n)
        print(json.dumps(out))
        return 0 if out.get("found", False) else 1
    out = verify_all_logs_in_dir(audit_dir)
    print(json.dumps(out))
    return 0 if out.get("valid", False) else 1


if __name__ == "__main__":
    sys.exit(_unified_cli())
