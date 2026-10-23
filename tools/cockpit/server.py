#!/usr/bin/env python3
"""CEO cockpit: a local, read-mostly view of the company (see SPEC.md).

Python 3 standard library only. Binds loopback only. The single write path is
POST /api/queue, which appends one row to docs/v10/FOUNDER-QUEUE.md.

Every data source degrades to an explicit UNKNOWN (or UNMEASURED) with the
reason in `error`; a missing value is None, never 0.
"""
import argparse
import fcntl
import json
import os
import re
import secrets
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PANELS = ["pulse", "releases", "board", "agents", "okrs", "roi", "queue"]
BOARD_TOKENS = ["ready", "building", "review", "review-blocked", "approved",
                "merged", "released", "blocked", "rejected", "parked"]
ACTIVE_TOKENS = ["building", "review", "review-blocked", "approved", "blocked"]
TIER_BUDGET_MIN = {"LOW": 15, "MEDIUM": 30, "HIGH": 60}
DEFAULT_TIMEOUT = 20
PULSE_TIMEOUT = 60
QUEUE_CAP = 2000
BODY_CAP = 8192
STALE_SEAT_MIN = 60
BASIS_STALE_DAYS = 90
ENV_ALLOW = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR",
             "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG",
             "GH_CONFIG_DIR", "XDG_CONFIG_HOME")


class Ctx:
    """Resolved paths and settings; every path comes from flags or env."""

    def __init__(self, root):
        e = os.environ.get
        self.root = root
        self.runtime = e("COCKPIT_RUNTIME_DIR") or os.path.join(root, ".loki", "cockpit")
        self.board = e("BOARD_MD") or os.path.join(root, "docs/v10/BOARD.md")
        self.queue = e("FOUNDER_QUEUE_MD") or os.path.join(root, "docs/v10/FOUNDER-QUEUE.md")
        self.retro = e("RETRO_MD") or os.path.join(root, "docs/v10/RETRO-2026.md")
        self.readings = e("USAGE_READINGS_TSV") or os.path.join(root, "docs/v10/usage-readings.tsv")
        self.cost_file = e("COST_HISTORY_FILE") or os.path.join(root, ".loki/cost-history.jsonl")
        self.status_dir = e("COCKPIT_STATUS_DIR") or os.path.join(root, ".loki/company/status")
        self.company_dir = e("COCKPIT_COMPANY_DIR") or os.path.join(root, ".loki/company")
        self.schedules = e("COCKPIT_SCHEDULES_JSON") or os.path.join(root, ".loki/triggers/schedules.json")
        self.okrs = e("COCKPIT_OKRS_JSON") or os.path.join(root, ".loki/company/okrs.json")
        self.scoreboard = e("COCKPIT_SCOREBOARD_DIR") or os.path.join(root, ".loki/company/scoreboard")
        self.agents_dir = e("COCKPIT_AGENTS_DIR") or os.path.join(root, ".claude/agents")
        self.basis = e("COCKPIT_ROI_BASIS") or os.path.join(HERE, "roi-basis.json")
        self.timeout = float(e("COCKPIT_CMD_TIMEOUT") or DEFAULT_TIMEOUT)
        self.pulse_timeout = float(e("COCKPIT_PULSE_TIMEOUT") or PULSE_TIMEOUT)
        self.first_wait = float(e("COCKPIT_FIRST_WAIT") or 6)
        self.npm_cmd = shlex.split(e("COCKPIT_NPM_CMD") or "npm view loki-mode time dist-tags --json")
        self.gh_cmd = shlex.split(e("COCKPIT_GH_CMD") or (
            "gh run list --workflow release.yml --limit 20 --json "
            "databaseId,status,conclusion,headSha,createdAt,displayTitle,url"))
        self.pulse_cmd = shlex.split(e("COCKPIT_PULSE_CMD") or "bash scripts/v10-pulse.sh")
        self.usage_cmd = shlex.split(e("COCKPIT_USAGE_CMD") or
                                     "%s scripts/usage-governor.py --json" % sys.executable)
        self.cost_cmd = [sys.executable, "tools/cost-history.py", "report", "--json",
                         "--file", self.cost_file]

    def now(self):
        v = os.environ.get("COCKPIT_NOW")
        if v:
            return parse_iso(v) or datetime.now(timezone.utc)
        return datetime.now(timezone.utc)


def parse_iso(s):
    if not isinstance(s, str):
        return None
    s = s.strip().replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def age_min(ctx, ts):
    d = parse_iso(ts)
    if d is None:
        return None
    return round((ctx.now() - d).total_seconds() / 60.0, 1)


def child_env(ctx, extra=None):
    env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
    env["PULSE_REPO_ROOT"] = ctx.root
    if extra:
        env.update(extra)
    return env


