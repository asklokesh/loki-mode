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
PANELS = ["pulse", "releases", "board", "agents", "work", "compare", "health", "okrs", "roi", "queue"]
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
        self.git_root = e("COCKPIT_GIT_ROOT") or root
        self.git_days = int(e("COCKPIT_GIT_DAYS") or 15)
        self.gh_runs_cmd = shlex.split(e("COCKPIT_GH_RUNS_CMD") or (
            "gh run list --limit 100 --json "
            "databaseId,workflowName,status,conclusion,headSha,headBranch,createdAt,event"))
        self.gh_issues_cmd = shlex.split(e("COCKPIT_GH_ISSUES_CMD") or (
            "gh issue list --state all --limit 300 --json number,title,state,createdAt,closedAt,labels"))
        self.gh_prs_cmd = shlex.split(e("COCKPIT_GH_PRS_CMD") or (
            "gh pr list --state merged --limit 200 --json number,title,mergedAt,author"))
        self.transcript_root = e("COCKPIT_TRANSCRIPT_ROOT")
        self.token_cache = e("COCKPIT_TOKEN_CACHE") or os.path.join(self.runtime, "token-cache.json")
        self.pricing = e("COCKPIT_PRICING_JSON") or os.path.join(root, "loki-ts/data/model-pricing.json")
        self.usage_cap_cmd = shlex.split(e("COCKPIT_USAGE_CAP_CMD") or
                                         "%s scripts/usage-cap.py check --json --no-refresh" % sys.executable)
        self.leader = e("COCKPIT_LEADER_FILE") or os.path.join(root, ".loki/v10-leader")
        self.ds = Datasets(self)

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


# ------------------------------------------------------------- datasets
# Shared, TTL-cached raw sources. Each fetcher returns (value, error, as_of);
# a failed source is (None, reason, as_of) and every panel that needs it shows
# UNKNOWN with that reason. Nothing here ever substitutes a default number.
class Datasets:
    def __init__(self, ctx):
        self.ctx, self.lock = ctx, threading.Lock()
        self.cache, self.locks = {}, {}

    def get(self, name, ttl, fn):
        with self.lock:
            e = self.cache.get(name)
            if e and time.time() - e[0] < ttl:
                return e[1]
            lk = self.locks.setdefault(name, threading.Lock())
        with lk:
            with self.lock:
                e = self.cache.get(name)
                if e and time.time() - e[0] < ttl:
                    return e[1]
            try:
                v = fn(self.ctx)
            except Exception as ex:  # a fetcher bug is a source failure, not a 500
                v = (None, "%s fetch crashed: %r" % (name, ex), iso(self.ctx.now()))
            with self.lock:
                self.cache[name] = (time.time(), v)
            return v


class Src:
    """Per-section source ledger: data["sources"][section] = {status, source, as_of, error}."""

    def __init__(self, ctx):
        self.ctx, self.m = ctx, {}

    def ok(self, key, source, as_of=None, keys=None):
        self.m[key] = {"status": "OK", "source": source, "as_of": as_of or iso(self.ctx.now()),
                       "error": None, "keys": keys or [key]}

    def bad(self, key, source, error, keys=None):
        self.m[key] = {"status": "UNKNOWN", "source": source, "as_of": iso(self.ctx.now()),
                       "error": error, "keys": keys or [key]}

    def finish(self, src_cmd, data, violation=False):
        data["sources"] = self.m
        sts = [v["status"] for v in self.m.values()]
        errs = ["%s: %s" % (k, v["error"]) for k, v in self.m.items() if v["status"] != "OK"]
        if sts and all(s == "UNKNOWN" for s in sts):
            return panel(self.ctx, "UNKNOWN", src_cmd, data, "; ".join(errs))
        if violation:
            return panel(self.ctx, "VIOLATION", src_cmd, data, "; ".join(errs) or None)
        if errs:
            return panel(self.ctx, "PARTIAL", src_cmd, data, "; ".join(errs))
        return panel(self.ctx, "OK", src_cmd, data, None)


COMMIT_TYPES = {"feat", "fix", "docs", "release", "chore", "test", "refactor", "perf", "ci", "build", "style"}


def commit_type(subject):
    m = re.match(r"^([A-Za-z]+)(\([^)]*\))?!?:", subject)
    if m and m.group(1).lower() in COMMIT_TYPES:
        return m.group(1).lower()
    return "merge" if subject.lower().startswith("merge") else "other"


def ds_git(ctx):
    since = iso(ctx.now() - timedelta(days=ctx.git_days))
    argv = ["git", "-C", ctx.git_root, "log", "--since=" + since, "--numstat",
            "--format=%x1e%H%x1f%aI%x1f%an%x1f%s"]
    rc, out, err = run_cmd(ctx, argv, ctx.timeout * 3)
    as_of = iso(ctx.now())
    if rc != 0:
        return None, "git log: " + (err or "exit %s" % rc), as_of
    commits = []
    for chunk in out.split("\x1e")[1:]:
        head, _, rest = chunk.partition("\n")
        p = head.split("\x1f")
        d = parse_iso(p[1]) if len(p) >= 4 else None
        if d is None:
            continue
        add = dele = files = 0
        for line in rest.splitlines():
            m = re.match(r"^(\d+|-)\t(\d+|-)\t", line)
            if m:
                files += 1
                if m.group(1) != "-":
                    add += int(m.group(1))
                    dele += int(m.group(2))
        commits.append({"sha": p[0], "ts": d, "author": p[2], "subject": p[3],
                        "type": commit_type(p[3]), "added": add, "deleted": dele, "files": files})
    return commits, None, as_of


def ds_json_cmd(ctx, argv, label, want, timeout=None):
    rc, out, err = run_cmd(ctx, argv, timeout or ctx.timeout)
    as_of = iso(ctx.now())
    if rc != 0:
        return None, "%s: %s" % (label, err or "exit %s" % rc), as_of
    try:
        v = json.loads(out)
    except ValueError as ex:
        return None, "%s: invalid JSON: %s" % (label, ex), as_of
    if not isinstance(v, want):
        return None, "%s: unexpected JSON shape" % label, as_of
    return v, None, as_of


def ds_runs(ctx):
    return ds_json_cmd(ctx, ctx.gh_runs_cmd, "gh run list", list)


def ds_issues(ctx):
    return ds_json_cmd(ctx, ctx.gh_issues_cmd, "gh issue list", list)


def ds_prs(ctx):
    return ds_json_cmd(ctx, ctx.gh_prs_cmd, "gh pr list", list)


