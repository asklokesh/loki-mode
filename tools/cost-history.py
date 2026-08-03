#!/usr/bin/env python3
"""Track agent cost across MANY runs and report the trend.

cost-guard.py gates ONE run against a ceiling. receipt-diff.py compares TWO
runs. Neither answers the question a team actually asks at the end of a month:
is our agent spend trending up? That needs a durable history, so this appends
one line per run to a JSONL file and reports over the whole series.

THE FIVE PROPERTIES THAT MAKE THE TREND WORTH BELIEVING:

1. AN UNMEASURED RUN IS NEVER RECORDED AS 0. It is appended with usd=null and
   excluded from the trend. Recording zero would drag the median down and
   understate real spend -- the exact "$0.00 means free" lie this repo spent
   thirteen surfaces removing. Whether a number counts as measured is
   record_is_measured() in autonomy/lib/efficiency_cost.py, imported and never
   restated; receipts store the figure under cost.usd while the predicate reads
   cost_usd, so the KEY is mapped here. Mapping a key name is not restating the
   rule.

   RECORD-NULL rather than REFUSE, deliberately. Refusing is cost-guard.py's
   job and it already does it, per run, with an exit code. Here the history IS
   the product, and a refused append leaves no trace: a month with four broken
   instrumentation runs would look identical to a month with eight clean ones.
   The null row is countable, so the report can say "12 runs, 8 measured" and
   the operator can see the measurement gap instead of inferring it from a
   short file.

2. A TREND FROM ONE POINT IS NOT A TREND. Fewer than 2 measured runs reads
   INSUFFICIENT DATA. "Flat" is a claim about change over time and one
   observation cannot support it.

3. APPEND IS ATOMIC PER LINE. See _append().

4. A CORRUPT LINE IS COUNTED AND REPORTED, never silently skipped. A history
   that quietly drops rows reports a cleaner trend than reality, and drops them
   most often when something upstream is broken -- precisely when the number
   matters.

5. AN EMPTY HISTORY IS NOT A FLAT TREND. It exits non-zero. Zero runs is an
   absent measurement, not evidence of stability.

Usage:
  tools/cost-history.py record [workspace] [--file .loki/cost-history.jsonl]
  tools/cost-history.py report [--file ...] [--json]

Exit: 0 report produced / run recorded, 1 nothing to report (empty or no
measured runs), 2 cannot record.
"""

import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "autonomy", "lib"))

from efficiency_cost import collect_efficiency, record_is_measured  # noqa: E402

OK, NOTHING, CANNOT = 0, 1, 2

DEFAULT_FILE = os.path.join(".loki", "cost-history.jsonl")

# Below this the two halves are the same number to the cent, and calling that
# a direction is noise dressed as signal.
FLAT_PCT = 5.0


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


def _num(v):
    """A number as itself; None, "", or a bool as None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def measured_usd(cost):
    """The USD figure from a cost block, or None when it was never measured.

    `available` is NOT trusted on its own: a real receipt shipped
    available=true with every field zero (v8.52.0), so the flag is a claim and
    the VALUES are the evidence.
    """
    if not isinstance(cost, dict):
        return None
    rec = {
        "cost_usd": _num(cost.get("usd")),
        "input_tokens": _num(cost.get("input_tokens")),
        "output_tokens": _num(cost.get("output_tokens")),
        "cache_read_tokens": _num(cost.get("cache_read_tokens")),
        "cache_creation_tokens": _num(cost.get("cache_creation_tokens")),
    }
    if not record_is_measured(rec):
        return None
    return _num(rec["cost_usd"])


def _loki_dir(workspace):
    """Accept either a workspace root or a .loki dir; collect_ wants .loki."""
    if os.path.basename(os.path.normpath(workspace)) == ".loki":
        return workspace
    return os.path.join(workspace, ".loki")


def _append(path, entry):
    """Append ONE newline-terminated line with ONE write() call, in "a" mode.

    WHY THAT IS SUFFICIENT HERE, rather than the usual write-temp-and-rename.
    POSIX gives an O_APPEND write a seek-to-end that cannot be interleaved, so
    concurrent appenders cannot overwrite each other, and a line small enough
    to land in a single write is not torn between two of them. Rename-based
    atomicity would be strictly WORSE for this file: it rewrites the whole
    history every time, which turns a crash into the loss of every prior run
    instead of a partial final line.

    That partial final line is the residual risk and it is handled rather than
    prevented: a torn or truncated row is COUNTED as corrupt by load() and
    named in the report. This is why the newline terminator is load-bearing --
    it is what makes a complete row distinguishable from a truncated one.

    ponytail: no locking. O_APPEND is the lock. Add one only if this ever needs
    to write multi-line entries, which would break the single-write property.
    """
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    line = json.dumps(entry, sort_keys=True) + "\n"
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line)


def load(path):
    """Read the history. Returns (entries, corrupt_count).

    A line that is not JSON, or is JSON but not an object, is corrupt and
    COUNTED. It is never dropped on the floor.
    """
    entries, corrupt = [], 0
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except OSError:
        return None, 0
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            corrupt += 1
            continue
        if not isinstance(obj, dict) or "usd" not in obj:
            corrupt += 1
            continue
        entries.append(obj)
    return entries, corrupt


def median(values):
    """Median of a non-empty list. Even length averages the middle pair."""
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def direction(values):
    """(label, explanation) for a series oldest to newest.

    Compares the median of the older half against the median of the newer
    half, not first-vs-last: a single expensive outlier at either end should
    not name the trend for a whole quarter. With 2 or 3 points the halves are
    small, so the comparison it used is always printed alongside the verdict --
    the operator can see how thin the evidence is.
    """
    if len(values) < 2:
        return "INSUFFICIENT DATA", (
            "%d measured run(s); a trend needs at least 2. One observation "
            "cannot show change over time, and 'flat' would be a claim."
            % len(values))
    half = len(values) // 2
    older = median(values[:half])
    newer = median(values[len(values) - half:])
    basis = ("median of the oldest %d ($%.4f) vs the newest %d ($%.4f)"
             % (half, older, half, newer))
    if older == 0:
        if newer == 0:
            return "flat", basis + "; both zero"
        return "rising", basis + "; percent change is undefined against zero"
    pct = (newer - older) / older * 100.0
    if abs(pct) < FLAT_PCT:
        return "flat", "%s; %+.1f%%, within the %.0f%% flat band" % (
            basis, pct, FLAT_PCT)
    return ("rising" if pct > 0 else "falling"), "%s; %+.1f%%" % (basis, pct)


def record(workspace, path, now=None):
    """Append this workspace's run to the history. Returns a verdict dict."""
    cost, model = collect_efficiency(_loki_dir(workspace))
    usd = measured_usd(cost)
    entry = {
        "ts": now if now is not None else time.time(),
        "workspace": os.path.abspath(workspace),
        "usd": usd,          # None when unmeasured. NEVER 0 as a stand-in.
        "measured": usd is not None,
        "model": model or None,
    }
    try:
        _append(path, entry)
    except OSError as exc:
        return {"status": "cannot_record", "exit_code": CANNOT,
                "why": "could not append to %s: %s" % (path, exc),
                "entry": None}
    return {"status": "recorded", "exit_code": OK, "why": None,
            "entry": entry}


