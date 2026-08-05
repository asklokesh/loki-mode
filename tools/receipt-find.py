#!/usr/bin/env python3
"""Find the receipts an auditor actually needs, out of a workspace full of them.

WHY THIS EXISTS. receipt-bundle.py verifies EVERY receipt under a workspace and
rolls them into one verdict. That is the right artifact to hand a compliance
reviewer, and the wrong one to work from. An auditor with three hundred runs is
not asking "is the archive sound"; they are asking "which run cost $40", "which
ones did not verify", "what has happened since the incident on the 12th".
Nothing queried receipts. This does, and the whole design problem is that a
filter is a claim about what it did NOT return.

THE RULES. Each is a specific way a result set can claim more than it earned.

1. AN UNMEASURED COST MATCHES NO NUMERIC FILTER, IN EITHER DIRECTION. A receipt
   that never recorded cost is not "under $5" and it is not "over $5" -- the
   comparison is undefined, and answering it either way invents a measurement.
   Treating unmeasured as 0.0 is the exact lie the cost-honesty line exists to
   prevent (v8.51.0-v8.54.0 fixed it on four surfaces); it would make every
   unmeasured run answer "cheapest in the archive". So unmeasured receipts are
   EXCLUDED from a cost filter and the exclusion is COUNTED and REPORTED. An
   auditor who asked for runs over $5 must be told the filter could not
   consider N of them, or they will read the result as exhaustive.

   The predicate is record_is_measured() in autonomy/lib/efficiency_cost.py,
   reached through receipt-diff.py's measured_cost(), which already maps the
   receipt's `cost.usd` onto the per-iteration `cost_usd` key it expects. A
   second copy of that predicate is how the honesty rule drifts, so there is
   not one here.

   Measured is necessary but NOT sufficient for a cost comparison:
   record_is_measured is true when ANY of five fields is non-zero, so a receipt
   with tokens but a null `usd` is honestly measured and still has no dollar
   figure. Both conditions are required -- see _usd().

2. ZERO MATCHES IS A RESULT; ZERO RECEIPTS IS NOT THE SAME FACT. "The filter
   ran and nothing qualified" and "there was nothing to search" look identical
   in a list of zero lines, and they mean opposite things: one is a clean
   answer, the other is a broken invocation pointed at the wrong directory.
   They get different summaries and different exit codes.

3. A MALFORMED RECEIPT IS COUNTED AND NAMED, NEVER SILENTLY SKIPPED. A search
   that drops what it cannot read reports a tidier archive than exists, and
   does it invisibly -- the reader sees only files that parsed and cannot tell
   whether the rest were irrelevant or unreadable. Same rule as the bundle's:
   absent is not clean.

4. A BAD --since IS REJECTED, NOT GUESSED. An unparseable date that silently
   matches everything (or nothing) returns a result set with no relation to the
   question asked, and looks exactly like a correct one.

5. FILTERS ARE AND, AND THE OUTPUT SAYS WHICH WERE APPLIED. A result set with
   no visible filter line can be pasted anywhere and read as "all receipts".

Usage:
    tools/receipt-find.py [workspace] [--min-usd N] [--max-usd N]
                          [--failed-only] [--since YYYY-MM-DD] [--json]

Exit codes:
    0  at least one receipt matched
    1  receipts were searched, none matched (a valid result, not an error)
    3  no receipts found at all -- nothing was searched
    2  usage error (argparse; e.g. an unparseable --since)
"""

import argparse
import datetime
import importlib.util
import json
import pathlib
import sys

# A stale .pyc can mask a mutation and turn a real probe into a false
# "MUTATION SURVIVED", since invalidation is mtime+size and a restore is
# byte-identical. Set before the loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]


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


# measured_cost() reuses record_is_measured() AND maps cost.usd -> cost_usd.
# Both halves of rule 1 already live there; this file must not restate either.
_rd = _load("receipt_diff", _ROOT / "tools" / "receipt-diff.py")
measured_cost = _rd.measured_cost

# The headline a receipt carries when the run did not verify. "VERIFIED WITH
# GAPS" is deliberately NOT failed -- it verified, with recorded gaps -- and a
# receipt with no headline at all is not silently treated as fine: it is
# UNKNOWN, reported in its own bucket, and never matched by --failed-only,
# because "we cannot tell" must not read as "it passed".
FAILED_HEADLINE = "NOT VERIFIED"


def _usd(proof):
    """The receipt's cost in dollars, or None when there is no such number.

    None means the comparison is UNDEFINED, and every caller must skip rather
    than substitute a value. Returning 0.0 here would make an unmeasured run
    the cheapest in the archive and match every --max-usd -- rule 1, and the
    single place it is decided.
    """
    rec = measured_cost(proof)
    if rec is None:
        return None
    return rec.get("cost_usd")


def _headline(proof):
    honesty = proof.get("honesty")
    if not isinstance(honesty, dict):
        return None
    h = honesty.get("headline")
    return h if isinstance(h, str) and h else None


def _date(proof):
    """The receipt's UTC date as YYYY-MM-DD, or None.

    Sliced, not parsed. generated_at ends in "Z", which datetime.fromisoformat
    rejects before Python 3.11, and this tool must behave identically on both
    interpreters. ISO dates compare correctly as strings, so a slice is both
    the portable answer and the smaller one.
    """
    v = proof.get("generated_at")
    if not isinstance(v, str) or len(v) < 10:
        return None
    d = v[:10]
    try:
        datetime.date.fromisoformat(d)
    except ValueError:
        return None
    return d


