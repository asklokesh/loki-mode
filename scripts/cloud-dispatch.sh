#!/usr/bin/env bash
# G-04: cloud fan-out dispatcher. Dispatches ONE ready BOARD slice as a Claude
# Code cloud session that works on its own branch and opens its own PR.
#
# Usage: scripts/cloud-dispatch.sh [--dry-run | --live] [--board PATH] SLICE-ID
#
#   --dry-run  (default) print the exact command and the exact BOARD row it
#              would write; change nothing (the governor runs with --no-cache
#              so not even its parse cache is written).
#   --live     really dispatch. Never used by the tests.
#
# Refusals (message on stderr, non-zero exit):
#   12  the row is missing, ambiguous, not ready, dependency-blocked, or its
#       file set names no concrete path
#   11  its file set overlaps a building, review or review-blocked row, or an
#       in-flight row cannot be parsed or has no usable file set
#   10  the usage governor max is reached, unknown, unreadable or timed out
#   13  --live and the installed claude CLI has no --cloud option
#   16  --live and .loki/v10-leader is missing or its PID is dead (A6)
#   17  the BOARD row it would write fails verification
#    2  usage error
#
# Governor source: the same JSON as scripts/v10-pulse.sh (G-01
# scripts/usage-governor.py --json, key governor.max_engineers_next_hour).
# Override the command with CLOUD_DISPATCH_GOVERNOR_CMD. The call is capped at
# 180s (CLOUD_DISPATCH_GOVERNOR_TIMEOUT may only lower it); a timeout refuses.
# The plan ceilings (G-03 docs/v10/SCALE.md) are enforced inside the
# governor's max. An unknown (null) max refuses: fail safe, never a guess.
# Engineers in flight = max(BOARD building/review rows, governor
# active_engineers_last_hour); dispatch needs in_flight < max.
#
# VERIFIED cloud-session CLI syntax (claude 2.1.288, `claude --help`, run
# 2026-10-03). There is NO cloud subcommand (the Commands list has agents,
# attach, logs, stop, rm, ultrareview and others, none cloud-dispatching).
# The only cloud entry point is the top-level option:
#     --cloud [description|session_id|url]
#         Create a cloud session with the given description, or attach to an
#         existing one by session ID or claude.ai/code URL
# so the command is:   claude --cloud "<description>"
# NOT documented by --help, therefore NOT used: any repo, branch, base, PR,
# non-interactive or JSON-output flag for --cloud, and the format of the
# printed session id. The branch name and the instruction to open a PR are
# carried in the description text only. --live therefore requires the output
# to contain a claude.ai/code URL or a session_... id and refuses to write the
# BOARD row (exit 14) when it finds neither. First live use is a founder-run
# probe; this script has never been run with --live.
#
# Bash 3.2 compatible. The Python helpers live in quoted heredoc variables
# (never inside a command substitution) so /bin/bash -n parses this file.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOARD="$REPO_ROOT/docs/v10/BOARD.md"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
LEADER_FILE="${CLOUD_DISPATCH_LEADER_FILE:-$REPO_ROOT/.loki/v10-leader}"
GOVERNOR_TIMEOUT="${CLOUD_DISPATCH_GOVERNOR_TIMEOUT:-180}"

MODE=dry
SAW_DRY=0
SLICE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) SAW_DRY=1; [ "$MODE" = live ] && { echo "cloud-dispatch: --live and --dry-run conflict" >&2; exit 2; }; MODE=dry ;;
    --live)    [ "$SAW_DRY" = 1 ] && { echo "cloud-dispatch: --live and --dry-run conflict" >&2; exit 2; }; MODE=live ;;
    --board)   [ "$#" -ge 2 ] || { echo "cloud-dispatch: --board needs a path" >&2; exit 2; }; BOARD="$2"; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)        echo "cloud-dispatch: unknown flag: $1" >&2; exit 2 ;;
    *)         [ -z "$SLICE" ] || { echo "cloud-dispatch: one slice id only" >&2; exit 2; }; SLICE="$1" ;;
  esac
  shift
done
[ -n "$SLICE" ] || { echo "cloud-dispatch: slice id required" >&2; exit 2; }
case "$SLICE" in
  *[!A-Za-z0-9._-]*|[!A-Za-z0-9]*) echo "cloud-dispatch: invalid slice id: $SLICE" >&2; exit 2 ;;
esac
[ -f "$BOARD" ] || { echo "cloud-dispatch: board not found: $BOARD" >&2; exit 2; }