def ds_npm(ctx):
    return ds_json_cmd(ctx, ctx.npm_cmd, "npm", dict)


def ds_governor(ctx):
    return ds_json_cmd(ctx, ctx.usage_cmd, "usage governor", dict, ctx.pulse_timeout)


def _load_module(name, path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _transcript_roots(ctx):
    if ctx.transcript_root:
        return [ctx.transcript_root]
    base = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    real = ctx.root.split("/.claude/worktrees/")[0]
    prefix = re.sub(r"[^A-Za-z0-9]", "-", real)
    try:
        return [os.path.join(base, d) for d in sorted(os.listdir(base)) if d.startswith(prefix)]
    except OSError:
        return []


def _price_tier(model):
    m = (model or "").lower()
    for t in ("opus", "sonnet", "haiku", "fable"):
        if t in m:
            return t
    return None


def _agent_setting(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 30:
                    break
                if '"agent-setting"' in line:
                    try:
                        return json.loads(line).get("agentSetting")
                    except ValueError:
                        return None
    except OSError:
        return None
    return None


def ds_tokens(ctx):
    """Hourly token buckets by (seat, price tier) from Claude Code transcripts.

    Reuses scripts/usage-governor.py iter_records (message.id dedup plus its
    per-file cache). USD is tokens x the shared price table: an ESTIMATE.
    """
    as_of = iso(ctx.now())
    prices, perr = read_json(ctx.pricing)
    table = prices.get("pricing") if isinstance(prices, dict) else None
    if not isinstance(table, dict):
        return None, "price table: " + (perr or "no 'pricing' object in " + ctx.pricing), as_of
    roots = [r for r in _transcript_roots(ctx) if os.path.isdir(r)]
    if not roots:
        return None, "no transcript directory found (COCKPIT_TRANSCRIPT_ROOT or ~/.claude/projects) for " + ctx.root, as_of
    try:
        from pathlib import Path
        gov = _load_module("usage_governor_cockpit", os.path.join(HERE, "..", "..", "scripts", "usage-governor.py"))
    except Exception as ex:
        return None, "cannot load usage-governor.py: %r" % (ex,), as_of
    slugs, _ = agent_slugs(ctx)
    since = ctx.now() - timedelta(days=ctx.git_days)
    settings, buckets, unpriced, nfiles = {}, {}, {}, set()
    try:
        os.makedirs(os.path.dirname(ctx.token_cache), exist_ok=True)
    except OSError:
        pass
    for root in roots:
        try:
            recs = list(gov.iter_records(Path(root), min_mtime=since.timestamp(), cache_path=Path(ctx.token_cache)))
        except Exception as ex:
            return None, "transcript scan failed in %s: %r" % (root, ex), as_of
        for path, role, ts, model, usage in recs:
            if ts < since or ts > ctx.now() + timedelta(minutes=5):
                continue
            ps = str(path)
            if ps not in settings:
                settings[ps] = _agent_setting(ps)
            st = settings[ps]
            seat = st if st in slugs else ("main-session" if role == "chief-of-staff" else "spawned-agent")
            tier = _price_tier(model)
            cc = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
            cw5 = int(cc.get("ephemeral_5m_input_tokens") or 0)
            cw1 = int(cc.get("ephemeral_1h_input_tokens") or 0)
            if not (cw5 or cw1):
                cw5 = int(usage.get("cache_creation_input_tokens") or 0)
            tin, tout, tcr = (int(usage.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens"))
            usd = None
            pr = table.get(tier) if tier else None
            if isinstance(pr, dict):
                usd = (tin * pr.get("input", 0) + tout * pr.get("output", 0) + tcr * pr.get("cache_read", 0)
                       + cw5 * pr.get("cache_write_5m", pr.get("cache_write", 0))
                       + cw1 * pr.get("cache_write_1h", pr.get("cache_write", 0))) / 1e6
            else:
                unpriced[model] = unpriced.get(model, 0) + 1
            hour = ts.strftime("%Y-%m-%dT%H:00:00Z")
            k = (hour, seat, tier or "unpriced", path.stem)
            b = buckets.setdefault(k, {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, "usd": 0.0, "msgs": 0})
            b["in"] += tin
            b["out"] += tout
            b["cache_read"] += tcr
            b["cache_write"] += cw5 + cw1
            b["usd"] += usd or 0.0
            b["msgs"] += 1
            nfiles.add(ps)
    if not buckets:
        return None, "no transcript records in the last %d days under %s" % (ctx.git_days, ", ".join(roots)), as_of
    rows = [{"hour": parse_iso(k[0]), "seat": k[1], "tier": k[2], "session": k[3], **v} for k, v in buckets.items()]
    return {"rows": rows, "unpriced_models": unpriced, "files": len(nfiles), "roots": roots,
            "price_updated": prices.get("_updated")}, None, as_of


def tok_sum(rows, a, b, seat=None, tier=None):
    out = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, "usd": 0.0, "msgs": 0}
    sess = set()
    a = a.replace(minute=0, second=0, microsecond=0)  # buckets are whole hours
    for r in rows:
        if a <= r["hour"] < b and (seat is None or r["seat"] == seat) and (tier is None or r["tier"] == tier):
            for k in out:
                out[k] += r[k]
            sess.add(r["session"])
    out["usd"] = round(out["usd"], 2)
    out["sessions"] = len(sess)
    return out


def owner_group(owner, slugs):
    o = (owner or "").lower()
    for s in slugs:
        if s in o:
            return s
    if "review" in o or "tech lead" in o or "tech-lead" in o:
        return "reviewer"
    if "engineer" in o or "builder" in o:
        return "engineer"
    return "unattributed"


def read_log(ctx, slug):
    """Parsed log.jsonl entries for a seat: (entries with a dt field, error)."""
    txt, err = read_text(os.path.join(ctx.company_dir, slug, "log.jsonl"))
    if err:
        return None, err
    out = []
    for line in txt.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        d = parse_iso(e.get("ts")) if isinstance(e, dict) else None
        if d:
            out.append({**e, "dt": d})
    return out, None


def pct_change(a, b):
    return round((a - b) * 100.0 / b, 1) if isinstance(a, (int, float)) and isinstance(b, (int, float)) and b else None


def pair(a, b, source, unit):
    return {"this_7d": a, "prev_7d": b, "delta": (round(a - b, 2) if a is not None and b is not None else None),
            "pct": pct_change(a, b), "unit": unit, "source": source}


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
def percentile(vals, q):
    if not vals:
        return None
    v = sorted(vals)
    i = min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))
    return round(v[i], 1)


def ci_state(runs):
    if not runs:
        return None
    if any(r.get("conclusion") == "failure" for r in runs):
        return "red"
    if any(r.get("status") in ("in_progress", "queued", "waiting", "pending") for r in runs):
        return "pending"
    if all(r.get("conclusion") in ("success", "skipped", "neutral") for r in runs):
        return "green"
    return "mixed"


def collect_releases(ctx):
    src = "%s ; %s ; %s ; VERSION ; git describe ; git log ; git tag" % (
        " ".join(ctx.npm_cmd), " ".join(ctx.gh_cmd), " ".join(ctx.gh_runs_cmd))
    errors, data, S = [], {"npm_label": "registry view (not proof a tarball is fetchable)"}, Src(ctx)
    now = ctx.now()

    npm, nerr, nas = ctx.ds.get("npm", 55, ds_npm)
    vers = []
    if nerr:
        errors.append("npm: " + nerr)
        S.bad("npm", " ".join(ctx.npm_cmd), nerr, keys=["versions", "latest", "next", "last_publish_minutes_ago",
                                                        "releases_last_hour", "releases_last_24h", "rates", "timeline"])
    else:
        tags = npm.get("dist-tags") or {}
        times = npm.get("time") or {}
        for v, t in times.items():
            d = parse_iso(t) if v not in ("created", "modified") else None
            if d:
                vers.append((d, v))
        vers.sort()
        data["latest"], data["next"] = tags.get("latest"), tags.get("next")
        data["versions"] = [{"version": v, "published": iso(d)} for d, v in reversed(vers[-20:])]
        if vers:
            data["last_publish_minutes_ago"] = round((now - vers[-1][0]).total_seconds() / 60.0, 1)
        data["releases_last_hour"] = sum(1 for d, _ in vers if now - d <= timedelta(hours=1))
        data["releases_last_24h"] = sum(1 for d, _ in vers if now - d <= timedelta(hours=24))
        hours = []
        for h in range(23, -1, -1):
            a = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=h)
            hours.append({"hour": iso(a), "count": sum(1 for d, _ in vers if a <= d < a + timedelta(hours=1))})
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        days = []
        for k in range(13, -1, -1):
            a = today - timedelta(days=k)
            days.append({"day": a.strftime("%Y-%m-%d"), "count": sum(1 for d, _ in vers if a <= d < a + timedelta(days=1))})
        w_this = sum(1 for d, _ in vers if now - d <= timedelta(days=7))
        w_prev = sum(1 for d, _ in vers if timedelta(days=7) < now - d <= timedelta(days=14))
        data["rates"] = {"per_hour_last_24h": hours, "per_day_last_14d": days,
                         "last_7d": w_this, "prev_7d": w_prev, "week_over_week_pct": pct_change(w_this, w_prev),
                         "per_hour_avg_last_24h": round(data["releases_last_24h"] / 24.0, 2)}
        S.ok("npm", " ".join(ctx.npm_cmd), nas, keys=["versions", "latest", "next", "last_publish_minutes_ago",
                                                    "releases_last_hour", "releases_last_24h", "rates"])

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
        failed = [r for r in data["runs"] if r.get("conclusion") == "failure"]
        data["failed_release_runs"] = {"last_20_runs": len(failed), "last_24h": sum(
            1 for r in failed if (age_min(ctx, r.get("createdAt")) or 1e9) <= 1440)}
        S.ok("gh_release_runs", " ".join(ctx.gh_cmd), keys=["runs", "failed_release_runs"])
    else:
        if runs is not None:
            errors.append("gh: unexpected JSON shape")
        S.bad("gh_release_runs", " ".join(ctx.gh_cmd), errors[-1] if errors else "no data",
              keys=["runs", "failed_release_runs"])

    vtxt, verr = read_text(os.path.join(ctx.root, "VERSION"))
    data["version_file"] = vtxt.strip() if vtxt is not None else None
    if verr:
        errors.append("VERSION: " + verr)
    rc, out, _ = run_cmd(ctx, ["git", "-C", ctx.root, "describe", "--tags", "--abbrev=0"], ctx.timeout)
    data["last_tag"] = out.strip() if rc == 0 and out.strip() else None
    rc, out, _ = run_cmd(ctx, ["git", "-C", ctx.root, "log", "-1", "--format=%H", "--", "VERSION"], ctx.timeout)
    vsha = out.strip() if rc == 0 else ""
    data["version_sha"] = vsha or None

    # Timeline: npm publish time joined to the release commit and its CI runs.
    commits, gerr, gas = ctx.ds.get("git", 120, ds_git)
    allruns, rerr, ras = ctx.ds.get("runs", 90, ds_runs)
    if npm is not None and vers:
        relmap = {}
        for c in commits or []:
            m = re.match(r"^release: v?(\d+\.\d+\.\d+\S*)", c["subject"])
            if m and m.group(1) not in relmap:
                relmap[m.group(1)] = c
        rc2, tout, terr = run_cmd(ctx, ["git", "-C", ctx.git_root, "for-each-ref", "--sort=-creatordate",
                                        "--count=60", "--format=%(refname:short)", "refs/tags"], ctx.timeout)
        tagset = set(tout.split()) if rc2 == 0 else None
        tl, leads = [], []
        for d, v in reversed(vers[-20:]):
            c = relmap.get(v)
            lead = round((d - c["ts"]).total_seconds() / 60.0, 1) if c else None
            ci = None
            if c and isinstance(allruns, list):
                mine = [r for r in allruns if isinstance(r, dict) and (r.get("headSha") or "").startswith(c["sha"][:12])]
                ci = {"state": ci_state(mine), "runs": len(mine),
                      "red": sorted({r.get("workflowName") for r in mine if r.get("conclusion") == "failure"})}
                if not mine:
                    ci["note"] = "no run for this SHA in the last 100 runs"
            tl.append({"version": v, "published": iso(d), "sha": c["sha"][:10] if c else None,
                       "commit_time": iso(c["ts"]) if c else None, "lead_time_min": lead,
                       "tag_exists": (("v" + v) in tagset) if tagset is not None else None, "ci": ci})
        for d, v in vers:
            c = relmap.get(v)
            if c and now - d <= timedelta(days=7):
                leads.append((d - c["ts"]).total_seconds() / 60.0)
        data["timeline"] = tl
        data["lead_time"] = {"n": len(leads), "median_min": percentile(leads, 0.5), "p90_min": percentile(leads, 0.9),
                             "definition": "npm publish time minus the author time of the 'release: vX' commit, last 7d"}
        if gerr:
            S.bad("timeline", "git log + npm time", gerr, keys=["timeline", "lead_time"])
        else:
            S.ok("timeline", "git log --format=%aI 'release: vX' commits joined to npm time", gas, keys=["timeline", "lead_time"])
        if rerr:
            S.bad("ci_per_release", " ".join(ctx.gh_runs_cmd), rerr, keys=[])
        else:
            S.ok("ci_per_release", " ".join(ctx.gh_runs_cmd), ras, keys=[])
    else:
        S.bad("timeline", "git log + npm time", "npm versions unavailable", keys=["timeline", "lead_time"])

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
    data["sources"] = S.m
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


