#!/usr/bin/env python3
"""Negative / adversarial tests for the crash scrubber (Crash Reporting Phase 0).

Dual-mode:
  - pytest: collects the test_* functions below (plain asserts). Importing the
    module does NOTHING at top level (no sys.exit), so pytest collection never
    crashes.
  - standalone: `python3 tests/crash/test_crash_redact_negative.py` runs the
    test_* functions under a PASS/FAIL counter and exits nonzero on any failure.

Covers:
  - ReDoS / pathological input: a 200KB string and a deeply nested dict scrub
    fast (under a couple of seconds) and never hang.
  - No /Users/, /home/<name>, raw email, or raw IPv4/IPv6 survive anywhere in
    the JSON-serialized output for a payload that stuffs these into many fields.
    Checked both on surviving (whitelisted) content and via the scrub engine
    directly, so the assertion is not satisfied merely by whitelist drop.
  - Fingerprint + stack_signature stability across two synthetic machines
    (home /Users/jdoe vs /home/alice) for the same logical error+stack.
  - project_id_hash format invariance across https / scp / .git / trailing
    slash forms of the same remote.
  - FAIL CLOSED: garbage / malformed input returns a safe dict, never raises,
    never echoes raw input.
"""

import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.normpath(os.path.join(_HERE, "..", "..", "autonomy", "lib"))
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import crash_redact  # noqa: E402
import proof_redact  # noqa: E402

# Generous bound: a linear scan of 200KB is milliseconds. A backtracking
# (ReDoS) pattern would blow far past this. 2.0s catches a hang without being
# flaky on a loaded CI box.
TIME_BUDGET_S = 2.0

PII = [
    "/Users/jdoe/work",
    "/home/alice/work",
    "admin@example.com",
    "192.168.1.42",
    "fe80:0:0:0:0:0:0:1",
]
PII_FRAGMENTS = ["/Users/", "/home/alice", "admin@example.com", "192.168.1.42", "fe80:"]


# --------------------------------------------------------------------------
# ReDoS guard: 200KB string. Must scrub fast and not hang.
# --------------------------------------------------------------------------
def test_redos_large_string():
    big = ("/Users/jdoe/x admin@example.com 10.0.0.5 Bearer " + "z" * 40 + " ") * 4000
    big = big[:200000]
    t0 = time.time()
    out = crash_redact.scrub_and_whitelist(
        {"error_class": "E", "message": big, "stack": []}
    )
    dt = time.time() - t0
    assert isinstance(out, dict), "200KB input did not return a dict"
    assert dt < TIME_BUDGET_S, "200KB input took %.3fs (budget %.1fs)" % (dt, TIME_BUDGET_S)
    blob = json.dumps(out)
    assert "/Users/" not in blob, "200KB output has /Users/"
    assert "admin@example.com" not in blob, "200KB output has raw email"


# --------------------------------------------------------------------------
# ReDoS guard: deeply nested dict. Very deep nesting can exceed Python's
# recursion limit; scrub_and_whitelist catches that and returns the safe-minimal
# dict (FAIL CLOSED). Either way: a dict, fast, no leak.
# --------------------------------------------------------------------------
def test_redos_deeply_nested_dict():
    deep = cur = {}
    for _ in range(3000):
        cur["k"] = {}
        cur = cur["k"]
    cur["leak"] = "/Users/jdoe ghp_" + "B" * 40
    t0 = time.time()
    out = crash_redact.scrub_and_whitelist(
        {"error_class": "E", "message": "x", "stack": [], "deep": deep}
    )
    dt = time.time() - t0
    assert isinstance(out, dict), "deeply nested input did not return a dict"
    assert dt < TIME_BUDGET_S, "deeply nested input took %.3fs (budget %.1fs)" % (
        dt, TIME_BUDGET_S)
    blob = json.dumps(out)
    assert "/Users/jdoe" not in blob, "deeply nested output has /Users/"
    assert "ghp_BBBB" not in blob, "deeply nested output has raw token"


# --------------------------------------------------------------------------
# No PII survives. Two angles:
#   (a) the scrub ENGINE strips these from any surviving string.
#   (b) the full public output never contains them for a multi-field payload.
# --------------------------------------------------------------------------
def test_engine_strips_pii():
    proof_redact.reset_context()
    for val in ("/Users/jdoe/work", "/home/alice/work"):
        red = proof_redact.redact_value(val)
        assert "/Users/" not in red and "/home/alice" not in red, (
            "engine did not strip home path %r -> %r" % (val, red)
        )
    for val in ("admin@example.com", "192.168.1.42", "fe80:0:0:0:0:0:0:1"):
        red, _ = crash_redact._apply_crash_deny(val, [])
        assert val not in red, "engine deny did not strip %r -> %r" % (val, red)
    proof_redact.reset_context()


