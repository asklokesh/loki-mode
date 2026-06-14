"""
tests/mcp/test_lsp_spawn_race.py

Regression test for the concurrent-spawn race in
mcp.lsp_proxy._get_or_spawn_client (v7.42.0).

Before the fix, _get_or_spawn_client used double-checked locking but called
LSPClient.start() OUTSIDE _clients_lock. Once the @mcp.tool() handlers began
running in worker threads (via _to_thread), two concurrent first-calls for the
SAME language could both miss the cache, both spawn a subprocess, and the loser
would be overwritten in the _clients dict and leak (an orphaned LSP process that
atexit would not reap because its dict entry was gone).

The fix re-checks the cache after re-acquiring the lock and, if another thread
already registered a live client, keeps that one and shuts down the just-spawned
duplicate. This test drives two threads through _get_or_spawn_client with a fake
client whose start() blocks briefly (to force the overlap) and asserts:
  (a) both callers get the SAME client object (the winner);
  (b) exactly one client remains registered in _clients;
  (c) the losing duplicate had shutdown() called on it (no leak).

No real subprocess or language server is used.
"""

from __future__ import annotations

import threading
import time
import unittest

import mcp.lsp_proxy as lp


class _FakeProc:
    def poll(self):
        return None  # always "alive"


class _FakeClient:
    instances = []

    def __init__(self, language, *args, **kwargs):
        self.language = language
        self.proc = None
        self.shutdown_called = False
        self.started = False
        _FakeClient.instances.append(self)

    def start(self):
        # Block long enough that a second thread entering before this returns
        # also misses the cache and spawns its own client (forces the race).
        time.sleep(0.15)
        self.proc = _FakeProc()
        self.started = True

    def shutdown(self):
        self.shutdown_called = True
        self.proc = None


class ConcurrentSpawnTest(unittest.TestCase):
    def setUp(self):
        self._orig_clients = dict(lp._clients)
        self._orig_client_cls = lp.LSPClient
        self._orig_detect = lp._detect_lsps
        self._orig_lang_map = dict(lp.LANG_MAP)
        lp._clients.clear()
        _FakeClient.instances = []
        lp.LSPClient = _FakeClient
        # Pretend the language server binary is present.
        lp._detect_lsps = lambda: {"python": "/usr/bin/fake-pyls"}
        if "python" not in lp.LANG_MAP:
            lp.LANG_MAP["python"] = ("pyls", (".py",), "fake-pyls", [])

    def tearDown(self):
        lp._clients.clear()
        lp._clients.update(self._orig_clients)
        lp.LSPClient = self._orig_client_cls
        lp._detect_lsps = self._orig_detect
        lp.LANG_MAP.clear()
        lp.LANG_MAP.update(self._orig_lang_map)

    def test_concurrent_first_calls_do_not_leak_duplicate(self):
        results = {}

        def worker(idx):
            results[idx] = lp._get_or_spawn_client("python")

        t1 = threading.Thread(target=worker, args=(0,))
        t2 = threading.Thread(target=worker, args=(1,))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        c0, c1 = results[0], results[1]
        # (a) both callers get the same surviving client.
        self.assertIsNotNone(c0)
        self.assertIs(c0, c1)
        # (b) exactly one client registered for the language.
        self.assertIs(lp._clients["python"], c0)
        # (c) the race spawned two clients; the loser was shut down, the winner not.
        spawned = _FakeClient.instances
        self.assertEqual(len(spawned), 2, "expected the race to spawn two clients")
        survivors = [c for c in spawned if not c.shutdown_called]
        losers = [c for c in spawned if c.shutdown_called]
        self.assertEqual(len(survivors), 1, "exactly one client must survive")
        self.assertEqual(len(losers), 1, "the duplicate must be shut down (no leak)")
        self.assertIs(survivors[0], c0)

    def test_cached_live_client_is_reused_without_spawn(self):
        first = lp._get_or_spawn_client("python")
        before = len(_FakeClient.instances)
        second = lp._get_or_spawn_client("python")
        self.assertIs(first, second)
        # No new client spawned when a live one is cached.
        self.assertEqual(len(_FakeClient.instances), before)


if __name__ == "__main__":
    unittest.main()
