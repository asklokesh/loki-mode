#!/usr/bin/env python3
"""Render the prompt-ablation result, and REFUSE to declare a winner on noise.

WHAT THIS GUARDS AGAINST, which is the failure mode of every A/B report ever
written: two medians differ by 8%, someone writes "18% faster" in a release
note, and the number was one trial's worth of variance. A stochastic agent's
iteration count and wall clock move run to run on identical input, so a
difference smaller than the spread inside a single arm is not a finding.

So this reports medians WITH spread, and prints an explicit verdict line that
says NO DIFFERENCE DEMONSTRATED whenever the arms overlap. That line exists to
be quoted: it is much easier to paste an honest verdict than to re-derive one.

Absent is not zero, everywhere. A trial that timed out before its writer ran
produces no row at all; it is reported as MISSING and excluded from the
medians rather than counted as a fast run or a $0.00 one.

Exit codes follow the repo convention:
    0  reported
    3  nothing to report (no rows yet)
   66  history file does not exist
"""

import json
import sys


def _median(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def _nums(rows, key):
    out = []
    for r in rows:
        v = r.get(key)
        if isinstance(v, bool) or v is None:
            continue
        if isinstance(v, (int, float)):
            out.append(float(v))
    return out


def _fmt(v, suffix=""):
    return "UNKNOWN" if v is None else "%.1f%s" % (v, suffix)


def main(argv):
    if len(argv) < 2:
        print("usage: report-prompt-ablation.py <history.jsonl>")
        return 64
    path = argv[1]
    try:
        raw = open(path, encoding="utf-8").read()
    except OSError:
        print("NO HISTORY -- %s does not exist. Nothing measured yet." % path)
        return 66

    rows = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue

    if not rows:
        print("NO RESULTS -- the history file is empty. Nothing measured yet.")
        return 3

    arms = {"full": [], "simple": []}
    for r in rows:
        a = r.get("arm")
        if a in arms:
            arms[a].append(r)

    print("trials recorded: full=%d simple=%d" % (len(arms["full"]), len(arms["simple"])))
    print("")

    # SPEED and iteration count, with spread.
    print("%-12s %-22s %-22s" % ("metric", "full (default)", "simple (LOKI_SIMPLE=1)"))
    print("-" * 58)
    for key, label, suffix in (
        ("wall_clock_min", "wall clock", " min"),
        ("act_iterations", "iterations", ""),
    ):
        cells = []
        for arm in ("full", "simple"):
            vals = _nums(arms[arm], key)
            if not vals:
                cells.append("UNKNOWN (no data)")
                continue
            med = _median(vals)
            cells.append("%s  [%s-%s] n=%d" % (
                _fmt(med, suffix), _fmt(min(vals)), _fmt(max(vals)), len(vals)))
        print("%-12s %-22s %-22s" % (label, cells[0], cells[1]))

    # RELIABILITY: completion rate, counted not averaged.
    print("")
    for arm in ("full", "simple"):
        rs = arms[arm]
        if not rs:
            print("%-6s reliability: UNKNOWN (no trials)" % arm)
            continue
        done = sum(1 for r in rs if r.get("engine_completed") is True)
        print("%-6s reliability: %d/%d completed" % (arm, done, len(rs)))

    # THE VERDICT, and the reason this file exists.
    print("")
    fw = _nums(arms["full"], "wall_clock_min")
    sw = _nums(arms["simple"], "wall_clock_min")

    if len(fw) < 3 or len(sw) < 3:
        print("VERDICT: INSUFFICIENT DATA -- need n>=3 per arm, have full=%d simple=%d."
              % (len(fw), len(sw)))
        print("         A single trial of a stochastic agent is indistinguishable")
        print("         from noise. No speed claim is licensed by this data.")
        return 0

    fmed, smed = _median(fw), _median(sw)
    # Overlapping ranges mean the observed gap is inside the noise each arm
    # already shows against itself. That is not a win for either side.
    if max(min(fw), min(sw)) <= min(max(fw), max(sw)):
        print("VERDICT: NO DIFFERENCE DEMONSTRATED -- the arms' ranges overlap")
        print("         (full %s-%s, simple %s-%s), so the median gap is within"
              % (_fmt(min(fw)), _fmt(max(fw)), _fmt(min(sw)), _fmt(max(sw))))
        print("         the run-to-run noise. Report the token saving, not a speed win.")
    else:
        faster = "simple" if smed < fmed else "full"
        pct = abs(fmed - smed) / max(fmed, smed) * 100.0
        print("VERDICT: %s is faster by %.0f%% at the median, and the ranges do"
              % (faster, pct))
        print("         NOT overlap across n=%d/%d trials." % (len(fw), len(sw)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