def agent_model(ctx, slug):
    txt, _ = read_text(os.path.join(ctx.agents_dir, slug + ".md"))
    m = re.search(r"^model:\s*(\S+)", (txt or "")[:2000], re.M)
    return m.group(1) if m else None


def seat_activity(ctx, slug, now):
    """Tick counts and the last skip reason from .loki/company/<slug>/log.jsonl, plus last.out cost."""
    a = {"ticks_24h": None, "ticks_7d": None, "ran_24h": None, "skipped_24h": None,
         "last_skip_reason": None, "last_skip_at": None, "last_tick_cost_usd": None,
         "source": "read %s/%s/{log.jsonl,last.out}" % (ctx.company_dir, slug)}
    entries, err = read_log(ctx, slug)
    if entries is None:
        a["log_error"] = err
    else:
        w24 = [e for e in entries if now - e["dt"] <= timedelta(hours=24)]
        w7 = [e for e in entries if now - e["dt"] <= timedelta(days=7)]
        a["ticks_24h"], a["ticks_7d"] = len(w24), len(w7)
        a["skipped_24h"] = sum(1 for e in w24 if e.get("outcome") == "skipped")
        a["ran_24h"] = len(w24) - a["skipped_24h"]
        sk = [e for e in entries if e.get("outcome") == "skipped"]
        if sk:
            a["last_skip_reason"], a["last_skip_at"] = sk[-1].get("detail"), iso(sk[-1]["dt"])
    o, _ = read_json(os.path.join(ctx.company_dir, slug, "last.out"))
    if isinstance(o, dict) and isinstance(o.get("total_cost_usd"), (int, float)):
        a["last_tick_cost_usd"] = round(o["total_cost_usd"], 4)
        a["last_tick_cost_label"] = "MEASURED (claude -p total_cost_usd of the last tick)"
    return a


