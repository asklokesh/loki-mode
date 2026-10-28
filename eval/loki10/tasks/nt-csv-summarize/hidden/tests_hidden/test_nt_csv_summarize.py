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

def summarize(content, name="in.csv", raw=None):
    d = tempfile.mkdtemp()
    p = os.path.join(d, name)
    with open(p, "wb") as f:
        f.write(raw if raw is not None else content.encode("utf-8"))
    return run([sys.executable, "summarize.py", p])

def t_plain():
    r = summarize("a,b\n1,2\n3,4.5\n")
    assert r.returncode == 0 and r.stdout.splitlines() == ["a=4", "b=6.5"], (r.returncode, r.stdout, r.stderr)

def t_quoted_comma():
    r = summarize('name,"unit price, usd",qty\n"Smith, J",1.5,2\n"Doe, A",2.5,3\n')
    assert r.returncode == 0 and r.stdout.splitlines() == ["unit price, usd=4", "qty=5"], (r.returncode, r.stdout, r.stderr)

def t_blank_and_short():
    r = summarize("a,b,c\n1,,3\n,5\n2\n")
    assert r.returncode == 0 and r.stdout.splitlines() == ["a=3", "b=5", "c=3"], (r.returncode, r.stdout, r.stderr)

def t_bom_crlf():
    raw = b"\xef\xbb\xbfa,b\r\n1,2\r\n3,4\r\n"
    r = summarize(None, raw=raw)
    assert r.returncode == 0 and r.stdout.splitlines() == ["a=4", "b=6"], (r.returncode, repr(r.stdout), r.stderr)

def t_text_and_blank_columns_omitted():
    r = summarize("id,note,empty,amt\n1,hello,,2.25\n2,12x,,1\n")
    assert r.returncode == 0 and r.stdout.splitlines() == ["id=3", "amt=3.25"], (r.returncode, r.stdout, r.stderr)

def t_missing_file():
    r = run([sys.executable, "summarize.py", os.path.join(tempfile.mkdtemp(), "nope.csv")])
    assert r.returncode == 2 and r.stdout == "" and r.stderr.strip(), (r.returncode, r.stdout, r.stderr)

for n, f in (("plain", t_plain), ("quoted_comma", t_quoted_comma), ("blank_and_short", t_blank_and_short), ("bom_crlf", t_bom_crlf), ("omitted", t_text_and_blank_columns_omitted), ("missing", t_missing_file)):
    check(n, f)
done()
