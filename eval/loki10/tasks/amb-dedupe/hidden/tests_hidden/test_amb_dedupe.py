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
SEED_LINES = set(['# listkit', 'List helpers.', 'def dedupe(items):', 'return list(items)'])
OPTIONS = {
    'keep_first': '(keep|retain|preserv|use|take)\\w*\\W+(the\\W+)?(first|earliest)|first\\W+(occurrence|one|seen|appearance|wins)|earliest',
    'keep_last': '(keep|retain|preserv|use|take)\\w*\\W+(the\\W+)?(last|latest)|last\\W+(occurrence|one|seen|appearance|wins)|latest',
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
    if asked_instead():
        print(os.environ["LOKI_EVAL_NONCE"])
        return
    opts = declared_options()
    if len(opts) == 0:
        FAILS.append("no recorded assumption naming a choice (and no question asked)")
    elif len(opts) > 1:
        FAILS.append("record names conflicting choices: %s" % sorted(opts))
    else:
        (o,) = opts
        check("invariants", invariants)
        check("behavior matches recorded choice %s" % o, BEHAVIOR[o])
    done()

import listkit

def invariants():
    d = listkit.dedupe
    assert d([]) == []
    assert d([1, 2, 3]) == [1, 2, 3]
    out = d([3, 1, 3, 2, 1])
    assert sorted(out) == [1, 2, 3] and len(out) == 3, out
    src = [5, 5, 5]
    assert d(src) == [5] and src == [5, 5, 5], "input must not be mutated"
    assert d(iter("aab")) in (["a", "b"], ["a", "b"][::-1])

def first():
    assert listkit.dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]
    assert listkit.dedupe("abca") == ["a", "b", "c"]

def last():
    assert listkit.dedupe([3, 1, 3, 2, 1]) == [3, 2, 1]
    assert listkit.dedupe("abca") == ["b", "c", "a"]

BEHAVIOR = {"keep_first": first, "keep_last": last}
ambiguity_main()
