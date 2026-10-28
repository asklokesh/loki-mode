import os, sys, subprocess, tempfile, json, re, shutil, warnings
FAILS = []
def check(name, fn):
    try:
        fn()
    except BaseException as e:
        FAILS.append("%s: %s: %s" % (name, type(e).__name__, str(e)[:300]))
def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, timeout=60, **kw)
def done():
    for f in FAILS:
        print("FAIL " + f)
    if FAILS:
        sys.exit(1)
    print(os.environ["LOKI_EVAL_NONCE"])
sys.path.insert(0, os.getcwd())

import router
from router import Router

def t_params():
    r = Router()
    r.add("GET", "/users/<id>", lambda id: "user:" + id)
    r.add("GET", "/users/<id>/posts/<post>", lambda id, post: "%s/%s" % (id, post))
    r.add("GET", "/health", lambda: "ok")
    assert r.dispatch("GET", "/users/42") == "user:42"
    assert r.dispatch("GET", "/users/42/posts/7") == "42/7"
    assert r.dispatch("GET", "/health") == "ok"

def t_decode_and_edges():
    r = Router()
    r.add("GET", "/files/<name>", lambda name: name)
    assert r.dispatch("GET", "/files/a%20b") == "a b"
    assert r.dispatch("GET", "/files/x/") == "x"
    assert r.dispatch("GET", "/files/x?y=1") == "x"
    assert r.dispatch("GET", "/files/x/?y=1") == "x"
    assert r.dispatch("GET", "/files/") is None
    assert r.dispatch("GET", "/files/a/b") is None
    assert r.dispatch("GET", "/nope") is None

def t_order_first_wins():
    r = Router()
    r.add("GET", "/a/<x>", lambda x: "param")
    r.add("GET", "/a/fixed", lambda: "static")
    assert r.dispatch("GET", "/a/fixed") == "param"

def t_method_not_allowed():
    r = Router()
    r.add("GET", "/item/<id>", lambda id: "g")
    r.add("DELETE", "/item/<id>", lambda id: "d")
    r.add("PUT", "/other", lambda: "p")
    assert issubclass(router.MethodNotAllowed, Exception)
    try:
        r.dispatch("POST", "/item/3")
    except router.MethodNotAllowed as e:
        assert e.allowed == ["DELETE", "GET"], e.allowed
    else:
        raise AssertionError("expected MethodNotAllowed")
    assert r.dispatch("POST", "/missing") is None

def t_method_match_beats_path_only_match():
    r = Router()
    r.add("GET", "/x/<a>", lambda a: "get")
    r.add("POST", "/x/<a>", lambda a: "post")
    assert r.dispatch("POST", "/x/1") == "post"

for n, f in (("params", t_params), ("decode_edges", t_decode_and_edges), ("order", t_order_first_wins), ("mna", t_method_not_allowed), ("method_beats_path", t_method_match_beats_path_only_match)):
    check(n, f)
done()
