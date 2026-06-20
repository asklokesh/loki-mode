"""
tests/dashboard/test_audit_chain_concurrency.py

Regression for the audit integrity-chain corruption under concurrent
log_event() calls (dashboard/audit.py).

Before the fix, log_event() did an unsynchronized read-modify-write of the
module-global _last_hash and then appended the line to disk with no lock. Under
concurrency the hash chaining and the file appends interleaved, so the on-disk
line order no longer matched the chain order: verify_all_logs_in_dir() returned
valid:False even though every line was written and none was tampered with.

The fix wraps "compute hash -> update _last_hash -> append the line" in a
module-level threading.Lock so that critical section is atomic and on-disk order
always matches chain order.

All tests are hermetic: AUDIT_DIR and _last_hash are pointed at a tmp dir / the
genesis hash so the real ~/.loki is never touched.
"""

import threading
from pathlib import Path

import pytest

from dashboard import audit


@pytest.fixture
def temp_audit(tmp_path, monkeypatch):
    """Point the audit module at an isolated temp dir + fresh genesis chain."""
    audit_dir = tmp_path / "audit"
    monkeypatch.setattr(audit, "AUDIT_DIR", audit_dir)
    monkeypatch.setattr(audit, "_last_hash", "0" * 64)
    # Force integrity + audit ON regardless of the ambient environment so the
    # chain is always written and verifiable.
    monkeypatch.setattr(audit, "INTEGRITY_ENABLED", True)
    monkeypatch.setattr(audit, "ENTERPRISE_AUDIT_ENABLED", True)
    return audit_dir


def test_chain_intact_under_concurrent_writes(temp_audit):
    threads_n = 8
    per_thread = 50
    expected = threads_n * per_thread

    def worker():
        for _ in range(per_thread):
            audit.log_event("create", "project", resource_id="x")

    threads = [threading.Thread(target=worker) for _ in range(threads_n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Every line was written.
    lines_on_disk = 0
    for f in temp_audit.glob("audit-*.jsonl"):
        lines_on_disk += sum(1 for _ in open(f))
    assert lines_on_disk == expected, (
        f"expected {expected} lines on disk, found {lines_on_disk}"
    )

    # And the chain verifies end-to-end across all entries.
    result = audit.verify_all_logs_in_dir(temp_audit)
    assert result["valid"] is True, f"chain broke under concurrency: {result}"
    assert result["entries_checked"] == expected, (
        f"verified {result['entries_checked']} of {expected} entries: {result}"
    )


def test_chain_intact_single_threaded(temp_audit):
    # Sanity: the lock does not break the simple sequential path.
    for i in range(5):
        audit.log_event("read", "task", resource_id=str(i))

    result = audit.verify_all_logs_in_dir(temp_audit)
    assert result["valid"] is True, result
    assert result["entries_checked"] == 5, result


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
