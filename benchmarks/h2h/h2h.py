#!/usr/bin/env python3
"""B1 head-to-head benchmark runner: raw Claude Code vs Loki on hidden-test tasks.

Invoked through benchmarks/h2h/run.sh. For every config x task x rep it copies a
fresh task repo into a run-owned temp dir, runs the contestant under a timeout,
then restores the protected test paths, copies the hidden tests in and lets only
the hidden tests decide pass or fail. Contestants never see the hidden tests:
they live in tasks/<id>/hidden, outside the copied repo, and are copied in only
after the contestant process (and its whole process group) has exited.
"""

import argparse
import datetime as dt
import json
import os
import platform
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TASKS_DIR = HERE / "tasks"
CONFIGS = ["raw-haiku", "raw-opus", "loki-haiku", "loki-default"]
# Offline configs for checking the task set itself: oracle applies tasks/<id>/solution, noop changes nothing.
CHECK_CONFIGS = ["oracle", "noop"]
SCORE_TIMEOUT_S = 180
NOISE = (".loki/", "node_modules/", "__pycache__/", ".pytest_cache/", ".bun/")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def load_task(task_id):
    d = TASKS_DIR / task_id
    meta = json.loads((d / "meta.json").read_text())
    meta["id"] = task_id
    meta["dir"] = d
    meta["text"] = (d / "task.txt").read_text().strip()
    return meta


def contestant_env(home):
    """The same scrubbed environment for every contestant: no parent Claude Code session
    variables, no inherited LOKI_* knobs, a throwaway HOME, no telemetry or update checks."""
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith("CLAUDE") or k.startswith("LOKI_") or k in ("AI_AGENT", "CLAUDECODE"))}
    env.update({
        "HOME": str(home),
        "LOKI_NO_COMPLETIONS": "1",
        "LOKI_TELEMETRY_DISABLED": "true",
        "DO_NOT_TRACK": "1",
        "LOKI_NO_UPDATE_CHECK": "1",
        "LOKI_NO_BROWSER": "1",
        "LOKI_DASHBOARD": "false",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


def make_home(path):
    """Throwaway HOME. Claude auth must still resolve: on macOS the OAuth token is in the
    login keychain, found through $HOME/Library/Keychains; on Linux it is
    ~/.claude/.credentials.json. Only that is linked, so no user CLAUDE.md, hooks,
    settings or Loki state leak into either contestant."""
    path.mkdir(parents=True)
    real = Path(os.environ.get("H2H_REAL_HOME") or Path.home())
    if os.environ.get("H2H_NO_AUTH_LINK") == "1":
        return path
    if platform.system() == "Darwin" and (real / "Library" / "Keychains").is_dir():
        (path / "Library").mkdir()
        (path / "Library" / "Keychains").symlink_to(real / "Library" / "Keychains")
    cred = real / ".claude" / ".credentials.json"
    if platform.system() != "Darwin" and cred.is_file():
        (path / ".claude").mkdir()
        (path / ".claude" / ".credentials.json").symlink_to(cred)
    return path


def prepare_repo(task, dest):
    shutil.copytree(task["dir"] / "repo", dest)
    git(dest, "init", "-q", "-b", "main")
    git(dest, "config", "user.name", "h2h")
    git(dest, "config", "user.email", "h2h@example.invalid")
    git(dest, "config", "commit.gpgsign", "false")
    git(dest, "add", "-A")
    git(dest, "commit", "-q", "-m", "base")
    return git(dest, "rev-parse", "HEAD").strip()


def contestant_cmd(config, task):
    text = task["text"]
    if config in ("raw-haiku", "raw-opus"):
        model = config.split("-", 1)[1]
        # `command claude` skips any shell function named claude in an interactive profile.
        return ["bash", "-c", 'command claude "$@"', "claude", "-p", text, "--model", model,
                "--output-format", "json", "--dangerously-skip-permissions"]
    if config in ("loki-haiku", "loki-default"):
        return ["bash", str(ROOT / "bin" / "loki"), text, "--no-pr"]
    raise ValueError(f"unknown config {config}")


def config_env(config, env):
    if config == "loki-haiku":
        # LOKI_SESSION_MODEL is the whole-run pin (loki-ts/src/engine10/session.ts resolveModel and
        # childEnv; runner/providers.ts sessionPinModel): every stage tier runs haiku, escalation stays
        # on the pinned model (runner/model_rank.ts escalationModel) and the Wall re-author is capped to
        # it (stages/wall.ts capToRunTier). LOKI_MODEL_OVERRIDE is not used: it is a pin key for the Wall
        # re-author, so that call would climb back to sonnet (engine10/sizing.ts wallModel).
        env["LOKI_SESSION_MODEL"] = "haiku"
    if config.startswith("loki-"):
        # A/B knob: H2H_LOKI_ENV="K=V,K=V" sets those variables on Loki contestants only (contestant_env drops inherited LOKI_*).
        for kv in filter(None, os.environ.get("H2H_LOKI_ENV", "").split(",")):
            k, _, v = kv.partition("=")
            if k.startswith("LOKI_"):
                env[k] = v
    return env


def kill_group(pgid):
    """Stops the process group the runner itself created for one contestant."""
    for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 2)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.2)


