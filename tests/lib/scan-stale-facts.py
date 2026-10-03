#!/usr/bin/env python3
"""Scan docs for stale facts (STALE-ZERO SZ-03).

usage: scan-stale-facts.py ROOT COMMANDS_FILE

Prints one finding per line as `kind<TAB>path:line<TAB>text`, kinds:
  command  a `loki <cmd>` naming a top-level command absent from COMMANDS_FILE
  envvar   a dead env var (LOKI_ENGINE, LOKI_LEGACY_BASH, LOKI_SDK_LOOP)
  version  a version string of an older major (v9.x and below)

Scanned: README.md, SKILL.md, docs/**, wiki/**. Excluded: CHANGELOG.md,
docs/history/ and docs/v10/ planning records (docs/v10/GUIDE.md is scanned).
"""
import os
import re
import sys

root, cmds_file = sys.argv[1], sys.argv[2]
commands = {l.strip() for l in open(cmds_file, encoding="utf-8") if l.strip()}

DEAD_ENV = re.compile(r"\b(LOKI_ENGINE|LOKI_LEGACY_BASH|LOKI_SDK_LOOP)(?![A-Z0-9_])")
OLD_VERSION = re.compile(r"(?<![\w.])v[0-9]\.(?:[0-9]+|x)(?:\.(?:[0-9]+|x))?(?![\w.]*[\w])")
CMD = re.compile(r"(?:^|[\s$;|&(`])loki\s+([a-z][a-z0-9-]*)(?=\s|$|`|[.,;:)])")
SPAN = re.compile(r"`([^`]+)`")


def files():
    for top in ("README.md", "SKILL.md"):
        if os.path.isfile(os.path.join(root, top)):
            yield top
    for base in ("docs", "wiki"):
        for dp, dn, fn in os.walk(os.path.join(root, base)):
            rel = os.path.relpath(dp, root)
            if rel == "docs/history" or rel.startswith("docs/history/"):
                dn[:] = []
                continue
            if rel == "docs/v10" or rel.startswith("docs/v10/"):
                for f in fn:
                    if f == "GUIDE.md":
                        yield os.path.join(rel, f)
                continue
            for f in sorted(fn):
                if f.endswith(".md"):
                    yield os.path.join(rel, f)


def cmd_hits(line, fenced):
    if fenced:
        text = line.strip()
        if text.startswith("#"):
            return
        for m in CMD.finditer(" " + text):
            yield m.group(1)
    else:
        for span in SPAN.findall(line):
            m = CMD.match(" " + span.strip())
            if m:
                yield m.group(1)


for rel in sorted(set(files())):
    try:
        lines = open(os.path.join(root, rel), encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        continue
    fenced = False
    for n, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        loc = "%s:%d" % (rel, n)
        for w in cmd_hits(line, fenced):
            if w not in commands:
                print("command\t%s\tloki %s" % (loc, w))
        for m in DEAD_ENV.finditer(line):
            print("envvar\t%s\t%s" % (loc, m.group(1)))
        for m in OLD_VERSION.finditer(line):
            print("version\t%s\t%s" % (loc, m.group(0)))
