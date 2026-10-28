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

def mk(names, extra_dirs=()):
    d = tempfile.mkdtemp()
    base = 1_700_000_000
    for i, n in enumerate(names):
        p = os.path.join(d, n)
        open(p, "w").write(n)
        os.utime(p, (base + i * 100, base + i * 100))
    for e in extra_dirs:
        os.mkdir(os.path.join(d, e))
    return d

def rot(d, keep):
    return run(["bash", "rotate.sh", d, str(keep)])

def left(d):
    return sorted(os.listdir(d))

def t_keep_exact():
    d = mk(["a.log", "b.log", "c.log", "d.log", "e.log"])
    r = rot(d, 2)
    assert r.returncode == 0, (r.returncode, r.stderr)
    assert left(d) == ["d.log", "e.log"], left(d)

def t_spaces():
    d = mk(["old one.log", "mid two.log", "new three.log"])
    r = rot(d, 1)
    assert r.returncode == 0 and left(d) == ["new three.log"], (r.returncode, left(d), r.stderr)

def t_untouched():
    d = mk(["x.log", "y.log", "z.log", "notes.txt", "data.log.bak"], extra_dirs=["sub", "dir.log"])
    r = rot(d, 1)
    assert r.returncode == 0, r.stderr
    assert left(d) == ["data.log.bak", "dir.log", "notes.txt", "sub", "z.log"], left(d)

def t_zero():
    d = mk(["a.log", "b.log", "keep.txt"])
    r = rot(d, 0)
    assert r.returncode == 0 and left(d) == ["keep.txt"], (r.returncode, left(d), r.stderr)

def t_fewer_than_keep_and_none():
    d = mk(["a.log", "b.log"])
    assert rot(d, 5).returncode == 0 and left(d) == ["a.log", "b.log"]
    d = mk(["only.txt"])
    r = rot(d, 3)
    assert r.returncode == 0 and r.stdout == "" and left(d) == ["only.txt"], (r.returncode, r.stdout, r.stderr)

def t_bad_args():
    for bad in ("-1", "x", "1.5", ""):
        d = mk(["a.log", "b.log"])
        r = rot(d, bad)
        assert r.returncode == 64 and r.stderr.strip() and left(d) == ["a.log", "b.log"], (bad, r.returncode, left(d))
    r = rot(os.path.join(tempfile.mkdtemp(), "missing"), 1)
    assert r.returncode == 66, r.returncode

def t_cwd_independent():
    d = mk(["a.log", "b.log", "c.log"])
    other = tempfile.mkdtemp()
    open(os.path.join(other, "z.log"), "w").write("z")
    r = subprocess.run(["bash", os.path.abspath("rotate.sh"), d, "1"], cwd=other, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and left(d) == ["c.log"] and left(other) == ["z.log"], (left(d), left(other))

for n, f in (("keep_exact", t_keep_exact), ("spaces", t_spaces), ("untouched", t_untouched), ("zero", t_zero), ("fewer", t_fewer_than_keep_and_none), ("bad_args", t_bad_args), ("cwd", t_cwd_independent)):
    check(n, f)
done()
