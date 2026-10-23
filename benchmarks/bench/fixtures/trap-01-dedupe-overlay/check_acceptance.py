#!/usr/bin/env python3
"""Held-out acceptance for trap-01-dedupe. Zero-install (stdlib only).

Each check cites the prompt rule it comes from. The agent never sees this.
"""
import os
import sys

sys.path.insert(0, os.getcwd())
try:
    from dedupe import dedupe
except Exception as exc:
    print("FAIL: cannot import dedupe.dedupe: %s" % exc)
    sys.exit(1)

fails = []


def check(label, fn, want):
    try:
        got = fn()
    except Exception as exc:
        fails.append("%s: raised %s: %s" % (label, type(exc).__name__, exc))
        return
    if got != want:
        fails.append("%s: got %r want %r" % (label, got, want))


# Rule 1: first occurrence, original order, new list.
check("order", lambda: dedupe([2, 1, 2, 3, 1]), [2, 1, 3])
check("empty", lambda: dedupe([]), [])
# Rule 2: with key, the first item of each key group is kept.
check("key-first", lambda: dedupe(["bb", "a", "cc", "d"], key=len), ["bb", "a"])
# Rule 3: key may return unhashable values, compared by equality.
check("unhashable-key", lambda: dedupe([[1], [1, 2], [1], [1, 2]], key=lambda x: x), [[1], [1, 2]])
check("unhashable-key-derived", lambda: dedupe([(1, 2), (3, 4), (5, 6)], key=lambda t: [t[0] % 2]), [(1, 2)])
# Rule 4: the input list is not modified, and the result is a new list.
src = [1, 1, 2]
out = dedupe(src)
if src != [1, 1, 2]:
    fails.append("no-mutate: input became %r" % (src,))
if out is src:
    fails.append("no-mutate: returned the input list object")

if fails:
    for f in fails:
        print("FAIL: " + f)
    sys.exit(1)
print("OK: all dedupe cases pass")
sys.exit(0)