def collect_agents(ctx):
    src = "read %s/<slug>.json for slugs in %s ; log.jsonl ; transcripts" % (ctx.status_dir, ctx.agents_dir)
    slugs, err = agent_slugs(ctx)
    if err or not slugs:
        return unknown(ctx, src, err or "no agent files in " + ctx.agents_dir)
    S, now = Src(ctx), ctx.now()
    toks, terr, tas = ctx.ds.get("tokens", 300, ds_tokens)
    rows = toks["rows"] if toks else None
    seats, have = [], 0
    cadence, mod = seat_cadence(ctx)
    for slug in slugs:
        seat = {"slug": slug, "state": "UNKNOWN", "model_file": agent_model(ctx, slug),
                "root_causes": root_causes(os.path.join(ctx.agents_dir, slug + ".md"))}
        seat["tick"] = tick = seat_tick(ctx, slug, cadence, mod)
        seat["activity"] = seat_activity(ctx, slug, now)
        if rows is not None:
            t24, t7 = tok_sum(rows, now - timedelta(hours=24), now + timedelta(hours=1), seat=slug), \
                tok_sum(rows, now - timedelta(days=7), now + timedelta(hours=1), seat=slug)
            seat["cost"] = {"label": "ESTIMATE (list-price equivalent, not billed spend)", "source": "transcripts x price table", "as_of": tas,
                            "usd_24h": t24["usd"], "usd_7d": t7["usd"], "output_tokens_24h": t24["out"],
                            "output_tokens_7d": t7["out"], "messages_7d": t7["msgs"]}
        else:
            seat["cost"] = {"state": "UNKNOWN", "error": terr, "source": "transcripts x price table"}
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
    S.ok("seats", "read %s, %s/<slug>/last.json, log.jsonl, last.out; cadence from %s" % (
        ctx.status_dir, ctx.company_dir, ctx.schedules), keys=["seats", "reporting", "total"])

    if rows is not None:
        def blk(h=None, d=None):
            a = now - (timedelta(hours=h) if h else timedelta(days=d))
            return {"spawned": tok_sum(rows, a, now + timedelta(hours=1), seat="spawned-agent"),
                    "main_session": tok_sum(rows, a, now + timedelta(hours=1), seat="main-session")}
        data["transcripts"] = {"last_24h": blk(h=24), "last_7d": blk(d=7), "files_scanned": toks["files"],
                               "label": "ESTIMATE, list-price equivalent not billed spend (tokens x price table dated %s)" % toks.get("price_updated"),
                               "unpriced_models": toks["unpriced_models"]}
        S.ok("transcripts", "Claude Code transcripts under %s via scripts/usage-governor.py iter_records" % (
            ", ".join(toks["roots"]),), tas)
    else:
        S.bad("transcripts", "Claude Code transcripts", terr)
        data["transcripts"] = None
    btext, berr = read_text(ctx.board)
    if berr:
        S.bad("slice_owners", "read " + ctx.board, berr)
        data["slice_owners"] = None
    else:
        brows, _ = parse_board(btext)
        own = {}
        for label, hrs in (("last_24h", 24), ("last_7d", 168)):
            c = {}
            for r in brows:
                if (age_min(ctx, r["since"]) or 1e9) <= hrs * 60:
                    g = owner_group(r["owner"], slugs)
                    c[g] = c.get(g, 0) + 1
            own[label] = c
        active = [{"id": r["id"], "owner": r["owner"], "status": r["token"], "age_min": age_min(ctx, r["since"])}
                  for r in brows if r["token"] in ("building", "review", "review-blocked", "approved")]
        data["slice_owners"] = {**own, "in_flight": active,
                                "note": "BOARD owner column is free text; unmatched owners are 'unattributed'"}
        S.ok("slice_owners", "read " + ctx.board)
    if have == 0:
        data["sources"] = S.m
        return panel(ctx, "UNKNOWN", src, data, "no seat has written a status file in " + ctx.status_dir)
    return S.finish(src, data)


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
    g, gerr, _gas = ctx.ds.get("governor", 55, ds_governor)
    if gerr:
        notes.append(gerr)
    else:
        gov = {k: g.get(k) for k in ("weekly", "window")}
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

    # Cost versus output per seat and for the company, 7 day window.
    S = Src(ctx)
    S.ok("cost", "%s ; %s ; read %s" % (" ".join(ctx.cost_cmd), " ".join(ctx.usage_cmd), ctx.readings),
         keys=["cost", "roi", "scoreboard"])
    S.ok("value", "read %s ; read %s (ASSUMPTION basis %s)" % (ctx.basis, ctx.board, basis.get("snapshot_date")),
         keys=["value", "basis"])
    toks, terr, tas = ctx.ds.get("tokens", 300, ds_tokens)
    commits, cerr, cas = ctx.ds.get("git", 120, ds_git)
    npm, nerr, nas = ctx.ds.get("npm", 55, ds_npm)
    issues, ierr, ias = ctx.ds.get("issues", 120, ds_issues)
    btext, berr = read_text(ctx.board)
    brows = parse_board(btext)[0] if btext else None
    w7 = now - timedelta(days=7)
    parts, miss = {}, []
    if toks:
        parts["cost_7d_usd"] = tok_sum(toks["rows"], w7, now + timedelta(hours=1))["usd"]
    else:
        miss.append("cost: " + (terr or ""))
    if npm:
        parts["releases_7d"] = sum(1 for v, t in (npm.get("time") or {}).items()
                                   if v not in ("created", "modified") and parse_iso(t) and parse_iso(t) >= w7)
    else:
        miss.append("releases: " + (nerr or ""))
    if brows is not None:
        rel = [r for r in brows if r["token"] == "released" and (age_min(ctx, r["since"]) or 1e9) <= 7 * 1440]
        parts["slices_released_7d"] = len(rel)
    else:
        rel = []
        miss.append("slices: " + (berr or "no BOARD rows"))
    if commits is not None:
        parts["bug_fix_commits_7d"] = sum(1 for c in commits if c["type"] == "fix" and c["ts"] >= w7)
    else:
        miss.append("fix commits: " + (cerr or ""))
    if issues is not None:
        parts["issues_closed_7d"] = sum(1 for i in issues if isinstance(i, dict) and parse_iso(i.get("closedAt"))
                                        and parse_iso(i.get("closedAt")) >= w7)
    else:
        miss.append("issues closed: " + (ierr or ""))

    def per(num, den):
        return round(num / den, 2) if isinstance(num, (int, float)) and den else None

    cost7 = parts.get("cost_7d_usd")
    data["company"] = {
        "window": "last 7 days", "label": "ESTIMATE cost (list-price equivalent, not billed spend) vs MEASURED counts",
        "cost_7d_usd": cost7,
        "plan_proration_7d_usd": round(per_day * 7, 2) if per_day is not None else None,
        "plan_proration_label": "ASSUMPTION (plan_usd_per_month in roi-basis.json x 12 / 365 x 7)",
        "releases_7d": parts.get("releases_7d"), "slices_released_7d": parts.get("slices_released_7d"),
        "bug_fix_commits_7d": parts.get("bug_fix_commits_7d"), "issues_closed_7d": parts.get("issues_closed_7d"),
        "usd_per_release": per(cost7, parts.get("releases_7d")),
        "usd_per_slice": per(cost7, parts.get("slices_released_7d")),
        "usd_per_bug_fix": per(cost7, parts.get("bug_fix_commits_7d")),
        "formula": "usd_per_X = transcript token cost (tokens x price table) in 7d / count of X in 7d; "
                   "X = npm releases, BOARD released slices, 'fix' commits; a ratio is withheld when its count is 0 or a source is UNKNOWN",
        "unknown_inputs": miss}
    data["by_seat"] = None
    slugs, _ = agent_slugs(ctx)
    if toks and brows is not None:
        out = []
        for slug in slugs:
            t7 = tok_sum(toks["rows"], w7, now + timedelta(hours=1), seat=slug)
            n = sum(1 for r in rel if owner_group(r["owner"], slugs) == slug)
            out.append({"seat": slug, "cost_7d_usd": t7["usd"], "output_tokens_7d": t7["out"],
                        "slices_released_7d": n, "usd_per_slice": per(t7["usd"], n)})
        other = {k: tok_sum(toks["rows"], w7, now + timedelta(hours=1), seat=k) for k in ("main-session", "spawned-agent")}
        data["by_seat"] = {"seats": out, "non_seat_cost_7d_usd": {k: v["usd"] for k, v in other.items()},
                           "slices_unattributed_7d": sum(1 for r in rel if owner_group(r["owner"], slugs) not in slugs),
                           "label": "ESTIMATE cost; slices attributed by seat slug in the BOARD owner text (free text)"}
        S.ok("by_seat", "transcripts x price table ; read " + ctx.board, tas)
    else:
        S.bad("by_seat", "transcripts x price table ; read " + ctx.board, "; ".join(miss) or "unavailable")
    S.ok("company", "transcripts, git log, npm time, BOARD, gh issue list (per-input status in unknown_inputs)", tas)
    data["sources"] = S.m
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


