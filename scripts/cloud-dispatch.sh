#!/usr/bin/env bash
# G-04: cloud fan-out dispatcher. Dispatches ONE ready BOARD slice as a Claude
# Code cloud session that works on its own branch and opens its own PR.
#
# Usage: scripts/cloud-dispatch.sh [--dry-run | --live] [--board PATH] SLICE-ID
#
#   --dry-run  (default) print the exact command and the exact BOARD row it
#              would write; change nothing.
#   --live     really dispatch. Never used by the tests.
#
# Refusals (message on stderr, non-zero exit):
#   12  the row is missing, not ready, or dependency-blocked
#   11  its file set overlaps a building, review or review-blocked row
#   10  the usage governor max is reached, unknown, or unreadable
#   13  --live and the installed claude CLI has no --cloud option
#    2  usage error
#
# Governor source: the same JSON as scripts/v10-pulse.sh (G-01
# scripts/usage-governor.py --json, key governor.max_engineers_next_hour).
# Override the command with CLOUD_DISPATCH_GOVERNOR_CMD (default: the
# PULSE_GOVERNOR_CMD default, python3 scripts/usage-governor.py --json). The
# plan ceilings (G-03 docs/v10/SCALE.md) are enforced inside the governor's
# max. An unknown (null) max refuses: fail safe, never a guess.
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

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOARD="$REPO_ROOT/docs/v10/BOARD.md"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
GOVERNOR_CMD="${CLOUD_DISPATCH_GOVERNOR_CMD:-python3 \"$REPO_ROOT/scripts/usage-governor.py\" --json}"

MODE=dry
SAW_DRY=0
SLICE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) SAW_DRY=1; [ "$MODE" = live ] && { echo "cloud-dispatch: --live and --dry-run conflict" >&2; exit 2; }; MODE=dry ;;
    --live)    [ "$SAW_DRY" = 1 ] && { echo "cloud-dispatch: --live and --dry-run conflict" >&2; exit 2; }; MODE=live ;;
    --board)   [ "$#" -ge 2 ] || { echo "cloud-dispatch: --board needs a path" >&2; exit 2; }; BOARD="$2"; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)        echo "cloud-dispatch: unknown flag: $1" >&2; exit 2 ;;
    *)         [ -z "$SLICE" ] || { echo "cloud-dispatch: one slice id only" >&2; exit 2; }; SLICE="$1" ;;
  esac
  shift
done
[ -n "$SLICE" ] || { echo "cloud-dispatch: slice id required" >&2; exit 2; }
[ -f "$BOARD" ] || { echo "cloud-dispatch: board not found: $BOARD" >&2; exit 2; }

NOW="${CLOUD_DISPATCH_NOW:-$(date -u +%Y-%m-%dT%H:%MZ)}"
BRANCH="cloud/$(printf '%s' "$SLICE" | tr '[:upper:]' '[:lower:]')"

# Board analysis. Prints TAB-separated records: KIND<TAB>value[<TAB>value].
analysis="$(python3 - "$BOARD" "$SLICE" <<'PYEOF'
import fnmatch, re, sys

board, slice_id = sys.argv[1], sys.argv[2]
SPLIT = re.compile(r'(?<!\\)\|')
STATUS = re.compile(r'^\s*([a-z-]+)@\d{4}-\d\d-\d\dT\d\d:\d\dZ\s*$')
INFLIGHT = ("building", "review", "review-blocked")
SATISFIED = ("merged", "released")

rows = []  # dicts: id, status, files, notes, line_no, cells, status_idx
cols = None
lines = open(board, encoding="utf-8").read().split("\n")
for n, line in enumerate(lines):
    if not line.startswith("|"):
        cols = None
        continue
    cells = SPLIT.split(line)[1:-1]
    if cols is None and cells and cells[0].strip() == "ID":
        names = [c.strip().lower() for c in cells]
        cols = {
            "status": names.index("status") if "status" in names else None,
            "files": next((i for i, c in enumerate(names) if c.startswith("file set")), None),
            "notes": names.index("notes") if "notes" in names else None,
        }
        continue
    if cols is None or not cells or set(cells[0].strip()) <= set("-: "):
        continue
    if cols["status"] is None or cols["status"] >= len(cells):
        continue
    m = STATUS.match(cells[cols["status"]])
    if not m:
        continue
    files = cells[cols["files"]] if cols["files"] is not None and cols["files"] < len(cells) else ""
    notes = cells[cols["notes"]] if cols["notes"] is not None and cols["notes"] < len(cells) else ""
    rows.append({"id": cells[0].strip(), "status": m.group(1), "files": files,
                 "notes": notes, "line": n, "cells": cells, "cols": cols})

