import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, h, b = req("GET", "/")
    html = b.decode(errors="replace")
    expect(s == 200 and "text/html" in (h.get("Content-Type") or ""), "GET / should be HTML, got %s" % s)
    expect('id="summary"' in html, 'dashboard page missing element with id="summary"')
    s, _, b = req("GET", "/api/summary")
    expect(s == 200 and jbody(b) == {"total": 0, "by_type": {}}, "empty summary wrong: %r" % b[:120])
    for t in ("signup", "signup", "purchase"):
        s, _, _ = req("POST", "/api/events", {"type": t})
        expect(s == 201, "POST /api/events -> %s" % s)
    s, _, _ = req("POST", "/api/events", {"kind": "oops"})
    expect(s == 400, "event without type should be 400, got %s" % s)
    s, _, b = req("GET", "/api/summary")
    expect(jbody(b) == {"total": 3, "by_type": {"signup": 2, "purchase": 1}}, "summary wrong: %r" % b[:200])


run(check)
