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
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
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

# Per-file transcript parse cache (E-109): keyed by (path, size, mtime), so
# an unchanged file is read from cache on the next run instead of
# re-parsed. See iter_records.
CACHE_PATH = Path.home() / ".claude" / "usage-governor" / "transcript-cache.json"

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


def iter_jsonl_files(root: Path, min_mtime: float | None = None):
    """Yield transcript paths, skipping ones whose mtime is older than min_mtime.

    Perf (E-109): a file untouched since before min_mtime cannot hold a row
    inside a window that starts at min_mtime -- Claude Code transcripts are
    append-only, so mtime tracks the last row written. Callers pass the
    outermost window's start as min_mtime so no in-window row is ever lost.
    """
    for p in glob.glob(str(root / "**" / "*.jsonl"), recursive=True):
        path = Path(p)
        if min_mtime is not None:
            try:
                if path.stat().st_mtime < min_mtime:
                    continue
            except OSError:
                continue
        yield path


def _load_cache(cache_path: Path):
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save_cache(cache_path: Path, cache):
    # A unique per-writer tmp name (tempfile.mkstemp in the same dir) so two
    # overlapping pulse refreshes never share one ".tmp" path and interleave
    # or truncate each other's write; os.replace is still the atomic swap.
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=cache_path.name + ".", suffix=".tmp", dir=str(cache_path.parent)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(cache, fh)
            os.replace(tmp_name, cache_path)
        except OSError:
            os.unlink(tmp_name)
            raise
    except OSError:
        pass  # cache is a perf layer only; a failed write just costs speed next run


def _parse_file(path: Path):
    """Parse one transcript file; return its per-message-id max-output_tokens rows.

    Returns a list of [key, output_tokens, timestamp_iso, model, usage],
    JSON-safe so it can be cached directly. `key` is message.id or
    requestId (a string) when present, else ["__row__", line_no] -- unique
    only within this file, made globally unique by the caller (which
    already knows the file's path). See iter_records for why only the
    max-output_tokens row per key is kept (G-01).
    """
    best = {}
    try:
        fh = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return []
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
            mid = msg.get("id") or rec.get("requestId")
            key = mid if mid else ("__row__", line_no)
            model = msg.get("model") or "unknown"
            out = output_tokens_of(usage)
            prior = best.get(key)
            if prior is None or out >= prior[0]:
                best[key] = (out, ts.isoformat(), model, usage)
    return [
        [list(key) if isinstance(key, tuple) else key, out, ts_iso, model, usage]
        for key, (out, ts_iso, model, usage) in best.items()
    ]


def iter_records(root: Path, min_mtime=None, cache_path: Path | None = None):
    """Yield (path, role, timestamp, model, usage-dict) for assistant messages with usage.

    Claude Code writes one JSONL row per content block, and each row is a
    streaming snapshot of the same API response, not a duplicate: output_tokens
    grows across rows sharing one message.id (e.g. 5, 5, 467) while cache
    fields repeat, and the LAST row holds the final, complete usage. Taking
    the first row (or naively summing every row) both undercount or
    overcount, so a file is grouped by `message.id` (falling back to
    `requestId`, then to row position when neither is present) and only the
    row with the highest output_tokens in each group is kept, using that
    row's full usage dict (its cache fields are the real, non-repeating
    ones) and its own timestamp. Skips unreadable files and unparseable
    lines rather than failing.

    Per-file results are cached by (path, size, mtime) under cache_path
    (E-109) via _parse_file: an unchanged file is read from cache instead
    of re-parsed. The cache stores PER-MESSAGE maxima for that file, never
    a per-file total, so the cross-file dedup below (a message.id repeated
    in two different files -- G-01) works identically whether either file
    came from cache or a fresh parse: `best` merges by dedup key across
    ALL files regardless of source, keeping the max output_tokens seen.
    """
    cache = _load_cache(cache_path) if cache_path is not None else {}
    new_cache = {}
    best = {}
    for path in iter_jsonl_files(root, min_mtime):
        try:
            st = path.stat()
        except OSError:
            continue
        cache_key = str(path)
        cached = cache.get(cache_key)
        if cached is not None and cached.get("size") == st.st_size and cached.get("mtime") == st.st_mtime:
            entries = cached["entries"]
        else:
            entries = _parse_file(path)
        if cache_path is not None:
            new_cache[cache_key] = {"size": st.st_size, "mtime": st.st_mtime, "entries": entries}
        role = classify_role(path)
        for key, out, ts_iso, model, usage in entries:
            ts = parse_ts(ts_iso)
            if ts is None:
                continue
            dedup_key = (cache_key, key[0], key[1]) if isinstance(key, list) else key
            prior = best.get(dedup_key)
            if prior is None or out >= prior[0]:
                best[dedup_key] = (out, path, role, ts, model, usage)
    # Perf (E-109): only rewrite the cache file when its contents actually
    # changed. A fully-warm run (every file a cache hit, same in-window file
    # set) would otherwise re-serialize and rewrite the whole multi-MB cache
    # every time for zero benefit -- the dict compare is cheap next to the
    # json.dump + write it would otherwise pay unconditionally.
    if cache_path is not None and new_cache != cache:
        _save_cache(cache_path, new_cache)
    for _out, path, role, ts, model, usage in best.values():
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
    """Return (last_occurrence_iso_or_None, count) for limit-related text in [since, now].

    Perf (E-109): skips files whose mtime predates `since` -- an append-only
    transcript's mtime tracks its last row, so a file untouched before
    `since` cannot hold a line timestamped at or after it either.
    """
    last = None
    count = 0
    for path in iter_jsonl_files(root, min_mtime=since.timestamp()):
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


