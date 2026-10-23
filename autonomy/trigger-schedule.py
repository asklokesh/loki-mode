#!/usr/bin/env python3
"""
trigger-schedule.py - Schedule-based trigger daemon for loki-mode.

Reads .loki/triggers/schedules.json and runs loki commands on cron-like schedules.
Called periodically via `loki trigger daemon`.

Schedule entry format:
    {
        "name": "daily-quality-review",
        "cron_expr": "0 9 * * 1-5",
        "action": "quality-review",
        "args": [],
        "enabled": true,
        "last_run": null
    }

Supported actions:
    run <issue-ref>     - Run loki run on an issue/ref
    status              - Run loki status
    quality-review      - Run loki review
    seat <name>         - One headless tick of company seat <name>
                          (.claude/agents/<name>.md), see tick_seat()

Usage:
    python3 autonomy/trigger-schedule.py [--once] [--dry-run]
    python3 autonomy/trigger-schedule.py daemon [--loop]
    python3 autonomy/trigger-schedule.py tick <seat>
    python3 autonomy/trigger-schedule.py seed | install | uninstall
"""

import argparse
import json
import logging
import os
import plistlib
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


def get_loki_dir():
    """Return .loki/triggers directory, creating it if needed."""
    loki_dir = Path(".loki") / "triggers"
    loki_dir.mkdir(parents=True, exist_ok=True)
    return loki_dir


def load_schedules():
    """Load schedules from .loki/triggers/schedules.json."""
    schedules_path = get_loki_dir() / "schedules.json"
    if not schedules_path.exists():
        return []
    try:
        with open(schedules_path) as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        return data.get("schedules", [])
    except (json.JSONDecodeError, OSError) as e:
        logging.error("Failed to load schedules: %s", e)
        return []


def save_schedules(schedules):
    """Save schedules back to .loki/triggers/schedules.json."""
    schedules_path = get_loki_dir() / "schedules.json"
    with open(schedules_path, "w") as f:
        json.dump(schedules, f, indent=2)


def parse_cron_field(field, min_val, max_val):
    """
    Parse a single cron field.
    Returns a set of matching integers.
    Supports: * (any), N (exact), N-M (range), */N (step), N,M,... (list)
    """
    result = set()
    if field == "*":
        return set(range(min_val, max_val + 1))

    for part in field.split(","):
        part = part.strip()
        if "/" in part:
            range_part, step_str = part.split("/", 1)
            step = int(step_str)
            if range_part == "*":
                start, end = min_val, max_val
            elif "-" in range_part:
                s, e = range_part.split("-", 1)
                start, end = int(s), int(e)
            else:
                start = int(range_part)
                end = max_val
            result.update(range(start, end + 1, step))
        elif "-" in part:
            s, e = part.split("-", 1)
            result.update(range(int(s), int(e) + 1))
        else:
            result.add(int(part))

    return result


