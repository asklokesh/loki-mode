"""The MCP tool surface is machine-consumed, so a fabricated zero is worse here.

loki_agent_metrics (mcp/server.py) hands per-iteration efficiency records to
ANOTHER AGENT, which does budget accounting on them and decides whether a run
is cheap enough to continue. It used to append the raw record verbatim, so the
real FireLater case -- four efficiency records, every token field 0 because
codex wrote no usage before v8.51.0 -- came back as:

    {"cost_usd": 0, "input_tokens": 0, ...}

That asserts the run was FREE. It was not free; it was UNMEASURED. This is the
same class the repo spent six releases on (v8.51.0-v8.54.0) for the receipt,
the prompt, and the verifier -- but on a surface where no human is present to
sanity-check the number before it propagates into another system's decision.

The measured/unmeasured decision is NOT restated here. It is delegated to
record_is_measured() in autonomy/lib/efficiency_cost.py, whose docstring says a
second copy of that predicate is precisely how the honesty rule drifts. This
test asserts the MCP surface obeys the same rule the receipt does.

BOTH DIRECTIONS are asserted, because an over-strict fix is its own dishonesty:

  1. all-zero record   -> cost/token fields read null, not 0   (the defect)
  2. genuine nonzero   -> passes through completely unchanged  (not suppressed)
  3. cost_usd=0.002 with input_tokens=0 -> measured, and that input_tokens
     stays 0. This is the v8.72.0 trap: 0 is falsy, so a falsy per-field guard
     would blank a REAL measured zero. The guard must be an explicit None/
     whole-record check.
"""

import asyncio
import json
import os
import pathlib
import sys
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

# Two distinct hazards, both observed:
#
# 1. mcp/server.py calls sys.exit(1) at MODULE SCOPE when the MCP SDK is absent
#    (server.py:536). A bare import raises SystemExit, not ImportError, which
#    pytest reports as an INTERNALERROR that kills the ENTIRE run at collection.
#
# 2. `mcp` is ALSO the name of the installed SDK package. In a full-suite run
#    another test imports the SDK first, so `from mcp import server` can resolve
#    to the SDK's own `server` submodule -- a real module that imports cleanly
#    and has none of our functions. Catching exceptions cannot detect that; the
#    import SUCCEEDS and the tests then fail on AttributeError.
#
# So the guard is a CAPABILITY check, not an exception check: skip unless the
# module we actually got is ours. An unusable module is an absent measurement.
try:
    from mcp import server  # noqa: E402
except (ImportError, SystemExit) as _exc:  # pragma: no cover - env dependent
    import pytest
    pytest.skip(
        "MCP SDK unavailable on this interpreter ({}); "
        "mcp/server.py exits at import without it".format(type(_exc).__name__),
        allow_module_level=True)

if not hasattr(server, "loki_agent_metrics"):  # pragma: no cover - env dependent
    import pytest
    pytest.skip(
        "'from mcp import server' resolved to {}, which is not loki's "
        "mcp/server.py -- the installed MCP SDK shadowed it".format(
            getattr(server, "__file__", "an unknown module")),
        allow_module_level=True)


def _write_records(tmpdir, records):
    """Lay down .loki/metrics/efficiency/iteration-N.json under tmpdir."""
    eff = pathlib.Path(tmpdir) / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    for i, rec in enumerate(records, start=1):
        (eff / f"iteration-{i}.json").write_text(json.dumps(rec))
    return eff


def _call_agent_metrics(tmpdir):
    """Call the REAL tool function against tmpdir and return parsed JSON.

    get_project_root() is os.path.realpath(os.getcwd()), so chdir is the whole
    fixture mechanism. The tool is async and carries no .fn wrapper, so it is
    driven with asyncio.run rather than a pytest-asyncio dependency.
    """
    prev = os.getcwd()
    try:
        os.chdir(tmpdir)
        return json.loads(asyncio.run(server.loki_agent_metrics()))
    finally:
        os.chdir(prev)


_ZERO_RECORD = {
    "iteration": 1,
    "model": "codex",
    "cost_usd": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_creation_tokens": 0,
}

_REAL_RECORD = {
    "iteration": 1,
    "model": "claude-opus-4",
    "cost_usd": 1.2345,
    "input_tokens": 5000,
    "output_tokens": 900,
    "cache_read_tokens": 120,
    "cache_creation_tokens": 30,
}

_COST_ONLY_RECORD = {
    "iteration": 1,
    "model": "claude-haiku",
    "cost_usd": 0.002,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_creation_tokens": 0,
}

_MEASURED_FIELDS = (
    "cost_usd",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
)


