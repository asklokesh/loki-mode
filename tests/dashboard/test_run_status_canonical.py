"""The runs API and the CLI must not disagree about a live run's phase.

WHAT THIS CAUGHT, on a REAL running build rather than a fixture. During an
actual `loki start`, the two surfaces reported different things about the same
workspace at the same instant:

    CLI  (autonomy/loki status --json)   phase  = BUILDING
    API  (/api/operator, api_runs)       status = unknown

The cause: _current_status read only `.loki/session.json`, which the current
runtime does not write. A live run writes `.loki/state/orchestrator.json`, and
the CLI reads its `currentPhase` (autonomy/loki:4782). The API was reading a
file that never appears, so every live run reported "unknown".

Two surfaces disagreeing about one run is precisely the divergence the operator
API was built to prevent -- the same reason `loki proof phases` shares its
reader with the API rather than reimplementing the parse.

PRECEDENCE IS PRESERVED. PAUSE and STOP files still win, then session.json if a
deployment does write it, and orchestrator.json is consulted last. A missing
signal still yields "unknown" and never "completed": absence of evidence is not
evidence of success.
"""

import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _workspace(**files):
    d = tempfile.mkdtemp()
    loki = os.path.join(d, ".loki")
    os.makedirs(os.path.join(loki, "state"), exist_ok=True)
    for rel, payload in files.items():
        path = os.path.join(loki, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            if isinstance(payload, (dict, list)):
                json.dump(payload, fh)
            else:
                fh.write(payload)
    return loki


class TheApiReadsTheCanonicalPhase(unittest.TestCase):

    def setUp(self):
        try:
            from dashboard import api_runs  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_runs not importable: %s" % exc)
        self.api_runs = api_runs

    def test_orchestrator_phase_is_reported(self):
        """The exact case measured on a live run."""
        loki = _workspace(**{
            "state/orchestrator.json": {"currentPhase": "BUILDING",
                                        "version": "9.12.3"},
        })
        self.assertEqual(
            self.api_runs._current_status(loki), "building",
            "a live run writing state/orchestrator.json still reports "
            "unknown; the API and the CLI disagree about the same workspace")

    def test_a_paused_run_still_wins_over_the_phase(self):
        """Precedence must not be reordered by the new fallback."""
        loki = _workspace(**{
            "PAUSE": "1",
            "state/orchestrator.json": {"currentPhase": "BUILDING"},
        })
        self.assertEqual(self.api_runs._current_status(loki), "paused")

    def test_a_stopped_run_still_wins_over_the_phase(self):
        loki = _workspace(**{
            "STOP": "1",
            "state/orchestrator.json": {"currentPhase": "BUILDING"},
        })
        self.assertEqual(self.api_runs._current_status(loki), "stopped")

    def test_session_json_still_wins_when_a_deployment_writes_it(self):
        """orchestrator.json is a FALLBACK, not a replacement."""
        loki = _workspace(**{
            "session.json": {"status": "completed"},
            "state/orchestrator.json": {"currentPhase": "BUILDING"},
        })
        self.assertEqual(self.api_runs._current_status(loki), "completed")

    def test_no_signal_at_all_is_unknown_not_completed(self):
        """Absence of evidence is not evidence of success."""
        loki = _workspace()
        self.assertEqual(self.api_runs._current_status(loki), "unknown")

    def test_an_empty_phase_does_not_become_a_status(self):
        loki = _workspace(**{"state/orchestrator.json": {"currentPhase": ""}})
        self.assertEqual(self.api_runs._current_status(loki), "unknown")


if __name__ == "__main__":
    unittest.main()