def run_cmd(ctx, argv, timeout, extra_env=None):
    """Run argv (never a shell) with a hard timeout. Returns (rc, out, err).

    rc is None when the command could not run or timed out; err says why.
    The cockpit kills only the process group it started itself.
    """
    try:
        p = subprocess.Popen(argv, cwd=ctx.root, env=child_env(ctx, extra_env),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    except (OSError, ValueError) as ex:
        return None, "", "cannot run %s: %s" % (argv[0] if argv else "?", ex)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
        try:
            p.communicate(timeout=5)
        except Exception:
            pass
        return None, "", "timed out after %ss: %s" % (timeout, " ".join(argv[:3]))
    return (p.returncode, out.decode("utf-8", "replace"),
            err.decode("utf-8", "replace").strip()[-300:])


def panel(ctx, status, source_cmd, data=None, error=None):
    return {"status": status, "as_of": iso(ctx.now()), "source_cmd": source_cmd,
            "data": data if data is not None else {}, "error": error}


def unknown(ctx, source_cmd, error):
    return panel(ctx, "UNKNOWN", source_cmd, None, error)


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(), None
    except OSError as ex:
        return None, "cannot read %s: %s" % (path, ex.strerror or ex)


def read_json(path):
    txt, err = read_text(path)
    if err:
        return None, err
    try:
        return json.loads(txt), None
    except ValueError as ex:
        return None, "invalid JSON in %s: %s" % (path, ex)


def val(x):
    return x.get("value") if isinstance(x, dict) else x


# ---------------------------------------------------------------- pulse
def collect_pulse(ctx):
    src = " ".join(ctx.pulse_cmd)
    rc, out, err = run_cmd(ctx, ctx.pulse_cmd, ctx.pulse_timeout)
    if rc is None:
        return unknown(ctx, src, err)
    metrics, violations, unknown_list, stale = {}, [], [], []
    in_viol = False
    for line in out.splitlines():
        if line.startswith("=== VIOLATIONS"):
            in_viol = True
            continue
        if line.startswith("==="):
            continue
        if in_viol and line.startswith("VIOLATION:"):
            violations.append(line[len("VIOLATION:"):].strip())
            continue
        if line.startswith("UNKNOWN metrics:"):
            unknown_list = [x.strip() for x in line.split(":", 1)[1].split(",") if x.strip()]
            continue
        if line.startswith("STALE"):
            stale.append(line.strip())
            continue
        m = re.match(r"^([A-Za-z][^:]{0,100}): (.*)$", line)
        if m and not in_viol and m.group(1) not in ("NEXT ACTION",):
            metrics[m.group(1)] = m.group(2)
    status = {0: "OK", 1: "VIOLATION", 2: "UNKNOWN"}.get(rc)
    if status is None:
        return unknown(ctx, src, "pulse exited %s: %s" % (rc, err))
    data = {"exit_code": rc, "metrics": metrics, "violations": violations,
            "unknown_metrics": unknown_list, "stale": stale}
    error = None
    if status == "UNKNOWN":
        error = "pulse reported unknown metrics: " + (", ".join(unknown_list) or "unspecified")
    return panel(ctx, status, src, data, error)


# ------------------------------------------------------------- releases
def collect_releases(ctx):
    src = "%s ; %s ; VERSION ; git describe" % (" ".join(ctx.npm_cmd), " ".join(ctx.gh_cmd))
    errors, data = [], {"npm_label": "registry view (not proof a tarball is fetchable)"}
    now = ctx.now()

    rc, out, err = run_cmd(ctx, ctx.npm_cmd, ctx.timeout)
    npm = None
    if rc != 0:
        errors.append("npm: " + (err or "exit %s" % rc))
    else:
        try:
            npm = json.loads(out)
        except ValueError as ex:
            errors.append("npm: invalid JSON: %s" % ex)
    if isinstance(npm, dict):
        tags = npm.get("dist-tags") or {}
        times = npm.get("time") or {}
        vers = []
        for v, t in times.items():
            d = parse_iso(t) if v not in ("created", "modified") else None
            if d:
                vers.append((d, v))
        vers.sort()
        last = vers[-20:]
        data["latest"], data["next"] = tags.get("latest"), tags.get("next")
        data["versions"] = [{"version": v, "published": iso(d)} for d, v in reversed(last)]
        if vers:
            data["last_publish_minutes_ago"] = round((now - vers[-1][0]).total_seconds() / 60.0, 1)
        data["releases_last_hour"] = sum(1 for d, _ in vers if now - d <= timedelta(hours=1))
        data["releases_last_24h"] = sum(1 for d, _ in vers if now - d <= timedelta(hours=24))
    elif npm is not None:
        errors.append("npm: unexpected JSON shape")

    rc, out, err = run_cmd(ctx, ctx.gh_cmd, ctx.timeout)
    runs = None
    if rc != 0:
        errors.append("gh: " + (err or "exit %s" % rc))
    else:
        try:
            runs = json.loads(out)
        except ValueError as ex:
            errors.append("gh: invalid JSON: %s" % ex)
    if isinstance(runs, list):
        data["runs"] = [{k: r.get(k) for k in ("databaseId", "status", "conclusion", "headSha",
                                                "createdAt", "displayTitle", "url")}
                        for r in runs if isinstance(r, dict)]
    elif runs is not None:
        errors.append("gh: unexpected JSON shape")

    vtxt, verr = read_text(os.path.join(ctx.root, "VERSION"))
    data["version_file"] = vtxt.strip() if vtxt is not None else None
    if verr:
        errors.append("VERSION: " + verr)
    rc, out, _ = run_cmd(ctx, ["git", "-C", ctx.root, "describe", "--tags", "--abbrev=0"], ctx.timeout)
    data["last_tag"] = out.strip() if rc == 0 and out.strip() else None
    rc, out, _ = run_cmd(ctx, ["git", "-C", ctx.root, "log", "-1", "--format=%H", "--", "VERSION"], ctx.timeout)
    vsha = out.strip() if rc == 0 else ""
    data["version_sha"] = vsha or None

    flags, violation = [], False
    if data.get("version_file") and data.get("next") and data["version_file"] != data["next"]:
        flags.append("VERSION %s differs from npm next %s" % (data["version_file"], data["next"]))
    if data.get("next") and data.get("latest") and data["next"] != data["latest"]:
        flags.append("npm next %s differs from latest %s" % (data["next"], data["latest"]))
    if vsha and isinstance(data.get("runs"), list):
        for r in data["runs"]:
            if (r.get("headSha") or "").startswith(vsha[:12]) and r.get("conclusion") == "failure":
                violation = True
                flags.append("release run %s failed on the newest VERSION SHA %s" % (r.get("databaseId"), vsha[:8]))
                break
    data["flags"] = flags
    if violation:
        return panel(ctx, "VIOLATION", src, data, "; ".join(errors) or None)
    if errors:
        return panel(ctx, "UNKNOWN", src, data, "; ".join(errors))
    return panel(ctx, "OK", src, data, None)


# ---------------------------------------------------------------- board
def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_board(text):
    rows, unparsed = [], []
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = split_row(line)
        if not cells or cells[0] in ("ID", "") or set(cells[0]) <= set("-: "):
            continue
        status_cell = cells[5] if len(cells) >= 7 else ""
        m = re.match(r"^([a-z-]+)@(\d{4}-\d\d-\d\dT\d\d:\d\dZ)$", status_cell)
        if len(cells) >= 7 and m and m.group(1) in BOARD_TOKENS:
            rows.append({"id": cells[0], "owner": cells[1], "tier": cells[4].upper(),
                         "token": m.group(1), "since": m.group(2),
                         "notes": "|".join(cells[6:])[:300]})
        else:
            unparsed.append(cells[0])
    return rows, unparsed


def collect_board(ctx):
    src = "read " + ctx.board
    text, err = read_text(ctx.board)
    if err:
        return unknown(ctx, src, err)
    rows, unparsed = parse_board(text)
    counts = {t: 0 for t in BOARD_TOKENS}
    for r in rows:
        counts[r["token"]] += 1
    active = []
    for r in rows:
        if r["token"] in ACTIVE_TOKENS:
            a = age_min(ctx, r["since"])
            budget = TIER_BUDGET_MIN.get(r["tier"])
            active.append({**r, "age_min": a, "budget_min": budget,
                           "over_budget": (a is not None and budget is not None and a > budget)})
    data = {"counts": counts, "active": active, "unparsed": unparsed, "rows_parsed": len(rows),
            "ready_below_30": counts["ready"] < 30, "ready_target": 30}
    if not rows:
        return unknown(ctx, src, "no BOARD rows parsed from " + ctx.board)
    return panel(ctx, "OK", src, data, None)


# --------------------------------------------------------------- agents
def agent_slugs(ctx):
    try:
        return sorted(f[:-3] for f in os.listdir(ctx.agents_dir) if f.endswith(".md")), None
    except OSError as ex:
        return [], "cannot list %s: %s" % (ctx.agents_dir, ex.strerror or ex)


def root_causes(path):
    txt, _ = read_text(path)
    if not txt:
        return []
    m = re.search(r"^## Root causes owned[^\n]*\n(.*?)(?=^## |\Z)", txt, re.S | re.M)
    if not m:
        return []
    out, cur = [], None
    for line in m.group(1).splitlines():
        if line.startswith("- "):
            cur = line[2:].strip()
            out.append(cur)
        elif cur is not None and line.startswith("  ") and line.strip():
            out[-1] += " " + line.strip()
    return out


def seat_cadence(ctx):
    """{seat: cron_expr} for `seat <name>` entries, plus the cron helpers (shared with the daemon)."""
    import importlib.util
    mod_path = os.path.join(HERE, "..", "..", "autonomy", "trigger-schedule.py")
    spec = importlib.util.spec_from_file_location("trigger_schedule_cockpit", mod_path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        return {}, None
    data, _ = read_json(ctx.schedules)
    rows = data if isinstance(data, list) else (data or {}).get("schedules", []) if isinstance(data, dict) else []
    out = {}
    for r in rows:
        parts = str(r.get("action", "")).split()
        if len(parts) == 2 and parts[0] == "seat" and r.get("enabled", True):
            out[parts[1]] = r.get("cron_expr")
    return out, mod


def seat_tick(ctx, slug, cadence, mod):
    """Last tick, outcome, next due and staleness for one seat (2x interval = STALE)."""
    d, err = read_json(os.path.join(ctx.company_dir, slug, "last.json"))
    t = {"last_tick": None, "outcome": None, "interval_min": None, "next_due": None,
         "state": "NO-TICK", "age_min": None}
    if isinstance(d, dict):
        t["last_tick"], t["outcome"] = d.get("ts"), d.get("outcome")
        t["age_min"] = age_min(ctx, d.get("ts"))
    cron = cadence.get(slug)
    if cron and mod:
        try:
            t["interval_min"] = mod.interval_minutes(cron)
            local = ctx.now().astimezone()
            nxt = mod.next_fire(cron, local.replace(tzinfo=None))
            if nxt:
                t["next_due"] = nxt.astimezone().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            pass
    if t["last_tick"] is not None:
        t["state"] = "OK"
        if t["interval_min"] and (t["age_min"] is None or t["age_min"] > 2 * t["interval_min"]):
            t["state"] = "STALE"
    return t


def collect_agents(ctx):
    src = "read %s/<slug>.json for slugs in %s" % (ctx.status_dir, ctx.agents_dir)
    slugs, err = agent_slugs(ctx)
    if err or not slugs:
        return unknown(ctx, src, err or "no agent files in " + ctx.agents_dir)
    seats, have = [], 0
    cadence, mod = seat_cadence(ctx)
    for slug in slugs:
        seat = {"slug": slug, "state": "UNKNOWN", "root_causes":
                root_causes(os.path.join(ctx.agents_dir, slug + ".md"))}
        seat["tick"] = tick = seat_tick(ctx, slug, cadence, mod)
        d, e = read_json(os.path.join(ctx.status_dir, slug + ".json"))
        if e or not isinstance(d, dict):
            seat["error"] = e or "status file is not an object"
            seat["state"] = "UNKNOWN"
        else:
            have += 1
            for k in ("seat", "model", "doing", "slice", "since", "next", "blocked_on", "updated"):
                seat[k] = d.get(k)
            a = age_min(ctx, d.get("updated"))
            seat["updated_min_ago"] = a
            seat["state"] = "STALE" if (a is None or a > STALE_SEAT_MIN) else "OK"
            seat["blocked"] = bool(d.get("blocked_on"))
        if tick["state"] == "STALE":
            seat["state"] = "STALE"
        elif seat["state"] == "UNKNOWN" and tick["state"] == "OK":
            seat["state"] = "OK"
            seat.pop("error", None)
            have += 1
        seats.append(seat)
    data = {"seats": seats, "reporting": have, "total": len(slugs)}
    if have == 0:
        return panel(ctx, "UNKNOWN", src, data, "no seat has written a status file in " + ctx.status_dir)
    return panel(ctx, "OK", src, data, None)


# ----------------------------------------------------------------- okrs
def parse_retro_items(text):
    m = re.search(r"^## 6\.[^\n]*\n(.*?)(?=^## 7\.|^---\s*$|\Z)", text, re.S | re.M)
    if not m:
        return []
    items = []
    for line in m.group(1).splitlines():
        im = re.match(r"^(\d+)\. (.*)$", line)
        if not im:
            continue
        body = im.group(2)
        title = re.split(r"(?<=[.])\s", body, maxsplit=1)[0].strip()
        om = re.search(r"Owner:\s*(.+?)\.\s+Metric:", body) or re.search(r"Owner:\s*([^.]+)", body)
        mm = re.search(r"Metric:\s*(.*)$", body)
        items.append({"n": int(im.group(1)), "title": title,
                      "owner": om.group(1).strip() if om else None,
                      "metric": mm.group(1).strip() if mm else None})
    return items


def collect_okrs(ctx):
    src = "read %s section 6 ; read %s" % (ctx.retro, ctx.okrs)
    text, err = read_text(ctx.retro)
    if err:
        return unknown(ctx, src, err)
    items = parse_retro_items(text)
    if not items:
        return unknown(ctx, src, "no numbered items parsed from section 6 of " + ctx.retro)
    cur, cerr = read_json(ctx.okrs)
    if not isinstance(cur, dict):
        cur = {}
    measured = 0
    for it in items:
        c = cur.get(str(it["n"]))
        if not isinstance(c, dict) or c.get("value") is None:
            it["state"], it["current"] = "UNMEASURED", None
        elif not c.get("source_cmd"):
            it["state"], it["current"] = "UNCITED", c
        else:
            it["state"], it["current"] = "MEASURED", c
            measured += 1
    data = {"items": items, "measured": measured, "total": len(items),
            "values_note": (cerr if cerr else None)}
    return panel(ctx, "OK" if measured else "UNMEASURED", src, data,
                 None if measured else "no OKR has a measured current value" + (": " + cerr if cerr else ""))


# ------------------------------------------------------------------ roi
def last_readings(path):
    txt, err = read_text(path)
    if err:
        return None, err
    rows = [l.split("\t") for l in txt.splitlines() if l.strip() and not l.startswith("utc_time")]
    rows = [r for r in rows if len(r) >= 3]
    if not rows:
        return None, "no readings in " + path
    r = rows[-1]
    try:
        return {"latest_utc": r[0], "window_percent": float(r[1]), "weekly_percent": float(r[2]),
                "n": len(rows), "unit": "plan-usage percent (not tokens, not dollars)"}, None
    except ValueError:
        return None, "unparsable last reading in " + path


def collect_roi(ctx):
    src = "read %s ; %s ; %s ; read %s" % (ctx.basis, " ".join(ctx.cost_cmd),
                                           " ".join(ctx.usage_cmd), ctx.readings)
    basis, berr = read_json(ctx.basis)
    if not isinstance(basis, dict):
        return unknown(ctx, src, berr or "ROI basis is not an object")
    now = ctx.now()
    sd = parse_iso(basis.get("snapshot_date"))
    basis_stale = sd is None or (now - sd).days > BASIS_STALE_DAYS
    _rc, sha, _e = run_cmd(ctx, ["git", "-C", ctx.root, "log", "-1", "--format=%h", "--", ctx.basis], ctx.timeout)
    notes = []

    # cost side
    plan = val(basis.get("plan_usd_per_month"))
    per_day = round(plan * 12 / 365.0, 2) if isinstance(plan, (int, float)) else None
    usage, uerr = last_readings(ctx.readings)
    if uerr:
        notes.append("usage readings: " + uerr)
    gov = None
    rc, out, err = run_cmd(ctx, ctx.usage_cmd, ctx.timeout)
    if rc == 0:
        try:
            g = json.loads(out)
            gov = {k: g.get(k) for k in ("weekly", "window") if isinstance(g, dict)}
        except ValueError:
            notes.append("usage governor: invalid JSON")
    else:
        notes.append("usage governor: " + (err or "exit %s" % rc))
    rc, out, err = run_cmd(ctx, ctx.cost_cmd, ctx.timeout)
    metered = {"state": "UNMEASURED", "reason": err or "no output"}
    if out.strip():
        try:
            r = json.loads(out)
            if r.get("status") == "no_history" or not r.get("measured"):
                metered = {"state": "UNMEASURED", "reason": r.get("why") or "no measured runs"}
            else:
                costs = [c for c in r.get("costs", []) if isinstance(c, (int, float))]
                metered = {"state": "MEASURED", "runs": r.get("runs"), "measured_runs": r.get("measured"),
                           "unmeasured_runs": (r.get("runs") or 0) - (r.get("measured") or 0),
                           "total_usd": round(sum(costs), 4), "median_usd": r.get("median_usd")}
        except ValueError:
            metered = {"state": "UNMEASURED", "reason": "cost-history output is not JSON"}
    cost = {"plan_usd_per_month": plan, "plan_usd_per_day": per_day,
            "daily_budget_usd": val(basis.get("daily_budget_usd")),
            "label": "MEASURED" if metered["state"] == "MEASURED" else "ESTIMATE",
            "label_note": "ESTIMATE = plan proration (plan x 12 / 365 per day); MEASURED only from cost-history rows",
            "usage": usage, "governor": gov, "metered": metered}

    # value side
    comp = basis.get("annual_total_comp_usd") or {}
    overhead = val(basis.get("overhead_multiplier"))
    hours = val(basis.get("work_hours_per_year"))
    tiers = basis.get("seat_tier") or {}
    default_tier = basis.get("default_tier", "senior")
    ok_rate = isinstance(overhead, (int, float)) and isinstance(hours, (int, float)) and hours > 0

    def rate(tier):
        c = comp.get(tier)
        return round(c * overhead / hours, 2) if ok_rate and isinstance(c, (int, float)) else None

    slugs, _ = agent_slugs(ctx)
    payroll = None
    if slugs and isinstance(overhead, (int, float)):
        parts = [comp.get(tiers.get(s, default_tier)) for s in slugs]
        if all(isinstance(p, (int, float)) for p in parts):
            payroll = {"seats": len(slugs), "annual_usd": round(sum(parts) * overhead),
                       "per_day_usd": round(sum(parts) * overhead / 365.0, 2),
                       "label": "ASSUMPTION (tier map and overhead multiplier)"}
    hpo = val((basis.get("hours_per_outcome") or {}).get("verified_slice"))
    value = {"formula": "hourly rate = annual total comp x overhead multiplier / work hours per year; "
                        "value = sum over released slices in window of hours per outcome x hourly rate of the owning seat tier",
             "hourly_rates": {t: rate(t) for t in comp}, "standing_payroll_equivalent": payroll,
             "hours_per_outcome_verified_slice": hpo, "window_days": 7}
    multiple, weaker = None, None
    if not isinstance(hpo, (int, float)):
        value["state"] = "UNMEASURED"
        value["reason"] = "hours_per_outcome.verified_slice is unset in roi-basis.json; no ROI multiple is printed"
        value["human_equivalent_usd"] = None
    else:
        btext, _ = read_text(ctx.board)
        rows, _ = parse_board(btext or "")
        win = [r for r in rows if r["token"] == "released" and (age_min(ctx, r["since"]) or 1e9) <= 7 * 24 * 60]
        total = 0.0
        for r in win:
            t = next((tiers[s] for s in tiers if s in r["owner"]), default_tier)
            rt = rate(t)
            total += (hpo * rt) if rt is not None else 0.0
        value.update({"state": "ESTIMATE", "released_slices_in_window": len(win),
                      "human_equivalent_usd": round(total, 2)})
        if per_day is not None and per_day > 0 and total > 0:
            multiple, weaker = round(total / (per_day * 7), 2), "ASSUMPTION"
    roi = {"multiple": multiple, "weaker_side_label": weaker,
           "note": None if multiple is not None else "no ROI multiple: a side is unmeasured"}

    score = {"state": "UNMEASURED", "reason": "no scoreboard files in " + ctx.scoreboard,
             "cost_per_verified_outcome_usd": None}
    try:
        files = sorted(f for f in os.listdir(ctx.scoreboard) if f.endswith(".json"))
    except OSError:
        files = []
    if files:
        d, _ = read_json(os.path.join(ctx.scoreboard, files[-1]))
        c = d.get("cost_per_verified_outcome_usd") if isinstance(d, dict) else None
        score = {"state": "MEASURED" if c is not None else "UNMEASURED", "file": files[-1],
                 "cost_per_verified_outcome_usd": c,
                 "reason": None if c is not None else "latest scoreboard file has no cost_per_verified_outcome_usd"}

    data = {"cost": cost, "value": value, "roi": roi, "scoreboard": score,
            "basis": {"path": ctx.basis, "git_sha": sha.strip() or None, "source_url": basis.get("source_url"),
                      "snapshot_date": basis.get("snapshot_date"), "stale": basis_stale,
                      "stale_note": "snapshot older than %d days" % BASIS_STALE_DAYS if basis_stale else None},
            "notes": notes}
    measured = metered["state"] == "MEASURED"
    return panel(ctx, "OK" if (measured and multiple is not None) else "UNMEASURED", src, data,
                 None if multiple is not None else "ROI multiple withheld: " + (
                     "value side unmeasured" if value["state"] == "UNMEASURED" else "cost side unmeasured"))


# ---------------------------------------------------------------- queue
def queue_rows(text):
    rows = []
    for line in text.splitlines():
        m = re.match(r"^\|\s*(\d+)\s*\|\s*(\d{4}-\d\d-\d\d)\s*\|\s*(.*?)\s*\|", line)
        if m:
            rows.append({"n": int(m.group(1)), "date": m.group(2), "item": m.group(3)[:240]})
    return rows


def collect_queue(ctx):
    src = "read " + ctx.queue
    text, err = read_text(ctx.queue)
    if err:
        return unknown(ctx, src, err)
    rows = queue_rows(text)
    data = {"rows_total": len(rows), "max_number": max([r["n"] for r in rows], default=None),
            "cockpit_rows": sum(1 for r in rows if r["item"].startswith("[cockpit]")),
            "last": rows[-5:], "max_item_chars": QUEUE_CAP}
    return panel(ctx, "OK", src, data, None)


COLLECTORS = {"pulse": (collect_pulse, 90), "releases": (collect_releases, 60),
              "board": (collect_board, 5), "agents": (collect_agents, 5),
              "okrs": (collect_okrs, 15), "roi": (collect_roi, 60), "queue": (collect_queue, 3)}


# ---------------------------------------------------------------- cache
class Store:
    """Per-panel cache refreshed in a background thread so a request never
    waits on a slow shell-out beyond the first-collection wait."""

    def __init__(self, ctx):
        self.ctx, self.lock = ctx, threading.Lock()
        self.entries, self.inflight = {}, {}

    def _run(self, name):
        fn = COLLECTORS[name][0]
        try:
            p = fn(self.ctx)
        except Exception as ex:  # a collector bug must surface as UNKNOWN, not a 500
            p = unknown(self.ctx, name, "collector crashed: %r" % (ex,))
        with self.lock:
            self.entries[name] = (time.time(), p)
            self.inflight.pop(name, None)
        try:
            d = os.path.join(self.ctx.runtime, "cache")
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name + ".json"), "w") as f:
                json.dump(p, f)
        except OSError:
            pass

    def kick(self, name):
        with self.lock:
            e = self.entries.get(name)
            if (e and time.time() - e[0] < COLLECTORS[name][1]) or name in self.inflight:
                return self.inflight.get(name)
            t = threading.Thread(target=self._run, args=(name,), daemon=True)
            self.inflight[name] = t
        t.start()
        return t

    def get(self, name, wait):
        t = self.kick(name)
        with self.lock:
            e = self.entries.get(name)
        if e is None:
            if t is not None:
                t.join(wait)
            with self.lock:
                e = self.entries.get(name)
        if e is None:
            return unknown(self.ctx, name, "first collection still in progress; retry shortly")
        p = dict(e[1])
        p["cache_age_s"] = round(time.time() - e[0], 1)
        return p

    def invalidate(self, name):
        with self.lock:
            self.entries.pop(name, None)

    def snapshot(self, names, wait):
        for n in names:
            self.kick(n)
        deadline = time.time() + wait
        out = {}
        for n in names:
            out[n] = self.get(n, max(0.0, deadline - time.time()))
        return {"generated_at": iso(self.ctx.now()), "repo_root": self.ctx.root, "panels": out}


