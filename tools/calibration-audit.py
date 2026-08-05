#!/usr/bin/env python3
"""Score council voters against the council's own outcome, over history already on disk.

WHY THIS EXISTS. Every iteration writes a council transcript recording who voted
which way and what the council decided. Nothing has ever gone back and asked the
obvious follow-up: when a voter says APPROVE, how often does that hold? A voter
who approves everything is indistinguishable from a careful one on any single
iteration, and the transcripts have been accumulating the evidence to tell them
apart the whole time.

This reads those files and nothing else. It starts no build, calls no model,
spends nothing, and changes no default behaviour. It is a REPORTER, not a gate:
it exits 0 on terrible calibration, because a reporter that fails CI would just
be turned off.

THE LABELLING CONVENTION, which is the one thing a reader should argue with.

  prediction = 1.0 when a voter's verdict is APPROVE, 0.0 when REJECT
  label      = 1 when the transcript's `outcome` is APPROVED, else 0

That convention has a circularity in it, and pretending otherwise would be the
dishonest move. The council outcome is MECHANICALLY DERIVED from the votes
(`approve_count >= threshold`), so a voter's own prediction partially CAUSES the
label it is then scored against. What this measures is therefore AGREEMENT WITH
THE COUNCIL MAJORITY, not accuracy against ground truth. A voter scoring
perfectly here may simply be voting with the crowd. No artifact on disk records
whether the council was actually right, so ground-truth calibration is not
computable from this substrate at all -- and it is reported that way rather than
approximated. The convention is printed with every run so a reader can disagree
with it without reading this source.

PREDICTIONS ARE BINARY, which shapes everything downstream. Voters emit a
verdict, not a probability, so every prediction is exactly 0.0 or 1.0. The
reliability curve therefore has at most two occupied bins no matter how many
bins are requested; the rest are empty by construction, not by accident. They
print as UNKNOWN, never as 0.0, because "no voter ever predicted 0.35" and
"voters predicted 0.35 and were never right" are opposite findings.

ECE DEPENDS ON ITS BIN COUNT. The number changes when the bin count changes,
so the bin count is printed next to every ECE and stated as a knob. An ECE
quoted without its bin count is not a measurement.

SUPPORT IS PRINTED EVERYWHERE, and a headline is REFUSED below a floor
(default 30 predictions). A Brier score over four samples is noise wearing a
decimal point, and the most expensive thing this tool could do is hand someone
a confident number derived from a handful of rows.

PREDICTIONS ARE CLUSTERED, and the count is printed alongside the transcript
count for that reason. Every voter in one transcript is scored against the SAME
label, so N votes drawn from M transcripts carry nowhere near N independent
observations -- the effective sample size is nearer M. Printing the pooled vote
count alone would inflate apparent support by roughly the council size, which
in a tool built to refuse overstatement would be the same defect it exists to
prevent. The floor is applied to predictions because that is the stated knob,
and the transcript count is printed next to it so a reader can apply their own.

WHAT THE ARTIFACTS CANNOT SUPPORT. The brief asked for breakdowns by gate,
model and task. None of the three is recorded, and each is reported NOT
AVAILABLE with its reason rather than approximated by a nearby field:

  by gate   -- `outcome` can be BLOCKED_BY_GATE, but that is a gate OUTCOME,
               not a gate IDENTITY. No gate id or name appears anywhere in the
               transcript, so votes cannot be grouped by which gate blocked.
  by model  -- `voters[].name` is the ROLE (it is populated from `v.role` in
               councilWriteTranscript). Which model backed a role is not
               written. Role is not a model and is reported as its own axis.
  by task   -- `prd_path` and `task_or_prd` (the first 200 chars of the PRD)
               identify the RUN, not a task, and are effectively constant
               across every transcript in one .loki dir, so they separate
               nothing.

Nearby numbers exist that would each make a plausible-looking proxy, and all
are deliberately refused. `last_confidence` is a real number, but it lives in
council STATE (loki-ts/src/runner/council.ts:129) as a single run-level scalar,
not per voter and not in the transcript; joining it onto voters would invent a
per-voter confidence that was never recorded. `.loki/state/uncertainty.json`
holds BOOLEAN uncertainty proxies, not a confidence, and cannot be read as one.

MISSINGNESS IS A RESULT, not a footnote. Skipped transcripts, absent fields and
CANNOT_VALIDATE votes each get their own counted line. CANNOT_VALIDATE is
EXCLUDED from the calibration sample -- a voter declining to assert is not a
wrong probabilistic assertion -- which means the sample size here will NOT match
the transcript's own `reject_count`, since that field lumps CANNOT_VALIDATE in
with REJECT. That discrepancy is stated in the output so it does not read as
dropped rows.

Exit codes follow the tools/ convention:
  0  reported
  2  could NOT check (transcript files found, none parseable)
  3  nothing to report (no transcript files)
  64 usage error
  66 input path missing

Usage:
  tools/calibration-audit.py [workspace] [--bins N] [--min-support N] [--json]
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

UNKNOWN = "UNKNOWN"

# Below this many usable predictions, no headline calibration number is
# presented. Stated in the output, and overridable, because the right floor is
# a judgement call and a hidden judgement call is one nobody can challenge.
DEFAULT_MIN_SUPPORT = 30
DEFAULT_BINS = 10

# Dimensions the brief asked for that the artifacts do not record. Printed
# verbatim so the refusal is visible to a reader who never opens this file.
NOT_AVAILABLE = [
    ("gate", "outcome can be BLOCKED_BY_GATE, but that is a gate OUTCOME, "
             "not a gate IDENTITY; no gate id or name is written to the "
             "transcript, so votes cannot be grouped by gate"),
    ("model", "voters[].name is the ROLE (populated from v.role in "
              "councilWriteTranscript); which model backed a role is never "
              "recorded, and role is reported as its own axis instead"),
    ("task", "prd_path and task_or_prd (first 200 chars of the PRD) identify "
             "the RUN, not a task, and are effectively constant across every "
             "transcript in one .loki dir, so they separate nothing"),
]


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, and 2 already means something else.

    In this convention 2 is "could NOT check" -- a real answer about the
    history. A typo in a flag is not that; it is 64. Left alone, `--bnis`
    would report as a failed scan and a caller could not tell the two apart.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def transcripts_dir(workspace):
    return os.path.join(workspace, ".loki", "council", "transcripts")


def load_votes(directory):
    """Read every transcript, returning (votes, missingness).

    A vote is a flat record so the breakdowns are plain groupings. Anything
    that could not be turned into a vote is counted rather than dropped
    silently: a scan that quietly discards half its input reports on a
    population nobody chose.
    """
    miss = {
        "files_found": 0,
        "files_unparseable": 0,
        "files_missing_voters": 0,
        "files_missing_outcome": 0,
        "transcripts_used": 0,
        "voters_seen": 0,
        "votes_cannot_validate": 0,
        "votes_unknown_verdict": 0,
        "votes_missing_name": 0,
        "votes_missing_role_index": 0,
        "outcome_blocked_by_gate": 0,
    }
    votes = []

    try:
        names = sorted(n for n in os.listdir(directory) if n.endswith(".json"))
    except OSError:
        return votes, miss

    for name in names:
        miss["files_found"] += 1
        path = os.path.join(directory, name)
        try:
            with open(path) as handle:
                data = json.load(handle)
            if not isinstance(data, dict):
                raise ValueError("not an object")
        except (OSError, ValueError):
            miss["files_unparseable"] += 1
            continue

        outcome = data.get("outcome")
        if not isinstance(outcome, str):
            miss["files_missing_outcome"] += 1
            continue
        voters = data.get("voters")
        if not isinstance(voters, list) or not voters:
            miss["files_missing_voters"] += 1
            continue

        # The label. BLOCKED_BY_GATE is not APPROVED, so under the stated
        # convention it labels 0 -- counted separately so a reader who reads
        # it differently can re-derive without re-running.
        if outcome == "BLOCKED_BY_GATE":
            miss["outcome_blocked_by_gate"] += 1
        label = 1 if outcome == "APPROVED" else 0

        miss["transcripts_used"] += 1
        for voter in voters:
            if not isinstance(voter, dict):
                miss["votes_unknown_verdict"] += 1
                continue
            miss["voters_seen"] += 1
            verdict = voter.get("verdict")

            # CANNOT_VALIDATE is a refusal to assert, not a wrong assertion.
            # Excluding it is a choice, so it is counted where it is visible.
            if verdict == "CANNOT_VALIDATE":
                miss["votes_cannot_validate"] += 1
                continue
            if verdict == "APPROVE":
                prediction = 1.0
            elif verdict == "REJECT":
                prediction = 0.0
            else:
                miss["votes_unknown_verdict"] += 1
                continue

            voter_name = voter.get("name")
            if not isinstance(voter_name, str) or not voter_name:
                miss["votes_missing_name"] += 1
                voter_name = UNKNOWN
            role_index = voter.get("role_index")
            if not isinstance(role_index, int):
                miss["votes_missing_role_index"] += 1
                role_index = UNKNOWN

            contrarian = voter.get("is_contrarian")
            votes.append({
                "prediction": prediction,
                "label": label,
                "name": voter_name,
                "role_index": role_index,
                "is_contrarian": (contrarian if isinstance(contrarian, bool)
                                  else UNKNOWN),
            })

    return votes, miss


def brier(votes):
    """Mean squared error of prediction against label. UNKNOWN over nothing."""
    if not votes:
        return UNKNOWN
    total = sum((v["prediction"] - v["label"]) ** 2 for v in votes)
    return total / len(votes)


def reliability(votes, bins):
    """Per-bin predicted rate vs observed rate, WITH support.

    EVERY bin is returned, including the empty ones, and an empty bin carries
    UNKNOWN rather than 0.0. Predictions here are binary, so most bins are
    empty by construction -- reporting those as a 0.0 observed rate would
    manufacture a perfectly-wrong-looking region of the curve out of the
    absence of data.
    """
    table = []
    for index in range(bins):
        low = index / bins
        high = (index + 1) / bins
        # Half-open bins, with the last one closed so prediction 1.0 lands.
        if index == bins - 1:
            members = [v for v in votes if low <= v["prediction"] <= high]
        else:
            members = [v for v in votes if low <= v["prediction"] < high]
        if members:
            predicted = sum(v["prediction"] for v in members) / len(members)
            observed = sum(v["label"] for v in members) / len(members)
        else:
            predicted = UNKNOWN
            observed = UNKNOWN
        table.append({
            "bin": index,
            "range": [low, high],
            "support": len(members),
            "predicted_rate": predicted,
            "observed_rate": observed,
        })
    return table


def ece(votes, bins):
    """Support-weighted mean gap between predicted and observed rate.

    Empty bins contribute nothing. That is the DEFINITION of the
    support-weighted sum, not an imputation: a bin with no support has no
    weight, so it cannot pull the number in either direction. It is a
    different thing from treating its observed rate as 0.0, which would.
    """
    if not votes:
        return UNKNOWN
    table = reliability(votes, bins)
    total = 0.0
    for row in table:
        if row["support"] == 0:
            continue
        gap = abs(row["predicted_rate"] - row["observed_rate"])
        total += (row["support"] / len(votes)) * gap
    return total


def group(votes, key, bins):
    """Break the sample down by one recorded field, keeping support per group."""
    buckets = {}
    for vote in votes:
        buckets.setdefault(str(vote[key]), []).append(vote)
    return [
        {
            "value": value,
            "support": len(members),
            "brier": brier(members),
            "ece": ece(members, bins),
            "approve_rate": sum(v["prediction"] for v in members) / len(members),
            "observed_rate": sum(v["label"] for v in members) / len(members),
        }
        for value, members in sorted(buckets.items())
    ]


def audit(workspace, bins, min_support):
    votes, miss = load_votes(transcripts_dir(workspace))
    enough = len(votes) >= min_support
    return {
        "bins": bins,
        "min_support": min_support,
        "total_predictions": len(votes),
        "sufficient_support": enough,
        # The headline is WITHHELD below the floor rather than printed small.
        # A number a reader can see is a number a reader will quote.
        "brier": brier(votes) if enough else UNKNOWN,
        "ece": ece(votes, bins) if enough else UNKNOWN,
        "reliability": reliability(votes, bins),
        "by_name": group(votes, "name", bins),
        "by_role_index": group(votes, "role_index", bins),
        "by_is_contrarian": group(votes, "is_contrarian", bins),
        "missingness": miss,
        "not_available": [{"dimension": d, "reason": r}
                          for d, r in NOT_AVAILABLE],
    }


def _num(value):
    return UNKNOWN if value == UNKNOWN else "%.4f" % value


def _exit_code(report):
    miss = report["missingness"]
    if miss["files_found"] == 0:
        return 3  # nothing to report
    if miss["transcripts_used"] == 0:
        # Files were there and none survived parsing. That is a FAILED scan,
        # not an empty one, and collapsing it into 3 would let a directory of
        # corrupt transcripts read as "nothing to report".
        return 2
    return 0


def _render(report, code):
    bins = report["bins"]
    total = report["total_predictions"]
    miss = report["missingness"]
    lines = ["COUNCIL CALIBRATION AUDIT"]
    lines.append("  reads .loki/council/transcripts only; starts nothing, "
                 "spends nothing")
    lines.append("")
    lines.append("LABELLING CONVENTION (disagree with this before the numbers)")
    lines.append("  prediction = 1.0 for APPROVE, 0.0 for REJECT")
    lines.append("  label      = 1 when outcome == APPROVED, else 0")
    lines.append("  CANNOT_VALIDATE is EXCLUDED: declining to assert is not a")
    lines.append("    wrong assertion. So this sample size will NOT match the")
    lines.append("    transcript reject_count, which lumps it in with REJECT.")
    lines.append("  CIRCULARITY: outcome is derived from the votes")
    lines.append("    (approve_count >= threshold), so a voter's prediction")
    lines.append("    partly CAUSES its own label. This measures AGREEMENT")
    lines.append("    WITH THE MAJORITY, not accuracy against ground truth.")
    lines.append("    No artifact records whether the council was right.")
    lines.append("  Predictions are BINARY (a verdict, not a probability), so")
    lines.append("    at most two bins can ever be occupied.")

    if code == 3:
        lines.append("")
        lines.append("NOTHING TO REPORT -- no transcript files found.")
        lines.append("  Scanning nothing is not evidence of good calibration.")
        return "\n".join(lines)
    if code == 2:
        lines.append("")
        lines.append("CANNOT CHECK -- %d transcript file(s) found, none "
                     "parseable." % miss["files_found"])
        return "\n".join(lines)

    lines.append("")
    lines.append("SUPPORT")
    lines.append("  usable predictions: %d   from %d transcript(s)"
                 % (total, miss["transcripts_used"]))
    lines.append("  Votes within one transcript share a label, so predictions")
    lines.append("    are CLUSTERED, not independent: the effective sample")
    lines.append("    size is nearer the transcript count than the vote count.")
    lines.append("  The floor below is applied to PREDICTIONS (the stated "
                 "knob): %d" % report["min_support"])
    if not report["sufficient_support"]:
        lines.append("")
        lines.append("  INSUFFICIENT SUPPORT -- headline calibration numbers "
                     "are WITHHELD.")
        lines.append("  Usable predictions (%d) is below the stated floor (%d)."
                     % (total, report["min_support"]))
        lines.append("  The breakdowns below are printed with their support so "
                     "they can be")
        lines.append("  read as counts, not as calibration.")
    else:
        lines.append("")
        lines.append("HEADLINE")
        lines.append("  Brier score: %s   (0 is perfect, lower is better)"
                     % _num(report["brier"]))
        lines.append("  ECE:         %s   at %d bins"
                     % (_num(report["ece"]), bins))
        lines.append("  ECE depends on its bin count: changing --bins changes "
                     "this number.")

    lines.append("")
    lines.append("RELIABILITY TABLE (%d bins; empty bins are UNKNOWN, not 0)"
                 % bins)
    lines.append("  %-14s %8s %10s %10s" % ("bin", "support", "predicted",
                                            "observed"))
    for row in report["reliability"]:
        lines.append("  %-14s %8d %10s %10s"
                     % ("[%.2f,%.2f]" % (row["range"][0], row["range"][1]),
                        row["support"], _num(row["predicted_rate"]),
                        _num(row["observed_rate"])))

    for title, key in (("BY VOTER NAME (role)", "by_name"),
                       ("BY ROLE INDEX", "by_role_index"),
                       ("BY IS_CONTRARIAN", "by_is_contrarian")):
        lines.append("")
        lines.append(title)
        rows = report[key]
        if not rows:
            lines.append("  UNKNOWN -- no usable votes carried this field")
            continue
        lines.append("  %-28s %8s %9s %9s" % ("value", "support", "brier",
                                              "ece"))
        for row in rows:
            flag = "" if row["support"] >= report["min_support"] else "  (low)"
            lines.append("  %-28s %8d %9s %9s%s"
                         % (row["value"][:28], row["support"],
                            _num(row["brier"]), _num(row["ece"]), flag))

    lines.append("")
    lines.append("NOT AVAILABLE -- asked for, not recorded, not approximated")
    for item in report["not_available"]:
        lines.append("  by %s: %s" % (item["dimension"], item["reason"]))

    lines.append("")
    lines.append("MISSINGNESS")
    lines.append("  transcript files found:      %d" % miss["files_found"])
    lines.append("  transcripts used:            %d" % miss["transcripts_used"])
    lines.append("  files unparseable:           %d" % miss["files_unparseable"])
    lines.append("  files with no voters[]:      %d"
                 % miss["files_missing_voters"])
    lines.append("  files with no outcome:       %d"
                 % miss["files_missing_outcome"])
    lines.append("  voter entries seen:          %d" % miss["voters_seen"])
    lines.append("  CANNOT_VALIDATE (excluded):  %d"
                 % miss["votes_cannot_validate"])
    lines.append("  unusable verdict:            %d"
                 % miss["votes_unknown_verdict"])
    lines.append("  votes with no name:          %d" % miss["votes_missing_name"])
    lines.append("  votes with no role_index:    %d"
                 % miss["votes_missing_role_index"])
    lines.append("  outcome BLOCKED_BY_GATE:     %d   (labelled 0 here)"
                 % miss["outcome_blocked_by_gate"])

    lines.append("")
    lines.append("This is a REPORTER, not a gate. It exits 0 even when "
                 "calibration is bad.")
    return "\n".join(lines)


def main(argv=None):
    parser = _Parser(
        description="Audit council voter calibration over transcripts on disk.")
    parser.add_argument("workspace", nargs="?", default=".",
                        help="workspace root holding .loki (default: cwd)")
    parser.add_argument("--bins", type=int, default=DEFAULT_BINS,
                        help="reliability bin count (default: %d); changing "
                             "it changes ECE" % DEFAULT_BINS)
    parser.add_argument("--min-support", type=int, default=DEFAULT_MIN_SUPPORT,
                        help="predictions required before a headline "
                             "calibration number is presented (default: %d)"
                             % DEFAULT_MIN_SUPPORT)
    parser.add_argument("--json", action="store_true",
                        help="emit machine-readable output")
    args = parser.parse_args(argv)

    if not os.path.exists(args.workspace):
        payload = {"status": "input_missing", "exit_code": 66,
                   "error": "no such path: " + args.workspace}
        print(json.dumps(payload, indent=2) if args.json
              else "INPUT MISSING -- no such path: " + args.workspace)
        return 66
    if args.bins < 1:
        parser.error("--bins must be at least 1")
    if args.min_support < 0:
        parser.error("--min-support cannot be negative")

    report = audit(args.workspace, args.bins, args.min_support)
    code = _exit_code(report)
    if args.json:
        report["status"] = {3: "nothing_to_report", 2: "cannot_check"}.get(
            code, "reported")
        report["exit_code"] = code
        print(json.dumps(report, indent=2))
    else:
        print(_render(report, code))
    return code


if __name__ == "__main__":
    sys.exit(main())
