#!/usr/bin/env python3
"""Deterministic diff risk score (0-100) for `loki review --risk`.

Reads a unified diff on stdin. Pure function of the diff text: no clock, no
network, no randomness. Same diff in, same score out.
"""
import json
import re
import sys

SENSITIVE = re.compile(
    r"(^|/)(\.github/workflows/|auth|security|secret|crypt|token|credential|password|"
    r"migrations?/|Dockerfile|docker-compose|\.env|package\.json$|requirements.*\.txt$|"
    r"VERSION$|autonomy/run\.sh$|providers/|moat/)", re.I)
TESTISH = re.compile(r"(^|/)(tests?|__tests__|spec)/|(^|/)test[-_][^/]*$|[._-](test|spec)\.[a-z]+$", re.I)


def parse(diff):
    files = {}
    cur = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            cur = m.group(2) if m else line[11:]
            files[cur] = {"add": 0, "del": 0, "deleted_file": False}
        elif cur is None:
            continue
        elif line.startswith("deleted file mode"):
            files[cur]["deleted_file"] = True
        elif line.startswith("+++") or line.startswith("---"):
            continue
        elif line.startswith("+"):
            files[cur]["add"] += 1
        elif line.startswith("-"):
            files[cur]["del"] += 1
    return files


def score(diff):
    files = parse(diff)
    names = sorted(files)
    test_files = [f for f in names if TESTISH.search(f)]
    src_files = [f for f in names if f not in test_files]
    sens = [f for f in names if SENSITIVE.search(f)]
    total = sum(v["add"] + v["del"] for v in files.values())
    src_lines = sum(files[f]["add"] + files[f]["del"] for f in src_files)
    test_add = sum(files[f]["add"] for f in test_files)
    test_del = sum(files[f]["del"] for f in test_files)
    removed_test_files = [f for f in test_files if files[f]["deleted_file"]]

    f_files = min(20, len(names) * 2)
    f_sens = min(30, len(sens) * 10)
    f_size = min(20, total // 25)
    if src_lines == 0:
        f_tests = 0
    elif test_add == 0:
        f_tests = 15
    else:
        f_tests = max(0, 15 - (15 * test_add) // src_lines)
    f_deleted = min(15, test_del // 5 + 5 * len(removed_test_files))
    factors = [
        {"factor": "files_touched", "points": f_files, "max": 20, "detail": "%d files" % len(names)},
        {"factor": "sensitive_paths", "points": f_sens, "max": 30, "detail": ", ".join(sens) or "none"},
        {"factor": "size", "points": f_size, "max": 20, "detail": "%d changed lines" % total},
        {"factor": "test_delta", "points": f_tests, "max": 15,
         "detail": "%d test lines added vs %d source lines changed" % (test_add, src_lines)},
        {"factor": "deleted_tests", "points": f_deleted, "max": 15,
         "detail": "%d test lines removed, %d test files deleted" % (test_del, len(removed_test_files))},
    ]
    s = min(100, sum(x["points"] for x in factors))
    level = "low" if s < 25 else "medium" if s < 50 else "high" if s < 75 else "critical"
    return {"score": s, "level": level, "files": len(names), "factors": factors}


def main():
    args = sys.argv[1:]
    as_json = "--json" in args
    rest = [a for a in args if a != "--json"]
    src = rest[0] if rest else ""
    r = score(sys.stdin.read())
    r["source"] = src
    if as_json:
        print(json.dumps(r, sort_keys=True))
        return
    print("Risk score: %d/100 (%s)%s" % (r["score"], r["level"], " - " + src if src else ""))
    for x in r["factors"]:
        print("  %-16s %2d/%-2d  %s" % (x["factor"], x["points"], x["max"], x["detail"]))


if __name__ == "__main__":
    main()
