#!/usr/bin/env bash
# Optional live-usage source for scripts/usage-governor.py (G-01, D39).
#
# This script is NOT wired up by anything in this repo: it becomes your
# Claude Code status line only if you set it as the "statusLine" command in
# your OWN ~/.claude/settings.json yourself. Nothing here edits that file.
#
# Once wired up, Claude Code runs this on stdin with the statusLine JSON
# (see https://code.claude.com/docs/en/statusline) on every render. It
# appends {"ts": <epoch seconds>, "rate_limits": {...}} to
# LOG_FILE below whenever a `rate_limits` object is present (Pro/Max plans
# only, and only after the first API response in a session), so the
# governor's `read_live_rate_limits()` always has a recent line to read
# while a session is active. It also prints a plain one-line status, so it
# works as an actual status line and not just a logger.
set -euo pipefail

LOG_DIR="${LOKI_STATUSLINE_LOG_DIR:-$HOME/.claude/usage-governor}"
LOG_FILE="$LOG_DIR/statusline.jsonl"
mkdir -p "$LOG_DIR"

INPUT="$(cat)"

python3 -c '
import json, sys, time

try:
    data = json.loads(sys.argv[1])
except (ValueError, json.JSONDecodeError):
    data = {}

log_file = sys.argv[2]
rate_limits = data.get("rate_limits")
if isinstance(rate_limits, dict):
    entry = {"ts": time.time(), "rate_limits": rate_limits}
    with open(log_file, "a") as fh:
        fh.write(json.dumps(entry) + "\n")

model = ((data.get("model") or {}).get("display_name")) or "?"
parts = [model]
five_h = (rate_limits or {}).get("five_hour", {}).get("used_percentage")
week = (rate_limits or {}).get("seven_day", {}).get("used_percentage")
if isinstance(five_h, (int, float)):
    parts.append("5h %.0f%%" % five_h)
if isinstance(week, (int, float)):
    parts.append("wk %.0f%%" % week)
print(" | ".join(parts))
' "$INPUT" "$LOG_FILE"
