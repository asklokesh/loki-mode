#!/usr/bin/env python3
"""loki workspace: run one issue across several repos (D51 Phase B, D65).

    loki workspace list
    loki workspace show <name>
    loki workspace run <name> <issue-ref>
    loki workspace status [<run-id>]

On by default (LOKI_WORKSPACES=0 disables). Workspaces are defined in loki.yaml:

    workspaces:
      shop:
        repos:
          - {repo: acme/api, path: ~/src/api, setup: "npm ci"}
          - {repo: acme/web, path: ~/src/web, after: [acme/api]}
        integration: {command: "make e2e", timeout_s: 900}

Each repo gets its own worktree and engine run (continue-and-report: a failing
repo does not stop the others; dependents of a failed repo are SKIPPED). After
every repo has finished, the integration command runs once with each run branch
checked out, and evidence lands in
.loki/workspaces/<name>/<run-id>/integration.json. Integration evidence is not
part of the Seal.

Repos with no pending `after` run in parallel, at most `concurrency` at once
(workspace key or LOKI_WORKSPACE_CONCURRENCY, default 2). SIGINT and SIGTERM
kill each recorded child process group.

Exit: 0 all repos ok and integration not failed; 3 when the only non-ok
outcomes are budget stops (child exit 3); 1 otherwise; 2 usage/config.

Test seam: LOKI_WORKSPACE_LAUNCHER replaces the engine launcher (called with
the issue ref or task text, cwd = the repo worktree).
"""
import datetime
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REF_RE = re.compile(r"^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\d+)$")


def say(msg):
    print(msg, flush=True)


BUDGET_EXIT = 3


def enabled(env=None):
    """On by default; LOKI_WORKSPACES=0 disables."""
    return (os.environ if env is None else env).get("LOKI_WORKSPACES") != "0"


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)


def load_workspaces(cfg=None):
    """Return (workspaces, errors) from loki.yaml (or the given cfg mapping)."""
    if cfg is None:
        import loki_yaml
        cfg, _path, errors = loki_yaml.load()
        if errors:
            return {}, errors
    return cfg.get("workspaces") or {}, []


def order_repos(ws):
    """Return repo entries ordered so every `after` predecessor comes first.

    Raises ValueError on an unknown `after` entry, a duplicate repo or a cycle.
    """
    entries = list(ws.get("repos") or [])
    names = [e.get("repo") for e in entries]
    if len(set(names)) != len(names):
        raise ValueError("duplicate repo in workspace")
    for e in entries:
        if not isinstance(e.get("repo"), str) or not REPO_RE.match(e["repo"]):
            raise ValueError("repo must be owner/name, got %r" % (e.get("repo"),))
        for dep in e.get("after") or []:
            if dep not in names:
                raise ValueError("%s: unknown after repo %s" % (e["repo"], dep))
    done, ordered, remaining = set(), [], entries
    while remaining:
        ready = [e for e in remaining if all(d in done for d in e.get("after") or [])]
        if not ready:
            raise ValueError("cycle in `after`: " + ", ".join(e["repo"] for e in remaining))
        for e in ready:
            ordered.append(e)
            done.add(e["repo"])
        remaining = [e for e in remaining if e not in ready]
    return ordered


def _slug(repo):
    return repo.replace("/", "__")


