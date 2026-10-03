#!/usr/bin/env python3
"""loki backlog: run one v10 issue-mode run per open issue, N in parallel (D51).

    loki backlog owner/repo --all | --label X | --issues 1,2,3
                 [--concurrency N] [--dry-run]

Each issue gets its own git worktree and branch (loki/backlog-N) beside the
checkout; the launcher runs inside it. Success = the child exited 0 (the engine's
ladder: 0 VERIFIED, 1 FAILED, 3 BUDGET_STOP, 4 BLOCKED, 5 STALLED). A draft PR
from a failed run is still FAILED. Exit: 0 all ok, 3 only budget stops, 1 other
failures, 2 usage/config error.

Unit mode (D61 slice 10): --dag FILE [--group G] also runs the units of a
decomposer DAG (engine10 Dag JSON: units[] with id, items, writeSet, optional
deps; edges[] {from,to} mean "to" waits for "from"). Unit n runs on branch
loki/unit-<group>-<n> in worktree unit-<group>-<n>, shares the one slot pool
with issues, starts only after every parent passed, and is SKIPPED when a
parent did not. The launcher gets the unit task text plus --no-pr, and the env
LOKI_GROUP_ID, LOKI_UNIT_ID, LOKI_UNIT_N, LOKI_UNIT_DEPS, LOKI_UNIT_WRITE_SET.
Passing unit branches are kept for the integrator; issue mode is unchanged.

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


MAX_DAG_UNITS = 500
MAX_DAG_EDGES = 5000
UNIT_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$")


def load_dag(path, group):
    """-> (group, units) where units = [{n, id, task, deps(list of ids), write_set}] or raises ValueError."""
    try:
        with open(path) as f:
            dag = json.load(f)
    except (OSError, ValueError) as e:
        raise ValueError("cannot read DAG %s: %s" % (path, e))
    raw = dag.get("units") if isinstance(dag, dict) else None
    if not isinstance(raw, list) or not raw:
        raise ValueError("DAG has no units")
    group = group or str(dag.get("group") or "g1")
    if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$", group) or ".." in group:
        raise ValueError("group must match [A-Za-z0-9_][A-Za-z0-9_.-]* with no '..', got %r" % group)
    if len(raw) > MAX_DAG_UNITS:
        raise ValueError("DAG has %d units, the limit is %d" % (len(raw), MAX_DAG_UNITS))
    ids = []
    for u in raw:
        uid = str(u.get("id", "")) if isinstance(u, dict) else ""
        if not uid or uid in ids:
            raise ValueError("DAG unit ids must be present and unique (got %r)" % uid)
        if not UNIT_ID_RE.match(uid):
            raise ValueError("DAG unit id %r is invalid (allowed: %s)" % (uid, UNIT_ID_RE.pattern))
        ids.append(uid)
    deps = {i: [] for i in ids}
    for u in raw:
        for d in u.get("deps") or []:
            deps[str(u["id"])].append(str(d))
    edges = dag.get("edges") or []
    if not isinstance(edges, list) or len(edges) > MAX_DAG_EDGES:
        raise ValueError("DAG edges must be a list of at most %d entries" % MAX_DAG_EDGES)
    for e in edges:
        if not isinstance(e, dict):
            raise ValueError("DAG edge must be an object, got %r" % (e,))
        src, dst = str(e.get("from")), str(e.get("to"))
        if src not in deps or dst not in deps:
            raise ValueError("DAG edge %s -> %s names an unknown unit id" % (src, dst))
        if src not in deps[dst]:
            deps[dst].append(src)
    for i, ds in deps.items():
        for d in ds:
            if d not in deps or d == i:
                raise ValueError("unit %s depends on unknown or itself: %s" % (i, d))
    left = dict(deps)
    while left:
        free = [i for i, ds in left.items() if not [d for d in ds if d in left]]
        if not free:
            raise ValueError("DAG has a dependency cycle among: " + ", ".join(sorted(left)))
        for i in free:
            del left[i]
    units = []
    for n, u in enumerate(raw, 1):
        uid = str(u["id"])
        items = u.get("items") or []
        task = "\n".join(str(x) for x in items) or str(u.get("task") or uid)
        if task.lstrip().startswith("-"):
            raise ValueError("unit %s task text starts with '-' and would be read as an option" % uid)
        units.append({"n": n, "id": uid, "deps": deps[uid], "write_set": list(u.get("writeSet") or []),
                      "task": task})
    return group, units


def main(argv):
    ap = argparse.ArgumentParser(prog="loki backlog", add_help=True)
    ap.add_argument("repo")
    sel = ap.add_mutually_exclusive_group()
    sel.add_argument("--all", action="store_true")
    sel.add_argument("--label")
    sel.add_argument("--issues")
    ap.add_argument("--concurrency", type=int)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--dag", help="decomposer DAG JSON; its units run on loki/unit-<group>-<n>")
    ap.add_argument("--group", help="unit group id (default: the DAG's group, else g1)")
    a = ap.parse_args(argv)

    if not REPO_RE.match(a.repo):
        return die("repo must be owner/repo, got %r" % a.repo)
    if not (a.all or a.label or a.issues or a.dag):
        return die("choose one of --all, --label X, --issues 1,2,3, --dag FILE")
    group, dag_units = None, []
    if a.dag:
        try:
            group, dag_units = load_dag(a.dag, a.group)
        except ValueError as e:
            return die(str(e))
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
                  else list_issues(a.repo, a.label, env) if (a.all or a.label) else [])
    except RuntimeError as e:
        return die(redact(str(e), token), 1)

    say("backlog: %s concurrency %d, %d issue(s)" % (a.repo, conc, len(issues))
        + (", %d unit(s) in group %s" % (len(dag_units), group) if dag_units else ""))
    if a.dry_run:
        for i in issues:
            say("backlog: would run #%d %s" % (i["number"], i["title"]))
        for u in dag_units:
            say("backlog: would run unit %s-%d (%s) after: %s" % (group, u["n"], u["id"], ", ".join(u["deps"]) or "nothing"))
        return 0
    if not issues and not dag_units:
        say("backlog: nothing to do")
        return 0

    # ---- launch ------------------------------------------------------------
    wt_root = top.rstrip("/") + "-backlog"
    os.makedirs(os.path.join(wt_root, "logs"), exist_ok=True)
    launcher = os.environ.get("LOKI_BACKLOG_LAUNCHER") or os.path.join(REPO_ROOT, "bin", "loki")
    child_env = dict(env, LOKI_ENGINE="v10", LOKI_NO_BROWSER="1")
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

    # One job table for issues and units: they share one slot pool.
    spec = {}
    for i in issues:
        n = i["number"]
        spec[n] = {"label": "#%d" % n, "branch": "loki/backlog-%d" % n, "wt": "issue-%d" % n,
                   "cmd": [launcher, "%s#%d" % (a.repo, n)], "env": {}, "deps": [], "unit": False}
    key_of = {u["id"]: "unit-%s-%d" % (group, u["n"]) for u in dag_units}
    for u in dag_units:
        k = key_of[u["id"]]
        spec[k] = {"label": k, "branch": "loki/" + k, "wt": k, "unit": True,
                   "cmd": [launcher, u["task"], "--no-pr"],
                   "deps": [key_of[d] for d in u["deps"]],
                   "env": {"LOKI_GROUP_ID": group, "LOKI_UNIT_ID": u["id"], "LOKI_UNIT_N": str(u["n"]),
                           "LOKI_UNIT_DEPS": ",".join(u["deps"]), "LOKI_UNIT_WRITE_SET": "\n".join(u["write_set"])}}
    state = {k: {"status": "queued", "ok": None, "cost": None, "ran": False} for k in spec}
    for k in state:
        say("backlog: %s queued" % spec[k]["label"])
    pending = list(spec)
    running = {}  # key -> (Popen, log path, worktree)
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

    def finish(k):
        nonlocal unmeasured
        p, log, wt = running.pop(k)
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
        state[k].update(status=status, ok=ok, cost=usd)
        say("backlog: %s %s" % (spec[k]["label"], status))
        if ok:
            git("worktree", "remove", "--force", wt, cwd=top)
            if not spec[k]["unit"]:  # a passing unit branch is kept for the integrator
                git("branch", "-D", spec[k]["branch"], cwd=top)

    def launch(k):
        s = spec[k]
        wt = os.path.join(wt_root, s["wt"])
        if os.path.exists(wt):
            git("worktree", "remove", "--force", wt, cwd=top)
        r = git("worktree", "add", "-B", s["branch"], wt, "HEAD", cwd=top)
        if r.returncode != 0:
            err = (r.stderr.strip().splitlines() or ["git error"])[-1]
            state[k].update(status="FAILED: worktree: " + redact(err, token), ok=False)
            say("backlog: %s %s" % (s["label"], state[k]["status"]))
            return
        log = os.path.join(wt_root, "logs", s["wt"] + ".log")
        with open(log, "w") as lf:
            p = subprocess.Popen(s["cmd"], cwd=wt, env=dict(child_env, **s["env"]), stdout=lf,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        running[k] = (p, log, wt)
        state[k].update(status="running", ran=True)
        say("backlog: %s running" % s["label"])

    def next_ready():
        """First pending job whose parents all passed; skip jobs whose parent did not."""
        for k in list(pending):
            ds = spec[k]["deps"]
            bad = [d for d in ds if state[d]["ok"] is False]
            if bad:
                pending.remove(k)
                state[k].update(status="SKIPPED: dependency %s did not pass" % spec[bad[0]]["label"], ok=False)
                say("backlog: %s %s" % (spec[k]["label"], state[k]["status"]))
                return next_ready()
            if all(state[d]["ok"] is True for d in ds):
                pending.remove(k)
                return k
        return None

    while pending or running:
        for k in [k for k, (p, _l, _w) in running.items() if p.poll() is not None]:
            finish(k)
        while pending and len(running) < conc:
            if day_cap and spent_today() >= day_cap:
                for k in pending:
                    state[k].update(status="BUDGET_STOP: daily budget $%.2f reached ($%.2f spent)" % (day_cap, spent_today()), ok=False)
                    say("backlog: %s %s" % (spec[k]["label"], state[k]["status"]))
                pending = []
                break
            k = next_ready()
            if k is None:
                break
            launch(k)
        if running:
            time.sleep(0.2)

    # ---- summary -----------------------------------------------------------
    say("")
    say("Summary: %s" % a.repo)
    say("%-14s %-10s %s" % ("ITEM", "COST", "RESULT"))
    for n, s in state.items():
        say("%-14s %-10s %s" % (spec[n]["label"], ("$%.2f" % s["cost"] if s["cost"] is not None else "unmeasured" if s["ran"] else "-"), s["status"]))
    measured = sum(s["cost"] or 0 for s in state.values())
    say("Total measured cost: $%.2f%s" % (measured, " (%d run(s) unmeasured, not counted as $0)" % unmeasured if unmeasured else ""))
    bad = [s for s in state.values() if not s["ok"]]
    if not bad:
        return 0
    return 3 if all(s["status"].startswith("BUDGET_STOP") for s in bad) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