def test_full_output_no_pii():
    big_msg = " ".join(PII * 20)
    out = crash_redact.scrub_and_whitelist(
        {
            "error_class": "E " + big_msg,
            "message": big_msg,
            "stack": ["at f (/Users/jdoe/a.ts:1:1)", "at g (/home/alice/b.ts:2:2)"],
            "rarv_phase": "act " + big_msg,
        }
    )
    blob = json.dumps(out)
    for frag in PII_FRAGMENTS:
        assert frag not in blob, "full output has PII fragment %r" % frag


# --------------------------------------------------------------------------
# Fingerprint + stack_signature stability across two synthetic machines.
# --------------------------------------------------------------------------
def test_fingerprint_machine_independent():
    m1 = crash_redact.scrub_and_whitelist(
        {
            "error_class": "TypeError",
            "message": "boom on /Users/jdoe/app.ts",
            "stack": [
                "at handler (/Users/jdoe/src/app.ts:10:5)",
                "at run (/Users/jdoe/src/run.ts:20:7)",
            ],
        }
    )
    m2 = crash_redact.scrub_and_whitelist(
        {
            "error_class": "TypeError",
            "message": "boom on /home/alice/app.ts",
            "stack": [
                "at handler (/home/alice/src/app.ts:10:5)",
                "at run (/home/alice/src/run.ts:20:7)",
            ],
        }
    )
    assert m1["fingerprint"] == m2["fingerprint"], (
        "fingerprint differs across machines (%s vs %s)"
        % (m1["fingerprint"][:12], m2["fingerprint"][:12])
    )
    assert m1["stack_signature"] == m2["stack_signature"], (
        "stack_signature differs across machines (%r vs %r)"
        % (m1["stack_signature"], m2["stack_signature"])
    )
    assert m1["stack_signature"] == ["handler", "run"], (
        "stack_signature not the expected symbol list (got %r)" % m1["stack_signature"]
    )


# --------------------------------------------------------------------------
# project_id_hash format invariance.
# --------------------------------------------------------------------------
def test_project_id_hash_invariance():
    remote_forms = [
        "https://github.com/octocat/repo.git",
        "https://github.com/octocat/repo",
        "https://github.com/octocat/repo/",
        "git@github.com:octocat/repo.git",
        "git@github.com:octocat/repo",
    ]
    hashes = [crash_redact.project_id_hash(r) for r in remote_forms]
    assert len(set(hashes)) == 1, (
        "project_id_hash not invariant across 5 forms (got %d distinct)" % len(set(hashes))
    )
    assert "octocat" not in hashes[0] and "repo" not in hashes[0], (
        "project_id_hash contains the literal owner/repo"
    )
    other = crash_redact.project_id_hash("https://github.com/other/thing.git")
    assert other != hashes[0], "project_id_hash same for a different repo"


# --------------------------------------------------------------------------
# FAIL CLOSED: garbage / malformed input never raises, returns a safe dict with
# no raw input echoed.
# --------------------------------------------------------------------------
def test_fail_closed_on_garbage():
    garbage = [
        None,
        42,
        3.14,
        True,
        "a bare string ghp_" + "B" * 40,
        ["list", "not", "dict"],
        ("tuple",),
    ]
    for g in garbage:
        raised = False
        try:
            r = crash_redact.scrub_and_whitelist(g)
        except Exception:  # noqa: BLE001
            raised = True
            r = None
        assert not raised, "raised on garbage input %r" % (repr(g)[:30])
        assert isinstance(r, dict), "garbage input did not return a dict %r" % (
            repr(g)[:30])
        if not isinstance(g, dict):
            assert r.get("error_class") == "ScrubError", (
                "non-dict garbage not ScrubError shape %r (got %r)"
                % (repr(g)[:30], r.get("error_class"))
            )
            assert "ghp_BBBB" not in json.dumps(r), "garbage output has raw token"


def test_fail_closed_on_unserializable_value():
    class Boom:
        def __repr__(self):
            raise RuntimeError("nope")

    r = crash_redact.scrub_and_whitelist({"error_class": "E", "evil": Boom(), "stack": []})
    assert isinstance(r, dict), "unserializable value did not return a dict (fail closed)"


def test_safe_minimal_shape():
    safe = crash_redact._safe_minimal()
    assert set(safe.keys()) <= set(crash_redact._WHITELIST), (
        "safe-minimal keys not within the whitelist"
    )
    assert safe.get("error_class") == "ScrubError", "safe-minimal not ScrubError shape"


# --------------------------------------------------------------------------
# Standalone runner (guarded; never runs on import / pytest collection).
# --------------------------------------------------------------------------
def _run_standalone():
    tests = sorted(
        (name, obj)
        for name, obj in globals().items()
        if name.startswith("test_") and callable(obj)
    )
    passed = 0
    failed = 0
    for name, fn in tests:
        try:
            fn()
            passed += 1
            print("PASS: " + name)
        except AssertionError as e:
            failed += 1
            print("FAIL: %s -- %s" % (name, e))
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("FAIL: %s -- unexpected %s: %s" % (name, type(e).__name__, e))
    print("")
    print("Total: %d  Passed: %d  Failed: %d" % (passed + failed, passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_standalone())