if [ -n "${CLOUD_DISPATCH_GOVERNOR_CMD:-}" ]; then
  GOVERNOR_CMD="$CLOUD_DISPATCH_GOVERNOR_CMD"
elif [ "$MODE" = dry ]; then
  GOVERNOR_CMD="python3 \"$REPO_ROOT/scripts/usage-governor.py\" --json --no-cache"
else
  GOVERNOR_CMD="python3 \"$REPO_ROOT/scripts/usage-governor.py\" --json"
fi

NOW="${CLOUD_DISPATCH_NOW:-$(date -u +%Y-%m-%dT%H:%MZ)}"
BRANCH="cloud/$(printf '%s' "$SLICE" | tr '[:upper:]' '[:lower:]')"

IFS= read -r -d '' PY_BOARD <<'PYEOF' || true
import fnmatch, os, re, sys

board, slice_id, repo_root, now = sys.argv[1:5]
SPLIT = re.compile(r'(?<!\\)\|')
STATUS = re.compile(r'^\s*([a-z-]+)@(\d{4}-\d\d-\d\dT\d\d:\d\dZ)\s*$')
INFLIGHT = ("building", "review", "review-blocked")
SATISFIED = ("merged", "released")
INFLIGHT_RE = re.compile(r'\b(?:building|review|review-blocked)@')
MAX_TOKENS = 500


def out(*parts):
    print("\t".join(str(p) for p in parts))


rows, bad = [], []
hdr, ncols = None, 0
lines = open(board, encoding="utf-8").read().split("\n")
for n, raw in enumerate(lines):
    line = raw.rstrip()
    if not line.startswith("|"):
        hdr = None
        continue
    ends = line.endswith("|") and not line.endswith("\\|")
    cells = SPLIT.split(line)[1:-1] if ends else SPLIT.split(line)[1:]
    if hdr is None and cells and cells[0].strip() == "ID":
        names = [c.strip().lower() for c in cells]
        hdr = {
            "status": names.index("status") if "status" in names else None,
            "files": next((i for i, c in enumerate(names) if c.startswith("file set")), None),
            "notes": names.index("notes") if "notes" in names else None,
        }
        ncols = len(cells)
        continue
    if cells and all(re.match(r'^[\s:-]*$', c) for c in cells):
        continue
    ident = cells[0].strip() if cells else "?"
    flagged = bool(INFLIGHT_RE.search(line))
    row = None
    if hdr is not None and ends and len(cells) == ncols and hdr["status"] is not None:
        m = STATUS.match(cells[hdr["status"]])
        if m:
            def cell(i):
                return cells[i] if i is not None and i < len(cells) else ""
            row = {"id": ident, "status": m.group(1), "files": cell(hdr["files"]),
                   "has_files": hdr["files"] is not None, "notes": cell(hdr["notes"]),
                   "cells": cells, "hdr": hdr, "line": line, "n": n}
    if row is None:
        bad.append({"id": ident, "flagged": flagged, "n": n})
    else:
        rows.append(row)


def expand_braces(t):
    i = t.find("{")
    if i < 0:
        if "}" in t:
            raise ValueError("unbalanced braces in %r" % t)
        return [t]
    depth, parts, cur, j = 0, [], "", i
    while j < len(t):
        ch = t[j]
        if ch == "{":
            depth += 1
            if depth > 1:
                cur += ch
        elif ch == "}":
            depth -= 1
            if depth == 0:
                parts.append(cur)
                break
            cur += ch
        elif ch == "," and depth == 1:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
        j += 1
    else:
        raise ValueError("unbalanced braces in %r" % t)
    res = []
    for p in parts:
        res += expand_braces(t[:i] + p + t[j + 1:])
        if len(res) > MAX_TOKENS:
            raise ValueError("brace expansion too large")
    return res


def tokens(fs):
    s = fs.replace("`", "")
    prev = None
    while prev != s:
        prev, s = s, re.sub(r"\([^()]*\)", "", s)
    s = re.sub(r"(?<=\s)and(?=\s)", ",", s).replace(";", ",")
    raw, cur, depth = [], "", 0
    for ch in s:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if depth == 0 and (ch == "," or ch.isspace()):
            raw.append(cur)
            cur = ""
        else:
            cur += ch
    raw.append(cur)
    if depth != 0:
        raise ValueError("unbalanced braces")
    res = []
    for t in raw:
        t = t.strip().rstrip(":")
        if not t:
            continue
        for e in expand_braces(t):
            e = e.strip()
            while e.startswith("./"):
                e = e[2:]
            e = e.rstrip("/")
            if e:
                res.append(e)
        if len(res) > MAX_TOKENS:
            raise ValueError("file set too large")
    return res


