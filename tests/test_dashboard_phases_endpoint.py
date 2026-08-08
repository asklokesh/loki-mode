#!/usr/bin/env python3
"""/api/phases serves api_phases.phase_history's envelope verbatim.

THE GAP THIS CLOSES. dashboard/api_phases.py had no importer in server.py and
no consumer in the UI: 262 lines of real phase-timeline parsing, unreachable.

WHAT IS ASSERTED. Not "the route exists" -- that a route exists proves nothing
about what it serves. The load-bearing assertion is that the envelope comes
back UNRESHAPED, because the honesty contract lives in its shape: an unmeasured
start is None and never 0, an unreadable log reads differently from an empty
one, and `sampled` says the history can be missing short phases. A handler that
rebuilt a "cleaner" dict is where those distinctions die.

Run: python3 -m pytest tests/test_dashboard_phases_endpoint.py -q
or:  python3 tests/test_dashboard_phases_endpoint.py
"""

import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dashboard import api_phases  # noqa: E402


def _events(dirpath, lines):
    with open(os.path.join(dirpath, "events.jsonl"), "w") as fh:
        for ln in lines:
            fh.write(json.dumps(ln) + "\n")


def _ev(ts, frm, to, it):
    return {"timestamp": ts, "type": "phase_change",
            "data": {"from": frm, "to": to, "iteration": it}}


def test_envelope_keys_are_the_modules_own():
    """The contract the panel reads. A missing key is a silent panel."""
    with tempfile.TemporaryDirectory() as d:
        _events(d, [_ev("2026-08-08T10:00:00Z", "BOOTSTRAP", "BUILDING", 1)])
        env = api_phases.phase_history(d)
    for key in ("segments", "leading_phase", "source", "freshness_s",
                "reason", "checked_at", "sampled"):
        assert key in env, "envelope lost key %r" % key
    seg = env["segments"][0]
    for key in ("phase", "start", "end", "ongoing", "iteration"):
        assert key in seg, "segment lost key %r" % key


def test_unmeasured_is_none_never_zero():
    """The whole honesty rule in one assertion.

    The leading phase RAN but its start was never emitted, and the final phase
    is still running so its end is unrecorded. Both must be None. A 0 here
    reads as "started at the epoch" / "ended instantly" -- a fabricated claim
    that the panel would then render as a real timestamp.
    """
    with tempfile.TemporaryDirectory() as d:
        _events(d, [_ev("2026-08-08T10:00:00Z", "BOOTSTRAP", "BUILDING", 1)])
        env = api_phases.phase_history(d)
    assert env["leading_phase"]["start"] is None
    assert env["leading_phase"]["start"] != 0
    assert env["segments"][-1]["end"] is None
    assert env["segments"][-1]["ongoing"] is True


def test_ongoing_distinguishes_running_from_ended():
    """Two segments, one closed and one open. Collapsing them would show a
    stalled build as a finished one -- the false-green class this repo keeps
    getting bitten by."""
    with tempfile.TemporaryDirectory() as d:
        _events(d, [_ev("2026-08-08T10:00:00Z", "BOOTSTRAP", "BUILDING", 1),
                    _ev("2026-08-08T10:05:00Z", "BUILDING", "TESTING", 2)])
        env = api_phases.phase_history(d)
    assert env["segments"][0]["ongoing"] is False
    assert env["segments"][0]["end"] is not None
    assert env["segments"][1]["ongoing"] is True
    assert env["segments"][1]["end"] is None
    # POSITIVE CONTROL: the closed segment carries its REAL 300s duration, so
    # "never fabricate" cannot pass by measuring nothing at all.
    dur = env["segments"][0]["end"] - env["segments"][0]["start"]
    assert dur == 300, "measured duration lost: %r" % dur


def test_phase_names_pass_through_verbatim():
    """An unrecognised phase name is NOT mapped onto a known label. Rendering
    'BOOTSTRAP' as 'Idle' is the same class of lie as a simulated timeline."""
    with tempfile.TemporaryDirectory() as d:
        _events(d, [_ev("2026-08-08T10:00:00Z", "A", "WIDGET_FROBNICATION", 1)])
        env = api_phases.phase_history(d)
    assert env["segments"][0]["phase"] == "WIDGET_FROBNICATION"


def test_absent_and_empty_have_DIFFERENT_reasons():
    """A dashboard that renders an unreadable log identically to an empty one
    reports healthy on a broken disk."""
    with tempfile.TemporaryDirectory() as d:
        absent = api_phases.phase_history(d)
        open(os.path.join(d, "events.jsonl"), "w").close()
        empty = api_phases.phase_history(d)
    assert absent["segments"] == [] and absent["reason"]
    assert empty["segments"] == [] and empty["reason"]
    assert absent["reason"] != empty["reason"], "no-data cases collapsed"


def test_sampled_is_declared():
    """The panel labels sampled data as sampled. It can only do that if the
    envelope says so."""
    with tempfile.TemporaryDirectory() as d:
        _events(d, [_ev("2026-08-08T10:00:00Z", "A", "B", 1)])
        env = api_phases.phase_history(d)
    assert env["sampled"] is True


def test_freshness_none_when_nothing_contributed():
    """None, not 0. '0s ago' reads as fresh when it means not measured."""
    with tempfile.TemporaryDirectory() as d:
        env = api_phases.phase_history(d)
    assert env["freshness_s"] is None


def test_malformed_line_does_not_blank_the_history():
    """events.jsonl is appended to by concurrent shell writers, so a torn final
    line is normal operation and must not erase the records behind it."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "events.jsonl")
        with open(path, "w") as fh:
            fh.write(json.dumps(_ev("2026-08-08T10:00:00Z", "A", "B", 1)) + "\n")
            fh.write('{"type":"phase_change","data":{"to":"C"')  # torn
        env = api_phases.phase_history(d)
    assert len(env["segments"]) == 1
    assert env["segments"][0]["phase"] == "B"


def test_server_returns_the_envelope_unreshaped():
    """The route's handler must RETURN phase_history's result directly.

    Checked on the AST rather than by string-matching the source: a grep for
    'phase_history' matches the docstring explaining the rule, which is how a
    text guard passes on its own documentation.
    """
    import ast
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    tree = ast.parse(open(os.path.join(root, "dashboard", "server.py")).read())
    handler = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) \
                and node.name == "phase_timeline":
            handler = node
    assert handler is not None, "/api/phases handler not found in server.py"
    rets = [n for n in ast.walk(handler) if isinstance(n, ast.Return)]
    assert len(rets) == 1, "handler has %d returns; expected one" % len(rets)
    val = rets[0].value
    assert isinstance(val, ast.Call) and isinstance(val.func, ast.Attribute) \
        and val.func.attr == "phase_history", \
        "handler reshapes the envelope instead of returning it verbatim"


def test_route_is_registered_and_scoped_as_a_sensitive_read():
    """It serves workspace phase history and source paths, so it must sit
    behind the same anonymous-remote guard as every comparable read."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(root, "dashboard", "server.py")).read()
    assert '@app.get("/api/phases"' in src, "route not registered"
    assert '"/api/phases",' in src, "/api/phases not in _SENSITIVE_READ_PREFIXES"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(list(globals().items())):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print("  PASS: %s" % name)
        except AssertionError as exc:
            print("  FAIL: %s -- %s" % (name, exc))
            failures += 1
    print("\n  Failed: %d" % failures)
    sys.exit(1 if failures else 0)
