"""The start-time model picker must work on non-Claude providers.

The dashboard's start control offers whatever the provider-aware `offers`
payload advertises. On codex that is the generic capability tiers
small|medium|high. But the spawn endpoint normalized against a Claude-only
allowlist (haiku|sonnet|opus), so EVERY value a codex user could pick
normalized to "" and was silently discarded: the POST returned success and the
run started on the provider default, with no error and no feedback.

The read side (what the picker offers) was fixed separately. This covers the
write side (what the spawn endpoint accepts and pins), which is where the
value actually has to survive.

Two properties, and the second is the one that is easy to get wrong:

  1. a generic tier survives normalization
  2. a generic tier pins LOKI_SESSION_MODEL and NOT the LOKI_CLAUDE_MODEL_*
     triple -- those variables are inert on codex, so pinning them would look
     correct in code review while doing nothing at runtime
"""

import os
import unittest

_SERVER = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "dashboard", "server.py")


def _load_normalizer():
    """Exec just the allowlist + normalizer, without importing the whole app."""
    src = open(_SERVER).read()
    start = src.index("_START_MODEL_ALLOWLIST = ")
    end = src.index("class SessionModelRequest")
    ns = {}
    exec(src[start:end], ns)  # noqa: S102 - deliberate, scoped to two defs
    return ns


class StartModelGenericTierTests(unittest.TestCase):
    def setUp(self):
        self.ns = _load_normalizer()
        self.normalize = self.ns["_normalize_start_model"]

    def test_generic_tiers_survive_normalization(self):
        """small|medium|high must not be silently dropped."""
        for tier in ("small", "medium", "high"):
            with self.subTest(tier=tier):
                self.assertEqual(
                    self.normalize(tier), tier,
                    "%r normalized to empty; on codex every offered value "
                    "would be discarded and the pick silently ignored" % tier)

    def test_claude_aliases_still_work(self):
        for alias in ("haiku", "sonnet", "opus"):
            with self.subTest(alias=alias):
                self.assertEqual(self.normalize(alias), alias)

    def test_fable_and_junk_still_rejected(self):
        """Widening to generic tiers must not widen anything else."""
        for bad in ("fable", "bogus", "", None, "claude-opus-4-8"):
            with self.subTest(value=bad):
                self.assertEqual(self.normalize(bad), "")

    def test_case_and_whitespace_still_normalized(self):
        self.assertEqual(self.normalize("  MEDIUM  "), "medium")

    def test_generic_tier_does_not_pin_claude_only_env(self):
        """A generic tier must pin LOKI_SESSION_MODEL, not the Claude triple.

        Asserted against the source of the spawn path: the generic branch must
        set LOKI_SESSION_MODEL and must not set LOKI_CLAUDE_MODEL_*, which are
        meaningless on codex.
        """
        src = open(_SERVER).read()
        anchor = src.index("if start_model in _START_MODEL_GENERIC_TIERS:")
        # The generic branch runs until the else that starts the exact-pin path.
        raw = src[anchor:src.index("popen_env[\"LOKI_CLAUDE_MODEL_PLANNING\"]",
                                   anchor)]
        # Assert on CODE, not on prose. The branch's comment necessarily names
        # LOKI_CLAUDE_MODEL_* to explain why it does not set it, and matching
        # that would fail on a correct implementation.
        branch = "\n".join(
            line.split("#", 1)[0] for line in raw.splitlines())
        self.assertIn("LOKI_SESSION_MODEL", branch,
                      "generic tier does not pin LOKI_SESSION_MODEL, so the "
                      "pick has no effect at all")
        self.assertNotIn("LOKI_CLAUDE_MODEL", branch,
                         "generic tier pins Claude-only env vars, which are "
                         "inert on codex -- the pin would silently do nothing")


if __name__ == "__main__":
    unittest.main()