def source_checkout(entry):
    """Local checkout for a repo entry: its `path`, else clone into ~/.loki/repos/<slug>."""
    if entry.get("path"):
        return os.path.abspath(os.path.expanduser(entry["path"]))
    dest = os.path.join(os.path.expanduser("~"), ".loki", "repos", _slug(entry["repo"]))
    if not os.path.isdir(os.path.join(dest, ".git")):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        r = subprocess.run(["git", "clone", "https://github.com/%s.git" % entry["repo"], dest],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("clone failed: " + (r.stderr.strip().splitlines() or ["git error"])[-1])
    return dest


def prepare(source, dest, branch, setup):
    """Make a worktree via worktree_prep when available, else a minimal `git worktree add`."""
    try:
        import worktree_prep
        res = worktree_prep.prepare_worktree(source, dest, branch, setup=setup)
        return res["path"]
    except ImportError:
        pass
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    r = git("worktree", "add", "-B", branch, dest, "HEAD", cwd=source)
    if r.returncode != 0:
        raise RuntimeError("worktree: " + (r.stderr.strip().splitlines() or ["git error"])[-1])
    if setup:
        s = subprocess.run(setup, shell=True, cwd=dest, capture_output=True, text=True)
        if s.returncode != 0:
            raise RuntimeError("setup failed: " + (s.stderr.strip().splitlines() or ["no output"])[-1])
    return dest


def task_for(entry, ref, siblings):
    """(launcher argument, extra env) for a repo: the issue ref when it lives here, else task text."""
    m = REF_RE.match(ref)
    if m and m.group(1) == entry["repo"]:
        return ref, {}
    text = ("Implement the change described by %s for the repo %s. Sibling worktrees (read-only "
            "context, do not edit): %s" % (ref, entry["repo"], ", ".join(siblings) or "none"))
    return text, {"LOKI_E10_TASK_TEXT": text}


def run_integration(ws, run_dir, worktrees, heads):
    """Run the integration command once; return the evidence dict."""
    integ = ws.get("integration") or {}
    cmd = integ.get("command")
    ev = {"heads": heads, "exit_code": None, "log_sha256": None, "status": "not_configured",
          "seal": False, "note": "integration evidence is not part of the Seal"}
    if not cmd:
        return ev
    timeout = integ.get("timeout_s", 900)
    env = dict(os.environ)
    for repo, wt in worktrees.items():
        env["LOKI_WS_DIR_" + re.sub(r"[^A-Za-z0-9]", "_", repo).upper()] = wt
    log_path = os.path.join(run_dir, "integration.log")
    with open(log_path, "wb") as lf:
        p = subprocess.Popen(cmd, shell=True, cwd=run_dir, env=env, stdout=lf, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            rc = p.wait(timeout=timeout)
            ev["status"] = "passed" if rc == 0 else "failed"
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait()
            rc = 124
            ev["status"] = "failed"
            ev["note"] += "; timeout after %ss" % timeout
    ev["exit_code"] = rc
    with open(log_path, "rb") as f:
        ev["log_sha256"] = hashlib.sha256(f.read()).hexdigest()
    return ev


def run_workspace(name, ref, workspaces, base_dir=None, launcher=None):
    """Run the workspace; return (exit_code, evidence_path_or_None)."""
    ws = workspaces.get(name)
    if ws is None:
        say("workspace: unknown workspace %r (known: %s)" % (name, ", ".join(sorted(workspaces)) or "none"))
        return 2, None
    try:
        ordered = order_repos(ws)
    except ValueError as e:
        say("workspace: %s: %s" % (name, e))
        return 2, None
    if not ordered:
        say("workspace: %s has no repos" % name)
        return 2, None

    base_dir = base_dir or os.getcwd()
    run_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run_dir = os.path.join(base_dir, ".loki", "workspaces", name, run_id)
    os.makedirs(run_dir, exist_ok=True)
    launcher = launcher or os.environ.get("LOKI_WORKSPACE_LAUNCHER") or os.path.join(REPO_ROOT, "bin", "loki")
    child_env_base = dict(os.environ, LOKI_ENGINE="v10", LOKI_NO_BROWSER="1")

    outcome, worktrees, heads, kind = {}, {}, {}, {}
    running = {}  # repo -> (Popen, log file handle)
    try:
        conc = max(1, int(os.environ.get("LOKI_WORKSPACE_CONCURRENCY") or ws.get("concurrency") or 2))
    except (TypeError, ValueError):
        conc = 2

    def stop(*_):
        for p, _lf in running.values():
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass
        sys.exit(130)
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)

    index = {e["repo"]: i for i, e in enumerate(ordered)}
    pending = list(ordered)
    while pending or running:
        for entry in list(pending):
            repo = entry["repo"]
            deps = entry.get("after") or []
            failed_dep = [d for d in deps if d in kind and kind[d] != "ok"]
            if failed_dep:
                pending.remove(entry)
                outcome[repo] = "SKIPPED (predecessor failed: %s)" % ", ".join(failed_dep)
                kind[repo] = "budget" if all(kind[d] == "budget" for d in failed_dep) else "fail"
                say("workspace: %s %s" % (repo, outcome[repo]))
        for entry in list(pending):
            repo = entry["repo"]
            if len(running) >= conc:
                break
            if not all(kind.get(d) == "ok" for d in entry.get("after") or []):
                continue
            pending.remove(entry)
            try:
                src = source_checkout(entry)
                dest = os.path.join(run_dir, "worktrees", _slug(repo))
                wt = prepare(src, dest, "loki/ws-%s-%d" % (run_id, index[repo]), entry.get("setup"))
            except (RuntimeError, OSError) as e:
                outcome[repo], kind[repo] = "FAILED: %s" % e, "fail"
                say("workspace: %s %s" % (repo, outcome[repo]))
                continue
            worktrees[repo] = wt
            siblings = [os.path.join(run_dir, "worktrees", _slug(o["repo"])) for o in ordered if o["repo"] != repo]
            arg, extra = task_for(entry, ref, siblings)
            lf = open(os.path.join(run_dir, "%s.log" % _slug(repo)), "w")
            say("workspace: %s running" % repo)
            p = subprocess.Popen([launcher, arg], cwd=wt, env=dict(child_env_base, **extra), stdout=lf,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
            running[repo] = (p, lf)
        for repo, (p, lf) in list(running.items()):
            rc = p.poll()
            if rc is None:
                continue
            lf.close()
            running.pop(repo)
            if rc == 0:
                outcome[repo], kind[repo] = "ok", "ok"
            else:
                outcome[repo] = "FAILED: exit %d" % rc
                kind[repo] = "budget" if rc == BUDGET_EXIT else "fail"
            say("workspace: %s %s" % (repo, outcome[repo]))
        if running:
            time.sleep(0.05)

    for repo, wt in worktrees.items():
        r = git("rev-parse", "HEAD", cwd=wt)
        heads[repo] = r.stdout.strip() if r.returncode == 0 else None

    ev = run_integration(ws, run_dir, worktrees, heads)
    ev["outcomes"] = outcome
    ev_path = os.path.join(run_dir, "integration.json")
    tmp = ev_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ev, f, indent=2, sort_keys=True)
    os.replace(tmp, ev_path)

    try:
        import workspace_comment
        workspace_comment.post_comments(name, run_id, run_dir, worktrees, ev, say)
    except Exception as e:  # commenting must never fail the run
        say("workspace: commenting skipped (%s)" % type(e).__name__)

    say("")
    say("Summary: workspace %s (%s)" % (name, run_id))
    for repo, res in outcome.items():
        say("%-30s %s" % (repo, res))
    say("%-30s %s" % ("integration", ev["status"]))
    if ev["status"] == "failed" or any(k == "fail" for k in kind.values()):
        return 1, ev_path
    return (3 if any(k == "budget" for k in kind.values()) else 0), ev_path


def _runs(base_dir):
    """Yield (workspace, run_id, evidence dict) for every recorded run, oldest first."""
    root = os.path.join(base_dir, ".loki", "workspaces")
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        for run_id in sorted(os.listdir(os.path.join(root, name))):
            path = os.path.join(root, name, run_id, "integration.json")
            try:
                with open(path) as f:
                    yield name, run_id, json.load(f)
            except (OSError, ValueError):
                continue


def status(base_dir, run_id=None, say=say):
    """Print per-repo rows from integration.json for one run, or for every run."""
    found = [r for r in _runs(base_dir) if run_id in (None, r[1])]
    if not found:
        say("workspace: no such run %s" % run_id if run_id else "no workspace runs recorded")
        return 0 if run_id is None else 1
    for name, rid, ev in found:
        say("%s %s" % (name, rid))
        for repo, res in sorted((ev.get("outcomes") or {}).items()):
            say("%-30s %s" % (repo, res))
        say("%-30s %s" % ("integration", ev.get("status")))
    return 0


def show(name, workspaces, say=say):
    ws = workspaces.get(name)
    if ws is None:
        say("workspace: unknown workspace %r (known: %s)" % (name, ", ".join(sorted(workspaces)) or "none"))
        return 2
    say("%s (concurrency %s)" % (name, ws.get("concurrency") or 2))
    for e in ws.get("repos") or []:
        extra = "; after: " + ", ".join(e["after"]) if e.get("after") else ""
        say("%s  path: %s%s" % (e.get("repo", "?"), e.get("path") or "(clone)", extra))
    integ = ws.get("integration") or {}
    say("integration: %s" % (integ.get("command") or "not configured"))
    return 0


def main(argv):
    if not enabled():
        say("loki workspace is disabled (LOKI_WORKSPACES=0). Unset it to use workspaces.")
        return 2
    if not argv or argv[0] in ("-h", "--help", "help"):
        say("Usage: loki workspace list | show <name> | run <name> <owner/repo#N | task text> | status [<run-id>]")
        return 0 if argv else 2
    try:
        workspaces, errors = load_workspaces()
    except Exception as e:  # CannotCheck or parse failure
        say("workspace: cannot read loki.yaml: %s" % e)
        return 2
    if errors:
        for e in errors:
            say("workspace: config error: %s" % e)
        return 2
    cmd = argv[0]
    if cmd == "list":
        if not workspaces:
            say("no workspaces defined in loki.yaml")
        for n, ws in sorted(workspaces.items()):
            say("%s: %s" % (n, ", ".join(e.get("repo", "?") for e in ws.get("repos") or [])))
        return 0
    if cmd == "show" and len(argv) == 2:
        return show(argv[1], workspaces)
    if cmd == "status" and len(argv) <= 2:
        return status(os.getcwd(), argv[1] if len(argv) == 2 else None)
    if cmd == "run" and len(argv) >= 3:
        rc, _ = run_workspace(argv[1], " ".join(argv[2:]), workspaces)
        return rc
    say("Usage: loki workspace list | show <name> | run <name> <issue-ref> | status [<run-id>]")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
