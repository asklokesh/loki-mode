#!/usr/bin/env bash
# scripts/v10-ops.sh -- fast, direct subcommands for trivial orchestration
# operations (git status checks, commit message formatting, one-row BOARD.md
# status flips, version/CI lookups) that the v10 swarm's orchestrator needs
# on every turn.
#
# Founder directive D26 guard 2: this session dispatched full subagents for
# a one-line "write a commit message" (22 min, 229k tokens) and a one-line
# "is the tree clean" (16 min, 182k tokens). Neither needs a model call.
# This script is the documented fast path so there is never a reason to
# reach for the Agent tool for these.
#
# Every subcommand is a thin wrapper around git/gh/python3 one-liners this
# codebase already uses elsewhere (see scripts/local-ci.sh, scripts/v10-pulse.sh).
# No subcommand should take more than a few seconds, excluding genuine
# network latency on version-check/ci-status.
#
# Usage: bash scripts/v10-ops.sh <subcommand> [args...]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
    cat <<'EOF'
scripts/v10-ops.sh -- fast path for trivial orchestration ops (no subagent needed)

Subcommands:
  status
      git status --short. Nothing more.

  clean-check
      Exit 0 if the working tree (staged + unstaged) is clean, 1 if dirty,
      2 if git itself failed (no .git, corrupt index, permission error --
      never printed as CLEAN). Prints a one-line summary in all cases.
      Untracked files count as dirty (same as `git status --porcelain`).

  commit-msg-template <type> <summary...>
      Formats a repo-convention commit message to stdout:
        <type>: <summary>
        <blank>
        Claude-Session: <session URL>
      <type> is used verbatim (e.g. "docs(v10)", "fix(S-74)"). Requires
      V10_OPS_SESSION_URL to be set -- exits 2 with no output on stdout if
      it is unset, so a placeholder trailer can never land in a real commit.
      This is string formatting only -- it never calls a model.

  board-row-status <slice-id> <new-status-token> [board-md-path]
      Flips exactly one BOARD.md row's Status cell to
      "<new-status-token>@<UTC timestamp>". Line-anchored: matches the row
      whose first pipe-delimited cell (ID) equals <slice-id> exactly. Fails
      loudly (exit 2) if zero or more than one row matches. <new-status-token>
      must match ^[a-z][a-z-]*$ and be one of the documented lifecycle
      tokens (ready building review review-blocked approved merged released
      blocked rejected parked) -- rejected before the file is touched, exit 2,
      so it can never carry an "@", "|", whitespace, or a newline into the
      table. The Status column index comes from walking up to the nearest
      table header and matching its "Status" label, never from scanning cell
      shapes anywhere in the row (a Branch/SHA cell like "main@abc123" can
      shape-match just like "<token>@<timestamp>", and so can an unrelated
      Notes fragment after an embedded "|" splits it). If the row's column
      count differs from its header's, the index shifts by POSITION, not by
      re-scanning: one column fewer shifts left by one (the real board's only
      observed short shape, a missing "Acceptance checks" column before
      Status); one column more keeps the header's index (an embedded "|"
      inside Notes, the last column, after Status); any other column-count
      difference refuses outright. Whichever index is chosen, the existing
      cell there must already match <known-token>@YYYY-MM-DDTHH:MMZ or the
      flip is refused, exit 2 -- this is what catches a wrong positional
      guess instead of silently overwriting the wrong cell. Reads and writes
      the file with no newline translation, so a CRLF board keeps CRLF.
      Writes atomically (temp file + fsync + rename, permission bits
      preserved) so a kill mid-write cannot leave BOARD.md empty, and
      resolves symlinks first so a symlinked board edits its real target,
      not the link. After the replace, re-reads the file from disk and
      verifies every non-target line, the total line count, and that the
      target row changed in exactly its Status cell, are all as expected; on
      any mismatch it restores the original content and exits 3. A directory
      that refuses new files (a read-only board) is reported as a clean
      error, not a traceback. Default board-md-path: docs/v10/BOARD.md.

  push-main
      Pushes HEAD's REPO_ROOT (this script's own repo) to origin main with
      no pipe, then verifies the push actually landed: compares `git
      ls-remote origin refs/heads/main` against `git rev-parse HEAD`. Prints
      both SHAs. Succeeds (exit 0) only if the push itself exited 0 AND the
      two SHAs match; any other outcome (a rejected/failed push, or a
      mismatched remote) is exit 1, with both SHAs still printed as evidence.
      PRE_PUSH_SKIP is passed straight through: it is read from this
      process's own environment (however the caller set it) and inherited by
      `git push`'s pre-push hook like any other subprocess call, no extra
      wiring needed.

  version-check
      Prints VERSION file contents and, if network/gh access works, the
      latest published npm version of loki-mode for comparison.

  ci-status [workflow-name]
      gh run list --branch main --workflow <name> --limit 1, formatted.
      Defaults to "Tests" if no workflow name given.

  worktree-budget <cap>
      Prints how many more worktrees a batch may open before dispatch: <cap>
      minus the entries under .claude/worktrees/ in `git worktree list
      --porcelain`. Exit 0 when that is above 0. At or over the cap prints 0
      and exits 1. A non-integer cap or a git failure exits 2.
