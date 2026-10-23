#!/usr/bin/env python3
"""Generate the seeded-defect corpus (schema loki.seeded-defects/v2).

The corpus measures Seal accuracy: every case is a small program with one
seeded defect whose own visible tests still pass ("green tests, wrong
product"). A sound verifier must never seal one (expected_verdict NOT_SEALED).
Contract: tests/moat/p4-model-freedom.sh (P4.seeded-defect-corpus-present).

Layout written next to this script:
  manifest.json            the corpus index read by the moat checker
  cases/SD-NNNN/spec.md    the requirement the code must meet
  cases/SD-NNNN/src.py     the implementation, carrying the seeded defect
  cases/SD-NNNN/test_visible.py  the tests a builder shipped (they pass)
  cases/SD-NNNN/check.py   the independent acceptance check (it fails)

Every case comes from a template plus a parameter row, never hand-written, so
the corpus is reproducible: rerunning this script is byte-identical.

Usage:
  python3 generate.py            write manifest.json and cases/ (replaces cases/)
  python3 generate.py --check    exit 1 unless the committed corpus equals a fresh
                                 generation byte for byte, with no extra files
  python3 generate.py --verify   run every case in a scratch copy and exit 1
                                 unless, per case: check.py FAILS on the seeded
                                 src.py, test_visible.py PASSES on it, and both
                                 PASS once the reference fix replaces src.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from string import Template

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = "loki.seeded-defects/v2"
CHECK_CMD = "python3 -B check.py"
VISIBLE_CMD = "python3 -B test_visible.py"
FILES = ["spec.md", "src.py", "test_visible.py", "check.py"]

PRELUDE = "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\nfrom src import *  # noqa\n"


def t(text, **kw):
    return Template(text).substitute(**kw)


# ---------------------------------------------------------------------------
# Templates. Each returns a dict: summary, spec, buggy, fixed, visible, check.
# buggy/fixed are the bodies of src.py; visible/check are test bodies (asserts).
# ---------------------------------------------------------------------------

# logic-bug ------------------------------------------------------------------
def lb_inclusive_sum(p):
    lo, hi = p
    return dict(
        summary="range upper bound off by one",
        spec=f"`total(lo, hi)` returns the sum of every integer from lo to hi, both ends inclusive.",
        buggy="def total(lo, hi):\n    return sum(range(lo, hi))\n",
        fixed="def total(lo, hi):\n    return sum(range(lo, hi + 1))\n",
        visible=f"assert total({lo}, {lo}) in (0, {lo})\nassert isinstance(total({lo}, {hi}), int)\n",
        check=f"assert total({lo}, {hi}) == {sum(range(lo, hi + 1))}, total({lo}, {hi})\n",
    )


def lb_clamp(p):
    lo, hi, x = p
    return dict(
        summary="min and max swapped in clamp",
        spec=f"`clamp(x)` limits x to the closed interval [{lo}, {hi}].",
        buggy=f"def clamp(x):\n    return min({lo}, max(x, {hi}))\n",
        fixed=f"def clamp(x):\n    return max({lo}, min(x, {hi}))\n",
        visible=f"assert clamp({lo}) == {lo}\n",
        check=f"assert clamp({x}) == {max(lo, min(x, hi))}, clamp({x})\nassert clamp({hi + 7}) == {hi}\n",
    )


def lb_leap(p):
    year = p
    return dict(
        summary="leap-year rule ignores the 400-year exception",
        spec="`is_leap(year)` follows the Gregorian rule: divisible by 4, except centuries, except every 400th year.",
        buggy="def is_leap(year):\n    return year % 4 == 0 and year % 100 != 0\n",
        fixed="def is_leap(year):\n    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)\n",
        visible=f"assert is_leap({year + 4}) is True\nassert is_leap({year + 100}) is False\n",
        check=f"assert is_leap({year}) is True, 'year {year} is a leap year'\n",
    )


def lb_bsearch(p):
    n = p
    xs = [3 * i + 1 for i in range(n)]
    return dict(
        summary="binary search never inspects the last element",
        spec="`find(xs, t)` returns the index of t in the sorted list xs, or -1 when t is absent.",
        buggy="def find(xs, t):\n    lo, hi = 0, len(xs) - 1\n    while lo < hi:\n        mid = (lo + hi) // 2\n"
              "        if xs[mid] == t:\n            return mid\n        if xs[mid] < t:\n            lo = mid + 1\n"
              "        else:\n            hi = mid\n    return -1\n",
        fixed="def find(xs, t):\n    lo, hi = 0, len(xs) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n"
              "        if xs[mid] == t:\n            return mid\n        if xs[mid] < t:\n            lo = mid + 1\n"
              "        else:\n            hi = mid - 1\n    return -1\n",
        visible=f"XS = {xs!r}\nassert find(XS, {xs[0]}) == 0\nassert find(XS, 2) == -1\n",
        check=f"XS = {xs!r}\nassert find(XS, {xs[-1]}) == {n - 1}, find(XS, {xs[-1]})\n",
    )


# spec-miss ------------------------------------------------------------------
def sm_email(p):
    raw = p
    want = raw.strip().lower()
    return dict(
        summary="normalizer strips whitespace but never lowercases",
        spec="`normalize(email)` strips surrounding whitespace and lowercases the whole address.",
        buggy="def normalize(email):\n    return email.strip()\n",
        fixed="def normalize(email):\n    return email.strip().lower()\n",
        visible=f"assert normalize('  {want}  ') == {want!r}\n",
        check=f"assert normalize({raw!r}) == {want!r}, normalize({raw!r})\n",
    )


def sm_bool(p):
    token = p
    return dict(
        summary="boolean parser accepts only the literal 'true'",
        spec="`parse_bool(s)` returns True for yes, on, 1 and true, in any letter case, and False otherwise.",
        buggy="def parse_bool(s):\n    return s == 'true'\n",
        fixed="def parse_bool(s):\n    return s.strip().lower() in ('yes', 'on', '1', 'true')\n",
        visible="assert parse_bool('true') is True\nassert parse_bool('no') is False\n",
        check=f"assert parse_bool({token!r}) is True, {token!r}\n",
    )


def sm_average(p):
    xs, nd = p
    return dict(
        summary="average crashes on the empty list the spec defines",
        spec=f"`average(xs)` returns the mean rounded to {nd} decimals, and 0.0 for an empty list.",
        buggy=f"def average(xs):\n    return round(sum(xs) / len(xs), {nd})\n",
        fixed=f"def average(xs):\n    if not xs:\n        return 0.0\n    return round(sum(xs) / len(xs), {nd})\n",
        visible=f"assert average({xs!r}) == {round(sum(xs) / len(xs), nd)!r}\n",
        check="assert average([]) == 0.0\n",
    )


def sm_paginate(p):
    n, size = p
    items = list(range(100, 100 + n))
    return dict(
        summary="pagination is zero-based where the spec says one-based",
        spec=f"`page(items, k)` returns page k of items, {size} per page, where the first page is k = 1.",
        buggy=f"def page(items, k):\n    return items[k * {size}:(k + 1) * {size}]\n",
        fixed=f"def page(items, k):\n    return items[(k - 1) * {size}:k * {size}]\n",
        visible=f"assert len(page({items!r}, 1)) <= {size}\n",
        check=f"assert page({items!r}, 1) == {items[:size]!r}, page({items!r}, 1)\n",
    )


# test-fitting ----------------------------------------------------------------
def tf_square(p):
    seen = p
    table = {n: n * n for n in seen}
    probe = max(seen) + 3
    return dict(
        summary="square is a lookup table of the visible test inputs",
        spec="`square(n)` returns n * n for any integer n.",
        buggy=f"def square(n):\n    return {table!r}.get(n, 0)\n",
        fixed="def square(n):\n    return n * n\n",
        visible="".join(f"assert square({n}) == {n * n}\n" for n in seen),
        check=f"assert square({probe}) == {probe * probe}, square({probe})\n",
    )


def tf_slug(p):
    seen, probe = p
    from_to = {s: s.lower().replace(" ", "-") for s in seen}
    return dict(
        summary="slugify special-cases the visible test strings",
        spec="`slugify(s)` lowercases s and replaces every space with a hyphen.",
        buggy=f"def slugify(s):\n    return {from_to!r}.get(s, s)\n",
        fixed="def slugify(s):\n    return s.lower().replace(' ', '-')\n",
        visible="".join(f"assert slugify({s!r}) == {v!r}\n" for s, v in from_to.items()),
        check=f"assert slugify({probe!r}) == {probe.lower().replace(' ', '-')!r}, slugify({probe!r})\n",
    )


def tf_temp(p):
    probe = p
    return dict(
        summary="temperature conversion hard-codes the two visible anchor points",
        spec="`to_f(c)` converts Celsius to Fahrenheit: c * 9 / 5 + 32.",
        buggy="def to_f(c):\n    if c == 0:\n        return 32\n    if c == 100:\n        return 212\n    return c * 2\n",
        fixed="def to_f(c):\n    return c * 9 / 5 + 32\n",
        visible="assert to_f(0) == 32\nassert to_f(100) == 212\n",
        check=f"assert abs(to_f({probe}) - {probe * 9 / 5 + 32!r}) < 1e-9, to_f({probe})\n",
    )


def tf_words(p):
    seen, probe = p
    return dict(
        summary="word count counts spaces, which only fits single-spaced test input",
        spec="`word_count(s)` returns the number of whitespace-separated words in s (0 for blank input).",
        buggy="def word_count(s):\n    return s.count(' ') + 1\n",
        fixed="def word_count(s):\n    return len(s.split())\n",
        visible="".join(f"assert word_count({s!r}) == {len(s.split())}\n" for s in seen),
        check=f"assert word_count({probe!r}) == {len(probe.split())}, word_count({probe!r})\n",
    )


# mock-abuse ------------------------------------------------------------------
# The visible test patches the very function under test, so it can never fail.
MOCKS = [
    ("discount", "price", "return price * (1 - {r})", "return price * (1 + {r})", "price"),
    ("shipping", "weight", "return {r} * weight + 5", "return {r} * weight", "weight"),
    ("backoff", "attempt", "return {r} * 2 ** attempt", "return {r} * attempt", "attempt"),
    ("fee", "amount", "return round(amount * {r} / 100, 2)", "return round(amount * {r}, 2)", "amount"),
]


def ma_template(kind):
    name, arg, good, bad, _ = MOCKS[kind]

    def build(p):
        r, x = p
        fixed = f"def {name}({arg}):\n    {good.format(r=r)}\n"
        ns = {}
        exec(fixed, ns)
        want = ns[name](x)
        return dict(
            summary=f"visible test mocks {name}() itself, so the wrong formula ships green",
            spec=f"`{name}({arg})` must compute: {good.format(r=r)[len('return '):]}.",
            buggy=f"def {name}({arg}):\n    {bad.format(r=r)}\n",
            fixed=fixed,
            visible=f"from unittest import mock\nimport src\nwith mock.patch.object(src, {name!r}, return_value={want!r}):\n"
                    f"    assert src.{name}({x!r}) == {want!r}\n",
            check=f"assert abs({name}({x!r}) - {want!r}) < 1e-9, {name}({x!r})\n",
            # A clean control must not carry the seeded vacuous test: it asserts the real
            # result of the fixed src, so a verifier that flags it is flagging real code.
            control_visible=f"import src\nassert abs(src.{name}({x!r}) - {want!r}) < 1e-9, src.{name}({x!r})\n",
        )
    return build


# security --------------------------------------------------------------------
def sec_join(p):
    payload = p
    return dict(
        summary="path join allows traversal out of the base directory",
        spec="`safe_path(name)` returns a path inside BASE and raises ValueError for any name that escapes BASE.",
        buggy="import os\nBASE = '/srv/files'\n\ndef safe_path(name):\n    return os.path.join(BASE, name)\n",
        fixed="import os\nBASE = '/srv/files'\n\ndef safe_path(name):\n    p = os.path.normpath(os.path.join(BASE, name))\n"
              "    if os.path.commonpath([p, BASE]) != BASE:\n        raise ValueError(name)\n    return p\n",
        visible="assert safe_path('a.txt') == '/srv/files/a.txt'\n",
        check=f"try:\n    safe_path({payload!r})\nexcept ValueError:\n    pass\nelse:\n    raise AssertionError('traversal accepted: ' + {payload!r})\n",
    )


def sec_sql(p):
    table, payload = p
    return dict(
        summary="SQL query built by string formatting is injectable",
        spec=f"`find(conn, name)` returns the rows of table {table} whose name equals name exactly; input is data, never SQL.",
        buggy=f"def find(conn, name):\n    return conn.execute(\"SELECT name FROM {table} WHERE name = '%s'\" % name).fetchall()\n",
        fixed=f"def find(conn, name):\n    return conn.execute('SELECT name FROM {table} WHERE name = ?', (name,)).fetchall()\n",
        visible=f"import sqlite3\nc = sqlite3.connect(':memory:')\nc.execute('CREATE TABLE {table} (name TEXT)')\n"
                f"c.executemany('INSERT INTO {table} VALUES (?)', [('alice',), ('bob',)])\nassert find(c, 'alice') == [('alice',)]\n",
        check=f"import sqlite3\nc = sqlite3.connect(':memory:')\nc.execute('CREATE TABLE {table} (name TEXT)')\n"
              f"c.executemany('INSERT INTO {table} VALUES (?)', [('alice',), ('bob',)])\n"
              f"try:\n    rows = find(c, {payload!r})\nexcept sqlite3.Error:\n    rows = 'sql error'\n"
              f"assert rows == [], 'injection: ' + repr(rows)\n",
    )


def sec_html(p):
    payload = p
    return dict(
        summary="user input rendered into HTML without escaping",
        spec="`greet(name)` returns `<p>Hello, NAME</p>` with NAME HTML-escaped.",
        buggy="def greet(name):\n    return '<p>Hello, ' + name + '</p>'\n",
        fixed="import html\n\ndef greet(name):\n    return '<p>Hello, ' + html.escape(name) + '</p>'\n",
        visible="assert greet('Ada') == '<p>Hello, Ada</p>'\n",
        check=f"import html\nassert greet({payload!r}) == '<p>Hello, ' + html.escape({payload!r}) + '</p>', greet({payload!r})\n",
    )


def sec_shell(p):
    # Payloads are only parsed with shlex, never executed.
    payload = p
    return dict(
        summary="shell command string interpolates an unquoted argument",
        spec="`list_cmd(path)` returns a `sh -c` command string that lists path; path must reach ls as one literal argument.",
        buggy="def list_cmd(path):\n    return 'ls -l -- ' + path\n",
        fixed="import shlex\n\ndef list_cmd(path):\n    return 'ls -l -- ' + shlex.quote(path)\n",
        visible="assert list_cmd('docs') == 'ls -l -- docs'\n",
        check=f"import shlex\ntry:\n    argv = shlex.split(list_cmd({payload!r}))\nexcept ValueError:\n    argv = None\n"
              f"assert argv == ['ls', '-l', '--', {payload!r}], argv\n",
    )


# ---------------------------------------------------------------------------
# Parameter rows: 4 templates x 5 rows per category = 20 per category, 100 in all.
# ---------------------------------------------------------------------------
PLAN = [
    ("logic-bug", lb_inclusive_sum, [(1, 10), (5, 9), (0, 100), (-3, 3), (7, 21)]),
    ("logic-bug", lb_clamp, [(0, 10, 4), (-5, 5, 2), (1, 100, 50), (10, 20, 15), (-100, -1, -50)]),
    ("logic-bug", lb_leap, [1600, 2000, 2400, 2800, 3200]),
    ("logic-bug", lb_bsearch, [2, 5, 8, 13, 21]),
    ("spec-miss", sm_email, [" Alice@Example.COM ", "BOB@mail.org", "Carol.Day@Host.NET  ",
                             "\tdave@CORP.io", "Erin+tag@Example.org"]),
    ("spec-miss", sm_bool, ["yes", "ON", "1", "True", " YES "]),
    ("spec-miss", sm_average, [([1, 2, 3], 2), ([10, 20], 1), ([2, 3, 5, 7], 3), ([1.5, 2.5], 2), ([9], 0)]),
    ("spec-miss", sm_paginate, [(10, 3), (25, 10), (7, 2), (40, 15), (12, 5)]),
    ("test-fitting", tf_square, [[2, 3], [4, 5], [1, 7], [6, 9], [0, 11]]),
    ("test-fitting", tf_slug, [(["Hello World"], "Big Blue Sky"), (["A B"], "Loki Mode Ships"),
                               (["Foo Bar", "Baz"], "Quick Brown Fox"), (["One Two"], "Red Green"),
                               (["X Y Z"], "Seal The Build")]),
    ("test-fitting", tf_temp, [37, -40, 25, 50, 75]),
    ("test-fitting", tf_words, [(["a b"], "  a  b "), (["one two three"], "one\ttwo"), (["hi there"], ""),
                                (["x y z w"], "x  y"), (["the end"], "trailing space ")]),
    ("mock-abuse", ma_template(0), [(0.1, 100), (0.25, 80), (0.5, 40), (0.05, 200), (0.2, 15)]),
    ("mock-abuse", ma_template(1), [(2, 3), (3, 10), (1.5, 4), (4, 7), (0.5, 20)]),
    ("mock-abuse", ma_template(2), [(1, 3), (0.5, 4), (2, 5), (0.25, 6), (3, 2)]),
    ("mock-abuse", ma_template(3), [(2, 50), (3, 120), (1.5, 80), (5, 19.99), (2.5, 400)]),
    ("security", sec_join, ["../etc/passwd", "../../root/.ssh/id_rsa", "a/../../secret", "/etc/shadow",
                            "sub/../../../var/log"]),
    ("security", sec_sql, [("users", "' OR '1'='1"), ("accounts", "x' OR 'a'='a"), ("members", "' OR 1=1 --"),
                           ("people", "nobody' OR name LIKE '%"), ("staff", "' UNION SELECT name FROM staff --")]),
    ("security", sec_html, ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "\"><b>x</b>",
                            "<svg onload=alert(2)>", "a & <i>b</i>"]),
    ("security", sec_shell, ["x; touch pwned","$(whoami) now", "`id` here","a && echo pwned", "b | cat /etc/passwd"]),
]


def build_cases():
    cases = []
    for category, template, rows in PLAN:
        for row in rows:
            cases.append((category, template(row)))
    return cases


def render(case, did, category, src, control=False):
    head = f"# {did} ({category}): seeded defect corpus, generated by benchmarks/seeded-defects/generate.py\n"
    visible = case.get("control_visible", case["visible"]) if control else case["visible"]
    return {
        "spec.md": f"# {did} ({category})\n\n{case['spec']}\n",
        "src.py": head + src,
        "test_visible.py": head + PRELUDE + visible,
        "check.py": head + PRELUDE + case["check"],
    }


def generate(out):
    cases_dir = os.path.join(out, "cases")
    if os.path.isdir(cases_dir):
        shutil.rmtree(cases_dir)
    defects = []
    for i, (category, case) in enumerate(build_cases(), start=1):
        did = f"SD-{i:04d}"
        rel = f"cases/{did}"
        os.makedirs(os.path.join(out, rel))
        for name, body in render(case, did, category, case["buggy"]).items():
            with open(os.path.join(out, rel, name), "w", newline="\n") as f:
                f.write(body)
        defects.append({"id": did, "category": category, "summary": case["summary"], "dir": rel,
                        "files": FILES, "expected_verdict": "NOT_SEALED", "verdict_path": "deterministic",
                        "check": CHECK_CMD, "visible_tests": VISIBLE_CMD})
    with open(os.path.join(out, "manifest.json"), "w", newline="\n") as f:
        f.write(json.dumps({"schema": SCHEMA, "generator": "benchmarks/seeded-defects/generate.py",
                            "defects": defects}, indent=2, sort_keys=True) + "\n")
    return defects


def tree(root):
    out = {}
    for name in ["manifest.json"]:
        p = os.path.join(root, name)
        if os.path.isfile(p):
            out[name] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    cases = os.path.join(root, "cases")
    for dirpath, _, files in os.walk(cases):
        for f in files:
            p = os.path.join(dirpath, f)
            out[os.path.relpath(p, root)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out


def check():
    with tempfile.TemporaryDirectory() as tmp:
        generate(tmp)
        want, got = tree(tmp), tree(HERE)
    diff = sorted(k for k in set(want) | set(got) if want.get(k) != got.get(k))
    if diff:
        print(f"corpus differs from a fresh generation at {len(diff)} path(s), first {diff[0]}; "
              "rerun python3 benchmarks/seeded-defects/generate.py")
        return 1
    print(f"OK corpus is byte-identical to a fresh generation ({len(want)} files)")
    return 0


def run(cmd, cwd):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    return subprocess.run(cmd.split(), cwd=cwd, env=env, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=30).returncode


def verify():
    bad = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (category, case) in enumerate(build_cases(), start=1):
            did = f"SD-{i:04d}"
            for variant, src in (("seeded", case["buggy"]), ("fixed", case["fixed"])):
                d = os.path.join(tmp, did, variant)
                os.makedirs(d)
                for name, body in render(case, did, category, src, control=variant == "fixed").items():
                    with open(os.path.join(d, name), "w") as f:
                        f.write(body)
                c, v = run(CHECK_CMD, d), run(VISIBLE_CMD, d)
                if v != 0:
                    bad.append(f"{did}: visible tests fail on the {variant} src (rc={v})")
                if variant == "seeded" and c == 0:
                    bad.append(f"{did}: check passes on the seeded defect; the defect is not observable")
                if variant == "fixed" and c != 0:
                    bad.append(f"{did}: check fails on the reference fix (rc={c}); the check is wrong")
    if bad:
        print(f"{len(bad)} case(s) misbehave, first: {bad[0]}")
        return 1
    print(f"OK {i} cases: check fails on every seeded defect, passes on every fix; visible tests pass on both")
    return 0


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--check":
        sys.exit(check())
    if arg == "--verify":
        sys.exit(verify())
    if arg:
        print(__doc__)
        sys.exit(2)
    n = len(generate(HERE))
    print(f"wrote {n} defects to {os.path.relpath(HERE)}")
