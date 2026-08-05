#!/usr/bin/env python3
"""Write ONE self-describing evidence file a third party can check.

WHY THIS EXISTS. Every piece is already here and none of them leaves the
machine. `receipt-bundle.py` rolls a workspace up into a verdict, but it prints
to a terminal and its output means nothing an hour later. `receipt-attest.py`
emits a portable per-receipt attestation, but ONE receipt at a time, and the
caller has to know which files to feed it. Handing a reviewer "run these two
tools in this order against a directory you do not have" is not evidence; it is
homework.

So this produces a single FILE: every receipt in the workspace, each with the
verdict THIS MACHINE computed, plus a statement of what the file does not
prove. One artifact, self-describing, checkable by someone who was never here.

THE RULE THAT MAKES IT EVIDENCE RATHER THAN MARKETING:

    NEVER EXPORT A VERDICT THIS MACHINE DID NOT COMPUTE.

Every per-receipt verdict and every per-axis state comes from attest(), which
calls verify() in autonomy/lib/proof-verify.py. Nothing here decides whether a
receipt is good. An axis that could not be checked is exported as UNVERIFIABLE
carrying the verifier's own reason -- never omitted, never rounded up to
VERIFIED. An export claiming more than was checked is not an optimistic report,
it is a FORGED CREDENTIAL: the reader's entire reason for trusting the file is
that it reports only what was measured, and one upgraded axis makes every other
line in it worthless too.

The specific way that forgery happens by accident is OMISSION. Dropping the
receipts that failed or could not be read leaves a file where every line says
VERIFIED, and the reader cannot tell whether that is because the run was clean
or because the bad ones were filtered out. Absent is not clean. So the export
carries every receipt discovered, and the counts are of what was DISCOVERED,
not of what survived.

WHAT THIS FILE DOES NOT PROVE, and it is said in the export body rather than in
documentation the reader will never see:

    An UNSIGNED receipt proves INTEGRITY, not ORIGIN.

Integrity means the recorded bytes were not edited after they were hashed.
Origin means a particular machine produced them. Without a gpg signature the
generator is trusted, so a forger who rewrites the facts AND the headline
consistently and recomputes the hash passes every check in here. proof-verify's
own docstring says so outright. A reader who takes an unsigned VERIFIED as
proof of provenance has been misled, and the only place that caveat reliably
reaches them is inside the artifact.

Reuse, not reimplementation:
  - verify()        autonomy/lib/proof-verify.py, via attest() below
  - attest()        tools/receipt-attest.py -- the per-axis three-state
                    projection, already written and already tested
  - find_receipts() tools/receipt-bundle.py -- the discovery convention, so an
                    export covers exactly what an audit covers
  - rollup()        tools/receipt-bundle.py -- weakest-link, never an average

Usage:
    tools/receipt-export.py [workspace] [--out evidence.json] [--force] [--json]

Exit codes (tests/test_tool_exit_contract.py enforces the convention):
    0   every receipt exported VERIFIED
    1   a receipt was checked and FAILED
    2   nothing failed, but a receipt was UNVERIFIABLE
    3   no receipts found -- nothing exported, and an empty export is not a
        passing audit
    64  usage error, including refusing to overwrite without --force
    66  the workspace does not exist
"""

