#!/usr/bin/env python3
"""Held-out acceptance for trap-05-lru. Zero-install (stdlib only).

Each check cites the prompt rule it comes from. The agent never sees this.
"""
import os
import sys
import time

sys.path.insert(0, os.getcwd())
try:
    from lru import LRUCache
except Exception as exc:
    print("FAIL: cannot import lru.LRUCache: %s" % exc)
    sys.exit(1)

fails = []

# Rule 2: putting an existing key updates its value and marks it most recently used.
c = LRUCache(2)
c.put("a", 1)
c.put("b", 2)
c.put("a", 10)
c.put("c", 3)
if c.get("b") is not None:
    fails.append("rule 2: put of an existing key did not refresh it, 'b' survived")
if c.get("a") != 10:
    fails.append("rule 2: put of an existing key did not update the value: %r" % (c.get("a"),))
if len(c) != 2:
    fails.append("rule 1: len %r want 2" % (len(c),))

# Rule 3: capacity 0 stores nothing.
z = LRUCache(0)
z.put("a", 1)
if len(z) != 0 or z.get("a") is not None:
    fails.append("rule 3: capacity 0 stored an entry")

# Rule 4: 200000 mixed operations on capacity 50000 finish within 5 seconds.
big = LRUCache(50000)
start = time.monotonic()
done = 0
for i in range(200000):
    if i % 2 == 0:
        big.put(i, i)
    else:
        big.get(i - 1)
    done += 1
    if i % 1000 == 0 and time.monotonic() - start > 5:
        break
elapsed = time.monotonic() - start
if done < 200000 or elapsed > 5:
    fails.append("rule 4: %d of 200000 operations done in %.1fs (limit 5s)" % (done, elapsed))
if len(big) > 50000:
    fails.append("rule 1: len %d exceeds capacity 50000" % len(big))

if fails:
    for f in fails:
        print("FAIL: " + f)
    sys.exit(1)
print("OK: all lru cases pass")
sys.exit(0)
