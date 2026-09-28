#!/usr/bin/env bash
# scripts/board-mark-released.sh -- flip every docs/v10/BOARD.md row whose
# Status cell is `merged@...` to `released@<UTC now>` when that slice's own
# merge commit is already an ancestor of the given release tag (E-90).
#
# Usage: scripts/board-mark-released.sh <tag>
#
# For each `merged@` row: find its merge commit via `git log --merges
# --grep "slice-<ID>"` (this repo's actual convention, e.g. "Merge branch
# 'slice-E-89-90'"), or, if that finds nothing, a SHA cited anywhere in the
# row that is itself a merge commit (2+ parents). If neither can be found,
# the row is left untouched and printed (never guessed at). If a merge
# commit IS found but is NOT an ancestor of <tag>, the row is also left
# untouched (it is genuinely still unreleased).
#
# Read-then-write, with a line-count assertion before the file is ever
# written: this script only ever replaces existing lines in place, never
# adds or removes one, so a mismatch means something went wrong and the
# original file is left untouched rather than risking a truncated write.
#
# Overridable like every other scripts/*.sh here:
#   BMR_REPO_ROOT   repo root for git operations (default: this repo)
#   BOARD_MD        path to BOARD.md (default: docs/v10/BOARD.md)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
BMR_REPO_ROOT="${BMR_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
BOARD_MD="${BOARD_MD:-$DEFAULT_REPO_ROOT/docs/v10/BOARD.md}"
export BMR_REPO_ROOT BOARD_MD
BMR_TAG="${1:-}"
export BMR_TAG

if [ -z "$BMR_TAG" ]; then
    printf 'usage: %s <tag>\n' "$0" >&2
    exit 2
fi

exec python3 -E - <<'BMR_PY'
import os
import re
import subprocess
import sys
import time

REPO_ROOT = os.environ["BMR_REPO_ROOT"]
BOARD_MD = os.environ["BOARD_MD"]
TAG = os.environ["BMR_TAG"]

STATUS_TOKEN_RE = re.compile(
    r"^(ready|building|review|review-blocked|blocked|approved|merged|released|rejected|parked)"
    r"@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$"
)
SHA_TOKEN_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def git(args):
    try:
        p = subprocess.run(
            ["git", "-C", REPO_ROOT] + args,
            capture_output=True, text=True, timeout=30,
        )
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", str(exc)


def find_merge_commit_for_id(row_id):
    # -E + a trailing "not another digit" boundary: a plain substring grep
    # for "slice-S-1" also matches "slice-S-10", "slice-S-11", ... (BOARD ID
    # numbers are not fixed-width), which would silently resolve the WRONG
    # slice's merge commit. This scans every `merged` row's ID verbatim, not
    # just the known GF/PF/S/E/EV-<digits> shapes (no ID_RE filter here), so
    # a row ID that breaks the -E pattern (e.g. an unbalanced paren) makes
    # git exit non-zero -- caught below the same as a real "no match", so
    # that row is SKIPped and printed, never guessed at or flipped wrong.
    # -n 1: stop at the first (newest) match instead of walking the rest of
    # history uselessly once the grep filter has already decided the answer.
    rc, out, _ = git(["log", "--merges", "-n", "1", "--format=%H", "-E", "--grep", "slice-%s([^0-9]|$)" % row_id])
    if rc == 0 and out.strip():
        return out.strip()
    return None


def find_cited_merge_sha(row_text):
    for tok in SHA_TOKEN_RE.findall(row_text):
        rc, out, _ = git(["rev-list", "--parents", "-n", "1", tok])
        if rc != 0 or not out.strip():
            continue
        parts = out.strip().split()
        if len(parts) >= 3:  # commit sha followed by 2+ parent shas
            return parts[0]
    return None


def is_ancestor(sha, tag):
    rc, _, _ = git(["merge-base", "--is-ancestor", sha, tag])
    return rc == 0