def tokens(fs):
    out = []
    # split on commas outside parentheses
    depth, cur = 0, ""
    for ch in fs:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append(cur); cur = ""
        else:
            cur += ch
    out.append(cur)
    res = []
    for t in out:
        t = re.sub(r"\([^)]*\)", "", t).replace("`", "").strip()
        if t and ("/" in t or "." in t or "*" in t):
            res.append(t.lstrip("./"))
    return res

def overlap(a, b):
    a, b = a.rstrip("/"), b.rstrip("/")
    if a == b or fnmatch.fnmatchcase(a, b) or fnmatch.fnmatchcase(b, a):
        return True
    return a.startswith(b + "/") or b.startswith(a + "/")

by_id = {}
for r in rows:
    by_id.setdefault(r["id"], r)
row = by_id.get(slice_id)
if row is None:
    print("MISSING"); sys.exit(0)
print("STATUS\t" + row["status"])
if row["status"] != "ready":
    sys.exit(0)

deps = []
for m in re.finditer(r"Depends on ([^;]*?)(?:\. |;|$)", row["notes"]):
    deps += re.findall(r"\b[A-Z]{1,5}-\d+[a-z]?\b", m.group(1))
for d in deps:
    dr = by_id.get(d)
    if dr is None:
        print("DEP\t%s\tabsent from the board" % d)
    elif dr["status"] not in SATISFIED:
        print("DEP\t%s\tnot merged (status %s)" % (d, dr["status"]))

mine = tokens(row["files"])
inflight = [r for r in rows if r["status"] in INFLIGHT]
print("INFLIGHT\t%d" % len(inflight))
for r in inflight:
    if r["id"] == slice_id:
        continue
    for a in mine:
        hit = next((b for b in tokens(r["files"]) if overlap(a, b)), None)
        if hit:
            print("OVERLAP\t%s\t%s vs %s" % (r["id"], a, hit))
            break
print("NFILES\t%d" % len(mine))

# Row that would be written: status -> building, notes gain a dispatch record.
cells = list(row["cells"])
c = row["cols"]
si, ni = c["status"], c["notes"]
cells[si] = " building@@NOW@ "
print("ROWTEMPLATE\t" + "|" + "|".join(cells) + "|" + "\t" + str(si) + "\t" + str(-1 if ni is None else ni))
PYEOF
)" || { echo "cloud-dispatch: board analysis failed" >&2; exit 2; }

field() { printf '%s\n' "$analysis" | awk -F'\t' -v k="$1" '$1==k {print $2}'; }

# (c) ready and dependency-unblocked
if [ "$analysis" = "MISSING" ]; then
  echo "REFUSED: slice $SLICE is not on the board" >&2; exit 12
fi
status="$(field STATUS)"
if [ "$status" != "ready" ]; then
  echo "REFUSED: slice $SLICE is not ready (status: $status)" >&2; exit 12
fi
dep_lines="$(printf '%s\n' "$analysis" | awk -F'\t' '$1=="DEP" {printf "%s %s; ", $2, $3}')"
if [ -n "$dep_lines" ]; then
  echo "REFUSED: slice $SLICE is dependency-blocked: $dep_lines" >&2; exit 12
fi

# (b) no overlap with in-flight work
ov="$(printf '%s\n' "$analysis" | awk -F'\t' '$1=="OVERLAP" {printf "%s (%s); ", $2, $3}')"
if [ -n "$ov" ]; then
  echo "REFUSED: file set overlaps in-flight work: $ov" >&2; exit 11
fi

# (a) usage governor
gov_json="$(bash -c "$GOVERNOR_CMD" 2>/dev/null)" || {
  echo "REFUSED: usage governor unreadable (command failed); refusing to dispatch blind" >&2; exit 10; }
