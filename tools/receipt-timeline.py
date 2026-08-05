#!/usr/bin/env python3
"""What happened across an archive of receipts, in time order, and what CHANGED.

WHY THIS EXISTS. receipt-stats.py answers "what IS this archive" -- a census,
one number per axis, no order. receipt-diff.py answers "how do these TWO runs
compare". Neither answers the question an operator asks when something started
going wrong: what changed, and WHEN. That question is answered today by
sorting proof.json paths by eye and subtracting two cost figures in your head,
which is exactly the pipeline that gets the answer wrong in a predictable
direction -- toward a tidy, continuous, complete-looking story.

A timeline is more dangerous than a census, because a timeline asserts things a
census never does: that these events are ORDERED, that they are ADJACENT, and
that the difference between two neighbours is a real change in the world. Every
rule below exists because one of those three assertions can be made without
evidence.

THE RULES.

1. A RECEIPT WITH NO READABLE TIMESTAMP IS COUNTED AND REPORTED AS UNDATED.
   Never dropped, and never given an invented position in the order. Dropping
   it reports a shorter, cleaner history than exists -- and does it invisibly,
   which is the whole defect class. Slotting it in "where it probably goes"
   (path order, mtime, the end of the list) is worse: it manufactures an
   ADJACENCY the data does not support, and every delta computed across that
   adjacency is a fabricated change between two runs that may be months apart.

   So undated receipts land in their own section, they are counted in the
   census, and they carry NO delta at all -- not a zero one.

2. A COST DELTA AGAINST AN UNMEASURED RECEIPT IS UNKNOWN, NEVER A NUMBER.
   This is v8.51.0-v8.54.0 in its most seductive form. `curr - prev` with an
   absent measurement read as 0.0 does not merely print a wrong figure, it
   prints a wrong STORY: the run whose instrumentation broke shows up as the
   moment cost collapsed to nothing, or as the moment it exploded, depending
   on which side of the pair went dark. An unmeasured neighbour means there is
   no delta to state.

   The predicate is record_is_measured() in autonomy/lib/efficiency_cost.py,
   reached through receipt-diff.py's measured_cost(), which already maps the
   receipt's `cost.usd` onto the per-iteration `cost_usd` key that predicate
   reads. Neither half is restated here; a second copy is how the rule drifts.

   Measured is necessary but not sufficient. record_is_measured is true when
   ANY of five fields is non-zero, so a receipt carrying tokens and a null
   `usd` is honestly measured and still has no dollar figure. Both are
   required -- see _usd().

3. A MEASURED ZERO DELTA READS 0, NOT UNKNOWN. `is None` throughout, never
   truthiness. "The cost did not change" is a finding; a run that genuinely
   cost the same as the one before it is the single most useful cell in this
   table, and `if delta:` erases exactly that cell. The two ways to be
   dishonest about a measurement are to invent one and to discard one, and
   rule 3 is rule 2 pointed the other way.

4. FEWER THAN TWO RECEIPTS CANNOT SHOW A CHANGE, AND SAYS SO. One receipt has
   nothing to be compared against. Printing it with an empty change column
   renders as "nothing changed" -- a claim about stability drawn from an
   archive that could not have detected instability. That is stated in words,
   and it is a DIFFERENT statement from "this receipt is the first in a longer
   chain", which is why they are separate messages.

5. ZERO RECEIPTS IS NOT A CLEAN ARCHIVE. It gets exit 3 and says in words that
   it is most often the wrong directory.

WHAT THIS IS NOT. This is an ADVISOR, not a gate, and the distinction is
pinned by tests/test_tool_exit_contract.py. A FAILED receipt in the history
does not make this exit 1 -- receipt-bundle.py is the gate that refuses to
merge on one, and re-deriving its weakest-link rule here would be a second
copy of a verdict predicate. An archive whose costs were never measured still
exits 0: "every receipt is readable, and none recorded a cost" is a complete,
honest answer, and the output says UNKNOWN in words. Forcing it non-zero would
make the honest answer look like a tool failure.

Verdict classification is receipt_state() from receipt-bundle.py, wrapping
verify() from autonomy/lib/proof-verify.py. Nothing here re-implements it.

Usage:
    tools/receipt-timeline.py [workspace] [--repo-dir DIR] [--json]

Exit codes:
    0   receipts were found and laid out in time order
    3   the workspace exists but holds no receipts -- nothing to show
    64  usage error (unknown flag, bad argument)
    66  the workspace path does not exist
"""

