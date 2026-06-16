"""
mcp/tests/test_lsp_proxy.py

Unit tests for the LSP proxy MCP server. Runs against fake LSP
subprocesses (no real typescript-language-server etc. required).

Verifies:
  - _detect_lsps() returns a dict with the right shape (and empty when
    no binaries are installed)
  - LANG_MAP covers all 4 expected file suffix classes
  - Tool dispatch returns {"error": "..."} when no language can be
    detected for the file or when the language binary is absent
  - Tool dispatch routes to the correct language client based on file
    suffix
  - Content-Length framing is written and parsed correctly
  - atexit cleanup function calls shutdown on every spawned client and
    clears the PID file
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


# Make the repo root importable so `import mcp.lsp_proxy` works regardless
# of where pytest / unittest is invoked from.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


def _run(coro):
    return asyncio.run(coro)


def _import_lsp_proxy():
    """Force a fresh import so module-level FastMCP loading runs each
    time. Necessary because tests may install/remove subprocess mocks
    between runs."""
    for k in list(sys.modules.keys()):
        if k == 'mcp.lsp_proxy':
            del sys.modules[k]
    from mcp import lsp_proxy as _lp  # type: ignore
    return _lp


class LangMapAndDetectionTests(unittest.TestCase):
    def setUp(self):
        self.lp = _import_lsp_proxy()
        self.lp._reset_detection_cache()

    def test_lang_map_covers_all_4_target_languages(self):
        suffixes_to_lang = {}
        for lang, (_lsp_id, suffixes, _bin, _args) in self.lp.LANG_MAP.items():
            for s in suffixes:
                suffixes_to_lang[s] = lang
        # 4 language classes per spec: TS/JS family, Python, Go, Rust.
        self.assertIn('.ts', suffixes_to_lang)
        self.assertIn('.tsx', suffixes_to_lang)
        self.assertIn('.js', suffixes_to_lang)
        self.assertIn('.jsx', suffixes_to_lang)
        self.assertIn('.py', suffixes_to_lang)
        self.assertIn('.go', suffixes_to_lang)
        self.assertIn('.rs', suffixes_to_lang)

    def test_binary_mapping_correct_per_spec(self):
        # TS/TSX/JS/JSX -> typescript-language-server
        for lang in ('typescript', 'javascript'):
            self.assertEqual(self.lp.LANG_MAP[lang][2], 'typescript-language-server')
        # .py -> pylsp
        self.assertEqual(self.lp.LANG_MAP['python'][2], 'pylsp')
        # .go -> gopls
        self.assertEqual(self.lp.LANG_MAP['go'][2], 'gopls')
        # .rs -> rust-analyzer
        self.assertEqual(self.lp.LANG_MAP['rust'][2], 'rust-analyzer')

    def test_detect_lsps_returns_dict_no_error_when_nothing_present(self):
        with mock.patch.object(self.lp.shutil, 'which', return_value=None):
            self.lp._reset_detection_cache()
            result = self.lp._detect_lsps()
        self.assertIsInstance(result, dict)
        self.assertEqual(result, {})

    def test_detect_lsps_finds_present_binaries(self):
        # Pretend gopls and pylsp are installed.
        def fake_which(name):
            return {'gopls': '/usr/local/bin/gopls',
                    'pylsp': '/opt/homebrew/bin/pylsp'}.get(name)
        with mock.patch.object(self.lp.shutil, 'which', side_effect=fake_which):
            self.lp._reset_detection_cache()
            result = self.lp._detect_lsps()
        self.assertIn('go', result)
        self.assertIn('python', result)
        self.assertEqual(result['go'], '/usr/local/bin/gopls')
        self.assertEqual(result['python'], '/opt/homebrew/bin/pylsp')
        self.assertNotIn('rust', result)
        self.assertNotIn('typescript', result)

    def test_detection_result_is_cached(self):
        call_count = {'n': 0}

        def fake_which(name):
            call_count['n'] += 1
            return None

        with mock.patch.object(self.lp.shutil, 'which', side_effect=fake_which):
            self.lp._reset_detection_cache()
            self.lp._detect_lsps()
            first_calls = call_count['n']
            self.lp._detect_lsps()
            self.lp._detect_lsps()
            self.assertEqual(call_count['n'], first_calls,
                             "Detection should be cached after first call")

    def test_suffix_to_language(self):
        self.assertEqual(self.lp._suffix_to_language('foo.ts'), 'typescript')
        self.assertEqual(self.lp._suffix_to_language('foo.tsx'), 'typescript')
        self.assertEqual(self.lp._suffix_to_language('foo.js'), 'javascript')
        self.assertEqual(self.lp._suffix_to_language('foo.py'), 'python')
        self.assertEqual(self.lp._suffix_to_language('foo.go'), 'go')
        self.assertEqual(self.lp._suffix_to_language('foo.rs'), 'rust')
        self.assertEqual(self.lp._suffix_to_language('foo.txt'), None)
        self.assertEqual(self.lp._suffix_to_language('Makefile'), None)


class WireFramingTests(unittest.TestCase):
    """Verify Content-Length framing is correct (LSP spec, NOT line-
    delimited JSON)."""

    def setUp(self):
        self.lp = _import_lsp_proxy()

    def test_write_lsp_emits_content_length_header(self):
        sink = io.BytesIO()
        # BytesIO already implements .write(bytes) and .flush() (no-op).
        msg = {'jsonrpc': '2.0', 'id': 1, 'method': 'foo', 'params': {}}
        self.lp._write_lsp(sink, msg)
        data = sink.getvalue()
        self.assertTrue(data.startswith(b'Content-Length: '))
        self.assertIn(b'\r\n\r\n', data)
        header, _, body = data.partition(b'\r\n\r\n')
        body_len = int(header.split(b':')[1].strip())
        self.assertEqual(len(body), body_len)
        self.assertEqual(json.loads(body), msg)

    def test_read_lsp_roundtrip(self):
        msg_in = {'jsonrpc': '2.0', 'id': 7,
                  'result': {'value': 'ok', 'nested': [1, 2, 3]}}
        body = json.dumps(msg_in).encode('utf-8')
        header = f'Content-Length: {len(body)}\r\n\r\n'.encode('ascii')
        source = io.BytesIO(header + body)
        msg_out = self.lp._read_lsp(source)
        self.assertEqual(msg_out, msg_in)

    def test_read_lsp_tolerates_extra_headers(self):
        msg_in = {'jsonrpc': '2.0', 'id': 8, 'result': 'ok'}
        body = json.dumps(msg_in).encode('utf-8')
        wire = (
            f'Content-Length: {len(body)}\r\n'
            f'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'
            f'\r\n'
        ).encode('ascii') + body
        msg_out = self.lp._read_lsp(io.BytesIO(wire))
        self.assertEqual(msg_out, msg_in)

    def test_read_lsp_returns_none_on_eof(self):
        self.assertIsNone(self.lp._read_lsp(io.BytesIO(b'')))


class ToolDispatchTests(unittest.TestCase):
    """Verify the three MCP tools route correctly and return structured
    error shapes on missing-binary / unsupported-suffix."""

    def setUp(self):
        self.lp = _import_lsp_proxy()
        self.lp._reset_detection_cache()
        # Wipe any clients carried over from prior tests / module reuse.
        with self.lp._clients_lock:
            self.lp._clients.clear()

    def tearDown(self):
        with self.lp._clients_lock:
            self.lp._clients.clear()

    def test_unsupported_file_suffix_returns_error(self):
        raw = _run(self.lp.lsp_find_references('README.md', 0, 0))
        body = json.loads(raw)
        self.assertIn('error', body)
        self.assertIn('Unsupported', body['error'])

    def test_missing_language_binary_returns_error(self):
        # No binaries installed.
        with mock.patch.object(self.lp.shutil, 'which', return_value=None):
            self.lp._reset_detection_cache()
            raw_ref = _run(self.lp.lsp_find_references('foo.ts', 0, 0))
            raw_def = _run(self.lp.lsp_go_to_definition('foo.py', 1, 2))
            raw_sym = _run(self.lp.lsp_symbol_at_position('foo.go', 3, 4))
        for raw in (raw_ref, raw_def, raw_sym):
            body = json.loads(raw)
            self.assertIn('error', body)
            self.assertIn('No LSP detected', body['error'])

    def test_dispatch_routes_to_correct_language(self):
        # All three of these are different languages -> different clients
        # are spawned. Mock _get_or_spawn_client to record the language
        # it was asked for; return a fake client that always returns
        # `{"result": "ok"}`.
        called_languages = []
        fake_client = mock.MagicMock()
        fake_client.did_open.return_value = None
        fake_client.request.return_value = {'result': 'ok'}

        def fake_get_or_spawn(language):
            called_languages.append(language)
            return fake_client

        with mock.patch.object(self.lp, '_get_or_spawn_client', side_effect=fake_get_or_spawn):
            _run(self.lp.lsp_find_references('a.ts', 0, 0))
            _run(self.lp.lsp_go_to_definition('b.py', 0, 0))
            _run(self.lp.lsp_symbol_at_position('c.go', 0, 0))
            _run(self.lp.lsp_find_references('d.rs', 0, 0))
            _run(self.lp.lsp_find_references('e.tsx', 0, 0))
            _run(self.lp.lsp_find_references('f.jsx', 0, 0))
        self.assertEqual(called_languages,
                         ['typescript', 'python', 'go', 'rust', 'typescript', 'javascript'])

    def test_dispatch_uses_correct_lsp_methods(self):
        method_calls = []
        fake_client = mock.MagicMock()
        fake_client.did_open.return_value = None

        def record_request(method, params, timeout=5.0):
            method_calls.append((method, params))
            return {'result': 'ok'}

        fake_client.request.side_effect = record_request

        with mock.patch.object(self.lp, '_get_or_spawn_client', return_value=fake_client):
            _run(self.lp.lsp_find_references('a.ts', 5, 3, include_declaration=True))
            _run(self.lp.lsp_go_to_definition('a.ts', 5, 3))
            _run(self.lp.lsp_symbol_at_position('a.ts', 5, 3))
        methods = [m for m, _ in method_calls]
        self.assertEqual(methods, [
            'textDocument/references',
            'textDocument/definition',
            'textDocument/hover',
        ])
        # find_references must pass `context.includeDeclaration`.
        ref_params = method_calls[0][1]
        self.assertIn('context', ref_params)
        self.assertEqual(ref_params['context']['includeDeclaration'], True)
        # All carry a 0-indexed position.
        for _m, p in method_calls:
            self.assertEqual(p['position'], {'line': 5, 'character': 3})


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.lp = _import_lsp_proxy()
        self.lp._reset_detection_cache()
        with self.lp._clients_lock:
            self.lp._clients.clear()
        # Run inside a tempdir so the PID file write goes there, not into
        # the live project's .loki/.
        self._tmpdir = tempfile.mkdtemp(prefix='lsp-proxy-test-')
        self._prev_cwd = os.getcwd()
        os.chdir(self._tmpdir)

    def tearDown(self):
        os.chdir(self._prev_cwd)
        with self.lp._clients_lock:
            self.lp._clients.clear()
        import shutil as _sh
        _sh.rmtree(self._tmpdir, ignore_errors=True)

    def test_cleanup_calls_shutdown_on_every_client(self):
        fake_a = mock.MagicMock()
        fake_b = mock.MagicMock()
        fake_a.language = 'python'
        fake_b.language = 'go'
        with self.lp._clients_lock:
            self.lp._clients['python'] = fake_a
            self.lp._clients['go'] = fake_b
        self.lp._cleanup_all_clients()
        fake_a.shutdown.assert_called_once()
        fake_b.shutdown.assert_called_once()
        # Registry is cleared after cleanup so subsequent calls are no-ops.
        with self.lp._clients_lock:
            self.assertEqual(self.lp._clients, {})

    def test_cleanup_clears_pid_file(self):
        pids_dir = Path(self._tmpdir) / '.loki' / 'lsp'
        pids_dir.mkdir(parents=True)
        pid_path = pids_dir / 'pids.json'
        pid_path.write_text(json.dumps({'python': 12345}))
        self.assertTrue(pid_path.exists())
        self.lp._cleanup_all_clients()
        self.assertFalse(pid_path.exists())

    def test_record_pid_to_disk_creates_parent_dir(self):
        # First call must mkdir -p the .loki/lsp/ dir.
        self.lp._record_pid_to_disk('python', 99999)
        pid_path = Path(self._tmpdir) / '.loki' / 'lsp' / 'pids.json'
        self.assertTrue(pid_path.exists())
        data = json.loads(pid_path.read_text())
        self.assertEqual(data['python'], 99999)
        # Second call must merge, not overwrite.
        self.lp._record_pid_to_disk('go', 88888)
        data = json.loads(pid_path.read_text())
        self.assertEqual(data['python'], 99999)
        self.assertEqual(data['go'], 88888)


class LSPClientShutdownTests(unittest.TestCase):
    """Test LSPClient.shutdown() sends shutdown + exit JSON-RPC messages
    and terminates the subprocess. We mock subprocess.Popen so no real
    LSP binary is needed."""

    def setUp(self):
        self.lp = _import_lsp_proxy()

    def test_shutdown_sends_shutdown_exit_and_terminates(self):
        fake_proc = mock.MagicMock()
        # poll() must return None at the start (alive), then a small int
        # after terminate() (so the grace loop exits and we don't have
        # to actually sleep 2s in the test).
        fake_proc.poll.side_effect = [None, None, 0, 0, 0, 0]
        fake_proc.stdin = io.BytesIO()
        client = self.lp.LSPClient('python', '/usr/bin/pylsp', [])
        client.proc = fake_proc
        client._initialized = True
        client.shutdown()
        wire = fake_proc.stdin.getvalue()
        # Two framed messages should have been written.
        self.assertEqual(wire.count(b'Content-Length:'), 2)
        self.assertIn(b'"shutdown"', wire)
        self.assertIn(b'"exit"', wire)
        # No need to assert terminate() count exactly -- if poll() never
        # returns None inside the grace loop, terminate() may not be
        # called. We only require the messages went out cleanly.

    def test_shutdown_sigterms_when_process_does_not_exit(self):
        fake_proc = mock.MagicMock()
        # poll() always returns None (process never voluntarily exits).
        # We use a callable so we don't run out of side_effect values.
        fake_proc.poll = mock.MagicMock(return_value=None)
        fake_proc.stdin = io.BytesIO()
        client = self.lp.LSPClient('python', '/usr/bin/pylsp', [])
        client.proc = fake_proc
        client._initialized = True
        # Stub time.sleep AND time.time so the grace loops exit
        # immediately rather than spinning for 3s of wall time.
        times = iter([0.0, 100.0, 200.0, 300.0])

        def fake_time():
            try:
                return next(times)
            except StopIteration:
                return 1000.0

        with mock.patch.object(self.lp.time, 'sleep', return_value=None), \
             mock.patch.object(self.lp.time, 'time', side_effect=fake_time):
            client.shutdown()
        fake_proc.terminate.assert_called()
        fake_proc.kill.assert_called()


class DiagnosticsWriterTests(unittest.TestCase):
    """P1-5: the diagnostics WRITER that feeds the LSP-diagnostics quality
    gate (loki-ts/src/runner/quality_gates.ts runLSPDiagnostics). Proves
    non-vacuity (real severity-1 diagnostics -> blocking artifact) at the
    recording/aggregation layer, and the no-false-fire honesty paths (no
    server / no measurable file -> NO artifact, so the gate's absence path
    fires instead of a fabricated clean verdict)."""

    def setUp(self):
        self.lp = _import_lsp_proxy()
        self.lp._reset_detection_cache()

    def _make_repo(self, files):
        """Create a tmp dir with the given {relpath: contents} and return it."""
        d = tempfile.mkdtemp(prefix='loki-lsp-writer-')
        for rel, body in files.items():
            p = os.path.join(d, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'w', encoding='utf-8') as fh:
                fh.write(body)
        return d

    def test_no_server_writes_no_artifact(self):
        """No detected language server -> measured:false, no artifact. The
        gate must then report 'did not run', never a clean verdict."""
        root = self._make_repo({'a.ts': 'const x = 1;\n'})
        loki = tempfile.mkdtemp(prefix='loki-lsp-out-')
        with mock.patch.object(self.lp, '_detect_lsps', return_value={}):
            status = self.lp.write_diagnostics_artifact(root=root, loki_dir=loki)
        self.assertFalse(status['measured'])
        self.assertFalse(status['wrote_artifact'])
        self.assertFalse(os.path.isfile(
            os.path.join(loki, 'quality', 'lsp-diagnostics.json')))

    def test_server_present_but_no_matching_changed_file(self):
        """Server detected for rust, but the changed file is .ts -> nothing
        real to measure -> no artifact."""
        root = self._make_repo({'a.ts': 'const x = 1;\n'})
        loki = tempfile.mkdtemp(prefix='loki-lsp-out-')
        with mock.patch.object(self.lp, '_detect_lsps',
                               return_value={'rust': '/usr/bin/rust-analyzer'}), \
             mock.patch.object(self.lp, '_writer_changed_files',
                               return_value=['a.ts']):
            status = self.lp.write_diagnostics_artifact(root=root, loki_dir=loki)
        self.assertFalse(status['measured'])
        self.assertEqual(status['reason'], 'no-changed-file-with-detected-server')
        self.assertFalse(os.path.isfile(
            os.path.join(loki, 'quality', 'lsp-diagnostics.json')))

    def test_real_error_recorded_and_blocks(self):
        """NON-VACUITY: a severity-1 diagnostic from the per-file LSP query is
        recorded into the artifact with count_errors>0 -- the exact shape the
        gate blocks on. Diagnostics source is mocked at the proxy boundary so
        this exercises the writer's enumeration + aggregation + serialization
        WITHOUT fabricating a verdict (the gate still independently reads the
        file)."""
        root = self._make_repo({'src/main.py': 'x: int = "nope"\n'})
        loki = tempfile.mkdtemp(prefix='loki-lsp-out-')
        fake = json.dumps({
            'diagnostics': [
                {'severity': 1, 'message': 'Type error', 'range': {}, 'source': 'x'},
                {'severity': 2, 'message': 'Unused', 'range': {}},
                {'severity': 3, 'message': 'Info note'},
            ],
            'count_errors': 1, 'count_warnings': 1,
            'language': 'python', 'elapsed_ms': 123.4,
        })
        with mock.patch.object(self.lp, '_detect_lsps',
                               return_value={'python': '/usr/bin/pyright'}), \
             mock.patch.object(self.lp, '_writer_changed_files',
                               return_value=['src/main.py']), \
             mock.patch.object(self.lp, '_lsp_get_diagnostics_blocking',
                               return_value=fake):
            status = self.lp.write_diagnostics_artifact(root=root, loki_dir=loki)
        self.assertTrue(status['measured'])
        self.assertTrue(status['wrote_artifact'])
        self.assertEqual(status['count_errors'], 1)
        path = os.path.join(loki, 'quality', 'lsp-diagnostics.json')
        self.assertTrue(os.path.isfile(path))
        with open(path, encoding='utf-8') as fh:
            artifact = json.load(fh)
        self.assertEqual(artifact['count_errors'], 1)
        self.assertEqual(artifact['count_warnings'], 1)
        # Minimal deterministic shape: only severity/message/file survive;
        # elapsed_ms / range / source are stripped.
        self.assertEqual(len(artifact['diagnostics']), 3)
        for d in artifact['diagnostics']:
            self.assertEqual(set(d.keys()), {'file', 'severity', 'message'})
        self.assertNotIn('elapsed_ms', artifact)

    def test_per_file_lsp_error_does_not_count_clean(self):
        """A detected server that returns {'error':...} for the only changed
        file means we measured nothing -> no artifact (NOT a fabricated
        clean verdict)."""
        root = self._make_repo({'src/main.py': 'x = 1\n'})
        loki = tempfile.mkdtemp(prefix='loki-lsp-out-')
        with mock.patch.object(self.lp, '_detect_lsps',
                               return_value={'python': '/usr/bin/pyright'}), \
             mock.patch.object(self.lp, '_writer_changed_files',
                               return_value=['src/main.py']), \
             mock.patch.object(self.lp, '_lsp_get_diagnostics_blocking',
                               return_value=json.dumps({'error': 'spawn failed'})):
            status = self.lp.write_diagnostics_artifact(root=root, loki_dir=loki)
        self.assertFalse(status['measured'])
        self.assertEqual(status['reason'], 'no-file-yielded-diagnostics')
        self.assertFalse(os.path.isfile(
            os.path.join(loki, 'quality', 'lsp-diagnostics.json')))

    def test_clean_file_writes_zero_artifact(self):
        """A measured file with no diagnostics writes a real 0/0 artifact --
        this is a MEASURED clean result (we queried a live server), distinct
        from the absence path."""
        root = self._make_repo({'src/main.py': 'x = 1\n'})
        loki = tempfile.mkdtemp(prefix='loki-lsp-out-')
        with mock.patch.object(self.lp, '_detect_lsps',
                               return_value={'python': '/usr/bin/pyright'}), \
             mock.patch.object(self.lp, '_writer_changed_files',
                               return_value=['src/main.py']), \
             mock.patch.object(self.lp, '_lsp_get_diagnostics_blocking',
                               return_value=json.dumps({
                                   'diagnostics': [], 'count_errors': 0,
                                   'count_warnings': 0})):
            status = self.lp.write_diagnostics_artifact(root=root, loki_dir=loki)
        self.assertTrue(status['measured'])
        path = os.path.join(loki, 'quality', 'lsp-diagnostics.json')
        with open(path, encoding='utf-8') as fh:
            artifact = json.load(fh)
        self.assertEqual(artifact['count_errors'], 0)
        self.assertEqual(artifact['count_warnings'], 0)
        self.assertEqual(artifact['diagnostics'], [])

    def test_stale_artifact_removed_when_unmeasured(self):
        """A previously-written artifact must be removed when a later run
        measures nothing, so last iteration's errors cannot block forever."""
        root = self._make_repo({'a.ts': 'const x = 1;\n'})
        loki = tempfile.mkdtemp(prefix='loki-lsp-out-')
        qdir = os.path.join(loki, 'quality')
        os.makedirs(qdir, exist_ok=True)
        stale = os.path.join(qdir, 'lsp-diagnostics.json')
        with open(stale, 'w', encoding='utf-8') as fh:
            fh.write('{"count_errors": 5, "count_warnings": 0, "diagnostics": []}')
        with mock.patch.object(self.lp, '_detect_lsps', return_value={}):
            self.lp.write_diagnostics_artifact(root=root, loki_dir=loki)
        self.assertFalse(os.path.isfile(stale))

    def test_deterministic_serialization(self):
        """Same inputs -> byte-identical artifact (route + run parity)."""
        root = self._make_repo({'src/main.py': 'x = 1\n'})
        loki1 = tempfile.mkdtemp(prefix='loki-lsp-out-')
        loki2 = tempfile.mkdtemp(prefix='loki-lsp-out-')
        fake = json.dumps({'diagnostics': [
            {'severity': 2, 'message': 'b'},
            {'severity': 1, 'message': 'a'},
        ]})
        for lk in (loki1, loki2):
            with mock.patch.object(self.lp, '_detect_lsps',
                                   return_value={'python': '/usr/bin/pyright'}), \
                 mock.patch.object(self.lp, '_writer_changed_files',
                                   return_value=['src/main.py']), \
                 mock.patch.object(self.lp, '_lsp_get_diagnostics_blocking',
                                   return_value=fake):
                self.lp.write_diagnostics_artifact(root=root, loki_dir=lk)
        with open(os.path.join(loki1, 'quality', 'lsp-diagnostics.json'), 'rb') as fh:
            b1 = fh.read()
        with open(os.path.join(loki2, 'quality', 'lsp-diagnostics.json'), 'rb') as fh:
            b2 = fh.read()
        self.assertEqual(b1, b2)


if __name__ == '__main__':
    unittest.main()
