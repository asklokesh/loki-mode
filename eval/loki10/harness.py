#!/usr/bin/env python3
"""Loki 10 eval harness: task validator, runner, scorer.

Subcommands (run.sh and summarize are thin wrappers around these):
  validate <task_dir>...
  run --arm <v10|raw-claude|legacy> (--task ID | --all) [--parallel N] [--out DIR] [--tasks-dir DIR]
  summarize <results.jsonl> [--markdown]

Honesty rules (the v10.0.0 release gate depends on them):
  - completed = pr_opened and hidden_pass and not capped and the arm really ran.
  - cost_usd is only ever a provider-reported figure; missing means null.
  - an arm that is not installed, or a v10 run that leaves no engine marker,
    is arm_unavailable, never a pass.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
ARMS = ("v10", "raw-claude", "legacy")
KINDS = ("augmentiq", "public", "quickstart")
TASK_KEYS = {"id", "kind", "prompt", "issue_ref", "repo", "setup", "hidden", "timeout_s"}
DEFAULT_TIMEOUT_S = 900
GIT_TIMEOUT_S = 600
ZERO_SHA = "0" * 40
BASE_BRANCH = "main"
# Positive signal that the v10 engine (not a legacy fallback) ran. The v10
# engine must write this file in the checkout with {"engine": "v10"}.
V10_MARKER = os.path.join(".loki", "engine.json")
PUSH_INSTRUCTION = ("\n\nImplement this in the current repository. Create a new git "
                    "branch, commit your changes on it, and push that branch to origin.")
SCRUB_ENV = ("GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")


# ---------------------------------------------------------------- validate

def validate_task(task_dir):
    """Return (task_or_None, [errors]). Hidden paths are a trust boundary."""
    errs = []
    path = os.path.join(task_dir, "task.json")
    try:
        with open(path, encoding="utf-8") as f:
            t = json.load(f)
    except (OSError, ValueError) as e:
        return None, ["%s: unreadable task.json: %s" % (task_dir, e)]
    if not isinstance(t, dict):
        return None, ["%s: task.json is not an object" % task_dir]
    for k in sorted(set(t) - TASK_KEYS):
        errs.append("unknown key %r" % k)
    tid = t.get("id")
    if not isinstance(tid, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", tid):
        errs.append("id must match [A-Za-z0-9._-]+")
    elif tid != os.path.basename(os.path.normpath(task_dir)):
        errs.append("id %r does not match directory name" % tid)
    if t.get("kind") not in KINDS:
        errs.append("kind must be one of %s" % "|".join(KINDS))
    if not isinstance(t.get("prompt"), str) or not t["prompt"].strip():
        errs.append("prompt must be a non-empty string")
    ir = t.get("issue_ref")
    if ir is not None and not (isinstance(ir, str) and re.fullmatch(r"[\w.-]+/[\w.-]+#\d+", ir)):
        errs.append("issue_ref must be null or owner/repo#N")
    repo = t.get("repo")
    if not isinstance(repo, dict):
        errs.append("repo must be an object")
    else:
        src = repo.get("source")
        if not isinstance(src, str) or not (src.startswith("/") or "://" in src or src.startswith("git@")):
            errs.append("repo.source must be a git url or absolute path")
        if not isinstance(repo.get("ref"), str) or not re.fullmatch(r"[0-9a-f]{7,40}", repo["ref"]):
            errs.append("repo.ref must be a commit sha (7-40 lowercase hex)")
    if t.get("setup") is not None and not isinstance(t.get("setup"), str):
        errs.append("setup must be a string or null")
    hidden = t.get("hidden")
    if not isinstance(hidden, dict):
        errs.append("hidden must be an object")
    else:
        files = hidden.get("files")
        if not isinstance(files, list) or not files:
            errs.append("hidden.files must be a non-empty list")
        else:
            for rel in files:
                if not isinstance(rel, str) or not rel or os.path.isabs(rel) \
                        or ".." in rel.replace("\\", "/").split("/"):
                    errs.append("hidden.files entry %r must be a relative path without '..'" % (rel,))
                elif not os.path.isfile(os.path.join(task_dir, "hidden", rel)):
                    errs.append("hidden file missing: hidden/%s" % rel)
        if not isinstance(hidden.get("run"), str) or not hidden["run"].strip():
            errs.append("hidden.run must be a non-empty command")
    ts = t.get("timeout_s", DEFAULT_TIMEOUT_S)
    if isinstance(ts, bool) or not isinstance(ts, int) or ts <= 0:
        errs.append("timeout_s must be a positive integer")
    return (None if errs else t), ["%s: %s" % (task_dir, e) for e in errs]


def cmd_validate(args):
    bad = 0
    for d in args.task_dirs:
        _, errs = validate_task(d)
        for e in errs:
            print("INVALID " + e, file=sys.stderr)
        bad += bool(errs)
        if not errs:
            print("ok " + d)
    return 1 if bad else 0


# ---------------------------------------------------------------- run helpers

class Children:
    """PIDs this runner started. Only these are ever signalled."""

    def __init__(self, pidfile):
        self.lock = threading.Lock()
        self.procs = {}
        self.pidfile = pidfile
        self.stopping = False

    def _flush(self):
        with open(self.pidfile, "w") as f:
            f.write("".join("%d\n" % p for p in self.procs))

    def add(self, p):
        with self.lock:
            self.procs[p.pid] = p
            self._flush()

    def remove(self, p):
        with self.lock:
            self.procs.pop(p.pid, None)
            self._flush()

    def stop_all(self):
        with self.lock:
            self.stopping = True
            for pid, p in list(self.procs.items()):
                if p.poll() is None:
                    # The child is `timeout`, which forwards TERM to its group.
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except OSError:
                        pass


CHILDREN = None
TIMEOUT_BIN = shutil.which("timeout") or shutil.which("gtimeout")


def capped_run(argv, cwd, env, cap_s, log_path, stdout_path=None):
    """Run argv under `timeout -k 10 cap_s`. Returns (rc, wall_s, capped)."""
    if CHILDREN.stopping:
        raise RuntimeError("runner is stopping; no new children")
    t0 = time.time()
    with open(log_path, "ab") as err, open(stdout_path or log_path, "ab") as out:
        p = subprocess.Popen([TIMEOUT_BIN, "-k", "10", str(int(cap_s))] + argv,
                             cwd=cwd, env=dict(env, PWD=cwd), stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        CHILDREN.add(p)
        try:
            rc = p.wait()
        finally:
            CHILDREN.remove(p)
    wall = time.time() - t0
    # 124 = timeout sent TERM; 137 = the -k KILL followed.
    return rc, round(wall, 3), rc in (124, 137) and wall >= cap_s - 1


def sh(cmd, cwd, env, log, cap_s=GIT_TIMEOUT_S):
    return capped_run(["bash", "-c", cmd], cwd, env, cap_s, log)[0]


def git(args, cwd, env, log, cap_s=GIT_TIMEOUT_S):
    return capped_run(["git"] + args, cwd, env, cap_s, log)[0]


def git_out(args, cwd):
    r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=60)
    return r.stdout.strip() if r.returncode == 0 else ""


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


def default_model():
    with open(os.path.join(REPO, "providers", "model_catalog.json"), encoding="utf-8") as f:
        claude = json.load(f)["providers"]["claude"]
    # First planning-tier entry is the default (providers/models.sh contract).
    return next(m["id"] for m in claude["models"] if m.get("tier") == "planning"), claude.get("cli_aliases", {})


def arm_env(rundir, model, alias):
    # Operator and harness state must not steer the arm: inherited LOKI_* knobs
    # (including LOKI_RUN_TMP, the harness's own tmp), nested-Claude-session
    # vars, and tokens are all dropped. Only what is set below reaches it.
    env = {k: v for k, v in os.environ.items()
           if k not in SCRUB_ENV and k not in ("CLAUDECODE", "CLAUDE_PROJECT_DIR", "OLDPWD")
           and not k.startswith(("LOKI_", "CLAUDE_CODE_"))}
    gh = os.path.join(rundir, "gh-config")
    os.makedirs(gh, exist_ok=True)
    env.update({
        "GH_CONFIG_DIR": gh,            # gh keyring login is invisible to the arm
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_SSH_COMMAND": "false",     # origin is a local bare repo; no ssh ever
        "LOKI_NO_BROWSER": "1",
        "LOKI_DASHBOARD": "false",
        "LOKI_EVAL_MODEL": model,
        "LOKI_SESSION_MODEL": alias,
        "LOKI_MODEL_OVERRIDE": model,
    })
    return env


def prepare_checkout(task, rundir, env, log):
    """Fresh clone at repo.ref with only that history; origin -> local bare repo."""
    work = os.path.join(rundir, "work")
    remote = os.path.join(rundir, "remote.git")
    src, ref = task["repo"]["source"], task["repo"]["ref"]
    steps = [
        (["clone", "--no-local", "--no-tags", "-q", src, work], rundir),
        (["checkout", "-q", "-B", BASE_BRANCH, ref], work),
        (["remote", "remove", "origin"], work),
    ]
    for a, cwd in steps:
        if git(a, cwd, env, log) != 0:
            return None
    # Drop every other ref and unreachable object so no later commit (the fix)
    # is readable from the arm's checkout.
    for b in git_out(["for-each-ref", "--format=%(refname)", "refs/"], work).splitlines():
        if b != "refs/heads/" + BASE_BRANCH:
            git(["update-ref", "-d", b], work, env, log)
    steps = [
        (["reflog", "expire", "--expire=now", "--all"], work),
        (["gc", "-q", "--prune=now"], work),
        (["init", "-q", "--bare", remote], rundir),
        (["remote", "add", "origin", remote], work),
        (["push", "-q", "origin", BASE_BRANCH], work),
        (["symbolic-ref", "HEAD", "refs/heads/" + BASE_BRANCH], remote),
        (["config", "credential.helper", ""], work),
        (["config", "user.name", "loki-eval"], work),
        (["config", "user.email", "loki-eval@localhost"], work),
    ]
    for a, cwd in steps:
        if git(a, cwd, env, log) != 0:
            return None
    hook = os.path.join(remote, "hooks", "post-receive")
    with open(hook, "w") as f:
        f.write('#!/bin/sh\nnow=$(date +%s)\nwhile read -r old new ref; do\n'
                '  echo "$now $old $new $ref" >> "$GIT_DIR/pushes.log"\ndone\n')
    os.chmod(hook, 0o755)
    return work, remote


def find_pr(remote, base_sha):
    """(branch, head_sha, first_push_epoch) of the pushed PR branch, or None."""
    try:
        with open(os.path.join(remote, "pushes.log")) as f:
            lines = [ln.split() for ln in f if ln.strip()]
    except OSError:
        return None
    cand = [ln for ln in lines if len(ln) == 4 and ln[3].startswith("refs/heads/")
            and ln[3] != "refs/heads/" + BASE_BRANCH and ln[2] not in (ZERO_SHA, base_sha)]
    if not cand:
        return None
    for ln in reversed(cand):
        head = git_out(["rev-parse", "--verify", "-q", ln[3]], remote)
        if head and head != base_sha:
            first = min(int(c[0]) for c in cand if c[3] == ln[3])
            return ln[3][len("refs/heads/"):], head, first
    return None


def provider_cost(arm, stdout_path, work):
    """Provider-reported cost only. Returns (usd_or_None, source)."""
    if arm == "raw-claude":
        try:
            with open(stdout_path, encoding="utf-8", errors="replace") as f:
                text = f.read().strip()
        except OSError:
            return None, "not reported"
        # Decode a JSON document starting at every line that opens one, so a
        # single-line object, a pretty-printed message array, and stray
        # output before either all parse. The last document wins.
        dec, docs = json.JSONDecoder(), []
        for m in re.finditer(r"(?m)^[\[{]", text):
            try:
                docs.append(dec.raw_decode(text, m.start())[0])
            except ValueError:
                continue
        for d in reversed(docs):
            items = d if isinstance(d, list) else [d]
            for it in reversed(items):
                v = it.get("total_cost_usd") if isinstance(it, dict) else None
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    return float(v), "claude total_cost_usd"
        return None, "not reported"
    r = subprocess.run([sys.executable, os.path.join(REPO, "autonomy", "lib", "cost-summary.py"),
                        work, "--json"], capture_output=True, text=True, timeout=120)
    try:
        s = json.loads(r.stdout)
    except ValueError:
        return None, "not reported"
    # A partially measured run is a lower bound, not a figure.
    if s.get("fully_measured") and isinstance(s.get("total_cost_usd"), (int, float)):
        return float(s["total_cost_usd"]), "loki cost-summary (fully measured)"
    return None, "not reported"


# ---------------------------------------------------------------- one run

def run_one(task, task_dir, arm, cfg):
    tid = task["id"]
    cap = task.get("timeout_s", DEFAULT_TIMEOUT_S)
    slot = "%s.%s.%d" % (tid, arm, int(time.time() * 1000))
    rundir = os.path.join(cfg["tmp"], slot)
    logdir = os.path.join(cfg["out"], "logs", slot)
    os.makedirs(rundir)
    os.makedirs(logdir)
    L = {k: os.path.join(logdir, k + ".log") for k in ("prepare", "setup", "arm_stdout", "arm_stderr", "grade")}
    row = {"task": tid, "arm": arm, "status": "ok", "model": cfg["model"],
           "repo_ref": task["repo"]["ref"], "harness_sha": cfg["harness_sha"],
           "started": None, "ended": None, "wall_s": None, "time_to_pr_s": None,
           "pr_opened": False, "pr_branch": None, "hidden_pass": False, "completed": False,
           "cost_usd": None, "cost_source": "not reported", "exit_code": None,
           "capped": False, "logs": L}
    env = arm_env(rundir, cfg["model"], cfg["alias"])

    binary = cfg["claude_bin"] if arm == "raw-claude" else cfg["loki_bin"]
    if not shutil.which(binary):
        row["status"] = "arm_unavailable"
        row["unavailable_reason"] = "%s not found" % binary
        return row

    prep = prepare_checkout(task, rundir, env, L["prepare"])
    if not prep:
        row["status"] = "prepare_failed"
        return row
    work, remote = prep
    if task.get("setup") and sh(task["setup"], work, env, L["setup"], cap) != 0:
        row["status"] = "setup_failed"
        return row

    prompt = task["prompt"]
    if arm == "raw-claude":
        argv = [binary, "-p", prompt + PUSH_INSTRUCTION, "--output-format", "json",
                "--dangerously-skip-permissions", "--model", cfg["model"]]
    elif arm == "v10":
        env["LOKI_ENGINE"] = "v10"
        argv = [binary, prompt]
    else:
        pfile = os.path.join(rundir, "prompt.md")
        with open(pfile, "w", encoding="utf-8") as f:
            f.write(prompt + PUSH_INSTRUCTION + "\n")
        argv = [binary, "start", pfile]

    started = time.time()
    rc, wall, capped = capped_run(argv, work, env, cap, L["arm_stderr"], L["arm_stdout"])
    row.update(started=iso(started), ended=iso(time.time()), wall_s=wall, exit_code=rc, capped=capped)
    row["cost_usd"], row["cost_source"] = provider_cost(arm, L["arm_stdout"], work)

    if arm == "v10":
        try:
            with open(os.path.join(work, V10_MARKER), encoding="utf-8") as f:
                ok = json.load(f).get("engine") == "v10"
        except (OSError, ValueError, AttributeError):
            ok = False
        if not ok:
            row["status"] = "arm_unavailable"
            row["unavailable_reason"] = "no v10 engine marker at %s" % V10_MARKER
            return row

    base_sha = git_out(["rev-parse", BASE_BRANCH], remote)
    pr = find_pr(remote, base_sha)
    grade_dir = work
    if pr:
        branch, head, pushed_at = pr
        row.update(pr_opened=True, pr_branch=branch, time_to_pr_s=max(0, pushed_at - int(started)))
        L["pr_record"] = os.path.join(logdir, "pr.json")
        with open(L["pr_record"], "w") as f:
            json.dump({"task": tid, "arm": arm, "branch": branch, "head_sha": head,
                       "base_sha": base_sha, "pushed_at": iso(pushed_at)}, f, indent=2)
        # Grade exactly what the PR contains, in a fresh clone.
        grade_dir = os.path.join(rundir, "grade")
        if git(["clone", "-q", "--no-tags", "-b", branch, remote, grade_dir], rundir, env, L["grade"]) != 0 \
                or (task.get("setup") and sh(task["setup"], grade_dir, env, L["grade"], cap) != 0):
            return row
    hidden_root = os.path.join(task_dir, "hidden")
    for rel in task["hidden"]["files"]:
        dst = os.path.join(grade_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(hidden_root, rel), dst)
    row["hidden_pass"] = sh(task["hidden"]["run"], grade_dir, env, L["grade"], cap) == 0
    row["completed"] = row["pr_opened"] and row["hidden_pass"] and not capped
    return row


def cmd_run(args):
    global CHILDREN
    if not TIMEOUT_BIN:
        print("error: GNU timeout (or gtimeout) is required", file=sys.stderr)
        return 2
    tmp = os.environ.get("LOKI_RUN_TMP")
    if not tmp or not os.path.isfile(os.path.join(tmp, ".loki-run-owned")):
        print("error: run through run.sh (needs a run-owned LOKI_RUN_TMP)", file=sys.stderr)
        return 2
    tasks_dir = os.path.abspath(args.tasks_dir)
    ids = sorted(d for d in os.listdir(tasks_dir) if os.path.isfile(os.path.join(tasks_dir, d, "task.json"))) \
        if args.all else [args.task]
    tasks, bad = [], False
    for tid in ids:
        t, errs = validate_task(os.path.join(tasks_dir, tid))
        for e in errs:
            print("INVALID " + e, file=sys.stderr)
        bad |= bool(errs)
        if t:
            tasks.append((t, os.path.join(tasks_dir, tid)))
    if bad or not tasks:
        return 2

    model = os.environ.get("LOKI_EVAL_MODEL", "")
    top, aliases = default_model()
    model = model or top
    alias = next((a for a, m in aliases.items() if m == model), None)
    if not alias:
        print("error: model %s has no claude cli alias; loki arms cannot be pinned to it" % model, file=sys.stderr)
        return 2
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    CHILDREN = Children(os.path.join(tmp, "child-pids"))
    cfg = {"tmp": tmp, "out": out, "model": model, "alias": alias,
           "harness_sha": git_out(["rev-parse", "HEAD"], HERE),
           "claude_bin": os.environ.get("LOKI_EVAL_CLAUDE_BIN", "claude"),
           "loki_bin": os.environ.get("LOKI_EVAL_LOKI_BIN", "loki")}
    binary = cfg["claude_bin"] if args.arm == "raw-claude" else cfg["loki_bin"]
    version = ""
    if shutil.which(binary):
        r = subprocess.run([TIMEOUT_BIN, "-k", "5", "30", binary, "--version"],
                           capture_output=True, text=True)
        version = (r.stdout or r.stderr).strip()[:200]
    # One line per invocation, so several arms can share one --out.
    with open(os.path.join(out, "manifest.jsonl"), "a") as f:
        f.write(json.dumps({"arm": args.arm, "model": model, "arm_binary": binary,
                            "arm_version": version, "harness_sha": cfg["harness_sha"],
                            "tasks": [t["id"] for t, _ in tasks], "started": iso(time.time())}) + "\n")

    def on_signal(signum, _frame):
        CHILDREN.stop_all()
        sys.exit(128 + signum)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    max_load = float(os.environ.get("LOKI_EVAL_MAX_LOAD", "20"))
    start_lock = threading.Lock()
    write_lock = threading.Lock()
    results = os.path.join(out, "results.jsonl")

    def job(item):
        with start_lock:  # refuse to START a run while the box is overloaded
            while os.getloadavg()[0] > max_load and not CHILDREN.stopping:
                print("load %.1f > %.0f; waiting" % (os.getloadavg()[0], max_load), file=sys.stderr)
                time.sleep(10)
        if CHILDREN.stopping:  # queued behind a stop: never started, no row
            return
        try:
            row = run_one(item[0], item[1], args.arm, cfg)
        except Exception as e:  # a harness crash is recorded, never a pass
            row = {"task": item[0]["id"], "arm": args.arm, "status": "harness_error",
                   "error": repr(e), "completed": False, "pr_opened": False,
                   "hidden_pass": False, "capped": False, "cost_usd": None, "time_to_pr_s": None}
        if CHILDREN.stopping:  # in flight at the stop: not a verdict on the arm
            row.update(status="interrupted", completed=False)
        with write_lock:
            with open(results, "a") as f:
                f.write(json.dumps(row) + "\n")
        print("%s %s status=%s completed=%s" % (row["task"], args.arm, row["status"], row["completed"]))

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.parallel)) as ex:
        list(ex.map(job, tasks))
    print("results: " + results)
    return 0


# ---------------------------------------------------------------- summarize

def nearest_rank(values, pct):
    """Nearest-rank percentile; None for an empty list."""
    if not values:
        return None
    v = sorted(values)
    k = max(1, -(-pct * len(v) // 100))  # ceil(pct/100 * n)
    return v[int(k) - 1]


def summarize_rows(rows):
    out = {}
    for arm in sorted({r["arm"] for r in rows}):
        rs = [r for r in rows if r["arm"] == arm]
        unavailable = [r for r in rs if r.get("status") == "arm_unavailable"]
        # Only runs where the arm actually ran count toward its rate. Harness
        # or task infrastructure failures (prepare/setup/harness_error) and
        # interrupted runs are reported separately, never as arm misses.
        evaluated = [r for r in rs if r.get("status") == "ok"]
        infra = [r for r in rs if r.get("status") not in ("ok", "arm_unavailable")]
        done = [r for r in evaluated if r.get("completed")]
        ttp = [r["time_to_pr_s"] for r in done if r.get("time_to_pr_s") is not None]
        costed = [r for r in evaluated if r.get("cost_usd") is not None]
        cost_per = None
        if done and evaluated and len(costed) == len(evaluated):
            cost_per = round(sum(r["cost_usd"] for r in costed) / len(done), 4)
        out[arm] = {
            "runs": len(rs), "evaluated": len(evaluated), "completed": len(done),
            "completion_rate": round(len(done) / len(evaluated), 4) if evaluated else None,
            "p50_time_to_pr_s": nearest_rank(ttp, 50), "p90_time_to_pr_s": nearest_rank(ttp, 90),
            "cost_per_completed_usd": cost_per,
            "cost_measured_runs": len(costed),
            "capped": sum(1 for r in rs if r.get("capped")), "unavailable": len(unavailable),
            "infra_or_interrupted": len(infra),
        }
    return out


def miss_reason(r):
    if r.get("status") != "ok":
        return r.get("status") + (": " + r["unavailable_reason"] if r.get("unavailable_reason") else "")
    if r.get("capped"):
        return "capped at wall limit"
    if not r.get("pr_opened"):
        return "no branch pushed"
    return "hidden tests failed"


def fmt(v, suffix=""):
    return "n/a" if v is None else "%s%s" % (v, suffix)


def cmd_summarize(args):
    rows = []
    with open(args.results, encoding="utf-8") as f:
        rows = [json.loads(ln) for ln in f if ln.strip()]
    s = summarize_rows(rows)
    if args.json:
        print(json.dumps(s, indent=2))
        return 0
    if not args.markdown:
        for arm, a in s.items():
            print("%s: completion %s (%d/%d evaluated), p50 ttPR %s, p90 ttPR %s, cost/completed %s "
                  "(cost measured %d/%d), capped %d, unavailable %d, infra/interrupted %d" % (
                      arm, fmt(a["completion_rate"]), a["completed"], a["evaluated"],
                      fmt(a["p50_time_to_pr_s"], "s"), fmt(a["p90_time_to_pr_s"], "s"),
                      fmt(a["cost_per_completed_usd"]), a["cost_measured_runs"], a["evaluated"],
                      a["capped"], a["unavailable"], a["infra_or_interrupted"]))
        return 0
    print("### Loki 10 eval results\n")
    print("Completion = branch pushed to the local remote AND hidden tests pass AND not capped. "
          "Rate denominator counts only runs where the arm ran (excludes unavailable, infrastructure "
          "failures and interrupted runs). Time to PR percentiles are nearest-rank over "
          "completed runs. Cost is provider-reported only; n/a when any evaluated run lacks a figure.\n")
    print("| Arm | Completed | Rate | p50 time to PR | p90 time to PR | Cost per completed | Cost measured "
          "| Capped | Unavailable | Infra/interrupted |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for arm, a in s.items():
        rate = "n/a" if a["completion_rate"] is None else "%.1f%%" % (100 * a["completion_rate"])
        cost = "n/a" if a["cost_per_completed_usd"] is None else "$%.4f" % a["cost_per_completed_usd"]
        print("| %s | %d/%d | %s | %s | %s | %s | %d/%d | %d | %d | %d |" % (
            arm, a["completed"], a["evaluated"], rate, fmt(a["p50_time_to_pr_s"], "s"),
            fmt(a["p90_time_to_pr_s"], "s"), cost, a["cost_measured_runs"], a["evaluated"],
            a["capped"], a["unavailable"], a["infra_or_interrupted"]))
    misses = [r for r in rows if not r.get("completed")]
    print("\n#### Misses (%d)\n" % len(misses))
    for r in misses:
        print("- %s / %s: %s" % (r["task"], r["arm"], miss_reason(r)))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("task_dirs", nargs="+")
    r = sub.add_parser("run")
    r.add_argument("--arm", required=True, choices=ARMS)
    g = r.add_mutually_exclusive_group(required=True)
    g.add_argument("--task")
    g.add_argument("--all", action="store_true")
    r.add_argument("--parallel", type=int, default=3)
    r.add_argument("--out", default=os.path.join(HERE, "results"))
    r.add_argument("--tasks-dir", default=os.path.join(HERE, "tasks"))
    s = sub.add_parser("summarize")
    s.add_argument("results")
    s.add_argument("--markdown", action="store_true")
    s.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    return {"validate": cmd_validate, "run": cmd_run, "summarize": cmd_summarize}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
