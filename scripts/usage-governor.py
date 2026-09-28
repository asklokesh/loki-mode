#!/usr/bin/env python3
"""Usage governor for the Loki v10 swarm (D39, docs/v10/DECISIONS.md).

Answers three questions for the Chief of Staff's dispatch loop: how much of
the Claude Max plan's 5-hour and weekly windows has been used, what the
burn rate projects for the next hour, and how many engineers that leaves
room for. stdlib only.

## Step 2: does Claude Code expose plan usage directly?

Yes, partially. The statusLine JSON schema (fetched from
https://code.claude.com/docs/en/statusline on 2026-09-28) documents:

  rate_limits.five_hour.used_percentage   (0-100)
  rate_limits.five_hour.resets_at         (unix epoch seconds)
  rate_limits.seven_day.used_percentage   (0-100)
  rate_limits.seven_day.resets_at         (unix epoch seconds)

"The rate_limits object is only present for claude.ai Pro and Max
subscribers ... and only after the first API response" in a session, and it
is delivered by Claude Code invoking whatever command is configured as
`statusLine` on every status-line render.

That makes it a genuine ground-truth source, but NOT independently
scriptable: there is no CLI subcommand or `claude rate-limit-status` that
this script can call on demand. It is push-based (Claude Code pushes JSON
to the configured statusLine command) and only exists while an interactive
session with a first API response is live. The `/usage` slash command is
documented as an interactive TUI screen (usage bars, attribution, `d`/`w`
toggle) with no non-interactive/JSON flag; `/usage-credits` explicitly
refuses to run under `-p`, and nothing in the costs doc claims `/usage`
does either, so it is not scriptable.

Given that, this script treats the live source as OPTIONAL and opt-in: if
the operator points their own statusLine command at a logger that appends
`{"ts": <epoch>, "rate_limits": {...}}` lines to LIVE_LOG_PATH (below), this
script prefers that as ground truth (source "live") when the newest line is
fresh (within LIVE_FRESHNESS_SECONDS). Nothing in ~/.claude/settings.json is
touched by this script -- wiring the statusLine hook up is a separate,
explicit choice for the operator. Absent that, usage falls back to the D39
calibration path (step 3) fit against founder-supplied readings.

## Calibration (step 3, when no live source)

docs/v10/usage-readings.tsv holds founder readings: utc_time, window_percent
(5-hour), weekly_percent (7-day). For each reading we sum token usage over
its matching window from the JSONL transcripts, then fit tokens-per-percent
as a least-squares line through the origin (tokens = rate * percent), which
reduces to a plain ratio for a single reading. We fit this twice: once for
raw output tokens, once for an "opus-weighted total" that scales opus output
tokens up relative to sonnet/haiku/fable, because D39 states "opus draws
faster than sonnet" against the plan limit. OPUS_WEIGHT below is a named,
commented ASSUMPTION pending real dual-model readings to calibrate it.

Every derived percentage is labelled "ESTIMATE (n=<readings>)". With zero
readings the script prints "uncalibrated" and no percentage, per spec.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# ASSUMPTION (D39: "opus draws faster than sonnet against the plan limit"):
# opus output tokens count ~1.4x as much against the 5h/weekly plan limits as
# sonnet/haiku/fable output tokens. Recalibrate once dual-model founder
# readings exist to fit this directly instead of assuming it.
OPUS_WEIGHT = 1.4

WINDOW_HOURS = 5
WINDOW_PCT_CEILING = 85.0
WEEKLY_PCT_CEILING = 90.0
ACTIVE_ROLES = ("subagent", "workflow-agent")

LIVE_LOG_PATH = Path.home() / ".claude" / "usage-governor" / "statusline.jsonl"
LIVE_FRESHNESS_SECONDS = 30 * 60

LIMIT_PATTERNS = [
    re.compile(r"limit reached", re.IGNORECASE),
    re.compile(r"organization has disabled", re.IGNORECASE),
    re.compile(r"(?<!\d)429(?!\d)"),
]

USAGE_FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def parse_ts(raw):
    """Parse an ISO8601 timestamp (with trailing Z) into an aware UTC datetime."""
    if not isinstance(raw, str):
        return None
    try:
        s = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def classify_role(path: Path):
    parts = path.parts
    if "subagents" in parts:
        meta = path.with_name(path.stem + ".meta.json")
        return "workflow-agent" if meta.exists() else "subagent"
    # a jsonl directly inside a project dir (not nested under a session dir)
    # is the main session transcript: the Chief of Staff.
    return "chief-of-staff"


def iter_jsonl_files(root: Path):
    yield from (Path(p) for p in glob.glob(str(root / "**" / "*.jsonl"), recursive=True))


def iter_records(root: Path):
    """Yield (path, role, timestamp, model, usage-dict) for assistant messages with usage.

    Claude Code writes one JSONL row per content block and repeats the same
    `message.usage` totals on every row of a given API response, so a file
    is deduplicated by `message.id` (falling back to `requestId`, then to
    row position when neither is present) before a row's usage counts.
    Skips unreadable files and unparseable lines rather than failing.
    """
    for path in iter_jsonl_files(root):
        role = classify_role(path)
        seen_ids = set()
        try:
            fh = open(path, "r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line_no, line in enumerate(fh):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                msg = rec.get("message")
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue
                ts = parse_ts(rec.get("timestamp"))
                if ts is None:
                    continue
                dedup_key = msg.get("id") or rec.get("requestId") or ("__row__", line_no)
                if dedup_key in seen_ids:
                    continue
                seen_ids.add(dedup_key)
                model = msg.get("model") or "unknown"
                yield path, role, ts, model, usage


def output_tokens_of(usage):
    try:
        return int(usage.get("output_tokens") or 0)
    except (TypeError, ValueError):
        return 0


def opus_weighted_tokens_of(model, usage):
    out = output_tokens_of(usage)
    return out * OPUS_WEIGHT if "opus" in (model or "").lower() else out


def error_text_of(rec):
    """Text worth pattern-matching for a real limit/error event.

    Scoped to structured error fields, not the whole raw line: a raw-line
    scan matches "429" inside UUIDs (e.g. "40b429da-...") and inside
    documentation text a WebFetch tool result pulled into context (measured:
    181 raw-line hits in the last hour on this machine, all noise -- see
    scripts/usage-governor.py test fixtures for the regression). Real API
    errors carry `apiErrorStatus` and `error` fields, and Claude Code marks
    its own error messages with `isApiErrorMessage`.
    """
    parts = []
    err = rec.get("error")
    if isinstance(err, str):
        parts.append(err)
    status = rec.get("apiErrorStatus")
    if isinstance(status, int):
        parts.append(str(status))
    if rec.get("isApiErrorMessage"):
        msg = rec.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
    return " ".join(parts)


def scan_for_limit_events(root: Path, since: datetime):
    """Return (last_occurrence_iso_or_None, count) for limit-related text in [since, now]."""
    last = None
    count = 0
    for path in iter_jsonl_files(root):
        try:
            fh = open(path, "r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                ts = parse_ts(rec.get("timestamp"))
                if ts is None or ts < since:
                    continue
                text = error_text_of(rec)
                if text and any(p.search(text) for p in LIMIT_PATTERNS):
                    count += 1
                    if last is None or ts > last:
                        last = ts
    return (last.isoformat() if last else None), count


def load_readings(path: Path):
    """Return list of (utc_dt, window_pct, weekly_pct). Missing file -> []."""
    if not path.exists():
        return []
    readings = []
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    if not lines:
        return []
    rows = lines[1:] if lines[0].lower().startswith("utc_time") else lines
    for row in rows:
        row = row.strip()
        if not row:
            continue
        parts = row.split("\t")
        if len(parts) != 3:
            continue
        ts = parse_ts(parts[0])
        try:
            window_pct = float(parts[1])
            weekly_pct = float(parts[2])
        except ValueError:
            continue
        if ts is None:
            continue
        readings.append((ts, window_pct, weekly_pct))
    return readings


def last_wednesday_reset(ref_utc: datetime) -> datetime:
    """Most recent Wednesday 13:00 America/New_York at or before ref_utc, as UTC."""
    tz = ZoneInfo("America/New_York")
    ref_local = ref_utc.astimezone(tz)
    days_since_wed = (ref_local.weekday() - 2) % 7  # Monday=0 .. Wednesday=2
    candidate = ref_local.replace(hour=13, minute=0, second=0, microsecond=0) - timedelta(days=days_since_wed)
    if candidate > ref_local:
        candidate -= timedelta(days=7)
    return candidate.astimezone(timezone.utc)


def fit_tokens_per_percent(pairs):
    """Least-squares slope through the origin: tokens = rate * percent.

    Reduces to tokens/percent for a single pair. Skips zero-percent readings
    (undefined ratio, and would only add a zero term to both sums).
    """
    num = 0.0
    den = 0.0
    n = 0
    for tokens, pct in pairs:
        if pct <= 0:
            continue
        num += pct * tokens
        den += pct * pct
        n += 1
    if den == 0 or n == 0:
        return None, 0
    return num / den, n


def sum_usage(records):
    out_tokens = 0
    opus_weighted = 0.0
    for _path, _role, _ts, model, usage in records:
        out_tokens += output_tokens_of(usage)
        opus_weighted += opus_weighted_tokens_of(model, usage)
    return out_tokens, opus_weighted


def read_live_rate_limits(now: datetime, live_log_path: Path):
    """Read the newest line of an opt-in statusLine logger, if fresh. See header."""
    if not live_log_path.exists():
        return None
    try:
        with open(live_log_path, "r", encoding="utf-8") as fh:
            lines = [l for l in fh.read().splitlines() if l.strip()]
    except OSError:
        return None
    if not lines:
        return None
    try:
        entry = json.loads(lines[-1])
    except (json.JSONDecodeError, ValueError):
        return None
    ts = entry.get("ts")
    if not isinstance(ts, (int, float)):
        return None
    age = now.timestamp() - ts
    if age < 0 or age > LIVE_FRESHNESS_SECONDS:
        return None
    return entry.get("rate_limits")


def build_report(root: Path, readings_path: Path, now: datetime, live_log_path: Path):
    all_records = list(iter_records(root))

    by_model = {}
    by_hour = {}
    by_role = {}
    for path, role, ts, model, usage in all_records:
        hour_key = ts.strftime("%Y-%m-%dT%H")
        m = by_model.setdefault(model, {f: 0 for f in USAGE_FIELDS})
        h = by_hour.setdefault(hour_key, {f: 0 for f in USAGE_FIELDS})
        r = by_role.setdefault(role, {f: 0 for f in USAGE_FIELDS})
        for f in USAGE_FIELDS:
            try:
                v = int(usage.get(f) or 0)
            except (TypeError, ValueError):
                v = 0
            m[f] += v
            h[f] += v
            r[f] += v

    window_start = now - timedelta(hours=WINDOW_HOURS)
    weekly_start = last_wednesday_reset(now)

    readings = load_readings(readings_path)
    window_pairs = []
    weekly_pairs = []
    for ts, window_pct, weekly_pct in readings:
        w_records = [rec for rec in all_records if ts - timedelta(hours=WINDOW_HOURS) <= rec[2] <= ts]
        w_out, w_opus = sum_usage(w_records)
        window_pairs.append((w_out, w_opus, window_pct))

        wk_start = last_wednesday_reset(ts)
        wk_records = [rec for rec in all_records if wk_start <= rec[2] <= ts]
        wk_out, wk_opus = sum_usage(wk_records)
        weekly_pairs.append((wk_out, wk_opus, weekly_pct))

    window_rate_out, window_n = fit_tokens_per_percent([(o, p) for o, _w, p in window_pairs])
    window_rate_opus, _ = fit_tokens_per_percent([(w, p) for _o, w, p in window_pairs])
    weekly_rate_out, weekly_n = fit_tokens_per_percent([(o, p) for o, _w, p in weekly_pairs])
    weekly_rate_opus, _ = fit_tokens_per_percent([(w, p) for _o, w, p in weekly_pairs])

    # hourly buckets for the trailing window, oldest first, to project the
    # rolling window forward by exactly one hour (drop oldest, add next).
    hour_buckets_out = []
    hour_buckets_opus = []
    for i in range(WINDOW_HOURS, 0, -1):
        b_start = now - timedelta(hours=i)
        b_end = now - timedelta(hours=i - 1)
        b_records = [rec for rec in all_records if b_start <= rec[2] < b_end]
        o, w = sum_usage(b_records)
        hour_buckets_out.append(o)
        hour_buckets_opus.append(w)

    current_window_out = sum(hour_buckets_out)
    current_window_opus = sum(hour_buckets_opus)
    last_hour_out = hour_buckets_out[-1]
    last_hour_opus = hour_buckets_opus[-1]
    oldest_hour_out = hour_buckets_out[0]
    oldest_hour_opus = hour_buckets_opus[0]

    weekly_records = [rec for rec in all_records if weekly_start <= rec[2] <= now]
    weekly_out, weekly_opus = sum_usage(weekly_records)

    last_hour_start = now - timedelta(hours=1)
    active_engineers = len({
        str(path) for path, role, ts, _model, _usage in all_records
        if role in ACTIVE_ROLES and ts >= last_hour_start
    })
    burn_per_engineer_out = (last_hour_out / active_engineers) if active_engineers else None
    burn_per_engineer_opus = (last_hour_opus / active_engineers) if active_engineers else None

    live = read_live_rate_limits(now, live_log_path)

    def pct(tokens, rate):
        return (tokens / rate) * 100.0 if rate else None

    window_source = "live" if live and live.get("five_hour") else ("estimate" if window_n else "uncalibrated")
    weekly_source = "live" if live and live.get("seven_day") else ("estimate" if weekly_n else "uncalibrated")

    current_window_pct = None
    if window_source == "live":
        current_window_pct = live["five_hour"].get("used_percentage")
    elif window_source == "estimate":
        current_window_pct = pct(current_window_out, window_rate_out)

    current_weekly_pct = None
    if weekly_source == "live":
        current_weekly_pct = live["seven_day"].get("used_percentage")
    elif weekly_source == "estimate":
        current_weekly_pct = pct(weekly_out, weekly_rate_out)

    # For a "live" source, derive an implied tokens-per-percent rate from the
    # live reading itself (current_tokens / current_pct) so the same linear
    # projection formula works whether the percent came from a live reading
    # or from calibration. Falls back to the calibrated rate if the live
    # reading is 0% (no ratio available yet).
    def effective_rate(source, current_tokens, current_pct, calibrated_rate):
        if source == "live" and current_pct:
            return current_tokens / current_pct * 100.0
        if source in ("live", "estimate"):
            return calibrated_rate
        return None

    window_rate_eff = effective_rate(window_source, current_window_out, current_window_pct, window_rate_out)
    weekly_rate_eff = effective_rate(weekly_source, weekly_out, current_weekly_pct, weekly_rate_out)

    max_engineers_next_hour = None
    if window_rate_eff and weekly_rate_eff and burn_per_engineer_out:
        n = 0
        best = 0
        while n <= 500:
            proj_next_hour = burn_per_engineer_out * n
            proj_window_tokens = current_window_out - oldest_hour_out + proj_next_hour
            proj_weekly_tokens = weekly_out + proj_next_hour
            proj_window_pct = pct(proj_window_tokens, window_rate_eff)
            proj_weekly_pct = pct(proj_weekly_tokens, weekly_rate_eff)
            if proj_window_pct <= WINDOW_PCT_CEILING and proj_weekly_pct <= WEEKLY_PCT_CEILING:
                best = n
                n += 1
            else:
                break
        max_engineers_next_hour = best

    limit_since = now - timedelta(hours=1)
    last_limit_event, limit_event_count = scan_for_limit_events(root, limit_since)

    def est_label(n):
        return f"ESTIMATE (n={n} readings)" if n else None

    report = {
        "generated_at": now.isoformat(),
        "root": str(root),
        "totals": {"by_model": by_model, "by_hour": by_hour, "by_role": by_role},
        "calibration": {
            "readings_count": len(readings),
            "window": {
                "status": "uncalibrated" if window_n == 0 else est_label(window_n),
                "tokens_per_percent_output": window_rate_out,
                "tokens_per_percent_opus_weighted": window_rate_opus,
            },
            "weekly": {
                "status": "uncalibrated" if weekly_n == 0 else est_label(weekly_n),
                "tokens_per_percent_output": weekly_rate_out,
                "tokens_per_percent_opus_weighted": weekly_rate_opus,
            },
            "opus_weight_assumption": OPUS_WEIGHT,
        },
        "window": {
            "source": window_source,
            "start": window_start.isoformat(),
            "current_tokens_output": current_window_out,
            "current_tokens_opus_weighted": current_window_opus,
            "current_pct": current_window_pct,
            "resets_at": live.get("five_hour", {}).get("resets_at") if live else None,
        },
        "weekly": {
            "source": weekly_source,
            "start": weekly_start.isoformat(),
            "current_tokens_output": weekly_out,
            "current_tokens_opus_weighted": weekly_opus,
            "current_pct": current_weekly_pct,
            "resets_at": live.get("seven_day", {}).get("resets_at") if live else None,
        },
        "governor": {
            "active_engineers_last_hour": active_engineers,
            "burn_per_engineer_output_last_hour": burn_per_engineer_out,
            "burn_per_engineer_opus_weighted_last_hour": burn_per_engineer_opus,
            "last_hour_output_tokens": last_hour_out,
            "max_engineers_next_hour": max_engineers_next_hour,
        },
        "limit_events": {
            "last_occurrence": last_limit_event,
            "count_last_hour": limit_event_count,
        },
    }
    return report


def human_summary(report):
    lines = []
    w = report["window"]
    k = report["weekly"]
    g = report["governor"]
    cal = report["calibration"]

    lines.append(f"Usage governor @ {report['generated_at']} (root: {report['root']})")
    lines.append(f"Readings on file: {cal['readings_count']}")

    if w["current_pct"] is not None:
        tag = "LIVE" if w["source"] == "live" else "ESTIMATE"
        lines.append(
            f"5h window [{tag}]: {w['current_pct']:.1f}% used, "
            f"{w['current_tokens_output']:,} output tokens since {w['start']}"
        )
    else:
        lines.append(f"5h window: uncalibrated ({w['current_tokens_output']:,} output tokens since {w['start']})")

    if k["current_pct"] is not None:
        tag = "LIVE" if k["source"] == "live" else "ESTIMATE"
        lines.append(
            f"Weekly window [{tag}]: {k['current_pct']:.1f}% used, "
            f"{k['current_tokens_output']:,} output tokens since {k['start']}"
        )
    else:
        lines.append(f"Weekly window: uncalibrated ({k['current_tokens_output']:,} output tokens since {k['start']})")

    lines.append(f"Active engineers (last hour): {g['active_engineers_last_hour']}")
    if g["burn_per_engineer_output_last_hour"] is not None:
        lines.append(f"Burn per engineer (last hour, output tokens): {g['burn_per_engineer_output_last_hour']:,.0f}")
    if g["max_engineers_next_hour"] is not None:
        lines.append(f"Max engineers for next hour: {g['max_engineers_next_hour']}")
    else:
        lines.append("Max engineers for next hour: uncalibrated, cannot project")

    le = report["limit_events"]
    if le["last_occurrence"]:
        lines.append(f"Limit events in last hour: {le['count_last_hour']} (last at {le['last_occurrence']})")
    else:
        lines.append("Limit events in last hour: none")

    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Loki v10 usage governor (D39)")
    default_root = os.environ.get("LOKI_USAGE_ROOT", str(Path.home() / ".claude" / "projects"))
    parser.add_argument("--root", default=default_root, help="root to scan for */*.jsonl transcripts")
    parser.add_argument(
        "--readings",
        default=str(Path(__file__).resolve().parent.parent / "docs" / "v10" / "usage-readings.tsv"),
        help="path to the founder readings TSV",
    )
    parser.add_argument("--now", default=None, help="override 'now' as ISO8601 UTC, for tests")
    parser.add_argument(
        "--live-log",
        default=str(LIVE_LOG_PATH),
        help="path to an opt-in statusLine logger's JSONL file",
    )
    parser.add_argument("--json", action="store_true", help="print JSON instead of a human summary")
    args = parser.parse_args(argv)

    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        parser.error("--now must be a parseable ISO8601 timestamp")

    report = build_report(Path(args.root), Path(args.readings), now, Path(args.live_log))

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(human_summary(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
