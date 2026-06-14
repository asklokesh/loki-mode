"""
tests/mcp/test_lsp_staleness.py

Regression suite for two LSP-proxy correctness fixes:

  1. STALENESS (the load-bearing fix). Before this change, LSPClient.did_open
     early-returned whenever a file's URI was already in the opened set, and
     there was no textDocument/didChange anywhere. So a file edited within a
     session kept returning the diagnostics (and references/definitions) of its
     FIRST-open snapshot forever. This suite proves that:
       (a) the first did_open() emits textDocument/didOpen at version 1;
       (b) editing the file on disk (bumping its mtime) and calling did_open()
           again emits textDocument/didChange at version 2 with the NEW text;
       (c) on a didChange, the stale pending_diagnostics for that URI are
           cleared so a subsequent poll waits for a fresh publish instead of
           returning the pre-edit set;
       (d) calling did_open() again with NO on-disk change emits nothing
           (the original no-op optimization is preserved).

  2. ASYNC OFFLOAD. The @mcp.tool() handlers are async but do blocking I/O.
     They now offload via mcp.lsp_proxy._to_thread. This suite proves the
     _to_thread helper runs a blocking callable and forwards both positional
     and keyword arguments correctly (kwargs are bound via functools.partial
     before anyio.to_thread.run_sync, which is positional-only).

The tests do NOT drive a real LSP subprocess or the reader thread. They drive
LSPClient with a fake `proc` whose stdin captures the raw bytes the client
writes, then decode the Content-Length-framed JSON-RPC messages directly. That
makes the dispatch logic the thing under test, deterministically, with no
network, no installed language server, and no timing.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


if _repo_root() not in sys.path:
    sys.path.insert(0, _repo_root())

import mcp.lsp_proxy as lsp  # noqa: E402


class _CaptureStdin:
    """Minimal stand-in for subprocess Popen.stdin: records every byte the
    client writes so the test can decode the LSP frames afterward."""

    def __init__(self) -> None:
        self.buffer = bytearray()

    def write(self, data: bytes) -> int:
        self.buffer.extend(data)
        return len(data)

    def flush(self) -> None:
        pass


class _FakeProc:
    """Stand-in for subprocess.Popen: alive (poll() is None) with a capturing
    stdin. No stdout reads happen because the test never starts the reader
    thread or calls request()."""

    def __init__(self) -> None:
        self.stdin = _CaptureStdin()
        self.stdout = None
        self.pid = 999999

    def poll(self):
        return None


def _decode_lsp_frames(raw: bytes) -> List[Dict[str, Any]]:
    """Decode a stream of Content-Length-framed JSON-RPC messages (the exact
    framing mcp.lsp_proxy._write_lsp produces) into a list of dicts."""
    messages: List[Dict[str, Any]] = []
    idx = 0
    while idx < len(raw):
        header_end = raw.find(b"\r\n\r\n", idx)
        if header_end == -1:
            break
        header_block = raw[idx:header_end].decode("ascii")
        content_length = None
        for line in header_block.split("\r\n"):
            if line.lower().startswith("content-length:"):
                content_length = int(line.split(":", 1)[1].strip())
        if content_length is None:
            break
        body_start = header_end + 4
        body = raw[body_start:body_start + content_length]
        messages.append(json.loads(body.decode("utf-8")))
        idx = body_start + content_length
    return messages


def _make_client_with_fake_proc() -> "lsp.LSPClient":
    """Build an LSPClient wired to a fake, already-initialized proc so
    did_open() writes are captured without spawning anything."""
    client = lsp.LSPClient("python", "/usr/bin/false", [])
    client.proc = _FakeProc()
    client._initialized = True
    return client


class TestDidOpenStaleness(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "sample.py")
        Path(self.path).write_text("x = 1\n", encoding="utf-8")
        self.client = _make_client_with_fake_proc()
        self.uri = lsp._path_to_uri(self.path)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _captured(self) -> List[Dict[str, Any]]:
        return _decode_lsp_frames(bytes(self.client.proc.stdin.buffer))

    def _bump_mtime_with_content(self, text: str) -> None:
        """Rewrite the file with new content AND force a distinct mtime so the
        change is detected even on coarse-resolution filesystems."""
        Path(self.path).write_text(text, encoding="utf-8")
        st = os.stat(self.path)
        # Push mtime forward by 2s (ns) so st_mtime_ns is unambiguously newer.
        future_ns = st.st_mtime_ns + 2_000_000_000
        os.utime(self.path, ns=(future_ns, future_ns))

    def test_first_open_emits_did_open_version_1(self) -> None:
        self.client.did_open(self.path)
        msgs = self._captured()
        self.assertEqual(len(msgs), 1, "first did_open should emit exactly one frame")
        m = msgs[0]
        self.assertEqual(m["method"], "textDocument/didOpen")
        td = m["params"]["textDocument"]
        self.assertEqual(td["uri"], self.uri)
        self.assertEqual(td["version"], 1)
        self.assertEqual(td["text"], "x = 1\n")
        self.assertEqual(td["languageId"], "python")
        # Internal bookkeeping recorded.
        self.assertEqual(self.client._doc_versions.get(self.uri), 1)
        self.assertIn(self.uri, self.client._doc_mtimes)

    def test_edited_file_emits_did_change_version_2_with_new_text(self) -> None:
        # First open snapshot.
        self.client.did_open(self.path)
        first_count = len(self._captured())
        self.assertEqual(first_count, 1)

        # Edit the file on disk, then re-open.
        self._bump_mtime_with_content("x = 1\ny = nonexistent_symbol\n")
        self.client.did_open(self.path)

        msgs = self._captured()
        self.assertEqual(len(msgs), 2, "edit should add exactly one didChange frame")
        change = msgs[1]
        self.assertEqual(change["method"], "textDocument/didChange",
                         "second open of an edited file must emit didChange")
        td = change["params"]["textDocument"]
        self.assertEqual(td["uri"], self.uri)
        self.assertEqual(td["version"], 2, "version must be incremented to 2")
        content_changes = change["params"]["contentChanges"]
        self.assertEqual(len(content_changes), 1)
        self.assertEqual(content_changes[0]["text"],
                         "x = 1\ny = nonexistent_symbol\n",
                         "didChange must carry the UPDATED file content")
        self.assertEqual(self.client._doc_versions.get(self.uri), 2)

    def test_did_change_clears_stale_pending_diagnostics(self) -> None:
        # Open, then simulate the LSP having published diagnostics for v1.
        self.client.did_open(self.path)
        stale = [{"severity": 1, "message": "old error", "range": {}}]
        with self.client._lock:
            self.client.pending_diagnostics[self.uri] = stale

        # Edit + re-open; the stale entry must be dropped so the next poll
        # waits for a fresh publish instead of returning the pre-edit set.
        self._bump_mtime_with_content("x = 1\n# fixed\n")
        self.client.did_open(self.path)

        with self.client._lock:
            self.assertNotIn(
                self.uri, self.client.pending_diagnostics,
                "stale diagnostics must be cleared on didChange",
            )

    def test_unchanged_file_emits_nothing_on_reopen(self) -> None:
        self.client.did_open(self.path)
        baseline = len(self._captured())
        self.assertEqual(baseline, 1)

        # Re-open with no on-disk change: no new frame (no-op preserved).
        self.client.did_open(self.path)
        self.assertEqual(
            len(self._captured()), baseline,
            "re-opening an unchanged file must not emit any frame",
        )
        # And no spurious didChange / version bump.
        self.assertEqual(self.client._doc_versions.get(self.uri), 1)


class TestToThreadHelper(unittest.TestCase):
    """The async tool handlers offload blocking work via _to_thread. Prove the
    helper runs the callable and forwards positional + keyword args."""

    def test_to_thread_runs_callable_with_positional_args(self) -> None:
        def add(a, b):
            return a + b

        result = asyncio.run(lsp._to_thread(add, 2, 3))
        self.assertEqual(result, 5)

    def test_to_thread_forwards_keyword_args(self) -> None:
        def fn(a, b=10, c=20):
            return (a, b, c)

        # kwargs path: must be bound via functools.partial (run_sync is
        # positional-only). Mixed positional + keyword.
        result = asyncio.run(lsp._to_thread(fn, 1, b=2, c=3))
        self.assertEqual(result, (1, 2, 3))

    def test_to_thread_propagates_exceptions(self) -> None:
        def boom():
            raise ValueError("kaboom")

        with self.assertRaises(ValueError):
            asyncio.run(lsp._to_thread(boom))


class TestRequestIdAtomicity(unittest.TestCase):
    """With handlers offloaded to worker threads, two request() calls on the
    same client allocate ids concurrently. _next_request_id() must never hand
    out the same id twice, or per-request response queues collide."""

    def test_concurrent_allocation_yields_unique_ids(self) -> None:
        import threading

        client = lsp.LSPClient("python", "/usr/bin/false", [])
        allocated: List[int] = []
        allocated_lock = threading.Lock()
        barrier = threading.Barrier(8)

        def worker() -> None:
            barrier.wait()  # maximize contention by starting together
            local = [client._next_request_id() for _ in range(500)]
            with allocated_lock:
                allocated.extend(local)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(
            len(allocated), len(set(allocated)),
            "concurrent _next_request_id() must never return a duplicate id",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
