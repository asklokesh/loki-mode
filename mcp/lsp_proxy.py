#!/usr/bin/env python3
"""
Loki Mode LSP Proxy MCP Server (v7.5.24 Phase G)

Exposes Language Server Protocol (LSP) capabilities to MCP clients by
proxying requests to per-language LSP binaries that the user already has
installed on PATH. The server is silent about missing binaries: if a
language's LSP is not detected, tools targeting that language return a
structured `{"error": ...}` payload but the server itself stays up.

Architecture:
    - Stdlib for the LSP wire + lifecycle (json, subprocess, shutil,
      threading, os, pathlib, atexit, signal, time, urllib). The only
      non-stdlib import is anyio (a transitive MCP-SDK dependency), used
      solely for the threading bridge that keeps the async tool handlers
      off the event loop; it is guarded so the module still imports on the
      no-SDK degrade path.
    - Lazy lifecycle: an `LSPClient` is spawned on the first tool call
      that needs a given language. Spawn does the LSP `initialize`
      handshake and caches `didOpen` per file URI.
    - JSON-RPC 2.0 over stdio framed with `Content-Length` headers
      (LSP spec, NOT line-delimited JSON).
    - Cleanup: atexit handler sends `shutdown` + `exit` and SIGTERMs
      the subprocess after a 2s grace, then removes the PID file at
      `.loki/lsp/pids.json`.

Supported languages (suffix -> binary):
    .ts/.tsx/.js/.jsx -> typescript-language-server
    .py               -> pylsp
    .go               -> gopls
    .rs               -> rust-analyzer

Tools (7):
    lsp_find_references(file, line, character, include_declaration=False)
    lsp_go_to_definition(file, line, character)
    lsp_symbol_at_position(file, line, character)
    lsp_check_exists(symbol, kind=None, ...)
    lsp_get_diagnostics(file)
    lsp_workspace_symbols(query, limit=20, ...)
    lsp_find_definition_by_name(symbol, ...)

Usage:
    python3 -m mcp.lsp_proxy                # stdio mode (default)
    python3 -m mcp.lsp_proxy --transport http --port 8422
"""

from __future__ import annotations

import atexit
import functools
import json
import logging
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

# v7.x async-safety fix: the MCP SDK dispatches @mcp.tool() handlers
# concurrently on its anyio event loop via start_soon. Every handler in this
# module does blocking I/O (LSP handshake up to 10s, request waits up to 5s,
# diagnostics poll sleeps) with no await, so each one stalls the whole loop.
# We offload the blocking body to a worker thread via anyio.to_thread.run_sync.
#
# anyio is a transitive dependency of the MCP SDK, so it is present whenever
# the proxy is actually runnable. But this module must still IMPORT cleanly on
# the _NoopFastMCP degrade path (no SDK, possibly no anyio), so the import is
# guarded and `_to_thread` falls back to an inline call when anyio is absent.
# The inline fallback only runs in degrade/test envs that have no event loop
# to stall, so it is safe there.
try:
    import anyio.to_thread as _anyio_to_thread  # noqa: E402

    _HAS_ANYIO = True
except ImportError:  # pragma: no cover - degrade path without anyio
    _anyio_to_thread = None  # type: ignore[assignment]
    _HAS_ANYIO = False


