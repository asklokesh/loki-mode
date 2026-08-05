#!/usr/bin/env python3
"""Pin one run as THE cost baseline, then resolve it later.

cost-guard.py compares against a baseline receipt, but somebody has to hand-pick
that file and keep it fresh. There is no way to say "the current main is the
reference" and have every later PR compare against it. This is that:

    tools/baseline-pin.py set <workspace>     # pin the newest receipt there
    tools/baseline-pin.py show                # what is pinned, and is it intact
    tools/baseline-pin.py path                # the proof path, for --baseline

    tools/cost-guard.py . --max-increase-pct 10 \\
        --baseline "$(tools/baseline-pin.py path)"

WHAT MAKES A PIN WORTH TRUSTING, and why each one is a refusal rather than a
warning:

1. NEVER PIN AN UNVERIFIABLE OR UNMEASURED RUN. A baseline nobody can verify
   makes every later comparison meaningless -- the percentage is computed
   against a number that may have been typed in. A baseline with no measured
   cost makes every percentage undefined. Both refuse, with DIFFERENT messages,
   because the operator's next move differs: one means re-run the build, the
   other means fix instrumentation. Integrity is checked FIRST: a receipt that
   fails it has no trustworthy cost to report, so "no measured cost" would be
   the wrong diagnosis to hand back.

   Neither predicate is restated here. Integrity is verify_integrity() from
   autonomy/lib/proof-verify.py; measurement is measured_usd() from
   cost-guard.py, which already maps the receipt's cost.usd onto the
   record_is_measured() key name. A second copy of either is how the rule
   drifts.

2. A PIN RECORDS WHAT IT PINNED, not just a path. The receipt's hash, the cost
   observed at pin time, and when. A path alone silently follows a file that
   can be edited afterwards, so "the baseline" would mean whatever that file
   says today.

   The hash is over the RAW FILE BYTES, deliberately not the canonical
   verification-stripped digest the receipt hashes itself with. That digest is
   blind to any edit confined to the verification block -- swap the whole block
   and it is unchanged. For pinning, the question is "did this file change",
   and a reordered or re-signed file IS a changed file.

3. show DETECTS DRIFT SINCE PINNING and says so loudly, and `path` REFUSES to
   emit a drifted baseline. A stale baseline that quietly drifts is worse than
   none: composed into --baseline "$(...)" it poisons the comparison while
   still looking like a green gate.

Exit: 0 fine, 1 refused / drifted / no pin. Never an empty success.
"""

import argparse
import glob
import hashlib
import importlib.util
import json
import os
import sys
import time

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(os.path.dirname(_HERE), "autonomy", "lib")
sys.path.insert(0, _LIB)


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


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Hyphenated filenames, so both need the loader dance rather than an import.
_pv = _load("proof_verify", os.path.join(_LIB, "proof-verify.py"))
_cg = _load("cost_guard", os.path.join(_HERE, "cost-guard.py"))

OK, REFUSED = 0, 1
DEFAULT_FILE = os.path.join(".loki", "baseline.json")


def _file_sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def newest_receipt(workspace):
    """The most recent proof.json under a workspace, or None.

    Same convention as ci-gate.py: accept a workspace root or its .loki dir.
    """
    root = os.path.normpath(workspace)
    if os.path.basename(root) == ".loki":
        root = os.path.dirname(root) or "."
    found = glob.glob(os.path.join(root, ".loki", "proofs", "*", "proof.json"))
    return max(found, key=os.path.getmtime) if found else None


class Refused(Exception):
    """A refusal carrying the reason the operator needs to act on."""


