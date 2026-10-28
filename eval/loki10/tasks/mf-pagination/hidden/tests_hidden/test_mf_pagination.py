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

from catalog import repo, routes, render, service

def t_repo():
    assert repo.count() == 23
    assert len(repo.list_items()) == 23
    assert repo.list_items(offset=20, limit=10) == ["item-21", "item-22", "item-23"]
    assert repo.list_items(offset=0, limit=2) == ["item-01", "item-02"]

def t_routes():
    s, b = routes.list_route({})
    assert s == 200 and b["page"] == 1 and b["per_page"] == 10 and b["total"] == 23 and b["pages"] == 3, (s, b)
    assert b["items"][0] == "item-01" and len(b["items"]) == 10
    s, b = routes.list_route({"page": "3", "per_page": "10"})
    assert s == 200 and b["items"] == ["item-21", "item-22", "item-23"], (s, b)
    s, b = routes.list_route({"page": "2", "per_page": "50"})
    assert s == 404 and b == {"error": "page out of range"}, (s, b)
    s, b = routes.list_route({"page": "1", "per_page": "50"})
    assert s == 200 and len(b["items"]) == 23 and b["pages"] == 1
    for q in ({"page": "0"}, {"page": "-1"}, {"page": "x"}, {"per_page": "0"}, {"per_page": "51"}, {"per_page": "ten"}):
        s, b = routes.list_route(q)
        assert (s, b) == (400, {"error": "invalid pagination"}), (q, s, b)

def t_empty_catalog():
    saved = list(repo.ITEMS)
    try:
        del repo.ITEMS[:]
        s, b = routes.list_route({})
        assert s == 200 and b["items"] == [] and b["pages"] == 1 and b["total"] == 0, (s, b)
        s, b = routes.list_route({"page": "2"})
        assert s == 404, (s, b)
    finally:
        repo.ITEMS[:] = saved

def t_render():
    s, b = routes.list_route({"page": "2", "per_page": "10"})
    out = render.render(b).splitlines()
    assert out[0] == "item-11" and out[-1] == "Page 2 of 3 (23 items)", out
    assert len(out) == 11

for n, f in (("repo", t_repo), ("routes", t_routes), ("empty", t_empty_catalog), ("render", t_render)):
    check(n, f)
done()