def cron_matches(cron_expr, dt):
    """
    Check if a datetime matches a cron expression.
    Format: minute hour day-of-month month day-of-week
    Day-of-week: 0=Sunday, 1=Monday, ..., 6=Saturday
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        raise ValueError("Invalid cron expression (expected 5 fields): %s" % cron_expr)

    minute_field, hour_field, dom_field, month_field, dow_field = parts

    minutes = parse_cron_field(minute_field, 0, 59)
    hours = parse_cron_field(hour_field, 0, 23)
    doms = parse_cron_field(dom_field, 1, 31)
    months = parse_cron_field(month_field, 1, 12)
    # Python weekday: 0=Monday, ..., 6=Sunday
    # Cron weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
    # Convert python weekday to cron dow
    python_dow = dt.weekday()  # 0=Mon
    cron_dow = (python_dow + 1) % 7  # 0=Sun, 1=Mon, ...
    dows = parse_cron_field(dow_field, 0, 6)

    return (
        dt.minute in minutes
        and dt.hour in hours
        and dt.day in doms
        and dt.month in months
        and cron_dow in dows
    )


def should_run(schedule, now):
    """
    Determine if a schedule should fire now.
    Compares current minute-resolution timestamp to last_run.
    """
    if not schedule.get("enabled", True):
        return False

    try:
        matches = cron_matches(schedule["cron_expr"], now)
    except (ValueError, KeyError) as e:
        logging.warning("Invalid cron for '%s': %s", schedule.get("name", "?"), e)
        return False

    if not matches:
        return False

    last_run = schedule.get("last_run")
    if last_run:
        try:
            # Check if we already ran this minute
            last_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
            if last_dt.year == now.year and last_dt.month == now.month and \
               last_dt.day == now.day and last_dt.hour == now.hour and \
               last_dt.minute == now.minute:
                return False
        except (ValueError, AttributeError):
            pass

    return True


def build_loki_args(schedule):
    """Build the loki CLI argument list from a schedule entry."""
    action = schedule.get("action", "")
    args = schedule.get("args", [])

    if action == "status":
        return ["status"]
    elif action == "quality-review":
        return ["review"] + list(args)
    elif action.startswith("run"):
        # action is "run" with args, or "run <issue-ref>"
        extra = list(args)
        if not extra and " " in action:
            # action = "run 123"
            parts = action.split(None, 1)
            extra = [parts[1]]
        return ["run"] + extra
    else:
        # Generic: split action and prepend
        return action.split() + list(args)


def build_seat_command(schedule):
    """argv that runs one seat tick in a detached child of this script."""
    seat = schedule.get("action", "").split(None, 1)[1].strip()
    return [sys.executable, os.path.abspath(__file__), "tick", seat]


def is_seat_action(schedule):
    return schedule.get("action", "").split(None, 1)[:1] == ["seat"] and \
        len(schedule.get("action", "").split()) == 2


def run_schedule(schedule, dry_run=False):
    """Execute a scheduled loki command."""
    if is_seat_action(schedule):
        cmd = build_seat_command(schedule)
    else:
        cmd = ["loki"] + build_loki_args(schedule)
    name = schedule.get("name", "unnamed")

    if dry_run:
        logging.info("[DRY-RUN] Schedule '%s' would run: %s", name, " ".join(cmd))
        return True

    logging.info("Schedule '%s' firing: %s", name, " ".join(cmd))
    try:
        extra = {"start_new_session": True} if is_seat_action(schedule) else {}
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL if extra else subprocess.PIPE,
            stderr=subprocess.DEVNULL if extra else subprocess.PIPE,
            **extra
        )
        logging.info("Schedule '%s' started pid=%d", name, proc.pid)
        return True
    except (FileNotFoundError, OSError) as e:
        logging.error("Schedule '%s' failed: %s", name, e)
        return False


# ---------------------------------------------------------------------------
# Company seats: always-on headless ticks of .claude/agents/<name>.md
# ---------------------------------------------------------------------------

SEAT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
LEADER_SEATS = ("chief-of-staff", "release-reliability-lead")
DEFAULT_MAX_LOAD = 28.0
DEFAULT_SEAT_TIMEOUT_SECS = 1200
GOVERNOR_CACHE_SECS = 300
LAUNCHAGENT_LABEL = "dev.autonomi.loki-company"

SEAT_TICK_PROMPT = (
    "Run one iteration of your standing loop from your agent file. "
    "Read the pulse (bash scripts/v10-pulse.sh) and docs/v10/BOARD.md. "
    "Act only within your decision rights. "
    "Write a short outcome to .loki/company/{seat}/last.json "
    "(fields: ts, seat, outcome, actions, evidence) and append one line to "
    ".loki/company/{seat}/log.jsonl. Then stop."
)


def company_root():
    return os.path.realpath(os.environ.get("LOKI_COMPANY_ROOT") or os.getcwd())


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _read_pid(path):
    """First run of digits on line 1 (the v10-leader / lock format), else None."""
    try:
        with open(path) as f:
            m = re.match(r"\s*(\d+)", f.readline())
    except OSError:
        return None
    return int(m.group(1)) if m else None


def acquire_seat_lock(lock_path):
    """Atomic per-seat lock holding our PID. Returns (ok, holder_pid)."""
    for _ in range(3):
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            holder = _read_pid(lock_path)
            if holder is not None and _pid_alive(holder):
                return False, holder
            try:
                os.unlink(lock_path)  # stale (dead or unreadable PID)
            except FileNotFoundError:
                pass
            continue
        with os.fdopen(fd, "w") as f:
            f.write("%d\n" % os.getpid())
        return True, os.getpid()
    return False, None


def governor_max_engineers():
    """max_engineers_next_hour from the usage governor, or None if unknown.

    Same source and key the pulse reads (scripts/usage-governor.py --json,
    report["governor"]["max_engineers_next_hour"]). Cached for a few minutes
    so ten seats do not each rescan the transcripts.
    """
    root = company_root()
    cache = os.path.join(root, ".loki", "company", "governor-cache.json")
    cmd_env = os.environ.get("LOKI_COMPANY_GOVERNOR_CMD") or os.environ.get("PULSE_GOVERNOR_CMD")
    if not cmd_env:
        cmd = [sys.executable, os.path.join(root, "scripts", "usage-governor.py"), "--json"]
        if not os.path.exists(cmd[1]):
            return None
    else:
        cmd = shlex.split(cmd_env)
    try:
        c = json.load(open(cache))
        if cmd_env is None and time.time() - c["at"] < GOVERNOR_CACHE_SECS:
            return c["max"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    try:
        out = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=90).stdout
        val = (json.loads(out).get("governor") or {}).get("max_engineers_next_hour")
    except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
        return None
    if not isinstance(val, int):
        return None
    if cmd_env is None:
        try:
            with open(cache, "w") as f:
                json.dump({"at": time.time(), "max": val}, f)
        except OSError:
            pass
    return val


def _append_log(seat_dir, seat, outcome, detail=""):
    entry = {"ts": _now_iso(), "seat": seat, "outcome": outcome}
    if detail:
        entry["detail"] = detail
    with open(os.path.join(seat_dir, "log.jsonl"), "a") as f:
        f.write(json.dumps(entry) + "\n")


def tick_seat(name):
    """Run one headless tick of seat `name`. Returns (status, detail).

    status is "ran", "skipped" or "error". Guards, in order: PAUSE file,
    1-min load average, live v10-leader (chief-of-staff and
    release-reliability-lead only), per-seat PID lock, usage governor.
    """
    root = company_root()
    if not SEAT_NAME_RE.match(name or "") or \
            not os.path.isfile(os.path.join(root, ".claude", "agents", name + ".md")):
        return "error", "unknown seat: %s" % name
    cdir = os.path.join(root, ".loki", "company")
    seat_dir = os.path.join(cdir, name)
    os.makedirs(seat_dir, exist_ok=True)

    def skip(why):
        _append_log(seat_dir, name, "skipped", why)
        return "skipped", why

    if os.path.exists(os.path.join(cdir, "PAUSE")):
        return skip("paused")
    max_load = float(os.environ.get("LOKI_COMPANY_MAX_LOAD") or DEFAULT_MAX_LOAD)
    load1 = os.getloadavg()[0]
    if load1 > max_load:
        return skip("load %.1f above %.1f" % (load1, max_load))
    if name in LEADER_SEATS:
        leader = _read_pid(os.path.join(root, ".loki", "v10-leader"))
        if leader is not None and leader != os.getpid() and _pid_alive(leader):
            return skip("live leader pid %d holds .loki/v10-leader" % leader)
    ok, holder = acquire_seat_lock(os.path.join(seat_dir, "lock"))
    if not ok:
        return skip("lock held by pid %s" % holder)
    try:
        if governor_max_engineers() == 0:
            return skip("governor max engineers is 0")
        return _run_claude_tick(root, name, seat_dir)
    finally:
        try:
            os.unlink(os.path.join(seat_dir, "lock"))
        except FileNotFoundError:
            pass


def _run_claude_tick(root, name, seat_dir):
    timeout = float(os.environ.get("LOKI_SEAT_TIMEOUT_SECS") or DEFAULT_SEAT_TIMEOUT_SECS)
    argv = [os.environ.get("LOKI_CLAUDE_BIN") or "claude", "-p", "--agent", name,
            "--dangerously-skip-permissions", "--output-format", "json",
            SEAT_TICK_PROMPT.format(seat=name)]
    last = os.path.join(seat_dir, "last.json")
    started = time.time()
    try:
        # Own session so a timeout can stop the tick's whole process group
        # (claude spawns children) by the group id we created, never by name.
        with open(os.path.join(seat_dir, "last.out"), "w") as out:
            proc = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL, stdout=out,
                                    stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as e:
        _append_log(seat_dir, name, "error", "cannot start claude: %s" % e)
        return "error", "cannot start claude: %s" % e
    outcome, detail = "ok", ""
    try:
        proc.wait(timeout=timeout)
        if proc.returncode != 0:
            outcome, detail = "error", "claude rc=%d" % proc.returncode
    except subprocess.TimeoutExpired:
        for sig, grace in ((signal.SIGTERM, 15), (signal.SIGKILL, 5)):
            try:
                os.killpg(proc.pid, sig)
                proc.wait(timeout=grace)
                break
            except (ProcessLookupError, PermissionError):
                break
            except subprocess.TimeoutExpired:
                continue
        outcome, detail = "timeout", "exceeded %ds" % int(timeout)
    fresh = os.path.exists(last) and os.path.getmtime(last) >= started - 1
    if outcome != "ok" or not fresh:
        if outcome == "ok":
            outcome, detail = "no-report", "seat did not write last.json"
        with open(last, "w") as f:
            json.dump({"ts": _now_iso(), "seat": name, "outcome": outcome,
                       "actions": [], "evidence": detail}, f)
        _append_log(seat_dir, name, outcome, detail)
    return "ran", ("%s: %s" % (outcome, detail) if detail else outcome)


def default_seat_schedules():
    """Shipped default cadence for the ten company seats."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "company-seats.json")
    with open(path) as f:
        return json.load(f)


