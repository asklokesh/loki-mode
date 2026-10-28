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
SEED_LINES = set(['# linecheck', 'def main(argv):', 'else:', 'except (OSError, IndexError):', 'for i, line in enumerate(lines, 1):', 'if __name__ == "__main__":', 'if not line.strip():', 'import sys', 'lines = f.read().splitlines()', 'print("done: %d lines" % len(lines))', 'print("error: cannot read input", file=sys.stderr)', 'print("line %d: ok" % i)', 'print("warning: blank line %d" % i, file=sys.stderr)', 'return 0', 'return 2', 'sys.exit(main(sys.argv[1:]))', 'tool.py FILE reports on the lines of a file.', 'try:', 'with open(argv[0]) as f:'])
OPTIONS = {
    'errors_still_shown': '(error|warning)s?\\W+(\\w+\\W+){0,2}(still|remain|kept|preserved|shown|printed|visible)|only\\W+(suppress|silenc|hid)\\w*\\W+(the\\W+)?(normal|stdout|informational|info|progress|routine)|stderr\\W+(\\w+\\W+){0,2}(kept|still|untouched|unchanged)',
    'silence_all': '(suppress|silenc|hid|mut)\\w*\\W+(everything|all\\W+output|all\\W+messages|all\\W+of)|including\\W+(errors|warnings)|nothing\\W+(at\\W+all|is\\W+printed)|(errors?|warnings?)\\W+(\\w+\\W+){0,2}(suppressed|silenced|hidden|muted)',
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

def tool(*args):
    return run([sys.executable, "tool.py"] + list(args))

def mkfile(text):
    p = os.path.join(tempfile.mkdtemp(), "in.txt")
    open(p, "w").write(text)
    return p

def invariants():
    good = mkfile("a\nb\n")
    r = tool(good)
    assert r.returncode == 0 and r.stdout.splitlines() == ["line 1: ok", "line 2: ok", "done: 2 lines"], r.stdout
    for args in (["--quiet", good], [good, "--quiet"]):
        r = tool(*args)
        assert r.returncode == 0 and r.stdout == "", (args, r.returncode, r.stdout)
    r = tool("--quiet", os.path.join(tempfile.mkdtemp(), "missing.txt"))
    assert r.returncode == 2 and r.stdout == "", (r.returncode, r.stdout)
    blank = mkfile("a\n\nb\n")
    r = tool("--quiet", blank)
    assert r.returncode == 0 and r.stdout == "", (r.returncode, r.stdout)

def errors_still_shown():
    blank = mkfile("a\n\nb\n")
    r = tool("--quiet", blank)
    assert "warning: blank line 2" in r.stderr, r.stderr
    r = tool("--quiet", os.path.join(tempfile.mkdtemp(), "missing.txt"))
    assert "error:" in r.stderr, r.stderr

def silence_all():
    blank = mkfile("a\n\nb\n")
    r = tool("--quiet", blank)
    assert r.stderr == "", r.stderr
    r = tool("--quiet", os.path.join(tempfile.mkdtemp(), "missing.txt"))
    assert r.stderr == "", r.stderr

BEHAVIOR = {"errors_still_shown": errors_still_shown, "silence_all": silence_all}
ambiguity_main()
