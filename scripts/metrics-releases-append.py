#!/usr/bin/env python3
"""Append one releases-per-hour block to docs/v10/METRICS.md (D44 item 5).

Reads `npm view loki-mode time --json` (or --npm-json FILE) and inserts a dated
block directly under the "## Releases per hour" header, newest first; the header
is created at the end of the file when missing. Existing content is never
truncated.
Usage: python3 scripts/metrics-releases-append.py [--npm-json FILE] [--metrics FILE] [--now ISO] [--tags a,b]
       python3 scripts/metrics-releases-append.py --self-test
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HEADER = "## Releases per hour"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)


def publishes(npm):
    return sorted(parse(v) for k, v in npm.items() if k not in ("created", "modified") and isinstance(v, str))


def render(npm, now, tags):
    times = publishes(npm)
    h1 = [t for t in times if now - t <= timedelta(hours=1)]
    h24 = [t for t in times if now - t <= timedelta(hours=24)]
    gaps = [(b - a).total_seconds() / 60 for a, b in zip(h24, h24[1:])]
    median = "n/a" if not gaps else "%.1f" % statistics.median(gaps)
    return "\n".join([
        "### %sZ" % now.strftime("%Y-%m-%dT%H:%M"),
        "- npm-published loki-mode versions: %d in the last hour, %d in the last 24 hours" % (len(h1), len(h24)),
        "- Release tags (last hour): %s" % (", ".join(tags) or "none"),
        "- Median minutes between releases (last 24 hours): %s" % median,
    ]) + "\n"


def insert(text, block):
    if HEADER not in text:
        return text.rstrip("\n") + "\n\n" + HEADER + "\n\n" + block
    i = text.index("\n", text.index(HEADER)) + 1
    return text[:i] + "\n" + block + text[i:]


def recent_tags(now):
    # ponytail: tags by creator date from the local repo; a fresh clone without tags reads "none".
    out = subprocess.run(["git", "-C", ROOT, "tag", "--list", "v*", "--format=%(creatordate:iso-strict) %(refname:short)"],
                         capture_output=True, text=True, timeout=30).stdout
    return [p[1] for p in (l.split() for l in out.splitlines()) if len(p) == 2 and now - parse(p[0]) <= timedelta(hours=1)]


def append(metrics, block):
    text = open(metrics).read() if os.path.exists(metrics) else ""
    new = insert(text, block)
    assert len(new) > len(text) and new.count(HEADER) == 1  # never truncate the file
    open(metrics, "w").write(new)


def self_test():
    now = parse("2026-09-30T12:00:00Z")
    npm = {"created": "2026-01-01T00:00:00Z", "modified": "2026-09-30T11:50:00Z",
           "1.0.0": "2026-09-30T11:10:00Z", "1.0.1": "2026-09-30T11:30:00Z", "1.0.2": "2026-09-30T11:50:00Z",
           "0.9.0": "2026-09-29T10:00:00Z"}
    b = render(npm, now, ["v1.0.2"])
    assert "3 in the last hour, 3 in the last 24" in b and "v1.0.2" in b and ": 20.0" in b, b
    assert ": n/a" in render({}, now, [])
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "M.md")
        open(f, "w").write("# Metrics\n\nkeep me\n")
        append(f, b)
        t1 = open(f).read()
        assert t1.startswith("# Metrics\n\nkeep me\n") and t1.count(HEADER) == 1
        append(f, render(npm, now + timedelta(hours=1), []))
        t2 = open(f).read()
        assert t2.count(HEADER) == 1 and t2.count("### ") == 2 and t2.startswith("# Metrics\n\nkeep me\n")
        assert t2.index("T13:00Z") < t2.index("T12:00Z")  # newest first
    print("metrics-releases-append self-test: PASS")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npm-json")
    ap.add_argument("--metrics", default=os.path.join(ROOT, "docs", "v10", "METRICS.md"))
    ap.add_argument("--now")
    ap.add_argument("--tags")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    now = parse(a.now) if a.now else datetime.now(timezone.utc)
    raw = open(a.npm_json).read() if a.npm_json else subprocess.run(
        ["npm", "view", "loki-mode", "time", "--json"], capture_output=True, text=True, timeout=120, check=True).stdout
    tags = [t for t in a.tags.split(",") if t] if a.tags is not None else recent_tags(now)
    block = render(json.loads(raw), now, tags)
    append(a.metrics, block)
    print(block, end="")


if __name__ == "__main__":
    sys.exit(main())