# --------------------------------------------------------- queue append
def sanitize(s):
    s = re.sub(r"[\r\n\t]+", " ", s)
    s = re.sub(r"[\x00-\x1f\x7f]", "", s)
    return s.replace("|", "/").strip()


class QueueError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def append_queue(ctx, item, why):
    if not isinstance(item, str) or not isinstance(why, str):
        raise QueueError(400, "item and why must be strings")
    if len(item) > QUEUE_CAP or len(why) > QUEUE_CAP:
        raise QueueError(413, "item or why exceeds %d characters" % QUEUE_CAP)
    item, why = sanitize(item), sanitize(why) or "founder command"
    if not item:
        raise QueueError(400, "item is empty")
    os.makedirs(ctx.runtime, exist_ok=True)
    lock_path = os.path.join(ctx.runtime, "FOUNDER-QUEUE.md.lock")
    with open(lock_path, "a") as lf:
        deadline = time.time() + 5
        while True:
            try:
                fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.time() > deadline:
                    raise QueueError(503, "queue lock busy")
                time.sleep(0.05)
        try:
            try:
                with open(ctx.queue, "rb") as f:
                    before = f.read()
            except OSError as ex:
                raise QueueError(500, "cannot read queue: %s" % (ex.strerror or ex))
            nums = [int(m) for m in re.findall(rb"(?m)^\|\s*(\d+)\s*\|", before)]
            n = (max(nums) if nums else 0) + 1
            line = "| %d | %s | [cockpit] %s | %s | chief-of-staff to triage | open |" % (
                n, ctx.now().strftime("%Y-%m-%d"), item, why)
            payload = (b"" if before.endswith(b"\n") or not before else b"\n") + line.encode("utf-8") + b"\n"
            size0 = len(before)
            try:
                with open(ctx.queue, "ab") as f:
                    f.write(payload)
                    f.flush()
                    os.fsync(f.fileno())
                with open(ctx.queue, "rb") as f:
                    after = f.read()
                lines = after.rstrip(b"\n").split(b"\n")
                if len(after) < size0 or lines[-1] != line.encode("utf-8"):
                    raise OSError("verification failed")
            except OSError as ex:
                try:
                    os.truncate(ctx.queue, size0)
                except OSError:
                    pass
                raise QueueError(500, "append failed, file restored: %s" % ex)
            return {"row": n, "line": line}
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