import argparse
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc can mask a mutation and turn a real probe into a false
# "MUTATION SURVIVED", since invalidation is mtime+size and a restore is
# byte-identical. Set before the loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# receipt_state() wraps verify() and keeps VERIFIED / FAILED / UNVERIFIABLE
# apart with the `is`-comparisons that make that correct. measured_cost()
# reuses record_is_measured() AND maps cost.usd -> cost_usd. Both imported,
# never restated.
_rb = _load("receipt_bundle", _ROOT / "tools" / "receipt-bundle.py")
receipt_state = _rb.receipt_state
measured_cost = _rb.measured_cost

VERIFIED = _rb.VERIFIED
UNVERIFIABLE = _rb.UNVERIFIABLE
FAILED = _rb.FAILED

MALFORMED = "MALFORMED"


def _usd(proof):
    """The receipt's cost in dollars, or None when there is no such number.

    None means UNMEASURED, and every caller must abstain rather than
    substitute. Two independent ways to be absent, both mapped to None: the
    whole record was never measured, and the record was measured on tokens but
    carries no `usd` figure. Rule 2 covers both, because a delta needs the
    dollar number specifically.
    """
    rec = measured_cost(proof)
    if rec is None:
        return None
    return rec.get("cost_usd")


def _when(proof):
    """The receipt's generated_at as a sortable ISO string, or None.

    Compared as a string, not parsed. generated_at ends in "Z", which
    datetime.fromisoformat rejects before Python 3.11, and this tool must
    behave identically on every interpreter it runs under. ISO-8601 UTC
    timestamps sort lexicographically in exactly chronological order, so the
    string IS the key.

    None is the answer for anything that is not a plausible timestamp, and
    None routes the receipt to the undated section (rule 1) rather than to a
    guessed position. The bar is deliberately low -- a full-precision parse
    would reject valid variants and manufacture undated receipts out of dated
    ones -- but it is not zero: a value must at least carry a date-shaped
    prefix, or "not a timestamp" and "a timestamp we mis-sorted" become the
    same outcome.
    """
    v = proof.get("generated_at")
    if not isinstance(v, str) or len(v) < 10:
        return None
    head = v[:10]
    if head[4] != "-" or head[7] != "-":
        return None
    if not (head[:4].isdigit() and head[5:7].isdigit() and head[8:10].isdigit()):
        return None
    return v


def _cost_change(prev_usd, curr_usd):
    """(delta, why) for one step. delta is None exactly when UNKNOWN.

    Rules 2 and 3 in one place. `is None` on BOTH sides: a measured $0.0000 is
    a real observation on either end of the subtraction, and truthiness would
    silently reclassify it as unmeasured -- the same erasure this file exists
    to prevent, applied to the operand instead of the result.
    """
    if prev_usd is None or curr_usd is None:
        side = ("neither receipt" if prev_usd is None and curr_usd is None
                else "the previous receipt" if prev_usd is None
                else "this receipt")
        return None, ("cost delta UNKNOWN -- %s recorded a measured cost, and "
                      "an absent measurement is not $0.00" % side)
    return curr_usd - prev_usd, ""


def _gate_regressions(prev_gates, curr_gates):
    """Gates that PASSED in the previous receipt and FAIL in this one.

    Only that direction, and only on gates present in BOTH receipts. A gate
    absent from one side did not change state; it was not observed, and
    reporting "gate X now fails" on the strength of its first-ever appearance
    is an invented transition. Absent is not passing and absent is not failing.
    """
    if not isinstance(prev_gates, dict) or not isinstance(curr_gates, dict):
        return []
    out = []
    for name in sorted(set(prev_gates) & set(curr_gates)):
        if _passed(prev_gates[name]) is True and _passed(curr_gates[name]) is False:
            out.append(name)
    return out


