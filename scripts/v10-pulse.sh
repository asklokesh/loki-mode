#!/usr/bin/env bash
# scripts/v10-pulse.sh -- deterministic anti-drift status/violation reporter
# for the v10 swarm (docs/v10/SWARM.md, docs/v10/BOARD.md, docs/v10/CONTROL.md).
# No model calls. Prints a status block to stdout, then a NEXT ACTIONS block
# if any VIOLATION fired.
#
# Exit codes:
#   0 -- clean (no violation, every metric known)
#   1 -- at least one VIOLATION fired
#   2 -- no VIOLATION, but at least one metric came back UNKNOWN (a crashed
#        or timed-out sub-check must never read as clean)
# ponytail: a hook wrapper (`bash scripts/v10-pulse.sh || true`) is a
# separate step's job, not this script's -- this script's own contract only
# needs to be honest about 0 vs 1 vs 2.
#
# This is a thin bash wrapper around one embedded python3 -E program: all
# parsing, date math, stat calls and subprocess timeouts live there, so bash
# 3.2 (macOS default /bin/bash) is trivially safe -- there is almost nothing
# here for a bashism to break.
#
# Every external data source is env-var overridable, matching this repo's
# ${VAR:-default} convention (see autonomy/run.sh: LOKI_SESSION_MODEL,
# LOKI_ORIGINAL_SCRIPT_DIR), so tests fully control inputs with no real
# npm/gh/git network or wall-clock dependency:
#   BOARD_MD            path to BOARD.md (default: docs/v10/BOARD.md)
#   CONTROL_MD          path to CONTROL.md (default: docs/v10/CONTROL.md)
#   PULSE_REPO_ROOT     repo root for git operations (default: this repo)
#   PULSE_MAIN_REF      the ref to treat as "main" (default: main) -- used for
#                       CI status, unreleased-merge age and the moat baseline,
#                       so this script gives an honest answer about the swarm's
#                       main line even when run from a builder worktree whose
#                       own HEAD is a feature branch.
#   PULSE_NPM_CMD       npm command to run (default: npm view loki-mode time dist-tags --json)
#   PULSE_GH_CMD        gh command to run (default: gh run list --branch main
#                       --commit <main-sha> --json status,conclusion,workflowName --limit 20)
#   PULSE_GH_STREAK_CMD gh command for the CI_CANCELLED_STREAK check (default:
#                       gh run list --branch main --workflow Tests --json
#                       status,conclusion --limit 10). Independent of
#                       PULSE_GH_CMD/main_sha on purpose -- it must still run
#                       (and be able to fire) even when the main-CI-status
#                       lookup above cannot resolve a SHA and reads UNKNOWN.
#   PULSE_GOVERNOR_CMD  command producing scripts/usage-governor.py --json
#                       output, for OPUS_SHARE/BUDGET_BURN (default: python3
#                       scripts/usage-governor.py --json). Cached the same
#                       90s way as PULSE_NPM_CMD/PULSE_GH_CMD below (S-104:
#                       interactive pulse reads cache only, a stale/missing
#                       entry starts the same detached background refresh).
#   PULSE_GOVERNOR_DEADLINE_SECS  wall-clock cap on the governor's own call
#                       inside that detached background refresh (default 45).
#                       Independent of PULSE_DEADLINE_SECS/NETWORK_DEADLINE:
#                       the governor scans every JSONL transcript under
#                       ~/.claude/projects, which measured ~125s on this
#                       repo's own real usage -- far slower than npm/gh, and
#                       never awaited by the interactive hook, so it gets a
#                       longer, separate ceiling instead of sharing npm/gh's
#                       short one. A host slower than this ceiling reads
#                       OPUS_SHARE/BUDGET_BURN as UNKNOWN until the governor
#                       itself is optimized or scoped narrower (a finding for
#                       G-01/usage-governor.py, not something this pulse
#                       check can paper over).
#   PULSE_WORKTREE_CMD  git worktree list command (default: git worktree list --porcelain)
#   PULSE_MOAT_RESULT   path to a file holding the real captured stdout of a
#                       `bash tests/moat/run.sh` run (its own summary lines
#                       are parsed: "moat: N of 9 properties proven" and, on
#                       failure, "moat suite: FAIL (K rule failure(s))").
#                       This is the ONLY source MOAT_REGRESSION trusts: the
#                       pending.txt-derived count is ratchet-only (its id set
#                       can only shrink release over release, per
#                       tests/moat/run.sh's own contract) and so can never by
#                       itself register a real regression -- it is shown as
#                       informational context only. With no PULSE_MOAT_RESULT
#                       (or an unreadable/unparseable one), MOAT_REGRESSION
#                       reports UNKNOWN rather than silently falling back to
#                       the pending-derived count.
#                       SHA pinning (BACKLOG 133): a result file alone is not
#                       enough -- it must also prove which commit it was
#                       measured against. The writer MUST also write a
#                       sidecar file at "<PULSE_MOAT_RESULT>.sha" holding
#                       exactly the full 40-char SHA the tree was at when
#                       `tests/moat/run.sh` was run (no trailing content, no
#                       short SHA, no ref name -- compared byte-for-byte,
#                       never re-resolved through git). Capture the SHA and
#                       require a clean tree BEFORE running the suite, not
#                       after: `tests/moat/run.sh` takes minutes, in which
#                       time HEAD can move (another process, a background
#                       swarm run) and a dirty tree means HEAD's SHA does not
#                       actually describe what was measured. Typical use:
#                         git diff --quiet HEAD || exit 1
#                         moat_sha="$(git rev-parse HEAD)"
#                         bash tests/moat/run.sh > moat-result.txt
#                         printf '%s\n' "$moat_sha" > moat-result.txt.sha
#                         PULSE_MOAT_RESULT=moat-result.txt bash scripts/v10-pulse.sh
#                       This script compares that sidecar's contents against
#                       PULSE_MAIN_REF's current resolved HEAD. A missing/
#                       empty sidecar (an older-style capture with no
#                       provenance) or a mismatched SHA (a stale capture from
#                       an earlier commit) both report UNKNOWN with a clear
#                       reason -- never a confident clean/regression verdict
#                       from input that cannot be proven current.
#   PULSE_SWARM_START   swarm start time override, epoch seconds or ISO8601
#   PULSE_NOW           "now" override, epoch seconds or ISO8601
#   PULSE_LAST_TRAIN_PUSH override for the last train-push time (TRAIN_LATE,
#                       D27 item 6), epoch seconds or ISO8601. Deliberately
#                       never the release tag -- a release can lag a push by
#                       minutes (see NO_RECENT_RELEASE's separate 90-minute
#                       budget for that). With no override, falls back to the
#                       reflog time of PULSE_TRAIN_PUSH_REF (a local `git
#                       push` moves it, and so does a `git fetch` that pulls
#                       in someone else's push -- the real meaning of "last
#                       train push"), then to the mtime of the newest
#                       push-*.log file under PULSE_PUSH_LOG_DIR.
#   PULSE_TRAIN_PUSH_REF the ref whose reflog is read for the
#                       PULSE_LAST_TRAIN_PUSH fallback above (default:
#                       refs/remotes/origin/main). Overridable for tests
#                       only; production never needs to change it.
#   PULSE_PUSH_LOG_DIR  directory to look for push-*.log files in for the
#                       reflog-less fallback above (default: ~/loki-ci-logs,
#                       where scripts/v10-ops.sh push-main and the swarm's
#                       train-push tooling write their logs). Only reached
#                       when PULSE_TRAIN_PUSH_REF has no reflog.
#   PULSE_PYTHON        python3 interpreter to use (default: python3)
#   PULSE_DEADLINE_SECS network-call time budget in seconds for npm+gh
#                       together (default: 3; the calls run concurrently, so
#                       this is also the per-call cap). git/worktree calls
#                       use a separate small fixed cap.
#   PULSE_CACHE         "0" disables the network cache below (default: on).
#   PULSE_CACHE_DIR     cache directory (default: $PULSE_REPO_ROOT/.loki/pulse-cache,
#                       gitignored via .loki/).
#   PULSE_LOAD_MAX      HIGH_LOAD threshold override (default: 28, 2x 14 cores).
#   PULSE_LOADAVG       overrides the 1-minute load average reading (default:
#                       `sysctl -n vm.loadavg` on macOS, /proc/loadavg on Linux).
#   PULSE_PS_OUTPUT     overrides `ps -eo pid,ppid,etime,command` for
#                       ORPHAN_TEST and ORPHAN_WORKTREE (same listing, both
#                       checks scan it independently).
#   PULSE_ORPHAN_WORKTREE_MAX_MIN
#                       age threshold in minutes for ORPHAN_WORKTREE (default
#                       30): a process older than this whose command line
#                       references a .claude/worktrees/ path or a
#                       /tmp/loki-run-*.sh script fires (E-00: a `timeout N
#                       bash .../agent-<id>/autonomy/run.sh` that ignored
#                       SIGTERM ran over 24h and ORPHAN_TEST's own tests/*
#                       regex never saw it).
#   PULSE_DOCKER_PS     overrides the docker container listing for
#                       STRAY_CONTAINER (see that check's own docstring for
#                       the tab-separated row shape).
#   PULSE_WORKTREE_LIST overrides `git worktree list --porcelain` for
#                       WORKTREE_COUNT and STRAY_WORKTREE (a raw porcelain
#                       listing, same shape as PULSE_WORKTREE_CMD's default
#                       output).
#   PULSE_RELEASE_TESTS overrides the gh-run-list JSON RELEASE_ON_RED reads
#                       for the newest VERSION-bump commit's Tests conclusion
#                       (default: read from S-104's gh_ci cache).
#   PULSE_PROGRESS_MD   path to PROGRESS.md for STALE_PROGRESS (default:
#                       docs/v10/PROGRESS.md). Its newest "## <ISO
#                       timestamp>Z" heading is the last-entry time; a
#                       missing file or no parseable heading reports UNKNOWN,
#                       never a false clean.
#   PULSE_TRANSCRIPT_DIR overrides the directory of session transcript files
#                       scanned for SESSION_STALLED (default:
#                       ~/.claude/projects/<project-slug>, Claude Code's own
#                       session JSONL directory; slug = the MAIN repo root's
#                       realpath (via `git rev-parse --git-common-dir`, so a
#                       subdirectory or a linked worktree resolves the same)
#                       with every non-alphanumeric character replaced by
#                       '-', the same rule autonomy/context-tracker.py's
#                       derive_project_slug uses). The newest *.jsonl mtime
#                       under this directory is "last assistant turn". A
#                       missing/unreadable directory, or one with no *.jsonl
#                       file, reports UNKNOWN, never a false clean.
#   PULSE_LOOP_MARKER   path to the loop-active marker file for
#                       SESSION_STALLED (default:
#                       $PULSE_REPO_ROOT/.loki/state/loop-active). Written
#                       with a UTC timestamp by whoever runs the /loop,
#                       refreshed every iteration (only its mtime is read).
#                       SESSION_STALLED only evaluates while this file's
#                       mtime is under 24h old, so an abandoned marker from
#                       an earlier /loop run can never keep this check firing
#                       after the loop has actually stopped. No marker (or
#                       one 24h+ old): reports n/a, never a violation and
#                       never UNKNOWN.
#
# Network cache (S-104: this runs as a UserPromptSubmit hook on every prompt,
# on a machine with ~16 concurrent agents, and a 15s hook timeout was being
# hit). When no PULSE_NPM_CMD/PULSE_GH_CMD/PULSE_GH_STREAK_CMD override is
# set (i.e. real npm/gh), the status run NEVER makes a network call: it reads
# the last successful npm/gh results from PULSE_CACHE_DIR. A result older than
# 90s is shown as STALE with its age (never as fresh), older than 1h or absent
# (or, for main CI, recorded against a different main SHA) is UNKNOWN. Any
# stale/missing entry starts ONE detached background refresh (this same
# script with PULSE_REFRESH_ONLY=1, PID recorded in refresh.pid, each call
# capped at PULSE_DEADLINE_SECS) whose result the next prompt sees. A failed
# refresh call never overwrites a good cached value; it just ages into STALE.
# With any override set (every test in tests/test-v10-pulse.sh), the calls
# run synchronously exactly as before, so fixtures are never cache-polluted.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PULSE_SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
export PULSE_SELF

PULSE_PYTHON="${PULSE_PYTHON:-python3}"
PULSE_REPO_ROOT="${PULSE_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
BOARD_MD="${BOARD_MD:-$DEFAULT_REPO_ROOT/docs/v10/BOARD.md}"
CONTROL_MD="${CONTROL_MD:-$DEFAULT_REPO_ROOT/docs/v10/CONTROL.md}"
PULSE_PROGRESS_MD="${PULSE_PROGRESS_MD:-$DEFAULT_REPO_ROOT/docs/v10/PROGRESS.md}"

export PULSE_REPO_ROOT BOARD_MD CONTROL_MD PULSE_PROGRESS_MD
export PULSE_TRANSCRIPT_DIR="${PULSE_TRANSCRIPT_DIR:-}"
export PULSE_LOOP_MARKER="${PULSE_LOOP_MARKER:-}"
export PULSE_MAIN_REF="${PULSE_MAIN_REF:-main}"
export PULSE_NPM_CMD="${PULSE_NPM_CMD:-}"
export PULSE_GH_CMD="${PULSE_GH_CMD:-}"
export PULSE_GH_STREAK_CMD="${PULSE_GH_STREAK_CMD:-}"
export PULSE_GOVERNOR_CMD="${PULSE_GOVERNOR_CMD:-}"
export PULSE_WORKTREE_CMD="${PULSE_WORKTREE_CMD:-}"
export PULSE_MOAT_RESULT="${PULSE_MOAT_RESULT:-}"
export PULSE_SWARM_START="${PULSE_SWARM_START:-}"
export PULSE_NOW="${PULSE_NOW:-}"
export PULSE_LAST_TRAIN_PUSH="${PULSE_LAST_TRAIN_PUSH:-}"
export PULSE_PUSH_LOG_DIR="${PULSE_PUSH_LOG_DIR:-}"
export PULSE_TRAIN_PUSH_REF="${PULSE_TRAIN_PUSH_REF:-refs/remotes/origin/main}"
export PULSE_DEADLINE_SECS="${PULSE_DEADLINE_SECS:-3}"
export PULSE_CACHE="${PULSE_CACHE:-1}"
export PULSE_CACHE_DIR="${PULSE_CACHE_DIR:-$PULSE_REPO_ROOT/.loki/pulse-cache}"
export PULSE_REFRESH_ONLY="${PULSE_REFRESH_ONLY:-}"

# `-` (read the program from stdin) rather than a real path: sys.path[0] is
# then '' as usual for stdin programs, and the scrub at the very top of the
# heredoc (D7 pattern: never trust an importable cwd or env-injected
# PYTHONPATH) removes it before any other import runs.
exec "$PULSE_PYTHON" -E - <<'PULSE_PY'
import sys, os
sys.path = [p for p in sys.path if p not in ("", os.getcwd())]


def _pulse_excepthook(exc_type, exc, tb):
    # Every check below routes crashes through safe() into UNKNOWN, but
    # module-level code between those calls (an env-var parse, a shlex.split
    # on an operator-supplied command string, the ci_status/board name
    # bindings) is NOT inside any function safe() can wrap. An uncaught
    # exception there would otherwise be a bare traceback and exit 1 -- a
    # false VIOLATION for a script bug, not a real one. This is the
    # backstop: never let a crash anywhere in this program read as anything
    # but exit 2 (could not check).
    try:
        print("PULSE ERROR: %s: %s" % (exc_type.__name__, exc))
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(2)


sys.excepthook = _pulse_excepthook

import calendar
import datetime
import json
import re
import shlex
import signal
import subprocess
import time

REPO_ROOT = os.environ["PULSE_REPO_ROOT"]
BOARD_MD = os.environ["BOARD_MD"]
CONTROL_MD = os.environ["CONTROL_MD"]
PROGRESS_MD = os.environ["PULSE_PROGRESS_MD"]
MAIN_REF = os.environ.get("PULSE_MAIN_REF", "main") or "main"

# Two deadlines, not one shared pool. A single pool meant a hung npm call
# alone (with nothing else slow) spent the ENTIRE budget and left every
# later check (gh, git describe/log/show, worktree list) returned as an
# instant TIMEOUT with no process ever started -- CI_RED, MOAT_REGRESSION,
# UNRELEASED_MERGE and IDLE_BUILDERS all silently going dark behind one slow
# network call. Instead:
#   NETWORK_DEADLINE -- npm and gh (the only network calls) run concurrently
#     (Popen now, communicate later) against this shared wall-clock deadline,
#     so one hanging does not starve the other, and both together cost at
#     most this much, not the sum of two full timeouts.
#   HARD_DEADLINE -- the absolute wall-clock point (script start + ~9s) nothing
#     may run past. Every git call and the worktree-list call gets a small
#     fixed per-call cap, further capped by whatever is left of this.
T0 = time.monotonic()
_NET_SECS = float(os.environ.get("PULSE_DEADLINE_SECS", "3") or "3")
NETWORK_DEADLINE = T0 + _NET_SECS
# Cache mode (see the bash header): real npm/gh only, never when a test
# overrides a network command.
REFRESH_ONLY = os.environ.get("PULSE_REFRESH_ONLY") == "1"
CACHE_MODE = (
    os.environ.get("PULSE_CACHE", "1") != "0"
    and not any(os.environ.get(k) for k in (
        "PULSE_NPM_CMD", "PULSE_GH_CMD", "PULSE_GH_STREAK_CMD", "PULSE_GH_FALLBACK_CMD"))
)
CACHE_DIR = os.environ.get("PULSE_CACHE_DIR") or os.path.join(REPO_ROOT, ".loki", "pulse-cache")
CACHE_TTL = 90.0
CACHE_MAX_AGE = 3600.0
# The status run waits on the network only when not serving from cache, so
# only then does the hard deadline include the network budget. A cached run
# stays under ~3.5s of git work even when every git call is slow (S-104: the
# hook must finish well inside 5s on a loaded machine).
HARD_DEADLINE = T0 + 3.5 + (0.0 if (CACHE_MODE and not REFRESH_ONLY) else _NET_SECS)
GIT_CALL_CAP = 2.0


def time_left(deadline):
    return max(0.0, deadline - time.monotonic())


def safe(fn, *args, **kwargs):
    """Run a metric check, turning any uncaught exception into None (which
    every caller below already treats as UNKNOWN-for-that-metric) instead of
    letting it propagate and crash the whole script into a false exit 1."""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:
        print("pulse: %s raised %s: %s" % (getattr(fn, "__name__", fn), type(exc).__name__, exc), file=sys.stderr)
        return None


# Env vars this process must never forward to a git subprocess: a pre-push
# git hook (this script's eventual caller) exports GIT_DIR, and a value
# inherited here would make git resolve against the hook's repo instead of
# PULSE_REPO_ROOT. Same rationale as tests/moat/run.sh's own unset block.
_GIT_ENV_STRIP = (
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
)


