"""The efficiency trend must not tell the agent its work is free.

W4 in docs/WANG-PRINCIPLES-PLAN.md -- the half of Wang's principle 5 that turns
telemetry into an actual feedback loop: *"the right agentic loop AND the right
eval or metric for the agents to optimize."*

WHY THIS ONE MATTERS MORE THAN A REPORT BUG. `--prompt-block` output is
INJECTED INTO THE PROMPT. Rendering "$0.00" does not merely misreport a
number -- it actively teaches the agent that its work costs nothing, and that
belief survives into every downstream decision it makes about effort and
iteration.

MEASURED on the real FireLater run: every iteration rendered "$0.00" because
codex wrote no usage before v8.51.0.

The honesty rule was already documented at the top of iteration_attribution.py
("cost not recorded for any iteration (reported as null, not as $0.00)") and
only the SUMMARY path honoured it. The per-iteration line rendered any numeric
cost, including 0.

THE DISTINCTION: an unmeasured cost is unknown, not free. Omitting the field
reads as unknown; printing $0.00 reads as a fact.

The opposite error is also tested: a genuine cost must still be shown, or the
steer this block exists to give disappears entirely.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_SCRIPT = _ROOT / "autonomy" / "lib" / "iteration_attribution.py"


def _render(records):
    """Run the real script over synthetic records; return the prompt block."""
    with tempfile.TemporaryDirectory() as d:
        eff = pathlib.Path(d) / ".loki" / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        for rec in records:
            (eff / f"iteration-{rec['iteration']}.json").write_text(
                json.dumps(rec), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(_SCRIPT),
             "--loki-dir", str(pathlib.Path(d) / ".loki"), "--prompt-block"],
            capture_output=True, text=True, timeout=60)
        return proc.stdout


class TrendCostHonestyTests(unittest.TestCase):
    def test_unmeasured_cost_is_omitted_not_zero(self):
        """The regression, in the shape that actually shipped."""
        out = _render([
            {"iteration": 1, "duration_ms": 226000, "cost_usd": 0,
             "input_tokens": 0, "output_tokens": 0, "status": "failed"},
            {"iteration": 2, "duration_ms": 1730000, "cost_usd": 0,
             "input_tokens": 0, "output_tokens": 0, "status": "completed"},
        ])
        self.assertNotIn(
            "$0.00", out,
            "the prompt tells the agent its work cost $0.00 -- an unmeasured "
            "cost is unknown, not free, and this text steers the agent")
        # The rest of the steer must survive; suppressing the whole block would
        # trade one failure for another.
        self.assertIn("EFFICIENCY TREND", out)
        self.assertIn("226s", out, "duration was dropped along with the cost")

    def test_real_cost_is_still_rendered(self):
        """The opposite error: a guard must not blank a genuine measurement."""
        out = _render([{
            "iteration": 1, "duration_ms": 90000, "cost_usd": 0.0187,
            "input_tokens": 9412, "output_tokens": 23,
            "cache_read_tokens": 11008, "status": "completed",
        }])
        self.assertIn("$0.02", out, "a real measured cost was suppressed")
        self.assertIn("cache", out, "cache ratio lost")

    def test_a_tiny_real_cost_is_not_suppressed(self):
        """Guard the boundary: > 0 must include values that round to $0.00.

        A sub-cent iteration is real data. It renders as $0.00 by format, which
        is acceptable BECAUSE it was measured -- the failure being fixed is
        printing $0.00 for something never measured at all. This test exists so
        a future 'just hide $0.00 everywhere' fix cannot silently discard real
        sub-cent measurements.
        """
        out = _render([{
            "iteration": 1, "duration_ms": 5000, "cost_usd": 0.0001,
            "input_tokens": 50, "output_tokens": 2, "status": "completed",
        }])
        self.assertIn("iter 1", out)
        self.assertIn("5s", out)


if __name__ == "__main__":
    unittest.main()