def find_receipts(workspace):
    """Every proof.json under the workspace, sorted for a stable report.

    ponytail: same rglob as receipt-bundle.find_receipts, so a receipt archived
    outside .loki/proofs/ is still findable. Deliberately not imported --
    receipt-bundle loads proof-verify and runs git per receipt, and this tool
    reads JSON only.
    """
    root = pathlib.Path(workspace)
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("proof.json") if p.is_file())


def search(workspace, min_usd=None, max_usd=None, failed_only=False,
           since=None):
    """Filter receipts under `workspace`. Pure: no writes, no network.

    Filters AND together (rule 5). A receipt excluded by the cost filter for
    being unmeasured is counted in `excluded_unmeasured` -- but only when a
    cost filter was actually applied, since without one nothing excluded it and
    reporting an exclusion would imply a filter it never faced.
    """
    cost_filtered = min_usd is not None or max_usd is not None
    paths = find_receipts(workspace)

    matches = []
    malformed = []
    excluded_unmeasured = 0

    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                proof = json.load(f)
            if not isinstance(proof, dict):
                raise ValueError("receipt is not a JSON object")
        except Exception as exc:
            # Rule 3: counted and named, with the reason. Never skipped.
            malformed.append({"path": str(path), "reason": str(exc)})
            continue

        why = []

        if cost_filtered:
            usd = _usd(proof)
            if usd is None:
                # Rule 1: undefined in BOTH directions. Not below, not above.
                excluded_unmeasured += 1
                continue
            if min_usd is not None and usd < min_usd:
                continue
            if max_usd is not None and usd > max_usd:
                continue
            why.append("cost.usd=%s" % usd)

        headline = _headline(proof)
        if failed_only:
            if headline != FAILED_HEADLINE:
                continue
            why.append("honesty.headline=%s" % headline)

        date = _date(proof)
        if since is not None:
            if date is None or date < since:
                continue
            why.append("generated_at=%s" % date)

        matches.append({
            "path": str(path),
            "matched": why,
            "cost_usd": _usd(proof),
            "headline": headline,
            "date": date,
        })

    return {
        "report": "loki-receipt-find/v1",
        "workspace": str(workspace),
        "filters": _filters(min_usd, max_usd, failed_only, since),
        "matches": matches,
        "match_count": len(matches),
        "scanned": len(paths),
        "malformed": malformed,
        "malformed_count": len(malformed),
        "excluded_unmeasured": excluded_unmeasured,
        "summary": _summary(len(paths), len(matches), len(malformed),
                            excluded_unmeasured,
                            _filters(min_usd, max_usd, failed_only, since)),
    }


def _filters(min_usd, max_usd, failed_only, since):
    """The applied filters, in the order they are applied.

    `is not None`, never truthiness: --min-usd 0 is a real filter, and reading
    it as "no filter" would make the output line state something untrue.
    """
    f = []
    if min_usd is not None:
        f.append("min-usd=%s" % min_usd)
    if max_usd is not None:
        f.append("max-usd=%s" % max_usd)
    if failed_only:
        f.append("failed-only")
    if since is not None:
        f.append("since=%s" % since)
    return f


def _summary(scanned, matched, malformed, excluded, filters):
    applied = ", ".join(filters) if filters else "none (no filter applied)"
    if scanned == 0:
        return ("NO RECEIPTS -- no proof.json found under this workspace, so "
                "nothing was searched. This is not the same as zero matches.")
    if matched == 0:
        # "found", not "searched": a malformed receipt is FOUND and counted,
        # and the malformed line below says it was NOT searched. Saying
        # "searched" here would contradict it in the same sentence.
        head = ("NO MATCHES -- %d receipt(s) found, none matched. The "
                "filter ran; the archive is not empty." % scanned)
    else:
        head = "%d of %d receipt(s) matched." % (matched, scanned)
    head += " Filters applied: %s." % applied
    if excluded:
        head += (" %d receipt(s) EXCLUDED from the cost filter: cost was never "
                 "measured, so it is neither above nor below the threshold."
                 % excluded)
    if malformed:
        head += (" %d receipt(s) could not be read and were NOT searched."
                 % malformed)
    return head


def _render(report):
    lines = []
    for m in report["matches"]:
        lines.append("%s  [%s]" % (m["path"], ", ".join(m["matched"]) or "-"))
    for bad in report["malformed"]:
        lines.append("MALFORMED %s  (%s)" % (bad["path"], bad["reason"]))
    lines.append("")
    lines.append(report["summary"])
    return "\n".join(lines)


def _since(value):
    """Rule 4: an unparseable --since is rejected, never guessed."""
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(
            "not a YYYY-MM-DD date: %r. A date that cannot be parsed would "
            "silently match everything or nothing." % value)


def main(argv=None):
    ap = _Parser(
        description="Find receipts under a workspace by measurable criteria.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace to search for receipts (default: .)")
    ap.add_argument("--min-usd", type=float, default=None,
                    help="only receipts whose measured cost is >= N")
    ap.add_argument("--max-usd", type=float, default=None,
                    help="only receipts whose measured cost is <= N")
    ap.add_argument("--failed-only", action="store_true",
                    help='only receipts whose headline is "%s"'
                         % FAILED_HEADLINE)
    ap.add_argument("--since", type=_since, default=None,
                    metavar="YYYY-MM-DD",
                    help="only receipts generated on or after this UTC date")
    ap.add_argument("--json", action="store_true",
                    help="emit the full report as JSON")
    args = ap.parse_args(argv)

    report = search(args.workspace, min_usd=args.min_usd,
                    max_usd=args.max_usd, failed_only=args.failed_only,
                    since=args.since)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(_render(report))

    if report["scanned"] == 0:
        return 3
    return 0 if report["match_count"] else 1


if __name__ == "__main__":
    sys.exit(main())