def _passed(value):
    """True / False / None for one gate entry. None means NOT OBSERVED.

    Three states, because a gate whose result we cannot read has not passed
    and has not failed. Folding the unreadable case into False would report a
    fabricated regression the first time a receipt schema changes shape.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, dict):
        for key in ("passed", "ok", "pass"):
            if isinstance(value.get(key), bool):
                return value[key]
        status = value.get("status")
        if isinstance(status, str):
            low = status.strip().lower()
            if low in ("pass", "passed", "ok", "green"):
                return True
            if low in ("fail", "failed", "error", "red"):
                return False
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("pass", "passed", "ok", "green"):
            return True
        if low in ("fail", "failed", "error", "red"):
            return False
    return None


def _gates(proof):
    """The receipt's gate results, or {} when the receipt records none."""
    for key in ("gates", "quality_gates"):
        block = proof.get(key)
        if isinstance(block, dict):
            return block
        if isinstance(block, list):
            named = {}
            for entry in block:
                if isinstance(entry, dict) and isinstance(entry.get("name"), str):
                    named[entry["name"]] = entry
            return named
    return {}


def timeline(rows):
    """Order `rows` oldest-first and compute what changed at each step.

    Pure: no filesystem, no verification, no clock. Every rule above is
    enforced here, so a defect in any of them is provable against a literal
    list of dicts.

    Each input row is {path, state, reason, when, cost_usd, gates}. `when` is
    None for an undated receipt (rule 1).

    Returns {dated, undated, comparable, note}. Undated rows keep their input
    order, are never merged into `dated`, and carry no delta -- an adjacency
    the data does not support is the same invention as a made-up sort position.
    """
    dated = [r for r in rows if r.get("when") is not None]
    undated = [r for r in rows if r.get("when") is None]

    # Sort by timestamp, path second, so two receipts sharing a timestamp still
    # land in a stable order rather than an arbitrary one.
    dated = sorted(dated, key=lambda r: (r["when"], r["path"]))

    steps = []
    prev = None
    for row in dated:
        entry = dict(row)
        if prev is None:
            # Distinct from rule 4's message. "First in a longer chain" and
            # "the only receipt there is" are different facts, and only the
            # second one says the archive cannot show change at all.
            entry["cost_delta_usd"] = None
            entry["change"] = ("first receipt in the timeline -- there is no "
                               "earlier run to compare it against")
            entry["gate_regressions"] = []
        else:
            delta, why = _cost_change(prev.get("cost_usd"), row.get("cost_usd"))
            entry["cost_delta_usd"] = delta
            regressions = _gate_regressions(prev.get("gates"), row.get("gates"))
            entry["gate_regressions"] = regressions
            entry["change"] = _change_line(delta, why, regressions)
        steps.append(entry)
        prev = row

    undated_out = []
    for row in undated:
        entry = dict(row)
        # Rule 1: counted, reported, and explicitly WITHOUT a delta. Not a
        # zero delta, which would read as "nothing changed".
        entry["cost_delta_usd"] = None
        entry["gate_regressions"] = []
        entry["change"] = ("UNDATED -- this receipt records no readable "
                           "generated_at, so it has no position in the order "
                           "and no previous receipt to compare against. It is "
                           "counted here, not dropped.")
        undated_out.append(entry)

    total = len(dated) + len(undated)
    comparable = len(dated) >= 2

    if total == 0:
        note = ("NO RECEIPTS -- no proof.json found under this workspace, so "
                "there was no history to lay out. Zero receipts is not a clean "
                "archive; it is most often the wrong directory.")
    elif not comparable:
        # Rule 4, stated in words rather than left as an empty column.
        note = ("%d receipt(s), %d of them dated: a timeline needs at least "
                "TWO dated receipts to show a change, so NOTHING here is a "
                "comparison. An empty change column would read as 'nothing "
                "changed', which is a claim this archive cannot support."
                % (total, len(dated)))
    else:
        note = "%d dated receipt(s) in order" % len(dated)
        if undated:
            note += (", plus %d UNDATED receipt(s) held out of the order "
                     "(counted, not dropped)" % len(undated))

    return {
        "dated": steps,
        "undated": undated_out,
        "comparable": comparable,
        "note": note,
    }


def _change_line(delta, why, regressions):
    """One sentence for the change column. Never blank on a comparable step."""
    if delta is None:
        parts = [why]
    elif delta > 0:
        parts = ["cost ROSE $%.4f" % delta]
    elif delta < 0:
        parts = ["cost FELL $%.4f" % -delta]
    else:
        # Rule 3. A measured zero is an observation, and it is the cell an
        # operator most often wants; `if delta:` would blank exactly this one.
        parts = ["cost UNCHANGED (measured $0.0000 delta)"]
    if regressions:
        parts.append("GATE REGRESSION: %s passed in the previous receipt and "
                     "now FAILS" % ", ".join(regressions))
    return "; ".join(parts)


