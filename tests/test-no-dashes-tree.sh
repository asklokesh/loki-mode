#!/usr/bin/env bash
# PO5-DASH-BENCH: whole-tree guard against U+2013 / U+2014 and emoji codepoints
# in tracked text files. scripts/structural-checks.sh scans only added diff
# lines, so dashes already shipped in a file persist; this scans every file.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export LOKI_NO_BROWSER=1

python3 - <<'PY'
import subprocess, sys, re

# Path exclusions. Each entry is (kind, pattern, reason).
EXCLUDES = [
    ("suffix", ".min.js", "vendored minified bundles"),
    ("suffix", ".map", "generated source maps"),
    ("suffix", ".lock", "generated lockfiles"),
    ("prefix", "web-app/dist/", "built output"),
    ("prefix", "loki-ts/dist/", "built output"),
    ("contains", "/assets/", "built dashboard assets"),
    ("contains", "/fixtures/", "test fixtures that need the character"),
    ("prefix", "tests/fixtures/", "test fixtures that need the character"),
    ("prefix", "tests/test-no-dashes-tree.sh", "this guard names the ranges"),
    ("prefix", "benchmarks/results/", "captured third-party benchmark solutions"),
    ("prefix", "eval/loki10/tasks/", "vendored upstream task repos and hidden tests"),
    ("prefix", "eval/loki10/refdiff/", "upstream reference diffs"),
    ("exact", "tests/test-design-archetypes.sh", "grep pattern that must contain the characters"),
    ("exact", "scripts/structural-checks.sh", "pattern file that matches the characters"),
]
# Explicit emoji ranges (codepoints).
EMOJI = [
    (0x1F300, 0x1FAFF),  # pictographs, emoticons, transport, supplemental
    (0x2600, 0x26FF),    # miscellaneous symbols
    (0x2705, 0x2705), (0x2728, 0x2728), (0x274C, 0x274C), (0x274E, 0x274E),
    (0x2753, 0x2755), (0x2757, 0x2757), (0x2764, 0x2764),  # emoji-presentation dingbats
    (0x1F000, 0x1F2FF),  # mahjong, cards, enclosed
    (0xFE0F, 0xFE0F),    # variation selector-16
]
DASHES = {0x2013, 0x2014}

_RANGES = EMOJI + [(c, c) for c in sorted(DASHES)]
BAD = re.compile("[" + "".join("%s-%s" % (chr(a), chr(b)) for a, b in _RANGES) + "]")

def excluded(p):
    for kind, pat, _ in EXCLUDES:
        if kind == "suffix" and p.endswith(pat): return True
        if kind == "prefix" and p.startswith(pat): return True
        if kind == "contains" and pat in "/" + p: return True
        if kind == "exact" and p == pat: return True
    return False

files = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
scanned, hits = 0, []
for p in files:
    if not p or excluded(p): continue
    try:
        data = open(p, "rb").read()
    except OSError:
        continue
    if b"\0" in data: continue
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        continue
    scanned += 1
    if not BAD.search(text): continue
    for n, line in enumerate(text.split("\n"), 1):
        m = BAD.search(line)
        if m:
            hits.append("%s:%d U+%04X" % (p, n, ord(m.group())))

fail = 0
if scanned < 500:
    print("[FAIL] only %d files scanned (need >= 500)" % scanned); fail = 1
else:
    print("[PASS] scanned %d files" % scanned)
if hits:
    print("[FAIL] %d lines with dash or emoji codepoints:" % len(hits))
    print("\n".join(hits[:200])); fail = 1
else:
    print("[PASS] no U+2013/U+2014 or emoji codepoints")
sys.exit(fail)
PY
