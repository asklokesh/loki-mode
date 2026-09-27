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
#   PULSE_NPM_CMD       npm command to run (default: npm view loki-mode time --json)
#   PULSE_GH_CMD        gh command to run (default: gh run list --branch main
#                       --commit <main-sha> --json status,conclusion,workflowName --limit 20)
#   PULSE_GH_STREAK_CMD gh command for the CI_CANCELLED_STREAK check (default:
#                       gh run list --branch main --workflow Tests --json
#                       status,conclusion --limit 10). Independent of
#                       PULSE_GH_CMD/main_sha on purpose -- it must still run
#                       (and be able to fire) even when the main-CI-status
#                       lookup above cannot resolve a SHA and reads UNKNOWN.
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
#                       mtime of the newest push-*.log file under
#                       PULSE_PUSH_LOG_DIR.
#   PULSE_PUSH_LOG_DIR  directory to look for push-*.log files in for the
#                       PULSE_LAST_TRAIN_PUSH fallback above (default:
#                       ~/loki-ci-logs, where scripts/v10-ops.sh push-main
#                       and the swarm's train-push tooling write their logs).
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
#                       WORKTREE_COUNT (a raw porcelain listing, same shape
#                       as PULSE_WORKTREE_CMD's default output).
#   PULSE_RELEASE_TESTS overrides the gh-run-list JSON RELEASE_ON_RED reads
#                       for the newest VERSION-bump commit's Tests conclusion
#                       (default: read from S-104's gh_ci cache).
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

export PULSE_REPO_ROOT BOARD_MD CONTROL_MD
export PULSE_MAIN_REF="${PULSE_MAIN_REF:-main}"
export PULSE_NPM_CMD="${PULSE_NPM_CMD:-}"
export PULSE_GH_CMD="${PULSE_GH_CMD:-}"
export PULSE_GH_STREAK_CMD="${PULSE_GH_STREAK_CMD:-}"
export PULSE_WORKTREE_CMD="${PULSE_WORKTREE_CMD:-}"
export PULSE_MOAT_RESULT="${PULSE_MOAT_RESULT:-}"
export PULSE_SWARM_START="${PULSE_SWARM_START:-}"
export PULSE_NOW="${PULSE_NOW:-}"
export PULSE_LAST_TRAIN_PUSH="${PULSE_LAST_TRAIN_PUSH:-}"
export PULSE_PUSH_LOG_DIR="${PULSE_PUSH_LOG_DIR:-}"
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
    and not any(os.environ.get(k) for k in ("PULSE_NPM_CMD", "PULSE_GH_CMD", "PULSE_GH_STREAK_CMD"))
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
    "CI_RED", "CI_CANCELLED_STREAK", "RELEASE_ON_RED", "HIGH_LOAD",
    "MOAT_REGRESSION", "UNRELEASED_MERGE", "TRAIN_LATE", "REVIEW_STALE",
    "AGENT_OVER_BUDGET", "UNEVIDENCED_CLAIM", "RELEASED_AHEAD_OF_NPM",
    "ORPHAN_TEST", "ORPHAN_WORKTREE", "STRAY_CONTAINER",
    "WORKTREE_COUNT", "IDLE_BUILDERS", "LOW_READY", "NO_RECENT_RELEASE",
    "LOW_RELEASE_VOLUME", "CONTROL_OVERSIZE",
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
    "npm", "view", "loki-mode", "time", "--json",
]
_gh_argv = None
if main_sha is not None:
    if os.environ.get("PULSE_GH_CMD"):
        _gh_argv = shlex.split(os.environ["PULSE_GH_CMD"])
    else:
        _gh_argv = [
            "gh", "run", "list", "--branch", MAIN_REF, "--commit", main_sha,
            "--json", "status,conclusion,workflowName", "--limit", "20",
        ]

_gh_streak_argv = shlex.split(os.environ["PULSE_GH_STREAK_CMD"]) if os.environ.get("PULSE_GH_STREAK_CMD") else [
    "gh", "run", "list", "--branch", MAIN_REF, "--workflow", "Tests",
    "--json", "status,conclusion", "--limit", "10",
]

