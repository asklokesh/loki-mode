"""Fixture unit for tests/test-modernize-py-capture.sh (M-09).

Written in 2/3-compatible style (this machine has no python2.7 to execute
it under, so the test runs it under python3; the tracer itself is
interpreter-agnostic). Exercises what py_capture.py must capture:

- classify(): two branch points (`n > 0`, `label == "bytes"`), four branch
  outcomes total. The fixture's cases cover three of the four on purpose,
  leaving one uncovered as the coverage test's negative control. Also
  writes a file under the traced call's cwd and prints to stdout.
- echo_text(): a plain text-in/text-out call used to test the boundary
  declaration contract (declared vs undeclared vs mismatched).
- mixed_dict(): returns a dict with non-string keys, to exercise the
  type-tagged dict format's sorted-pairs encoding.
- explode(): always raises, to exercise exception capture.
- exotic_values(): one of each type py_capture can now type-tag faithfully
  beyond the JSON-native ones (set, frozenset, Decimal, datetime, date,
  time, bytearray), to exercise those tags round-trip.
- unsupported_value(): returns a plain custom-class instance, which
  py_capture cannot type-tag faithfully, to exercise the not_proven path
  for unsupported types (docs/v10/MODERNIZE.md section 7 honest-verdict
  rule).
"""
from __future__ import print_function

import datetime
from decimal import Decimal


def classify(n, label):
    print("classifying", n)
    if n > 0:
        sign = "positive"
    else:
        sign = "non-positive"

    if label == "bytes":
        payload = b"binary-" + sign.encode("ascii")
    else:
        payload = u"text-" + sign

    with open("receipt.txt", "w") as fh:
        fh.write(sign)

    return {"n": n, "sign": sign, "payload": payload, "ok": True}


def echo_text(s):
    return s


def mixed_dict():
    # Insertion order is deliberately NOT the sorted order (tuple, text, int)
    # so a test that skips the type-tagged sort would still fail on key order.
    return {(3, 4): "tuple-key", "two": 2, 1: "one"}


def explode(message):
    raise ValueError(message)


def exotic_values():
    return {
        "s": set([3, 1, 2]),
        "fs": frozenset([5, 4]),
        "d": Decimal("2.50"),
        "dt": datetime.datetime(2024, 1, 2, 3, 4, 5, 6),
        "date": datetime.date(2024, 1, 2),
        "time": datetime.time(3, 4, 5, 6),
        "ba": bytearray(b"hi"),
    }


class _NotProvable(object):
    """A plain custom class: py_capture has no faithful tag for an instance
    of this, so it must surface as {"t": "unsupported", ...} and a
    not_proven entry, never as silently-equal to another instance."""

    def __init__(self, n):
        self.n = n


def unsupported_value():
    return _NotProvable(7)
