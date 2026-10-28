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

def cfg(path, *args):
    return run([sys.executable, "cfg.py", path] + list(args))

def with_file(content):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "app.ini")
    if content is not None:
        open(p, "w").write(content)
    return p

SRC = """# top comment
[server]
host = example.org
Port : 80   ; the web port
; keep me

[db]
name=main
user = admin
"""

def t_replace_existing():
    p = with_file(SRC)
    r = cfg(p, "set", "server", "port", "8080")
    assert r.returncode == 0 and r.stdout == "", (r.returncode, r.stdout, r.stderr)
    want = SRC.replace("Port : 80   ; the web port", "Port : 8080")
    assert open(p).read() == want, repr(open(p).read())
    g = cfg(p, "get", "server", "port")
    assert g.stdout.strip() == "8080"

def t_replace_keeps_prefix():
    p = with_file(SRC)
    assert cfg(p, "set", "db", "name", "other").returncode == 0
    assert open(p).read() == SRC.replace("name=main", "name=other"), repr(open(p).read())
    assert cfg(p, "set", "server", "HOST", "h2").returncode == 0
    assert "host = h2" in open(p).read()

def t_append_key_in_section():
    p = with_file(SRC)
    assert cfg(p, "set", "server", "timeout", "30").returncode == 0
    want = SRC.replace("; keep me\n", "; keep me\ntimeout = 30\n")
    assert open(p).read() == want, repr(open(p).read())

def t_new_section():
    p = with_file(SRC)
    assert cfg(p, "set", "cache", "ttl", "5").returncode == 0
    assert open(p).read() == SRC + "\n[cache]\nttl = 5\n", repr(open(p).read())

def t_missing_file_created():
    p = with_file(None)
    assert cfg(p, "set", "a", "b", "c").returncode == 0
    assert open(p).read() == "[a]\nb = c\n", repr(open(p).read())

def t_section_case_sensitive():
    p = with_file("[Db]\nx = 1\n")
    assert cfg(p, "set", "db", "x", "2").returncode == 0
    assert open(p).read() == "[Db]\nx = 1\n\n[db]\nx = 2\n", repr(open(p).read())

def t_usage_and_get():
    p = with_file(SRC)
    assert cfg(p, "set", "server").returncode == 64
    assert cfg(p, "get", "db", "user").stdout.strip() == "admin"
    assert cfg(p, "get", "db", "nokey").returncode == 1

for n, f in (("replace", t_replace_existing), ("prefix", t_replace_keeps_prefix), ("append_key", t_append_key_in_section), ("new_section", t_new_section), ("created", t_missing_file_created), ("section_case", t_section_case_sensitive), ("usage_get", t_usage_and_get)):
    check(n, f)
done()