def run_contestant(cmd, cwd, env, timeout_s, out_path, err_path):
    t0 = time.monotonic()
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                             start_new_session=True)
        timed_out = False
        try:
            rc = p.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(p.pid)
            rc = p.wait()
    secs = time.monotonic() - t0
    kill_group(p.pid)  # nothing of the contestant may still be running when the hidden tests are copied in
    return rc, secs, timed_out


def apply_oracle(task, repo):
    shutil.copytree(task["dir"] / "solution", repo, dirs_exist_ok=True)


def changed_files(repo, base):
    names = set(git(repo, "diff", "--name-only", base).split())
    names |= set(git(repo, "ls-files", "--others", "--exclude-standard").split())
    return sorted(n for n in names if not any(n.startswith(p) or f"/{p}" in n for p in NOISE))


def loki_branch_checkout(repo, base):
    """If the run left its work on a loki/<id> branch and the checkout itself still sits at
    base, score the branch: that is what the user gets from the run."""
    head = git(repo, "rev-parse", "HEAD").strip()
    if head != base or git(repo, "status", "--porcelain", "--untracked-files=no").strip():
        return None
    for br in git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/loki/").split():
        if git(repo, "rev-parse", br).strip() != base:
            git(repo, "checkout", "-q", br)
            return br
    return None


def restore_protected(task, repo, base):
    """SWE-bench style: every protected path goes back to its base content before scoring, so a
    contestant cannot pass by editing tests or test config."""
    base_files = set(git(repo, "ls-tree", "-r", "--name-only", base).split())
    for p in task.get("protected", []):
        tracked = any(f == p or f.startswith(p.rstrip("/") + "/") for f in base_files)
        target = repo / p
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        elif target.exists() or target.is_symlink():
            target.unlink()
        if tracked:
            git(repo, "checkout", base, "--", p)


def score(task, repo, env, log_path):
    for src, dest in task["hidden"].items():
        d = repo / dest
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(task["dir"] / "hidden" / src, d)
    try:
        r = subprocess.run(task["hidden_cmd"], cwd=repo, env=env, capture_output=True, text=True,
                           timeout=SCORE_TIMEOUT_S)
        out, rc = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        out, rc = "hidden tests timed out", 124
    Path(log_path).write_text(out)
    return 1 if rc == 0 else 0, out[-1500:]


def raw_metrics(stdout_path):
    try:
        text = Path(stdout_path).read_text()
        start = text.find("{")
        data = json.loads(text[start:]) if start >= 0 else {}
    except (OSError, ValueError):
        data = {}
    cost = data.get("total_cost_usd")
    return {
        "cost_usd": cost if isinstance(cost, (int, float)) else None,
        "sessions": 1 if data else 0,
        "turns": data.get("num_turns"),
        "models": sorted((data.get("modelUsage") or {}).keys()),
        "result_subtype": data.get("subtype"),
        "is_error": data.get("is_error"),
    }


