#!/usr/bin/env python3
"""loki backlog: run one v10 issue-mode run per open issue, N in parallel (D51).

    loki backlog owner/repo --all | --label X | --issues 1,2,3
                 [--concurrency N] [--dry-run]

Each issue gets its own git worktree and branch (loki/backlog-N) beside the
checkout; the launcher runs inside it. Success = the child exited 0 (the engine's
ladder: 0 VERIFIED, 1 FAILED, 3 BUDGET_STOP, 4 BLOCKED, 5 STALLED). A draft PR
from a failed run is still FAILED. Exit: 0 all ok, 3 only budget stops, 1 other
failures, 2 usage/config error.

Test seam: LOKI_BACKLOG_LAUNCHER replaces the real launcher (called with the
issue ref, cwd = the issue worktree).
"""
import argparse
import datetime
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import loki_yaml  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def say(msg):
    print(msg, flush=True)


def die(msg, rc=2):
    print("loki backlog: " + msg, file=sys.stderr)
    return rc


def redact(text, token):
    return text.replace(token, "***") if token and len(token) >= 6 else text


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)


def origin_slug(cwd):
    url = git("remote", "get-url", "origin", cwd=cwd).stdout.strip()
    m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", url)
    return m.group(1) if m else ""


def list_issues(repo, label, env):
    cmd = ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "200",
           "--json", "number,title,labels"]
    if label:
        cmd += ["--label", label]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError("gh issue list failed: " + (r.stderr.strip().splitlines() or ["unknown error"])[0])
    return sorted(({"number": i["number"], "title": i.get("title", "")} for i in json.loads(r.stdout or "[]")),
                  key=lambda i: i["number"])


# ---- daily spend ledger (outside any worktree) -----------------------------
def ledger_path():
    return os.path.join(os.path.expanduser("~"), ".loki", "backlog-spend.json")


def spent_today():
    try:
        with open(ledger_path()) as f:
            return float(json.load(f).get(datetime.date.today().isoformat(), 0))
    except (OSError, ValueError):
        return 0.0


def add_spend(usd):
    p = ledger_path()
    try:
        with open(p) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    k = datetime.date.today().isoformat()
    data[k] = round(float(data.get(k, 0)) + usd, 6)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(data, f)


def parse_result(rc, text):
    """-> (ok, status line text, cost_usd or None)."""
    pr = re.search(r"^PR:\s+(https?://\S+)", text, re.M)
    why = re.search(r"^Reason:\s+(.+)$", text, re.M)
    cost = re.search(r"^Cost:\s+(?:partial:\s+)?\$([0-9]+(?:\.[0-9]+)?)", text, re.M)
    usd = float(cost.group(1)) if cost else None
    reason = why.group(1).strip() if why else ""
    if rc == 0:
        return True, ("PR " + pr.group(1)) if pr else "VERIFIED", usd
    if rc == 4:
        return False, "BLOCKED: " + (reason or "see the run log"), usd
    if rc == 3:
        return False, "BUDGET_STOP: " + (reason or "run cost cap reached"), usd
    return False, "FAILED: " + (reason or "exit %d" % rc), usd