# ------------------------------------------------------------ work made
def day_buckets(ctx, n=14):
    today = ctx.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return [today - timedelta(days=k) for k in range(n - 1, -1, -1)]


def label_names(item):
    return [str(l.get("name", "")).lower() for l in (item.get("labels") or []) if isinstance(l, dict)]


def title_type(title):
    return commit_type(title or "")


def collect_work(ctx):
    src = "git log --numstat ; read BOARD.md ; gh pr list ; gh issue list"
    S, now, data = Src(ctx), ctx.now(), {}
    slugs, _ = agent_slugs(ctx)
    d1, d7, d14 = now - timedelta(hours=24), now - timedelta(days=7), now - timedelta(days=14)

    commits, err, as_of = ctx.ds.get("git", 120, ds_git)
    if err:
        data["commits"] = None
        S.bad("commits", "git log --numstat --since", err)
    else:
        c7 = [c for c in commits if c["ts"] >= d7]
        by_type = {}
        for c in c7:
            by_type[c["type"]] = by_type.get(c["type"], 0) + 1
        nonrel = [c for c in c7 if c["type"] != "release"]
        data["commits"] = {
            "last_24h": sum(1 for c in commits if c["ts"] >= d1), "last_7d": len(c7),
            "prev_7d": sum(1 for c in commits if d14 <= c["ts"] < d7),
            "by_type_7d": by_type,
            "lines_added_7d": sum(c["added"] for c in c7), "lines_deleted_7d": sum(c["deleted"] for c in c7),
            "lines_changed_excl_release_7d": sum(c["added"] + c["deleted"] for c in nonrel),
            "files_touched_7d": sum(c["files"] for c in c7),
            "authors_7d": len({c["author"] for c in c7}),
            "per_day_14d": [{"day": a.strftime("%Y-%m-%d"),
                             "commits": sum(1 for c in commits if a <= c["ts"] < a + timedelta(days=1)),
                             "feat": sum(1 for c in commits if a <= c["ts"] < a + timedelta(days=1) and c["type"] == "feat"),
                             "fix": sum(1 for c in commits if a <= c["ts"] < a + timedelta(days=1) and c["type"] == "fix")}
                            for a in day_buckets(ctx)],
            "note": "author is the git identity, not the seat; per-seat attribution comes from the BOARD owner column"}
        S.ok("commits", "git -C %s log --numstat --since=%d days" % (ctx.git_root, ctx.git_days), as_of)

    btext, berr = read_text(ctx.board)
    if berr:
        data["slices"] = None
        S.bad("slices", "read " + ctx.board, berr)
    else:
        rows, unparsed = parse_board(btext)
        rel = [r for r in rows if r["token"] == "released"]

        def inwin(r, a, b=None):
            d = parse_iso(r["since"])
            return d is not None and d >= a and (b is None or d < b)

        by_tier, by_owner = {}, {}
        for r in rel:
            if inwin(r, d7):
                tier = r["tier"] if r["tier"] in TIER_BUDGET_MIN else "unparsed"
                by_tier[tier] = by_tier.get(tier, 0) + 1
                g = owner_group(r["owner"], slugs)
                by_owner[g] = by_owner.get(g, 0) + 1
        counts = {t: sum(1 for r in rows if r["token"] == t) for t in BOARD_TOKENS}
        data["slices"] = {
            "counts": counts, "rows_parsed": len(rows), "unparsed_rows": len(unparsed),
            "released_24h": sum(1 for r in rel if inwin(r, d1)), "released_7d": sum(1 for r in rel if inwin(r, d7)),
            "released_prev_7d": sum(1 for r in rel if inwin(r, d14, d7)),
            "released_by_tier_7d": by_tier, "released_by_owner_7d": by_owner,
            "released_per_day_14d": [{"day": a.strftime("%Y-%m-%d"),
                                      "count": sum(1 for r in rel if inwin(r, a, a + timedelta(days=1)))}
                                     for a in day_buckets(ctx)],
            "note": "the BOARD status stamp for a released row is its release time; owner is free text"}
        S.ok("slices", "read " + ctx.board)

    prs, perr, pas = ctx.ds.get("prs", 120, ds_prs)
    if perr:
        data["pull_requests"] = None
        S.bad("pull_requests", " ".join(ctx.gh_prs_cmd), perr)
    else:
        m7 = [p for p in prs if isinstance(p, dict) and parse_iso(p.get("mergedAt")) and parse_iso(p.get("mergedAt")) >= d7]
        by_author, by_type = {}, {}
        for p in m7:
            a = (p.get("author") or {}).get("login") if isinstance(p.get("author"), dict) else None
            by_author[a or "unknown"] = by_author.get(a or "unknown", 0) + 1
            t = title_type(p.get("title"))
            by_type[t] = by_type.get(t, 0) + 1
        data["pull_requests"] = {"merged_24h": sum(1 for p in m7 if parse_iso(p["mergedAt"]) >= d1), "merged_7d": len(m7),
                                 "merged_by_author_7d": by_author, "merged_by_type_7d": by_type}
        S.ok("pull_requests", " ".join(ctx.gh_prs_cmd), pas)

    issues, ierr, ias = ctx.ds.get("issues", 120, ds_issues)
    if ierr:
        data["issues"] = None
        S.bad("issues", " ".join(ctx.gh_issues_cmd), ierr)
    else:
        it = [i for i in issues if isinstance(i, dict)]
        closed7 = [i for i in it if parse_iso(i.get("closedAt")) and parse_iso(i["closedAt"]) >= d7]
        data["issues"] = {"opened_7d": sum(1 for i in it if parse_iso(i.get("createdAt")) and parse_iso(i["createdAt"]) >= d7),
                          "closed_7d": len(closed7),
                          "bugs_closed_7d": sum(1 for i in closed7 if "bug" in label_names(i)),
                          "open_now": sum(1 for i in it if str(i.get("state", "")).upper() == "OPEN"),
                          "window_note": "newest 300 issues only"}
        S.ok("issues", " ".join(ctx.gh_issues_cmd), ias)
    return S.finish(src, data)