def seed_default_schedules():
    """Add default seat schedules missing from schedules.json. Returns count added."""
    schedules = load_schedules()
    have = {s.get("name") for s in schedules}
    added = 0
    for d in default_seat_schedules():
        if d["name"] not in have:
            schedules.append(dict(d))
            added += 1
    if added:
        save_schedules(schedules)
    return added


def _fire_minutes(cron_expr, start, span_minutes):
    t = start
    for _ in range(span_minutes):
        if cron_matches(cron_expr, t):
            yield t
        t += timedelta(minutes=1)


def interval_minutes(cron_expr):
    """Smallest gap in minutes between consecutive fires (None if fewer than 2 in 8 days)."""
    fires = list(_fire_minutes(cron_expr, datetime(2026, 1, 5, 0, 0), 8 * 1440))
    gaps = [int((b - a).total_seconds() // 60) for a, b in zip(fires, fires[1:])]
    return min(gaps) if gaps else None


def next_fire(cron_expr, after):
    """First fire strictly after `after` (naive datetime), within 8 days, else None."""
    start = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    return next(_fire_minutes(cron_expr, start, 8 * 1440), None)


def launchagent_path(home):
    return os.path.join(home, "Library", "LaunchAgents", LAUNCHAGENT_LABEL + ".plist")


def write_launchagent(home, repo, loki_bin):
    """Write the LaunchAgent plist under `home`. Does not load it."""
    logs = os.path.join(home, ".loki", "logs")
    os.makedirs(logs, exist_ok=True)
    plist = {
        "Label": LAUNCHAGENT_LABEL,
        "ProgramArguments": [loki_bin, "trigger", "daemon", "--loop"],
        "WorkingDirectory": repo,
        "EnvironmentVariables": {
            "LOKI_COMPANY_ROOT": repo,
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": home,
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "StandardOutPath": os.path.join(logs, "company.out.log"),
        "StandardErrorPath": os.path.join(logs, "company.err.log"),
    }
    path = launchagent_path(home)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        plistlib.dump(plist, f)
    return path


def remove_launchagent(home):
    path = launchagent_path(home)
    if not os.path.exists(path):
        return False
    os.unlink(path)
    return True


def systemd_unit(repo, loki_bin):
    return "\n".join([
        "[Unit]",
        "Description=Loki Mode company seats (schedule daemon)",
        "",
        "[Service]",
        "WorkingDirectory=%s" % repo,
        "Environment=LOKI_COMPANY_ROOT=%s" % repo,
        "ExecStart=%s trigger daemon --loop" % loki_bin,
        "Restart=always",
        "RestartSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ])


def _launchctl(*args):
    return subprocess.run(["launchctl"] + list(args), capture_output=True, text=True)


def install_company(no_load=False):
    home = os.path.expanduser("~")
    repo = company_root()
    loki_bin = os.environ.get("LOKI_BIN") or shutil.which("loki") or "loki"
    added = seed_default_schedules()
    print("Seeded %d default seat schedule(s) into .loki/triggers/schedules.json" % added)
    if sys.platform != "darwin":
        print("NOT SUPPORTED: launchd install is macOS only. Equivalent systemd user unit "
              "(~/.config/systemd/user/loki-company.service):\n")
        print(systemd_unit(repo, loki_bin))
        return 0
    path = write_launchagent(home, repo, loki_bin)
    print("Wrote %s" % path)
    if not no_load:
        dom = "gui/%d" % os.getuid()
        _launchctl("bootout", dom, path)
        r = _launchctl("bootstrap", dom, path)
        if r.returncode != 0:
            print("launchctl bootstrap failed: %s" % (r.stderr.strip() or r.stdout.strip()))
            return 1
        print("Loaded %s" % LAUNCHAGENT_LABEL)
    return 0


def uninstall_company(no_load=False):
    home = os.path.expanduser("~")
    if sys.platform != "darwin":
        print("NOT SUPPORTED: nothing to remove (launchd is macOS only).")
        return 0
    path = launchagent_path(home)
    if not no_load and os.path.exists(path):
        _launchctl("bootout", "gui/%d" % os.getuid(), path)
    print("Removed %s" % path if remove_launchagent(home) else "Not installed: %s" % path)
    return 0


def log_event(name, action_desc, status):
    """Log schedule fire to events.log."""
    log_path = get_loki_dir() / "events.log"
    timestamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "timestamp": timestamp,
        "event": "schedule",
        "action": action_desc,
        "summary": name,
        "status": status,
    }
    with open(log_path, "a") as f:
        f.write(json.dumps(entry) + "\n")


def run_daemon(dry_run=False, once=False):
    """
    Check all schedules and fire those that match the current minute.
    If once=True, run one pass and exit (used for cron job invocation).
    """
    now = datetime.now()
    schedules = load_schedules()
    changed = False

    for i, schedule in enumerate(schedules):
        if should_run(schedule, now):
            success = run_schedule(schedule, dry_run=dry_run)
            status = "fired" if success else "error"
            log_event(schedule.get("name", "?"), schedule.get("action", "?"), status)
            if not dry_run:
                schedules[i]["last_run"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
                changed = True

    if changed:
        save_schedules(schedules)

    if not schedules:
        logging.debug("No schedules configured.")

    return True


def run_daemon_loop(max_passes=None):
    """Always-on mode: one pass at the top of every minute (launchd KeepAlive)."""
    passes = 0
    while max_passes is None or passes < max_passes:
        try:
            run_daemon(once=True)
        except Exception:  # keep the always-on loop alive across a bad pass
            logging.exception("daemon pass failed")
        passes += 1
        if max_passes is not None and passes >= max_passes:
            break
        time.sleep(60 - time.time() % 60)


def list_schedules():
    """Print all configured schedules."""
    schedules = load_schedules()
    if not schedules:
        print("No schedules configured.")
        print("Add schedules to .loki/triggers/schedules.json")
        return

    print("Configured schedules:")
    for s in schedules:
        enabled = "enabled" if s.get("enabled", True) else "disabled"
        last_run = s.get("last_run") or "never"
        print("  %-30s  %-20s  %-12s  %s  (last: %s)" % (
            s.get("name", "?"),
            s.get("cron_expr", "?"),
            s.get("action", "?"),
            enabled,
            last_run,
        ))


def add_schedule(name, cron_expr, action, extra_args, enabled=True):
    """Add or update a schedule entry."""
    schedules = load_schedules()
    # Check for existing
    for i, s in enumerate(schedules):
        if s.get("name") == name:
            schedules[i] = {
                "name": name,
                "cron_expr": cron_expr,
                "action": action,
                "args": list(extra_args),
                "enabled": enabled,
                "last_run": s.get("last_run"),
            }
            save_schedules(schedules)
            print("Updated schedule: %s" % name)
            return
    schedules.append({
        "name": name,
        "cron_expr": cron_expr,
        "action": action,
        "args": list(extra_args),
        "enabled": enabled,
        "last_run": None,
    })
    save_schedules(schedules)
    print("Added schedule: %s" % name)


def remove_schedule(name):
    """Remove a schedule by name."""
    schedules = load_schedules()
    before = len(schedules)
    schedules = [s for s in schedules if s.get("name") != name]
    if len(schedules) == before:
        print("Schedule not found: %s" % name)
        return False
    save_schedules(schedules)
    print("Removed schedule: %s" % name)
    return True


def main():
    parser = argparse.ArgumentParser(
        description="loki-mode schedule-based trigger daemon"
    )
    subparsers = parser.add_subparsers(dest="command")

    # daemon - run one pass
    daemon_parser = subparsers.add_parser("daemon", help="Run one pass of schedule checks")
    daemon_parser.add_argument("--dry-run", action="store_true", help="Preview without running")
    daemon_parser.add_argument("--loop", action="store_true", help="Keep running, one pass per minute")
    daemon_parser.add_argument("--max-passes", type=int, default=None, help=argparse.SUPPRESS)

    tick_parser = subparsers.add_parser("tick", help="Run one headless tick of a company seat")
    tick_parser.add_argument("seat")
    subparsers.add_parser("seed", help="Add default company-seat schedules")
    for cmd_name in ("install", "uninstall"):
        ip = subparsers.add_parser(cmd_name, help="%s the always-on company LaunchAgent" % cmd_name.capitalize())
        ip.add_argument("--no-load", action="store_true", help="Write/remove the plist without launchctl")

    # list
    subparsers.add_parser("list", help="List configured schedules")

    # add
    add_parser = subparsers.add_parser("add", help="Add a schedule")
    add_parser.add_argument("name")
    add_parser.add_argument("cron_expr")
    add_parser.add_argument("action")
    add_parser.add_argument("args", nargs="*")
    add_parser.add_argument("--disabled", action="store_true")

    # remove
    remove_parser = subparsers.add_parser("remove", help="Remove a schedule")
    remove_parser.add_argument("name")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )

    if args.command == "daemon" or args.command is None:
        dry_run = getattr(args, "dry_run", False)
        if getattr(args, "loop", False):
            run_daemon_loop(getattr(args, "max_passes", None))
        else:
            run_daemon(dry_run=dry_run, once=True)
    elif args.command == "tick":
        status, detail = tick_seat(args.seat)
        print("%s: %s" % (status, detail))
        sys.exit(1 if status == "error" else 0)
    elif args.command == "seed":
        print("Added %d default seat schedule(s)" % seed_default_schedules())
    elif args.command == "install":
        sys.exit(install_company(args.no_load))
    elif args.command == "uninstall":
        sys.exit(uninstall_company(args.no_load))
    elif args.command == "list":
        list_schedules()
    elif args.command == "add":
        add_schedule(
            args.name,
            args.cron_expr,
            args.action,
            args.args,
            enabled=not args.disabled,
        )
    elif args.command == "remove":
        success = remove_schedule(args.name)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
