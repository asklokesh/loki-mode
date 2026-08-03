#!/usr/bin/env python3
"""Held-out acceptance for hard-2-ledger. The agent never sees this file.

WHY THIS TASK EXISTS. Measured 2026-07-31: haiku with the harness DISABLED
passed hard-1-order-api on the first trial, and every baseline failure in the
corpus was on simple-2-fizzbuzz. A suite whose only failures are on its
simplest task has no discriminating power -- more trials buy a tighter
interval around a ceiling, at any price.

hard-1-order-api hands the model every rule explicitly, including boundary
cases and worked examples. It measures instruction-following.

This task withholds them on purpose. The prompt says "obey the fundamental
accounting rule" without stating it, requires atomicity without describing a
rollback, and says money "must not drift" without naming Decimal. Each is a
thing a careful implementer does and a one-shot draft skips -- which is
precisely the gap a harness is supposed to close through iteration and review.

Exits 0 only if every assertion passes.
"""

import os
import sys
import importlib

# THE TASK WAS UNPASSABLE WITHOUT THIS LINE.
#
# The grader runs with the agent's workdir as cwd, but cwd is NOT on
# sys.path for a script invoked by absolute path. So `import_module("ledger")`
# could never find a correct ledger.py, and EVERY agent -- Loki, raw Claude,
# any competitor -- scored FAIL for a reason that has nothing to do with its
# output.
#
# Proven with one artifact, two runs:
#   without cwd on sys.path -> "FAIL: cannot import ledger.py"
#   with PYTHONPATH set     -> "PASS: all ledger assertions hold"
#
# hard-1-order-api-overlay has carried `sys.path.insert(0, os.getcwd())`
# since it was written; this file was missing it. That asymmetry is why
# hard-1 discriminates and hard-2 read as a universal failure.
#
# A benchmark task that cannot be passed is worse than a missing one: it
# reports every tool as equally bad and looks like a finding.
sys.path.insert(0, os.getcwd())

try:
    led = importlib.import_module("ledger")
except Exception as exc:  # noqa: BLE001
    print(f"FAIL: cannot import ledger.py: {exc}")
    sys.exit(1)

for fn in ("post", "balance", "reconcile"):
    if not hasattr(led, fn):
        print(f"FAIL: ledger.py does not define {fn}()")
        sys.exit(1)

failures = []


def check(desc, fn):
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{desc}: raised {type(exc).__name__}: {exc}")
        return
    if not ok:
        failures.append(f"{desc}: {detail}")


def status_of(r):
    if not isinstance(r, tuple) or len(r) != 2:
        raise AssertionError(f"expected (status, body) tuple, got {r!r}")
    return r[0], r[1]


# --- the rule the prompt refuses to state -----------------------------------
# Double-entry: every posting must sum to zero. A model that treats `post` as
# "append these rows" passes nothing below.
def unbalanced_rejected():
    s, b = status_of(led.post([{"account": "cash", "amount": 100}]))
    if s != 400:
        return False, f"single-sided post accepted with status {s}"
    if not isinstance(b, dict) or "error" not in b:
        return False, f"rejection body missing 'error': {b!r}"
    return True, ""


def balanced_accepted():
    s, _ = status_of(
        led.post(
            [
                {"account": "cash", "amount": 100},
                {"account": "revenue", "amount": -100},
            ]
        )
    )
    return (s == 200), f"balanced post rejected with status {s}"


check("unbalanced post is rejected", unbalanced_rejected)
check("balanced post is accepted", balanced_accepted)


# --- atomicity: a rejected post must not mutate state -----------------------
def rejected_post_is_atomic():
    before = status_of(led.balance("cash"))[1].get("balance")
    led.post(
        [
            {"account": "cash", "amount": 50},
            {"account": "revenue", "amount": -49},  # unbalanced by 1
        ]
    )
    after = status_of(led.balance("cash"))[1].get("balance")
    if before != after:
        return False, f"rejected post mutated cash: {before} -> {after}"
    return True, ""


def partial_failure_is_atomic():
    before = status_of(led.balance("cash"))[1].get("balance")
    led.post(
        [
            {"account": "cash", "amount": 10},
            {"account": "revenue", "amount": -10},
            {"account": "bogus", "amount": "not-a-number"},
        ]
    )
    after = status_of(led.balance("cash"))[1].get("balance")
    if before != after:
        return False, f"partially-invalid post was applied: {before} -> {after}"
    return True, ""


check("rejected post leaves state unchanged", rejected_post_is_atomic)
check("partially-invalid post is all-or-nothing", partial_failure_is_atomic)


# --- money must not drift ---------------------------------------------------
# 0.1 + 0.2 in binary float is 0.30000000000000004. A correct implementation
# uses Decimal or integer cents; the prompt says only "must not drift".
def no_float_residue():
    led.post([{"account": "a", "amount": 0.1}, {"account": "b", "amount": -0.1}])
    led.post([{"account": "a", "amount": 0.2}, {"account": "b", "amount": -0.2}])
    bal = status_of(led.balance("a"))[1].get("balance")
    if bal is None:
        return False, "balance('a') returned no 'balance' key"
    if abs(float(bal) - 0.3) > 1e-9 or str(bal).startswith("0.30000000000000"):
        return False, f"float residue in balance: {bal!r}"
    return True, ""


check("0.1 + 0.2 does not leave float residue", no_float_residue)


# --- validation -------------------------------------------------------------
def rejects_malformed():
    for bad in (None, {}, [], "entries", [{"account": "x"}], [{"amount": 1}]):
        s, _ = status_of(led.post(bad))
        if s != 400:
            return False, f"accepted malformed input {bad!r} with status {s}"
    return True, ""


check("malformed input is rejected", rejects_malformed)


# --- reconcile reports real state ------------------------------------------
def reconcile_reports_consistent():
    s, b = status_of(led.reconcile())
    if s != 200:
        return False, f"reconcile returned status {s}"
    if not isinstance(b, dict) or not b:
        return False, f"reconcile body is empty or not a dict: {b!r}"
    return True, ""


def unknown_account_is_not_silently_zero():
    s, b = status_of(led.balance("no-such-account-xyz"))
    if s == 200 and b.get("balance") in (0, 0.0):
        return False, "unknown account silently reported balance 0"
    return True, ""


check("reconcile reports consistency", reconcile_reports_consistent)
check("unknown account is not silently zero", unknown_account_is_not_silently_zero)


if failures:
    print(f"FAIL ({len(failures)}):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print("PASS: all ledger assertions hold")
sys.exit(0)