def concrete(t):
    # A bare name counts when it exists at the repo root or looks like a root
    # file (VERSION, Makefile, Dockerfile); lowercase prose words do not.
    return ("/" in t or "." in t or "*" in t or re.match(r"^[A-Z][A-Za-z0-9_-]*$", t) is not None
            or os.path.exists(os.path.join(repo_root, t)))


def file_tokens(r):
    """Return (tokens, error). An unusable file set is an error, never 'empty'."""
    if not r["has_files"]:
        return None, "row has no File set column"
    try:
        toks = tokens(r["files"])
    except ValueError as exc:
        return None, str(exc)
    if any(".." in t or "\u2026" in t for t in toks):
        return None, "file set is elided (%s)" % r["files"].strip()[:60]
    if not any(concrete(t) for t in toks):
        return None, "file set names no concrete path (%s)" % r["files"].strip()[:60]
    return toks, None


def overlap(a, b):
    if a == b or fnmatch.fnmatchcase(a, b) or fnmatch.fnmatchcase(b, a):
        return True
    return a.startswith(b + "/") or b.startswith(a + "/")


IDRE = re.compile(r"(?<![\w/-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?![\w/-]|\.\w)")


def dep_ids(notes):
    ids = []
    for m in re.finditer(r"(?i)\bdepend(?:s|ing|ent)?\s+(?:on|upon)\b|\bdepends:", notes):
        j, depth = m.end(), 0
        while j < len(notes):
            ch = notes[j]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth = max(0, depth - 1)
            elif depth == 0 and (ch == ";" or (ch == "." and notes[j + 1:j + 2] in (" ", ""))):
                break
            j += 1
        ids += [i for i in IDRE.findall(notes[m.end():j]) if any(c.isdigit() for c in i)]
    return ids


matches = [r for r in rows if r["id"] == slice_id]
self_bad = [b for b in bad if b["id"] == slice_id]
if len(matches) + len(self_bad) == 0:
    out("MISSING")
    sys.exit(0)
if len(matches) + len(self_bad) > 1:
    out("AMBIGUOUS")
    sys.exit(0)
if self_bad:
    out("SELFBAD")
    sys.exit(0)
row = matches[0]
out("STATUS", row["status"])
if row["status"] != "ready":
    sys.exit(0)

by_id = {}
for r in rows:
    by_id.setdefault(r["id"].upper(), r)
seen = set()
for d in dep_ids(row["notes"]):
    if d.upper() in seen or d.upper() == slice_id.upper():
        continue
    seen.add(d.upper())
    dr = by_id.get(d.upper())
    if dr is None:
        out("DEP", d, "absent from the board")
    elif dr["status"] not in SATISFIED:
        out("DEP", d, "not merged (status %s)" % dr["status"])

mine, err = file_tokens(row)
if err:
    out("BADFILES", err)
    sys.exit(0)

for b in bad:
    if b["flagged"]:
        out("UNPARSABLE", b["id"], "line %d" % (b["n"] + 1))
inflight = [r for r in rows if r["status"] in INFLIGHT]
out("INFLIGHT", len(inflight) + len([b for b in bad if b["flagged"]]))
for r in inflight:
    theirs, terr = file_tokens(r)
    if terr:
        out("BADINFLIGHT", r["id"], terr)
        continue
    for a in mine:
        hit = next((b for b in theirs if overlap(a, b)), None)
        if hit:
            out("OVERLAP", r["id"], "%s vs %s" % (a, hit))
            break

# The row that would be written, verified before anything can start.
cells = list(row["cells"])
h = row["hdr"]
problems = []
if "\t" in row["line"]:
    problems.append("a tab in the row")
if "\\|" in row["line"]:
    problems.append("an escaped pipe in the row")
if h["notes"] is None:
    problems.append("no Notes column to record the dispatch in")
if not problems:
    cells[h["status"]] = " building@%s " % now
    cells[h["notes"]] = cells[h["notes"]].rstrip() + " Cloud dispatch %s: session @@SID@@, branch cloud/%s. " % (now, slice_id.lower())
    new = "|" + "|".join(cells) + "|"
    chk = SPLIT.split(new)[1:-1]
    if not new.strip():
        problems.append("rendered row is empty")
    elif len(chk) != len(row["cells"]):
        problems.append("rendered row has %d cells, header has %d" % (len(chk), len(row["cells"])))
    elif chk[0].strip() != slice_id:
        problems.append("rendered row id differs")
    elif len(chk) != ncols:
        problems.append("cell count differs from the header")
