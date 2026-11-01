"""Offline Jira Cloud stand-in for tests/min/triage-router.sh.

Usage: python3 -I jira_server.py <port-file> <request-log>
Binds 127.0.0.1 on a free port, writes the port to <port-file>, logs each
request path (decoded) to <request-log>, and answers GET /rest/api/3/search/jql
with jira-search.json when the request carries Basic auth. Anything else is 404.
"""
import base64
import http.server
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PORT_FILE, LOG = sys.argv[1], sys.argv[2]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        with open(LOG, "a") as f:
            f.write(urllib.parse.unquote(self.path) + "\n")
        auth = self.headers.get("Authorization", "")
        want = "Basic " + base64.b64encode(b"bot@example.invalid:fixture-token").decode()
        if not self.path.startswith("/rest/api/3/search/jql?") or auth != want:
            self.send_response(404 if auth == want else 401)
            self.end_headers()
            return
        with open(os.path.join(HERE, "jira-search.json"), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE + ".tmp", "w") as f:
    f.write(str(srv.server_address[1]))
os.replace(PORT_FILE + ".tmp", PORT_FILE)
srv.serve_forever()