gov="$(printf '%s' "$gov_json" | python3 -c '
import json, sys
try:
    g = (json.load(sys.stdin).get("governor") or {})
except Exception:
    print("BAD"); sys.exit(0)
m, a = g.get("max_engineers_next_hour"), g.get("active_engineers_last_hour")
ok = lambda v: isinstance(v, int) and not isinstance(v, bool)
print("%s %s" % (m if ok(m) else "NONE", a if ok(a) else 0))
' 2>/dev/null)"
gov_max="${gov%% *}"; gov_active="${gov##* }"
case "$gov_max" in
  NONE|BAD|"") echo "REFUSED: usage governor max is unknown (uncalibrated or unreadable); refusing to dispatch" >&2; exit 10 ;;
esac
inflight="$(field INFLIGHT)"; inflight="${inflight:-0}"
busy="$inflight"; [ "$gov_active" -gt "$busy" ] && busy="$gov_active"
if [ "$busy" -ge "$gov_max" ]; then
  echo "REFUSED: usage governor max reached (in flight $busy >= max engineers next hour $gov_max)" >&2; exit 10
fi

prompt="Work BOARD slice $SLICE from docs/v10/BOARD.md in this repository. Create and work on branch $BRANCH only, touch only the files in that row's file set, run its Wall checks, and open a pull request from $BRANCH when the checks pass. Do not merge, push to main, or edit BOARD.md."
cmd=("$CLAUDE_BIN" --cloud "$prompt")

render_row() { # $1 = session id text
  printf '%s\n' "$analysis" | python3 -c '
import sys
now, sid, branch = sys.argv[1], sys.argv[2], sys.argv[3]
for line in sys.stdin:
    p = line.rstrip("\n").split("\t")
    if p[0] != "ROWTEMPLATE":
        continue
    row, si, ni = p[1], int(p[2]), int(p[3])
    cells = row[1:-1].split("|")
    cells[si] = " building@%s " % now
    if ni >= 0:
        cells[ni] = cells[ni].rstrip() + " Cloud dispatch %s: session %s, branch %s. " % (now, sid, branch)
    print("|" + "|".join(cells) + "|")
' "$NOW" "$1" "$BRANCH"
}

quote_cmd() { local out="" a; for a in "$@"; do out="$out $(printf '%q' "$a")"; done; printf '%s' "${out# }"; }

if [ "$MODE" = dry ]; then
  echo "DRY RUN (nothing executed, nothing written). Governor: in flight $busy < max $gov_max."
  echo "Command: $(quote_cmd "${cmd[@]}")"
  echo "BOARD row it would write (session id filled in from the command output):"
  render_row "<cloud-session-id>"
  exit 0
fi

# --live: the cloud CLI must exist and advertise --cloud.
if ! "$CLAUDE_BIN" --help 2>/dev/null | grep -q -- '--cloud'; then
  echo "REFUSED: cloud CLI not available ($CLAUDE_BIN --help lists no --cloud option)" >&2; exit 13
fi
out="$("${cmd[@]}" 2>&1)" || { echo "REFUSED: cloud dispatch command failed: $out" >&2; exit 14; }
sid="$(printf '%s\n' "$out" | grep -Eo 'https://claude\.ai/code/[A-Za-z0-9_/-]+|session_[A-Za-z0-9]+' | head -n 1)"
if [ -z "$sid" ]; then
  echo "cloud-dispatch: session started but no session id or claude.ai/code URL found in its output; BOARD NOT updated. Output: $out" >&2
  exit 14
fi
row="$(render_row "$sid")"
python3 - "$BOARD" "$SLICE" "$row" <<'PYEOF' || { echo "cloud-dispatch: BOARD write failed (session $sid was started)" >&2; exit 15; }
import os, sys, tempfile
board, slice_id, row = sys.argv[1:4]
text = open(board, encoding="utf-8").read()
lines = text.split("\n")
hits = [i for i, l in enumerate(lines) if l.startswith("| %s |" % slice_id)]
assert len(hits) == 1, "slice row not unique"
lines[hits[0]] = row
new = "\n".join(lines)
assert len(new) > 0 and len(new.split("\n")) == len(lines)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(board)))
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(new)
os.replace(tmp, board)
PYEOF
echo "Dispatched $SLICE: session $sid, branch $BRANCH. BOARD row updated."