def _clean_env():
    env = dict(os.environ)
    for k in _GIT_ENV_STRIP:
        env.pop(k, None)
    # C locale: moat_baseline_at_last_release() matches git's stderr text
    # ("No names found") to tell "no tag exists" apart from "the call
    # failed/timed out". git localizes that text; tests/moat/run.sh sets
    # LC_ALL=C for the same reason.
    env["LC_ALL"] = "C"
    return env


def start_proc(argv, cwd=None, env=None):
    """Start argv in its own process group (for a clean killpg on timeout),
    or return None if it could not even start."""
    try:
        return subprocess.Popen(
            argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except (OSError, ValueError):
        return None


def finish_proc(proc, timeout):
    """Wait up to timeout for proc, killing its whole process group on
    expiry. Returns (rc, stdout, stderr); rc is None on timeout.
    subprocess.run's own timeout= only signals the direct child; npm spawns
    node as a grandchild that can hold the pipe open past the deadline, so
    this manages the process group explicitly (start_new_session=True at
    start_proc + os.killpg here), the same scoping discipline as D14-D17:
    never an unscoped kill, only this process's own child group."""
    if proc is None:
        return (None, "", "SPAWN_FAILED")
    try:
        # A floor, not a bare max(0.0, ...): communicate(timeout=0.0) can
        # raise TimeoutExpired on its first internal check before ever
        # reading the pipe, even when the process already exited with its
        # output fully buffered (e.g. gh finishing in 10ms while npm, started
        # alongside it, used up the whole shared network deadline). A near-
        # zero floor gives every process at least one real chance to be
        # reaped and read before this gives up on it.
        out, err = proc.communicate(timeout=max(0.25, timeout))
        return (proc.returncode, out.decode("utf-8", "replace"),
                err.decode("utf-8", "replace"))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.communicate(timeout=0.5)
        except Exception:
            pass
        return (None, "", "TIMEOUT")


def run_capped(argv, cwd=None, env=None):
    """A single-shot run for git/worktree calls: capped at GIT_CALL_CAP,
    further capped by whatever is left of the hard deadline. Fails fast as a
    timeout without starting the process if the hard deadline is already
    gone, so one slow call cannot let a later one run unbounded."""
    budget = min(GIT_CALL_CAP, time_left(HARD_DEADLINE))
    if budget <= 0.05:
        return (None, "", "TIMEOUT")
    proc = start_proc(argv, cwd=cwd, env=env)
    return finish_proc(proc, budget)


_GIT_MEMO = {}


def git(args):
    # Memoized: `git describe` against MAIN_REF was run twice per pulse
    # (unreleased-merge age and the moat baseline); one answer serves both.
    key = tuple(args)
    if key not in _GIT_MEMO:
        _GIT_MEMO[key] = run_capped(["git"] + list(args), cwd=REPO_ROOT, env=_clean_env())
    return _GIT_MEMO[key]


def parse_time_value(raw):
    """Accept an epoch-seconds string or an ISO8601 'YYYY-MM-DDTHH:MMZ'
    (the BOARD.md timestamp format) and return epoch seconds, or None."""
    if raw is None or raw == "":
        return None
    raw = raw.strip()
    if re.match(r"^-?\d+(\.\d+)?$", raw):
        return float(raw)
    m = re.match(
        r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$", raw,
    )
    if not m:
        return None
    y, mo, d, h, mi, se = (int(x) if x else 0 for x in m.groups(default="0"))
    # The regex above only checks digit SHAPE (\d{2} matches "99" or "61"),
    # never calendar range. calendar.timegm does NOT reject every bad range
    # itself: it builds datetime.date(year, month, 1) -- which does catch a
    # bad MONTH -- then adds day/hour/minute/second as plain unchecked
    # arithmetic, so a bad day/hour/minute silently produces a wrong-but-valid
    # epoch instead of raising (reproduced: "2026-09-27T24:61Z" parsed with no
    # error and a negative age; "2026-02-30T10:00Z" silently normalized to
    # March 2 and fabricated a real AGENT_OVER_BUDGET violation). Validate the
    # FULL tuple with datetime.datetime first -- it enforces day-within-month
    # (catches Feb 30), hour 0-23, minute/second 0-59 -- before calendar.timegm
    # ever runs, so every one of those bad values is rejected here instead of
    # downstream.
    try:
        datetime.datetime(y, mo, d, h, mi, se)
    except ValueError:
        return None
    # All timestamps this parses (BOARD.md, PULSE_NOW/PULSE_SWARM_START
    # overrides) are explicit UTC ('Z' suffix). calendar.timegm treats the
    # tuple as UTC directly -- time.mktime() - time.timezone is WRONG here:
    # time.timezone is always the STANDARD offset, so it is off by an hour
    # under DST (verified: EDT reports time.timezone=18000, the EST value,
    # while the live offset is 14400).
    try:
        return float(calendar.timegm((y, mo, d, h, mi, se, 0, 0, 0)))
    except (ValueError, OverflowError):
        # Belt-and-suspenders: the datetime.datetime validation above already
        # rejects every range calendar.timegm itself could still choke on, but
        # every caller already treats None as "could not parse this value" and
        # either falls back or skips the row (see now_epoch, parse_npm_releases,
        # REVIEW_STALE, AGENT_OVER_BUDGET below), so keep this catch as the
        # same safe fallback rather than relying solely on the check above.
        return None


def now_epoch():
    override = parse_time_value(os.environ.get("PULSE_NOW", ""))
    return override if override is not None else time.time()


NOW = now_epoch()

# Fixed priority order for every VIOLATION this script can raise, matching
# the spec exactly. Printed in this order regardless of check order, because
# docs/v10/CONTROL.md's Rule says the first action of every turn addresses
# the TOP violation -- an accidental ordering-by-discovery would misrank it.
VIOLATION_PRIORITY = [
    "SESSION_STALLED", "CI_RED", "CI_CANCELLED_STREAK", "RELEASE_ON_RED", "HIGH_LOAD",
    "BUDGET_BURN", "OPUS_SHARE",
    "MOAT_REGRESSION", "MAIN_RED_BY_MERGE", "UNRELEASED_MERGE", "RELEASE_CADENCE", "TRAIN_LATE", "REVIEW_STALE",
    "AGENT_OVER_BUDGET", "STALE_PROGRESS", "UNEVIDENCED_CLAIM", "RELEASED_AHEAD_OF_NPM",
    "ORPHAN_TEST", "ORPHAN_WORKTREE", "STRAY_CONTAINER", "STRAY_WORKTREE",
    "WORKTREE_COUNT", "IDLE_BUILDERS", "UNDERSTAFFED", "LOW_READY", "NO_RECENT_RELEASE",
    "LOW_RELEASE_VOLUME", "RELEASE_SLO", "MERGED_NOT_RELEASED_STALE", "CONTROL_OVERSIZE",
]

violations = []          # list of (code, text)
unknown_metrics = []      # list of metric names that came back UNKNOWN
lines = []                # status block lines, printed verbatim


def add_violation(code, text):
    violations.append((code, text))


def mark_unknown(name):
    unknown_metrics.append(name)


def emit(line=""):
    lines.append(line)


def sorted_violations():
    def rank(item):
        code = item[0]
        try:
            return VIOLATION_PRIORITY.index(code)
        except ValueError:
            return len(VIOLATION_PRIORITY)
    return sorted(violations, key=rank)


# --- main SHA, then npm + gh started CONCURRENTLY against one network ------
# deadline (metrics 1 and 2). Started together and finished together so one
# hanging network call cannot starve the other's whole timeout budget.
_CI_FAILURE_CONCLUSIONS = ("failure", "timed_out", "startup_failure")
_CI_OK_CONCLUSIONS = ("success", "skipped", "neutral")


def resolve_main_sha():
    rc, out, _ = git(["rev-parse", MAIN_REF])
    if rc != 0:
        return None
    return out.strip()


main_sha = safe(resolve_main_sha)

_npm_argv = shlex.split(os.environ["PULSE_NPM_CMD"]) if os.environ.get("PULSE_NPM_CMD") else [
    "npm", "view", "loki-mode", "time", "dist-tags", "--json",
]
_gh_argv = None
if main_sha is not None:
    if os.environ.get("PULSE_GH_CMD"):
        _gh_argv = shlex.split(os.environ["PULSE_GH_CMD"])
    else:
        _gh_argv = [
            # No --branch: under D44 a promoted commit's Tier B ran on train/N
            # (headBranch train/N), so a main-only filter would hide it.
            "gh", "run", "list", "--commit", main_sha, "--event", "push",
            "--json", "status,conclusion,workflowName,event,updatedAt", "--limit", "20",
        ]

_gh_streak_argv = shlex.split(os.environ["PULSE_GH_STREAK_CMD"]) if os.environ.get("PULSE_GH_STREAK_CMD") else [
    "gh", "run", "list", "--branch", MAIN_REF, "--workflow", "Tests",
    "--json", "status,conclusion", "--limit", "10",
]

# E-75: a second, narrower gh call for when the main-CI lookup above (multi
# -workflow, --json status,conclusion,workflowName) comes back inconclusive
# -- gh itself failed/timed out, OR it succeeded but returned nothing
# clean-red/clean-green (e.g. a cancelled-only run set). That read as a bare
# UNKNOWN for 3 consecutive pushes while Tests was actually red (see
# docs/v10/PROGRESS.md). This rescues those two cases -- a bad/ambiguous
# primary read -- not whatever upstream condition made the primary call
# itself fail or time out in the first place. Scoped to just the Tests
# workflow at this exact commit so a same-shaped-but-different call has a
# real chance of resolving what the first one could not. Always started
# alongside the others (same reasoning as _gh_streak_proc: cheap, and only
# consulted if actually needed) so it never costs a second sequential
# network round trip, and shares the same NETWORK_DEADLINE and SHA-keyed
# cache/refresh path as the primary -- a shared-cause failure (e.g. gh
# itself unreachable) takes both down together, by design.
_gh_fallback_argv = None
if main_sha is not None:
    if os.environ.get("PULSE_GH_FALLBACK_CMD"):
        _gh_fallback_argv = shlex.split(os.environ["PULSE_GH_FALLBACK_CMD"])
    else:
        _gh_fallback_argv = [
            "gh", "run", "list", "--commit", main_sha, "--workflow", "Tests",
            "--json", "conclusion,status,databaseId", "--limit", "5",
        ]

# Usage governor (D13/D39, G-02): local, not network, but on a host with a
# lot of session history it is FAR from instant -- measured ~125s wall clock
# scanning ~/.claude/projects on this repo's own real usage. It gets exactly
# npm/gh's cache/background-refresh treatment (S-104): the interactive pulse
# never calls it directly, only cache_read (below); a stale/missing cache
# starts the same detached spawn_refresh() background run as npm/gh. Its own
# finish_proc call below uses GOVERNOR_DEADLINE, not npm/gh's short
# NETWORK_DEADLINE -- that deadline only bounds the interactive hook's own
# network wait, and the governor is never awaited interactively, so it gets a
# realistic ceiling to actually finish inside the detached refresh run.
# ponytail: still a bounded cap, not unlimited -- a host slower than this
# ceiling reads UNKNOWN forever until the governor itself is optimized or
# scoped narrower; that is a real finding for G-01/usage-governor.py, not
# something this pulse check can paper over.
GOVERNOR_DEADLINE_SECS = float(os.environ.get("PULSE_GOVERNOR_DEADLINE_SECS", "45") or "45")
GOVERNOR_DEADLINE = T0 + GOVERNOR_DEADLINE_SECS
_governor_argv = shlex.split(os.environ["PULSE_GOVERNOR_CMD"]) if os.environ.get("PULSE_GOVERNOR_CMD") else [
    sys.executable, os.path.join(REPO_ROOT, "scripts", "usage-governor.py"), "--json", "--read-usage",
]


def run_network():
    """Start npm + all gh calls concurrently, finish them against the one
    shared NETWORK_DEADLINE. Returns {name: (rc, out, err)}."""
    _npm_proc = safe(start_proc, _npm_argv, REPO_ROOT)
    # gh resolves its repo through git, so it must see the same scrubbed
    # environment as every direct git call -- a GIT_DIR inherited from the
    # eventual pre-push hook would misdirect gh's repo detection too.
    _gh_proc = safe(start_proc, _gh_argv, REPO_ROOT, _clean_env()) if _gh_argv is not None else None
    # Deliberately NOT gated on main_sha like _gh_argv above: CI_CANCELLED_STREAK
    # must still be able to run (and fire) even when the main-CI-status lookup
    # cannot resolve a SHA and reads UNKNOWN -- that independence is the whole
    # point of this check (see finding 3).
    _gh_streak_proc = safe(start_proc, _gh_streak_argv, REPO_ROOT, _clean_env())
    _gh_fallback_proc = (
        safe(start_proc, _gh_fallback_argv, REPO_ROOT, _clean_env())
        if _gh_fallback_argv is not None else None
    )
    _governor_proc = safe(start_proc, _governor_argv, REPO_ROOT)
    return {
        "npm": safe(finish_proc, _npm_proc, time_left(NETWORK_DEADLINE)) or (None, "", ""),
        "gh_ci": (
            safe(finish_proc, _gh_proc, time_left(NETWORK_DEADLINE)) or (None, "", "")
            if _gh_proc is not None else (None, "", "")
        ),
        "gh_streak": safe(finish_proc, _gh_streak_proc, time_left(NETWORK_DEADLINE)) or (None, "", ""),
        "gh_fallback": (
            safe(finish_proc, _gh_fallback_proc, time_left(NETWORK_DEADLINE)) or (None, "", "")
            if _gh_fallback_proc is not None else (None, "", "")
        ),
        # Its own deadline (GOVERNOR_DEADLINE), not NETWORK_DEADLINE -- see the
        # comment above run_network's definition.
        "governor": safe(finish_proc, _governor_proc, time_left(GOVERNOR_DEADLINE)) or (None, "", ""),
    }


def _cache_path(name):
    return os.path.join(CACHE_DIR, name + ".json")


def cache_read(name):
    """(record, age_seconds) or (None, None). Age is real wall-clock time,
    never PULSE_NOW (a fixture clock must not make a cache look fresh)."""
    try:
        with open(_cache_path(name), "r", encoding="utf-8") as f:
            rec = json.load(f)
        return rec, time.time() - float(rec["t"])
    except Exception:
        return None, None


def cache_write(name, result, sha=None):
    rc, out = result[0], result[1]
    # Only a successful call is cached: a failed/timed-out refresh leaves the
    # previous good value in place to age into STALE, never replaces it with
    # a failure (and never with a fabricated value).
    if rc != 0 or not out.strip():
        return
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = _cache_path(name) + ".%d.tmp" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"t": time.time(), "out": out, "sha": sha}, f)
    os.replace(tmp, _cache_path(name))


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def spawn_refresh():
    """Start ONE detached background refresh unless one is already running.
    refresh.pid is created O_EXCL (two concurrent prompts cannot both spawn)
    and holds the refresher's PID. A pid file older than 30s is dead by
    construction (a refresh is bounded by PULSE_DEADLINE_SECS plus git caps),
    which also covers PID reuse. Never waits on the child."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    pid_path = os.path.join(CACHE_DIR, "refresh.pid")
    fd = None
    for _ in range(2):
        try:
            fd = os.open(pid_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            break
        except FileExistsError:
            try:
                with open(pid_path, "r") as f:
                    pid = int(f.read().strip() or "0")
            except (OSError, ValueError):
                pid = 0
            try:
                age = time.time() - os.stat(pid_path).st_mtime
            except OSError:
                age = 0.0
            if age < 30 and (pid == 0 or _pid_alive(pid)):
                return "already running"
            try:
                os.unlink(pid_path)
            except OSError:
                pass
    if fd is None:
        return "not started (lock busy)"
    env = dict(os.environ)
    env["PULSE_REFRESH_ONLY"] = "1"
    try:
        child = subprocess.Popen(
            ["bash", os.environ["PULSE_SELF"]], env=env, cwd=REPO_ROOT,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True,
        )
    except (OSError, KeyError):
        os.close(fd)
        try:
            os.unlink(pid_path)
        except OSError:
            pass
        return "not started (spawn failed)"
    os.write(fd, ("%d\n" % child.pid).encode())
    os.close(fd)
    return "started"


net = {}           # name -> (rc, out, err)
cache_age = {}     # name -> age seconds of the cached value used, or None
refresh_state = None
if REFRESH_ONLY:
    # Background refresher: fetch, cache what succeeded, exit. No report.
    _res = run_network()
    safe(cache_write, "npm", _res["npm"])
    if _gh_argv is not None:
        safe(cache_write, "gh_ci", _res["gh_ci"], main_sha)
    safe(cache_write, "gh_streak", _res["gh_streak"])
    if _gh_fallback_argv is not None:
        safe(cache_write, "gh_fallback", _res["gh_fallback"], main_sha)
    safe(cache_write, "governor", _res["governor"])
    try:
        _pp = os.path.join(CACHE_DIR, "refresh.pid")
        with open(_pp, "r") as _f:
            if _f.read().strip() == str(os.getpid()):
                os.unlink(_pp)
    except (OSError, ValueError):
        pass
    sys.exit(0)
elif CACHE_MODE:
    _need_refresh = False
    for _name in ("npm", "gh_ci", "gh_streak", "gh_fallback", "governor"):
        _rec, _age = cache_read(_name)
        _usable = (
            _rec is not None and isinstance(_rec.get("out"), str)
            and -60 <= _age <= CACHE_MAX_AGE
            and (_name not in ("gh_ci", "gh_fallback")
                 or (main_sha is not None and _rec.get("sha") == main_sha))
        )
        if _usable:
            net[_name] = (0, _rec["out"], "")
            cache_age[_name] = max(0.0, _age)
            if _age > CACHE_TTL:
                _need_refresh = True
        else:
            net[_name] = (None, "", "CACHE_MISS")
            cache_age[_name] = None
            _need_refresh = True
    if _need_refresh:
        refresh_state = safe(spawn_refresh) or "not started (error)"
else:
    net = run_network()

stale_metrics = []


def cache_note(name, metric=None):
    """Suffix for a line built from a cached value: '' outside cache mode,
    '(cached Ns ago)' when fresh, '(STALE: cached Ns ago, ...)' past the TTL."""
    if not CACHE_MODE:
        return ""
    age = cache_age.get(name)
    if age is None:
        return " [no usable cached result; background refresh %s]" % (refresh_state or "not needed")
    if age <= CACHE_TTL:
        return " (cached %ds ago)" % age
    if metric:
        stale_metrics.append("%s (%ds)" % (metric, age))
    return " (STALE: cached %ds ago; background refresh %s)" % (age, refresh_state or "not needed")


_npm_rc, _npm_out, _npm_err = net["npm"]
_gh_rc, _gh_out, _gh_err = net["gh_ci"]
_gh_streak_rc, _gh_streak_out, _gh_streak_err = net["gh_streak"]
_gh_fallback_rc, _gh_fallback_out, _gh_fallback_err = net["gh_fallback"]
_governor_rc, _governor_out, _governor_err = net["governor"]


# --- 1. releases in the last 24h / minutes since last release -------------
def parse_npm_releases(rc, out):
    if rc != 0 or not out.strip():
        return None
    try:
        data = json.loads(out)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    # A-01: `npm view <pkg> time dist-tags --json` nests both; a bare time
    # map (older fixtures, cached output) has no "time" key.
    dist_tags = {}
    if isinstance(data.get("time"), dict):
        dist_tags = data.get("dist-tags") if isinstance(data.get("dist-tags"), dict) else {}
        data = data["time"]
    # 'created' and 'modified' are metadata, not releases; excluding them
    # matters because 'modified' updates on every publish including the
    # current one and would otherwise always read as "just released".
    stamps = []       # epoch seconds, every real version entry
    versioned = []     # (epoch, version key), for latest_version below
    for key, val in data.items():
        if key in ("created", "modified"):
            continue
        if not isinstance(val, str):
            continue
        t = parse_time_value(val)
        if t is None:
            # npm's own ISO8601 has seconds + fractional, always UTC ('Z'
            # suffix) -- calendar.timegm, not time.mktime()-time.timezone
            # (see parse_time_value's comment on the DST bug that caused).
            try:
                t = float(calendar.timegm(time.strptime(val[:19], "%Y-%m-%dT%H:%M:%S")))
            except ValueError:
                t = None
        if t is not None:
            stamps.append(t)
            versioned.append((t, key))
    if not stamps:
        return None
    stamps.sort()
    last = stamps[-1]
    count_24h = sum(1 for t in stamps if NOW - t <= 24 * 3600)
    count_1h = sum(1 for t in stamps if NOW - t <= 3600)
    # latest_version: the version key with the newest publish stamp (S-139 /
    # BACKLOG 136) -- read from this SAME `npm view ... time --json` result,
    # never a second `npm view ... dist-tags`/`version` call, to stay inside
    # S-104's shared network-cache budget. A tie on the stamp is broken by
    # the larger key string, deterministic but arbitrary; real npm publish
    # timestamps do not collide in practice.
    versioned.sort(key=lambda pair: (pair[0], pair[1]))
    latest_version = versioned[-1][1]
    return {
        "last_release_epoch": last,
        "count_24h": count_24h,
        "count_1h": count_1h,
        "latest_version": latest_version,
        # A-01: releases land on `next`; the newest publish is next unless
        # the registry says otherwise. `latest` moves only via promote.yml.
        "next_version": dist_tags.get("next") or latest_version,
        "promoted_version": dist_tags.get("latest"),
    }


npm_result = safe(parse_npm_releases, _npm_rc, _npm_out)
if npm_result is None:
    mark_unknown("releases_24h")
    mark_unknown("minutes_since_release")
    emit("Releases (last hour): UNKNOWN (npm check failed or timed out)%s" % cache_note("npm"))
    emit("Releases (24h): UNKNOWN (npm check failed or timed out)%s" % cache_note("npm"))
    emit("Minutes since last release: UNKNOWN")
else:
    mins_since = (NOW - npm_result["last_release_epoch"]) / 60.0
    _npm_note = cache_note("npm", "releases")
    emit("Releases (last hour): %d%s" % (npm_result["count_1h"], _npm_note))
    emit("Releases (24h): %d%s" % (npm_result["count_24h"], _npm_note))
    emit("Minutes since last release: %.1f%s" % (mins_since, _npm_note))
    emit("latest promoted: %s%s" % (npm_result.get("promoted_version") or "UNKNOWN", _npm_note))


# --- 2. main CI status for PULSE_MAIN_REF's head SHA -----------------------
# A run-completion status alone is not enough: 'cancelled' is routine here
# (a push during a release cancels its own Tests run -- see feedback in
# project memory) and must never read as red. A failure ANYWHERE in the run
# set wins over "still pending" -- a failed lint job sitting next to a still
# -running Tests job is a real CI_RED, not a "wait and see".
def parse_main_ci(rc, out):
    if rc != 0 or not out.strip():
        return None, None
    try:
        runs = json.loads(out)
    except (ValueError, TypeError):
        return None, None
    if not isinstance(runs, list) or not runs:
        return None, None
    parsed = [r for r in runs if isinstance(r, dict)]
    failing = [r.get("workflowName") or "unknown workflow" for r in parsed
               if r.get("conclusion") in _CI_FAILURE_CONCLUSIONS]
    if failing:
        return "red", failing
    if any(r.get("status") not in ("completed",) for r in parsed):
        return "pending", None
    if all(r.get("conclusion") in _CI_OK_CONCLUSIONS for r in parsed):
        return "green", None
    # Everything completed, nothing actually failed, but not cleanly all-ok
    # either (e.g. all cancelled/stale/action_required) -- not evidence of
    # red, and not evidence of green: report UNKNOWN rather than guess.
    return None, None


# E-75 fallback: same red-over-pending-over-green precedence as
# parse_main_ci above, but scoped to just the Tests workflow (the --workflow
# filter already did that) so it returns the run id (databaseId) that
# decided the verdict instead of a workflow name list. (None, None) on any
# failure -- the caller then has both lookups inconclusive and reports
# UNKNOWN, same as before this existed.
def parse_main_ci_fallback(rc, out):
    if rc != 0 or not out.strip():
        return None, None
    try:
        runs = json.loads(out)
    except (ValueError, TypeError):
        return None, None
    if not isinstance(runs, list) or not runs:
        return None, None
    parsed = [r for r in runs if isinstance(r, dict)]
    if not parsed:
        return None, None
    failing = [r for r in parsed if r.get("conclusion") in _CI_FAILURE_CONCLUSIONS]
    if failing:
        return "red", failing[0].get("databaseId")
    pending = [r for r in parsed if r.get("status") not in ("completed",)]
    if pending:
        return "pending", pending[0].get("databaseId")
    if all(r.get("conclusion") in _CI_OK_CONCLUSIONS for r in parsed):
        return "green", parsed[0].get("databaseId")
    return None, None


ci_status = None
if main_sha is None:
    mark_unknown("main_ci")
    emit("Main CI (%s): UNKNOWN (could not resolve %s SHA)" % (MAIN_REF, MAIN_REF))
else:
    _ci_parsed = safe(parse_main_ci, _gh_rc, _gh_out)
    ci_status, ci_failing_workflows = _ci_parsed if _ci_parsed is not None else (None, None)
    _ci_via_fallback = False
    _fallback_run_id = None
    if ci_status is None:
        _fb_parsed = safe(parse_main_ci_fallback, _gh_fallback_rc, _gh_fallback_out)
        _fb_status, _fallback_run_id = _fb_parsed if _fb_parsed is not None else (None, None)
        if _fb_status is not None:
            ci_status = _fb_status
            _ci_via_fallback = True
    if ci_status is None:
        mark_unknown("main_ci")
        emit("Main CI (%s @ %s): UNKNOWN (gh check failed, timed out, or inconclusive)%s"
             % (MAIN_REF, main_sha[:8], cache_note("gh_ci")))
    else:
        if _ci_via_fallback:
            _run_label = ("run %d" % _fallback_run_id) if isinstance(_fallback_run_id, int) else "unknown run"
            _ci_note = "%s [fallback: gh run list --commit %s --workflow Tests, %s]" % (
                cache_note("gh_fallback", "main_ci"), main_sha[:8], _run_label)
            _workflows_label = "Tests (fallback)"
        else:
            _ci_note = cache_note("gh_ci", "main_ci")
            _workflows_label = None
        emit("Main CI (%s @ %s): %s%s" % (MAIN_REF, main_sha[:8], ci_status.upper(), _ci_note))
        if ci_status == "red":
            workflows = _workflows_label or (
                ", ".join(sorted(set(ci_failing_workflows or []))) or "unknown workflow")
            add_violation("CI_RED", "main CI is RED at %s (%s)%s" % (main_sha[:8], workflows, _ci_note))


# --- 2b. CI_CANCELLED_STREAK: 3+ consecutive cancelled Tests runs on main ---
# Independent of the main-CI-status lookup above on purpose (see the
# _gh_streak_proc comment): a run of cancelled Tests runs is itself a signal
# worth flagging even when (especially when) the SHA-pinned CI status above
# cannot resolve and reads UNKNOWN. A push cancelling the previous run's
# Tests job is routine (see the CI_RED section's own comment on this), so a
# streak of them isn't automatically a real problem -- but 3+ in a row means
# nothing has finished checking main in a while, which the swarm should know.
_CANCELLED_STREAK_THRESHOLD = 3


def parse_ci_cancelled_streak(rc, out):
    """Count consecutive 'cancelled' conclusions from the most recent
    COMPLETED run backward. A still-running run at the head (status not
    'completed') is skipped before counting starts, not counted as a
    non-cancelled break -- every push cancels the PRIOR run's Tests job, so
    the newest run is normally in_progress/queued and would otherwise mask a
    real streak sitting right behind it. Returns None (UNKNOWN) if the call
    failed or produced no usable run list -- never a false 0."""
    if rc != 0 or not out.strip():
        return None
    try:
        runs = json.loads(out)
    except (ValueError, TypeError):
        return None
    if not isinstance(runs, list):
        return None
    parsed = [r for r in runs if isinstance(r, dict)]
    if not parsed:
        return None
    streak = 0
    seen_completed = False
    for r in parsed:
        if r.get("status") != "completed":
            if seen_completed:
                break
            continue
        seen_completed = True
        if r.get("conclusion") == "cancelled":
            streak += 1
        else:
            break
    if not seen_completed:
        return None
    return streak


ci_streak = safe(parse_ci_cancelled_streak, _gh_streak_rc, _gh_streak_out)
if ci_streak is None:
    mark_unknown("ci_cancelled_streak")
    emit("CI cancelled streak (Tests, %s): UNKNOWN (gh check failed, timed out, or no completed runs)%s"
         % (MAIN_REF, cache_note("gh_streak")))
else:
    _streak_note = cache_note("gh_streak", "ci_cancelled_streak")
    emit("CI cancelled streak (Tests, %s): %d consecutive%s" % (MAIN_REF, ci_streak, _streak_note))
    if ci_streak >= _CANCELLED_STREAK_THRESHOLD:
        add_violation(
            "CI_CANCELLED_STREAK",
            "%d consecutive cancelled Tests runs on %s (threshold %d)%s"
            % (ci_streak, MAIN_REF, _CANCELLED_STREAK_THRESHOLD, _streak_note),
        )


# --- 2c. OPUS_SHARE / BUDGET_BURN: usage governor (D13, D39; G-02) ----------
# Mirrors scripts/usage-governor.py's own WINDOW_PCT_CEILING/WEEKLY_PCT_CEILING
# (85%/90%, D39) rather than importing the module -- the pulse only ever
# reads the governor's --json output as an external data source, same as
# npm/gh above.
OPUS_SHARE_PCT_MAX = 30.0
WINDOW_PCT_CEILING = 85.0
WEEKLY_PCT_CEILING = 90.0


def parse_governor(rc, out):
    if rc != 0 or not out.strip():
        return None
    try:
        data = json.loads(out)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def compute_opus_share_pct(gov):
    """Opus's share of active-engineer (subagent/workflow-agent) output
    tokens in the last hour, as a percent, or None if there is no active-
    engineer burn to measure. Derived, not read directly: the governor JSON
    exposes a total burn and an opus-WEIGHTED burn per active engineer, not
    a raw opus-only figure. Since opus_weighted = total + opus*(weight-1),
    opus = (weighted - total) / (weight - 1) recovers the raw opus tokens.
    """
    g = gov.get("governor") or {}
    weight = (gov.get("calibration") or {}).get("opus_weight_assumption")
    active = g.get("active_engineers_last_hour")
    burn_out = g.get("burn_per_engineer_output_last_hour")
    burn_opus = g.get("burn_per_engineer_opus_weighted_last_hour")
    if not active or not weight or weight <= 1 or burn_out is None or burn_opus is None:
        return None
    total_out = burn_out * active
    if total_out <= 0:
        return None
    opus_out = (burn_opus * active - total_out) / (weight - 1)
    return 100.0 * opus_out / total_out


def project_pct(bucket, extra_tokens):
    """D39: 'projected 5-hour window usage at or below 85% at window end;
    weekly at or below 90% by the reset' -- projected, not merely current.
    Scales current_pct by the token growth current_tokens_output ->
    current_tokens_output + extra_tokens (extra_tokens being however many
    more tokens this window/weekly total is expected to carry: last hour's
    total burn for the window, that same rate sustained to the weekly reset
    for weekly). Falls back to the current percent unscaled when tokens or
    pct is missing/non-positive -- there is nothing to scale by."""
    tokens = bucket.get("current_tokens_output")
    pct = bucket.get("current_pct")
    if tokens is None or pct is None or tokens <= 0 or pct <= 0 or extra_tokens is None:
        return pct
    return pct * (tokens + extra_tokens) / tokens


governor_report = safe(parse_governor, _governor_rc, _governor_out)
if governor_report is None:
    mark_unknown("opus_share")
    mark_unknown("budget_burn")
    emit("Opus share (active engineers, last hour): UNKNOWN (usage governor check failed or timed out)%s"
         % cache_note("governor"))
    emit("Budget burn (5h window / weekly): UNKNOWN (usage governor check failed or timed out)")
else:
    _gov_note = cache_note("governor", "usage_governor")
    opus_share_pct = safe(compute_opus_share_pct, governor_report)
    if opus_share_pct is None:
        emit("Opus share (active engineers, last hour): n/a (no active-engineer burn)%s" % _gov_note)
    else:
        emit("Opus share (active engineers, last hour): %.1f%%%s" % (opus_share_pct, _gov_note))
        if opus_share_pct > OPUS_SHARE_PCT_MAX:
            add_violation(
                "OPUS_SHARE",
                "opus is %.1f%% of active-engineer output tokens in the last hour "
                "(budget %.0f%%, D13: opus is for planning/HIGH review only)"
                % (opus_share_pct, OPUS_SHARE_PCT_MAX),
            )

    _gov_window = governor_report.get("window") or {}
    _gov_weekly = governor_report.get("weekly") or {}
    if _gov_window.get("source") == "uncalibrated" and _gov_weekly.get("source") == "uncalibrated":
        mark_unknown("budget_burn")
        emit("Budget burn (5h window / weekly): UNKNOWN (usage governor uncalibrated)%s" % _gov_note)
    else:
        _gov_g = governor_report.get("governor") or {}
        _last_hour_out = _gov_g.get("last_hour_output_tokens")
        _hours_to_weekly_reset = _gov_g.get("hours_to_weekly_reset")
        _gov_measured = governor_report.get("measured") or {}
        _is_measured = _gov_g.get("cap_basis") == "measured"
        if _is_measured:
            # GOV-MEASURE: real /usage percentages, never scaled by a projection.
            window_pct = _gov_window.get("current_pct")
            weekly_pct = _gov_weekly.get("current_pct")
            _basis_note = " (measured, read %dm ago)" % (int(_gov_measured.get("age_secs") or 0) // 60)
        else:
            window_pct = project_pct(_gov_window, _last_hour_out)
            weekly_pct = project_pct(
                _gov_weekly,
                _last_hour_out * _hours_to_weekly_reset
                if _last_hour_out is not None and _hours_to_weekly_reset is not None else None,
            )
            if _gov_measured.get("status") == "failed":
                _basis_note = " (projected; /usage read failed: %s)" % (_gov_measured.get("reason") or "unknown")
            else:
                _basis_note = " (projected; /usage not read)"
        max_next = _gov_g.get("max_engineers_next_hour")
        active_engineers = _gov_g.get("active_engineers_last_hour")
        _burn_reasons = []
        if window_pct is not None and window_pct >= WINDOW_PCT_CEILING:
            _burn_reasons.append("5h window %s at %.1f%% (ceiling %.0f%%)" % ("measured" if _is_measured else "projected", window_pct, WINDOW_PCT_CEILING))
        if weekly_pct is not None and weekly_pct >= WEEKLY_PCT_CEILING:
            _burn_reasons.append("weekly window %s at %.1f%% (ceiling %.0f%%)" % ("measured" if _is_measured else "projected", weekly_pct, WEEKLY_PCT_CEILING))
        if max_next is not None and active_engineers is not None and max_next < active_engineers:
            _burn_reasons.append(
                "max engineers for next hour (%d) is below the %d currently active" % (max_next, active_engineers)
            )
        if _burn_reasons:
            add_violation("BUDGET_BURN", "; ".join(_burn_reasons) + " (D39)")
        emit(
            "Budget burn: 5h window %s %s, weekly %s %s, max engineers next hour %s%s%s"
            % (
                "used" if _is_measured else "projected",
                "%.1f%%" % window_pct if window_pct is not None else "uncalibrated",
                "used" if _is_measured else "projected",
                "%.1f%%" % weekly_pct if weekly_pct is not None else "uncalibrated",
                max_next if max_next is not None else "n/a",
                _basis_note,
                _gov_note,
            )
        )


# --- 3/4. BOARD.md status counts + review-pending age ----------------------
STATUS_TOKEN_RE = re.compile(
    r"^(ready|building|review|review-blocked|blocked|approved|merged|released|rejected|parked)"
    r"@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$"
)
# Any uppercase letter-run prefix, not a hardcoded whitelist (E-91): a fixed
# (GF|PF|S|E|EV|M) list meant every row using a prefix outside it (G-02,
# DEP-02..07) was silently invisible to parse_board -- never counted in
# "ready"/"building", never eligible for REVIEW_STALE/AGENT_OVER_BUDGET,
# never checked against LOW_READY. The optional trailing lowercase letter
# covers lettered sub-slices (E-98a..E-98f). A trailing digit run in the
# prefix (E-121: S41-01) is also allowed -- BOARD.md workstream ids are not
# always pure letters, and a prefix-only pattern left every S41 row equally
# invisible.
ID_RE = re.compile(r"^[A-Z]+[0-9]*-\d+[a-z]?$")
TIER_CELL_RE = re.compile(r"^(LOW|MEDIUM|HIGH)$")
# LOW_READY (E-79): a "ready" row can still name un-landed dependencies in
# its Notes cell ("Depends on M-07, E-31 merged or parked."; "Depends on
# none." means no deps). Only the ID-shaped tokens inside that clause are
# pulled out -- trailing prose ("merged or parked") is condition text this
# LOW-tier parse does not need to understand, not a second dependency. Case
# sensitive on purpose: BOARD.md's convention is always the capitalized
# "Depends on"; several older rows' Notes cells contain unrelated lowercase
# "depends on ... build then review." narrative prose from an earlier phase
# writeup, which a case-insensitive match would misread as a live gate.
# The clause ends at a lone "." (the sentence terminator). A range shorthand
# ("E-98a..c") also contains dots, so a bare `[^.]*` up to the first "."
# truncated the clause right after "E-98a" and lost everything past it. ".."
# is only ever a range separator (always followed by another id character),
# never the terminator, so it is let through; a genuine single "." is not.
DEPENDS_ON_RE = re.compile(r"Depends on ((?:[^.]|\.\.(?=[A-Za-z0-9]))*)\.")
DEPENDS_ON_ID_RE = re.compile(r"\b[A-Z]+[0-9]*-\d+[a-z]?\b")
# Range shorthand (E-117): "E-98a..e" or "M-20..M-23" or "M-20..23" names a
# contiguous run of sibling slices without spelling out each id. Expanded
# BEFORE DEPENDS_ON_ID_RE runs, so every id in the run is captured instead of
# just the first (letter ranges) or just the two endpoints (numeric ranges,
# dropping the ids between them). A malformed range (backwards direction,
# mismatched prefix) is left as-is in the clause text, so DEPENDS_ON_ID_RE
# still picks up whatever plain ids it contains -- never guessed at.
DEPENDS_ON_RANGE_RE = re.compile(
    r"\b([A-Z]+[0-9]*)-(\d+)([a-z])\.\.([a-z])\b"       # E-98a..e
    r"|\b([A-Z]+[0-9]*)-(\d+)\.\.(?:([A-Z]+[0-9]*)-)?(\d+)\b"  # M-20..M-23 / S41-01..S41-04
)


def _expand_depends_on_range(m):
    letter_prefix, letter_num, letter_start, letter_end, \
        num_prefix, num_start, num_end_prefix, num_end = m.groups()
    if letter_prefix is not None:
        if letter_start > letter_end:
            return m.group(0)
        return " ".join(
            "%s-%s%s" % (letter_prefix, letter_num, chr(c))
            for c in range(ord(letter_start), ord(letter_end) + 1)
        )
    if num_end_prefix is not None and num_end_prefix != num_prefix:
        return m.group(0)
    start, end = int(num_start), int(num_end)
    # Capped at 50 (Tech Lead REJECT on E-117): an unbounded numeric span
    # ("M-1..M-9999") would expand to thousands of ids, all landing in the
    # pulse block injected into every turn. A span over the cap is left as
    # literal text, same as the reversed-range fallback above.
    if start > end or (end - start + 1) > 50:
        return m.group(0)
    return " ".join("%s-%d" % (num_prefix, n) for n in range(start, end + 1))


def parse_depends_on(notes):
    """Returns the slice IDs named in a Notes cell's "Depends on ..."
    clause, or [] when there is no such clause (including "Depends on
    none.")."""
    m = DEPENDS_ON_RE.search(notes or "")
    if not m:
        return []
    clause = DEPENDS_ON_RANGE_RE.sub(_expand_depends_on_range, m.group(1))
    return DEPENDS_ON_ID_RE.findall(clause)


def parse_board(path):
    """Parse BOARD.md's pipe table rows. Cell position varies (some rows
    omit the Acceptance-checks column, and BOARD.md has used at least four
    different header layouts), so this finds the Status cell (and the Tier
    cell) by matching their normalized content rather than trusting a fixed
    column index. Notes is always the last cell in every layout this file
    has used, so it is read positionally."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    rows = []
    unparsed = []
    tiers = {}
    notes = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        row_id = cells[0]
        if not ID_RE.match(row_id):
            continue
        status_cell = None
        for cell in cells[1:]:
            m = STATUS_TOKEN_RE.match(cell)
            if m:
                status_cell = (m.group(1), m.group(2))
                break
        if status_cell is None:
            unparsed.append(row_id)
            continue
        rows.append((row_id, status_cell[0], status_cell[1]))
        notes[row_id] = cells[-1]
        for cell in cells[1:]:
            tm = TIER_CELL_RE.match(cell)
            if tm:
                tiers[row_id] = tm.group(1)
                break
    return {"rows": rows, "unparsed": unparsed, "tiers": tiers, "notes": notes}


board = safe(parse_board, BOARD_MD)
board_rows = []
if board is None:
    mark_unknown("board_counts")
    mark_unknown("review_pending_age")
    emit("BOARD.md: UNKNOWN (could not read %s)" % BOARD_MD)
else:
    board_rows = board["rows"]
    counts = {}
    ready_ids = []
    for row_id, token, _ts in board_rows:
        norm = "blocked" if token == "review-blocked" else token
        counts[norm] = counts.get(norm, 0) + 1
        if norm == "ready":
            ready_ids.append(row_id)
    order = ["ready", "building", "review", "blocked", "approved", "merged", "released"]
    emit("BOARD status counts: " + ", ".join(
        "%s=%d" % (tok, counts.get(tok, 0)) for tok in order
    ))
    other_tokens = sorted(set(counts) - set(order))
    if other_tokens:
        emit("BOARD other tokens: " + ", ".join(
            "%s=%d" % (tok, counts[tok]) for tok in other_tokens
        ))
    if board["unparsed"]:
        emit("BOARD unparsed rows (no status token found): " + ", ".join(board["unparsed"]))

    # LOW_READY dependency gate (E-79): a "ready" row whose Notes cell names
    # a dependency that has not itself reached merged/released is not
    # actually actionable yet, so it should not count toward the ready
    # queue -- otherwise the swarm reads a full ready queue while every
    # named engineer would immediately hit a real blocker. A dependency ID
    # not found on the board at all is treated as unmet (never assumed
    # done), same fail-safe default as every other UNKNOWN-leaning check in
    # this file.
    row_status = {row_id: token for row_id, token, _ts in board_rows}
    board_notes = board["notes"]
    ready_deps_met = []
    ready_blocked_by_deps = []
    for row_id in ready_ids:
        deps = parse_depends_on(board_notes.get(row_id, ""))
        unmet = [d for d in deps if row_status.get(d) not in ("merged", "released")]
        if unmet:
            ready_blocked_by_deps.append((row_id, unmet))
        else:
            ready_deps_met.append(row_id)
    emit(
        "Ready rows blocked by dependency: "
        + (", ".join("%s (needs %s)" % (rid, "/".join(unmet)) for rid, unmet in ready_blocked_by_deps) or "none")
    )

    # RELEASED_AHEAD_OF_NPM (S-139 / GUARDS 13 / BACKLOG 136): a `released@`
    # row stamped LATER than npm's own newest publish time claims a release
    # npm has no record of yet -- either it never actually reached npm, or
    # the row's token/timestamp is wrong. Reuses npm_result (metric 1's
    # already-cached/network npm read) rather than a second npm call, to
    # stay inside S-104's 5s budget.
    released_ahead = []
    released_ts_unknown = []
    if npm_result is not None:
        for row_id, token, ts in board_rows:
            if token != "released":
                continue
            t = parse_time_value(ts)
            if t is None:
                released_ts_unknown.append(row_id)
                continue
            if t > npm_result["last_release_epoch"]:
                released_ahead.append((row_id, t))
    if released_ts_unknown:
        mark_unknown("released_vs_npm")
        emit(
            "Released-vs-npm check: UNKNOWN for %s (no parseable Status timestamp on a released row)"
            % ", ".join(sorted(released_ts_unknown))
        )
    if released_ahead:
        released_ahead.sort(key=lambda pair: -pair[1])
        ids_desc = ", ".join(
            "%s (released@%s)" % (rid, time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(t)))
            for rid, t in released_ahead
        )
        add_violation(
            "RELEASED_AHEAD_OF_NPM",
            "%s marked released after npm's newest publish (%s); npm shows no publish that recent"
            % (ids_desc, time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(npm_result["last_release_epoch"]))),
        )

    # Every review-pending slice over the 45-minute budget, oldest first.
    stale_reviews = []
    all_reviews = []  # (row_id, age) for every parseable review-pending row
    ts_unknown_reviews = []  # row_id for a review-pending row with a bad timestamp
    for row_id, token, ts in board_rows:
        if token in ("review", "review-blocked"):
            t = parse_time_value(ts)
            if t is None:
                ts_unknown_reviews.append(row_id)
                continue
            age = (NOW - t) / 60.0
            all_reviews.append((row_id, age))
            if age > 45:
                stale_reviews.append((row_id, age))
    if all_reviews:
        oldest = max(all_reviews, key=lambda pair: pair[1])
        emit("Oldest review-pending slice: %s (%.1f min)" % (oldest[0], oldest[1]))
    else:
        emit("Oldest review-pending slice: none")
    if ts_unknown_reviews:
        mark_unknown("review_pending_age")
        emit(
            "Review-pending age: UNKNOWN for %s (no parseable Status timestamp on a review-pending row)"
            % ", ".join(sorted(ts_unknown_reviews))
        )
    if stale_reviews:
        stale_reviews.sort(key=lambda pair: -pair[1])
        ids_desc = ", ".join("%s (%.1f min)" % (rid, age) for rid, age in stale_reviews)
        add_violation(
            "REVIEW_STALE",
            "review-pending past 45 minutes: %s" % ids_desc,
        )

    # AGENT_OVER_BUDGET: founder-specified per-role agent time budgets
    # (D26 guard 3). "building" rows are a builder agent, "review" rows are
    # a reviewer agent; "review-blocked"/"blocked" rows have no agent
    # actively working them and are excluded, same as REVIEW_STALE's own
    # (review, review-blocked) scope one section up.
    #
    # Budget table (minutes), keyed by (role, tier):
    #   builder LOW=15, builder MEDIUM=30 -- founder-specified directly.
    #   reviewer LOW=30, reviewer MEDIUM=30 -- founder said "reviewer (any
    #     tier up to MEDIUM): 30 minutes", i.e. flat 30 regardless of
    #     LOW/MEDIUM, unlike the builder row which scales with tier.
    #   reviewer HIGH=60 -- "HIGH-tier adversarial reviewer: 60 minutes",
    #     founder-specified directly.
    #   builder HIGH -- NOT named by the founder. BOARD.md's own history
    #     has real HIGH-tier BUILD rows (GF-1..GF-5, PF-1/PF-2 are all
    #     HIGH-tier build slices, not reviews), so this is a real case, not
    #     a hypothetical needing no entry. ponytail: picked 60 (symmetry
    #     with the HIGH reviewer budget: HIGH-tier work is HIGH-tier work
    #     regardless of role) over a conservative 30, because these are
    #     exactly the security/GF-class slices that took the longest
    #     round-trips this session; 30 would false-fire on routine HIGH
    #     builder work. Flagged here and in the S-75 report as the one
    #     founder-underspecified budget in this table -- revisit if the
    #     founder gives an explicit number.
    _AGENT_BUDGET_MIN = {
        ("building", "LOW"): 15,
        ("building", "MEDIUM"): 30,
        ("building", "HIGH"): 60,
        ("review", "LOW"): 30,
        ("review", "MEDIUM"): 30,
        ("review", "HIGH"): 60,
    }
    # ponytail: this reads BOARD.md's own `building@`/`review@` cell, the
    # same source IDLE_BUILDERS' own comment warns "go stale between edits".
    # A slice actually finished/handed-off but left at a stale status token
    # will read as still running and can false-fire here; the fix is to
    # update the BOARD cell (already required practice), not to change this
    # check -- same tradeoff this file already accepts for REVIEW_STALE and
    # UNRELEASED_MERGE's board-derived reads.
    board_tiers = board.get("tiers", {})
    over_budget = []
    tier_unknown_active = []
    ts_unknown_active = []  # row_id for an active row with a bad Status timestamp
    active_checked = 0
    for row_id, token, ts in board_rows:
        if token not in ("building", "review"):
            continue
        t = parse_time_value(ts)
        if t is None:
            ts_unknown_active.append(row_id)
            continue
        active_checked += 1
        age = (NOW - t) / 60.0
        tier = board_tiers.get(row_id)
        if tier is None:
            tier_unknown_active.append(row_id)
            continue
        budget = _AGENT_BUDGET_MIN.get((token, tier))
        if budget is None:
            tier_unknown_active.append(row_id)
            continue
        if age > budget:
            over_budget.append((row_id, token, tier, age, budget))
    emit(
        "Agent budget: %d active (building/review) row(s) checked, %d over budget"
        % (active_checked, len(over_budget))
    )
    if ts_unknown_active:
        mark_unknown("agent_budget")
        emit(
            "Agent budget: UNKNOWN for %s (no parseable Status timestamp on an active row)"
            % ", ".join(sorted(ts_unknown_active))
        )
    if tier_unknown_active:
        mark_unknown("agent_budget")
        emit(
            "Agent budget: UNKNOWN for %s (no parseable Tier cell on an active row)"
            % ", ".join(sorted(tier_unknown_active))
        )
    if over_budget:
        over_budget.sort(key=lambda item: -item[3])
        ids_desc = ", ".join(
            "%s %s %s (%.1f min, budget %d min)" % (rid, role, tier, age, budget)
            for rid, role, tier, age, budget in over_budget
        )
        add_violation(
            "AGENT_OVER_BUDGET",
            "agent(s) past their role/tier time budget: %s" % ids_desc,
        )

    ready_count = len(ready_deps_met)
    if ready_count < 8:
        _low_ready_text = (
            "only %d ready slice(s) on BOARD (want at least 8); cut %d more"
            % (ready_count, 8 - ready_count)
        )
        if ready_blocked_by_deps:
            _low_ready_text += "; blocked by dependency: " + ", ".join(
                "%s (needs %s)" % (rid, "/".join(unmet)) for rid, unmet in ready_blocked_by_deps
            )
        add_violation("LOW_READY", _low_ready_text)

    # UNDERSTAFFED (founder 17:22Z, exact wording: "ready of 8 or more with
    # fewer than 8 building"): plenty of dependency-gated ready work (>= 8,
    # same floor LOW_READY already enforces) but fewer than 8 BOARD rows
    # are actually `building` is a dispatch failure distinct from
    # IDLE_BUILDERS -- IDLE_BUILDERS keys on real worktree activity (a
    # `building` cell can go stale between edits, per its own comment),
    # while this reads BOARD's own staffing count directly, so a BOARD
    # that claims plenty of builders while the ready queue still towers
    # over 8 is caught even if the worktree signal is itself UNKNOWN.
    # `review` deliberately does not count: a row under review is not
    # being built, and counting it as staffing would mask exactly the
    # ready-queue-vs-builders gap the founder is naming. Reuses
    # ready_deps_met (LOW_READY's own dependency-filtered ready set)
    # rather than a raw ready_ids scan, for the same reason IDLE_BUILDERS
    # does (E-79-81-r2): a dependency-blocked row is not actionable, so it
    # should never count as "ready work going unstaffed" either.
    _understaffed_ready = len(ready_deps_met)
    _understaffed_building = counts.get("building", 0)
    if _understaffed_ready >= 8 and _understaffed_building < 8:
        add_violation(
            "UNDERSTAFFED",
            "%d ready slice(s) on BOARD but only %d building (want at least 8 staffed)"
            % (_understaffed_ready, _understaffed_building),
        )


# --- 5. IDLE_BUILDERS: fewer than 6 active builder worktrees while ready ----
# active_worktrees is computed below (metric 6); this violation is added
# after that so it can key on real worktree activity rather than BOARD's
# `building` cells, which the swarm's own docs (BOARD.md's Status-format
# section) warn go stale between edits -- the same reason the unreleased-
# merge age cross-checks git instead of trusting a table cell.


# --- 4b. merged-but-unreleased age, cross-checked against git --------------
def check_unreleased_merge_age():
    # Pin to MAIN_REF explicitly: with no ref argument, `git describe` walks
    # from the CALLING PROCESS'S OWN HEAD, which is wrong whenever this script
    # runs from a builder worktree checked out somewhere other than main (the
    # documented, and intended, way to run it) -- see PULSE_MAIN_REF's header
    # comment. Reviewer-reproduced from a scratch checkout at an older tag.
    rc, out, _ = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", MAIN_REF])
    if rc != 0:
        return None
    tag = out.strip()
    # --first-parent: without it, this walks INTO a merged branch's own
    # history and finds commits' ORIGINAL authorship/commit timestamps, which
    # can be much older than when they actually landed on MAIN_REF via merge.
    # That produced a false UNRELEASED_MERGE positive on ordinary swarm
    # `merge:` commits whose source branch had older pre-merge commits.
    # --first-parent restricts the walk to MAIN_REF's own direct history, so
    # "oldest commit since the tag" reflects real merge order/time.
    rc, out, _ = git(["log", "--first-parent", "%s..%s" % (tag, MAIN_REF), "--format=%H %ct"])
    if rc != 0:
        return None
    commits = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            commits.append((parts[0], float(parts[1])))
    if not commits:
        return {"tag": tag, "unreleased_commits": 0, "oldest_age_min": None, "oldest_sha": None}
    oldest_sha, oldest_t = min(commits, key=lambda pair: pair[1])
    return {
        "tag": tag,
        "unreleased_commits": len(commits),
        "oldest_age_min": (NOW - oldest_t) / 60.0,
        "oldest_sha": oldest_sha,
    }


unreleased = safe(check_unreleased_merge_age)
# S-139 / BACKLOG 136: the "N commit(s) since <tag>" report below trusts
# `unreleased["tag"]` (the newest local v* tag) as ground truth for "what was
# last released". When npm's own latest published version (from the SAME
# npm_result computed above -- no second network call) disagrees with that
# tag, the tag is stale (a fetch is missing, or the release process tagged
# something npm never got), and "N commits since v9.54.2" is a confident
# answer built on a basis known to be wrong. Report UNKNOWN instead of
# either sub-case (0 or >0 unreleased commits) -- `unreleased` itself is left
# untouched so TRAIN_LATE (which only checks `unreleased is None`) is not
# affected by this npm-only cross-check.
_npm_tag_mismatch = None
if unreleased is not None and npm_result is not None:
    _local_tag_version = unreleased["tag"][1:] if unreleased["tag"].startswith("v") else unreleased["tag"]
    _npm_latest_version = npm_result.get("next_version")
    if _npm_latest_version is not None and _local_tag_version != _npm_latest_version:
        _npm_tag_mismatch = (unreleased["tag"], _npm_latest_version)

if unreleased is None:
    mark_unknown("unreleased_merge_age")
    emit("Merged-but-unreleased age: UNKNOWN (git tag/log check failed)")
elif _npm_tag_mismatch is not None:
    mark_unknown("unreleased_merge_age")
    emit(
        "Merged-but-unreleased age: UNKNOWN (local tag %s disagrees with npm next %s)"
        % _npm_tag_mismatch
    )
else:
    if unreleased["unreleased_commits"] == 0:
        emit("Merged-but-unreleased age: none (all commits released at %s)" % unreleased["tag"])
        merged_rows = [rid for rid, tok, _ in board_rows if tok == "merged"]
        if merged_rows:
            emit(
                "BOARD note: %s marked 'merged' but git shows nothing unreleased on %s since %s "
                "(stale BOARD cell, not treated as a violation)"
                % (", ".join(merged_rows), MAIN_REF, unreleased["tag"])
            )
    else:
        age = unreleased["oldest_age_min"]
        emit(
            "Merged-but-unreleased age: %.1f min (%d commit(s) since %s, oldest %s)"
            % (age, unreleased["unreleased_commits"], unreleased["tag"], unreleased["oldest_sha"][:8])
        )
        merged_rows = [rid for rid, tok, _ in board_rows if tok == "merged"]
        merged_desc = (", ".join(merged_rows) + " ") if merged_rows else ""
        if age > 30 and ci_status == "green":
            add_violation(
                "UNRELEASED_MERGE",
                "%s%d commit(s) merged but unreleased for %.1f minutes since %s (oldest %s) while CI is green"
                % (merged_desc, unreleased["unreleased_commits"], age, unreleased["tag"], unreleased["oldest_sha"][:8]),
            )
        # Independent of CI status (finding 2/3): a merge sitting unreleased
        # past 45 minutes is itself a violation regardless of what CI reads --
        # including UNKNOWN, which must never read as "safe, do nothing" the
        # way `ci_status == "green"` above silently did. This is a longer
        # budget than the CI-green case (30 min) precisely because it has no
        # green-CI corroboration; it must never fire twice for the same
        # window, so it is an elif against the same `age` check above.
        elif age > 45:
            add_violation(
                "UNRELEASED_MERGE",
                "%s%d commit(s) merged but unreleased for %.1f minutes since %s (oldest %s) (CI status: %s)"
                % (merged_desc, unreleased["unreleased_commits"], age, unreleased["tag"], unreleased["oldest_sha"][:8],
                   (ci_status or "unknown").upper()),
            )


# --- 4c. TRAIN_LATE: push cadence (D27 item 6) ------------------------------
# Fires only when the merged-but-unreleased computation above (`unreleased`)
# found real merged-but-unreleased commits AND the last train push is more
# than 25 minutes old. Reuses `unreleased` rather than re-deriving it, so
# this can never disagree with UNRELEASED_MERGE about whether anything is
# actually merged-but-unreleased.
#
# "Last train push time" is deliberately NEVER the release tag (a release
# can lag its push by minutes -- see NO_RECENT_RELEASE's own separate
# 90-minute budget for that). Source order:
#   1. PULSE_LAST_TRAIN_PUSH override (epoch seconds or ISO8601) -- same
#      override convention as PULSE_NOW/PULSE_SWARM_START, and what every
#      test below uses.
#   2. The reflog time of PULSE_TRAIN_PUSH_REF (default
#      refs/remotes/origin/main), read with `git reflog show`. This ref
#      moves on every plain `git push` to origin main -- how every train is
#      actually pushed -- and on a `git fetch` that brings in someone else's
#      push, with no network call of this script's own: reading an existing
#      local reflog is a local git operation like every other `git()` call
#      here, never a `git fetch`.
#   3. The mtime of the newest push-*.log file under PULSE_PUSH_LOG_DIR
#      (default ~/loki-ci-logs), for a repo with no such reflog (a fresh
#      clone, a shallow checkout, or a pruned reflog).
# With no source available, this reports UNKNOWN rather than silently not
# firing, matching every other metric in this script.
def last_train_push_epoch():
    override = parse_time_value(os.environ.get("PULSE_LAST_TRAIN_PUSH", ""))
    if override is not None:
        return override
    ref = os.environ.get("PULSE_TRAIN_PUSH_REF", "") or "refs/remotes/origin/main"
    rc, out, _ = git(["reflog", "show", "--date=unix", "--format=%gd", ref, "-n", "1"])
    if rc == 0:
        m = re.search(r"@\{(\d+)\}\s*$", out.strip())
        if m:
            return float(m.group(1))
    log_dir = os.environ.get("PULSE_PUSH_LOG_DIR", "") or os.path.expanduser("~/loki-ci-logs")
    try:
        names = os.listdir(log_dir)
    except OSError:
        return None
    best = None
    for name in names:
        if not (name.startswith("push-") and name.endswith(".log")):
            continue
        try:
            mt = os.stat(os.path.join(log_dir, name)).st_mtime
        except OSError:
            continue
        if best is None or mt > best:
            best = mt
    return best


_TRAIN_LATE_THRESHOLD_MIN = 25


def check_train_late():
    if unreleased is None:
        return None
    if unreleased["unreleased_commits"] == 0:
        return {"applicable": False}
    push_epoch = last_train_push_epoch()
    if push_epoch is None:
        return {"applicable": True, "unknown": True}
    return {"applicable": True, "unknown": False, "age_min": (NOW - push_epoch) / 60.0}


train_late = safe(check_train_late)
if train_late is None:
    # unreleased is itself UNKNOWN (already reported above) or this check
    # crashed -- either way, never silently skip without a trace.
    mark_unknown("train_late")
    emit("Train push cadence: UNKNOWN (could not evaluate merged-unreleased state)")
elif not train_late["applicable"]:
    emit("Train push cadence: n/a (no merged-but-unreleased commits)")
elif train_late["unknown"]:
    mark_unknown("train_late")
    emit(
        "Train push cadence: UNKNOWN (no PULSE_LAST_TRAIN_PUSH override, no reflog "
        "for %s, and no push-*.log under %s)"
        % (
            os.environ.get("PULSE_TRAIN_PUSH_REF", "") or "refs/remotes/origin/main",
            os.environ.get("PULSE_PUSH_LOG_DIR", "") or os.path.expanduser("~/loki-ci-logs"),
        )
    )
else:
    _tl_age = train_late["age_min"]
    emit("Minutes since last train push: %.1f" % _tl_age)
    if _tl_age > _TRAIN_LATE_THRESHOLD_MIN:
        add_violation(
            "TRAIN_LATE",
            "%.1f minutes since the last train push while merged-but-unreleased commits exist (threshold %d)"
            % (_tl_age, _TRAIN_LATE_THRESHOLD_MIN),
        )


# --- 4d. RELEASE_CADENCE: D37 fixed cadence (E-89) --------------------------
# D37: cut a release at :00/:20/:40 whenever main is green and at least one
# merged-unreleased slice commit exists; never let more than 25 minutes pass
# with both conditions true. Deliberately its own check rather than a
# TRAIN_LATE rename: TRAIN_LATE clocks from the last actual `git push` (a
# push-side signal, independent of CI), while RELEASE_CADENCE clocks from
# the merged work itself (a release-readiness signal) and, per D37's own
# text, requires CI green -- a red main with old merged commits is not a
# cadence violation, it is CI_RED's problem (already highest priority).
#
# Definition of "merged-unreleased slice commit": one entry per node on
# MAIN_REF's own --first-parent chain since the tag (same walk
# check_unreleased_merge_age above already uses, and for the same reason --
# without --first-parent this walks INTO a merged branch's own history and
# picks up a side commit's pre-merge authorship time, not when it actually
# landed on MAIN_REF; T47 reproduces the false-fire/false-n/a this caused).
# A slice lands via a merge commit in this repo's trains workflow (D25), so
# the merge commit itself IS the slice's landing event here, not a wrapper
# to skip. Docs-only commits (touching only docs/, *.md, .gitleaksignore)
# never count -- a docs commit sitting on main is not backlog pressure for
# a release. Changed paths are read via `git diff --name-only <sha>^1
# <sha>` (first-parent diff) rather than `git show --name-only`: for a
# merge commit, `git show` prints a combined diff that comes back EMPTY for
# a clean merge, which would silently misclassify a real (non-docs) slice
# merge -- see T47b. `^1` diff works identically for an ordinary
# non-merge commit (its only parent). Reuses `unreleased["tag"]` /
# `_npm_tag_mismatch` (same "newest v* tag whose version equals npm's
# next dist-tag" definition, same npm lookup, no second network call)
# and `ci_status` (same main-CI result, with its own Tests-run-list
# fallback already built in) rather than re-deriving either.
def _docs_only_path(path):
    return path.startswith("docs/") or path.endswith(".md") or path == ".gitleaksignore"


def check_release_cadence_d37():
    if unreleased is None or npm_result is None or _npm_tag_mismatch is not None:
        return None
    tag = unreleased["tag"]
    rc, out, _ = git(["log", "--first-parent", "--format=%H %ct", "%s..%s" % (tag, MAIN_REF)])
    if rc != 0:
        return None
    commits = []
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2:
            commits.append((parts[0], float(parts[1])))
    qualifying = []
    for sha, ct in commits:
        rc2, files_out, _ = git(["diff", "--name-only", "%s^1" % sha, sha])
        if rc2 != 0:
            return None
        paths = [p for p in files_out.splitlines() if p.strip()]
        if paths and all(_docs_only_path(p) for p in paths):
            continue
        qualifying.append((sha, ct))
    rc3, tag_out, _ = git(["log", "-1", "--format=%ct", tag])
    if rc3 != 0 or not tag_out.strip():
        return None
    return {"tag": tag, "tag_time": float(tag_out.strip()), "qualifying": qualifying}


_RELEASE_CADENCE_THRESHOLD_MIN = 25

release_cadence = safe(check_release_cadence_d37)
if release_cadence is None:
    mark_unknown("release_cadence")
    emit("Release cadence (D37): UNKNOWN (release tag or commit history could not be read)")
elif not release_cadence["qualifying"]:
    emit("Release cadence (D37): n/a (no merged-unreleased slice commits since %s)" % release_cadence["tag"])
else:
    _rc_count = len(release_cadence["qualifying"])
    _rc_oldest = min(ct for _, ct in release_cadence["qualifying"])
    _rc_basis = max(_rc_oldest, release_cadence["tag_time"])
    _rc_age = (NOW - _rc_basis) / 60.0
    emit(
        "Release cadence (D37): %.1f min, %d merged-unreleased slice commit(s) since %s"
        % (_rc_age, _rc_count, release_cadence["tag"])
    )
    if ci_status is None:
        mark_unknown("release_cadence")
        emit("Release cadence (D37): CI status UNKNOWN, cannot evaluate the D37 cadence gate")
    elif ci_status == "green" and _rc_age > _RELEASE_CADENCE_THRESHOLD_MIN:
        add_violation(
            "RELEASE_CADENCE",
            "%d merged-unreleased slice commit(s) since %s, %.1f minutes since the later of the oldest "
            "commit and the release tag while main CI is green (D37 threshold %d)"
            % (_rc_count, release_cadence["tag"], _rc_age, _RELEASE_CADENCE_THRESHOLD_MIN),
        )


# --- 4d2. D44 item 5: RELEASE_CADENCE (green-age) and MAIN_RED_BY_MERGE -------
# Both read the SAME cached gh_ci lookup (_gh_out) as CI_RED; no new gh call.
# Tier B = Tests, `push` event only. Time basis for
# "green for N minutes" is the RUN COMPLETION time (gh updatedAt, latest of
# the run), not the commit time: a commit can sit unbuilt for a while
# before it turns green, and the 20-minute clock is about how long a green,
# releasable commit has been waiting. Only the main HEAD is judged (the one
# commit this lookup covers); a fixture/run lacking `event`/`updatedAt` reads
# n/a, never fires. ponytail: head-only, a green non-head unreleased commit
# is not seen; add a per-commit gh lookup if trains stop fast-forwarding.
_TIER_B = ("Tests",)
_D44_GREEN_MIN = 20


def _tier_b_push_runs():
    try:
        runs = json.loads(_gh_out) if _gh_rc == 0 and _gh_out.strip() else []
    except (ValueError, TypeError):
        return None
    if not isinstance(runs, list):
        return None
    return [r for r in runs if isinstance(r, dict) and r.get("event") == "push"
            and r.get("workflowName") in _TIER_B]


def _head_version_only():
    rc, out, _ = git(["diff", "--name-only", "%s^1" % main_sha, main_sha])
    return rc == 0 and out.split() == ["VERSION"]


def check_d44():
    if main_sha is None or unreleased is None:
        return None
    runs = _tier_b_push_runs()
    if runs is None:
        return None
    return {"runs": runs, "version_only": _head_version_only()}


_d44 = safe(check_d44)
if _d44 is None or not _d44["runs"]:
    emit("D44 main push checks: n/a (no Tier B push runs for %s)" % (main_sha or MAIN_REF)[:8])
else:
    _d44_runs = _d44["runs"]
    _d44_failed = sorted(set(r["workflowName"] for r in _d44_runs if r.get("conclusion") in _CI_FAILURE_CONCLUSIONS))
    if _d44_failed and not _d44["version_only"]:
        add_violation(
            "MAIN_RED_BY_MERGE",
            "push to main %s failed Tier B: %s" % (main_sha[:8], ", ".join(_d44_failed)),
        )
    _d44_green = (
        {r["workflowName"] for r in _d44_runs if r.get("status") == "completed" and r.get("conclusion") in _CI_OK_CONCLUSIONS}
        >= set(_TIER_B)
    )
    _d44_done = [parse_time_value(r.get("updatedAt") or "") for r in _d44_runs]
    _rc2, _tag_sha, _ = git(["rev-parse", "%s^{commit}" % unreleased["tag"]])
    if _d44_green and None not in _d44_done and _rc2 == 0 and _tag_sha.strip() != main_sha:
        _d44_age = (NOW - max(_d44_done)) / 60.0
        emit("Green unreleased main %s: green for %.1f min since %s" % (main_sha[:8], _d44_age, unreleased["tag"]))
        if _d44_age > _D44_GREEN_MIN:
            add_violation(
                "RELEASE_CADENCE",
                "D44: green unreleased main commit %s has had green Tier B for %.1f minutes (by run completion time) and is newer than %s (D44 threshold %d)"
                % (main_sha[:8], _d44_age, unreleased["tag"], _D44_GREEN_MIN),
            )


# --- 4e. MERGED_NOT_RELEASED_STALE: a `merged` row already shipped (E-90) --
# A BOARD row stuck at `merged@` after its own merge commit already reached
# the latest published tag over-reports the backlog (the D37 "found at
# 16:20Z" incident this slice exists to stop recurring). This is narrower
# than the informational note inside check_unreleased_merge_age above (which
# only fires when NOTHING at all is unreleased since the tag): a single
# stale row can hide among other commits that are genuinely still
# unreleased, so each `merged` row's OWN merge commit is checked for
# ancestry independently. scripts/board-mark-released.sh carries its own
# copy of this same merge-commit lookup (no shared importable module between
# these two standalone bash-wrapped python programs, matching how this file
# already relates to every other scripts/*.sh here) so it can actually flip
# the row; this check only ever reports, never writes BOARD.md.
_MERGE_SHA_TOKEN_RE = re.compile(r"\b[0-9a-f]{7,40}\b")


def find_merge_commit_for_id(row_id):
    # -E + a trailing "not another digit" boundary: a plain substring grep
    # for "slice-S-1" also matches "slice-S-10", "slice-S-11", ... (BOARD ID
    # numbers are not fixed-width), which would silently resolve the WRONG
    # slice's merge commit. Pinned to MAIN_REF, not the caller's own HEAD,
    # for the same reason check_unreleased_merge_age's git describe is
    # above. `-n 1`: the grep-filtered walk stops at the first (newest)
    # match instead of scanning the rest of history uselessly. row_id comes
    # straight off a BOARD.md cell with no ID_RE filter here (this check
    # scans every row, not just the known ID shapes), so an odd ID can make
    # `-E`'s pattern itself invalid -- git then exits non-zero and this
    # raises rather than silently returning "no match" (see below: that
    # distinction is the whole point of raising here instead of just
    # returning None on any non-zero rc, which would let a git failure --
    # timeout, malformed pattern, anything -- read as "nothing to flag").
    rc, out, err = git(
        ["log", MAIN_REF, "--merges", "-n", "1", "--format=%H", "-E", "--grep", "slice-%s([^0-9]|$)" % row_id]
    )
    if rc != 0:
        raise RuntimeError("git log --merges failed for row %r: rc=%s: %s" % (row_id, rc, err.strip()))
    return out.strip() or None


def find_cited_merge_sha(row_text):
    for tok in _MERGE_SHA_TOKEN_RE.findall(row_text):
        # A non-zero rc here just means "not a real commit" (an all-digit
        # run ID is valid hex and legitimately fails to resolve) -- never
        # the kind of git-itself-broke signal find_merge_commit_for_id
        # raises on, so this keeps skipping rather than raising.
        rc, out, _ = git(["rev-list", "--parents", "-n", "1", tok])
        if rc != 0 or not out.strip():
            continue
        parts = out.strip().split()
        if len(parts) >= 3:  # commit sha followed by >=2 parent shas
            return parts[0]
    return None


def check_merged_not_released_stale():
    if unreleased is None or _npm_tag_mismatch is not None:
        return None
    tag = unreleased["tag"]
    try:
        with open(BOARD_MD, "r", encoding="utf-8") as f:
            board_text = f.read()
    except OSError:
        return None
    stale = []
    for line in board_text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) < 2:
            continue
        row_id = cells[0]
        status_token = None
        for cell in cells[1:]:
            m = STATUS_TOKEN_RE.match(cell)
            if m:
                status_token = m.group(1)
                break
        if status_token != "merged":
            continue
        merge_sha = find_merge_commit_for_id(row_id) or find_cited_merge_sha(line)
        if merge_sha is None:
            continue
        # Only rc 0 (is an ancestor) or rc 1 (is not) are real answers;
        # anything else (128: bad revision, a timeout under load, ...) is a
        # git failure, not "not an ancestor", and must not be swallowed the
        # same way -- same reasoning as find_merge_commit_for_id above.
        rc, _, err = git(["merge-base", "--is-ancestor", merge_sha, tag])
        if rc not in (0, 1):
            raise RuntimeError("git merge-base --is-ancestor failed for %s (%s): rc=%s: %s"
                                % (row_id, merge_sha, rc, err.strip()))
        if rc == 0:
            stale.append((row_id, merge_sha[:8]))
    return {"tag": tag, "stale": stale}


merged_stale = safe(check_merged_not_released_stale)
if merged_stale is None:
    mark_unknown("merged_not_released_stale")
    emit(
        "Merged rows already released (D37/E-90): UNKNOWN "
        "(release tag, %s, or a git lookup could not be read)" % BOARD_MD
    )
elif not merged_stale["stale"]:
    emit("Merged rows already released (D37/E-90): none")
else:
    _mns_names = ", ".join("%s (merge %s)" % (rid, sha) for rid, sha in merged_stale["stale"])
    emit("Merged rows already released (D37/E-90): %s" % _mns_names)
    add_violation(
        "MERGED_NOT_RELEASED_STALE",
        "%s marked 'merged' but its merge commit is already in %s (over-reports the backlog)"
        % (_mns_names, merged_stale["tag"]),
    )


# --- 5. moat proven count vs last release ----------------------------------
def list_pending_ids(text):
    ids = set()
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        ids.add(s.split()[0])
    return ids


def proven_properties(ids):
    """Set of property numbers (1..9) with zero pending ids -- i.e. proven,
    by the same "no pending case for this Pn" rule tests/moat/run.sh uses
    for its own PROVEN verdict, just without re-running the suite."""
    proven = set()
    for n in range(1, 10):
        prefix = "P%d." % n
        if not any(i.startswith(prefix) for i in ids):
            proven.add(n)
    return proven


# Sentinel distinct from None: moat_baseline_at_last_release returns this
# when the git calls themselves failed or timed out (UNKNOWN), as opposed to
# returning None when git affirmatively reports no matching tag exists (a
# real "no prior release", not a measurement failure). Conflating the two
# used to let a git timeout silently print "no prior release to compare"
# and disable MOAT_REGRESSION with no UNKNOWN ever recorded.
_BASELINE_UNKNOWN = object()


def moat_baseline_at_last_release():
    # Pin to MAIN_REF for the same reason as check_unreleased_merge_age: with
    # no ref argument, `git describe` follows the calling process's own HEAD,
    # not the swarm's actual main line, which flips the baseline count when
    # run from a builder worktree at an older tag/branch.
    rc, out, err = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", MAIN_REF])
    if rc != 0:
        no_tag = ("no names found" in err.lower()) or ("no tags can describe" in err.lower())
        return None if no_tag else _BASELINE_UNKNOWN
    tag = out.strip()
    rc2, out2, err2 = git(["show", "%s:tests/moat/pending.txt" % tag])
    if rc2 != 0:
        return _BASELINE_UNKNOWN
    return proven_properties(list_pending_ids(out2))


def moat_pending_count_at(ref):
    """Pending-derived proven count read via `git show REF:...`, never a raw
    working-tree file read -- the informational count must reflect
    PULSE_MAIN_REF, not whatever the calling process's own working tree
    happens to hold (finding 1 applies here too: a builder worktree's HEAD
    can be a feature branch checked out at a different commit than main)."""
    rc, out, _ = git(["show", "%s:tests/moat/pending.txt" % ref])
    if rc != 0:
        return None
    return len(proven_properties(list_pending_ids(out)))


# tests/moat/pending.txt's own documented invariant (see tests/moat/run.sh) is
# a ratchet: a property's failing-case IDs are removed once truly fixed, never
# added back, so the SET of pending ids can only shrink release over release.
# That means a "proven" count inferred purely from "zero pending ids for Pn"
# can only ever stay flat or INCREASE from an older ref to a newer one -- it
# is structurally unable to register a real regression, even while
# tests/moat/run.sh itself reports a live FAIL with an unlisted
# "REGRESSION: ... FAIL but not listed in tests/moat/pending.txt" line (a
# property can have zero pending.txt lines at BOTH the baseline tag and HEAD
# while its suite fails live in between -- verified on this repo: pulse's old
# pending-only heuristic read "3 of 9 proven" while `bash tests/moat/run.sh`
# reported "2 of 9 proven, FAIL (3 rule failures)" for the identical commit,
# because P7 has no pending.txt line at either ref).
#
# So MOAT_REGRESSION below never uses the pending-derived count as its source
# of truth -- only PULSE_MOAT_RESULT, which must point to a file holding the
# real captured stdout of a `tests/moat/run.sh` run (its own summary lines are
# parsed verbatim: "moat: N of 9 properties proven" and, when the suite
# failed, "moat suite: FAIL (K rule failure(s))"). Typical use (SHA captured
# BEFORE the run, see the header comment's BACKLOG 133 note on why):
#   git diff --quiet HEAD || exit 1
#   moat_sha="$(git rev-parse HEAD)"
#   bash tests/moat/run.sh > /path/to/moat-result.txt   # takes minutes
#   printf '%s\n' "$moat_sha" > /path/to/moat-result.txt.sha
#   PULSE_MOAT_RESULT=/path/to/moat-result.txt bash scripts/v10-pulse.sh
# Re-running the suite inside this script's own ~9s budget is not an option
# (the suite alone takes minutes), so when no result file is supplied, or it
# cannot be read, or its summary lines cannot be parsed, MOAT_REGRESSION is
# reported UNKNOWN rather than silently falling back to the pending-derived
# approximation as if it were a real measurement -- that fallback was the
# original bug. The pending-derived count is still shown, but only as
# informational context, explicitly labelled as not suite-verified, and it
# never feeds a violation.
#
# BACKLOG 133 (SHA pinning): a real, parseable PULSE_MOAT_RESULT is still not
# enough on its own -- nothing ties it to the commit it was measured against,
# so a stale capture from an earlier commit would read as clean today. The
# required sidecar "<PULSE_MOAT_RESULT>.sha" (see the header comment) must
# hold exactly the full SHA `tests/moat/run.sh` was measured at; this script
# compares it byte-for-byte against `git rev-parse MAIN_REF`'s current
# resolved HEAD (never re-resolved through git -- a ref name or short SHA in
# the sidecar simply fails the equality check rather than being trusted). A
# missing/empty sidecar or a mismatch both demote an otherwise-parseable
# result to UNKNOWN, deliberately fail-closed: a capture with no provenance,
# or provably stale provenance, must never register as a confident verdict.
_MOAT_COUNT_RE = re.compile(r"moat:\s*(\d+)\s*of\s*9\s*properties\s*proven", re.IGNORECASE)
_MOAT_FAIL_RE = re.compile(r"moat suite:\s*FAIL\s*\((\d+)\s*rule failure", re.IGNORECASE)
# tests/moat/run.sh's own terminal verdict lines (see its final echo calls):
# exactly one of these three appears on any run that reached a real verdict.
# Requiring one of them (not just the count line) guards against a truncated
# or could-not-check capture that happens to contain a "moat: N of 9" count
# substring from something else (e.g. a mid-run progress line) without ever
# reaching run.sh's actual conclusion.
_MOAT_VERDICT_RE = re.compile(
    r"moat suite:\s*(?:FAIL\s*\(\d+\s*rule failure|all 9 properties proven|no rule failed)",
    re.IGNORECASE,
)


def parse_moat_result(text):
    """Parse tests/moat/run.sh's own captured stdout. Returns
    {"count": int, "suite_failed": bool, "rule_failures": int or None} or
    None if the count line or a recognized terminal verdict line is missing
    (an unparseable, truncated, or unrelated file -- never guessed at)."""
    m = _MOAT_COUNT_RE.search(text)
    if not m or not _MOAT_VERDICT_RE.search(text):
        return None
    count = int(m.group(1))
    fm = _MOAT_FAIL_RE.search(text)
    return {
        "count": count,
        "suite_failed": fm is not None,
        "rule_failures": int(fm.group(1)) if fm else None,
    }


def check_moat_pending():
    """Informational-only pending-derived count at MAIN_REF (see the ratchet
    comment below check_unreleased_merge_age/moat_baseline_at_last_release):
    read via `git show`, never the raw working tree, for the same reason as
    finding 1 -- this script is meant to run from a builder worktree whose
    own HEAD can differ from MAIN_REF."""
    return moat_pending_count_at(MAIN_REF)


def check_moat_regression():
    """The only source of truth for MOAT_REGRESSION: PULSE_MOAT_RESULT. Kept
    entirely independent of check_moat_pending so a `git show`/pending-read
    failure never silently blanks this check (and vice versa) -- each is
    wrapped in its own safe() call below."""
    result_path = os.environ.get("PULSE_MOAT_RESULT", "")
    baseline = moat_baseline_at_last_release()
    baseline_unknown = baseline is _BASELINE_UNKNOWN
    baseline_set = None if baseline_unknown else baseline
    at_release = len(baseline_set) if baseline_set is not None else None

    measured = None
    measured_error = None
    if result_path:
        try:
            with open(result_path, "r", encoding="utf-8") as f:
                result_text = f.read()
        except OSError as exc:
            measured_error = "could not read PULSE_MOAT_RESULT file: %s" % exc
        else:
            measured = parse_moat_result(result_text)
            if measured is None:
                measured_error = (
                    "PULSE_MOAT_RESULT file did not contain a parseable 'moat: N of 9' "
                    "count line plus one of run.sh's terminal verdict lines"
                )
            else:
                # BACKLOG 133: a parseable result is not yet a TRUSTABLE one --
                # it must also prove it was measured against the commit this
                # pulse is reporting on. Sidecar path convention, see header.
                sha_path = result_path + ".sha"
                try:
                    with open(sha_path, "r", encoding="utf-8") as f:
                        measured_sha = f.read().strip()
                except OSError:
                    measured_sha = ""
                if not measured_sha:
                    measured = None
                    measured_error = (
                        "PULSE_MOAT_RESULT has no provenance: expected a sidecar file at "
                        "%s holding the SHA it was measured against (run "
                        "`git rev-parse HEAD > %s` BEFORE running the suite); a result with "
                        "no recorded SHA cannot be trusted to be current" % (sha_path, sha_path)
                    )
                elif main_sha is None:
                    measured = None
                    measured_error = (
                        "could not verify PULSE_MOAT_RESULT's provenance: %s's current HEAD "
                        "could not be resolved" % MAIN_REF
                    )
                elif measured_sha != main_sha:
                    measured = None
                    measured_error = (
                        "moat result is stale, measured against %s but %s is now at %s"
                        % (measured_sha[:8], MAIN_REF, main_sha[:8])
                    )

    return {
        "at_last_release": at_release,
        "baseline_unknown": baseline_unknown,
        "measured": measured,
        "measured_error": measured_error,
        "result_path": result_path,
    }


pending_count = safe(check_moat_pending)
if pending_count is None:
    mark_unknown("moat_proven")
    emit("Moat proven (pending-derived, informational, NOT suite-verified): UNKNOWN (git show against %s failed)" % MAIN_REF)
else:
    emit(
        "Moat proven (pending-derived, informational, NOT suite-verified): %d of 9"
        % pending_count
    )

regression = safe(check_moat_regression)
if regression is None:
    mark_unknown("moat_regression")
    emit("Moat regression check: UNKNOWN (could not evaluate PULSE_MOAT_RESULT or the baseline tag)")
else:
    if regression["baseline_unknown"]:
        mark_unknown("moat_baseline")

    if regression["measured"] is not None:
        m = regression["measured"]
        emit("Moat proven (measured, PULSE_MOAT_RESULT): %d of 9" % m["count"])
        if regression["at_last_release"] is not None:
            emit("Moat proven at last release (pending-derived baseline): %d of 9" % regression["at_last_release"])
        if m["suite_failed"]:
            add_violation(
                "MOAT_REGRESSION",
                "measured moat suite reports FAIL (%s rule failure(s)) -- a live suite failure is always a "
                "regression regardless of the proven count (see %s)"
                % (m["rule_failures"] if m["rule_failures"] is not None else "unknown", regression["result_path"]),
            )
        elif regression["at_last_release"] is not None and m["count"] < regression["at_last_release"]:
            add_violation(
                "MOAT_REGRESSION",
                "measured moat proven count dropped to %d of 9 (was %d of 9 pending-derived at last release)"
                % (m["count"], regression["at_last_release"]),
            )
    else:
        # No real measurement available. This is the load-bearing fix for
        # finding 3: never treat the pending-derived count as if it were a
        # measured result, and never let MOAT_REGRESSION silently read as
        # clean just because nothing was supplied -- route it through
        # UNKNOWN, per this script's own "never silently read as clean"
        # contract (see the header).
        mark_unknown("moat_regression")
        if regression["measured_error"]:
            emit("Moat regression check: UNKNOWN (%s)" % regression["measured_error"])
        else:
            emit(
                "Moat regression check: UNKNOWN (no PULSE_MOAT_RESULT supplied; capture "
                "`git rev-parse HEAD` BEFORE running `bash tests/moat/run.sh > FILE`, write it to "
                "FILE.sha, and pass PULSE_MOAT_RESULT=FILE for a real measurement)"
            )


# --- 6. live builder worktrees (mtime, no find walk) ------------------------
def check_worktrees():
    wt_cmd_raw = os.environ.get("PULSE_WORKTREE_CMD", "")
    argv = shlex.split(wt_cmd_raw) if wt_cmd_raw else ["git", "worktree", "list", "--porcelain"]
    if argv[0] == "git":
        rc, out, _ = run_capped(argv, cwd=REPO_ROOT, env=_clean_env())
    else:
        rc, out, _ = run_capped(argv, cwd=REPO_ROOT)
    if rc != 0:
        return None
    worktrees = []
    cur_path = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            cur_path = line[len("worktree "):].strip()
        elif line.strip() == "" and cur_path:
            worktrees.append(cur_path)
            cur_path = None
    if cur_path:
        worktrees.append(cur_path)
    if not worktrees:
        # Fall back to plain `git worktree list` output (path is column 1).
        for line in out.splitlines():
            parts = line.split()
            if parts:
                worktrees.append(parts[0])
    if not worktrees:
        return {"checked": 0, "active": 0}

    # git worktree list (both --porcelain and plain) always lists the
    # primary/main worktree first. Skip it by position, not by path
    # comparison against REPO_ROOT -- this script is meant to run FROM a
    # builder worktree, where REPO_ROOT (that worktree) is never the primary
    # one, so a path-equality exclusion would exclude nothing there.
    builder_worktrees = worktrees[1:]

    active = 0
    checked = 0
    for wt_path in builder_worktrees:
        git_marker = os.path.join(wt_path, ".git")
        gitdir = git_marker
        if os.path.isfile(git_marker):
            with open(git_marker, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if content.startswith("gitdir:"):
                gitdir = content.split(":", 1)[1].strip()
        if not os.path.isdir(gitdir):
            continue
        checked += 1
        # ponytail: mtime of the worktree's own .git-file/directory reflects
        # its CREATION time, not last activity -- that would read every
        # builder as idle. Use the freshest of the files git actually
        # rewrites on commit/checkout activity (index, HEAD, logs/HEAD)
        # instead of a find(1) walk, which would blow the 10s budget across
        # ~40 worktrees. Ceiling: a worktree with uncommitted-only edits (no
        # commit, no checkout) since these files last changed reads as idle
        # even if a builder is actively editing it.
        candidates = [gitdir, os.path.join(gitdir, "index"),
                      os.path.join(gitdir, "HEAD"), os.path.join(gitdir, "logs", "HEAD")]
        best = None
        for c in candidates:
            try:
                mt = os.stat(c).st_mtime
            except OSError:
                continue
            if best is None or mt > best:
                best = mt
        if best is not None and (NOW - best) <= 30 * 60:
            active += 1
    return {"checked": checked, "active": active}


worktrees = safe(check_worktrees)
if worktrees is None:
    mark_unknown("active_worktrees")
    emit("Active builder worktrees: UNKNOWN (git worktree list failed or timed out)")
else:
    emit(
        "Active builder worktrees (last 30 min): %d of %d checked"
        % (worktrees["active"], worktrees["checked"])
    )
    # IDLE_BUILDERS keys on real worktree activity, not BOARD's `building`
    # cells (which BOARD.md's own Status-format section warns can go stale
    # between edits) -- same reasoning as UNRELEASED_MERGE cross-checking
    # git instead of trusting a table cell. If the worktree check itself
    # came back UNKNOWN, this violation simply does not fire (never a false
    # positive from a metric we could not measure).
    if board is not None:
        # E-79-81-r2: reuse LOW_READY's dependency-filtered ready set
        # (ready_deps_met) instead of a raw board_rows scan, so a
        # dependency-blocked row (named by LOW_READY in the same run) is
        # never also named here as a dispatch target.
        idle_ready_count = len(ready_deps_met)
        if worktrees["active"] < 6 and idle_ready_count > 0:
            add_violation(
                "IDLE_BUILDERS",
                "only %d active builder worktree(s) while %d ready slice(s) exist on BOARD (%s)"
                % (worktrees["active"], idle_ready_count, ", ".join(ready_deps_met)),
            )


# --- 7. release cadence violations (needs npm_result) -----------------------
def swarm_start_epoch():
    override = parse_time_value(os.environ.get("PULSE_SWARM_START", ""))
    if override is not None:
        return override
    # Wave 0 (docs/v10/BOARD.md Wave log): "setup, 2026-09-26". A fixed
    # fallback, not derived from git history at runtime (SWARM.md's own add
    # commit is 2026-09-26T15:21:31Z UTC) -- this script never shells out
    # beyond what PULSE_MAIN_REF/PULSE_REPO_ROOT already cover, and a fixed
    # constant is simpler than adding another git call for one rarely-hit
    # fallback. Deliberately later than the real add time, so on the day this
    # fallback is reachable at all it stays on the side of suppressing the
    # 24h-volume check rather than false-firing it, matching the spec's
    # "suppress until 24h of swarm operation" intent.
    return parse_time_value("2026-09-26T23:59Z")


def check_release_cadence():
    if npm_result is None:
        return
    mins_since = (NOW - npm_result["last_release_epoch"]) / 60.0
    if mins_since > 90:
        add_violation(
            "NO_RECENT_RELEASE",
            "no release in the last 90 minutes (%.1f minutes since last release)%s" % (mins_since, cache_note("npm")),
        )
    start = swarm_start_epoch()
    hours_running = (NOW - start) / 3600.0 if start else 0
    if hours_running >= 24 and npm_result["count_24h"] < 30:
        add_violation(
            "LOW_RELEASE_VOLUME",
            "only %d release(s) in the last 24h (want at least 30) after %.1f hours of swarm operation%s"
            % (npm_result["count_24h"], hours_running, cache_note("npm")),
        )


safe(check_release_cadence)


# RELEASE_SLO (D46): 3-6 `next` releases per rolling hour. The npm `time`
# map cannot tell dist-tags apart per version, so this counts EVERY publish in
# the trailing 60 minutes; after D44 every release goes to `next`, so the two
# are the same. Unknown npm data never reaches here (npm_result is None and
# "Releases (last hour): UNKNOWN" is already emitted), so no false pass.
def check_release_slo():
    if npm_result is None:
        return
    n = npm_result["count_1h"]
    if n < 3:
        add_violation(
            "RELEASE_SLO",
            "%d next releases in the trailing 60 minutes (target 3-6, D46)%s" % (n, cache_note("npm")),
        )


safe(check_release_slo)


# --- 8. CONTROL.md line budget ----------------------------------------------
def check_control_md():
    with open(CONTROL_MD, "r", encoding="utf-8") as f:
        return sum(1 for _ in f)


control_lines = safe(check_control_md)
if control_lines is None:
    mark_unknown("control_md_lines")
    emit("CONTROL.md line count: UNKNOWN (could not read %s)" % CONTROL_MD)
else:
    emit("CONTROL.md line count: %d (budget: 40)" % control_lines)
    if control_lines > 40:
        add_violation(
            "CONTROL_OVERSIZE",
            "docs/v10/CONTROL.md is %d lines (budget is 40); trim %d line(s)"
            % (control_lines, control_lines - 40),
        )


# --- 8b. STALE_PROGRESS: PROGRESS.md update cadence -------------------------
# The newest "## <ISO timestamp>Z" heading in PROGRESS.md is the last time
# anyone recorded progress. Scans every such heading rather than trusting the
# LAST one in the file (a manual edit could append below an older heading, or
# reorder sections) and keeps the max epoch found. A file with no such
# heading at all, or one whose only headings fail the same calendar
# validation parse_time_value already enforces elsewhere in this script (Feb
# 30, hour 24, ...), returns None -- UNKNOWN, never a pass, matching every
# other metric's contract here.
_PROGRESS_HEADING_RE = re.compile(r"^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)\b")
_STALE_PROGRESS_BUDGET_MIN = 35


def newest_progress_entry(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    best = None  # (epoch, raw timestamp)
    for line in text.splitlines():
        m = _PROGRESS_HEADING_RE.match(line)
        if not m:
            continue
        t = parse_time_value(m.group(1))
        if t is None:
            continue
        if best is None or t > best[0]:
            best = (t, m.group(1))
    return best


progress_entry = safe(newest_progress_entry, PROGRESS_MD)
if progress_entry is None:
    mark_unknown("progress_last_entry")
    emit(
        "PROGRESS.md last entry: UNKNOWN (missing %s or no parseable '## <timestamp>Z' heading)"
        % PROGRESS_MD
    )
else:
    # Round to whole minutes BEFORE comparing against the budget, not after:
    # comparing the float age (e.g. 35.3) against an integer budget while
    # printing the rounded minute count would print "35 min ago (budget 35)"
    # on a violation that looks, from its own text, like it should not have
    # fired.
    _prog_age_min = int(round((NOW - progress_entry[0]) / 60.0))
    # E-80: a clock-skewed or hand-typed heading ahead of PULSE_NOW produced
    # a negative age ("PROGRESS.md last entry: -12 min ago"), which is
    # nonsensical and (since a negative age can never exceed the budget)
    # silently hid a real staleness signal behind a heading nobody should
    # trust. Report it by name and clamp the printed/compared age at 0
    # rather than either trusting the bogus future timestamp as fresh in
    # spirit or letting a negative number reach the violation text.
    if _prog_age_min < 0:
        emit(
            "PROGRESS.md last entry: FUTURE_TIMESTAMP (%s is %d min ahead of now)"
            % (progress_entry[1], -_prog_age_min)
        )
        _prog_age_min = 0
    emit("PROGRESS.md last entry: %d min ago" % _prog_age_min)
    if _prog_age_min > _STALE_PROGRESS_BUDGET_MIN:
        add_violation(
            "STALE_PROGRESS",
            "PROGRESS.md last updated %d min ago (budget %d)"
            % (_prog_age_min, _STALE_PROGRESS_BUDGET_MIN),
        )


# --- 9. UNEVIDENCED_CLAIM: D26 guard 4 (evidence-or-it-didn't-happen) -------
# Kept in its own function on purpose: a separate slice (S-94) adds its own
# check elsewhere in this same file, and each check owning one function
# means the two never touch the same lines.
#
# A claim word alone ("verified", "green", "fixed", "confirmed", "passes",
# "no fix needed") is not evidence -- D26 guard 4 requires a citation
# alongside it: a backticked command, an rc=/exit result, an N/N count, or a
# SHA. This scans ADDED lines only (the `+` side of a unified diff, never
# `+++`), over the last 20 commits on MAIN_REF touching docs/v10/BOARD.md or
# docs/v10/PROGRESS.md -- hardcoded relative paths, like
# moat_baseline_at_last_release's "tests/moat/pending.txt" above, since a
# `git log -- <path>` filter needs a path inside the repo, not whatever
# BOARD_MD/CONTROL_MD happen to be overridden to in a test.
_CLAIM_RE = re.compile(
    r"\b(verified|green|fixed|confirmed|passes|no[- ]fix[- ]needed)\b",
    re.IGNORECASE,
)
_EVIDENCE_TEST_WORD = r"(?:tests?|passing|passed|failing|failed|suite)"
_EVIDENCE_RE = re.compile(
    r"`[^`]+`"                                    # a backticked command
    r"|\brc\s*=\s*-?\d+\b"                        # rc=<n>
    r"|\bexit(?:\s*code)?\s*-?\d+\b"               # exit 0 / exit code 1
                                                    # (a bare "exit"/"exited"
                                                    # with no number is NOT
                                                    # evidence -- neither is
                                                    # a bare N/N: it matches a
                                                    # date like "9/27" just as
                                                    # well as a test count, so
                                                    # N/N only counts next to
                                                    # a test word below)
    r"|\b\d+\s+passed\b"                           # "N passed"
    r"|\b\d+\s*/\s*\d+\s+" + _EVIDENCE_TEST_WORD + r"\b"  # N/N tests|passing|...
    r"|\b" + _EVIDENCE_TEST_WORD + r"\s*:?\s*\d+\s*/\s*\d+\b"  # tests: N/N
    r"|\b[0-9a-f]{7,40}\b",                        # a SHA
    re.IGNORECASE,
)
_CLAIM_DOC_PATHS = ("docs/v10/BOARD.md", "docs/v10/PROGRESS.md")


def check_unevidenced_claims():
    """Scan the last 20 commits on MAIN_REF touching docs/v10/BOARD.md or
    docs/v10/PROGRESS.md for an added line making an evidence-word claim
    with no citation next to it. Returns {"checked": int, "flagged": [(sha,
    line), ...]}, or None if the git log call itself failed (never a false
    clean -- routed through UNKNOWN like every other check here)."""
    rc, out, _ = git(
        ["log", MAIN_REF, "-n", "20", "--format=%H", "--"] + list(_CLAIM_DOC_PATHS)
    )
    if rc != 0:
        return None
    shas = [s for s in out.splitlines() if s.strip()]
    # A line that was later edited (a citation added) or deleted (retracted)
    # no longer exists verbatim on MAIN_REF, so it is resolved and not flagged;
    # otherwise a fixed line would stay flagged until it aged out of the window.
    current = set()
    for path in _CLAIM_DOC_PATHS:
        crc, cout, _ = git(["show", "%s:%s" % (MAIN_REF, path)])
        if crc == 0:
            current.update(l.strip() for l in cout.splitlines())
    flagged = []
    for sha in shas:
        drc, dout, _ = git(["show", sha, "--"] + list(_CLAIM_DOC_PATHS))
        if drc != 0:
            continue
        for line in dout.splitlines():
            if not line.startswith("+") or line.startswith("+++"):
                continue
            added = line[1:]
            # A BOARD slice row's Wall-check cell is a spec ("... passes"), not
            # a claim; only its Notes cell can claim (E-91). Notes is always
            # the last cell regardless of column layout (parse_board's own
            # docstring: BOARD.md has used at least four), so this reads it
            # positionally the same way parse_board does, rather than
            # trusting a fixed column count.
            text = added
            stripped = added.strip()
            if stripped.startswith("|"):
                row_cells = [c.strip() for c in stripped.strip("|").split("|")]
                if row_cells and ID_RE.match(row_cells[0]):
                    text = row_cells[-1]
            if _CLAIM_RE.search(text) and not _EVIDENCE_RE.search(text):
                if current and added.strip() not in current:
                    continue
                flagged.append((sha[:8], added.strip()[:160]))
    return {"checked": len(shas), "flagged": flagged}


claims = safe(check_unevidenced_claims)
if claims is None:
    mark_unknown("unevidenced_claims")
    emit("Unevidenced-claim check: UNKNOWN (git log/show against %s failed)" % MAIN_REF)
else:
    emit(
        "Unevidenced-claim check: %d commit(s) scanned touching BOARD.md/PROGRESS.md, %d flagged line(s)"
        % (claims["checked"], len(claims["flagged"]))
    )
    if claims["flagged"]:
        shown = claims["flagged"][:5]
        desc = "; ".join("%s: %s" % (sha, text) for sha, text in shown)
        more = "" if len(claims["flagged"]) <= 5 else " (+%d more)" % (len(claims["flagged"]) - 5)
        add_violation(
            "UNEVIDENCED_CLAIM",
            "%d added line(s) in the last %d commit(s) touching BOARD.md/PROGRESS.md claim "
            "verified/green/fixed/confirmed/passes/no-fix-needed with no command, rc=/exit, "
            "N/N, or SHA citation: %s%s"
            % (len(claims["flagged"]), claims["checked"], desc, more),
        )


# --- 10. HIGH_LOAD: 1-min load average over 2x core count (D28 rule 3) ------
_LOAD_CORES = 14
_LOAD_DEFAULT_MAX = float(_LOAD_CORES * 2)  # 28


def read_loadavg():
    """1-minute load average as a float, or None. PULSE_LOADAVG overrides
    with a raw string (a bare number, or a full 'sysctl'/'/proc/loadavg'
    style line -- only the first number is used) so tests never depend on
    real machine load. Otherwise: `sysctl -n vm.loadavg` on macOS
    ('{ 1.20 3.40 5.60 }') or a direct read of /proc/loadavg on Linux
    ('1.20 3.40 5.60 3/456 789') -- the latter is a plain file, no subprocess
    needed."""
    override = os.environ.get("PULSE_LOADAVG", "")
    if override.strip():
        text = override
    elif sys.platform == "darwin":
        rc, out, _ = run_capped(["sysctl", "-n", "vm.loadavg"])
        if rc != 0:
            return None
        text = out
    else:
        try:
            with open("/proc/loadavg", "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            return None
    m = re.search(r"[\d.]+", text)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def check_high_load():
    load = read_loadavg()
    if load is None:
        return None
    max_load = float(os.environ.get("PULSE_LOAD_MAX", "") or _LOAD_DEFAULT_MAX)
    return {"load": load, "max": max_load}


high_load = safe(check_high_load)
if high_load is None:
    mark_unknown("high_load")
    emit("1-min load average: UNKNOWN (could not read vm.loadavg/proc.loadavg)")
else:
    emit("1-min load average: %.2f (max %.0f)" % (high_load["load"], high_load["max"]))
    if high_load["load"] > high_load["max"]:
        add_violation(
            "HIGH_LOAD",
            "1-minute load average %.2f is above the %.0f max (2x core count, D28)"
            % (high_load["load"], high_load["max"]),
        )


# --- 11. ORPHAN_TEST / ORPHAN_WORKTREE: an orphaned or long-running tests/*
# process, or a stuck worktree run.sh / loki-run tmp script (D28, E-00) ------
# E-00 incident: a `timeout 240 bash .../agent-<id>/autonomy/run.sh` process
# (with a generated /tmp/loki-run-*.sh child) ran over 24 hours. It ignored
# SIGTERM -- plain `timeout` never escalates to SIGKILL (see the timeout call
# sites fixed alongside this, all now `timeout -k 10 N`) -- and this check's
# own ORPHAN_TEST regex only ever matched tests/*.sh|py, never autonomy/run.sh
# or a worktree path, so the incident process was invisible here the entire
# time it ran ("Orphan test processes: 0"). ORPHAN_WORKTREE below is a second,
# independent match against the SAME ps listing, never a new process fetch.
_ORPHAN_TEST_RE = re.compile(r"tests/\S+\.(?:sh|py)\b")
_ORPHAN_MAX_MIN = 30.0
_ORPHAN_WORKTREE_RE = re.compile(r"\.claude/worktrees/|/tmp/loki-run-\S*\.sh\b")
_ORPHAN_WORKTREE_MAX_MIN = float(os.environ.get("PULSE_ORPHAN_WORKTREE_MAX_MIN", "30") or "30")


def parse_etime_minutes(etime):
    """ps etime shapes: 'SS', 'MM:SS', 'HH:MM:SS', 'DD-HH:MM:SS'. Returns
    minutes, or None if unparseable."""
    etime = etime.strip()
    m = re.match(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$", etime)
    if not m:
        return None
    days, hours, minutes, seconds = (int(x) if x else 0 for x in m.groups(default="0"))
    return days * 1440.0 + hours * 60.0 + minutes + seconds / 60.0


def read_ps_listing():
    """The shared `ps -eo pid,ppid,etime,command` text both orphan checks
    below scan -- one real `ps` call in production (matching this file's own
    S-109 comment on HIGH_LOAD/ORPHAN_TEST/STRAY_CONTAINER host-state
    isolation), one PULSE_PS_OUTPUT fixture in tests, so a test never has to
    fake the listing twice to cover both checks. None means the real call
    failed; every caller already treats None as UNKNOWN for its own metric."""
    override = os.environ.get("PULSE_PS_OUTPUT")
    if override is not None:
        return override
    rc, out, _ = run_capped(["ps", "-eo", "pid,ppid,etime,command"])
    if rc != 0:
        return None
    return out


def check_orphan_tests(ps_text):
    """Returns a list of (pid, etime, command) for a tests/*.sh or
    tests/*.py process that is either parentless (PPID 1) or has run past
    the 30-minute budget, or None if the process listing itself could not be
    read. Never kills anything -- reporting only."""
    if ps_text is None:
        return None
    orphans = []
    for line in ps_text.splitlines()[1:]:  # skip the ps header line
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, ppid, etime, command = parts
        if not _ORPHAN_TEST_RE.search(command):
            continue
        age_min = parse_etime_minutes(etime)
        if ppid == "1" or (age_min is not None and age_min > _ORPHAN_MAX_MIN):
            orphans.append((pid, etime, command.strip()))
    return orphans


_TEMP_ROOTS = tuple(os.path.realpath(r) for r in {os.environ.get("TMPDIR") or "/tmp", "/tmp", "/private/tmp"})


def _cwd_under_temp_root(pid):
    """True when process PID's working directory is under a temp root.
    PULSE_PROC_CWD_JSON (a JSON object pid -> cwd) replaces the real lookup in
    tests; otherwise `lsof -a -p PID -d cwd -Fn`. An unknown cwd counts as
    not-temp, so a live user run is never flagged on a failed lookup."""
    override = os.environ.get("PULSE_PROC_CWD_JSON")
    if override is not None:
        try:
            cwd = json.loads(override).get(str(pid))
        except Exception:
            cwd = None
    else:
        try:
            out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                                 capture_output=True, text=True, timeout=5).stdout
            cwd = next((l[1:] for l in out.splitlines() if l.startswith("n")), None)
        except Exception:
            cwd = None
    if not cwd:
        return False
    real = os.path.realpath(cwd)
    return any(real == r or real.startswith(r + os.sep) for r in _TEMP_ROOTS)


def check_orphan_worktree_procs(ps_text):
    """Returns a list of (pid, etime, command) for any process older than
    PULSE_ORPHAN_WORKTREE_MAX_MIN (default 30) whose command line references
    a .claude/worktrees/ path or a /tmp/loki-run-*.sh script -- the exact
    shape of the E-00 incident. Age-gated only, no PPID-1 rule: a worktree
    agent's run.sh is legitimately still attached to its launching parent for
    most of its life, unlike a stray test process, so parentlessness is not a
    useful signal here. Never kills anything -- reporting only."""
    if ps_text is None:
        return None
    hits = []
    for line in ps_text.splitlines()[1:]:  # skip the ps header line
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, _ppid, etime, command = parts
        if not _ORPHAN_WORKTREE_RE.search(command):
            continue
        # A backgrounded `loki start` also runs as /tmp/loki-run-*.sh (PPID 1,
        # long-lived) from the user's project checkout; only a copy whose cwd is
        # under the temp root (a test fixture repo) is an orphan candidate.
        if ".claude/worktrees/" not in command and not _cwd_under_temp_root(pid):
            continue
        age_min = parse_etime_minutes(etime)
        if age_min is not None and age_min > _ORPHAN_WORKTREE_MAX_MIN:
            hits.append((pid, etime, command.strip()))
    return hits


_ps_listing = safe(read_ps_listing)
orphan_tests = safe(check_orphan_tests, _ps_listing)
if orphan_tests is None:
    mark_unknown("orphan_tests")
    emit("Orphan test processes: UNKNOWN (ps check failed)")
else:
    emit("Orphan test processes: %d" % len(orphan_tests))
    for pid, etime, command in orphan_tests:
        add_violation(
            "ORPHAN_TEST",
            "pid %s etime %s: %s" % (pid, etime, command),
        )

orphan_worktree_procs = safe(check_orphan_worktree_procs, _ps_listing)
if orphan_worktree_procs is None:
    mark_unknown("orphan_worktree_procs")
    emit("Orphan worktree/run.sh processes: UNKNOWN (ps check failed)")
else:
    emit("Orphan worktree/run.sh processes: %d" % len(orphan_worktree_procs))
    for pid, etime, command in orphan_worktree_procs:
        add_violation(
            "ORPHAN_WORKTREE",
            "pid %s etime %s: %s" % (pid, etime, command),
        )


# --- 12. STRAY_CONTAINER: an old or misconfigured swarm container (D28) ----
_STRAY_NAME_PREFIXES = ("s1", "loki-", "kind-")
_STRAY_MAX_AGE_MIN = 60.0


def _parse_running_for_minutes(text):
    """docker ps's RunningFor column: '45 minutes ago', '3 hours ago',
    'About an hour ago', etc. Bucketed by unit -- good enough for a 1-hour
    threshold, never exact to the second."""
    text = text.strip().lower()
    if "about an hour" in text:
        return 60.0
    m = re.search(r"(\d+)\s*(second|minute|hour|day|week|month|year)s?", text)
    if not m:
        return None
    mult = {
        "second": 1 / 60.0, "minute": 1.0, "hour": 60.0, "day": 1440.0,
        "week": 10080.0, "month": 43200.0, "year": 525600.0,
    }[m.group(2)]
    return int(m.group(1)) * mult


def check_stray_containers():
    """Returns a list of (name, id, age_min, restart_policy) for a container
    that either matches the swarm naming/label convention and is older than
    1h, or matches it and carries a restart policy other than 'no' (any
    age) -- or [] with nothing to report. None only on a real check
    failure; docker simply not installed/not running is a quiet skip (this
    machine has no swarm containers to protect), never a violation or an
    UNKNOWN metric.

    PULSE_DOCKER_PS overrides the entire listing as tab-separated rows
    "id\\tname\\tage_minutes\\tlabel\\trestart_policy" -- one override
    covers both real subprocess calls below (docker ps for name/age/label,
    then one batched docker inspect for restart policy, since `docker ps`'s
    container-list API has no HostConfig field to read a restart policy
    from at all)."""
    override = os.environ.get("PULSE_DOCKER_PS")
    if override is not None:
        rows = []
        for line in override.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) != 5:
                continue
            cid, name, age_raw, label, policy = parts
            try:
                age = float(age_raw)
            except ValueError:
                age = None
            rows.append((cid, name, age, label, policy or None))
    else:
        rc, out, _ = run_capped([
            "docker", "ps", "-a", "--format",
            '{{.ID}}\t{{.Names}}\t{{.RunningFor}}\t{{.Label "loki.swarm"}}',
        ])
        if rc is None or rc != 0:
            # Not installed, daemon not running, or timed out: skip quietly.
            return []
        rows = []
        for line in out.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) != 4:
                continue
            cid, name, running_for, label = parts
            rows.append((cid, name, _parse_running_for_minutes(running_for), label, None))

    candidates = [
        r for r in rows
        if any(r[1].startswith(p) for p in _STRAY_NAME_PREFIXES) or r[3] == "1"
    ]
    if not candidates:
        return []

    if override is None:
        ids = [r[0] for r in candidates]
        rc, out, _ = run_capped(
            ["docker", "inspect", "--format", "{{.Id}}\t{{.HostConfig.RestartPolicy.Name}}"] + ids
        )
        policy_by_id = {}
        if rc == 0:
            for line in out.splitlines():
                parts = line.split("\t")
                if len(parts) == 2:
                    policy_by_id[parts[0]] = parts[1]
        candidates = [
            (cid, name, age, label, policy_by_id.get(cid, policy))
            for cid, name, age, label, policy in candidates
        ]

    fired = [
        (name, cid, age, policy)
        for cid, name, age, label, policy in candidates
        if (age is not None and age > _STRAY_MAX_AGE_MIN) or (policy and policy.lower() != "no")
    ]
    return fired


stray_containers = safe(check_stray_containers)
if stray_containers is None:
    mark_unknown("stray_containers")
    emit("Stray swarm containers: UNKNOWN (docker ps check failed)")
else:
    emit("Stray swarm containers: %d" % len(stray_containers))
    for name, cid, age, policy in stray_containers:
        reasons = []
        if age is not None and age > _STRAY_MAX_AGE_MIN:
            reasons.append("age %.0f min" % age)
        if policy and policy.lower() != "no":
            reasons.append("restart policy %s" % policy)
        add_violation(
            "STRAY_CONTAINER",
            "%s (%s): %s" % (name, cid[:12], ", ".join(reasons)),
        )


# --- 12b. WORKTREE_COUNT: too many worktrees under .claude/worktrees (S-94)
_WORKTREE_COUNT_MAX = 15
# WORKTREE_SPRAWL (AUTO-REAP, FC-91): the disk-exhaustion tier. 377 worktrees
# (56G) once filled the laptop volume; above this the reaper must run now.
_WORKTREE_SPRAWL_MAX = 20


def check_worktree_count():
    """Counts `git worktree list --porcelain` entries whose path is under
    .claude/worktrees (the swarm's per-agent worktree directory) -- unbounded
    growth there is a disk/inode risk, independent of the live-builder-
    activity worktree check above (metric 6, which counts ALL worktrees
    regardless of location, for IDLE_BUILDERS). PULSE_WORKTREE_LIST overrides
    with a raw porcelain listing (same text shape as PULSE_WORKTREE_CMD's
    default output), so tests never depend on this host's real worktree
    count. Returns None only on a real listing failure -- an empty/absent
    override still runs the real command below."""
    override = os.environ.get("PULSE_WORKTREE_LIST")
    if override is not None:
        text = override
    else:
        rc, out, _ = run_capped(
            ["git", "worktree", "list", "--porcelain"], cwd=REPO_ROOT, env=_clean_env()
        )
        if rc != 0:
            return None
        text = out
    count = 0
    for line in text.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):].strip()
            if "/.claude/worktrees/" in path:
                count += 1
    return count


worktree_count = safe(check_worktree_count)
if worktree_count is None:
    mark_unknown("worktree_count")
    emit("Worktrees under .claude/worktrees: UNKNOWN (git worktree list failed)")
else:
    emit(
        "Worktrees under .claude/worktrees: %d (max %d)"
        % (worktree_count, _WORKTREE_COUNT_MAX)
    )
    if worktree_count > _WORKTREE_COUNT_MAX:
        add_violation(
            "WORKTREE_COUNT",
            "%d worktrees under .claude/worktrees exceeds the %d max"
            % (worktree_count, _WORKTREE_COUNT_MAX),
        )
    if worktree_count > _WORKTREE_SPRAWL_MAX:
        add_violation(
            "WORKTREE_SPRAWL",
            "%d worktrees under .claude/worktrees exceeds the %d sprawl limit; "
            "run scripts/v10-worktree-reap.sh now (disk exhaustion risk)"
            % (worktree_count, _WORKTREE_SPRAWL_MAX),
        )


# --- 12c. STRAY_WORKTREE: a worktree registered inside the repo root but
# outside .claude/worktrees (E-81) ------------------------------------------
def check_stray_worktrees():
    """Reuses WORKTREE_COUNT's own PULSE_WORKTREE_LIST override (same raw
    porcelain-listing shape), rather than a second env var or git call.
    `git worktree list --porcelain` always reports the primary/main worktree
    first (same fact metric 6's own check_worktrees relies on), so it is
    skipped by position -- the repo root itself is never a stray entry. The
    "repo root" for containment is THAT primary path (paths[0]), never
    REPO_ROOT/PULSE_REPO_ROOT: this script is meant to run FROM a builder
    worktree (metric 4b's own comment on the same fact), where REPO_ROOT is
    that worktree's own path, not the primary one -- using it here would
    make a real stray, sitting right next to the actual repo root, compare
    against the wrong directory and never fire in the one place this check
    is meant to run. Returns None only on a real listing failure; an empty
    override (or a listing with no additional worktrees) is a real,
    reportable "0 stray"."""
    override = os.environ.get("PULSE_WORKTREE_LIST")
    if override is not None:
        text = override
    else:
        rc, out, _ = run_capped(
            ["git", "worktree", "list", "--porcelain"], cwd=REPO_ROOT, env=_clean_env()
        )
        if rc != 0:
            return None
        text = out
    paths = [line[len("worktree "):].strip() for line in text.splitlines()
              if line.startswith("worktree ")]
    if not paths:
        return []
    repo_root = os.path.normpath(paths[0])
    stray = []
    for path in paths[1:]:
        norm = os.path.normpath(path)
        inside_repo_root = norm == repo_root or norm.startswith(repo_root + os.sep)
        if inside_repo_root and "/.claude/worktrees/" not in path:
            stray.append(path)
    return stray


stray_worktrees = safe(check_stray_worktrees)
if stray_worktrees is None:
    mark_unknown("stray_worktrees")
    emit("Stray worktrees (inside repo root, outside .claude/worktrees): UNKNOWN (git worktree list failed)")
else:
    emit(
        "Stray worktrees (inside repo root, outside .claude/worktrees): %d"
        % len(stray_worktrees)
    )
    if stray_worktrees:
        add_violation(
            "STRAY_WORKTREE",
            "worktree(s) registered inside the repo root but outside .claude/worktrees: %s"
            % ", ".join(sorted(stray_worktrees)),
        )


# --- 13. RELEASE_ON_RED: the newest VERSION bump on main has red Tests -----
# (D28 rule 2 / S-108's own release-time guard; this is the pulse-side
# early-warning companion.) Reuses S-104's gh_ci cache -- keyed by the SHA
# it was fetched for -- rather than making its own network call: a fresh
# CI_RED check already paid for that call this pulse (or a recent one), and
# this only needs it when the VERSION-bump commit happens to be that same
# SHA. A different SHA (VERSION bumped, then more commits landed) means the
# cache cannot answer this question, so it reports UNKNOWN rather than a
# stale or wrong guess -- never a false clean.
_VERSION_SHA_UNKNOWN = object()  # the git call itself failed, distinct from
                                  # "it succeeded and VERSION has no history"


def resolve_version_bump_sha():
    rc, out, _ = git(["log", "-1", "--format=%H", MAIN_REF, "--", "VERSION"])
    if rc != 0:
        return _VERSION_SHA_UNKNOWN
    sha = out.strip()
    return sha or None  # None: no commit ever touched VERSION on this ref -- n/a, not unknown


def _tests_conclusion_from_runs(runs_json):
    """Parse a gh-run-list JSON array (status, conclusion, workflowName) and
    return the Tests workflow's conclusion for its most recent completed
    run, or None if no completed Tests run is present in the data."""
    try:
        runs = json.loads(runs_json)
    except (ValueError, TypeError):
        return None
    if not isinstance(runs, list):
        return None
    for run in runs:
        if not isinstance(run, dict):
            continue
        if run.get("workflowName") != "Tests" or run.get("status") != "completed":
            continue
        return run.get("conclusion")
    return None


def check_release_on_red():
    version_sha = safe(resolve_version_bump_sha)
    if version_sha is _VERSION_SHA_UNKNOWN:
        return None
    if version_sha is None:
        return {"sha": None, "conclusion": None, "na": True}
    override = os.environ.get("PULSE_RELEASE_TESTS")
    if override is not None:
        return {"sha": version_sha, "conclusion": _tests_conclusion_from_runs(override)}
    rec, _age = cache_read("gh_ci")
    if rec is None or rec.get("sha") != version_sha:
        return {"sha": version_sha, "conclusion": None}
    return {"sha": version_sha, "conclusion": _tests_conclusion_from_runs(rec.get("out", ""))}


release_on_red = safe(check_release_on_red)
if release_on_red is None:
    mark_unknown("release_on_red")
    emit("Release-on-red (newest VERSION bump on %s): UNKNOWN (could not resolve the VERSION-bump commit)" % MAIN_REF)
elif release_on_red.get("na"):
    emit("Release-on-red (newest VERSION bump on %s): n/a (no commit has ever touched VERSION)" % MAIN_REF)
elif release_on_red["conclusion"] is None:
    mark_unknown("release_on_red")
    emit(
        "Release-on-red (newest VERSION bump on %s, %s): UNKNOWN (no cached/overridden Tests result for that SHA)"
        % (MAIN_REF, release_on_red["sha"][:8])
    )
else:
    emit(
        "Release-on-red (newest VERSION bump on %s, %s): Tests %s"
        % (MAIN_REF, release_on_red["sha"][:8], release_on_red["conclusion"].upper())
    )
    if release_on_red["conclusion"] in ("failure", "cancelled"):
        add_violation(
            "RELEASE_ON_RED",
            "the newest VERSION-bump commit on %s (%s) has a %s Tests run"
            % (MAIN_REF, release_on_red["sha"][:8], release_on_red["conclusion"]),
        )


# --- 14. SESSION_STALLED: no assistant turn while the /loop is active ------
# Two independent signals, each overridable for tests (see the bash header):
#   "loop active"       -- PULSE_LOOP_MARKER (default
#                           $PULSE_REPO_ROOT/.loki/state/loop-active) exists
#                           and its mtime is under 24h old. Cheap: a stat
#                           call, no parsing of the timestamp text it holds.
#   "last assistant turn" -- the newest *.jsonl mtime under
#                           PULSE_TRANSCRIPT_DIR (default Claude Code's own
#                           ~/.claude/projects/<project-slug> session dir).
# The marker is checked first: with no fresh marker the loop is not
# considered active and this reports n/a without ever touching the
# transcript directory, so "no marker" can never itself read as UNKNOWN.
_SESSION_STALLED_BUDGET_MIN = 20
_LOOP_MARKER_MAX_AGE_HOURS = 24


def loop_marker_epoch():
    path = os.environ.get("PULSE_LOOP_MARKER") or os.path.join(REPO_ROOT, ".loki", "state", "loop-active")
    try:
        return os.stat(path).st_mtime
    except OSError:
        return None


def _main_repo_root():
    # Claude Code keys its transcript directory off the MAIN checkout, not
    # any subdirectory or linked worktree the shell happens to sit in.
    # `git rev-parse --git-common-dir` always resolves into the main repo's
    # .git, from a subdirectory or from a linked worktree alike; REPO_ROOT
    # is the fallback only if git cannot answer at all.
    rc, out, _ = git(["rev-parse", "--git-common-dir"])
    common_dir = out.strip() if rc == 0 else ""
    if not common_dir:
        return REPO_ROOT
    if not os.path.isabs(common_dir):
        common_dir = os.path.join(REPO_ROOT, common_dir)
    return os.path.dirname(os.path.realpath(common_dir))


def _default_transcript_dir():
    # Same sanitization rule as autonomy/context-tracker.py's
    # derive_project_slug: every non-alphanumeric character in the main
    # repo root's realpath becomes '-', prefixed with '-' for the leading
    # slash.
    slug = "-" + re.sub(r"[^a-zA-Z0-9]", "-", _main_repo_root().lstrip("/"))
    return os.path.join(os.path.expanduser("~"), ".claude", "projects", slug)


def newest_transcript_epoch(transcript_dir):
    try:
        names = os.listdir(transcript_dir)
    except OSError:
        return None
    best = None
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        try:
            mt = os.stat(os.path.join(transcript_dir, name)).st_mtime
        except OSError:
            continue
        if best is None or mt > best:
            best = mt
    return best


def check_session_stalled():
    marker_epoch = loop_marker_epoch()
    if marker_epoch is None or (NOW - marker_epoch) / 3600.0 >= _LOOP_MARKER_MAX_AGE_HOURS:
        return {"applicable": False}
    transcript_dir = os.environ.get("PULSE_TRANSCRIPT_DIR") or _default_transcript_dir()
    transcript_epoch = newest_transcript_epoch(transcript_dir)
    if transcript_epoch is None:
        return {"applicable": True, "unknown": True, "transcript_dir": transcript_dir}
    return {"applicable": True, "unknown": False, "stall_min": (NOW - transcript_epoch) / 60.0}


session_stalled = safe(check_session_stalled)
if session_stalled is None:
    mark_unknown("session_stalled")
    emit("Session stall (loop active check): UNKNOWN (could not evaluate loop marker/transcript state)")
elif not session_stalled["applicable"]:
    emit("Session stall: n/a (no fresh .loki/state/loop-active marker; /loop not active)")
elif session_stalled["unknown"]:
    mark_unknown("session_stalled")
    emit(
        "Session stall: UNKNOWN (could not read transcript dir %s)" % session_stalled["transcript_dir"]
    )
else:
    _stall_min = session_stalled["stall_min"]
    emit(
        "Minutes since last assistant turn: %.1f (loop active, budget %d)"
        % (_stall_min, _SESSION_STALLED_BUDGET_MIN)
    )
    if _stall_min > _SESSION_STALLED_BUDGET_MIN:
        add_violation(
            "SESSION_STALLED",
            "no assistant turn in %.1f minutes while the /loop is active (budget %d)"
            % (_stall_min, _SESSION_STALLED_BUDGET_MIN),
        )


_NEXT_ACTION_TEXT = {
    "SESSION_STALLED": "the /loop marker is fresh but no assistant turn has landed in over the budget; check the session is actually alive and resume it",
    "CI_RED": "investigate and fix the red main CI run before anything else",
    "CI_CANCELLED_STREAK": "investigate why Tests keeps getting cancelled on main before anything else",
    "RELEASE_ON_RED": "do not release from this VERSION-bump commit until its Tests run is green (D28 rule 2)",
    "HIGH_LOAD": "reduce load now: stop non-essential agents/containers, the machine is over 2x its core count (D28)",
    "BUDGET_BURN": "cut active engineers now, the plan's 5h/weekly usage window or its next-hour headroom is at the D39 ceiling",
    "OPUS_SHARE": "re-pin the named engineer(s) to sonnet, opus is over its D13 30% share of last-hour engineer output tokens",
    "MOAT_REGRESSION": "identify which moat property regressed and revert or fix it before any further merge",
    "UNRELEASED_MERGE": "cut a release now, main has been unreleased past the 30-minute budget",
    "RELEASE_CADENCE": "cut a release now (D37 cadence, or D44 green unreleased main commit)",
    "MAIN_RED_BY_MERGE": "main's latest push failed Tier B: fix forward or revert the named SHA before any further merge (D44)",
    "TRAIN_LATE": "push a release train now, merged-unreleased commits exist and cadence has slipped past the 25-minute budget",
    "REVIEW_STALE": "escalate or finish review for the named slice(s), they have exceeded the 45-minute budget",
    "AGENT_OVER_BUDGET": "check in on the named agent(s), they have exceeded their role/tier time budget",
    "STALE_PROGRESS": "append a PROGRESS.md entry: Part 1 gate numbers, Part 2 slices done, top blocker",
    "UNEVIDENCED_CLAIM": "add a command/output citation to the named line(s) or retract the claim (D26 guard 4)",
    "RELEASED_AHEAD_OF_NPM": "verify the named release(s) actually reached npm, or fix the BOARD row's status/timestamp",
    "ORPHAN_TEST": "investigate the named orphaned/long-running test process; stop by exact PID only if confirmed stale, never by name or pattern",
    "ORPHAN_WORKTREE": "investigate the named worktree/run.sh process; stop by exact PID only if confirmed stale, never by name or pattern",
    "STRAY_CONTAINER": "remove or fix the named swarm container: capped resources, restart policy 'no', removed when done (D28)",
    "STRAY_WORKTREE": "move the named worktree(s) under .claude/worktrees or remove them (git worktree remove)",
    "WORKTREE_COUNT": "prune stale worktrees under .claude/worktrees (git worktree remove), it is over the 15 max",
    "IDLE_BUILDERS": "dispatch more builders against the named ready slice(s) in docs/v10/BOARD.md",
    "UNDERSTAFFED": "staff more engineers now, the ready queue is deep and BOARD shows fewer than 8 rows building",
    "LOW_READY": "the Product Owner should cut the named number of additional slices onto the ready queue",
    "NO_RECENT_RELEASE": "cut a release now, none has shipped in over 90 minutes",
    "RELEASE_SLO": "cut releases now, fewer than 3 next releases shipped in the trailing 60 minutes (D46)",
    "LOW_RELEASE_VOLUME": "investigate why release throughput is below the 30/day target",
    "MERGED_NOT_RELEASED_STALE": "run scripts/board-mark-released.sh <tag> to flip the named row(s), their merge commit already shipped",
    "CONTROL_OVERSIZE": "trim docs/v10/CONTROL.md back under its 40-line budget",
}


# --- print status block ------------------------------------------------------
# Wrapped as the final safety net: everything above already routes crashes
# through safe() into an UNKNOWN metric, but if formatting itself somehow
# raises, this must still exit 2 (could-not-check), never exit 1 (a false
# VIOLATION) and never an uncaught traceback with exit code 1.
def render_and_exit():
    print("=== v10-pulse status (%s) ===" % time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(NOW)))
    for l in lines:
        print(l)

    if unknown_metrics:
        print("UNKNOWN metrics: " + ", ".join(sorted(set(unknown_metrics))))
    if stale_metrics:
        print("STALE metrics (cached value past %ds, shown with its age): %s"
              % (CACHE_TTL, ", ".join(stale_metrics)))

    print("")
    ordered = sorted_violations()
    if ordered:
        print("=== VIOLATIONS ===")
        for code, text in ordered:
            print("VIOLATION: %s: %s" % (code, text))
        print("")
        print("=== NEXT ACTIONS ===")
        for code, text in ordered:
            action = _NEXT_ACTION_TEXT.get(code, "address the violation above")
            print("NEXT ACTION: %s: %s -- %s" % (code, action, text))
        return 1

    if unknown_metrics:
        return 2
    return 0


try:
    sys.exit(render_and_exit())
except SystemExit:
    raise
except Exception as exc:
    print("PULSE ERROR: %s: %s" % (type(exc).__name__, exc))
    sys.exit(2)
PULSE_PY