def report(path):
    """Summarize the history. Returns a verdict dict."""
    entries, corrupt = load(path)
    if entries is None:
        return {"status": "no_history", "exit_code": NOTHING,
                "why": "no history file at %s; record a run first." % path,
                "runs": 0, "measured": 0, "corrupt_lines": 0,
                "costs": [], "median_usd": None,
                "direction": "INSUFFICIENT DATA", "basis": None}

    costs = [e["usd"] for e in entries
             if e.get("measured") and _num(e.get("usd")) is not None]

    if not entries:
        # An empty file is not a flat trend. Zero runs is an absent
        # measurement, and reporting stability from it would be a claim made
        # out of nothing.
        return {"status": "empty", "exit_code": NOTHING,
                "why": "history %s is empty (%d corrupt line(s)); zero runs "
                       "is not a flat trend." % (path, corrupt),
                "runs": 0, "measured": 0, "corrupt_lines": corrupt,
                "costs": [], "median_usd": None,
                "direction": "INSUFFICIENT DATA", "basis": None}

    label, basis = direction(costs)
    return {
        "status": "ok" if costs else "no_measured_runs",
        "exit_code": OK if costs else NOTHING,
        "why": None if costs else (
            "%d run(s) recorded but none carried a measured cost; there is "
            "nothing to trend. Unmeasured runs are kept as null, not 0."
            % len(entries)),
        "runs": len(entries),
        "measured": len(costs),
        "corrupt_lines": corrupt,
        "costs": costs,
        "median_usd": median(costs) if costs else None,
        "direction": label,
        "basis": basis,
    }


def render(d):
    if d["status"] in ("no_history", "empty"):
        return "NO TREND: %s" % d["why"]
    if d["status"] == "cannot_record":
        return "CANNOT RECORD: %s" % d["why"]
    if d["status"] == "recorded":
        e = d["entry"]
        return ("recorded %s: %s" % (
            e["workspace"],
            "$%.4f" % e["usd"] if e["measured"]
            else "UNMEASURED (stored as null, excluded from the trend)"))

    lines = ["%d run(s), %d measured" % (d["runs"], d["measured"])]
    if d["corrupt_lines"]:
        # Named, not swallowed. A dropped row makes the trend look cleaner
        # than reality.
        lines.append("%d CORRUPT line(s) in the history -- counted, not "
                     "skipped; the trend below omits them."
                     % d["corrupt_lines"])
    if d["status"] == "no_measured_runs":
        lines.append("NO TREND: %s" % d["why"])
        return "\n".join(lines)
    lines.append("costs oldest to newest: "
                 + ", ".join("$%.4f" % c for c in d["costs"]))
    lines.append("median: $%.4f" % d["median_usd"])
    lines.append("direction: %s (%s)" % (d["direction"], d["basis"]))
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Track agent cost across many runs and report the trend.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("record", help="append this run's cost to the history")
    rec.add_argument("workspace", nargs="?", default=".",
                     help="workspace root (or its .loki dir); default .")
    rec.add_argument("--file", default=DEFAULT_FILE,
                     help="history JSONL (default %s)" % DEFAULT_FILE)

    rep = sub.add_parser("report", help="summarize the recorded history")
    rep.add_argument("--file", default=DEFAULT_FILE,
                     help="history JSONL (default %s)" % DEFAULT_FILE)
    rep.add_argument("--json", action="store_true", dest="as_json",
                     help="emit the report as JSON")

    args = ap.parse_args(argv)
    if args.cmd == "record":
        d = record(args.workspace, args.file)
        print(render(d))
    else:
        d = report(args.file)
        print(json.dumps(d, indent=2) if args.as_json else render(d))
    return d["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
