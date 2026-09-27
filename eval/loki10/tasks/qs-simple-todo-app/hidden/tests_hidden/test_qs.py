import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, h, b = req("GET", "/")
    html = b.decode(errors="replace").lower()
    expect(s == 200 and "text/html" in (h.get("Content-Type") or ""), "GET / should serve HTML, got %s" % s)
    expect("<input" in html, "GET / page has no <input> for new todos")
    s, _, b = req("GET", "/api/todos")
    expect(s == 200 and jbody(b) == [], "GET /api/todos should start as [], got %s %r" % (s, b[:100]))
    s, _, b = req("POST", "/api/todos", {"text": "buy milk"})
    expect(s == 201, "POST /api/todos -> %s" % s)
    t = jbody(b)
    expect(t.get("text") == "buy milk" and t.get("done") is False and "id" in t, "bad todo: %r" % t)
    s, _, _ = req("POST", "/api/todos", {"text": "   "})
    expect(s == 400, "blank todo text should be 400, got %s" % s)
    s, _, b = req("PATCH", "/api/todos/%s" % t["id"], {"done": True})
    expect(s == 200 and jbody(b).get("done") is True, "PATCH done -> %s %r" % (s, b[:100]))
    s, _, b = req("GET", "/api/todos")
    lst = jbody(b)
    expect(len(lst) == 1 and lst[0]["done"] is True, "list after PATCH wrong: %r" % lst)
    s, _, _ = req("DELETE", "/api/todos/%s" % t["id"])
    expect(s == 204, "DELETE -> %s" % s)
    s, _, b = req("GET", "/api/todos")
    expect(jbody(b) == [], "list after DELETE should be []")


run(check)
