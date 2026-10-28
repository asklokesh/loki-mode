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

import inspect
from acct import users, billing, notifications, reports

def t_internal_callers():
    calls = []
    real = users.get_user
    def spy(uid):
        calls.append(uid)
        return real(uid)
    users.get_user = spy
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            assert billing.invoice_for("1", 5) == "Invoice for Ada: 5"
            assert notifications.welcome("2") == "to=bob@example.com subject=Welcome Bob"
            assert reports.roster(["1", "2"]) == ["Ada", "Bob"]
    finally:
        users.get_user = real
    assert calls == ["1", "2", "1", "2"], calls

def t_alias():
    assert users.get_user("1")["name"] == "Ada"
    try:
        users.get_user("zz")
    except KeyError:
        pass
    else:
        raise AssertionError("missing user must raise KeyError")
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r = users.fetch_user("1")
    assert r == users.get_user("1")
    dep = [x for x in w if issubclass(x.category, DeprecationWarning)]
    assert len(dep) == 1, [str(x.message) for x in w]
    assert dep[0].filename.endswith("test_mf_rename_api.py"), dep[0].filename

def t_alias_late_binding():
    real = users.get_user
    users.get_user = lambda uid: {"id": uid, "name": "patched", "email": "p@x"}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            assert users.fetch_user("1")["name"] == "patched"
    finally:
        users.get_user = real

def t_no_leftover_references():
    for mod in (billing, notifications, reports):
        assert "fetch_user" not in inspect.getsource(mod), mod.__name__

for n, f in (("internal_callers", t_internal_callers), ("alias", t_alias), ("alias_late_binding", t_alias_late_binding), ("no_leftovers", t_no_leftover_references)):
    check(n, f)
done()