import argparse
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE failures (the probe edits the source, the loader serves the old
# bytecode). Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOLS = _ROOT / "tools"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_attest = _load("receipt_attest", _TOOLS / "receipt-attest.py")
_bundle = _load("receipt_bundle", _TOOLS / "receipt-bundle.py")

# The single source of every verdict in the export. attest() calls verify().
attest = _attest.attest
# The discovery convention, imported so an export covers exactly what an audit
# covers. A second glob here is how the two drift apart and a receipt becomes
# auditable but not exportable.
find_receipts = _bundle.find_receipts
# Weakest-link, imported rather than restated. One FAILED receipt sinks the
# export no matter how many VERIFIED ones surround it.
rollup = _bundle.rollup
measured_cost = _bundle.measured_cost
_pv = _bundle._pv

VERIFIED = "VERIFIED"
FAILED = "FAILED"
UNVERIFIABLE = "UNVERIFIABLE"
EMPTY = "EMPTY"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_UNVERIFIABLE = 2
EXIT_EMPTY = 3
EXIT_USAGE = 64
EXIT_INPUT_MISSING = 66

EXIT = {VERIFIED: EXIT_OK, FAILED: EXIT_FAILED,
        UNVERIFIABLE: EXIT_UNVERIFIABLE, EMPTY: EXIT_EMPTY}

# Stated in the artifact, not in docs the reader never opens. Each line is a
# claim the export does NOT support, phrased as the reader would be tempted to
# over-read it.
LIMITS = [
    "An UNSIGNED receipt proves INTEGRITY, not ORIGIN: the recorded bytes were "
    "not edited after they were hashed, but nothing here shows WHICH machine "
    "produced them. A forger who rewrites the facts and the headline "
    "consistently and recomputes the hash passes every check in this file. "
    "Only a gpg signature from a key you already trust proves origin.",

    "UNVERIFIABLE is not a soft pass. It means this machine could NOT check "
    "that axis, most often because the recorded diff cannot be re-derived "
    "outside the original repository. Read it as unchecked, never as clean.",

    "This export covers only the receipts DISCOVERED under the workspace. It "
    "cannot show a run that never wrote a receipt, so it is evidence about "
    "what was recorded, not proof that nothing else happened.",

    "Every verdict here was computed by the exporting machine at export time. "
    "Re-run the verifier yourself if you do not trust that machine; this file "
    "reports what was checked, it does not replace checking.",
]


def _cost_of(path):
    """The receipt's cost, or None when it was not MEASURED.

    measured_cost() reaches record_is_measured() in autonomy/lib/
    efficiency_cost.py, which is the single definition of "measured" in this
    repo. Restating it here is how the honesty rule drifts.
    """
    try:
        cost = measured_cost(_pv._load_proof(str(path)))
    except Exception:
        return None
    if cost is None:
        return None
    # `is None`, never falsy: a run that genuinely measured $0.00 is a real
    # observation and must survive as 0, not be erased into "unmeasured".
    return cost.get("cost_usd")


def _receipt_entry(path, repo_dir):
    """One receipt, verdict and axes straight from attest(). No judgement here.

    attest() already keeps VERIFIED / FAILED / UNVERIFIABLE apart per axis and
    refuses to collapse the third into either neighbour. Re-deriving any of it
    would be a second opinion this file is not entitled to hold.
    """
    record = attest(str(path), repo_dir)

    axes = {}
    for name, axis in (record.get("axes") or {}).items():
        # Carried whole, including the reason. An UNVERIFIABLE axis with its
        # reason stripped is indistinguishable from one nobody thought about.
        axes[name] = {"state": axis["state"], "reason": axis.get("reason", "")}

    signature = record.get("signature") or {}

    return {
        "path": str(path),
        "receipt_sha256": record.get("receipt_sha256"),
        "verdict": record.get("verdict"),
        "summary": record.get("summary"),
        "axes": axes,
        "signature": {
            "state": signature.get("state"),
            "status": signature.get("status"),
            "reason": signature.get("reason", ""),
        },
        # True means no valid signature vouches for the facts, so they are
        # taken at face value. Carried from verify() rather than inferred.
        "generator_trusted": bool(record.get("generator_trusted")),
        "cost_usd": _cost_of(path),
    }


def export(workspace, repo_dir="."):
    """Build the evidence record. Pure: reads only, writes nothing."""
    paths = find_receipts(workspace)
    receipts = [_receipt_entry(p, repo_dir) for p in paths]

    verdict = rollup([r["verdict"] for r in receipts])

    measured = [r["cost_usd"] for r in receipts if r["cost_usd"] is not None]
    cost = {
        "measured_receipts": len(measured),
        "total_receipts": len(receipts),
        # UNKNOWN when nothing measured, never 0.0. Unmeasured and free are
        # different claims and only one of them is honest. The COUNT decides,
        # not the sum, so a genuine total of $0.00 still reports as a number.
        "total_usd": sum(measured) if measured else None,
    }

    unsigned_n = sum(1 for r in receipts
                     if r["signature"].get("status") == "unsigned")

    return {
        "export": "loki-evidence-export/v1",
        "workspace": os.path.abspath(str(workspace)),
        "checked_from": os.path.abspath(repo_dir),
        # Counts of what was DISCOVERED. If these disagree with len(receipts),
        # something was dropped, and a reader can see it without trusting us.
        "counts": {
            state: sum(1 for r in receipts if r["verdict"] == state)
            for state in (FAILED, UNVERIFIABLE, VERIFIED)
        },
        "discovered": len(receipts),
        "receipts": receipts,
        "cost": cost,
        "unsigned_receipts": unsigned_n,
        "verdict": verdict,
        "does_not_prove": LIMITS,
        "summary": _summary(verdict, receipts, cost, unsigned_n),
    }


def _cost_line(cost):
    if cost["total_usd"] is None:
        return "total cost UNKNOWN (0 of %d receipts measured cost)" % (
            cost["total_receipts"],)
    return "total cost $%.4f across %d of %d receipts measured" % (
        cost["total_usd"], cost["measured_receipts"], cost["total_receipts"])


def _summary(verdict, receipts, cost, unsigned_n):
    if verdict == EMPTY:
        return ("EMPTY -- no receipts found under this workspace. Nothing was "
                "exported, because an export with no evidence in it is not a "
                "passing audit.")
    n = len(receipts)
    bad = sum(1 for r in receipts if r["verdict"] == FAILED)
    unv = sum(1 for r in receipts if r["verdict"] == UNVERIFIABLE)
    if verdict == VERIFIED:
        head = "VERIFIED -- all %d receipts verified here" % n
    elif verdict == FAILED:
        head = ("FAILED -- %d of %d receipts FAILED verification; this export "
                "is only as good as its weakest receipt" % (bad, n))
    else:
        head = ("UNVERIFIABLE -- %d of %d receipts could not be checked here; "
                "nothing failed, but nothing is proven either" % (unv, n))
    caveat = ""
    if unsigned_n:
        caveat = ("; %d of %d receipts are UNSIGNED, so their ORIGIN is not "
                  "proven -- only that their bytes were not edited after "
                  "hashing" % (unsigned_n, n))
    return head + ". " + _cost_line(cost) + caveat


def _render(record):
    lines = ["Evidence export: %s" % record["workspace"], ""]
    for r in record["receipts"]:
        lines.append("  %-13s %s" % (r["verdict"], r["path"]))
        for name, axis in sorted(r["axes"].items()):
            if axis["state"] != VERIFIED:
                lines.append("                %s %s: %s" % (
                    axis["state"], name, axis["reason"]))
    lines.append("")
    lines.append(record["summary"])
    lines.append("")
    lines.append("What this export does NOT prove:")
    for limit in record["does_not_prove"]:
        lines.append("  - %s" % limit)
    return "\n".join(lines)


class _Parser(argparse.ArgumentParser):
    # argparse exits 2 on a usage error, and 2 means "could not be checked" in
    # this repo -- a mistyped flag would read as a finding about the evidence.
    # Overriding error() rather than parse_args leaves --help exiting 0.
    def error(self, message):
        self.print_usage(sys.stderr)
        print("%s: error: %s" % (self.prog, message), file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def main(argv=None):
    ap = _Parser(
        description="Export every receipt under a workspace as ONE evidence "
                    "file a third party can check.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace to scan for receipts (default: .)")
    ap.add_argument("--out", default=None,
                    help="write the evidence file here (default: stdout only)")
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing --out file")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="print the raw record instead of the report")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are re-checked against")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.workspace):
        print("receipt-export: workspace does not exist: %s" % args.workspace,
              file=sys.stderr)
        return EXIT_INPUT_MISSING

    # Refuse BEFORE doing the work. Discovering the clobber after verifying
    # everything wastes the run, and worse, tempts a caller to pass --force
    # reflexively next time.
    if args.out and os.path.exists(args.out) and not args.force:
        print("receipt-export: refusing to overwrite %s without --force"
              % args.out, file=sys.stderr)
        return EXIT_USAGE

    record = export(args.workspace, args.repo_dir)

    # An empty workspace exports NOTHING. Writing a file whose only content is
    # "no evidence" makes an audit passable by deleting the receipts, and the
    # resulting file looks like evidence in a directory listing.
    if record["verdict"] == EMPTY:
        print(record["summary"], file=sys.stderr)
        return EXIT_EMPTY

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, sort_keys=True)
            f.write("\n")

    print(json.dumps(record, indent=2, sort_keys=True) if args.as_json
          else _render(record))
    return EXIT[record["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