def main(argv):
    ap = argparse.ArgumentParser(prog="loki backlog", add_help=True)
    ap.add_argument("repo")
    sel = ap.add_mutually_exclusive_group()
    sel.add_argument("--all", action="store_true")
    sel.add_argument("--label")
    sel.add_argument("--issues")
    ap.add_argument("--concurrency", type=int)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    if not REPO_RE.match(a.repo):
        return die("repo must be owner/repo, got %r" % a.repo)
    if not (a.all or a.label or a.issues):
        return die("choose one of --all, --label X, --issues 1,2,3")
    numbers = None
    if a.issues:
        if not re.match(r"^\d+(,\d+)*$", a.issues):
            return die("--issues takes a comma-separated list of numbers, got %r" % a.issues)
        numbers = [int(n) for n in a.issues.split(",")]

    try:
        cfg, cfg_path, errors = loki_yaml.load()
    except loki_yaml.CannotCheck as e:
        return die("could not read loki.yaml: %s" % e)
    if errors:
        print("loki backlog: invalid configuration (%s):" % (cfg_path or "environment"), file=sys.stderr)
        for e in errors:
            print("  - " + e, file=sys.stderr)
        return 2
    conc = a.concurrency or cfg.get("concurrency", 2)
    if conc < 1:
        return die("--concurrency must be >= 1")

    env = dict(os.environ)
    token = ""
    tok_env = cfg.get("git", {}).get("token_env")
    if tok_env:
        token = os.environ.get(tok_env, "")
        if not token:
            return die("git.token_env names %s but that environment variable is not set" % tok_env)
        env["GH_TOKEN"] = env["GITHUB_TOKEN"] = token

    top = git("rev-parse", "--show-toplevel").stdout.strip()
    if not top:
        return die("run this from a checkout of %s" % a.repo)
    if origin_slug(top).lower() != a.repo.lower():
        return die("this checkout's origin is %r, not %s; cd into a checkout of %s"
                   % (origin_slug(top) or "unknown", a.repo, a.repo))

    try:
        issues = ([{"number": n, "title": ""} for n in numbers] if numbers
                  else list_issues(a.repo, a.label, env))
    except RuntimeError as e:
        return die(redact(str(e), token), 1)

    say("backlog: %s concurrency %d, %d issue(s)" % (a.repo, conc, len(issues)))
    if a.dry_run:
        for i in issues:
            say("backlog: would run #%d %s" % (i["number"], i["title"]))
        return 0
    if not issues:
        say("backlog: nothing to do")
        return 0

    # ---- launch ------------------------------------------------------------
    wt_root = top.rstrip("/") + "-backlog"
    os.makedirs(os.path.join(wt_root, "logs"), exist_ok=True)
    launcher = os.environ.get("LOKI_BACKLOG_LAUNCHER") or os.path.join(REPO_ROOT, "bin", "loki")
    child_env = dict(env, LOKI_NO_BROWSER="1")
    for key, var in (("models.default", "LOKI_MODEL_DEVELOPMENT"), ("models.cheap", "LOKI_MODEL_FAST")):
        sect, name = key.split(".")
        if cfg.get(sect, {}).get(name):
            child_env[var] = cfg[sect][name]
    if cfg.get("provider"):
        child_env["LOKI_PROVIDER"] = cfg["provider"]
    # ponytail: per-run cap is forwarded only; the v10 engine itself caps on time
    if cfg.get("budgets", {}).get("per_run_usd"):
        child_env["LOKI_BUDGET_LIMIT"] = str(cfg["budgets"]["per_run_usd"])
    day_cap = cfg.get("budgets", {}).get("per_day_usd")

    state = {i["number"]: {"status": "queued", "ok": None, "cost": None, "ran": False} for i in issues}
    for n in state:
        say("backlog: #%d queued" % n)
    pending = [i["number"] for i in issues]
    running = {}  # n -> (Popen, log path, worktree)
    unmeasured = 0

    def stop_children(*_):
        for p, _l, _w in running.values():
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass
        sys.exit(130)
    signal.signal(signal.SIGTERM, stop_children)
    signal.signal(signal.SIGINT, stop_children)

    def finish(n):
        nonlocal unmeasured
        p, log, wt = running.pop(n)
        try:
            with open(log, errors="replace") as f:
                text = redact(f.read(), token)
            with open(log, "w") as f:
                f.write(text)
        except OSError:
            text = ""
        ok, status, usd = parse_result(p.returncode, text)
        if usd is None:
            unmeasured += 1
        else:
            add_spend(usd)
        state[n].update(status=status, ok=ok, cost=usd)
        say("backlog: #%d %s" % (n, status))
        if ok:
            git("worktree", "remove", "--force", wt, cwd=top)
            git("branch", "-D", "loki/backlog-%d" % n, cwd=top)

    def launch(n):
        wt = os.path.join(wt_root, "issue-%d" % n)
        if os.path.exists(wt):
            git("worktree", "remove", "--force", wt, cwd=top)
        r = git("worktree", "add", "-B", "loki/backlog-%d" % n, wt, "HEAD", cwd=top)
        if r.returncode != 0:
            err = (r.stderr.strip().splitlines() or ["git error"])[-1]
            state[n].update(status="FAILED: worktree: " + redact(err, token), ok=False)
            say("backlog: #%d %s" % (n, state[n]["status"]))
            return
        log = os.path.join(wt_root, "logs", "issue-%d.log" % n)
        cmd = [launcher, "%s#%d" % (a.repo, n)]
        with open(log, "w") as lf:
            p = subprocess.Popen(cmd, cwd=wt, env=child_env, stdout=lf, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, start_new_session=True)
        running[n] = (p, log, wt)
        state[n].update(status="running", ran=True)
        say("backlog: #%d running" % n)

    while pending or running:
        for n in [n for n, (p, _l, _w) in running.items() if p.poll() is not None]:
            finish(n)
        while pending and len(running) < conc:
            if day_cap and spent_today() >= day_cap:
                for n in pending:
                    state[n].update(status="BUDGET_STOP: daily budget $%.2f reached ($%.2f spent)" % (day_cap, spent_today()), ok=False)
                    say("backlog: #%d %s" % (n, state[n]["status"]))
                pending = []
                break
            launch(pending.pop(0))
        if running:
            time.sleep(0.2)

    # ---- summary -----------------------------------------------------------
    say("")
    say("Summary: %s" % a.repo)
    say("%-8s %-8s %s" % ("ISSUE", "COST", "RESULT"))
    for n, s in state.items():
        say("%-8s %-8s %s" % ("#%d" % n, ("$%.2f" % s["cost"] if s["cost"] is not None else "unmeasured" if s["ran"] else "-"), s["status"]))
    measured = sum(s["cost"] or 0 for s in state.values())
    say("Total measured cost: $%.2f%s" % (measured, " (%d run(s) unmeasured, not counted as $0)" % unmeasured if unmeasured else ""))
    bad = [s for s in state.values() if not s["ok"]]
    if not bad:
        return 0
    return 3 if all(s["status"].startswith("BUDGET_STOP") for s in bad) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
