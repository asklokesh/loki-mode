#!/usr/bin/env bash
# Hard repo rule: no emoji and no en or em dashes in any tracked or new text file
# (code, docs, UI strings, workflows). Scans every non-binary, non-vendored file
# for U+2013, U+2014 and the emoji ranges. Built output and fixtures that need the
# character are excluded by path (see EXCLUDES).
#
# Second check: every repo-relative path named in README.md, SKILL.md, CLAUDE.md,
# skills, references, docs and wiki markdown (backticked or linked, rooted at a
# top-level repo directory) must exist in git. Paths under tests/ count only when
# they look like repo tests (test-*, run-*, check-*, or a known test directory), so
# example paths for a user's own project (tests/users.test.ts) are not flagged;
# the allowlist below covers other user-side or illustrative paths.
#
# Third check: internal strategy never ships. No tracked file may sit under
# internal/ (the gitignored home for roadmap, moat, competitor and strategy docs),
# no tracked doc may be named like one (ROADMAP, BACKLOG, STRATEGY, MOAT,
# COMPETITIVE, SCORECARD), and no shipped markdown (README.md, SKILL.md, docs,
# references, skills, wiki) may use the internal words "moat", "8090" or
# "factory.ai". internal/ must stay gitignored.
#
# Fourth check: no shipped text (outside CHANGELOG.md) tells a user to run
# `claude login`, which the Claude CLI does not have; the command is
# `claude auth login`.
#
# Planted defects used to prove this test can fail: add one en dash (U+2013) to
# README.md, and separately one emoji (U+2705) to docs/INSTALLATION.md; each must be
# reported by file and line. For the path check, add the sentence "See
# `tests/test-plant.sh`." to README.md. For the internal check, add the word
# "moat" to docs/QUICKSTART.md, and separately create docs/ROADMAP-PLANT.md and
# `git add -f internal/plant.md`. For the login check, change "claude auth login"
# to "claude login" in loki-ts/src/util/run_summary.ts. Reverted afterwards.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3
cd "$ROOT" || exit 2

echo "TEST: no emoji, no en or em dashes"

out="$(python3 -I - <<'PY'
import re, subprocess, sys

# (kind, pattern): paths that are generated or must hold the character.
EXCLUDES = [
    ("suffix", ".min.js"), ("suffix", ".map"), ("suffix", ".lock"),
    ("prefix", "web-app/dist/"), ("prefix", "loki-ts/dist/"),
    ("contains", "/assets/"), ("contains", "/fixtures/"),
    ("exact", "tests/min/hygiene.sh"),
]
EMOJI = [
    (0x1F300, 0x1FAFF), (0x2600, 0x26FF),
    (0x2705, 0x2705), (0x2728, 0x2728), (0x274C, 0x274C), (0x274E, 0x274E),
    (0x2753, 0x2755), (0x2757, 0x2757), (0x2764, 0x2764),
    (0x1F000, 0x1F2FF), (0xFE0F, 0xFE0F),
]
RANGES = EMOJI + [(0x2013, 0x2013), (0x2014, 0x2014)]
BAD = re.compile("[" + "".join("%s-%s" % (chr(a), chr(b)) for a, b in RANGES) + "]")

def excluded(p):
    for kind, pat in EXCLUDES:
        if kind == "suffix" and p.endswith(pat): return True
        if kind == "prefix" and p.startswith(pat): return True
        if kind == "contains" and pat in "/" + p: return True
        if kind == "exact" and p == pat: return True
    return False

files = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
scanned, hits = 0, []
for p in files:
    if not p or excluded(p):
        continue
    try:
        data = open(p, "rb").read()
    except OSError:
        continue
    if b"\0" in data:
        continue
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        continue
    scanned += 1
    for n, line in enumerate(text.split("\n"), 1):
        m = BAD.search(line)
        if m:
            hits.append("%s:%d U+%04X" % (p, n, ord(m.group())))

print(("OK scanned %d files" % scanned) if scanned >= 300 else ("NO only %d files scanned (need 300 or more)" % scanned))
print("OK no U+2013, U+2014 or emoji codepoints" if not hits else "NO %d line(s) with dash or emoji codepoints: %s" % (len(hits), " ".join(hits[:20])))
PY
)"
while IFS= read -r l; do
    case "$l" in
        "OK "*) ok "${l#OK }" ;;
        "NO "*) bad "${l#NO }" ;;
        *) [ -n "$l" ] && bad "unexpected output: $l" ;;
    esac
done <<< "$out"

paths_out="$(python3 -I - <<'PY'
import os, re, subprocess
ROOTS = ["tests", "scripts", "docs", "skills", "loki-ts", "benchmarks", "eval", "examples", "demo", "references", "autonomy",
         "providers", "tools", "wiki", "packages", "dashboard", "deploy", "vscode-extension"]
