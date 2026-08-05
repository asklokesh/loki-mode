#!/usr/bin/env python3
"""Diff two policy files by SAFETY DIRECTION, because a loosening looks like any other line.

WHY THIS EXISTS. tools/policy-load.py put the merge policy in a version-
controlled file so lowering a ceiling would look like a code change. It does.
So does RAISING one. In a 400-line PR diff, this:

    -  "max_usd": 5,
    +  "max_usd": 50,

is one line of JSON, the same visual weight as a renamed variable, and it has
just given every merge a 10x cost ceiling. `git diff` is direction-blind by
construction: it reports that a value changed, and leaves the safety reasoning
to a reviewer who is 300 lines from the end and has no schema in their head.

Doing that reasoning FOR the reviewer is the entire product. Not "max_usd:
5 -> 50" -- that is what git already said. "WEAKENS".

Three rules follow, each one a way a loosening gets waved through:

  A CHANGE WE CANNOT CLASSIFY READS "UNKNOWN DIRECTION", NEVER "unchanged" and
  never assumed safe. policy-load.KNOWN_KEYS will grow. A key added there but
  not here is a fully valid policy edit that diffs cleanly -- exactly the shape
  a silent loosening hides in. Falling through to "changed" makes the new axis
  invisible on the one surface built to see it. So the fallthrough is loud, and
  a test asserts DIRECTIONS covers every KNOWN_KEYS entry -- UNKNOWN is the
  runtime safety net for whatever still slips past, not the accepted resting
  state for a key we ship.

  REMOVING A KEY IS ALWAYS WEAKENING. Not "removed". Deleting `max_usd` does
  not lower a ceiling, it stops enforcing cost AT ALL, which is strictly weaker
  than any number you could have written. This holds for `require_receipt:
  false -> absent` too, where the tempting reading is "it enforced nothing
  either way, so it is neutral". A per-case exception here is the hole: the
  reviewer needs one rule they can trust, not a rule with a footnote about
  which removals are the safe kind.

  BOTH FILES MUST BE VALID POLICIES FIRST. A diff of a file policy-load would
  reject is a confident verdict about a document no gate would ever honour --
  the vacuously-green shape one level over. Refuse, name the file, name the
  reason.

Exit 0 means the diff was produced, INCLUDING when it found weakenings; that is
a successful answer to the question asked. --fail-on-weaken is what turns a
finding into a build failure, so CI can require a human ack on a loosening.

Usage:
  tools/policy-diff.py <old.json> <new.json> [--json] [--fail-on-weaken]
"""

import argparse
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))

# policy-load.py is hyphenated, so it is not importable by name. Load it by
# path rather than re-implementing validation: a second copy of the schema is a
# second thing to forget to update, and this tool's whole claim is that it
# refuses exactly what the loader refuses.
_spec = importlib.util.spec_from_file_location(
    "policy_load", os.path.join(_HERE, "policy-load.py"))
policy_load = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy_load)

WEAKENS = "WEAKENS"
TIGHTENS = "TIGHTENS"
UNKNOWN = "UNKNOWN DIRECTION"


class _Missing:
    """A key absent from a policy. Not None: `null` is a value a file can hold."""

    def __repr__(self):
        return "<absent>"


MISSING = _Missing()

# Exit codes, per the convention tests/test_tool_exit_contract.py enforces.
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CANNOT_EVALUATE = 2
EXIT_USAGE = 64
EXIT_INPUT_MISSING = 66


def _direction_max_usd(old, new):
    """A higher ceiling admits runs the old policy would have blocked."""
    return WEAKENS if new > old else TIGHTENS


def _direction_require_receipt(old, new):
    # Only false -> true tightens; true -> false drops the requirement.
    return TIGHTENS if new else WEAKENS


