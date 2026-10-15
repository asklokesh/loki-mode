#!/usr/bin/env python3
"""loki workspace: run one issue across several repos (D51 Phase B, D65).

    loki workspace list
    loki workspace show <name>
    loki workspace run <name> <issue-ref>
    loki workspace status [<run-id>]
    loki workspace infer <name>

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
.loki/workspaces/<name>/<run-id>/integration.json. When every repo finished ok,
integration did not fail and every child sealed a receipt, the run seals
composite.json (`loki verify --seal-composite`), which binds integration.json.
Otherwise the run prints "composite not sealed: <reason>".

With `plan: true` (workspace key) or LOKI_WORKSPACE_PLAN=1 one provider call
through the launcher seam writes <run-dir>/plan.json ({"<repo>": "<task>"});
a valid plan gives each listed repo its own task, an invalid one falls back to
the generic text and prints why.

Repos with no pending `after` run in parallel, at most `concurrency` at once
(workspace key or LOKI_WORKSPACE_CONCURRENCY, default 2). SIGINT and SIGTERM
kill each recorded child process group.

Exit: 0 all repos ok and integration not failed; 3 when the only non-ok
outcomes are budget stops (child exit 3); 1 otherwise; 2 usage/config.

`infer` prints suggested `after:` edges read from package.json, go.mod and
pyproject.toml dependencies on other listed repos (print-only, cycle-checked).
With `integration: {per_stage: true}` the integration command also runs after
each topological layer; a failing stage SKIPs every later layer, so a broken
contract stops before downstream repos build on it.

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


def layers_of(ordered):
    """Map repo -> topological layer (0 = no `after`), for an order_repos result."""
    layer = {}
    for e in ordered:
        layer[e["repo"]] = 1 + max([layer[d] for d in e.get("after") or []], default=-1)
    return layer


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


def load_plan(run_dir, repos):
    """(plan dict, reason): per-repo task text from run_dir/plan.json. Any problem gives ({}, reason)."""
    path = os.path.join(run_dir, "plan.json")
    try:
        with open(path) as f:
            plan = json.load(f)
    except FileNotFoundError:
        return {}, "plan.json was not written"
    except (OSError, ValueError) as e:
        return {}, "plan.json unreadable (%s)" % type(e).__name__
    if not isinstance(plan, dict) or not plan:
        return {}, "plan.json is not a non-empty object"
    unknown = sorted(k for k in plan if k not in repos)
    if unknown:
        return {}, "plan.json names repos outside the workspace: %s" % ", ".join(map(str, unknown))
    empty = sorted(k for k, v in plan.items() if not isinstance(v, str) or not v.strip())
    if empty:
        return {}, "plan.json has empty task text for: %s" % ", ".join(empty)
    return plan, None


def request_plan(ordered, ref, run_dir, launcher, env):
    """One launcher call asking for plan.json; returns (plan, reason). The launcher may ignore it."""
    repos = [e["repo"] for e in ordered]
    prompt = ("Plan the change described by %s across the repos %s. Write JSON to %s mapping each "
              "repo that needs work to its own task text. Do not edit any repo." %
              (ref, ", ".join(repos), os.path.join(run_dir, "plan.json")))
    try:
        timeout = int(os.environ.get("LOKI_WORKSPACE_PLAN_TIMEOUT") or 600)
    except ValueError:
        timeout = 600
    penv = dict(env, LOKI_E10_TASK_TEXT=prompt, LOKI_WORKSPACE_PLAN_OUT=os.path.join(run_dir, "plan.json"))
    try:
        subprocess.run([launcher, prompt], cwd=run_dir, env=penv, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=timeout,
                       start_new_session=True)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {}, "plan call failed (%s)" % type(e).__name__
    return load_plan(run_dir, set(repos))


def task_for(entry, ref, siblings, plan=None):
    """(launcher argument, extra env) for a repo: its planned task, else the issue ref when it lives here, else task text."""
    if plan and plan.get(entry["repo"]):
        text = "%s\n\nPart of: %s. Sibling worktrees (read-only context, do not edit): %s" % (
            plan[entry["repo"]].strip(), ref, ", ".join(siblings) or "none")
        return text, {"LOKI_E10_TASK_TEXT": text}
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
          "seal": False, "note": "integration evidence is bound by composite.json only when the run seals one"}
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


def _heads(worktrees):
    out = {}
    for repo, wt in worktrees.items():
        r = git("rev-parse", "HEAD", cwd=wt)
        out[repo] = r.stdout.strip() if r.returncode == 0 else None
    return out


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
    child_env_base = dict(os.environ, LOKI_NO_BROWSER="1")

    outcome, worktrees, heads, kind = {}, {}, {}, {}
    timing = {}  # repo -> {started_at, finished_at} epoch seconds
    running = {}  # repo -> (Popen, log file handle)
    try:
        conc = max(1, int(os.environ.get("LOKI_WORKSPACE_CONCURRENCY") or ws.get("concurrency") or 2))
    except (TypeError, ValueError):
        conc = 2

    plan = {}
    if ws.get("plan") is True or os.environ.get("LOKI_WORKSPACE_PLAN") == "1":
        plan, why = request_plan(ordered, ref, run_dir, launcher, child_env_base)
        if why:
            say("workspace: plan not used (%s); every repo gets the generic task" % why)
        else:
            say("workspace: plan accepted for %s" % ", ".join(sorted(plan)))

    def stop(*_):
        for p, _lf in running.values():
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except OSError:
                pass
        now = time.time()
        for r in list(running):
            outcome[r] = "INTERRUPTED"
            kind[r] = "fail"
            timing[r]["finished_at"] = now
        for e in pending:
            outcome.setdefault(e["repo"], "INTERRUPTED (not started)")
        try:
            ev_i = {"status": "interrupted", "outcomes": outcome,
                    "timing": {r: t for r, t in timing.items() if "finished_at" in t}}
            ip = os.path.join(run_dir, "integration.json")
            with open(ip + ".tmp", "w") as f:
                json.dump(ev_i, f, indent=2, sort_keys=True)
            os.replace(ip + ".tmp", ip)
        except OSError:
            pass
        sys.exit(130)
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)

    index = {e["repo"]: i for i, e in enumerate(ordered)}
    pending = list(ordered)
    per_stage = bool((ws.get("integration") or {}).get("per_stage"))
    layer = layers_of(ordered)
    gate, stages = {}, []  # layer -> "passed"/"failed"; stage evidence list

    def process_gates():
        """per_stage: once a layer has fully finished, gate it with the integration command."""
        for lv in sorted(set(layer.values())):
            members = [r for r, l in layer.items() if l == lv]
            if lv in gate or not all(r in kind for r in members):
                continue
            if any(l < lv and l not in gate for l in set(layer.values())):
                continue
            if any(kind[r] != "ok" for r in members):
                gate[lv] = "failed"
            else:
                sev = run_integration(ws, run_dir, worktrees, _heads(worktrees))
                sev["layer"] = lv
                stages.append(sev)
                gate[lv] = "failed" if sev["status"] == "failed" else "passed"
                say("workspace: stage %d integration %s" % (lv, sev["status"]))
            if gate[lv] == "failed":
                for e in list(pending):
                    if layer[e["repo"]] > lv:
                        pending.remove(e)
                        outcome[e["repo"]] = "SKIPPED (stage %d integration failed)" % lv
                        kind[e["repo"]] = "fail"
                        say("workspace: %s %s" % (e["repo"], outcome[e["repo"]]))

    while pending or running:
        if per_stage:
            process_gates()
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
            if per_stage and any(gate.get(lv) != "passed" for lv in range(layer[repo])):
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
            arg, extra = task_for(entry, ref, siblings, plan)
            lf = open(os.path.join(run_dir, "%s.log" % _slug(repo)), "w")
            say("workspace: %s running" % repo)
            p = subprocess.Popen([launcher, arg], cwd=wt, env=dict(child_env_base, **extra), stdout=lf,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
            running[repo] = (p, lf)
            timing[repo] = {"started_at": time.time()}
        for repo, (p, lf) in list(running.items()):
            rc = p.poll()
            if rc is None:
                continue
            lf.close()
            running.pop(repo)
            timing[repo]["finished_at"] = time.time()
            if rc == 0:
                outcome[repo], kind[repo] = "ok", "ok"
            else:
                outcome[repo] = "FAILED: exit %d" % rc
                kind[repo] = "budget" if rc == BUDGET_EXIT else "fail"
            say("workspace: %s %s" % (repo, outcome[repo]))
        if running:
            time.sleep(0.05)

    if per_stage:
        process_gates()
    heads = _heads(worktrees)

    if per_stage and stages:
        ev = dict(stages[-1], heads=heads, stages=[{k: v for k, v in s_.items() if k != "heads"} for s_ in stages])
    else:
        ev = run_integration(ws, run_dir, worktrees, heads)
    ev["outcomes"] = outcome
    ev["timing"] = {r: t for r, t in timing.items() if "finished_at" in t}
    ev_path = os.path.join(run_dir, "integration.json")
    tmp = ev_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ev, f, indent=2, sort_keys=True)
    os.replace(tmp, ev_path)

    seal_composite(ordered, outcome, ev, run_dir)

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


_SEAL_ENV_KEYS = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "BUN_INSTALL", "LOKI_NO_BROWSER",
                  "LOKI_RECEIPT_SIGNING_KEY", "LOKI_RECEIPT_SIGNING_KEY_FILE", "LOKI_TS_ENTRY", "BUN_FROM_SOURCE",
                  "LOKI_LEGACY_BASH")


def seal_composite(ordered, outcome, ev, run_dir):
    """Seal composite.json once when every repo finished ok with a receipt; otherwise say why not."""
    if ev.get("status") == "failed":
        say("composite not sealed: integration failed")
        return False
    for e in ordered:
        repo = e["repo"]
        if outcome.get(repo) != "ok":
            say("composite not sealed: %s did not finish ok (%s)" % (repo, outcome.get(repo, "no outcome")))
            return False
        runs = os.path.join(run_dir, "worktrees", _slug(repo), ".loki", "runs")
        try:
            has = any(os.path.isfile(os.path.join(runs, n, "receipt.json")) for n in os.listdir(runs))
        except OSError:
            has = False
        if not has:
            say("composite not sealed: %s has no receipt" % repo)
            return False
    env = {k: os.environ[k] for k in _SEAL_ENV_KEYS if k in os.environ}
    env["LOKI_NO_BROWSER"] = "1"
    exe = os.environ.get("LOKI_WORKSPACE_VERIFY") or os.path.join(REPO_ROOT, "bin", "loki")
    try:
        r = subprocess.run([exe, "verify", "--seal-composite", run_dir], env=env, capture_output=True,
                           text=True, stdin=subprocess.DEVNULL, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        say("composite not sealed: verify could not run (%s)" % type(e).__name__)
        return False
    if r.returncode != 0:
        last = (r.stderr.strip().splitlines() or r.stdout.strip().splitlines() or ["no output"])[-1]
        say("composite not sealed: verify exit %d (%s)" % (r.returncode, last))
        return False
    say("workspace: composite sealed: %s" % os.path.join(run_dir, "composite.json"))
    return True


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
            except FileNotFoundError:
                continue
            except (OSError, ValueError) as e:
                yield name, run_id, {"state": "unreadable", "status": "unreadable",
                                     "error": "%s: %s" % (type(e).__name__, e)}


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
        if ev.get("state") == "unreadable":
            say("%-30s %s (%s)" % ("integration", "unreadable", ev.get("error")))
            continue
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


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _identities(entry, root):
    """Names other repos may use to depend on this one (repo name, package, module)."""
    ids = {entry["repo"].split("/", 1)[1].lower()}
    pj = _read(os.path.join(root, "package.json"))
    if pj:
        try:
            n = json.loads(pj).get("name")
            if isinstance(n, str):
                ids.add(n.lower())
        except ValueError:
            pass
    gm = _read(os.path.join(root, "go.mod"))
    if gm:
        m = re.search(r"^module\s+(\S+)", gm, re.M)
        if m:
            ids.add(m.group(1).lower())
    pp = _read(os.path.join(root, "pyproject.toml"))
    if pp:
        m = re.search(r'^name\s*=\s*["\']([^"\']+)["\']', pp, re.M)
        if m:
            ids.add(m.group(1).lower().replace("_", "-"))
    return ids


def _dep_tokens(root):
    """Lower-cased dependency names/paths declared by one checkout."""
    toks = set()
    pj = _read(os.path.join(root, "package.json"))
    if pj:
        try:
            d = json.loads(pj)
            for k in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                toks.update(str(n).lower() for n in (d.get(k) or {}))
        except (ValueError, AttributeError):
            pass
    gm = _read(os.path.join(root, "go.mod"))
    if gm:
        toks.update(t.lower() for t in re.findall(r"^\s*(?:require\s+)?([\w.\-]+(?:/[\w.\-]+)+)\s+v\S+", gm, re.M))
    pp = _read(os.path.join(root, "pyproject.toml"))
    if pp:
        toks.update(t.lower().replace("_", "-") for t in
                    re.findall(r'["\']([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*(?:[<>=!~\[;,][^"\']*)?["\']', pp))
    return toks


_SRC_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go")
_SKIP_DIRS = {"node_modules", ".git", "dist", "build", "vendor", "venv", ".venv", "__pycache__", ".loki"}
_SCAN_MAX_FILES = 400
_SCAN_MAX_BYTES = 262144
_JS_SPEC = re.compile(r"""(?:from\s*|require\s*\(\s*|import\s*\(?\s*)["']([^"']+)["']""")
_PY_IMPORT = re.compile(r"^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))")
_GO_IMPORT = re.compile(r'^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"\s*$')
_SPEC_KEY = re.compile(r"""["']?(?:inputSpec|input|target)["']?\s*[:=]\s*["']?([^"',\s}]+)""")
_GEN_CONFIG = re.compile(
    r"^(openapitools\.json|openapi-generator.*\.(?:ya?ml|json)|orval\.config\.\w+|\.orvalrc(?:\.\w+)?)$")


def _spec_hits(path, ext):
    """Yield (line number, imported specifier) for one source file."""
    text = _read(path)
    if text is None or len(text) > _SCAN_MAX_BYTES:
        return
    for n, line in enumerate(text.splitlines(), 1):
        if ext == ".py":
            m = _PY_IMPORT.match(line)
            if m:
                yield n, (m.group(1) or m.group(2)).lower().replace("_", "-")
        elif ext == ".go":
            m = _GO_IMPORT.match(line)
            if m:
                yield n, m.group(1).lower()
        else:
            for m in _JS_SPEC.finditer(line):
                yield n, m.group(1).lower()


def _import_evidence(root, ids):
    """First file:line per sibling whose package/module name a source file imports (bounded scan)."""
    found, seen = {}, 0
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS)
        for fn in sorted(files):
            ext = os.path.splitext(fn)[1]
            if ext not in _SRC_EXT:
                continue
            seen += 1
            if seen > _SCAN_MAX_FILES:
                return found
            path = os.path.join(dirpath, fn)
            for n, spec in _spec_hits(path, ext):
                if spec.startswith("."):
                    continue
                for o, oids in ids.items():
                    if o not in found and any(spec == i or spec.startswith(i + "/") or spec.startswith(i + ".")
                                              for i in oids):
                        found[o] = "%s:%d (imports %s)" % (os.path.relpath(path, root), n, spec)
    return found


def _openapi_evidence(root, roots):
    """file:line per sibling whose checkout holds the spec a client generator config points at."""
    found = {}
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return found
    for fn in names:
        path = os.path.join(root, fn)
        if not _GEN_CONFIG.match(fn) or not os.path.isfile(path):
            continue
        text = _read(path) or ""
        for n, line in enumerate(text.splitlines(), 1):
            for m in _SPEC_KEY.finditer(line):
                val = m.group(1)
                if "://" in val:
                    continue
                target = os.path.realpath(os.path.join(root, val))
                for o, oroot in roots.items():
                    if oroot and o not in found and os.path.realpath(oroot) != os.path.realpath(root) and \
                            (target + os.sep).startswith(os.path.realpath(oroot) + os.sep):
                        found[o] = "%s:%d (spec %s)" % (fn, n, val)
    return found


def infer(name, workspaces, say=say):
    """Print suggested `after:` edges from manifests; never writes loki.yaml."""
    ws = workspaces.get(name)
    if ws is None:
        say("workspace: unknown workspace %r (known: %s)" % (name, ", ".join(sorted(workspaces)) or "none"))
        return 2
    entries = [e for e in ws.get("repos") or [] if isinstance(e.get("repo"), str)]
    roots = {}
    for e in entries:
        root = os.path.abspath(os.path.expanduser(e["path"])) if e.get("path") else os.path.join(
            os.path.expanduser("~"), ".loki", "repos", _slug(e["repo"]))
        roots[e["repo"]] = root if os.path.isdir(root) else None
    ids = {e["repo"]: _identities(e, roots[e["repo"]]) if roots[e["repo"]] else set() for e in entries}
    proposed, evidence = {}, {}
    for e in entries:
        repo = e["repo"]
        if not roots[repo]:
            say("workspace: %s: no local checkout, skipped" % repo)
            proposed[repo] = list(e.get("after") or [])
            continue
        toks = _dep_tokens(roots[repo])
        deps = list(e.get("after") or [])
        others = {x["repo"]: ids[x["repo"]] for x in entries if x["repo"] != repo}
        imp = _import_evidence(roots[repo], others)
        api = _openapi_evidence(roots[repo], {o: roots[o] for o in others})
        for o in others:
            if o in deps:
                continue
            if any(t == i or t.startswith(i + "/") for t in toks for i in ids[o]):
                deps.append(o)
                evidence[(repo, o)] = "manifest dependency"
            elif o in api:
                deps.append(o)
                evidence[(repo, o)] = api[o]
            elif o in imp:
                deps.append(o)
                evidence[(repo, o)] = imp[o]
        proposed[repo] = deps
    try:
        order_repos({"repos": [{"repo": e["repo"], "after": proposed[e["repo"]]} for e in entries]})
    except ValueError as err:
        say("workspace: %s: inferred edges are not usable: %s" % (name, err))
        return 1
    say("workspace %s: suggested edges (print-only; copy into loki.yaml)" % name)
    for e in entries:
        say("%s" % e["repo"])
        say("  after: [%s]" % ", ".join(proposed[e["repo"]]))
        for d in proposed[e["repo"]]:
            if (e["repo"], d) in evidence:
                say("    %s: %s" % (d, evidence[(e["repo"], d)]))
    return 0


def main(argv):
    if not enabled():
        say("loki workspace is disabled (LOKI_WORKSPACES=0). Unset it to use workspaces.")
        return 2
    if not argv or argv[0] in ("-h", "--help", "help"):
        say("Usage: loki workspace list | show <name> | infer <name> | run <name> <owner/repo#N | task text> | status [<run-id>]")
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
    if cmd == "infer" and len(argv) == 2:
        return infer(argv[1], workspaces)
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