# --------------------------------------------------------------- compare
def collect_compare(ctx):
    src = "git log ; npm time ; BOARD.md ; transcripts x price table ; scoreboard dir"
    S, now, data = Src(ctx), ctx.now(), {}
    slugs, _ = agent_slugs(ctx)
    d1, d7, d14 = now - timedelta(hours=24), now - timedelta(days=7), now - timedelta(days=14)
    horizon = now + timedelta(hours=1)
    commits, cerr, cas = ctx.ds.get("git", 120, ds_git)
    npm, nerr, nas = ctx.ds.get("npm", 55, ds_npm)
    toks, terr, tas = ctx.ds.get("tokens", 300, ds_tokens)
    btext, berr = read_text(ctx.board)
    brows = parse_board(btext)[0] if btext else None

    def cc(pred):
        if commits is None:
            return None, None
        return (sum(1 for c in commits if d7 <= c["ts"] and pred(c)),
                sum(1 for c in commits if d14 <= c["ts"] < d7 and pred(c)))

    def rl(a, b):
        if npm is None:
            return None
        return sum(1 for v, t in (npm.get("time") or {}).items() if v not in ("created", "modified")
                   and parse_iso(t) and a <= parse_iso(t) < b)

    def sl(a, b):
        if brows is None:
            return None
        return sum(1 for r in brows if r["token"] == "released" and a <= (parse_iso(r["since"]) or d14 - timedelta(days=1)) < b)

    def tk(a, b, key):
        return None if toks is None else tok_sum(toks["rows"], a, b)[key]

    mets = {}
    cn = cc(lambda c: True)
    mets["commits"] = pair(cn[0], cn[1], "git log", "commits")
    ft = cc(lambda c: c["type"] == "feat")
    mets["feat_commits"] = pair(ft[0], ft[1], "git log", "commits")
    fx = cc(lambda c: c["type"] == "fix")
    mets["fix_commits"] = pair(fx[0], fx[1], "git log", "commits")
    if commits is not None:
        a = sum(c["added"] + c["deleted"] for c in commits if c["ts"] >= d7 and c["type"] != "release")
        b = sum(c["added"] + c["deleted"] for c in commits if d14 <= c["ts"] < d7 and c["type"] != "release")
        mets["lines_changed_excl_release"] = pair(a, b, "git log --numstat", "lines")
    else:
        mets["lines_changed_excl_release"] = pair(None, None, "git log --numstat", "lines")
    mets["npm_releases"] = pair(rl(d7, horizon), rl(d14, d7), "npm view time", "releases")
    mets["slices_released"] = pair(sl(d7, horizon), sl(d14, d7), "BOARD.md released stamps", "slices")
    mets["token_cost_usd"] = pair(tk(d7, horizon, "usd"), tk(d14, d7, "usd"), "transcripts x price table (ESTIMATE)", "USD")
    mets["output_tokens"] = pair(tk(d7, horizon, "out"), tk(d14, d7, "out"), "transcripts", "tokens")
    errs = [e for e in (cerr, nerr, terr, berr) if e]
    data["week_over_week"] = {"metrics": mets, "window": "this = last 7d, prev = the 7d before; hour-aligned for tokens",
                              "unknown_inputs": errs}
    if all(m["this_7d"] is None for m in mets.values()):
        S.bad("week_over_week", src, "; ".join(errs) or "no input available")
        data["week_over_week"] = None
    else:
        S.ok("week_over_week", src)

    days = day_buckets(ctx)
    series = []
    for a in days:
        b = a + timedelta(days=1)
        series.append({"day": a.strftime("%Y-%m-%d"),
                       "commits": None if commits is None else sum(1 for c in commits if a <= c["ts"] < b),
                       "npm_releases": rl(a, b), "slices_released": sl(a, b),
                       "token_cost_usd": tk(a, b, "usd")})
    if all(all(v is None for k, v in row.items() if k != "day") for row in series):
        data["day_over_day"] = None
        S.bad("day_over_day", src, "; ".join(errs) or "no input available")
    else:
        today, yest = series[-1], series[-2]
        data["day_over_day"] = {"series": series,
                                "today_vs_yesterday": {k: pair(today[k], yest[k], k, "count" if k != "token_cost_usd" else "USD")
                                                       for k in ("commits", "npm_releases", "slices_released", "token_cost_usd")},
                                "note": "today is a partial UTC day (%d hours elapsed)" % now.hour}
        S.ok("day_over_day", src)

    if toks is None:
        data["seat_vs_seat"] = data["model_mix"] = None
        S.bad("seat_vs_seat", "transcripts x price table", terr)
        S.bad("model_mix", "transcripts x price table", terr)
    else:
        names = list(slugs) + ["main-session", "spawned-agent"]
        seats = []
        tot = tok_sum(toks["rows"], d7, horizon)
        for n in names:
            t = tok_sum(toks["rows"], d7, horizon, seat=n)
            seats.append({"seat": n, "usd_7d": t["usd"], "output_tokens_7d": t["out"], "messages_7d": t["msgs"],
                          "sessions_7d": t["sessions"], "usd_share_pct": round(t["usd"] * 100.0 / tot["usd"], 1) if tot["usd"] else None,
                          "slices_released_7d": (sum(1 for r in brows if r["token"] == "released"
                                                      and (parse_iso(r["since"]) or d14) >= d7
                                                      and owner_group(r["owner"], slugs) == n) if brows is not None and n in slugs else None)})
        seats.sort(key=lambda x: -x["usd_7d"])
        data["seat_vs_seat"] = {"seats": seats, "total_usd_7d": tot["usd"], "label": "ESTIMATE, list-price equivalent not billed spend (tokens x price table)"}
        S.ok("seat_vs_seat", "Claude Code transcripts x " + ctx.pricing, tas)
        mix = {}
        for label, a in (("last_24h", d1), ("last_7d", d7)):
            t_all = tok_sum(toks["rows"], a, horizon)
            tiers = sorted({r["tier"] for r in toks["rows"]})
            mix[label] = [{"tier": t, **{k: v for k, v in tok_sum(toks["rows"], a, horizon, tier=t).items()
                                          if k in ("usd", "out", "msgs")},
                           "usd_share_pct": round(tok_sum(toks["rows"], a, horizon, tier=t)["usd"] * 100.0 / t_all["usd"], 1) if t_all["usd"] else None,
                           "out_share_pct": round(tok_sum(toks["rows"], a, horizon, tier=t)["out"] * 100.0 / t_all["out"], 1) if t_all["out"] else None}
                          for t in tiers]
        data["model_mix"] = {**mix, "unpriced_models": toks["unpriced_models"],
                             "label": "ESTIMATE; tier from the model id in each transcript message"}
        S.ok("model_mix", "Claude Code transcripts x " + ctx.pricing, tas)

    try:
        files = sorted(f for f in os.listdir(ctx.scoreboard) if f.endswith(".json"))
    except OSError:
        files = []
    if not files:
        data["scoreboard"] = None
        S.bad("scoreboard", "read %s/*.json (research-outcomes nightly Loki vs raw claude -p)" % ctx.scoreboard,
              "no scoreboard files in %s" % ctx.scoreboard)
    else:
        d, e = read_json(os.path.join(ctx.scoreboard, files[-1]))
        if not isinstance(d, dict):
            data["scoreboard"] = None
            S.bad("scoreboard", "read " + os.path.join(ctx.scoreboard, files[-1]), e or "latest scoreboard file is not an object")
        else:
            flat = {k: v for k, v in d.items() if isinstance(v, (int, float, str, bool)) and not isinstance(v, bool)}
            data["scoreboard"] = {"file": files[-1], "files_total": len(files), "fields": dict(list(flat.items())[:30]),
                                  "note": "fields shown verbatim from the file; this panel does not interpret them"}
            S.ok("scoreboard", "read " + os.path.join(ctx.scoreboard, files[-1]))
    return S.finish(src, data)


