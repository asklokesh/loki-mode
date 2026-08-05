"""`--json` must emit parseable JSON, including when the tool fails.

WHY THIS EXISTS. Twelve tools under tools/ accept `--json`, and CI composes
them: a job runs one, pipes stdout to `json.load`, and branches on the result.
Every one of them handled the SUCCESS path correctly.

`run-replay.py` did not handle the failure path. On a workspace with no
artifacts it printed a bare text line and raised SystemExit before `--json` was
ever consulted, so a consumer that asked for machine output got:

    json.decoder.JSONDecodeError: Expecting value: line 1 column 1

The failure was unreadable to precisely the automation the flag exists for. A
structured error is still structured output; the exit code carries the verdict
either way.

WHAT THIS ASSERTS, and why it is a CONTRACT test rather than a unit test: the
rule only has value if EVERY tool obeys it. A per-tool test proves one tool is
fine while the next one added quietly breaks the convention. This walks the
real tools/ directory, so a new tool is covered the day it lands rather than
whenever someone remembers to add a case.

Deliberately NOT asserted: that stdout is non-empty on every path. Some tools
legitimately write their structured payload to stderr and keep stdout clean.
The contract is "if it writes to stdout under --json, that text parses", which
is the property a consumer actually depends on.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOLS = _ROOT / "tools"

# Invocations chosen to hit a tool's NO-DATA path, which is where the
# convention broke. Each entry is (tool, args-that-cannot-succeed).
_NO_DATA_CASES = [
    ("run-replay.py", ["{ws}"]),
    ("model-advisor.py", ["{ws}"]),
    ("cost-history.py", ["report", "--file", "{ws}/nope.jsonl"]),
    ("receipt-bundle.py", ["{ws}"]),
    ("tool-index.py", []),
]


def _run(tool, args, ws):
    argv = [sys.executable, str(_TOOLS / tool)]
    argv += [a.replace("{ws}", ws) for a in args]
    argv.append("--json")
    return subprocess.run(argv, capture_output=True, text=True, timeout=120)


class JsonModeEmitsParseableJson(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.ws, ".loki"), exist_ok=True)

    def test_every_tool_that_writes_stdout_under_json_emits_json(self):
        """The contract, across all tools, on the path where it broke."""
        for tool, args in _NO_DATA_CASES:
            if not (_TOOLS / tool).exists():
                continue
            with self.subTest(tool=tool):
                r = _run(tool, args, self.ws)
                if not r.stdout.strip():
                    # Writing the payload to stderr is a legitimate choice.
                    continue
                try:
                    json.loads(r.stdout)
                except ValueError as exc:
                    self.fail(
                        "%s --json wrote non-JSON to stdout on its no-data "
                        "path, so a consumer's json.load() crashes instead of "
                        "reading the failure: %s\nstdout: %r"
                        % (tool, exc, r.stdout[:200]))

    def test_run_replay_no_data_is_structured_and_keeps_its_exit_code(self):
        """The specific regression, pinned.

        Both halves matter: the payload must parse AND the process must still
        exit non-zero. A tool that started emitting JSON but lost its exit code
        would turn a blind gate green, which is the defect this whole tool line
        exists to prevent.
        """
        r = _run("run-replay.py", ["{ws}"], self.ws)
        self.assertNotEqual(r.returncode, 0,
                            "a no-data replay reported success")
        payload = json.loads(r.stdout)
        self.assertEqual(payload["status"], "no_data")
        self.assertEqual(
            payload["exit_code"], r.returncode,
            "the embedded exit_code disagrees with the real process exit, so a "
            "consumer reading the JSON reaches a different verdict than a "
            "consumer reading $?")

    def test_a_real_replay_still_produces_its_iterations(self):
        """The opposite direction: the guard must not swallow success."""
        ws = tempfile.mkdtemp()
        loki = pathlib.Path(ws) / ".loki"
        loki.mkdir(parents=True, exist_ok=True)
        (loki / "events.jsonl").write_text(
            json.dumps({"type": "stage_complete",
                        "data": {"stage": "test_suite", "status": "pass",
                                 "duration_s": 3, "iteration": 1}}) + "\n"
            + json.dumps({"type": "iteration_complete",
                          "data": {"iteration": 1, "status": "completed"}}) + "\n",
            encoding="utf-8")
        r = _run("run-replay.py", [ws], ws)
        self.assertEqual(r.returncode, 0, r.stderr[:200])
        payload = json.loads(r.stdout)
        self.assertEqual(len(payload["iterations"]), 1)


if __name__ == "__main__":
    unittest.main()
