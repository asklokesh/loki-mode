#!/usr/bin/env python3
"""Render a ci-gate verdict as a shields.io badge, without laundering it.

WHY THIS EXISTS. `ci-gate.py --json` already emits an honest three-state
verdict, but nobody reads a JSON body on a README. They read a badge, at a
glance, and act on the colour alone. That glance is the last place the
three-state distinction can be lost, and it is the easiest place to lose it:
shields.io has exactly two colours everyone reaches for, and a two-colour
rendering of a three-state verdict has to fold one state into another.

Folding UNEVALUABLE into PASS is the failure this file exists to prevent. It
puts a green badge on a README at exactly the moment the gate went blind --
the loudest possible reassurance backed by the least possible evidence. So
UNEVALUABLE gets its own colour, and a test asserts that colour is neither in
the green family nor equal to whatever the pass path renders.

THREE RULES THIS ENFORCES BEYOND COLOUR:

  Never invent a verdict. Empty stdin and malformed stdin are not states of
  the gate, they are the absence of a reading. Both exit 2 and render an
  "input" badge. Neither can render a pass.

  Trust nothing the input contradicts. The payload carries `state` (which
  picks the colour) and `exit_code` (which this process re-raises). If they
  disagree -- UNEVALUABLE alongside exit 0 -- the payload is not a verdict
  this tool recognises, and it is rejected rather than half-believed.

  A measured zero survives. `exit_code` 0 is the PASS code, and it is falsy.
  `payload.get("exit_code") or UNEVALUABLE` would silently convert every
  passing gate into a blind one. Read it with `is None`, never truthiness.

Usage:
  tools/ci-gate.py <ws> --max-usd 5 --json | tools/gate-badge.py [--label NAME]

Exit: mirrors the input verdict (0 pass, 1 failed, 2 unevaluable), so a shell
pipe cannot turn a failure into a success. 64 on a usage error.
"""

import argparse
import json
import sys

PASS, FAIL, UNEVALUABLE = 0, 1, 2

# The colour and the words for each state. Deliberately NOT a green/red pair:
# "orange" is the whole point of the file, and the message names the actual
# state rather than a generic "error" that reads the same for all three.
_BADGE = {
    "PASS": ("passing", "brightgreen"),
    "FAIL": ("failing", "red"),
    "UNEVALUABLE": ("unevaluable", "orange"),
}

# A verdict this tool did not receive, rendered so a reader can tell "the gate
# is blind" from "nobody told me what the gate said".
_NO_INPUT = ("no gate verdict on stdin", "lightgrey")


class _Parser(argparse.ArgumentParser):
    """A typo must never read as a blind gate.

    argparse exits 2 on a usage error, and 2 here means "could not be
    checked" -- so a mistyped flag would be indistinguishable from a gate
    that genuinely went dark, and an operator would go hunting for broken
    instrumentation that was never broken.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def badge(payload, label="gate"):
    """Map one ci-gate verdict onto a shields.io endpoint body.

    Returns (body, exit_code). Raises ValueError when the payload is not a
    verdict, so no caller can fall through into a rendered pass.
    """
    if not isinstance(payload, dict):
        raise ValueError("expected a ci-gate JSON object, got %s"
                         % type(payload).__name__)

    state = payload.get("state")
    code = payload.get("exit_code")

    if state not in _BADGE:
        raise ValueError("unrecognised gate state: %r" % (state,))
    # `is None` and an explicit int check, not truthiness: 0 is the PASS code
    # and is falsy, and `True` is an int to Python but not an exit code.
    if code is None or not isinstance(code, int) or isinstance(code, bool):
        raise ValueError("gate payload carries no usable exit_code: %r"
                         % (code,))

    # The two fields must agree. A payload saying UNEVALUABLE while carrying
    # exit 0 is either corrupt or hand-edited toward green; believing half of
    # it would let the half that is green through.
    expected = {"PASS": PASS, "FAIL": FAIL, "UNEVALUABLE": UNEVALUABLE}[state]
    if code != expected:
        raise ValueError(
            "gate payload disagrees with itself: state=%s implies exit %d "
            "but exit_code=%d" % (state, expected, code))

    message, color = _BADGE[state]
    return ({"schemaVersion": 1, "label": label, "message": message,
             "color": color}, code)


def main(argv=None):
    ap = _Parser(
        description="Render a ci-gate --json verdict as a shields.io badge.")
    ap.add_argument("--label", default="gate",
                    help="badge label text; default 'gate'")
    # No positional. A stray path argument is a usage error (64), never a file
    # this tool silently judges.
    args = ap.parse_args(argv)

    raw = sys.stdin.read()
    if not raw.strip():
        # Absence of a reading, not a reading of absence. Rendering a pass
        # here would mean an unplugged pipe certifies a merge.
        message, color = _NO_INPUT
        print(json.dumps({"schemaVersion": 1, "label": args.label,
                          "message": message, "color": color}))
        sys.stderr.write("gate-badge: empty stdin -- pipe `ci-gate.py --json` "
                         "into this tool. No verdict was read, so none is "
                         "rendered.\n")
        return UNEVALUABLE

    try:
        body, code = badge(json.loads(raw), args.label)
    except (ValueError, TypeError) as exc:
        message, color = _NO_INPUT
        print(json.dumps({"schemaVersion": 1, "label": args.label,
                          "message": message, "color": color}))
        sys.stderr.write("gate-badge: %s\n" % exc)
        return UNEVALUABLE

    print(json.dumps(body))
    return code


if __name__ == "__main__":
    sys.exit(main())