def run_network():
    """Start npm + both gh calls concurrently, finish them against the one
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
    return {
        "npm": safe(finish_proc, _npm_proc, time_left(NETWORK_DEADLINE)) or (None, "", ""),
        "gh_ci": (
            safe(finish_proc, _gh_proc, time_left(NETWORK_DEADLINE)) or (None, "", "")
            if _gh_proc is not None else (None, "", "")
        ),
        "gh_streak": safe(finish_proc, _gh_streak_proc, time_left(NETWORK_DEADLINE)) or (None, "", ""),
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
    for _name in ("npm", "gh_ci", "gh_streak"):
        _rec, _age = cache_read(_name)
        _usable = (
            _rec is not None and isinstance(_rec.get("out"), str)
            and -60 <= _age <= CACHE_MAX_AGE
            and (_name != "gh_ci" or (main_sha is not None and _rec.get("sha") == main_sha))
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
        "latest_version": latest_version,
    }


npm_result = safe(parse_npm_releases, _npm_rc, _npm_out)
if npm_result is None:
    mark_unknown("releases_24h")
    mark_unknown("minutes_since_release")
    emit("Releases (24h): UNKNOWN (npm check failed or timed out)%s" % cache_note("npm"))
    emit("Minutes since last release: UNKNOWN")
else:
    mins_since = (NOW - npm_result["last_release_epoch"]) / 60.0
    _npm_note = cache_note("npm", "releases")
    emit("Releases (24h): %d%s" % (npm_result["count_24h"], _npm_note))
    emit("Minutes since last release: %.1f%s" % (mins_since, _npm_note))


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


ci_status = None
if main_sha is None:
    mark_unknown("main_ci")
    emit("Main CI (%s): UNKNOWN (could not resolve %s SHA)" % (MAIN_REF, MAIN_REF))
else:
    _ci_parsed = safe(parse_main_ci, _gh_rc, _gh_out)
    ci_status, ci_failing_workflows = _ci_parsed if _ci_parsed is not None else (None, None)
    if ci_status is None:
        mark_unknown("main_ci")
        emit("Main CI (%s @ %s): UNKNOWN (gh check failed, timed out, or inconclusive)%s"
             % (MAIN_REF, main_sha[:8], cache_note("gh_ci")))
    else:
        _ci_note = cache_note("gh_ci", "main_ci")
        emit("Main CI (%s @ %s): %s%s" % (MAIN_REF, main_sha[:8], ci_status.upper(), _ci_note))
        if ci_status == "red":
            workflows = ", ".join(sorted(set(ci_failing_workflows or []))) or "unknown workflow"
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


# --- 3/4. BOARD.md status counts + review-pending age ----------------------
STATUS_TOKEN_RE = re.compile(
    r"^(ready|building|review|review-blocked|blocked|approved|merged|released|rejected|parked)"
    r"@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)$"
)
ID_RE = re.compile(r"^(GF|PF|S|E)-\d+$")
TIER_CELL_RE = re.compile(r"^(LOW|MEDIUM|HIGH)$")


def parse_board(path):
    """Parse BOARD.md's pipe table rows. Cell position varies (some rows
    omit the Acceptance-checks column, and BOARD.md has used at least four
    different header layouts), so this finds the Status cell (and the Tier
    cell) by matching their normalized content rather than trusting a fixed
    column index."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    rows = []
    unparsed = []
    tiers = {}
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
        for cell in cells[1:]:
            tm = TIER_CELL_RE.match(cell)
            if tm:
                tiers[row_id] = tm.group(1)
                break
    return {"rows": rows, "unparsed": unparsed, "tiers": tiers}


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

    ready_count = counts.get("ready", 0)
    if ready_count < 8:
        add_violation(
            "LOW_READY",
            "only %d ready slice(s) on BOARD (want at least 8); cut %d more"
            % (ready_count, 8 - ready_count),
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
    _npm_latest_version = npm_result.get("latest_version")
    if _npm_latest_version is not None and _local_tag_version != _npm_latest_version:
        _npm_tag_mismatch = (unreleased["tag"], _npm_latest_version)

if unreleased is None:
    mark_unknown("unreleased_merge_age")
    emit("Merged-but-unreleased age: UNKNOWN (git tag/log check failed)")
elif _npm_tag_mismatch is not None:
    mark_unknown("unreleased_merge_age")
    emit(
        "Merged-but-unreleased age: UNKNOWN (local tag %s disagrees with npm's latest published version %s)"
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
#   2. The mtime of the newest push-*.log file under PULSE_PUSH_LOG_DIR
#      (default ~/loki-ci-logs). Simpler than resolving origin/main's real
#      committer time, which would need this script to run its own `git
#      fetch` -- a new, unbounded network call this script's fixed npm+gh
#      NETWORK_DEADLINE was never sized for (see its header comment).
# With neither source available, this reports UNKNOWN rather than silently
# not firing, matching every other metric in this script.
def last_train_push_epoch():
    override = parse_time_value(os.environ.get("PULSE_LAST_TRAIN_PUSH", ""))
    if override is not None:
        return override
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
        "Train push cadence: UNKNOWN (no PULSE_LAST_TRAIN_PUSH override and no "
        "push-*.log under %s)" % (os.environ.get("PULSE_PUSH_LOG_DIR", "") or os.path.expanduser("~/loki-ci-logs"))
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
        ready_count = sum(1 for _rid, tok, _ts in board_rows if tok == "ready")
        if worktrees["active"] < 6 and ready_count > 0:
            ready_ids = [rid for rid, tok, _ts in board_rows if tok == "ready"]
            add_violation(
                "IDLE_BUILDERS",
                "only %d active builder worktree(s) while %d ready slice(s) exist on BOARD (%s)"
                % (worktrees["active"], ready_count, ", ".join(ready_ids)),
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
            # a claim; only its status and notes cells (the last two) can claim.
            text = added
            cells = added.split("|")
            if added.startswith("| S-") and len(cells) >= 9:
                text = "|".join(cells[-3:-1])
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


_NEXT_ACTION_TEXT = {
    "CI_RED": "investigate and fix the red main CI run before anything else",
    "CI_CANCELLED_STREAK": "investigate why Tests keeps getting cancelled on main before anything else",
    "RELEASE_ON_RED": "do not release from this VERSION-bump commit until its Tests run is green (D28 rule 2)",
    "HIGH_LOAD": "reduce load now: stop non-essential agents/containers, the machine is over 2x its core count (D28)",
    "MOAT_REGRESSION": "identify which moat property regressed and revert or fix it before any further merge",
    "UNRELEASED_MERGE": "cut a release now, main has been unreleased past the 30-minute budget",
    "TRAIN_LATE": "push a release train now, merged-unreleased commits exist and cadence has slipped past the 25-minute budget",
    "REVIEW_STALE": "escalate or finish review for the named slice(s), they have exceeded the 45-minute budget",
    "AGENT_OVER_BUDGET": "check in on the named agent(s), they have exceeded their role/tier time budget",
    "UNEVIDENCED_CLAIM": "add a command/output citation to the named line(s) or retract the claim (D26 guard 4)",
    "RELEASED_AHEAD_OF_NPM": "verify the named release(s) actually reached npm, or fix the BOARD row's status/timestamp",
    "ORPHAN_TEST": "investigate the named orphaned/long-running test process; stop by exact PID only if confirmed stale, never by name or pattern",
    "ORPHAN_WORKTREE": "investigate the named worktree/run.sh process; stop by exact PID only if confirmed stale, never by name or pattern",
    "STRAY_CONTAINER": "remove or fix the named swarm container: capped resources, restart policy 'no', removed when done (D28)",
    "WORKTREE_COUNT": "prune stale worktrees under .claude/worktrees (git worktree remove), it is over the 15 max",
    "IDLE_BUILDERS": "dispatch more builders against the named ready slice(s) in docs/v10/BOARD.md",
    "LOW_READY": "the Product Owner should cut the named number of additional slices onto the ready queue",
    "NO_RECENT_RELEASE": "cut a release now, none has shipped in over 90 minutes",
    "LOW_RELEASE_VOLUME": "investigate why release throughput is below the 30/day target",
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