EOF
}

cmd_status() {
    git -C "$REPO_ROOT" status --short
}

cmd_clean_check() {
    local dirty status
    dirty="$(git -C "$REPO_ROOT" status --porcelain 2>&1)"
    status=$?
    if [ "$status" -ne 0 ]; then
        echo "ERROR: 'git status' failed (exit $status) in $REPO_ROOT -- cannot determine clean/dirty: $dirty" >&2
        return 2
    fi
    if [ -z "$dirty" ]; then
        echo "CLEAN: working tree has no staged or unstaged changes."
        return 0
    fi
    local n
    n="$(printf '%s\n' "$dirty" | grep -c .)"
    echo "DIRTY: $n changed path(s). Run 'git status --short' for detail."
    return 1
}

cmd_commit_msg_template() {
    local type="${1:-}"
    shift || true
    local summary="$*"
    if [ -z "$type" ] || [ -z "$summary" ]; then
        echo "usage: v10-ops.sh commit-msg-template <type> <summary...>" >&2
        return 2
    fi
    if [ -z "${V10_OPS_SESSION_URL:-}" ]; then
        echo "commit-msg-template: V10_OPS_SESSION_URL is not set -- refusing to" \
             "emit a placeholder trailer that could land in a real commit" >&2
        return 2
    fi
    printf '%s: %s\n\nClaude-Session: %s\n' "$type" "$summary" "$V10_OPS_SESSION_URL"
}

# Precise, line-anchored single-row status flip. Never a blind find/replace:
# matches on the row's ID cell only, refuses on 0 or >1 matches, validates
# the new token before touching the file, writes atomically, and re-reads
# the result from disk to verify every other line is byte-identical
# (the anti-D18 property -- checked against disk, not memory).
V10_OPS_BOARD_TOKENS="ready building review review-blocked approved merged released blocked rejected parked"