async def _to_thread(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run a blocking callable off the event loop.

    Uses anyio.to_thread.run_sync (the MCP SDK's own threading bridge) when
    anyio is available; otherwise calls inline (degrade/test path, no loop to
    stall). anyio's run_sync is positional-only, so kwargs are bound via
    functools.partial before handing the callable to the worker thread."""
    if _HAS_ANYIO and _anyio_to_thread is not None:
        if kwargs:
            func = functools.partial(func, **kwargs)
        return await _anyio_to_thread.run_sync(func, *args)
    return func(*args, **kwargs)


# ============================================================
# LOGGING (stderr; stdio transport reserves stdout for JSON-RPC)
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr,
)
logger = logging.getLogger('loki-mcp-lsp-proxy')


# ============================================================
# LANGUAGE / BINARY MAPPING
# ============================================================

# Each entry: (language_id_for_LSP, list_of_file_suffixes, binary_name,
# extra_args_for_invocation). language_id is the LSP `languageId`
# string used in `textDocument/didOpen` params (LSP spec section
# "Text Documents").
LANG_MAP: Dict[str, Tuple[str, List[str], str, List[str]]] = {
    'typescript': (
        'typescript', ['.ts', '.tsx'],
        'typescript-language-server', ['--stdio'],
    ),
    'javascript': (
        'javascript', ['.js', '.jsx', '.mjs', '.cjs'],
        'typescript-language-server', ['--stdio'],
    ),
    # Python: prefer pyright-langserver (Microsoft, faster, stricter types)
    # over pylsp. _detect_lsps() checks the listed binary; if it's not on
    # PATH, the language entry is dropped. v7.7.0 swap: pyright-langserver
    # has better workspace/symbol behavior which the new check_exists tool
    # depends on. pylsp falls back via a separate entry below for users
    # who only have it.
    'python': (
        'python', ['.py'],
        'pyright-langserver', ['--stdio'],
    ),
    'python-pylsp': (
        'python', ['.py'],
        'pylsp', [],
    ),
    'go': (
        'go', ['.go'],
        'gopls', [],
    ),
    'rust': (
        'rust', ['.rs'],
        'rust-analyzer', [],
    ),
    # v7.7.9: Java via Eclipse JDT.LS. The launcher script name varies by
    # install method (`jdtls` from Homebrew, `jdt-language-server` from
    # tarball). We register `jdtls` as the canonical binary; users with
    # the tarball need to symlink or alias.
    'java': (
        'java', ['.java'],
        'jdtls', [],
    ),
}


def _suffix_to_language(file_path: str) -> Optional[str]:
    """Return the LANG_MAP key whose suffix list contains the file's
    extension, or None if no match. Suffix comparison is lowercase."""
    suffix = Path(file_path).suffix.lower()
    if not suffix:
        return None
    for lang, (_lsp_id, suffixes, _bin, _args) in LANG_MAP.items():
        if suffix in suffixes:
            return lang
    return None


# ============================================================
# DETECTION
# ============================================================

_detected: Optional[Dict[str, str]] = None
_detected_lock = threading.Lock()


def _detect_lsps() -> Dict[str, str]:
    """Return {language: absolute_binary_path} for each LANG_MAP entry
    whose binary is found on PATH. Result is cached per process; call
    `_reset_detection_cache()` in tests.

    Multiple language entries may share a binary (typescript +
    javascript both use typescript-language-server). That is handled
    by resolving each entry independently."""
    global _detected
    with _detected_lock:
        if _detected is not None:
            return dict(_detected)
        result: Dict[str, str] = {}
        for lang, (_lsp_id, _suffixes, bin_name, _args) in LANG_MAP.items():
            resolved = shutil.which(bin_name)
            if resolved:
                result[lang] = resolved
        _detected = result
        return dict(result)


def _reset_detection_cache() -> None:
    """Test hook: clear the cached detection result so the next
    `_detect_lsps()` call re-runs `shutil.which`."""
    global _detected
    with _detected_lock:
        _detected = None


# ============================================================
# LSP WIRE: Content-Length framed JSON-RPC 2.0
# ============================================================

def _write_lsp(stdin, msg: Dict[str, Any]) -> None:
    """Encode `msg` as JSON-RPC 2.0 with `Content-Length` framing per
    LSP spec and write it to `stdin`. `stdin` must accept bytes."""
    body = json.dumps(msg, separators=(',', ':')).encode('utf-8')
    header = f"Content-Length: {len(body)}\r\n\r\n".encode('ascii')
    stdin.write(header)
    stdin.write(body)
    stdin.flush()


def _read_lsp(stdout) -> Optional[Dict[str, Any]]:
    """Read one Content-Length-framed JSON-RPC message from `stdout`.

    Returns the decoded dict, or None on EOF / malformed framing.
    Headers are parsed line-by-line until a blank line; Content-Length
    is required, other headers (e.g. Content-Type) are tolerated and
    ignored."""
    content_length: Optional[int] = None
    while True:
        line = stdout.readline()
        if not line:
            return None
        # Lines end in \r\n; rstrip handles both \r\n and \n for robustness
        line = line.rstrip(b'\r\n')
        if line == b'':
            break
        if b':' not in line:
            # Malformed header; skip rather than crash
            continue
        name, _, value = line.partition(b':')
        if name.strip().lower() == b'content-length':
            try:
                content_length = int(value.strip())
            except ValueError:
                return None
    if content_length is None or content_length < 0:
        return None
    body = b''
    remaining = content_length
    while remaining > 0:
        chunk = stdout.read(remaining)
        if not chunk:
            return None
        body += chunk
        remaining -= len(chunk)
    try:
        return json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


# ============================================================
# LSP CLIENT (one subprocess per language)
# ============================================================

def _path_to_uri(path: str) -> str:
    """Convert an absolute filesystem path to a file:// URI per RFC 8089.
    Windows paths are out of scope (LSP servers we target are POSIX in
    Loki's supported envs); we still encode each path segment to handle
    spaces / unicode safely."""
    abs_path = os.path.abspath(path)
    # quote with safe="/" so directory separators stay intact.
    return 'file://' + quote(abs_path, safe='/')


class LSPClient:
    """Wraps a single LSP subprocess. One client per language per
    process. Not safe for concurrent use across threads on the same
    client without external locking; we serialize via `_lock`."""

    def __init__(self, language: str, binary_path: str, extra_args: List[str]):
        self.language = language
        self.binary_path = binary_path
        self.extra_args = list(extra_args)
        self.proc: Optional[subprocess.Popen] = None
        self._next_id = 1
        # v7.x staleness fix: track per-URI document version + on-disk mtime
        # (st_mtime_ns) instead of a plain "opened" set. On a second open of a
        # file whose mtime changed, we send textDocument/didChange with an
        # incremented version (full-sync) so the LSP re-analyzes the new
        # content; without this, did_open early-returned and every query (and
        # diagnostics) saw the first-open snapshot forever. mtime is used
        # (not a content hash) because it is content-independent: it always
        # bumps on save, sidestepping the same-size-edit blind spot that bit
        # the non-git codebase signature (see task #569).
        #   _doc_versions: uri -> last LSP document version we sent
        #   _doc_mtimes:   uri -> st_mtime_ns at the time we last (re)opened
        self._doc_versions: Dict[str, int] = {}
        self._doc_mtimes: Dict[str, int] = {}
        self._lock = threading.Lock()
        # v7.x async-safety fix: with handlers now offloaded to worker threads
        # (anyio.to_thread), two tool calls can run did_open()/request() in
        # parallel. _write_lsp() does write(header)+write(body)+flush(); if two
        # threads interleave there, the Content-Length framing on the LSP's
        # stdin is corrupted. _write_lock serializes ONLY the stdin write
        # sequences (and the did_open check-and-record), never the response
        # wait or the diagnostics poll, so concurrency is preserved everywhere
        # that matters.
        self._write_lock = threading.Lock()
        # v7.x async-safety fix: _next_request_id() is a read-modify-write on
        # _next_id. With handlers offloaded to worker threads, two concurrent
        # request() calls on the same-language client can allocate the SAME id
        # (the GIL can switch between the load and the store), which collides
        # in _response_queues -- one waiter is overwritten and hangs, or a
        # response is routed to the wrong caller. This leaf lock (it never
        # calls out while held, so no ordering concern with the other locks)
        # makes id allocation atomic.
        self._id_lock = threading.Lock()
        self._initialized = False
        # v7.7.14 LSP regression fix (was broken since v7.7.0):
        # publishDiagnostics notifications were dropped by request()'s
        # busy-read loop. Now a dedicated reader thread (spawned at end
        # of start()) owns proc.stdout, routes responses to per-request
        # Queues, and routes `textDocument/publishDiagnostics` into
        # `pending_diagnostics`. See docs/plans/UT2-6-LSP-DIAGNOSTIC-
        # BROADCAST.md section 3 for the prior root-cause analysis.
        self.pending_diagnostics: Dict[str, List[Dict[str, Any]]] = {}
        self._response_queues: Dict[int, "queue.Queue[Dict[str, Any]]"] = {}
        self._response_lock = threading.Lock()
        self._reader_thread: Optional[threading.Thread] = None
        self._reader_stop = threading.Event()

    def start(self) -> None:
        """Spawn the subprocess and perform the LSP `initialize` +
        `initialized` handshake. Idempotent: re-calling start() on an
        already-initialized client is a no-op. If the subprocess died,
        re-spawn cleanly: stop and join the previous reader thread first
        to avoid leaking threads against a dead pipe.
        """
        if self._initialized and self.proc and self.proc.poll() is None:
            return
        # v7.7.14 (Opus 2 council fix): re-spawn after crash must not leak
        # the previous reader thread. Signal stop + join with timeout, then
        # reset routing state so the new reader starts clean.
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_stop.set()
            # Close stale stdout to unblock the reader's _read_lsp() if any
            try:
                if self.proc and self.proc.stdout:
                    self.proc.stdout.close()
            except OSError:
                pass
            self._reader_thread.join(timeout=1.0)
            self._reader_thread = None
        # Drain any pending response waiters from the previous incarnation;
        # they would otherwise hang for the full request() timeout.
        with self._response_lock:
            for waiter in self._response_queues.values():
                try:
                    waiter.put_nowait({'error': {'message': 'LSP restarted; request abandoned'}})
                except queue.Full:
                    pass
            self._response_queues.clear()
        with self._lock:
            self.pending_diagnostics.clear()
        with self._write_lock:
            self._doc_versions.clear()
            self._doc_mtimes.clear()
        self._initialized = False
        cmd = [self.binary_path] + self.extra_args
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        # LSP `initialize` request. processId / rootUri / capabilities
        # are required by spec; capabilities={} signals "no extras",
        # which servers accept.
        root_uri = _path_to_uri(os.getcwd())
        init_id = self._next_request_id()
        _write_lsp(self.proc.stdin, {
            'jsonrpc': '2.0',
            'id': init_id,
            'method': 'initialize',
            'params': {
                'processId': os.getpid(),
                'rootUri': root_uri,
                'capabilities': {},
                'clientInfo': {
                    'name': 'loki-mode-lsp-proxy',
                    'version': '7.5.24',
                },
            },
        })
        # Read messages until we see the response to init_id; tolerate
        # interleaved notifications.
        deadline = time.time() + 10.0
        while time.time() < deadline:
            msg = _read_lsp(self.proc.stdout)
            if msg is None:
                break
            if msg.get('id') == init_id:
                break
        # `initialized` is a notification (no id, no response expected).
        _write_lsp(self.proc.stdin, {
            'jsonrpc': '2.0',
            'method': 'initialized',
            'params': {},
        })
        self._initialized = True
        # v7.7.14 fix: spawn the notification-reader thread AFTER the
        # synchronous initialize handshake completes. From this point on,
        # all reads from proc.stdout go through `_reader_loop`; request()
        # parks on a per-request Queue keyed by request id.
        self._reader_stop.clear()
        self._reader_thread = threading.Thread(
            target=self._reader_loop,
            name=f"lsp-reader-{self.language}",
            daemon=True,
        )
        self._reader_thread.start()
        _record_pid_to_disk(self.language, self.proc.pid)

    def _reader_loop(self) -> None:
        """v7.7.14 fix: dedicated reader thread that owns proc.stdout.
        Routes JSON-RPC responses to per-request Queues keyed by id;
        routes `textDocument/publishDiagnostics` notifications into
        `self.pending_diagnostics`. Exits cleanly on EOF or stop signal.

        v7.7.14 council fix (Opus 2): on exit, drain pending request
        waiters with an error sentinel so they fail fast instead of
        hanging for the full request() timeout. Log the exit reason so
        a silently-dead reader does not silently break the whole proxy.
        """
        exit_reason = "stop signal"
        try:
            while not self._reader_stop.is_set():
                try:
                    if not self.proc or not self.proc.stdout:
                        exit_reason = "proc/stdout missing"
                        break
                    msg = _read_lsp(self.proc.stdout)
                except Exception as exc:
                    exit_reason = f"read exception: {type(exc).__name__}: {exc}"
                    break
                if msg is None:
                    exit_reason = "EOF (subprocess closed stdout)"
                    break
                msg_id = msg.get('id')
                method = msg.get('method')
                if msg_id is not None and method is None:
                    # Response to a prior request: hand off to waiter
                    with self._response_lock:
                        waiter = self._response_queues.get(msg_id)
                    if waiter is not None:
                        try:
                            waiter.put_nowait(msg)
                        except queue.Full:
                            pass
                elif method == 'textDocument/publishDiagnostics':
                    params = msg.get('params') or {}
                    uri = params.get('uri')
                    diags = params.get('diagnostics') or []
                    if uri:
                        with self._lock:
                            self.pending_diagnostics[uri] = diags
                # Other notifications (window/logMessage, $/progress, etc.)
                # silently ignored. Server-to-client requests are not handled
                # (we declared no capabilities, so servers should not send any).
        finally:
            # Drain any outstanding request waiters with an error sentinel.
            # Without this, request() callers hang the full timeout (5s+) on
            # reader death; downstream tools surface as silent slow paths.
            with self._response_lock:
                waiters = list(self._response_queues.items())
                self._response_queues.clear()
            for rid, waiter in waiters:
                try:
                    waiter.put_nowait({'error': {
                        'message': f'LSP reader thread exited: {exit_reason}',
                        'request_id': rid,
                    }})
                except queue.Full:
                    pass
            try:
                logger.warning(
                    "LSP reader thread for language=%s exited: %s "
                    "(drained %d pending waiters)",
                    self.language, exit_reason, len(waiters),
                )
            except Exception:
                pass

    def _next_request_id(self) -> int:
        # Atomic id allocation: see _id_lock note in __init__. Called from
        # request() and shutdown(), which may run concurrently once handlers
        # are offloaded to worker threads.
        with self._id_lock:
            rid = self._next_id
            self._next_id += 1
            return rid

    def did_open(self, file_path: str) -> None:
        """Ensure the LSP has the CURRENT content of `file_path` open.

        First call for a URI: sends `textDocument/didOpen` at version 1 and
        records the file's on-disk mtime. Subsequent call for an already-open
        URI whose on-disk mtime CHANGED since the last (re)open: sends
        `textDocument/didChange` (full document sync) with an incremented
        version so the server re-analyzes the edited file, and clears any
        stale published diagnostics for that URI so the next poll waits for a
        fresh publish instead of returning the pre-edit snapshot. Unchanged
        files early-return (no redundant didChange), preserving the original
        no-op optimization.

        Reads file contents from disk; silently no-ops if the file is
        unreadable (a subsequent request will fail with a clean LSP error
        rather than crashing the proxy)."""
        uri = _path_to_uri(file_path)
        try:
            mtime = os.stat(file_path).st_mtime_ns
        except OSError:
            return
        # Fast path: already open and on-disk content unchanged since last
        # (re)open. No write, no lock contention beyond the dict read.
        with self._write_lock:
            prev_mtime = self._doc_mtimes.get(uri)
            already_open = uri in self._doc_versions
            if already_open and prev_mtime == mtime:
                return
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as fh:
                text = fh.read()
        except OSError:
            return
        lsp_id, _suffixes, _bin, _args = LANG_MAP[self.language]
        with self._write_lock:
            # Re-read under the lock so two racing threads agree on state.
            prev_version = self._doc_versions.get(uri)
            if prev_version is None:
                # First open of this URI.
                _write_lsp(self.proc.stdin, {
                    'jsonrpc': '2.0',
                    'method': 'textDocument/didOpen',
                    'params': {
                        'textDocument': {
                            'uri': uri,
                            'languageId': lsp_id,
                            'version': 1,
                            'text': text,
                        },
                    },
                })
                self._doc_versions[uri] = 1
                self._doc_mtimes[uri] = mtime
                return
            if self._doc_mtimes.get(uri) == mtime:
                # Another thread already refreshed to this mtime; nothing to do.
                return
            # File changed on disk since we last opened it: full-sync
            # didChange with an incremented version.
            new_version = prev_version + 1
            _write_lsp(self.proc.stdin, {
                'jsonrpc': '2.0',
                'method': 'textDocument/didChange',
                'params': {
                    'textDocument': {
                        'uri': uri,
                        'version': new_version,
                    },
                    'contentChanges': [{'text': text}],
                },
            })
            self._doc_versions[uri] = new_version
            self._doc_mtimes[uri] = mtime
        # Drop the stale published diagnostics for this URI (outside the
        # write lock, under _lock which guards pending_diagnostics) so that
        # lsp_get_diagnostics polls for the re-published set instead of
        # immediately returning the pre-edit snapshot.
        with self._lock:
            self.pending_diagnostics.pop(uri, None)

    def request(self, method: str, params: Dict[str, Any], timeout: float = 5.0) -> Dict[str, Any]:
        """Send a JSON-RPC request and block until its response arrives.

        v7.7.14: parks on a per-request Queue instead of reading stdout
        directly (which would race the reader thread). The reader thread
        spawned in start() routes responses to this Queue by request id.
        """
        rid = self._next_request_id()
        wait_q: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=1)
        with self._response_lock:
            self._response_queues[rid] = wait_q
        try:
            try:
                # Serialize the stdin write sequence against did_open() and
                # other concurrent request() calls so the Content-Length
                # framing is never interleaved. The lock is held ONLY for the
                # write, never across the wait below.
                with self._write_lock:
                    _write_lsp(self.proc.stdin, {
                        'jsonrpc': '2.0',
                        'id': rid,
                        'method': method,
                        'params': params,
                    })
            except (BrokenPipeError, OSError) as exc:
                return {'error': {'message': f'LSP I/O failure on write: {exc}'}}
            try:
                return wait_q.get(timeout=timeout)
            except queue.Empty:
                return {'error': {'message': f'LSP timeout after {timeout}s'}}
        finally:
            with self._response_lock:
                self._response_queues.pop(rid, None)

    def shutdown(self) -> None:
        """Send `shutdown` + `exit`, then SIGTERM after a 2s grace and
        SIGKILL after another 1s if still alive."""
        # v7.7.14: signal the reader thread to stop. It will also exit on
        # its own once proc.stdout closes (EOF), but the flag is belt-and-
        # suspenders for the kill path below.
        self._reader_stop.set()
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            # Serialize against concurrent request()/did_open() stdin writes
            # via _write_lock so the shutdown + exit frames are not interleaved
            # with another in-flight write. (Switched from _lock, which guards
            # pending_diagnostics, to the dedicated stdin write lock.)
            with self._write_lock:
                _write_lsp(self.proc.stdin, {
                    'jsonrpc': '2.0',
                    'id': self._next_request_id(),
                    'method': 'shutdown',
                    'params': None,
                })
                _write_lsp(self.proc.stdin, {
                    'jsonrpc': '2.0',
                    'method': 'exit',
                    'params': None,
                })
        except (BrokenPipeError, OSError):
            pass
        # Give the LSP 2s to exit on its own after `exit` notification.
        deadline = time.time() + 2.0
        while time.time() < deadline and self.proc.poll() is None:
            time.sleep(0.05)
        if self.proc.poll() is None:
            try:
                self.proc.terminate()
            except OSError:
                pass
            deadline = time.time() + 1.0
            while time.time() < deadline and self.proc.poll() is None:
                time.sleep(0.05)
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass


# ============================================================
# CLIENT REGISTRY (lazy spawn)
# ============================================================

_clients: Dict[str, LSPClient] = {}
_clients_lock = threading.Lock()


def _get_or_spawn_client(language: str) -> Optional[LSPClient]:
    """Return an initialized LSPClient for `language`, spawning it on
    first request. Returns None if the language's binary is absent
    (silent skip per spec)."""
    detected = _detect_lsps()
    if language not in detected:
        return None
    with _clients_lock:
        client = _clients.get(language)
        if client is not None and client.proc and client.proc.poll() is None:
            return client
        _lsp_id, _suffixes, _bin, extra_args = LANG_MAP[language]
        client = LSPClient(language, detected[language], extra_args)
    # start() acquires no shared lock; do it outside _clients_lock to
    # avoid holding the lock across a multi-second handshake.
    try:
        client.start()
    except (OSError, FileNotFoundError) as exc:
        logger.warning("LSP spawn failed for %s: %s", language, exc)
        return None
    with _clients_lock:
        # Double-check after re-acquiring: a concurrent first-call for the same
        # language (now reachable because handlers run in worker threads via
        # _to_thread) may have spawned and registered a live client while we
        # were handshaking. If so, keep the cached one and shut down our
        # duplicate so we never leak an orphaned LSP subprocess.
        existing = _clients.get(language)
        if existing is not None and existing.proc and existing.proc.poll() is None:
            losing = client
            client = existing
        else:
            losing = None
            _clients[language] = client
    if losing is not None:
        try:
            losing.shutdown()
        except Exception as exc:  # best-effort reap; never fail the caller
            logger.warning("LSP duplicate-client shutdown failed for %s: %s", language, exc)
    return client


# ============================================================
# PID PERSISTENCE (so `loki doctor` can reap stragglers)
# ============================================================

def _pids_file() -> Path:
    return Path.cwd() / '.loki' / 'lsp' / 'pids.json'


def _record_pid_to_disk(language: str, pid: int) -> None:
    """Append the language -> pid mapping to .loki/lsp/pids.json.
    Best-effort; failures to write are logged but never raised."""
    try:
        path = _pids_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        data: Dict[str, int] = {}
        if path.is_file():
            try:
                with open(path, 'r', encoding='utf-8') as fh:
                    data = json.load(fh) or {}
            except (json.JSONDecodeError, OSError):
                data = {}
        data[language] = pid
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
    except OSError as exc:
        logger.debug("Could not record PID for %s: %s", language, exc)


def _clear_pid_file() -> None:
    """Remove the PID file at process exit."""
    try:
        path = _pids_file()
        if path.is_file():
            path.unlink()
    except OSError:
        pass


# ============================================================
# CLEANUP (atexit)
# ============================================================

def _cleanup_all_clients() -> None:
    """atexit handler: shutdown every spawned LSPClient and clear the
    PID file. Safe to call multiple times."""
    with _clients_lock:
        clients = list(_clients.values())
        _clients.clear()
    for c in clients:
        try:
            c.shutdown()
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("Cleanup for %s raised: %s", c.language, exc)
    _clear_pid_file()


atexit.register(_cleanup_all_clients)


# ============================================================
# TOOL DISPATCH HELPER
# ============================================================

def _dispatch_lsp(file: str, line: int, character: int,
                  method: str, extra_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Route a tool call to the right LSP client and return a normalized
    response dict. Common error shapes (no language detected, no binary
    on PATH, LSP error) are returned as `{"error": "..."}`."""
    language = _suffix_to_language(file)
    if language is None:
        return {'error': f'Unsupported file type: {file}'}
    client = _get_or_spawn_client(language)
    if client is None:
        return {'error': f'No LSP detected for language: {language}'}
    try:
        client.did_open(file)
    except (BrokenPipeError, OSError) as exc:
        return {'error': f'LSP I/O failure on didOpen: {exc}'}
    params: Dict[str, Any] = {
        'textDocument': {'uri': _path_to_uri(file)},
        'position': {'line': int(line), 'character': int(character)},
    }
    if extra_params:
        params.update(extra_params)
    try:
        resp = client.request(method, params)
    except (BrokenPipeError, OSError) as exc:
        return {'error': f'LSP I/O failure on {method}: {exc}'}
    if 'error' in resp:
        err = resp['error']
        msg = err.get('message') if isinstance(err, dict) else str(err)
        return {'error': msg, 'language': language}
    return {'result': resp.get('result'), 'language': language}


# ============================================================
# FASTMCP LOADING
# ============================================================
# Task 566: the local `mcp/` package shadows the pip `mcp` SDK, which under
# MCP SDK 1.x (FastMCP shipped as a package DIRECTORY) makes a naive
# importlib.util load of mcp/server/fastmcp/__init__.py fail with
# `ModuleNotFoundError: No module named 'mcp.types'`. The previous loader
# here did exactly that and then SILENTLY degraded to a no-op shim, so the
# LSP tools never loaded for real consumers even with the SDK installed.
#
# The fix: reuse the SAME namespace-collision-resolving loader that
# mcp/server.py uses (now shared in mcp/_sdk_loader.py). Unlike server.py we
# do NOT sys.exit() when the SDK is genuinely absent -- we degrade to a no-op
# shim so the module imports cleanly under test, and production-without-SDK
# fails on `.run()` rather than at import time (silent-skip philosophy). But
# the degrade is now LOUD: one warning line naming the cause, never silent.
from mcp._sdk_loader import _load_real_fastmcp  # noqa: E402


class _NoopFastMCP:
    """Fallback used when the pip `mcp` SDK is not installed. Tool
    decorators become identity, run() raises a clear error."""

    def __init__(self, *args, **kwargs):
        pass

    def tool(self, *args, **kwargs):
        def deco(fn):
            return fn
        return deco

    def run(self, *args, **kwargs):
        raise RuntimeError(
            "MCP SDK (pip package 'mcp') not installed. "
            "Install with: pip install mcp"
        )


def _load_fastmcp():
    """Load the genuine pip MCP SDK's FastMCP via the shared loader, which
    resolves the local-vs-SDK `mcp` namespace collision under both SDK
    layouts. Returns the real FastMCP class on success, or `_NoopFastMCP`
    on a genuinely-absent SDK (so import never raises). The degrade path is
    LOUD: it logs one warning naming the cause rather than failing silently
    the way the old importlib.util shim did."""
    cls = _load_real_fastmcp()
    if cls is not None:
        return cls
    logger.warning(
        "MCP SDK (pip package 'mcp') not found or not importable; LSP proxy "
        "MCP server will not be runnable. Tools are registered against a "
        "no-op shim and mcp.run() will raise. Install with: "
        "pip install -r mcp/requirements.txt (or: pip install mcp)."
    )
    return _NoopFastMCP


FastMCP = _load_fastmcp()


# Read version from VERSION file
try:
    _version_path = os.path.join(os.path.dirname(__file__), '..', 'VERSION')
    with open(_version_path, 'r', encoding='utf-8') as _vf:
        _version = _vf.read().strip()
except Exception:
    _version = 'unknown'


def _build_lsp_fastmcp():
    """Instantiate FastMCP forwarding only the optional kwargs the installed
    SDK actually accepts. Mirrors mcp/server.py's _build_fastmcp: MCP SDK 1.x
    FastMCP.__init__ has no `version=`/`description=` parameters (it uses
    `instructions=`), so passing them unconditionally raises TypeError and
    the proxy never starts. We introspect the signature and forward only
    supported kwargs, keeping forward/backward compatibility. The no-op shim
    accepts any kwargs, so this is safe on the degrade path too."""
    import inspect
    _kwargs = {}
    try:
        _params = inspect.signature(FastMCP.__init__).parameters
    except (TypeError, ValueError):  # pragma: no cover - defensive
        _params = {}
    _desc = ('Loki Mode LSP proxy: find references, go to definition, '
             'symbol-at-position via on-PATH language servers.')
    if "instructions" in _params:
        _kwargs["instructions"] = _desc
    elif "description" in _params:
        _kwargs["description"] = _desc
    if "version" in _params:
        _kwargs["version"] = _version
    return FastMCP('loki-mode-lsp-proxy', **_kwargs)


mcp = _build_lsp_fastmcp()


# ============================================================
# MCP TOOL FUNCTIONS
# ============================================================

@mcp.tool()
async def lsp_find_references(file: str, line: int, character: int,
                              include_declaration: bool = False) -> str:
    """Find references to the symbol at the given file / line / character.

    Args:
        file: Absolute or cwd-relative path to the source file.
        line: 0-indexed line number (LSP convention).
        character: 0-indexed character offset within the line.
        include_declaration: If True, include the symbol declaration in
            results.

    Returns:
        JSON-encoded string. Success: {"result": [...], "language": ...}.
        Error: {"error": "..."}.
    """
    result = await _to_thread(
        _dispatch_lsp,
        file, line, character, 'textDocument/references',
        extra_params={'context': {'includeDeclaration': bool(include_declaration)}},
    )
    return json.dumps(result)


@mcp.tool()
async def lsp_go_to_definition(file: str, line: int, character: int) -> str:
    """Resolve the definition location for the symbol at file / line /
    character.

    Args:
        file: Absolute or cwd-relative path to the source file.
        line: 0-indexed line number.
        character: 0-indexed character offset within the line.

    Returns:
        JSON-encoded string with `result` (LSP Location | Location[] |
        LocationLink[]) on success or `error` on failure.
    """
    result = await _to_thread(
        _dispatch_lsp,
        file, line, character, 'textDocument/definition',
    )
    return json.dumps(result)


@mcp.tool()
async def lsp_symbol_at_position(file: str, line: int, character: int) -> str:
    """Return the hover / symbol info at the given file / line /
    character. Uses LSP `textDocument/hover` which returns a
    `MarkupContent` plus an optional range.

    Args:
        file: Absolute or cwd-relative path to the source file.
        line: 0-indexed line number.
        character: 0-indexed character offset within the line.

    Returns:
        JSON-encoded string with `result` (LSP Hover) on success or
        `error` on failure.
    """
    result = await _to_thread(
        _dispatch_lsp,
        file, line, character, 'textDocument/hover',
    )
    return json.dumps(result)


# ============================================================
# v7.7.0: agent-facing tool surface for grounding (no positional args)
# ============================================================
# These four tools are the high-value additions for v7.7.0. Unlike the
# position-based tools above, they let an agent ask intentional questions
# ("does this symbol exist?", "what's broken in this file?", "find me
# something matching this name") without first having to compute line +
# character offsets. This is the surface the planning-tier model wants.

def _resolve_workspace_root(file_or_dir: Optional[str] = None) -> str:
    """Return the workspace root for LSP queries. Prefers the project's
    git root, then the CWD. Used for workspace-scoped methods like
    workspace/symbol where no specific file is known."""
    start = os.path.abspath(file_or_dir or os.getcwd())
    if os.path.isfile(start):
        start = os.path.dirname(start)
    cur = start
    for _ in range(20):  # cap traversal
        if os.path.isdir(os.path.join(cur, '.git')):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return start


def _pick_language_for_workspace(root: str) -> Optional[str]:
    """Auto-detect the dominant workspace language from marker files.
    Returns the LANG_MAP key (python/typescript/etc.) or None."""
    markers = (
        ('package.json', 'typescript'),
        ('tsconfig.json', 'typescript'),
        ('Cargo.toml', 'rust'),
        ('go.mod', 'go'),
        ('pyproject.toml', 'python'),
        ('requirements.txt', 'python'),
        ('setup.py', 'python'),
    )
    for fname, lang in markers:
        if os.path.isfile(os.path.join(root, fname)):
            # Confirm we actually have an LSP for it
            if lang in _detect_lsps():
                return lang
    # Fallback: any installed LSP
    detected = _detect_lsps()
    if detected:
        return sorted(detected.keys())[0]
    return None


def _workspace_symbol_request(language: str, query: str, limit: int = 50) -> Dict[str, Any]:
    """Issue LSP workspace/symbol on a spawned client for `language`."""
    client = _get_or_spawn_client(language)
    if client is None:
        return {'error': f'No LSP detected for language: {language}'}
    try:
        resp = client.request('workspace/symbol', {'query': query})
    except (BrokenPipeError, OSError) as exc:
        return {'error': f'LSP I/O failure on workspace/symbol: {exc}', 'language': language}
    if 'error' in resp:
        err = resp['error']
        msg = err.get('message') if isinstance(err, dict) else str(err)
        return {'error': msg, 'language': language}
    result = resp.get('result') or []
    if not isinstance(result, list):
        return {'result': [], 'language': language}
    return {'result': result[:limit], 'language': language}


def _lsp_check_exists_blocking(symbol: str, kind: Optional[str] = None,
                               language: Optional[str] = None) -> str:
    """Blocking implementation of lsp_check_exists. Runs on a worker thread
    via _to_thread so the spawn handshake + workspace/symbol request never
    stall the MCP event loop."""
    import time as _t
    t0 = _t.perf_counter()
    if not symbol or not isinstance(symbol, str):
        return json.dumps({'error': 'symbol must be a non-empty string', 'exists': None})
    root = _resolve_workspace_root()
    lang = language or _pick_language_for_workspace(root)
    if lang is None:
        return json.dumps({
            'error': 'No language detected (no LSP server available on PATH for this workspace)',
            'exists': None,
            'hint': 'Install one of: pyright, typescript-language-server, gopls, rust-analyzer',
        })
    resp = _workspace_symbol_request(lang, symbol, limit=20)
    if 'error' in resp:
        return json.dumps({**resp, 'exists': None, 'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1)})
    matches = resp['result']
    # Optional kind filter (LSP SymbolKind: Function=12, Method=6, Class=5, Variable=13, etc.)
    if kind:
        kind_map = {
            'class': 5, 'method': 6, 'property': 7, 'function': 12,
            'variable': 13, 'constant': 14, 'enum': 10, 'interface': 11,
            'module': 2, 'namespace': 3, 'package': 4,
        }
        wanted = kind_map.get(kind.lower())
        if wanted is not None:
            matches = [m for m in matches if m.get('kind') == wanted]
    return json.dumps({
        'exists': len(matches) > 0,
        'matches': len(matches),
        'samples': [
            {
                'name': m.get('name'),
                'kind': m.get('kind'),
                'location': m.get('location', {}).get('uri'),
            } for m in matches[:5]
        ],
        'language': lang,
        'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1),
    })


@mcp.tool()
async def lsp_check_exists(symbol: str, kind: Optional[str] = None,
                           language: Optional[str] = None) -> str:
    """Cheap existence check for a symbol in the current workspace.

    The single most useful grounding primitive: an agent about to write
    `flightApi.getStatus()` should call `lsp_check_exists("getStatus")`
    first. If false, it means LSP could not find that name anywhere in
    the workspace; the agent should resolve via find / grep / read
    before writing the call.

    Args:
        symbol: Symbol name to look for (substring match per LSP spec).
        kind: Optional filter: 'function', 'class', 'method', 'variable',
            etc. If provided, only symbols whose LSP SymbolKind matches
            are counted.
        language: Optional language override. If None, auto-detected
            from workspace markers (package.json, requirements.txt, etc.).

    Returns:
        JSON-encoded string: {"exists": bool, "matches": N, "samples": [...],
        "language": "...", "elapsed_ms": float}. On no-LSP-available:
        {"error": "...", "exists": null}.
    """
    return await _to_thread(_lsp_check_exists_blocking, symbol, kind, language)


def _lsp_get_diagnostics_blocking(file: str) -> str:
    """Blocking implementation of lsp_get_diagnostics. Runs on a worker
    thread via _to_thread; the spawn handshake, didOpen/didChange and the
    ~1s diagnostics poll (time.sleep loop) must not stall the event loop."""
    import time as _t
    t0 = _t.perf_counter()
    abs_file = os.path.abspath(file)
    if not os.path.isfile(abs_file):
        return json.dumps({'error': f'File not found: {file}'})
    language = _suffix_to_language(abs_file)
    if language is None:
        return json.dumps({'error': f'Unsupported file type: {file}'})
    client = _get_or_spawn_client(language)
    if client is None:
        return json.dumps({
            'error': f'No LSP detected for language: {language}',
            'hint': f'Install the language server for {language}',
        })
    try:
        client.did_open(abs_file)
    except (BrokenPipeError, OSError) as exc:
        return json.dumps({'error': f'LSP I/O failure on didOpen: {exc}', 'language': language})
    # v7.7.14: reader thread populates client.pending_diagnostics on
    # textDocument/publishDiagnostics notifications. Poll for up to ~1s
    # (matches docstring "waits up to 1 second"). Pyright cold-pass on
    # a small file lands diagnostics in 100-400ms; gopls/rust-analyzer
    # vary. If the buffer never fills, return empty (no false errors).
    diagnostics: List[Dict[str, Any]] = []
    target_uri = _path_to_uri(abs_file)
    for _ in range(20):
        with client._lock:
            buf = client.pending_diagnostics
            if target_uri in buf:
                diagnostics = list(buf.get(target_uri) or [])
                break
        time.sleep(0.05)
    err_count = sum(1 for d in diagnostics if d.get('severity') == 1)
    warn_count = sum(1 for d in diagnostics if d.get('severity') == 2)
    return json.dumps({
        'diagnostics': diagnostics[:50],
        'count_errors': err_count,
        'count_warnings': warn_count,
        'language': language,
        'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1),
    })


@mcp.tool()
async def lsp_get_diagnostics(file: str) -> str:
    """Return current LSP diagnostics (errors + warnings) for a file.

    Diagnostics are published asynchronously by LSP servers via
    `textDocument/publishDiagnostics`. This tool opens the file (if not
    already open, or re-syncs it via didChange if edited since first open)
    and waits up to 1 second for diagnostics to arrive, then returns
    whatever has been published.

    Args:
        file: Absolute or cwd-relative path to the source file.

    Returns:
        JSON: {"diagnostics": [{severity, message, range, source}, ...],
        "count_errors": N, "count_warnings": M, "language": "...",
        "elapsed_ms": float}.
    """
    return await _to_thread(_lsp_get_diagnostics_blocking, file)


def _lsp_workspace_symbols_blocking(query: str, limit: int = 20,
                                    language: Optional[str] = None) -> str:
    """Blocking implementation of lsp_workspace_symbols. Runs on a worker
    thread via _to_thread (spawn handshake + workspace/symbol request)."""
    import time as _t
    t0 = _t.perf_counter()
    if not isinstance(query, str):
        return json.dumps({'error': 'query must be a string'})
    limit = max(1, min(int(limit or 20), 100))
    root = _resolve_workspace_root()
    lang = language or _pick_language_for_workspace(root)
    if lang is None:
        return json.dumps({
            'error': 'No language detected for workspace',
            'hint': 'Install pyright, typescript-language-server, gopls, or rust-analyzer',
        })
    resp = _workspace_symbol_request(lang, query, limit=limit)
    if 'error' in resp:
        return json.dumps({**resp, 'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1)})
    result = resp['result']
    return json.dumps({
        'matches': [
            {
                'name': m.get('name'),
                'kind': m.get('kind'),
                'container': m.get('containerName'),
                'location': m.get('location'),
            } for m in result
        ],
        'count': len(result),
        'language': lang,
        'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1),
    })


@mcp.tool()
async def lsp_workspace_symbols(query: str, limit: int = 20,
                                language: Optional[str] = None) -> str:
    """Fuzzy-search symbols across the entire workspace.

    Use when an agent is hunting for the right name (knows the
    function/class is about "config loading" but isn't sure of the
    actual identifier). Returns LSP workspace/symbol results scoped to
    the detected language (or the language override).

    Args:
        query: Symbol query (substring or fuzzy per LSP server impl).
        limit: Max results to return (default 20, hard cap 100).
        language: Optional language override.

    Returns:
        JSON: {"matches": [...], "count": N, "language": "...",
        "elapsed_ms": float}.
    """
    return await _to_thread(_lsp_workspace_symbols_blocking, query, limit, language)


def _lsp_find_definition_by_name_blocking(symbol: str,
                                          language: Optional[str] = None) -> str:
    """Blocking implementation of lsp_find_definition_by_name. Runs on a
    worker thread via _to_thread (spawn handshake + workspace/symbol)."""
    import time as _t
    t0 = _t.perf_counter()
    root = _resolve_workspace_root()
    lang = language or _pick_language_for_workspace(root)
    if lang is None:
        return json.dumps({
            'error': 'No language detected for workspace',
            'location': None,
        })
    resp = _workspace_symbol_request(lang, symbol, limit=5)
    if 'error' in resp:
        return json.dumps({**resp, 'location': None,
                           'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1)})
    matches = resp['result']
    if not matches:
        return json.dumps({
            'location': None,
            'name': None,
            'language': lang,
            'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1),
        })
    first = matches[0]
    return json.dumps({
        'location': first.get('location'),
        'name': first.get('name'),
        'kind': first.get('kind'),
        'language': lang,
        'elapsed_ms': round((_t.perf_counter() - t0) * 1000, 1),
    })


@mcp.tool()
async def lsp_find_definition_by_name(symbol: str,
                                      language: Optional[str] = None) -> str:
    """Find where a named symbol is defined, without needing a file
    position upfront. Convenience wrapper: runs workspace/symbol then
    returns the first result's location.

    Args:
        symbol: Symbol name to find.
        language: Optional language override.

    Returns:
        JSON: {"location": {uri, range} | null, "name": str | null,
        "language": "...", "elapsed_ms": float}.
    """
    return await _to_thread(_lsp_find_definition_by_name_blocking, symbol, language)


# ============================================================
# MAIN
# ============================================================

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(
        description='Loki Mode LSP Proxy MCP Server',
    )
    parser.add_argument(
        '--transport', choices=['stdio', 'http'], default='stdio',
        help='Transport mechanism (default: stdio).',
    )
    parser.add_argument(
        '--port', type=int, default=8422,
        help='Port for HTTP transport (default: 8422).',
    )
    args = parser.parse_args()
    # SIGTERM handler so docker stop / supervisord stop triggers cleanup
    # symmetrically to atexit. Re-raises via default handler so the
    # process actually exits.
    def _sigterm(_signum, _frame):
        _cleanup_all_clients()
        sys.exit(0)
    try:
        signal.signal(signal.SIGTERM, _sigterm)
    except (ValueError, OSError):
        # Some test runners install their own handlers; non-fatal.
        pass
    logger.info("Starting Loki Mode LSP proxy (transport: %s)", args.transport)
    detected = _detect_lsps()
    logger.info("Detected LSPs: %s", sorted(detected.keys()) or 'none')
    if args.transport == 'http':
        mcp.run(transport='http', port=args.port)
    else:
        mcp.run(transport='stdio')


if __name__ == '__main__':
    main()
