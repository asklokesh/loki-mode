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

Usage:
    python3 autonomy/trigger-schedule.py [--once] [--dry-run]
"""

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
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


def run_schedule(schedule, dry_run=False):
    """Execute a scheduled loki command."""
    loki_args = build_loki_args(schedule)
    cmd = ["loki"] + loki_args
    name = schedule.get("name", "unnamed")

    if dry_run:
        logging.info("[DRY-RUN] Schedule '%s' would run: %s", name, " ".join(cmd))
        return True

    logging.info("Schedule '%s' firing: %s", name, " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        logging.info("Schedule '%s' started pid=%d", name, proc.pid)
        return True
    except (FileNotFoundError, OSError) as e:
        logging.error("Schedule '%s' failed: %s", name, e)
        return False


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
        run_daemon(dry_run=dry_run, once=True)
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