# ----------------------------------------------------------------- http
def make_handler(ctx, store, token, port, index_html):
    hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port, "[::1]:%d" % port}
    origins = {"http://" + h for h in hosts}
    csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"

    class H(BaseHTTPRequestHandler):
        server_version = "cockpit"
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def send(self, code, body, ctype="application/json"):
            if not isinstance(body, bytes):
                body = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", csp)
            self.end_headers()
            self.wfile.write(body)

        def host_ok(self):
            if self.headers.get("Host") in hosts:
                return True
            self.send(403, {"error": "bad Host header"})
            return False

        def do_GET(self):
            if not self.host_ok():
                return
            path = self.path.split("?", 1)[0]
            if path == "/":
                page = index_html.replace("__COCKPIT_TOKEN__", token)
                return self.send(200, page.encode("utf-8"), "text/html")
            if path == "/healthz":
                return self.send(200, {"ok": True, "pid": os.getpid()})
            if path == "/api/snapshot":
                return self.send(200, store.snapshot(PANELS, ctx.first_wait))
            if path.startswith("/api/panel/"):
                name = path[len("/api/panel/"):]
                if name not in COLLECTORS:
                    return self.send(404, {"error": "unknown panel"})
                return self.send(200, store.get(name, ctx.first_wait))
            if path == "/api/queue":
                return self.send(405, {"error": "method not allowed"})
            self.send(404, {"error": "not found"})

        def do_POST(self):
            if not self.host_ok():
                return
            path = self.path.split("?", 1)[0]
            if path != "/api/queue":
                known = path in ("/", "/healthz", "/api/snapshot") or path.startswith("/api/panel/")
                return self.send(405 if known else 404, {"error": "method not allowed" if known else "not found"})
            tok = self.headers.get("X-Cockpit-Token") or ""
            if not secrets.compare_digest(tok, token) or self.headers.get("Origin") not in origins:
                return self.send(403, {"error": "missing or wrong token or origin"})
            try:
                n = int(self.headers.get("Content-Length") or "-1")
            except ValueError:
                n = -1
            if n < 0:
                return self.send(400, {"error": "Content-Length required"})
            if n > BODY_CAP:
                self.close_connection = True
                return self.send(413, {"error": "body exceeds %d bytes" % BODY_CAP})
            raw = self.rfile.read(n)
            try:
                body = json.loads(raw.decode("utf-8"))
                assert isinstance(body, dict)
            except (ValueError, AssertionError):
                return self.send(400, {"error": "body must be a JSON object"})
            try:
                res = append_queue(ctx, body.get("item", ""), body.get("why", "") or "")
            except QueueError as ex:
                return self.send(ex.code, {"error": ex.msg})
            store.invalidate("queue")
            self.send(200, res)

        def _no(self):
            if self.host_ok():
                self.send(405, {"error": "method not allowed"})

        do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _no

        def do_HEAD(self):
            self._no()

    return H