def _ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def loki_metrics(repo):
    """Cost, sessions and the per-stage breakdown from the run's own records:
    .loki/runs/<id>/events.jsonl (engine10/events.ts envelopes {seq, ts, run, type, stage, data};
    one `cost` event per model session with data.usd, data.model, data.duration_ms, written by
    engine10/session.ts recordCost) plus this run's lines in .loki/metrics/child-sessions.jsonl
    ({run_id, usd, ...}, util/child_ledger.ts), which runCost adds to the total. run.completed
    carries the run's own total in data.cost_usd (engine10/supervisor.ts), used when present."""
    runs = repo / ".loki" / "runs"
    eng = repo / ".loki" / "engine.json"
    run_dir = None
    try:
        rid = json.loads(eng.read_text()).get("run_id")
        if rid and (runs / rid).is_dir():
            run_dir = runs / rid
    except (OSError, ValueError):
        pass
    if run_dir is None and runs.is_dir():
        cands = sorted((p for p in runs.iterdir() if (p / "events.jsonl").is_file()), key=lambda p: p.stat().st_mtime)
        run_dir = cands[-1] if cands else None
    if run_dir is None:
        return {"cost_usd": None, "sessions": 0, "run_id": None, "stages": {}, "verdict": None, "models": []}
    events = []
    for line in (run_dir / "events.jsonl").read_text().splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    stages = {}
    started = {}
    stage_cost_total, priced, unpriced = 0.0, 0, 0
    models = set()
    for e in events:
        st = e.get("stage") or "run"
        s = stages.setdefault(st, {"cost_usd": 0.0, "sessions": 0, "seconds": 0.0, "session_seconds": 0.0, "runs": 0})
        typ, data = e.get("type"), e.get("data") or {}
        if typ == "stage.started":
            started[st] = _ts(e["ts"])
        elif typ in ("stage.completed", "stage.failed") and st in started:
            s["seconds"] += _ts(e["ts"]) - started.pop(st)
            s["runs"] += 1
        elif typ == "cost":
            s["sessions"] += 1
            if isinstance(data.get("usd"), (int, float)):
                s["cost_usd"] += data["usd"]
                stage_cost_total += data["usd"]
                priced += 1
            else:
                unpriced += 1
            if data.get("model"):
                models.add(str(data["model"]))
            if isinstance(data.get("duration_ms"), (int, float)):
                s["session_seconds"] += data["duration_ms"] / 1000
    child_usd, child_n = 0.0, 0
    ledger = repo / ".loki" / "metrics" / "child-sessions.jsonl"
    rid = run_dir.name
    if ledger.is_file():
        for line in ledger.read_text().splitlines():
            try:
                c = json.loads(line)
            except ValueError:
                continue
            if c.get("run_id") == rid:
                u = c.get("usd")
                if isinstance(u, (int, float)):
                    child_usd += u
                    child_n += 1
    completed = next((e for e in reversed(events) if e.get("type") == "run.completed"), None)
    cdata = (completed or {}).get("data") or {}
    own_total = cdata.get("cost_usd")
    total = own_total if isinstance(own_total, (int, float)) else (stage_cost_total + child_usd if priced else None)
    for s in stages.values():
        for k in ("cost_usd", "seconds", "session_seconds"):
            s[k] = round(s[k], 4)
    return {
        "cost_usd": total,
        "stage_cost_usd": round(stage_cost_total, 6),
        "child_cost_usd": round(child_usd, 6),
        "child_sessions": child_n,
        "unpriced_sessions": unpriced,
        "sessions": priced + unpriced + child_n,
        "run_id": rid,
        "verdict": cdata.get("verdict"),
        "wall_s": cdata.get("wall_s"),
        "stages": {k: v for k, v in stages.items() if v["sessions"] or v["seconds"]},
        "models": sorted(models),
        "event_types": sorted({e.get("type") for e in events if e.get("type")}),
    }


def auth_ok(work):
    """Before any spend: claude auth must resolve under the throwaway HOME."""
    home = make_home(work / "auth-home")
    env = contestant_env(home)
    try:
        r = subprocess.run(["bash", "-c", "command claude auth status"], env=env, capture_output=True, text=True,
                           timeout=60)
        data = json.loads(r.stdout[r.stdout.find("{"):])
        return bool(data.get("loggedIn")), r.stdout.strip()
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)