if problems:
    out("ROWBAD", "; ".join(problems))
else:
    out("ORIG", row["line"])
    out("ROW", new)
PYEOF

IFS= read -r -d '' PY_GOV <<'PYEOF' || true
import json, os, signal, subprocess, sys
cmd = sys.argv[1]
try:
    tmo = min(float(sys.argv[2]), 180.0)
except ValueError:
    tmo = 180.0
p = subprocess.Popen(["bash", "-c", cmd], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     start_new_session=True)
try:
    data, _ = p.communicate(timeout=tmo)
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.communicate()
    print("TIMEOUT")
    sys.exit(0)
if p.returncode != 0:
    print("FAIL")
    sys.exit(0)
try:
    g = (json.loads(data.decode("utf-8", "replace")).get("governor") or {})
except Exception:
    print("BAD")
    sys.exit(0)
m, a = g.get("max_engineers_next_hour"), g.get("active_engineers_last_hour")
ok = lambda v: isinstance(v, int) and not isinstance(v, bool)
print("OK %s %s" % (m if ok(m) else "NONE", a if ok(a) else 0))
PYEOF

IFS= read -r -d '' PY_WRITE <<'PYEOF' || true
import os, sys, tempfile
board, slice_id, orig, row = sys.argv[1:5]
lines = open(board, encoding="utf-8").read().split("\n")
hits = [i for i, l in enumerate(lines) if l.rstrip() == orig]
if len(hits) != 1 or not lines[hits[0]].startswith("| %s |" % slice_id):
    sys.exit("slice row changed or not unique since analysis")
lines[hits[0]] = row
new = "\n".join(lines)
if not new:
    sys.exit("refusing to write an empty board")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(board)))
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(new)
os.replace(tmp, board)
PYEOF

analyze() { python3 -c "$PY_BOARD" "$BOARD" "$SLICE" "$REPO_ROOT" "$NOW"; }
analysis="$(analyze)" || { echo "cloud-dispatch: board analysis failed" >&2; exit 2; }

field() { printf '%s\n' "$analysis" | awk -F'\t' -v k="$1" '$1==k {print $2}'; }
join_lines() { printf '%s\n' "$analysis" | awk -F'\t' -v k="$1" '$1==k {printf "%s (%s); ", $2, $3}'; }

# (c) present, unambiguous, ready, dependency-unblocked
case "$analysis" in
  MISSING)   echo "REFUSED: slice $SLICE is not on the board" >&2; exit 12 ;;
  AMBIGUOUS) echo "REFUSED: slice $SLICE appears more than once on the board" >&2; exit 12 ;;
  SELFBAD)   echo "REFUSED: slice $SLICE row cannot be parsed (status cell or cell count)" >&2; exit 12 ;;
esac
status="$(field STATUS)"
if [ "$status" != "ready" ]; then
  echo "REFUSED: slice $SLICE is not ready (status: $status)" >&2; exit 12
fi
dep_lines="$(join_lines DEP)"
if [ -n "$dep_lines" ]; then
  echo "REFUSED: slice $SLICE is dependency-blocked: $dep_lines" >&2; exit 12
fi
bf="$(field BADFILES)"
if [ -n "$bf" ]; then
  echo "REFUSED: slice $SLICE file set unusable: $bf" >&2; exit 12
fi

# (b) no overlap with in-flight work; an unreadable in-flight row is unsafe
unp="$(join_lines UNPARSABLE)"
if [ -n "$unp" ]; then
  echo "REFUSED: in-flight row cannot be parsed, overlap cannot be judged: $unp" >&2; exit 11
fi
bi="$(join_lines BADINFLIGHT)"
if [ -n "$bi" ]; then
  echo "REFUSED: in-flight row file set unusable, overlap cannot be judged: $bi" >&2; exit 11
fi
ov="$(join_lines OVERLAP)"
if [ -n "$ov" ]; then
  echo "REFUSED: file set overlaps in-flight work: $ov" >&2; exit 11
fi
rb="$(field ROWBAD)"
if [ -n "$rb" ]; then
  echo "REFUSED: the BOARD row cannot be written safely: $rb" >&2; exit 17