class V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True


def serve(ctx, host, port):
    token = secrets.token_urlsafe(32)
    with open(os.path.join(HERE, "index.html"), encoding="utf-8") as f:
        index_html = f.read()
    store = Store(ctx)
    srv_cls = V6Server if host == "::1" else ThreadingHTTPServer
    # Bind first: the handler's Host allow-list needs the real port.
    httpd = srv_cls((host, port), BaseHTTPRequestHandler, bind_and_activate=False)
    httpd.daemon_threads = True
    httpd.server_bind()
    real_port = httpd.server_address[1]
    httpd.RequestHandlerClass = make_handler(ctx, store, token, real_port, index_html)
    httpd.server_activate()
    os.makedirs(ctx.runtime, exist_ok=True)
    tok_path = os.path.join(ctx.runtime, "token")
    fd = os.open(tok_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    os.chmod(tok_path, 0o600)
    with open(os.path.join(ctx.runtime, "server.pid"), "w") as f:
        f.write(str(os.getpid()))
    shown = "[::1]" if host == "::1" else host
    print("cockpit: http://%s:%d/" % (shown, real_port), flush=True)
    print("cockpit pid: %d" % os.getpid(), flush=True)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=httpd.shutdown, daemon=True).start())
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="CEO cockpit (loopback only)")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--repo-root", default=os.path.abspath(os.path.join(HERE, "..", "..")))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--panel", choices=PANELS)
    a = ap.parse_args(argv)
    if a.host not in ("127.0.0.1", "::1"):
        print("cockpit: refusing --host %s; only 127.0.0.1 or ::1 are allowed" % a.host, file=sys.stderr)
        return 64
    ctx = Ctx(os.path.abspath(a.repo_root))
    if a.once:
        store = Store(ctx)
        names = [a.panel] if a.panel else PANELS
        snap = store.snapshot(names, ctx.pulse_timeout + ctx.timeout * 4 + 30)
        if a.json:
            print(json.dumps(snap, indent=2, sort_keys=True))
        else:
            for n, p in snap["panels"].items():
                print("%-9s %-10s %s" % (n, p["status"], p.get("error") or ""))
        sts = [p["status"] for p in snap["panels"].values()]
        if "VIOLATION" in sts:
            return 1
        return 2 if "UNKNOWN" in sts else 0
    return serve(ctx, a.host, a.port)


if __name__ == "__main__":
    sys.exit(main())