def run_one(config, task, rep, work, timeout_s, keep_dir):
    d = Path(tempfile.mkdtemp(prefix=f"{config}.{task['id']}.{rep}.", dir=work))
    repo = d / "repo"
    base = prepare_repo(task, repo)
    env = config_env(config, contestant_env(make_home(d / "home")))
    hidden_names = [Path(dest).name for dest in task["hidden"].values()]
    rec = {"config": config, "task": task["id"], "kind": task["kind"], "lang": task["lang"], "rep": rep}
    if config == "oracle":
        t0 = time.monotonic()
        apply_oracle(task, repo)
        rc, secs, timed_out = 0, time.monotonic() - t0, False
    elif config == "noop":
        rc, secs, timed_out = 0, 0.0, False
    else:
        rc, secs, timed_out = run_contestant(contestant_cmd(config, task), repo, env, timeout_s,
                                             d / "contestant.out", d / "contestant.err")
    # The hidden tests must not exist in the contestant's copy before scoring starts.
    leaked = [str(p.relative_to(repo)) for p in repo.rglob("*") if p.name in hidden_names]
    branch = loki_branch_checkout(repo, base) if config.startswith("loki") else None
    files = changed_files(repo, base)
    if config.startswith("raw"):
        m = raw_metrics(d / "contestant.out")
    elif config.startswith("loki"):
        m = loki_metrics(repo)
    else:
        m = {"cost_usd": 0.0, "sessions": 0}
    restore_protected(task, repo, base)
    passed, tail = score(task, repo, env, d / "hidden.log")
    rec.update({
        "pass": passed, "seconds": round(secs, 2), "exit_code": rc, "timed_out": timed_out,
        "files_changed": len(files), "files": files, "hidden_leaked_before_scoring": leaked,
        "scored_branch": branch, "hidden_tail": tail if not passed else "", **m,
    })
    if not keep_dir:
        shutil.rmtree(d, ignore_errors=True)
    else:
        rec["workdir"] = str(d)
    return rec


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[k]


def summarize(results, configs):
    rows = []
    for c in configs:
        rs = [r for r in results if r["config"] == c]
        if not rs:
            continue
        secs = [r["seconds"] for r in rs]
        costs = [r["cost_usd"] for r in rs if isinstance(r.get("cost_usd"), (int, float))]
        rows.append({
            "config": c, "n": len(rs), "passed": sum(r["pass"] for r in rs),
            "pass_rate": round(sum(r["pass"] for r in rs) / len(rs), 4),
            "median_s": round(statistics.median(secs), 1), "p90_s": round(pct(secs, 0.9), 1),
            "total_cost_usd": round(sum(costs), 4), "cost_per_task_usd": round(sum(costs) / len(rs), 4),
            "cost_unmeasured": len(rs) - len(costs),
            "mean_sessions": round(statistics.mean(r.get("sessions") or 0 for r in rs), 2),
            "timeouts": sum(1 for r in rs if r["timed_out"]),
        })
    return rows