cmd_board_row_status() {
    local slice_id="${1:-}" new_token="${2:-}" board="${3:-$REPO_ROOT/docs/v10/BOARD.md}"
    if [ -z "$slice_id" ] || [ -z "$new_token" ]; then
        echo "usage: v10-ops.sh board-row-status <slice-id> <new-status-token> [board-md-path]" >&2
        return 2
    fi
    # Validated before anything on disk is touched. The shape check alone
    # (lowercase letters and hyphens only) already excludes "@", "|",
    # whitespace and newlines -- a token carrying any of those could grow a
    # table column or a line count instead of just flipping a cell.
    if ! [[ "$new_token" =~ ^[a-z][a-z-]*$ ]]; then
        echo "board-row-status: invalid status token '$new_token' -- must match ^[a-z][a-z-]*\$" \
             "(lowercase letters and hyphens only; no @, |, whitespace, or newline)" >&2
        return 2
    fi
    local token_ok="" t
    for t in $V10_OPS_BOARD_TOKENS; do
        if [ "$new_token" = "$t" ]; then
            token_ok=1
            break
        fi
    done
    if [ -z "$token_ok" ]; then
        echo "board-row-status: unknown status token '$new_token' -- must be one of: $V10_OPS_BOARD_TOKENS" >&2
        return 2
    fi
    if [ ! -f "$board" ]; then
        echo "board-row-status: no such file: $board" >&2
        return 2
    fi
    python3 -E -S -c '
import sys, os, re, shutil, tempfile, datetime

board, slice_id, new_token = sys.argv[1], sys.argv[2], sys.argv[3]
known_tokens = sys.argv[4].split()

# Resolve symlinks/relative components up front. Without this, replacing a
# symlinked board.md would swap the LINK for a plain file and leave the real
# target untouched, while every path used below (including the post-write
# disk re-read) still reads the same resolved file and reports success.
board = os.path.realpath(board)

# newline="" disables newline translation on both read and write, so a CRLF
# board keeps its CRLF bytes untouched instead of every line getting
# rewritten as LF.
try:
    with open(board, "r", encoding="utf-8", newline="") as f:
        lines = f.readlines()
except OSError as e:
    print("board-row-status: cannot read " + board + ": " + str(e), file=sys.stderr)
    sys.exit(2)

before_count = len(lines)
before_lines = list(lines)

# A row is a table line whose first pipe cell (after the leading "|") is
# exactly the slice id. Anchor with word boundaries so "S-1" never matches
# "S-10".
row_re = re.compile(r"^\|\s*" + re.escape(slice_id) + r"\s*\|")
matches = [i for i, line in enumerate(lines) if row_re.match(line)]

if len(matches) == 0:
    print("board-row-status: no row found for slice id " + slice_id, file=sys.stderr)
    sys.exit(2)
if len(matches) > 1:
    print("board-row-status: " + str(len(matches)) + " rows matched slice id "
          + slice_id + " -- refusing to guess", file=sys.stderr)
    sys.exit(2)

idx = matches[0]

# Locate the Status column via the nearest preceding markdown table header,
# never by scanning cell SHAPES. A Branch/SHA cell can read "main@abc123"
# (no space) -- indistinguishable by shape from "<token>@<timestamp>" -- so
# shape-matching risks silently editing the wrong column. Column count and
# order vary across the table layouts in BOARD.md, so the header is read fresh
# for every call rather than assuming a fixed index.
sep_re = re.compile(r"^\s*\|(?:\s*:?-+:?\s*\|)+\s*$")
header_idx = None
for i in range(idx - 1, -1, -1):
    if i > 0 and sep_re.match(lines[i]):
        header_idx = i - 1
        break
if header_idx is None:
    print("board-row-status: could not locate a table header above the row "
          "for " + slice_id, file=sys.stderr)
    sys.exit(2)

header_cells = lines[header_idx].split("|")
header_status_idx = None
for i, cell in enumerate(header_cells):
    if cell.strip().lower() == "status":
        header_status_idx = i
        break
if header_status_idx is None:
    print("board-row-status: the table header above " + slice_id
          + " has no Status column", file=sys.stderr)
    sys.exit(2)

row = lines[idx]
cells = row.split("|")

# The existing cell must already be exactly "<known-token>@<UTC timestamp>"
# (the documented Status format in docs/v10/BOARD.md). Refusing anything else --
# a bare word, a SHA-shaped cell that slipped past the header lookup, a row
# that predates the format -- means an unexpected cell is never overwritten.
current_status_re = re.compile(
    r"^\s*(" + "|".join(re.escape(t) for t in known_tokens)
    + r")@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\s*$"
)

# Decide the Status index by POSITION, never by scanning for a cell that
# happens to shape-match anywhere in the row -- an anywhere-in-row scan
# cannot tell a real Status cell apart from a Notes fragment that, after an
# embedded "|" split it into pieces, coincidentally also shape-matches
# <token>@<timestamp> (e.g. a "was ready | review@..." fragment sitting
# right after a genuine, untouched "in progress" Status cell). Two real
# column-count drifts are measured in docs/v10/BOARD.md:
#   - one column MORE than the header: the extra cell(s) come from a
#     literal "|" inside Notes, the LAST column -- everything before Notes,
#     including Status, keeps the same index the header gives it.
#   - one column FEWER than the header: the missing column is "Acceptance
#     checks", which sits immediately BEFORE Status in that layout -- every
#     later column, including Status, shifts one index to the left.
# Any other column-count difference is unrecognized shape drift; refuse
# rather than guess a position.
if len(cells) == len(header_cells) or len(cells) > len(header_cells):
    status_idx = header_status_idx
elif len(cells) == len(header_cells) - 1:
    status_idx = header_status_idx - 1
else:
    print("board-row-status: row for " + slice_id + " has " + str(len(cells))
          + " columns, header has " + str(len(header_cells)) + " -- unrecognized "
          "column-count drift, refusing to guess a position", file=sys.stderr)
    sys.exit(2)

if status_idx < 0 or status_idx >= len(cells):
    print("board-row-status: computed Status index " + str(status_idx)
          + " is out of range for row " + slice_id + " (" + str(len(cells))
          + " columns) -- refusing to guess", file=sys.stderr)
    sys.exit(2)

# Whichever way the index was derived, the cell it points at must already
# be exactly "<known-token>@<full UTC timestamp>". This is what catches a
# wrong positional guess (e.g. a column-drift shape this script does not
# actually match the two recognized cases above) instead of silently
# overwriting an unrelated cell.
if not current_status_re.match(cells[status_idx]):
    print("board-row-status: the Status cell for " + slice_id
          + " does not match <token>@YYYY-MM-DDTHH:MMZ -- refusing to edit "
          "an unexpected cell: " + cells[status_idx].strip(), file=sys.stderr)
    sys.exit(2)

timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
cells[status_idx] = " " + new_token + "@" + timestamp + " "
lines[idx] = "|".join(cells)

after_count = len(lines)
if after_count != before_count:
    print("board-row-status: FATAL line-count mismatch (" + str(before_count)
          + " -> " + str(after_count) + ") before write -- aborting, board untouched",
          file=sys.stderr)
    sys.exit(3)

# TEST ONLY: corrupts an unrelated in-memory line right before the write, so
# the post-write disk-verification below has a real corruption to catch
# without needing to simulate an actual disk fault. Never set in normal use.
if os.environ.get("V10_OPS_TEST_CORRUPT_WRITE") == "1" and after_count > 1:
    victim = 0 if idx != 0 else after_count - 1
    lines[victim] = lines[victim].rstrip("\r\n") + " CORRUPTED\n"

# Atomic write: a temp file in the same directory, fsync, then rename over
# the original. A kill mid-write leaves either the old file (rename never
# happened) or the new one (rename is atomic on the same filesystem) -- never
# an empty BOARD.md. Writing to a fresh temp file also means a read-only
# board.md itself is not what stands in the way; only a non-writable
# directory is, and that is reported cleanly below instead of a traceback.
board_dir = os.path.dirname(board) or "."

def _atomic_write(content, prefix):
    # mkstemp creates the temp file 0600 regardless of the board file real
    # mode, and os.replace carries that mode straight onto the board -- so
    # without copymode a 644 board.md silently becomes 600 on every write,
    # including a restore. Shared by the main write and the restore path
    # below so both preserve the actual permission bits of the board file.
    fd, tmp_path = tempfile.mkstemp(prefix=prefix, dir=board_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.writelines(content)
            f.flush()
            os.fsync(f.fileno())
        shutil.copymode(board, tmp_path)
        os.replace(tmp_path, board)
    except OSError:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise

try:
    _atomic_write(lines, ".v10-ops-board-")
except OSError as e:
    print("board-row-status: cannot write " + board + ": " + str(e), file=sys.stderr)
    sys.exit(2)

# The anti-D18 property, checked against DISK, never memory: every line
# other than the target row must be byte-identical to the pre-image, the
# target row must match what was intended, and the total line count must be
# unchanged. Comparing the in-memory list to itself cannot catch a
# corrupted write -- even deleting the board entirely would still pass that
# check. Re-reading from disk after the atomic replace is what makes it real.
try:
    with open(board, "r", encoding="utf-8", newline="") as f:
        disk_lines = f.readlines()
except OSError as e:
    print("board-row-status: FATAL cannot re-read " + board + " after write: "
          + str(e), file=sys.stderr)
    try:
        _atomic_write(before_lines, ".v10-ops-board-restore-")
        print("board-row-status: original content restored", file=sys.stderr)
    except OSError as e2:
        print("board-row-status: FATAL restore also failed (" + str(e2)
              + ") -- restore " + board + " from git immediately", file=sys.stderr)
    sys.exit(3)

corrupted = len(disk_lines) != before_count
if not corrupted:
    before_row_cells = before_lines[idx].split("|")
    for i in range(before_count):
        if i != idx:
            if disk_lines[i] != before_lines[i]:
                corrupted = True
                break
            continue
        # The target row itself: must have changed in EXACTLY the Status
        # cell, column-for-column identical everywhere else.
        disk_row_cells = disk_lines[i].split("|")
        if len(disk_row_cells) != len(before_row_cells):
            corrupted = True
            break
        for j in range(len(before_row_cells)):
            if j != status_idx and disk_row_cells[j] != before_row_cells[j]:
                corrupted = True
                break
        if corrupted:
            break
        if disk_row_cells[status_idx] != cells[status_idx]:
            corrupted = True
            break

if corrupted:
    try:
        _atomic_write(before_lines, ".v10-ops-board-restore-")
        print("board-row-status: FATAL post-write verification failed for " + slice_id
              + " -- disk content diverged from the expected write, original restored",
              file=sys.stderr)
    except OSError as e:
        print("board-row-status: FATAL post-write verification failed AND restore "
              "failed (" + str(e) + ") -- restore " + board + " from git immediately",
              file=sys.stderr)
    sys.exit(3)

print("board-row-status: " + slice_id + " -> " + new_token + "@" + timestamp)
' "$board" "$slice_id" "$new_token" "$V10_OPS_BOARD_TOKENS"
}

cmd_push_main() {
    # PRE_PUSH_SKIP passthrough: any env var already present in this
    # process's environment is inherited by every subprocess it spawns
    # (including `git push`'s own pre-push hook) with no extra code needed.
    # The re-export below only guards the edge case where PRE_PUSH_SKIP
    # arrived as a plain, unexported shell variable rather than a real env
    # var -- it is a no-op for the normal `PRE_PUSH_SKIP=1 bash ...` case.
    export PRE_PUSH_SKIP="${PRE_PUSH_SKIP:-}"

    local push_rc local_sha remote_sha
    # No pipe: the exit code captured below is git push's own, never a
    # pipeline's (a `| tee` or `| cat` here would launder a real push
    # failure through pipefail's last-command-wins semantics).
    git -C "$REPO_ROOT" push origin main
    push_rc=$?

    local_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    remote_sha="$(git -C "$REPO_ROOT" ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}')"

    echo "local HEAD:  $local_sha"
    echo "origin/main: ${remote_sha:-<none>}"

    if [ "$push_rc" -eq 0 ] && [ -n "$remote_sha" ] && [ "$remote_sha" = "$local_sha" ]; then
        echo "push-main: OK (push exited 0, ls-remote matches HEAD)"
        return 0
    fi
    echo "push-main: FAILED (push rc=$push_rc, HEAD=$local_sha, origin/main=${remote_sha:-<none>})" >&2
    return 1
}

cmd_version_check() {
    local v
    v="$(cat "$REPO_ROOT/VERSION" 2>/dev/null || echo MISSING)"
    echo "VERSION file: $v"
    if command -v npm >/dev/null 2>&1; then
        local npm_v
        npm_v="$(npm view loki-mode dist-tags.next 2>/dev/null)"
        if [ -n "$npm_v" ]; then
            echo "npm published (next): $npm_v; latest promoted: $(npm view loki-mode dist-tags.latest 2>/dev/null)"
        else
            echo "npm published: unavailable (no network or npm error)"
        fi
    else
        echo "npm published: npm not on PATH"
    fi
}

cmd_ci_status() {
    local workflow="${1:-Tests}"
    if ! command -v gh >/dev/null 2>&1; then
        echo "ci-status: gh not on PATH" >&2
        return 2
    fi
    gh run list --branch main --workflow "$workflow" --limit 1 \
        --json status,conclusion,displayTitle,headSha,createdAt \
        --template '{{range .}}{{.displayTitle}} ({{.headSha}}) -- status={{.status}} conclusion={{.conclusion}} at {{.createdAt}}
{{end}}'
}

cmd_worktree_budget() {
    local cap="${1:-}" list used
    if ! [[ "$cap" =~ ^[0-9]+$ ]]; then
        echo "usage: v10-ops.sh worktree-budget <cap> (non-negative integer)" >&2
        return 2
    fi
    # Captured first (no pipe) so a git failure is exit 2, never a budget.
    if ! list="$(git -C "$REPO_ROOT" worktree list --porcelain 2>&1)"; then
        echo "worktree-budget: git worktree list failed: $list" >&2
        return 2
    fi
    used="$(printf '%s\n' "$list" | awk '/^worktree .*\/\.claude\/worktrees\//{n++} END{print n+0}')"
    if [ "$used" -ge "$((10#$cap))" ]; then
        echo 0
        return 1
    fi
    echo "$((10#$cap - used))"
}

main() {
    local sub="${1:-}"
    [ -n "$sub" ] && shift
    case "$sub" in
        status)                cmd_status "$@" ;;
        clean-check)            cmd_clean_check "$@" ;;
        commit-msg-template)    cmd_commit_msg_template "$@" ;;
        board-row-status)       cmd_board_row_status "$@" ;;
        push-main)              cmd_push_main "$@" ;;
        version-check)          cmd_version_check "$@" ;;
        ci-status)              cmd_ci_status "$@" ;;
        worktree-budget)        cmd_worktree_budget "$@" ;;
        -h|--help|help|"")      usage ;;
        *)
            echo "v10-ops.sh: unknown subcommand '$sub'" >&2
            usage >&2
            return 2
            ;;
    esac
}

main "$@"