# Keyed by policy key. The DEFAULT is UNKNOWN, never "changed": see the module
# docstring. Adding a key to policy-load.KNOWN_KEYS without adding it here is
# caught by a test, but until someone fixes it the output must still be loud.
DIRECTIONS = {
    "max_usd": _direction_max_usd,
    "require_receipt": _direction_require_receipt,
}


def classify(key, old, new):
    """Return (direction, detail) for one key. `old`/`new` may be MISSING."""
    if old == new:
        return None, None
    if new is MISSING:
        # Never "removed". The gate stops enforcing this axis entirely, which
        # is weaker than any value that could have been there.
        return WEAKENS, "{} removed (was {}) -- this axis is no longer enforced at all".format(
            key, json.dumps(old))
    if old is MISSING:
        return TIGHTENS, "{} added = {} -- a new axis is now enforced".format(
            key, json.dumps(new))
    decide = DIRECTIONS.get(key)
    if decide is None:
        return UNKNOWN, "{}: {} -> {} -- this tool does not know which direction is safer".format(
            key, json.dumps(old), json.dumps(new))
    return decide(old, new), "{}: {} -> {}".format(
        key, json.dumps(old), json.dumps(new))


def diff(old_policy, new_policy):
    """Every classified change between two validated policies."""
    changes = []
    for key in sorted(set(old_policy) | set(new_policy)):
        direction, detail = classify(
            key, old_policy.get(key, MISSING), new_policy.get(key, MISSING))
        if direction is not None:
            changes.append({"key": key, "direction": direction, "detail": detail})
    return changes


def _load_or_die(path, label):
    """Validated policy, or an exit code. Missing file and invalid file differ."""
    if not os.path.exists(path):
        print("policy-diff: {} file does not exist: {}".format(label, path),
              file=sys.stderr)
        return None, EXIT_INPUT_MISSING
    try:
        return policy_load.load(path), None
    except policy_load.PolicyError as exc:
        # Refusing to diff is "could not be checked", not "the check failed".
        print("policy-diff: refusing to diff -- the {} file is not a valid "
              "policy: {}".format(label, exc), file=sys.stderr)
        return None, EXIT_CANNOT_EVALUATE


class _Parser(argparse.ArgumentParser):
    # argparse exits 2 on a usage error, and 2 means "could not be checked" in
    # this repo. Overriding error() (not parse_args) leaves --help exiting 0.
    def error(self, message):
        self.print_usage(sys.stderr)
        print("{}: error: {}".format(self.prog, message), file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def main(argv=None):
    ap = _Parser(description="Classify every policy change as WEAKENS or TIGHTENS.")
    ap.add_argument("old", help="the policy file as it is today")
    ap.add_argument("new", help="the policy file as proposed")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the classified changes as JSON")
    ap.add_argument("--fail-on-weaken", action="store_true", dest="fail_on_weaken",
                    help="exit non-zero if any change weakens the gate")
    args = ap.parse_args(argv)

    old, rc = _load_or_die(args.old, "old")
    if rc is not None:
        return rc
    new, rc = _load_or_die(args.new, "new")
    if rc is not None:
        return rc

    changes = diff(old, new)
    weakenings = [c for c in changes if c["direction"] == WEAKENS]
    unknowns = [c for c in changes if c["direction"] == UNKNOWN]

    if args.as_json:
        print(json.dumps({
            "changes": changes,
            "weakens": len(weakenings),
            "unknown_direction": len(unknowns),
        }, indent=2, sort_keys=True))
    elif not changes:
        print("no change: the two policies enforce the same gate")
    else:
        for c in changes:
            print("{}: {}".format(c["direction"], c["detail"]))
        # UNKNOWN is called out beside the weakenings, not buried in the list:
        # it is the count a reviewer must resolve by hand.
        print("{} weakening(s), {} unknown direction, {} change(s) total".format(
            len(weakenings), len(unknowns), len(changes)))

    if weakenings and args.fail_on_weaken:
        print("policy-diff: {} weakening(s) require an explicit human ack".format(
            len(weakenings)), file=sys.stderr)
        return EXIT_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
