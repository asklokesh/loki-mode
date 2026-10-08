#!/usr/bin/env python3
"""Print the loki-ts/src files reached by the import closure of packages/control-plane/src.

Used by scripts/select-tests.sh (FC-32). Run from the repo root. Conservative: any
relative import form counts. Kept out of the shell script because a heredoc inside
$( ) does not parse under macOS bash 3.2.
"""
import os
import re

pat = re.compile(r'(?:\bfrom|\bimport)\s*\(?\s*["\']([^"\']+)["\']')


def res(d, spec):
    b = os.path.normpath(os.path.join(d, spec))
    for c in (b, re.sub(r"\.js$", ".ts", b), b + ".ts", os.path.join(b, "index.ts")):
        if os.path.isfile(c):
            return os.path.normpath(c)
    return None


q = [os.path.join(d, f) for d, _, fs in os.walk("packages/control-plane/src") for f in fs if f.endswith((".ts", ".tsx"))]
need, seen = set(), set(q)
while q:
    p = q.pop()
    try:
        txt = open(p).read()
    except OSError:
        continue
    for spec in pat.findall(txt):
        if not spec.startswith("."):
            continue
        r = res(os.path.dirname(p), spec)
        if r and r.startswith("loki-ts/src/") and r not in need:
            need.add(r)
        if r and r.startswith("loki-ts/src/") and r not in seen:
            seen.add(r)
            q.append(r)
print("\n".join(sorted(need)))