def find_receipts(workspace):
    """Every proof.json under the workspace, sorted for a stable report.

    ponytail: same rglob as receipt-bundle.find_receipts, so a receipt archived
    outside .loki/proofs/ is still counted. Not imported, because that one
    assumes the directory exists and this tool must tell a missing workspace
    (exit 66) apart from an empty one (exit 3).
    """
    root = pathlib.Path(workspace)
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("proof.json") if p.is_file())


def scan(workspace, repo_dir="."):
    """Read every receipt under `workspace` and lay it out in time order."""
    rows = []
    malformed = []

    for path in find_receipts(workspace):
        try:
            with open(path, "r", encoding="utf-8") as f:
                proof = json.load(f)
            if not isinstance(proof, dict):
                raise ValueError("receipt is not a JSON object")
        except Exception as exc:
            # Counted and NAMED, never dropped -- and undated by construction,
            # so it lands in the undated section rather than at a guessed
            # point in the order.
            malformed.append({"path": str(path), "reason": str(exc)})
            rows.append({
                "path": str(path), "state": MALFORMED, "reason": str(exc),
                "when": None, "cost_usd": None, "gates": {},
            })
            continue

        state, reason = receipt_state(path, repo_dir)
        rows.append({
            "path": str(path), "state": state, "reason": reason,
            "when": _when(proof), "cost_usd": _usd(proof),
            "gates": _gates(proof),
        })

    tl = timeline(rows)
    return {
        "report": "loki-receipt-timeline/v1",
        "workspace": os.path.abspath(str(workspace)),
        "checked_from": os.path.abspath(repo_dir),
        "dated": tl["dated"],
        "undated": tl["undated"],
        "receipt_count": len(rows),
        "dated_count": len(tl["dated"]),
        "undated_count": len(tl["undated"]),
        "comparable": tl["comparable"],
        "malformed": malformed,
        "malformed_count": len(malformed),
        "note": tl["note"],
    }


def _row_line(row):
    # `is None`, not truthiness, per rule 3 -- consistently with every other
    # absence test in this file, so a reader never has to work out which
    # falsy values this one line happens to be safe against.
    when = "UNDATED" if row["when"] is None else row["when"]
    # "-" for an unmeasured cost, never "$0.0000". The table is the surface an
    # operator eyeballs, and it must not be the one place the archive looks
    # free.
    usd = "-" if row["cost_usd"] is None else "$%.4f" % row["cost_usd"]
    return "%-26s %-13s %-11s %s" % (when, row["state"], usd, row["path"])


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error; here 2 means "could not check".

    A mistyped flag would otherwise be indistinguishable from a blind gate --
    the operator sees the code that means "your instrumentation is broken" and
    goes looking for broken instrumentation. 64 is the usage error.

    error() only. --help routes through exit(), not error(), and overriding
    exit() would break the exit-0 contract that test_tool_exit_contract.py
    asserts for every tool's --help.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def main(argv=None):
    ap = _Parser(
        description="Show what happened across an archive of receipts, in "
                    "time order, and what changed at each step.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace holding the receipts (default: .)")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are verified against "
                         "(default: .)")
    ap.add_argument("--json", action="store_true",
                    help="emit the full report as JSON")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.workspace):
        # 66, not 3. "You pointed me at nothing" and "this archive is empty"
        # are different facts, and only one of them is about the archive.
        sys.stderr.write(
            "receipt-timeline: workspace does not exist: %s\n" % args.workspace)
        return 66

    report = scan(args.workspace, args.repo_dir)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for row in report["dated"]:
            print(_row_line(row))
            print("    %s" % row["change"])
        if report["undated"]:
            print("")
            print("UNDATED -- held out of the order, counted, not dropped:")
            for row in report["undated"]:
                print(_row_line(row))
                print("    %s" % row["change"])
        print("")
        print(report["note"])

    return 0 if report["receipt_count"] else 3


if __name__ == "__main__":
    sys.exit(main())