# ---------------------------------------------------------------- health
def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def collect_health(ctx):
    src = "gh run list ; gh issue list ; BOARD.md ; usage-governor ; .loki files"
    S, now, data = Src(ctx), ctx.now(), {}
    runs, rerr, ras = ctx.ds.get("runs", 90, ds_runs)
    if rerr:
        data["ci"] = None
        S.bad("ci", " ".join(ctx.gh_runs_cmd), rerr)
    else:
        rs = [r for r in runs if isinstance(r, dict)]

        def rate(sub):
            ok = sum(1 for r in sub if r.get("conclusion") == "success")
            bad = sum(1 for r in sub if r.get("conclusion") == "failure")
            return {"success": ok, "failure": bad, "cancelled": sum(1 for r in sub if r.get("conclusion") == "cancelled"),
                    "green_rate_pct": round(ok * 100.0 / (ok + bad), 1) if ok + bad else None}
        wf = {}
        for r in rs:
            wf.setdefault(r.get("workflowName") or "?", []).append(r)
        main = [r for r in rs if r.get("headBranch") == "main"]
        data["ci"] = {"runs_considered": len(rs), "all": rate(rs), "main_branch": rate(main),
                      "by_workflow": {k: rate(v) for k, v in sorted(wf.items())},
                      "note": "last 100 runs; green rate = success / (success + failure), cancelled excluded"}
        S.ok("ci", " ".join(ctx.gh_runs_cmd), ras)

    issues, ierr, ias = ctx.ds.get("issues", 120, ds_issues)
    if ierr:
        data["p0"] = None
        S.bad("p0", " ".join(ctx.gh_issues_cmd), ierr)
    else:
        p0 = [i for i in issues if isinstance(i, dict) and str(i.get("state", "")).upper() == "OPEN"
              and any(n in ("p0", "priority: p0", "priority/p0") for n in label_names(i))]
        data["p0"] = {"open_p0_issues": len(p0), "items": [{"number": i.get("number"), "title": str(i.get("title"))[:120]}
                                                           for i in p0[:10]]}
        S.ok("p0", " ".join(ctx.gh_issues_cmd), ias)

    btext, berr = read_text(ctx.board)
    if berr:
        data["blocked"] = None
        S.bad("blocked", "read " + ctx.board, berr)
    else:
        rows, _ = parse_board(btext)
        bl = [r for r in rows if r["token"] in ("blocked", "review-blocked")]
        data["blocked"] = {"blocked": sum(1 for r in rows if r["token"] == "blocked"),
                           "review_blocked": sum(1 for r in rows if r["token"] == "review-blocked"),
                           "parked": sum(1 for r in rows if r["token"] == "parked"),
                           "rejected": sum(1 for r in rows if r["token"] == "rejected"),
                           "ready": sum(1 for r in rows if r["token"] == "ready"),
                           "p0_rows_open": sum(1 for r in rows if r["token"] not in ("released", "rejected", "parked", "merged")
                                               and re.search(r"\bP0\b", r["id"] + " " + r["notes"])),
                           "blocked_rows": [{"id": r["id"], "owner": r["owner"][:40], "age_min": age_min(ctx, r["since"]),
                                             "notes": r["notes"][:140]} for r in bl[:10]]}
        S.ok("blocked", "read " + ctx.board)

    g, gerr, gas = ctx.ds.get("governor", 55, ds_governor)
    pause_file = os.path.join(ctx.company_dir, "PAUSE")
    if gerr:
        data["usage"] = None
        S.bad("usage", " ".join(ctx.usage_cmd), gerr)
    else:
        gv = g.get("governor") if isinstance(g.get("governor"), dict) else {}
        wk, wd = g.get("weekly") or {}, g.get("window") or {}
        usage = {"weekly_percent": wk.get("current_pct"), "window_5h_percent": wd.get("current_pct"),
                 "weekly_resets": wk.get("resets_text"), "window_resets": wd.get("resets_text"),
                 "max_engineers_next_hour": gv.get("max_engineers_next_hour"),
                 "active_engineers_last_hour": gv.get("active_engineers_last_hour"),
                 "cap_basis": gv.get("cap_basis"), "measured_age_secs": (g.get("measured") or {}).get("age_secs"),
                 "paused_file_present": os.path.exists(pause_file)}
        data["usage"] = usage
        S.ok("usage", "%s ; stat %s" % (" ".join(ctx.usage_cmd), pause_file), gas)

    cap, cerr, cas = ds_json_cmd(ctx, ctx.usage_cap_cmd, "usage cap", dict)
    if cap is not None and cap.get("state") not in ("OK", "PAUSED"):
        cap, cerr = None, "usage cap: state is %r, expected OK or PAUSED" % (cap.get("state"),)
    if cerr:
        data["usage_cap"] = None
        S.bad("usage_cap", " ".join(ctx.usage_cap_cmd), cerr)
    else:
        data["usage_cap"] = {"paused": cap["state"] == "PAUSED", "state": cap["state"], "reason": cap.get("reason"),
                             "week_pct": cap.get("week_pct"), "ceiling": cap.get("ceiling"),
                             "override": cap.get("override"), "reading_at": cap.get("reading_at"),
                             "cache_age_secs": cap.get("cache_age_secs"), "message": cap.get("message")}
        S.ok("usage_cap", " ".join(ctx.usage_cap_cmd), cas)

    leader_txt, lerr = read_text(ctx.leader)
    holder = None
    if leader_txt is not None:
        m = re.match(r"\s*(\d+)", leader_txt)
        if m:
            holder = {"pid": int(m.group(1)), "alive": pid_alive(int(m.group(1))),
                      "raw_first_line": leader_txt.splitlines()[0][:80] if leader_txt.splitlines() else ""}
    try:
        load1 = round(os.getloadavg()[0], 2)
        lerr2 = None
    except OSError as ex:
        load1, lerr2 = None, "os.getloadavg: %s" % ex
    data["system"] = {"load_1min": load1, "load_error": lerr2, "leader_file": ctx.leader,
                      "leader": holder, "leader_error": lerr if holder is None else None,
                      "company_paused": os.path.exists(pause_file)}
    S.ok("system", "os.getloadavg ; read %s ; stat %s" % (ctx.leader, pause_file))
    return S.finish(src, data)


COLLECTORS = {"pulse": (collect_pulse, 90), "releases": (collect_releases, 60),
              "board": (collect_board, 5), "agents": (collect_agents, 5),
              "work": (collect_work, 60), "compare": (collect_compare, 60), "health": (collect_health, 30),
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
