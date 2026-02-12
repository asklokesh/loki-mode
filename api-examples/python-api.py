#!/usr/bin/env python3
"""
Minimal HTTP API for loki-mode
Zero pip dependencies - uses only Python stdlib
Usage: python3 api-examples/python-api.py
"""

import asyncio
import json
import os
import signal
import subprocess
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get('LOKI_DASHBOARD_PORT', 57374))
LOKI_DIR = Path(os.environ.get('LOKI_DIR', Path.home() / '.loki'))
STATE_DIR = LOKI_DIR / 'state'

# Ensure state directory exists
STATE_DIR.mkdir(parents=True, exist_ok=True)

# SSE clients (for async version)
sse_clients = set()


def read_file(filepath: Path) -> str:
    """Read file safely, return empty string on error."""
    try:
        return filepath.read_text().strip()
    except (FileNotFoundError, PermissionError):
        return ''


def is_running(pid: int) -> bool:
    """Check if a process is running."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def get_status() -> dict:
    """Get current loki status."""
    pid_str = read_file(STATE_DIR / 'session.pid')
    state = 'stopped'

    if pid_str:
        try:
            if is_running(int(pid_str)):
                state = 'paused' if (STATE_DIR / 'paused').exists() else 'running'
        except ValueError:
            pass

    return {
        'state': state,
        'project': read_file(STATE_DIR / 'current_project'),
        'task': read_file(STATE_DIR / 'current_task'),
        'provider': read_file(STATE_DIR / 'provider') or 'claude',
        'timestamp': datetime.now(timezone.utc).isoformat()
    }


class LokiAPIHandler(BaseHTTPRequestHandler):
    """HTTP request handler for loki-mode API."""

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def send_json(self, data: dict, status: int = 200):
        """Send JSON response."""
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == '/health':
            self.send_json({'status': 'ok'})

        elif path == '/status':
            self.send_json(get_status())

        elif path == '/events':
            # Server-Sent Events
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            # Send initial status
            data = json.dumps(get_status())
            self.wfile.write(f'data: {data}\n\n'.encode())
            self.wfile.flush()

            # Keep connection open (simple polling approach)
            try:
                while True:
                    asyncio.get_event_loop().run_until_complete(asyncio.sleep(5))
                    data = json.dumps(get_status())
                    self.wfile.write(f'data: {data}\n\n'.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif path == '/logs':
            lines = int(query.get('lines', [50])[0])
            log_file = LOKI_DIR / 'logs' / 'session.log'

            if log_file.exists():
                content = log_file.read_text()
                all_lines = content.strip().split('\n')
                logs = all_lines[-lines:]
            else:
                logs = []

            self.send_json({'logs': logs})

        else:
            self.send_json({'error': 'not found'}, 404)

    def do_POST(self):
        """Handle POST requests."""
        path = urlparse(self.path).path

        # Read body
        content_length = int(self.headers.get('Content-Length', 0))
        body = {}
        if content_length > 0:
            try:
                body = json.loads(self.rfile.read(content_length))
            except json.JSONDecodeError:
                pass

        if path == '/start':
            prd = body.get('prd', '')
            provider = body.get('provider', 'claude')

            run_script = Path.cwd() / 'autonomy' / 'run.sh'
            if not run_script.exists():
                self.send_json({'error': 'run.sh not found'}, 500)
                return

            args = [str(run_script), '--provider', provider]
            if prd:
                args.append(prd)

            proc = subprocess.Popen(
                args,
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )

            (STATE_DIR / 'session.pid').write_text(str(proc.pid))
            (STATE_DIR / 'provider').write_text(provider)

            self.send_json({'started': True, 'pid': proc.pid})

        elif path == '/stop':
            pid_str = read_file(STATE_DIR / 'session.pid')

            if pid_str:
                try:
                    pid = int(pid_str)
                    if is_running(pid):
                        os.kill(pid, signal.SIGTERM)
                        self.send_json({'stopped': True})
                        return
                except (ValueError, ProcessLookupError):
                    pass

            self.send_json({'error': 'no session running'}, 404)

        elif path == '/pause':
            (STATE_DIR / 'paused').touch()
            self.send_json({'paused': True})

        elif path == '/resume':
            try:
                (STATE_DIR / 'paused').unlink()
            except FileNotFoundError:
                pass
            self.send_json({'resumed': True})

        else:
            self.send_json({'error': 'not found'}, 404)


def main():
    """Start the API server."""
    server = HTTPServer(('', PORT), LokiAPIHandler)
    print(f'Loki API listening on http://localhost:{PORT}')
    print('Endpoints:')
    print('  GET  /health  - Health check')
    print('  GET  /status  - Current status')
    print('  GET  /events  - SSE stream')
    print('  GET  /logs    - Recent logs')
    print('  POST /start   - Start session')
    print('  POST /stop    - Stop session')
    print('  POST /pause   - Pause session')
    print('  POST /resume  - Resume session')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down...')
        server.shutdown()


if __name__ == '__main__':
    main()
