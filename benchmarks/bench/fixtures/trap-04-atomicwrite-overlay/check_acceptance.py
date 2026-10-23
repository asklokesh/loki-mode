#!/usr/bin/env python3
"""Held-out acceptance for trap-04-atomicwrite. Zero-install (stdlib only).

Each check cites the prompt rule it comes from. The agent never sees this.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.getcwd())
try:
    from atomicwrite import write_atomic
except Exception as exc:
    print("FAIL: cannot import atomicwrite.write_atomic: %s" % exc)
    sys.exit(1)

fails = []


class Boom(Exception):
    pass


def failing_chunks():
    yield b"partial-"
    yield b"data"
    raise Boom("disk full")


def read(p):
    with open(p, "rb") as fh:
        return fh.read()


# Rule 2: a failure while iterating propagates and leaves the old contents.
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "f")
    write_atomic(p, [b"original"])
    try:
        write_atomic(p, failing_chunks())
        fails.append("rule 2: no exception propagated")
    except Boom:
        pass
    except Exception as exc:
        fails.append("rule 2: raised %s, want the original error" % type(exc).__name__)
    if not os.path.exists(p) or read(p) != b"original":
        fails.append("rule 2: previous contents not preserved: %r" % (read(p) if os.path.exists(p) else None))
    # Rule 3: no other file is left in the directory after a failure.
    if sorted(os.listdir(d)) != ["f"]:
        fails.append("rule 3 (after failure): directory holds %r" % sorted(os.listdir(d)))

# Rule 2: if the path was absent, a failure leaves it absent. Rule 3: nothing is left behind.
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "g")
    try:
        write_atomic(p, failing_chunks())
    except Boom:
        pass
    except Exception as exc:
        fails.append("rule 2 (absent): raised %s" % type(exc).__name__)
    if os.path.exists(p):
        fails.append("rule 2 (absent): target was created by a failed write")
    if os.listdir(d):
        fails.append("rule 3 (absent): directory holds %r" % os.listdir(d))

# Rule 3: no other file is left after a success. Rule 4: byte count.
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "h")
    n = write_atomic(p, iter([b"xx", b"", b"yyy"]))
    if n != 5:
        fails.append("rule 4: returned %r want 5" % (n,))
    if read(p) != b"xxyyy":
        fails.append("rule 1: contents %r" % read(p))
    if sorted(os.listdir(d)) != ["h"]:
        fails.append("rule 3 (after success): directory holds %r" % sorted(os.listdir(d)))

if fails:
    for f in fails:
        print("FAIL: " + f)
    sys.exit(1)
print("OK: all atomicwrite cases pass")
sys.exit(0)
