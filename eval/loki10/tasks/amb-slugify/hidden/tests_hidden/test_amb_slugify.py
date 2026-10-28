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
SEED_LINES = set(['# textkit', 'Small text helpers.', 'def slugify(s):', 'import re', 'return s.strip("-")', 's = re.sub(r"[^a-z0-9]+", "-", s)', 's = s.lower()'])
OPTIONS = {
    'ascii_fold': 'transliterat|ascii|\\bfold|normali[sz]|(remov|strip)\\w*\\W+(the\\W+)?(accent|diacritic)|unaccent|\\bcafe\\b|e\\W+for\\W+\xe9',
    'keep_unicode': '(keep|preserv|retain|leav)\\w*\\W+(the\\W+)?(accent|unicode|non-ascii|diacritic|letters|\xe9)|unicode\\W+slug|\\bcaf\xe9\\b',
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

import textkit

def invariants():
    s = textkit.slugify
    assert s("Hello,  World!") == "hello-world"
    assert s("  --Trim me--  ") == "trim-me"
    assert s("") == ""
    assert s("a1 b2") == "a1-b2"
    assert "caf-" not in s("Caf\xe9 au lait"), s("Caf\xe9 au lait")

def fold():
    assert textkit.slugify("Caf\xe9 au lait") == "cafe-au-lait"
    assert textkit.slugify("Cr\xe8me br\xfbl\xe9e") == "creme-brulee"

def keep():
    assert textkit.slugify("Caf\xe9 au lait") == "caf\xe9-au-lait"
    assert textkit.slugify("Cr\xe8me br\xfbl\xe9e") == "cr\xe8me-br\xfbl\xe9e"

BEHAVIOR = {"ascii_fold": fold, "keep_unicode": keep}
ambiguity_main()
