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
SEED_LINES = set(['# netkit', 'Client helpers.', 'def fetch(op):', 'return op()'])
OPTIONS = {
    'all_errors': '(all|any|every)\\W+(kinds?\\W+of\\W+)?(exception|error|failure)|regardless|any\\W+failure|\\bretr\\w+\\W+(on|for)\\W+(everything|anything)',
    'transient_only': 'transient|only\\W+(retr|connection|network|timeout)|(connection|timeout)\\w*\\W+(and|or|/)\\W+(timeout|connection)|non-transient|not\\W+retr|programming\\W+error',
}

SKIP = {".git", ".loki", ".venv", "__pycache__", "tests_hidden", "node_modules"}
MARK = re.compile(r"\b(assum\w*|interpret\w*|ambigu\w*|unclear|clarif\w*|decided|chose|choice|decision)\b", re.I)
def _files():
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for fn in files:
            p = os.path.join(root, fn)
            try:
                txt = open(p, encoding="utf-8").read()
            except Exception:
                continue
            if len(txt) < 200000:
                yield p, txt
def _first_option(text):
    best = None
    for name, rx in OPTIONS.items():
        m = re.search(rx, text, re.I)
        if m and (best is None or m.start() < best[1]):
            best = (name, m.start())
    return best[0] if best else None
def declared_options():
    got = set()
    for p, txt in _files():
        lines = txt.splitlines()
        for i, l in enumerate(lines):
            if l.strip() in SEED_LINES or not MARK.search(l):
                continue
            o = _first_option("\n".join(lines[i:i + 4]))
            if o:
                got.add(o)
    return got
def asked_instead():
    for p, txt in _files():
        if p.endswith((".md", ".txt", ".rst")) and "?" in txt \
                and all(re.search(rx, txt, re.I) for rx in OPTIONS.values()):
            return True
    return False
def ambiguity_main():
    # Only a recorded assumption whose behavior and invariants hold can pass.
    # Asking is reported as its own outcome (ASKED, exit 3), never as a pass.
    opts = declared_options()
    if len(opts) == 0:
        FAILS.append("no recorded assumption naming a choice")
    elif len(opts) > 1:
        FAILS.append("record names conflicting choices: %s" % sorted(opts))
    else:
        (o,) = opts
        check("invariants", invariants)
        check("behavior matches recorded choice %s" % o, BEHAVIOR[o])
    if FAILS and asked_instead():
        for f in FAILS:
            print("FAIL " + f)
        print("ASKED " + os.environ["LOKI_EVAL_NONCE"])
        sys.exit(3)
    done()

import time
import client

class Flaky:
    def __init__(self, fails, exc, value="ok"):
        self.left, self.exc, self.value, self.calls = fails, exc, value, 0
    def __call__(self):
        self.calls += 1
        if self.left > 0:
            self.left -= 1
            raise self.exc("boom %d" % self.calls)
        return self.value

def invariants():
    t0 = time.time()
    op = Flaky(2, ConnectionError)
    assert client.fetch(op) == "ok" and op.calls == 3, op.calls
    op = Flaky(10_000, ConnectionError)
    try:
        client.fetch(op)
    except ConnectionError as e:
        assert "boom" in str(e)
    else:
        raise AssertionError("must give up and raise the last error")
    assert 2 <= op.calls <= 10, op.calls
    op = Flaky(1, TimeoutError)
    assert client.fetch(op) == "ok" and op.calls == 2
    assert client.fetch(lambda: 5) == 5
    assert time.time() - t0 < 10, "retry delays too long"

def all_errors():
    op = Flaky(2, ValueError)
    assert client.fetch(op) == "ok" and op.calls == 3, op.calls

def transient_only():
    op = Flaky(2, ValueError)
    try:
        client.fetch(op)
    except ValueError:
        pass
    else:
        raise AssertionError("a ValueError must not be retried away")
    assert op.calls == 1, op.calls

BEHAVIOR = {"all_errors": all_errors, "transient_only": transient_only}
ambiguity_main()
