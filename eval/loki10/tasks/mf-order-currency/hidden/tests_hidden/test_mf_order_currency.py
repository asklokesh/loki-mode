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

def cli(db, *args):
    env = dict(os.environ, SHOP_DB=db)
    return run([sys.executable, "-m", "shop.cli"] + list(args), env=env)

def t_cli():
    d = tempfile.mkdtemp()
    db = os.path.join(d, "a.jsonl")
    assert cli(db, "add", "o1", "100").returncode == 0
    assert cli(db, "add", "o2", "250", "--currency", "USD").returncode == 0
    r = cli(db, "total")
    assert r.returncode == 0 and r.stdout.strip() == "350 USD", (r.returncode, r.stdout)
    assert cli(db, "add", "--currency", "EUR", "o3", "5").returncode == 0
    r = cli(db, "total")
    assert r.returncode == 3 and r.stdout == "" and r.stderr.strip(), (r.returncode, r.stdout, r.stderr)
    db2 = os.path.join(d, "b.jsonl")
    cli(db2, "add", "a", "5", "--currency", "EUR")
    cli(db2, "add", "b", "7", "--currency", "EUR")
    r = cli(db2, "total")
    assert r.stdout.strip() == "12 EUR", r.stdout
    assert "EUR" in open(db2).read()

def t_invalid():
    d = tempfile.mkdtemp()
    db = os.path.join(d, "c.jsonl")
    for bad in ("usd", "US", "USDX", "U5D"):
        r = cli(db, "add", "x", "1", "--currency", bad)
        assert r.returncode == 64, (bad, r.returncode)
    assert not os.path.exists(db) or open(db).read().strip() == ""

def t_legacy_and_empty():
    d = tempfile.mkdtemp()
    db = os.path.join(d, "old.jsonl")
    open(db, "w").write(json.dumps({"id": "old", "amount_cents": 10}) + "\n")
    r = cli(db, "total")
    assert r.returncode == 0 and r.stdout.strip() == "10 USD", r.stdout
    r = cli(os.path.join(d, "none.jsonl"), "total")
    assert r.returncode == 0 and r.stdout.strip() == "0 USD", r.stdout

def t_lib():
    from shop.model import Order
    from shop import store, totals
    assert Order("a", 1).currency == "USD"
    o = Order("a", 1, "EUR")
    assert o.currency == "EUR" and o.to_dict()["currency"] == "EUR"
    p = os.path.join(tempfile.mkdtemp(), "x.jsonl")
    store.save(p, [o, Order("b", 2, "EUR")])
    assert [x.currency for x in store.load(p)] == ["EUR", "EUR"]
    assert totals.total_cents([Order("a", 1), Order("b", 2)]) == 3
    try:
        totals.total_cents([Order("a", 1), Order("b", 2, "EUR")])
    except ValueError:
        pass
    else:
        raise AssertionError("mixed currencies must raise ValueError")

for n, f in (("cli", t_cli), ("invalid", t_invalid), ("legacy_empty", t_legacy_and_empty), ("lib", t_lib)):
    check(n, f)
done()
