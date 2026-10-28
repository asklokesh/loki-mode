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

from svc import api, audit, errors, handlers

def t_shapes():
    handlers.USERS.clear()
    handlers.USERS.update({"1": {"name": "ada"}, "2": {"name": "bob"}})
    r = api.dispatch("get_user", {"id": "9"})
    assert r == {"status": 404, "error": {"code": "E_NOT_FOUND", "message": "no such user 9"}}, r
    r = api.dispatch("get_user", {})
    assert r == {"status": 400, "error": {"code": "E_INVALID", "message": "id is required"}}, r
    r = api.dispatch("nope", {})
    assert r == {"status": 404, "error": {"code": "E_UNKNOWN_ROUTE", "message": "unknown route"}}, r
    r = api.dispatch("get_user", {"id": "1"})
    assert r["status"] == 200 and r["body"]["user"]["name"] == "ada", r

def t_classes():
    assert (errors.NotFound.code, errors.NotFound.status) == ("E_NOT_FOUND", 404)
    assert (errors.Invalid.code, errors.Invalid.status) == ("E_INVALID", 400)
    assert (errors.AppError.code, errors.AppError.status) == ("E_APP", 500)
    assert (errors.Conflict.code, errors.Conflict.status) == ("E_CONFLICT", 409)
    assert issubclass(errors.Conflict, errors.AppError)

def t_generic_dispatch():
    class Teapot(errors.AppError):
        code = "E_TEAPOT"
        status = 418
    def boom(params):
        raise Teapot("short and stout")
    api.ROUTES["boom"] = boom
    r = api.dispatch("boom", {})
    assert r == {"status": 418, "error": {"code": "E_TEAPOT", "message": "short and stout"}}, r
    def crash(params):
        raise RuntimeError("secret detail")
    api.ROUTES["crash"] = crash
    r = api.dispatch("crash", {})
    assert r == {"status": 500, "error": {"code": "E_INTERNAL", "message": "internal"}}, r
    r = api.dispatch("rename_user", {"id": "1", "name": "x" * 30})
    assert r["status"] == 400 and r["error"]["code"] == "E_INVALID", r

def t_conflict():
    handlers.USERS.clear()
    handlers.USERS.update({"1": {"name": "ada"}, "2": {"name": "bob"}})
    r = api.dispatch("rename_user", {"id": "1", "name": "bob"})
    assert r["status"] == 409 and r["error"]["code"] == "E_CONFLICT", r
    assert handlers.USERS["1"]["name"] == "ada"
    r = api.dispatch("rename_user", {"id": "1", "name": "ada"})
    assert r["status"] == 200, r
    r = api.dispatch("rename_user", {"id": "1", "name": "cleo"})
    assert r["status"] == 200 and handlers.USERS["1"]["name"] == "cleo"

def t_audit():
    del audit.LOG[:]
    handlers.USERS.clear()
    handlers.USERS.update({"1": {"name": "ada"}})
    api.dispatch("get_user", {"id": "1"})
    api.dispatch("get_user", {"id": "7"})
    api.dispatch("zzz", {})
    assert audit.LOG == [("get_user", 200, None), ("get_user", 404, "E_NOT_FOUND"), ("zzz", 404, "E_UNKNOWN_ROUTE")], audit.LOG

for n, f in (("shapes", t_shapes), ("classes", t_classes), ("generic_dispatch", t_generic_dispatch), ("conflict", t_conflict), ("audit", t_audit)):
    check(n, f)
done()
