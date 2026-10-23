#!/usr/bin/env python3
"""Held-out acceptance for trap-02-ratelimit. Zero-install (stdlib only).

Each check cites the prompt rule it comes from. The agent never sees this.
"""
import os
import sys

sys.path.insert(0, os.getcwd())
try:
    from ratelimit import Limiter
except Exception as exc:
    print("FAIL: cannot import ratelimit.Limiter: %s" % exc)
    sys.exit(1)

fails = []


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def seq(label, max_calls, window, steps):
    """steps: list of (time, key, expected)."""
    clock = Clock()
    try:
        lim = Limiter(max_calls, window, clock=clock)
        for t, key, want in steps:
            clock.t = t
            got = lim.allow(key)
            if got is not want:
                fails.append("%s: t=%s key=%s got %r want %r" % (label, t, key, got, want))
    except Exception as exc:
        fails.append("%s: raised %s: %s" % (label, type(exc).__name__, exc))


# Rule 2: a call exactly window_s old no longer counts.
seq("boundary", 1, 10, [(0, "a", True), (9.99, "a", False), (10, "a", True)])
# Rule 3: keys are independent.
seq("keys", 1, 10, [(0, "a", True), (0, "b", True), (1, "a", False), (1, "b", False)])
# Rule 4: a rejected call is not recorded, so it does not extend the window.
seq("rejected-not-recorded", 1, 10, [(0, "a", True), (5, "a", False), (10, "a", True)])
# Rule 1: exactly max_calls are allowed inside one window.
seq("count", 3, 10, [(0, "a", True), (1, "a", True), (2, "a", True), (3, "a", False)])

if fails:
    for f in fails:
        print("FAIL: " + f)
    sys.exit(1)
print("OK: all ratelimit cases pass")
sys.exit(0)
