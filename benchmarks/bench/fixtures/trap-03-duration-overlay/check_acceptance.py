#!/usr/bin/env python3
"""Held-out acceptance for trap-03-duration. Zero-install (stdlib only).

Each check cites the prompt rule it comes from. The agent never sees this.
"""
import os
import sys

sys.path.insert(0, os.getcwd())
try:
    from duration import parse_duration
except Exception as exc:
    print("FAIL: cannot import duration.parse_duration: %s" % exc)
    sys.exit(1)

fails = []


def ok(s, want):
    try:
        got = parse_duration(s)
    except Exception as exc:
        fails.append("%r: raised %s, want %r" % (s, type(exc).__name__, want))
        return
    if got != want or type(got) is not int:
        fails.append("%r: got %r want %r" % (s, got, want))


def bad(rule, s):
    try:
        got = parse_duration(s)
    except ValueError:
        return
    except Exception as exc:
        fails.append("rule %s %r: raised %s, want ValueError" % (rule, s, type(exc).__name__))
        return
    fails.append("rule %s %r: returned %r, want ValueError" % (rule, s, got))


# Rule 1: valid forms.
ok("10s", 10)
ok("90m", 5400)
ok("1d", 86400)
# Rule 2: each unit at most once.
bad(2, "1h1h")
bad(2, "5m10m")
# Rule 3: descending unit order d, h, m, s.
bad(3, "30m1h")
bad(3, "10s5m")
# Rule 4: empty, blank, unknown unit, missing number, negative or decimal number.
bad(4, "")
bad(4, "   ")
bad(4, "1x")
bad(4, "h")
bad(4, "-1h")
bad(4, "1.5h")
bad(1, "1h junk")
# Rule 5: a bare number has no unit.
bad(5, "5")
bad(5, "1h30")

if fails:
    for f in fails:
        print("FAIL: " + f)
    sys.exit(1)
print("OK: all duration cases pass")
sys.exit(0)