fi
orig_line="$(field ORIG)"
row_template="$(field ROW)"
if [ -z "$orig_line" ] || [ -z "$row_template" ]; then
  echo "REFUSED: no verified BOARD row was produced" >&2; exit 17
fi

# (a) usage governor
gov="$(python3 -c "$PY_GOV" "$GOVERNOR_CMD" "$GOVERNOR_TIMEOUT" 2>/dev/null)"
case "$gov" in
  TIMEOUT) echo "REFUSED: usage governor timed out (cap ${GOVERNOR_TIMEOUT}s, max 180s); refusing to dispatch blind" >&2; exit 10 ;;
  FAIL)    echo "REFUSED: usage governor unreadable (command failed); refusing to dispatch blind" >&2; exit 10 ;;
  "OK "*)  ;;
  *)       echo "REFUSED: usage governor output unparsable; refusing to dispatch" >&2; exit 10 ;;
esac
read -r _ gov_max gov_active <<< "$gov"
if [ "$gov_max" = NONE ]; then
  echo "REFUSED: usage governor max is unknown (uncalibrated or unreadable); refusing to dispatch" >&2; exit 10
fi
inflight="$(field INFLIGHT)"; inflight="${inflight:-0}"
busy="$inflight"; [ "$gov_active" -gt "$busy" ] && busy="$gov_active"
if [ "$busy" -ge "$gov_max" ]; then
  echo "REFUSED: usage governor max reached (in flight $busy >= max engineers next hour $gov_max)" >&2; exit 10
fi

prompt="Work BOARD slice $SLICE from docs/v10/BOARD.md in this repository. Create and work on branch $BRANCH only, touch only the files in that row's file set, run its Wall checks, and open a pull request from $BRANCH when the checks pass. Do not merge, push to main, or edit BOARD.md."
cmd=("$CLAUDE_BIN" --cloud "$prompt")

quote_cmd() { local out="" a; for a in "$@"; do out="$out $(printf '%q' "$a")"; done; printf '%s' "${out# }"; }

if [ "$MODE" = dry ]; then
  echo "DRY RUN (nothing executed, nothing written). Governor: in flight $busy < max $gov_max."
  echo "Command: $(quote_cmd "${cmd[@]}")"
  echo "BOARD row it would write (session id filled in from the command output):"
  printf '%s\n' "${row_template//@@SID@@/<cloud-session-id>}"
  exit 0
fi

# --live: every check below runs BEFORE any cloud session starts.
if ! "$CLAUDE_BIN" --help 2>/dev/null | grep -q -- '--cloud'; then
  echo "REFUSED: cloud CLI not available ($CLAUDE_BIN --help lists no --cloud option)" >&2; exit 13
fi
leader_pid=""
if [ -f "$LEADER_FILE" ]; then
  leader_pid="$(sed -n '1s/[^0-9].*//p;1q' "$LEADER_FILE" 2>/dev/null)"
fi
case "$leader_pid" in
  ""|*[!0-9]*) echo "REFUSED: no leader lock ($LEADER_FILE missing or unreadable); only the leader may dispatch" >&2; exit 16 ;;
esac
if ! kill -0 "$leader_pid" 2>/dev/null; then
  echo "REFUSED: leader lock PID $leader_pid is dead; only the live leader may dispatch" >&2; exit 16
fi
fresh="$(analyze)" || { echo "cloud-dispatch: board re-analysis failed" >&2; exit 2; }
if [ "$(printf '%s\n' "$fresh" | awk -F'\t' '$1=="ORIG" {print $2}')" != "$orig_line" ]; then
  echo "REFUSED: the slice row changed or is no longer ready since analysis" >&2; exit 12
fi

out="$("${cmd[@]}" 2>&1)" || { echo "REFUSED: cloud dispatch command failed: $out" >&2; exit 14; }
sid="$(printf '%s\n' "$out" | grep -Eo 'https://claude\.ai/code/[A-Za-z0-9_/-]+|session_[A-Za-z0-9]+' | head -n 1)"
if [ -z "$sid" ]; then
  echo "cloud-dispatch: session started but no session id or claude.ai/code URL found in its output; BOARD NOT updated. Output: $out" >&2
  exit 14
fi
row="${row_template//@@SID@@/$sid}"
python3 -c "$PY_WRITE" "$BOARD" "$SLICE" "$orig_line" "$row" || {
  echo "cloud-dispatch: BOARD write failed (session $sid WAS started; record it by hand)" >&2; exit 15; }
echo "Dispatched $SLICE: session $sid, branch $BRANCH. BOARD row updated."
