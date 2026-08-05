#!/usr/bin/env python3
"""Merge policy as a version-controlled FILE, not a CI flag nobody reviews.

WHY THIS EXISTS. tools/ci-gate.py takes its policy as CLI flags: --max-usd,
--require-receipt. That works exactly once, in one job, on one machine. The
ceiling lives in YAML nobody diffs, it cannot be reviewed in a PR, and two
repos in the same org drift apart with nobody able to name the moment it
happened. Lowering a ceiling should look like a code change, because it is one.

So: put the policy in a file, load it here, and hand ci-gate its flags.

    python3 tools/ci-gate.py $(python3 tools/policy-load.py --as-args)

THAT COMPOSITION IS WHY EVERY FAILURE HERE IS LOUD. This tool's stdout becomes
another gate's argv. A loader that shrugs at bad input does not produce a weak
policy, it produces a gate invoked with NOTHING TO ENFORCE, which ci-gate's own
docstring calls a vacuously-green gate: worse than no gate, because it is
trusted. This repo has paid for that shape four times (four detectors missing
from the package, a deferred dist check, a tarball assertion passing on "6 or
more" of 6). Every one was a check reporting a pass without having checked.

Hence four rules, each of which is one way to be silently unenforced:

  UNKNOWN KEY IS AN ERROR. "max_usd_" is not "max_usd". Skipping it leaves an
  operator certain a ceiling is enforced while nothing is. The misspelling is
  invisible precisely because the file still looks like a policy. Named, not
  counted: "1 unknown key" does not tell you which line to fix.

  EMPTY OR ABSENT IS AN ERROR, not an empty policy. An empty policy enforces
  nothing while looking configured. And "implies no flags" is the same hole one
  level up: {"require_receipt": false} is valid JSON, has a key, and expands to
  an empty argv. So the test is what the policy ENFORCES, not what it contains.

  VALUES ARE VALIDATED, NOT JUST KEYS. A ceiling of -1 passes every run. So
  does NaN, which json.loads accepts as a bare literal and which loses every
  comparison it appears in -- an unenforceable ceiling that reads as a number.
  So does True, which is an int in Python and floats to 1.0.

  MALFORMED JSON REPORTS THE PARSE ERROR AND THE PATH, never a partial policy.

Exit 0 only when a non-empty, fully-valid policy loaded and implies at least
one flag. Diagnostics go to stderr, always: anything on stdout gets word-split
straight into ci-gate's argv.

Usage:
  tools/policy-load.py [--file .loki-policy.json] [--json] [--as-args]
"""

import argparse
import json
import math
import sys

DEFAULT_FILE = ".loki-policy.json"

# The entire schema. Two keys, because ci-gate enforces exactly two policies.
# `workspace` is per-invocation and not a policy (and a path with a space would
# silently split under $(...)); `json` is an output format. Neither belongs here.
KNOWN_KEYS = ("max_usd", "require_receipt")


class PolicyError(Exception):
    """A policy that must not be handed to a gate."""


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _check_max_usd(value):
    # bool is a subclass of int: `true` would otherwise become a $1.00 ceiling.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "max_usd must be a number, got {!r}".format(value)
    # NaN and Infinity are bare literals json.loads accepts. NaN loses every
    # comparison, so a NaN ceiling never trips while looking like a number.
    # isfinite raises OverflowError on a 400-digit int literal; that already
    # fails closed, but a traceback is a worse message than a named reason.
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        return "max_usd must be a finite number, got {!r}".format(value)
    if value < 0:
        return "max_usd must not be negative, got {!r}".format(value)
    return None


def _check_require_receipt(value):
    # "true" is a string and is truthy; it is not a boolean policy.
    if not isinstance(value, bool):
        return "require_receipt must be true or false, got {!r}".format(value)
    return None


VALIDATORS = {
    "max_usd": _check_max_usd,
    "require_receipt": _check_require_receipt,
}


def load(path):
    """Return a validated policy dict, or raise PolicyError naming the problem."""
    try:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
    except FileNotFoundError:
        raise PolicyError(
            "no policy file at {}: a gate with no policy enforces nothing".format(path))
    except OSError as exc:
        raise PolicyError("cannot read {}: {}".format(path, exc))

    if not raw.strip():
        raise PolicyError(
            "policy file is empty: {} -- an empty policy enforces nothing "
            "while looking configured".format(path))

    try:
        policy = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PolicyError("malformed JSON in {}: {}".format(path, exc))

    if not isinstance(policy, dict):
        raise PolicyError(
            "policy in {} must be a JSON object, got {}".format(
                path, type(policy).__name__))

    # Named, sorted, and ALL of them: fixing one misspelling at a time across
    # three re-runs is how the third one gets abandoned.
    unknown = sorted(k for k in policy if k not in KNOWN_KEYS)
    if unknown:
        raise PolicyError(
            "unknown policy key(s) in {}: {} -- known keys are: {}".format(
                path, ", ".join(unknown), ", ".join(KNOWN_KEYS)))

    # Iterate KNOWN_KEYS, not policy.items(): indexing VALIDATORS by a key
    # straight from the file makes an unknown key a KeyError traceback instead
    # of the named message above. That still exits non-zero, so the check looks
    # tested while the operator gets a stack trace naming only the first typo.
    problems = [msg for key in KNOWN_KEYS if key in policy
                for msg in [VALIDATORS[key](policy[key])] if msg]
    if problems:
        raise PolicyError("invalid policy in {}: {}".format(path, "; ".join(problems)))

    if not policy:
        raise PolicyError(
            "policy in {} is empty: a gate driven by an empty policy enforces "
            "nothing while looking configured".format(path))

    return policy


def as_args(policy):
    """The ci-gate flags this policy implies."""
    args = []
    if "max_usd" in policy:
        args += ["--max-usd", repr(float(policy["max_usd"]))]
    if policy.get("require_receipt"):
        args.append("--require-receipt")
    return args


def main(argv=None):
    ap = _Parser(
        description="Load and validate a merge policy file for ci-gate.py.")
    ap.add_argument("--file", default=DEFAULT_FILE,
                    help="policy file to load; default {}".format(DEFAULT_FILE))
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the validated policy as JSON")
    ap.add_argument("--as-args", action="store_true", dest="args_only",
                    help="emit the ci-gate flags this policy implies")
    args = ap.parse_args(argv)

    try:
        policy = load(args.file)
        flags = as_args(policy)
        # require_receipt:false is valid, non-empty, and enforces NOTHING. Let
        # it exit 0 and `ci-gate $(...)` runs with an empty argv -- the same
        # vacuously-green gate this file exists to prevent, one level up.
        if not flags:
            raise PolicyError(
                "policy in {} enforces nothing: it implies no ci-gate flags, so "
                "the gate would run with nothing to check".format(args.file))
    except PolicyError as exc:
        print("policy-load: {}".format(exc), file=sys.stderr)
        return 1

    if args.args_only:
        print(" ".join(flags))
    elif args.as_json:
        print(json.dumps(policy, indent=2, sort_keys=True))
    else:
        for key in sorted(policy):
            print("{} = {}".format(key, json.dumps(policy[key])))
        print("ci-gate args: {}".format(" ".join(flags)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