ALLOW = [r"^deploy/loki-", r"^docs/(comments|prd\.md|api\.html|AGENTS\.md)$", r"^\.github/", r"^wiki/My-Page\.md$",
         r"^dashboard/(terminal|static/?)$", r"^scripts/CI$", r"^loki-ts/src/runner/runQualityGates$", r"^loki-ts/runner$",
         r"^tests/(a\.py|Quick|monitoring|unit/?|load\.js)$", r"^autonomy/hooks/$"]
TEST_REPO = re.compile(r"^tests/(test[-_][^/]*|run-[^/]*|check-[^/]*|(moat|managed|managed_memory|real-run|workspace|commands|fixtures|cli|council|memory|e2e|plugins|dashboard)(/.*)?)$")
tracked = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0") if f]
tset = set(tracked)
dirs = {"/".join(t.split("/")[:i]) for t in tracked for i in range(1, len(t.split("/")))}
docs = [t for t in tracked if t.endswith(".md")
        and (t in ("README.md", "SKILL.md", "CLAUDE.md") or t.startswith(("skills/", "references/", "docs/", "wiki/")))]
rx = re.compile(r"(?<![A-Za-z0-9_./~$-])((?:%s)/[A-Za-z0-9_./@+-]*[A-Za-z0-9_/])" % "|".join(ROOTS))
bad = []
for f in docs:
    for n, line in enumerate(open(f, encoding="utf-8").read().split("\n"), 1):
        for m in rx.finditer(line):
            p = m.group(1).rstrip(".")
            q = p.rstrip("/")
            if any(c in p for c in "*<>{}") or "..." in p or q in tset or q in dirs:
                continue
            if os.path.normpath(os.path.join(os.path.dirname(f), p)) in tset:
                continue
            if any(re.search(a, p) for a in ALLOW) or (p.startswith("tests/") and not TEST_REPO.match(p)):
                continue
            bad.append("%s:%d %s" % (f, n, p))
print(("OK checked %d markdown files, every named repo path exists" % len(docs)) if not bad
      else "NO %d dangling path(s): %s" % (len(bad), " ".join(bad[:15])))
PY
)"
case "$paths_out" in
    "OK "*) ok "${paths_out#OK }" ;;
    *) bad "${paths_out#NO }" ;;
esac

internal_out="$(python3 -I - <<'PY'
import re, subprocess
files = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0") if f]
bad = []
bad += ["tracked under internal/: " + f for f in files if f.startswith("internal/")]
NAME = re.compile(r"(ROADMAP|BACKLOG|STRATEGY|MOAT|COMPETITIVE|SCORECARD)[^/]*\.(md|html|txt|json)$", re.I)
bad += ["internal-looking doc name: " + f for f in files if NAME.search(f.split("/")[-1])]
WORD = re.compile(r"\bmoat\b|\b8090\b|factory\.ai", re.I)
shipped = [f for f in files if f.endswith(".md") and (f in ("README.md", "SKILL.md") or f.startswith(("docs/", "references/", "skills/", "wiki/")))]
for f in shipped:
    try:
        text = open(f, encoding="utf-8").read()
    except OSError:
        continue
    for n, line in enumerate(text.split("\n"), 1):
        if WORD.search(line):
            bad.append("internal word in %s:%d" % (f, n))
if subprocess.run(["git", "check-ignore", "-q", "internal/x.md"]).returncode != 0:
    bad.append("internal/ is not gitignored")
print(("OK no internal strategy docs or words in %d shipped markdown files; internal/ is ignored" % len(shipped)) if not bad
      else "NO %d internal-strategy leak(s): %s" % (len(bad), "; ".join(bad[:10])))
PY
)"
case "$internal_out" in
    "OK "*) ok "${internal_out#OK }" ;;
    *) bad "${internal_out#NO }" ;;
esac

login_out="$(python3 -I - <<'PY'
import re, subprocess
# The Claude CLI has no `login` subcommand: `claude login` starts a session with
# the prompt "login". The command is `claude auth login`. CHANGELOG.md keeps
# history verbatim; the built bundle is shipped, so it is scanned too.
BAD = re.compile(r"(?<![-\w])claude login\b|[\"']claude[\"'],\s*[\"']login[\"']")
files = [f for f in subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).decode().split("\0")
         if f and f not in ("CHANGELOG.md", "tests/min/hygiene.sh")]
hits, scanned = [], 0
for f in files:
    try:
        data = open(f, "rb").read()
    except OSError:
        continue
    if b"\0" in data:
        continue
    text = data.decode("utf-8", "replace")
    scanned += 1
    for n, line in enumerate(text.split("\n"), 1):
        if BAD.search(line):
            hits.append("%s:%d" % (f, n))
print(("OK no shipped text says claude login without auth (%d files)" % scanned) if not hits
      else "NO %d line(s) say claude login (use claude auth login): %s" % (len(hits), " ".join(hits[:15])))
PY
)"
case "$login_out" in
    "OK "*) ok "${login_out#OK }" ;;
    *) bad "${login_out#NO }" ;;
esac

finish