def build_pin(workspace):
    """The pin record for a workspace, or raise Refused explaining why not."""
    proof_path = newest_receipt(workspace)
    if proof_path is None:
        raise Refused(
            "no receipt under %s/.loki/proofs/*/proof.json, so there is no run "
            "to pin. Run a build first." % os.path.normpath(workspace))

    try:
        proof = _pv._load_proof(proof_path)
    except Exception as exc:
        raise Refused("receipt %s could not be read: %s" % (proof_path, exc))

    verdict = _pv.verify_integrity(proof)
    if not verdict["ok"]:
        raise Refused(
            "receipt %s FAILED integrity verification, so it must not become a "
            "baseline: every later comparison would be against a number nobody "
            "can verify.\n  %s"
            % (proof_path,
               "\n  ".join(verdict["reasons"] or [verdict["reason"]])))

    usd = _cg.measured_usd(proof.get("cost"))
    if usd is None:
        raise Refused(
            "receipt %s records NO MEASURED COST, so it must not become a "
            "baseline: a percentage increase against an unmeasured number is "
            "undefined. Unmeasured is not $0.00. Fix the cost instrumentation "
            "for that run, then pin it." % proof_path)

    return {
        "pin": "loki-cost-baseline/v1",
        "proof_path": os.path.abspath(proof_path),
        "receipt_sha256": _file_sha256(proof_path),
        "cost_usd": usd,
        "pinned_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def read_pin(pin_file):
    """The pin record, or raise Refused. Never an empty success."""
    if not os.path.exists(pin_file):
        raise Refused(
            "no baseline pinned (%s does not exist). Pin one with: "
            "tools/baseline-pin.py set <workspace>" % pin_file)
    try:
        with open(pin_file, "r", encoding="utf-8") as handle:
            rec = json.load(handle)
    except Exception as exc:
        raise Refused("pin file %s is unreadable: %s" % (pin_file, exc))
    if not isinstance(rec, dict) or not rec.get("proof_path"):
        raise Refused("pin file %s records no proof_path" % pin_file)
    return rec


def check_pin(rec):
    """Re-hash the pinned receipt. Returns (state, detail).

    state is "intact", "changed", or "missing".
    """
    path = rec["proof_path"]
    if not os.path.exists(path):
        return "missing", "the pinned receipt no longer exists at %s" % path
    now = _file_sha256(path)
    if now != rec.get("receipt_sha256"):
        return "changed", (
            "the pinned receipt CHANGED since it was pinned: %s\n  pinned "
            "sha256 %s\n  current sha256 %s\n  This baseline no longer "
            "describes the run it was pinned from. Re-pin it deliberately, or "
            "every comparison against it is against an unknown."
            % (path, rec.get("receipt_sha256"), now))
    return "intact", "receipt unchanged since pinning"


def main(argv):
    ap = _Parser(
        description="Pin a run as the cost baseline, then resolve it later.")
    sub = ap.add_subparsers(dest="cmd")

    p_set = sub.add_parser("set", help="pin the newest receipt in a workspace")
    p_set.add_argument("workspace")
    p_set.add_argument("--file", default=DEFAULT_FILE)

    p_show = sub.add_parser("show", help="what is pinned, and is it intact")
    p_show.add_argument("--file", default=DEFAULT_FILE)
    p_show.add_argument("--json", action="store_true")

    p_path = sub.add_parser("path", help="the pinned proof path, for --baseline")
    p_path.add_argument("--file", default=DEFAULT_FILE)

    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help(sys.stderr)
        return REFUSED

    if args.cmd == "set":
        try:
            rec = build_pin(args.workspace)
        except Refused as exc:
            sys.stderr.write("REFUSED TO PIN: %s\n" % exc)
            return REFUSED
        parent = os.path.dirname(os.path.abspath(args.file))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(args.file, "w", encoding="utf-8") as handle:
            json.dump(rec, handle, indent=2, sort_keys=True)
            handle.write("\n")
        sys.stderr.write(
            "PINNED %s\n  cost $%.4f  sha256 %s\n  written to %s\n"
            % (rec["proof_path"], rec["cost_usd"], rec["receipt_sha256"],
               args.file))
        return OK

    try:
        rec = read_pin(args.file)
    except Refused as exc:
        sys.stderr.write("NO BASELINE: %s\n" % exc)
        return REFUSED

    state, detail = check_pin(rec)

    if args.cmd == "path":
        if state != "intact":
            sys.stderr.write("REFUSING TO EMIT BASELINE: %s\n" % detail)
            return REFUSED
        # ONLY the path on stdout, so this composes into --baseline "$(...)".
        sys.stdout.write("%s\n" % rec["proof_path"])
        return OK

    if getattr(args, "json", False):
        out = dict(rec)
        out["state"] = state
        out["detail"] = detail
        sys.stdout.write(json.dumps(out, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write(
            "baseline: %s\n  pinned at %s\n  cost at pin $%.4f\n"
            % (rec["proof_path"], rec.get("pinned_at", "unknown"),
               rec.get("cost_usd") or 0.0))
    if state != "intact":
        sys.stderr.write("BASELINE %s: %s\n" % (state.upper(), detail))
        return REFUSED
    sys.stderr.write("baseline INTACT: %s\n" % detail)
    return OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
