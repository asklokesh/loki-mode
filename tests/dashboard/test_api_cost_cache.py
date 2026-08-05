"""The dashboard's cost endpoint must price and report cache tokens.

Fifth surface in this chain, and the third route carrying the identical
cache-pricing bug. bash `check_budget_limit` and the TypeScript budget breaker
were fixed in v8.12; `/api/cost` still summed input and output only, and its
cost fallback `_calculate_model_cost(model, inp, out)` had no cache parameters
at all.

Two consequences on the surface a user actually watches while a build runs:

  - the token count described roughly 1% of the run, since cache reads are
    typically ~98% of input volume
  - when an iteration record had no cost_usd (the degraded path, where a
    runaway is most likely), the estimate under-counted about 5x

The rates match the other two routes exactly, so one run cannot report three
different spends depending on which surface you look at.

THE PROPERTY: with nothing read in, cache_hit_ratio is None, never 0.0. A zero
is a claim about a COLD cache -- real, expensive, worth investigating -- so
emitting it for a run with no data would send someone hunting a caching problem
that does not exist.
"""

import pathlib
import unittest

_SERVER = pathlib.Path(__file__).resolve().parents[2] / "dashboard" / "server.py"


def _load_calculator():
    """Exec just the cost calculator, with a pinned pricing table.

    Importing the whole FastAPI app would pull the full dependency tree; the
    arithmetic is what is under test.
    """
    src = _SERVER.read_text(encoding="utf-8")
    start = src.index("def _calculate_model_cost")
    end = src.index('@app.get("/api/cost"')
    ns = {}
    stub = (
        "def _get_model_pricing():\n"
        "    return {'sonnet': {'input': 3.0, 'output': 15.0,\n"
        "                       'cache_read': 0.3, 'cache_write': 3.75},\n"
        "            'nocache': {'input': 3.0, 'output': 15.0}}\n"
    )
    exec(stub + src[start:end], ns)  # noqa: S102 - deliberate, scoped
    return ns["_calculate_model_cost"]


# The measured real-world shape, same fixture the other two routes are tested on.
INP, OUT, CREAD, CWRITE = 10272, 6164, 797496, 79769


class ApiCostCacheTests(unittest.TestCase):
    def setUp(self):
        self.calc = _load_calculator()

    def test_cache_tokens_are_not_free(self):
        without = self.calc("sonnet", INP, OUT)
        with_cache = self.calc("sonnet", INP, OUT, CREAD, CWRITE)
        self.assertGreater(
            with_cache, without * 4,
            "cache tokens priced at or near zero; on the measured shape they "
            "are ~98% of input volume")

    def test_matches_the_other_two_routes(self):
        """One run must not report three different spends.

        bash check_budget_limit and the TS budget breaker both produce 0.6617
        for this record. A third answer here would mean the surface a user
        watches disagrees with the breaker that stops their run.
        """
        self.assertAlmostEqual(
            self.calc("sonnet", INP, OUT, CREAD, CWRITE), 0.6617, places=3)

    def test_records_without_cache_fields_are_unchanged(self):
        """Back-compat: pre-v6.82.0 records have no cache keys."""
        self.assertAlmostEqual(
            self.calc("sonnet", 1_000_000, 0), 3.0, places=6)

    def test_unpriced_cache_tier_falls_back_to_input_rate_not_zero(self):
        """Fail-safe direction: over-state an unknown rate, never under-count.

        A pricing entry predating the cache tiers must not make cache reads
        free; for a spend display the safe error is too high.
        """
        cost = self.calc("nocache", 0, 0, 1_000_000, 0)
        self.assertGreater(cost, 0.0)

    def test_signature_accepts_cache_arguments(self):
        """Guards the specific regression.

        The old signature took only (model, input, output). A caller passing
        cache counts would raise TypeError, which is how this stayed broken
        while the other routes were fixed.
        """
        try:
            self.calc("sonnet", 1, 1, 1, 1)
        except TypeError as exc:  # pragma: no cover - the failure being guarded
            self.fail("cost calculator rejects cache arguments: %s" % exc)


class ApiCostPayloadTests(unittest.TestCase):
    """The endpoint must expose what it now computes."""

    def setUp(self):
        self.src = _SERVER.read_text(encoding="utf-8")

    def test_payload_exposes_cache_fields(self):
        for field in ("total_cache_read_tokens", "total_cache_creation_tokens",
                      "cache_hit_ratio", "total_tokens"):
            with self.subTest(field=field):
                self.assertIn(
                    '"%s"' % field, self.src,
                    "computed but never returned: a consumer cannot see it")

    def test_ratio_is_null_when_nothing_was_read(self):
        """None, not 0.0. Cold cache and no data are different claims."""
        self.assertIn("if _read_in > 0 else None", self.src)

    def test_every_call_site_passes_cache_arguments(self):
        """WIRING. The isolation tests above prove the calculator handles cache
        tokens and say nothing about whether callers pass them.

        server.py calls _calculate_model_cost from two places: the /api/cost
        snapshot and _compute_budget_snapshot, which drives the budget breaker
        and the 80% warning. The second passed only input and output, so the
        surface a user relies on to STOP spending under-counted 5.4x on a real
        record while every test here stayed green.
        """
        import re
        # Match the assignment form, which is what every invocation uses. A
        # broader pattern matched the NESTED data.get(...) inside an argument
        # and reported a false positive -- the scan has to be as precise as the
        # claim it makes.
        invocations = re.findall(
            r"cost = _calculate_model_cost\((.*)\)", self.src)
        self.assertGreaterEqual(len(invocations), 2,
                                "expected at least two call sites; the scan "
                                "may be matching nothing")
        for call in invocations:
            with self.subTest(call=call.strip()[:60]):
                self.assertIn(
                    "cr", call,
                    "a call site omits cache-read tokens, so that surface "
                    "prices ~98%% of real volume at zero")

    def test_totals_include_cache(self):
        self.assertIn(
            "total_input + total_output + total_cache_read + total_cache_creation",
            self.src,
            "total_tokens excludes cache, so it describes a fraction of the run")


if __name__ == "__main__":
    unittest.main()