def _parse_timeout_secs():
    """Parse LOKI_USAGE_LIVE_TIMEOUT, validating with math.isfinite and > 0."""
    try:
        v = float(os.environ.get("LOKI_USAGE_LIVE_TIMEOUT") or 20)
        if math.isfinite(v) and v > 0:
            return v
    except (ValueError, TypeError):
        pass
    return 20


LIVE_READ_TIMEOUT_SECS = _parse_timeout_secs()
LIVE_READ_MIN_GAP = timedelta(minutes=10)
_SESSION_RE = re.compile(r"Current session:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*\S+\s*resets\s+([^\n]+))?")
_WEEK_RE = re.compile(r"Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*\S+\s*resets\s+([^\n]+))?")


def _kill_group(proc):
    """SIGTERM the child's process group, SIGKILL after 5s; never raises."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except OSError:
            pass
        try:
            proc.communicate(timeout=5)
            break
        except subprocess.TimeoutExpired:
            continue
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass


def live_read_usage(readings_path: Path, now: datetime):
    """E-163: read live plan usage from the local `/usage` slash command and
    append one row to the readings TSV (at most one per 10 minutes). Any
    failure returns status "uncalibrated" and invents nothing."""
    bad = {"status": "uncalibrated"}
    existing = load_readings(readings_path)
    if existing and now - max(r[0] for r in existing) < LIVE_READ_MIN_GAP:
        return {"status": "recent"}
    proc = None
    try:
        # Own process group so a timeout can reap grandchildren too.
        proc = subprocess.Popen(
            ["claude", "-p", "/usage", "--output-format", "json"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        try:
            out, _ = proc.communicate(timeout=LIVE_READ_TIMEOUT_SECS)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            return bad
        text = json.loads(out).get("result")
        sm, wm = _SESSION_RE.search(text), _WEEK_RE.search(text)
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError):
        # Kill the process group if Popen succeeded but an error occurred later.
        if proc is not None:
            try:
                _kill_group(proc)
            except (ProcessLookupError, TypeError):
                pass
        return bad
    if not sm or not wm:
        return bad
    try:
        new_file = not readings_path.exists() or readings_path.stat().st_size == 0
        with open(readings_path, "a", encoding="utf-8") as fh:
            if new_file:
                fh.write("utc_time\twindow_percent\tweekly_percent\n")
            fh.write(f"{now.strftime('%Y-%m-%dT%H:%M:%SZ')}\t{sm.group(1)}\t{wm.group(1)}\n")
    except OSError:
        return bad
    return {
        "status": "ok",
        "session_pct": float(sm.group(1)) if "." in sm.group(1) else int(sm.group(1)),
        "week_pct": float(wm.group(1)) if "." in wm.group(1) else int(wm.group(1)),
        "session_resets": (sm.group(2) or "").strip() or None,
        "week_resets": (wm.group(2) or "").strip() or None,
    }


# GOV-MEASURE: the cap is derived from MEASURED plan usage (`claude -p /usage`),
# not from a token-burn projection that was wrong three times in one day.
# The read is cached (MEASURE_MIN_GAP between real invocations) so the pulse
# and cloud-dispatch never hammer the CLI; a failed read is cached briefly
# (MEASURE_FAIL_GAP) and reported visibly, then the projection is the fallback.
MEASURE_CACHE_PATH = Path.home() / ".claude" / "usage-governor" / "measured-usage.json"
MEASURE_MIN_GAP = timedelta(minutes=15)
MEASURE_FAIL_GAP = timedelta(minutes=3)
MEASURE_MAX_SEATS = 8
MEASURE_HOLD_ABOVE_SESSION_PCT = 70.0


def _parse_measure_timeout_secs():
    try:
        v = float(os.environ.get("LOKI_USAGE_MEASURE_TIMEOUT") or 40)
        if math.isfinite(v) and v > 0:
            return v
    except (ValueError, TypeError):
        pass
    return 40


def parse_usage_text(out):
    """Parse `claude -p /usage` stdout (json envelope or plain text) into
    {session_pct, week_pct, session_resets, week_resets}. Raises ValueError
    with a short reason when the shape is not recognised."""
    text = out
    try:
        env = json.loads(out)
        if isinstance(env, dict):
            if env.get("is_error"):
                raise ValueError("usage command reported an error")
            text = env.get("result")
    except json.JSONDecodeError:
        pass
    if not isinstance(text, str):
        raise ValueError("unparseable output")
    sm, wm = _SESSION_RE.search(text), _WEEK_RE.search(text)
    if not sm or not wm:
        raise ValueError("unparseable output")

    def num(m):
        v = float(m.group(1))
        return v if 0 <= v <= 100 else None

    sp, wp = num(sm), num(wm)
    if sp is None or wp is None:
        raise ValueError("percent out of range")
    return {
        "session_pct": sp, "week_pct": wp,
        "session_resets": (sm.group(2) or "").strip() or None,
        "week_resets": (wm.group(2) or "").strip() or None,
    }


def _run_usage_command():
    """Run `claude -p /usage --output-format json` bounded by the measure
    timeout. Returns stdout; raises ValueError(reason) on any failure."""
    proc = None
    try:
        proc = subprocess.Popen(
            ["claude", "-p", "/usage", "--output-format", "json"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        try:
            out, _ = proc.communicate(timeout=_parse_measure_timeout_secs())
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            raise ValueError("timeout")
    except OSError as exc:
        raise ValueError("cannot run claude (%s)" % type(exc).__name__)
    if proc.returncode != 0:
        raise ValueError("exit %d" % proc.returncode)
    return out


def measured_usage(cache_path, now):
    """Return {"status":"ok", ..., "read_at": iso, "age_secs": n} or
    {"status":"failed","reason":...}. Real invocations are at most one per
    MEASURE_MIN_GAP (ok) / MEASURE_FAIL_GAP (failed); everything else is
    served from cache_path (None disables the cache file)."""
    cached = None
    if cache_path is not None:
        try:
            with open(cache_path, "r", encoding="utf-8") as fh:
                cached = json.load(fh)
        except (OSError, ValueError):
            cached = None
    if isinstance(cached, dict):
        read_at = parse_ts(cached.get("read_at") or "")
        if read_at is not None and cached.get("status") in ("ok", "failed"):
            age = now - read_at
            gap = MEASURE_MIN_GAP if cached["status"] == "ok" else MEASURE_FAIL_GAP
            if timedelta(0) <= age < gap:
                cached["age_secs"] = int(age.total_seconds())
                return cached
    try:
        result = parse_usage_text(_run_usage_command())
        result["status"] = "ok"
    except ValueError as exc:
        result = {"status": "failed", "reason": str(exc) or "unknown"}
    result["read_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    result["age_secs"] = 0
    if cache_path is not None:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache_path.with_name(cache_path.name + ".%d.tmp" % os.getpid())
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(result, fh)
            os.replace(tmp, cache_path)
        except OSError:
            pass
    return result


def measured_cap(session_pct, week_pct, active_engineers):
    """Seat policy: up to MEASURE_MAX_SEATS; no new seats (hold at the
    engineers already active) while session usage is above 70%; zero at or
    over the D39 ceilings. Returns (cap, reason)."""
    if session_pct >= WINDOW_PCT_CEILING or week_pct >= WEEKLY_PCT_CEILING:
        return 0, "over_ceiling"
    if session_pct > MEASURE_HOLD_ABOVE_SESSION_PCT:
        return min(active_engineers, MEASURE_MAX_SEATS), "hold_above_70_session"
    return MEASURE_MAX_SEATS, "ok"


def _last_wednesday_reset_local(ref_utc: datetime) -> datetime:
    """Most recent Wednesday 13:00 America/New_York at or before ref_utc, kept in local (aware) time."""
    tz = ZoneInfo("America/New_York")
    ref_local = ref_utc.astimezone(tz)
    days_since_wed = (ref_local.weekday() - 2) % 7  # Monday=0 .. Wednesday=2
    candidate = ref_local.replace(hour=13, minute=0, second=0, microsecond=0) - timedelta(days=days_since_wed)
    if candidate > ref_local:
        candidate -= timedelta(days=7)
    return candidate


def last_wednesday_reset(ref_utc: datetime) -> datetime:
    """Most recent Wednesday 13:00 America/New_York at or before ref_utc, as UTC."""
    return _last_wednesday_reset_local(ref_utc).astimezone(timezone.utc)


def next_wednesday_reset(ref_utc: datetime) -> datetime:
    """Next Wednesday 13:00 America/New_York strictly after ref_utc, as UTC.

    The +7 days is done on the LOCAL (zoneinfo-aware) datetime, not after
    converting to UTC: zoneinfo preserves wall-clock time across a
    timedelta add and re-derives the UTC offset for the new date, so 13:00
    ET stays 13:00 ET even when the 7-day span crosses a DST transition. A
    UTC-side +7 days instead adds a fixed 168 hours, landing an hour off in
    any week that crosses DST.
    """
    return (_last_wednesday_reset_local(ref_utc) + timedelta(days=7)).astimezone(timezone.utc)


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
    if not isinstance(entry, dict):
        return None
    ts = entry.get("ts")
    if not isinstance(ts, (int, float)):
        return None
    age = now.timestamp() - ts
    if age < 0 or age > LIVE_FRESHNESS_SECONDS:
        return None
    return entry.get("rate_limits")


def _valid_live_window(value):
    """Return value if it's a dict with a numeric used_percentage, else None.

    A live five_hour/seven_day reading that isn't a dict, or whose
    used_percentage isn't numeric, is unusable as ground truth for the
    downstream percent comparisons (>= WINDOW_PCT_CEILING etc.) -- ignored
    as "no reading" (falls back to the calibration/uncalibrated path)
    instead of crashing (G-01 / E-118).
    """
    if not isinstance(value, dict):
        return None
    pct = value.get("used_percentage")
    if not isinstance(pct, (int, float)) or isinstance(pct, bool):
        return None
    return value


def build_report(root: Path, readings_path: Path, now: datetime, live_log_path: Path, cache_path: Path | None = None, measured: dict | None = None):
    window_start = now - timedelta(hours=WINDOW_HOURS)
    weekly_start = last_wednesday_reset(now)
    readings = load_readings(readings_path)

    # Perf (E-109): min_mtime must be the EARLIEST start of every window this
    # function reads from all_records below, not just weekly_start. Bug found
    # by Tech Lead review (e07a9df1): weekly_start is not always <= window_start
    # -- for up to WINDOW_HOURS after a Wednesday reset, window_start (now-5h)
    # falls BEFORE weekly_start, so a row inside the 5h window but before the
    # reset was wrongly skipped (repro: row 15:00Z, now=18:00Z, 17:00Z reset ->
    # window_start=13:00Z < weekly_start=17:00Z; using weekly_start alone
    # dropped a file whose mtime was 15:00Z). Each reading's own window/weekly
    # ranges (used by the calibration fit below) have the identical exposure,
    # so they are folded into the same min() rather than left as a comment.
    min_mtime_candidates = [window_start, weekly_start]
    for reading_ts, _window_pct, _weekly_pct in readings:
        min_mtime_candidates.append(reading_ts - timedelta(hours=WINDOW_HOURS))
        min_mtime_candidates.append(last_wednesday_reset(reading_ts))
    min_mtime = min(min_mtime_candidates)

    all_records = list(iter_records(root, min_mtime=min_mtime.timestamp(), cache_path=cache_path))

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
    engineer_last_hour_out, engineer_last_hour_opus = sum_usage([
        rec for rec in all_records if rec[1] in ACTIVE_ROLES and rec[2] >= last_hour_start
    ])
    burn_per_engineer_out = (engineer_last_hour_out / active_engineers) if active_engineers else None
    burn_per_engineer_opus = (engineer_last_hour_opus / active_engineers) if active_engineers else None

    # The Chief of Staff's own main-session burn is a fixed load on the plan
    # limits, independent of how many engineers are dispatched: it happens
    # regardless of n, so it is added once per projected hour rather than
    # divided across (or multiplied by) the engineer count.
    cos_last_hour_out, _cos_last_hour_opus = sum_usage([
        rec for rec in all_records if rec[1] == "chief-of-staff" and rec[2] >= last_hour_start
    ])

    live = read_live_rate_limits(now, live_log_path)
    live = live if isinstance(live, dict) else None
    live_five_hour = _valid_live_window(live.get("five_hour")) if live else None
    live_seven_day = _valid_live_window(live.get("seven_day")) if live else None

    # rate here is already tokens-PER-PERCENT (calibrated as tokens/pct), so
    # recovering a percent from a token count is a plain division -- no *100.
    def pct(tokens, rate):
        return (tokens / rate) if rate else None

    window_source = "live" if live_five_hour else ("estimate" if window_n else "uncalibrated")
    weekly_source = "live" if live_seven_day else ("estimate" if weekly_n else "uncalibrated")

    # For "live", count window tokens from the actual plan window start
    # (resets_at - 5h) instead of the rolling now-5h hour buckets: those
    # rolling buckets can include tokens from BEFORE the real window opened,
    # which inflates the tokens side of (tokens / live_pct) and so inflates
    # the derived rate -- silently under-restricting the governor. Falls back
    # to the rolling window when resets_at is missing.
    live_window_start = window_start
    if live_five_hour and isinstance(live_five_hour.get("resets_at"), (int, float)):
        resets_at = datetime.fromtimestamp(live_five_hour["resets_at"], tz=timezone.utc)
        live_window_start = resets_at - timedelta(hours=WINDOW_HOURS)
    live_window_out, live_window_opus = sum_usage(
        [rec for rec in all_records if live_window_start <= rec[2] <= now]
    )

    report_window_out = live_window_out if window_source == "live" else current_window_out
    report_window_opus = live_window_opus if window_source == "live" else current_window_opus

    current_window_pct = None
    if window_source == "live":
        current_window_pct = live_five_hour.get("used_percentage")
    elif window_source == "estimate":
        current_window_pct = pct(current_window_out, window_rate_out)

    current_weekly_pct = None
    if weekly_source == "live":
        current_weekly_pct = live_seven_day.get("used_percentage")
    elif weekly_source == "estimate":
        current_weekly_pct = pct(weekly_out, weekly_rate_out)

    # For a "live" source, derive an implied tokens-per-percent rate from the
    # live reading itself (current_tokens / current_pct) so the same linear
    # projection formula works whether the percent came from a live reading
    # or from calibration. Falls back to the calibrated rate if the live
    # reading is 0% (no ratio available yet).
    def effective_rate(source, current_tokens, current_pct, calibrated_rate):
        if source == "live" and current_pct:
            return current_tokens / current_pct
        if source in ("live", "estimate"):
            return calibrated_rate
        return None

    window_rate_eff = effective_rate(window_source, report_window_out, current_window_pct, window_rate_out)
    weekly_rate_eff = effective_rate(weekly_source, weekly_out, current_weekly_pct, weekly_rate_out)

    # Prefer the live seven_day.resets_at (ground truth from the API) over the
    # computed ET-Wednesday estimate when it is present.
    if live_seven_day and isinstance(live_seven_day.get("resets_at"), (int, float)):
        weekly_reset_at = datetime.fromtimestamp(live_seven_day["resets_at"], tz=timezone.utc)
    else:
        weekly_reset_at = next_wednesday_reset(now)
    hours_to_weekly_reset = max((weekly_reset_at - now).total_seconds() / 3600.0, 0.0)

    # Fail-safe: a window or weekly usage already at/over its ceiling means
    # zero headroom for new engineers, full stop -- independent of whether a
    # burn rate or rate-eff is even available to run the projection loop
    # below (e.g. no active engineers yet this hour).
    max_engineers_next_hour = None
    # Why max_engineers_next_hour stayed None, for human_summary (E-118):
    # "uncalibrated" only when there is genuinely no rate to project with;
    # calibration/live rates can be present while burn_per_engineer_out is
    # still None because active_engineers == 0 (no engineer ran last hour),
    # which is a different, more specific reason to report.
    max_engineers_reason = None
    measured_ok = isinstance(measured, dict) and measured.get("status") == "ok"
    if measured_ok:
        # GOV-MEASURE: real /usage percentages replace the projection.
        current_window_pct = measured["session_pct"]
        current_weekly_pct = measured["week_pct"]
        window_source = weekly_source = "measured"
        max_engineers_next_hour, max_engineers_reason = measured_cap(
            current_window_pct, current_weekly_pct, active_engineers)
    over_window = current_window_pct is not None and current_window_pct >= WINDOW_PCT_CEILING
    over_weekly = current_weekly_pct is not None and current_weekly_pct >= WEEKLY_PCT_CEILING
    if measured_ok:
        pass
    elif over_window or over_weekly:
        max_engineers_next_hour = 0
        max_engineers_reason = "over_ceiling"
    elif not (window_rate_eff and weekly_rate_eff):
        max_engineers_reason = "uncalibrated"
    elif not burn_per_engineer_out:
        max_engineers_reason = "no_active_engineers"
    else:
        n = 0
        best = 0
        while n <= 500:
            proj_next_hour = cos_last_hour_out + burn_per_engineer_out * n
            if window_source == "live":
                # The live window is fixed until its reset; nothing ages out
                # of it mid-window, so next hour's burn simply adds on top.
                proj_window_tokens = live_window_out + proj_next_hour
            else:
                # Rolling 5h estimate: the oldest hour bucket ages out as the
                # next hour arrives.
                proj_window_tokens = current_window_out - oldest_hour_out + proj_next_hour
            # Gate against the projected usage AT the weekly reset, not just
            # one hour out: sustaining this same burn rate until the reset
            # must not cross the weekly ceiling either.
            proj_weekly_tokens = weekly_out + proj_next_hour * hours_to_weekly_reset
            proj_window_pct = pct(proj_window_tokens, window_rate_eff)
            proj_weekly_pct = pct(proj_weekly_tokens, weekly_rate_eff)
            if proj_window_pct <= WINDOW_PCT_CEILING and proj_weekly_pct <= WEEKLY_PCT_CEILING:
                best = n
                n += 1
            else:
                break
        max_engineers_next_hour = best
        max_engineers_reason = "ok"

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
            "start": (live_window_start if window_source == "live" else window_start).isoformat(),
            "current_tokens_output": report_window_out,
            "current_tokens_opus_weighted": report_window_opus,
            "current_pct": current_window_pct,
            "resets_at": live_five_hour.get("resets_at") if live_five_hour else None,
            "resets_text": measured.get("session_resets") if measured_ok else None,
        },
        "weekly": {
            "source": weekly_source,
            "start": weekly_start.isoformat(),
            "current_tokens_output": weekly_out,
            "current_tokens_opus_weighted": weekly_opus,
            "current_pct": current_weekly_pct,
            "resets_at": live_seven_day.get("resets_at") if live_seven_day else None,
            "resets_text": measured.get("week_resets") if measured_ok else None,
        },
        "governor": {
            "active_engineers_last_hour": active_engineers,
            "burn_per_engineer_output_last_hour": burn_per_engineer_out,
            "burn_per_engineer_opus_weighted_last_hour": burn_per_engineer_opus,
            "chief_of_staff_burn_output_last_hour": cos_last_hour_out,
            "last_hour_output_tokens": last_hour_out,
            "hours_to_weekly_reset": hours_to_weekly_reset,
            "max_engineers_next_hour": max_engineers_next_hour,
            "max_engineers_reason": max_engineers_reason,
            "cap_basis": "measured" if measured_ok else "projected",
        },
        "measured": measured if isinstance(measured, dict) else None,
        "limit_events": {
            "last_occurrence": last_limit_event,
            "count_last_hour": limit_event_count,
        },
    }
    return report


def cap_basis_label(report):
    """Visible provenance of the cap: measured, or projected with the reason
    the /usage read failed (GOV-MEASURE)."""
    m = report.get("measured")
    if report["governor"].get("cap_basis") == "measured" and m:
        return "measured, read %dm ago" % (int(m.get("age_secs", 0)) // 60)
    if m and m.get("status") == "failed":
        return "projected; /usage read failed: %s" % m.get("reason", "unknown")
    return "projected; /usage not read"


def human_summary(report):
    lines = []
    w = report["window"]
    k = report["weekly"]
    g = report["governor"]
    cal = report["calibration"]

    lines.append(f"Usage governor @ {report['generated_at']} (root: {report['root']})")
    lines.append(f"Readings on file: {cal['readings_count']}")

    if w["current_pct"] is not None:
        tag = {"live": "LIVE", "measured": "MEASURED"}.get(w["source"], "ESTIMATE")
        lines.append(
            f"5h window [{tag}]: {w['current_pct']:.1f}% used, "
            f"{w['current_tokens_output']:,} output tokens since {w['start']}"
        )
    else:
        lines.append(f"5h window: uncalibrated ({w['current_tokens_output']:,} output tokens since {w['start']})")

    if k["current_pct"] is not None:
        tag = {"live": "LIVE", "measured": "MEASURED"}.get(k["source"], "ESTIMATE")
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
        lines.append(f"Max engineers for next hour: {g['max_engineers_next_hour']} ({cap_basis_label(report)})")
    elif g.get("max_engineers_reason") == "no_active_engineers":
        lines.append("Max engineers for next hour: no active engineers, cannot project")
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
    parser.add_argument(
        "--read-usage", action="store_true",
        help="calibrate from live `claude -p /usage` before reporting (E-163)",
    )
    parser.add_argument(
        "--measure", dest="measure", action="store_true", default=None,
        help="derive the cap from a cached `claude -p /usage` read (default; off with --now or LOKI_USAGE_MEASURE=0)",
    )
    parser.add_argument("--no-measure", dest="measure", action="store_false", help="projection only")
    parser.add_argument(
        "--measure-cache", default=str(MEASURE_CACHE_PATH),
        help="path to the cached /usage read (15 min between real invocations)",
    )
    parser.add_argument("--json", action="store_true", help="print JSON instead of a human summary")
    parser.add_argument(
        "--cache-path",
        default=str(CACHE_PATH),
        help="path to the per-file transcript parse cache (E-109)",
    )
    parser.add_argument(
        "--no-cache", action="store_true", help="never read or write the transcript parse cache"
    )
    args = parser.parse_args(argv)

    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        parser.error("--now must be a parseable ISO8601 timestamp")

    live = live_read_usage(Path(args.readings), now) if args.read_usage else None
    cache_path = None if args.no_cache else Path(args.cache_path)
    do_measure = args.measure
    if do_measure is None:
        do_measure = args.now is None and os.environ.get("LOKI_USAGE_MEASURE") != "0"
    measured = None
    if do_measure:
        measured = measured_usage(None if args.no_cache else Path(args.measure_cache), now)
    report = build_report(Path(args.root), Path(args.readings), now, Path(args.live_log),
                          cache_path=cache_path, measured=measured)

    if live is not None:
        report["live_reading"] = live
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(human_summary(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