class TestAgentMetricsHonesty(unittest.TestCase):

    def setUp(self):
        import shutil
        import tempfile
        # The tool emits its start/complete events on a BACKGROUND thread that
        # writes into .loki/events/pending under the fixture dir. That thread
        # can still be writing when the test returns, so a strict rmtree races
        # it (OSError: Directory not empty). The events are not under test.
        self.tmpdir = tempfile.mkdtemp(prefix="loki-mcp-metrics-")
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)

    # -- direction 1: the defect ------------------------------------------

    def test_all_zero_record_reads_unknown_never_zero(self):
        """A run we failed to measure must not report itself as free."""
        _write_records(self.tmpdir, [_ZERO_RECORD])
        out = _call_agent_metrics(self.tmpdir)

        self.assertEqual(len(out["agents"]), 1)
        agent = out["agents"][0]
        for field in _MEASURED_FIELDS:
            self.assertIsNone(
                agent[field],
                f"{field} must read null when nothing was measured, got "
                f"{agent[field]!r}. A zero here asserts the run was FREE.",
            )
        self.assertIs(agent["measured"], False)
        # Non-measurement fields are untouched -- we blank the claim, not the
        # record's identity.
        self.assertEqual(agent["model"], "codex")
        self.assertEqual(agent["iteration"], 1)

    def test_zero_is_not_rendered_as_zero_in_the_json_text(self):
        """Guard the wire format, not just the parsed dict.

        A consumer reading the raw JSON string must not find a 0 cost either.
        """
        _write_records(self.tmpdir, [_ZERO_RECORD])
        prev = os.getcwd()
        try:
            os.chdir(self.tmpdir)
            raw = asyncio.run(server.loki_agent_metrics())
        finally:
            os.chdir(prev)
        self.assertIn('"cost_usd": null', raw)
        self.assertNotIn('"cost_usd": 0', raw)

    # -- direction 2: an over-strict fix must not suppress real data -------

    def test_genuine_measurement_passes_through_unchanged(self):
        """Real numbers must survive verbatim; blanking them is its own lie."""
        _write_records(self.tmpdir, [_REAL_RECORD])
        out = _call_agent_metrics(self.tmpdir)

        agent = out["agents"][0]
        for field in _MEASURED_FIELDS:
            self.assertEqual(
                agent[field], _REAL_RECORD[field],
                f"{field} was measured and must pass through unchanged",
            )
        # No spurious measured=False stamped onto a real record.
        self.assertNotEqual(agent.get("measured"), False)

    def test_measured_zero_is_preserved_not_blanked(self):
        """v8.72.0 trap: 0 is falsy, and a falsy guard would blank real data.

        cost_usd=0.002 makes this record MEASURED, so its genuine zero token
        counts are observed facts and must stay 0 -- not become null.
        """
        _write_records(self.tmpdir, [_COST_ONLY_RECORD])
        out = _call_agent_metrics(self.tmpdir)

        agent = out["agents"][0]
        self.assertEqual(agent["cost_usd"], 0.002)
        for field in (
            "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_creation_tokens",
        ):
            self.assertEqual(
                agent[field], 0,
                f"{field} is a MEASURED zero and must stay 0, not null. "
                "Blanking it would suppress a genuine result.",
            )
        self.assertNotEqual(agent.get("measured"), False)

    # -- mixed: per-record, not per-run -----------------------------------

    def test_records_are_judged_individually(self):
        """One unmeasured iteration must not blank a measured sibling."""
        _write_records(self.tmpdir, [_ZERO_RECORD, _REAL_RECORD])
        out = _call_agent_metrics(self.tmpdir)

        self.assertEqual(out["agent_count"], 2)
        by_model = {a["model"]: a for a in out["agents"]}
        self.assertIsNone(by_model["codex"]["cost_usd"])
        self.assertEqual(by_model["claude-opus-4"]["cost_usd"], 1.2345)
        self.assertEqual(by_model["claude-opus-4"]["input_tokens"], 5000)

    def test_no_records_yields_empty_not_a_zero_claim(self):
        """No efficiency dir at all: report nothing, never a zero cost."""
        out = _call_agent_metrics(self.tmpdir)
        self.assertEqual(out["agents"], [])
        self.assertEqual(out["agent_count"], 0)


class TestPredicateIsNotRestated(unittest.TestCase):
    """The rule must be the SAME CODE the receipt uses, not a lookalike."""

    def test_server_uses_the_canonical_predicate(self):
        sys.path.insert(0, str(_ROOT / "autonomy" / "lib"))
        from efficiency_cost import record_is_measured
        self.assertIs(
            server.record_is_measured, record_is_measured,
            "mcp/server.py must import record_is_measured from "
            "autonomy/lib/efficiency_cost.py, never restate it.",
        )


if __name__ == "__main__":
    unittest.main()