rc, _, err = git(["rev-parse", "--verify", "%s^{commit}" % TAG])
if rc != 0:
    print("board-mark-released: tag %r could not be resolved: %s" % (TAG, err.strip()), file=sys.stderr)
    sys.exit(1)

try:
    with open(BOARD_MD, "r", encoding="utf-8") as f:
        original_text = f.read()
except OSError as exc:
    print("board-mark-released: cannot read %s: %s" % (BOARD_MD, exc), file=sys.stderr)
    sys.exit(1)

# splitlines(keepends=True) so the join-back below reproduces the file
# byte-for-byte apart from the cells this script deliberately edits --
# no trailing-newline normalization, no CRLF/LF surprise.
lines = original_text.splitlines(keepends=True)
now_stamp = time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())
flipped, left_not_found, left_not_ancestor = [], [], []

for i, raw_line in enumerate(lines):
    line = raw_line.rstrip("\n").rstrip("\r")
    if not line.strip().startswith("|"):
        continue
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) < 2:
        continue
    row_id = cells[0]
    status_idx = None
    for idx, cell in enumerate(cells[1:], start=1):
        if STATUS_TOKEN_RE.match(cell):
            status_idx = idx
            break
    if status_idx is None or not cells[status_idx].startswith("merged@"):
        continue

    if status_idx == len(cells) - 1:
        # No Notes cell after Status to append the "Released in..." note
        # into -- every real row in this BOARD.md has one, but never guess
        # at inventing a new column for a row shaped otherwise.
        left_not_found.append(row_id)
        print("SKIP %s: no Notes cell to record the release in (row left unchanged)" % row_id)
        continue

    merge_sha = find_merge_commit_for_id(row_id) or find_cited_merge_sha(line)
    if merge_sha is None:
        left_not_found.append(row_id)
        print("SKIP %s: no merge commit found (row left unchanged)" % row_id)
        continue
    if not is_ancestor(merge_sha, TAG):
        left_not_ancestor.append(row_id)
        continue

    sha8 = merge_sha[:8]
    cells[status_idx] = "released@%s" % now_stamp
    note_text = "Released in %s (merge %s is an ancestor of %s)." % (TAG, sha8, TAG)
    cells[-1] = (cells[-1] + " " + note_text).strip() if cells[-1] else note_text
    new_line = "| " + " | ".join(cells) + " |"
    line_ending = raw_line[len(raw_line.rstrip("\r\n")):]
    lines[i] = new_line + line_ending
    flipped.append((row_id, sha8))
    print("RELEASED %s: merge %s is an ancestor of %s" % (row_id, sha8, TAG))

if not flipped:
    print("board-mark-released: no rows flipped (%d left, no merge found; %d left, not yet released)"
          % (len(left_not_found), len(left_not_ancestor)))
    sys.exit(0)

new_text = "".join(lines)
if len(new_text.splitlines()) != len(original_text.splitlines()):
    print(
        "board-mark-released: REFUSING to write %s -- line count changed (%d -> %d)"
        % (BOARD_MD, len(original_text.splitlines()), len(new_text.splitlines())),
        file=sys.stderr,
    )
    sys.exit(1)


# Write to a sibling temp file, fsync, then rename over BOARD_MD: os.replace
# is atomic on the same filesystem, so a crash or kill mid-write leaves
# either the old file or the new one, never a truncated/half-written one
# (this repo has a real incident of a coordination file going to 0 bytes
# mid-write; see docs memory feedback-python-heredoc-emptied-a-coordination-file).
_tmp_path = "%s.tmp%d" % (BOARD_MD, os.getpid())
with open(_tmp_path, "w", encoding="utf-8") as f:
    f.write(new_text)
    f.flush()
    os.fsync(f.fileno())
os.replace(_tmp_path, BOARD_MD)

print("board-mark-released: %d row(s) flipped to released@%s in %s" % (len(flipped), now_stamp, BOARD_MD))
sys.exit(0)
BMR_PY
