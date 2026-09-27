import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, _, b = req("POST", "/api/posts", {"title": "Hello World Again", "body_markdown": "Some **bold** text"})
    expect(s == 201, "POST /api/posts -> %s" % s)
    p = jbody(b)
    expect(p.get("slug") == "hello-world-again", "slug should be hello-world-again: %r" % p)
    s, _, b = req("POST", "/api/posts", {"title": "Hello World Again", "body_markdown": "dup"})
    expect(s == 201 and jbody(b).get("slug") == "hello-world-again-2", "duplicate title slug should get -2 suffix: %r" % b[:120])
    s, _, _ = req("POST", "/api/posts", {"title": "", "body_markdown": "x"})
    expect(s == 400, "empty title should be 400, got %s" % s)
    s, h, b = req("GET", "/posts/hello-world-again")
    html = b.decode(errors="replace")
    expect(s == 200 and "text/html" in (h.get("Content-Type") or ""), "GET /posts/<slug> should be HTML, got %s" % s)
    expect("<h1>Hello World Again</h1>" in html, "post page missing <h1>title</h1>")
    expect("<strong>bold</strong>" in html, "markdown **bold** not rendered as <strong>")
    s, _, b = req("GET", "/api/posts")
    lst = jbody(b)
    expect(s == 200 and [x.get("slug") for x in lst] == ["hello-world-again-2", "hello-world-again"], "list should be newest first: %r" % lst)
    s, _, _ = req("GET", "/posts/nope")
    expect(s == 404, "unknown slug should be 404, got %s" % s)


run(check)
