import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _h import expect, jbody, req, run  # noqa: E402


def check():
    s, _, b = req("POST", "/shorten", {"url": "https://example.com/a/b?c=1"})
    expect(s == 201, "POST /shorten -> %s" % s)
    code = jbody(b).get("code")
    expect(isinstance(code, str) and code.isalnum() and 4 <= len(code) <= 10, "bad code: %r" % code)
    s, _, _ = req("POST", "/shorten", {"url": "not a url"})
    expect(s == 400, "invalid url should be 400, got %s" % s)
    for _ in range(2):
        s, h, _ = req("GET", "/" + code)
        expect(s == 302, "GET /<code> should be 302, got %s" % s)
        expect(h.get("Location") == "https://example.com/a/b?c=1", "wrong Location: %r" % h.get("Location"))
    s, _, b = req("GET", "/stats/" + code)
    st = jbody(b)
    expect(s == 200 and st.get("hits") == 2 and st.get("url") == "https://example.com/a/b?c=1", "stats wrong: %r" % st)
    s, _, _ = req("GET", "/zzzzzzzz")
    expect(s == 404, "unknown code should be 404, got %s" % s)


run(check)