def markdown(rows, results, configs):
    out = ["| config | pass | median s | p90 s | total $ | $ / task | mean sessions | timeouts |",
           "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        unm = f" ({r['cost_unmeasured']} unmeasured)" if r["cost_unmeasured"] else ""
        out.append(f"| {r['config']} | {r['passed']}/{r['n']} ({r['pass_rate'] * 100:.0f}%) | {r['median_s']} | {r['p90_s']} "
                   f"| {r['total_cost_usd']:.4f}{unm} | {r['cost_per_task_usd']:.4f} | {r['mean_sessions']} | {r['timeouts']} |")
    tasks = sorted({r["task"] for r in results})
    out += ["", "| task | " + " | ".join(configs) + " |", "|---|" + "---|" * len(configs)]
    for t in tasks:
        cells = []
        for c in configs:
            rs = [r for r in results if r["task"] == t and r["config"] == c]
            cost = sum(r["cost_usd"] or 0 for r in rs)
            cells.append(" ".join(f"{'PASS' if r['pass'] else 'FAIL'} {r['seconds']:.0f}s" for r in rs) + (f" ${cost:.3f}" if rs else "") if rs else "-")
        out.append(f"| {t} | " + " | ".join(cells) + " |")
    return "\n".join(out)


def ledger_total(path):
    if not path or not Path(path).is_file():
        return 0.0
    return sum(json.loads(l).get("cost_usd") or 0 for l in Path(path).read_text().splitlines() if l.strip())


def main(argv=None):
    ap = argparse.ArgumentParser(prog="benchmarks/h2h/run.sh", description=__doc__.splitlines()[0])
    ap.add_argument("--configs", default=",".join(CONFIGS), help=f"comma list from {CONFIGS + CHECK_CONFIGS}")
    ap.add_argument("--tasks", default="", help="comma list of task ids (default: all)")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=600, help="contestant timeout in seconds (default 600)")
    ap.add_argument("--budget", type=float, default=None, help="stop before starting a run once the ledger total reaches this many USD")
    ap.add_argument("--ledger", default=os.environ.get("H2H_LEDGER", ""), help="JSONL file of spend across invocations (one line per run)")
    ap.add_argument("--out", default="", help="results JSON path (default results/<date>-<shortsha>.json)")
    ap.add_argument("--keep", action="store_true", help="keep each run's work dir and print its path")
    a = ap.parse_args(argv)

    configs = [c for c in a.configs.split(",") if c]
    for c in configs:
        if c not in CONFIGS + CHECK_CONFIGS:
            ap.error(f"unknown config {c}")
    all_tasks = sorted(p.name for p in TASKS_DIR.iterdir() if (p / "meta.json").is_file())
    task_ids = [t for t in a.tasks.split(",") if t] or all_tasks
    for t in task_ids:
        if t not in all_tasks:
            ap.error(f"unknown task {t}")
    tasks = [load_task(t) for t in task_ids]

    sha = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or "nogit"
    out = Path(a.out) if a.out else HERE / "results" / f"{dt.date.today().isoformat()}-{sha}.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    tmp_root = Path(os.environ.get("TMPDIR") or "/tmp").resolve()
    work = Path(tempfile.mkdtemp(prefix="loki-h2h.", dir=tmp_root))
    results, stopped = [], None
    try:
        if any(c not in CHECK_CONFIGS for c in configs):
            ok, detail = auth_ok(work)
            if not ok:
                log(f"h2h: claude auth does not resolve under the throwaway HOME; refusing to run\n{detail}")
                return 3
        for rep in range(1, a.reps + 1):
            for task in tasks:
                for c in configs:
                    spent = ledger_total(a.ledger)
                    if a.budget is not None and spent >= a.budget:
                        stopped = f"budget {a.budget} reached (ledger {spent:.4f})"
                        raise StopIteration
                    log(f"h2h: {c} {task['id']} rep {rep} (ledger ${spent:.4f})")
                    rec = run_one(c, task, rep, work, a.timeout, a.keep)
                    results.append(rec)
                    if a.ledger and c not in CHECK_CONFIGS:
                        with open(a.ledger, "a") as fh:
                            fh.write(json.dumps({"config": c, "task": task["id"], "cost_usd": rec.get("cost_usd"), "at": dt.datetime.now().isoformat()}) + "\n")
                    log(f"h2h:   pass={rec['pass']} {rec['seconds']}s cost={rec.get('cost_usd')} sessions={rec.get('sessions')} files={rec['files_changed']}")
                    write_results(out, results, configs, sha, a, stopped)
    except StopIteration:
        log(f"h2h: stopped: {stopped}")
    finally:
        if work.name.startswith("loki-h2h.") and work.parent == tmp_root and not a.keep:
            shutil.rmtree(work, ignore_errors=True)
    write_results(out, results, configs, sha, a, stopped)
    rows = summarize(results, configs)
    print(markdown(rows, results, configs))
    print(f"\nresults: {out}")
    leaks = [r for r in results if r["hidden_leaked_before_scoring"]]
    if leaks:
        log(f"h2h: hidden test files were present before scoring in {len(leaks)} runs")
        return 4
    return 0


def write_results(out, results, configs, sha, a, stopped):
    doc = {
        "benchmark": "h2h-b1", "loki_sha": sha, "date": dt.datetime.now().isoformat(timespec="seconds"),
        "configs": configs, "reps": a.reps, "timeout_s": a.timeout, "stopped": stopped,
        "summary": summarize(results, configs), "runs": results,
    }
    out.write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
