import http.server
import os
import json
import subprocess
import sys
import threading

PAGES = {
    "/shop": """<html><body><ul>
<li class="product"><span class="name">Red Mug</span> <span class="price">$12.00</span></li>
<li class="product"><span class="name">Blue &amp; Gold Shirt</span> <span class="price">$20.50</span></li>
</ul><a rel="next" href="/shop?page=2">Next</a></body></html>""",
    "/shop?page=2": """<html><body><ul>
<li class="product"><span class="name">Sticker</span> <span class="price">$1.99</span></li>
</ul></body></html>""",
}


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGES.get(self.path)
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write((body or "not found").encode())

    def log_message(self, *a):
        pass


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = "http://127.0.0.1:%d/shop" % srv.server_address[1]
try:
    try:
        r = subprocess.run(["sh", "scrape.sh", url], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail("scrape.sh did not run: %s" % e)
    if r.returncode != 0:
        fail("scrape.sh exit %s stderr %r" % (r.returncode, r.stderr[:300]))
    try:
        out = json.loads(r.stdout)
    except ValueError:
        fail("stdout is not JSON: %r" % r.stdout[:300])
    want = [
        {"name": "Red Mug", "price_cents": 1200},
        {"name": "Blue & Gold Shirt", "price_cents": 2050},
        {"name": "Sticker", "price_cents": 199},
    ]
    if out != want:
        fail("got %r want %r" % (out, want))
finally:
    srv.shutdown()
print("PASS")
# Last stdout line, only reached when every check passed.
print(os.environ.get("LOKI_EVAL_NONCE", ""))
