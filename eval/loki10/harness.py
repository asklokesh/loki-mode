#!/usr/bin/env python3
"""Loki 10 eval harness: task validator, runner, scorer.

Subcommands (run.sh and summarize are thin wrappers around these):
  validate <task_dir>...
  run --arm <v10|raw-claude|legacy> (--task ID | --tasks A,B | --all) [--parallel N] [--out DIR] [--tasks-dir DIR]
  summarize <results.jsonl> [--markdown]

Honesty rules (the v10.0.0 release gate depends on them):
  - completed = pr_opened and hidden_pass and not capped and the arm really ran.
  - hidden_pass needs exit 0 AND the per-run nonce as the last stdout line (or,
    for a plain pytest/vitest command, a summary with >= 1 passed and no
    failures or errors).
  - cost_usd is only ever a provider-reported figure; missing means null.
  - an arm that is not installed, or a v10 run that leaves no fresh engine
    marker plus events file, is arm_unavailable, never a pass.
  - a task whose checkout already holds engine/metrics state, or whose hidden
    tests pass before the arm, is task_invalid for every arm.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import re
import secrets
import shlex
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
# Positive signal that the v10 engine (not a legacy fallback) ran. Per
# ENGINE.md sections 5 and 10 the engine writes
#   .loki/engine.json = {"engine": "v10", "run_id": "<id>", "events": ".loki/runs/<id>/events.jsonl"}
# and the event log .loki/runs/<id>/events.jsonl during the run (mtime at or
# after the arm start).
V10_MARKER = os.path.join(".loki", "engine.json")
# Engine state that must not exist before the arm: its presence would let a
# committed or setup-created file stand in for this run's own output.
PRE_ARM_FORBIDDEN = (V10_MARKER, os.path.join(".loki", "metrics"))
EFFICIENCY_DIR = os.path.join(".loki", "metrics", "efficiency")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
PUSH_INSTRUCTION = ("\n\nImplement this in the current repository. Create a new git "
                    "branch, commit your changes on it, and push that branch to origin.")
SCRUB_ENV = ("GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
             # Model auth never reaches prepare/setup/grade; only the arm gets it (arm_auth).
             "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR")
# Operator auth env vars, in precedence order, passed through to the arm as-is.
AUTH_ENV = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")
KEYCHAIN_SERVICE = "Claude Code-credentials"
SECURITY_BIN = "/usr/bin/security"  # absolute: never a PATH lookup
AUTH_MARGIN_S = 120


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
                elif os.path.islink(os.path.join(task_dir, "hidden", rel)) \
                        or not os.path.isfile(os.path.join(task_dir, "hidden", rel)):
                    errs.append("hidden file missing or a symlink: hidden/%s" % rel)
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


def kill_orphans(timeout_pid):
    """KILL what is left in the process group of a `timeout` we started.

    GNU timeout (without --foreground) makes itself a process-group leader,
    so its pgid equals its pid and every child it spawned stays in that group
    unless it deliberately escaped (setsid). Once timeout has exited, anything
    still in the group is an orphan of this run. Our own group is never hit.
    """
    if timeout_pid == os.getpgrp():
        return
    try:
        os.killpg(timeout_pid, signal.SIGKILL)
    except OSError:
        pass  # ESRCH: no group left, the normal case


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
            kill_orphans(p.pid)
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
    # Config isolation (EV-3): an empty per-run Claude config dir, so the
    # operator's global CLAUDE.md, settings, hooks, plugins, MCP servers and
    # memory never steer any arm. Auth comes from arm_auth, not from this dir.
    cc = os.path.join(rundir, "claude-config")
    os.makedirs(cc, mode=0o700, exist_ok=True)
    env.update({
        "CLAUDE_CONFIG_DIR": cc,
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


def apply_git_isolation(env):
    """Git run by or for the arm reads no system or user config.

    Kept apart from arm_env so per-arm config isolation (EV-3) can change
    arm_env without touching this. Commit identity is set repo-local in
    prepare_checkout, so arms can still commit.
    """
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    return env
class AuthError(Exception):
    """Messages never contain a credential value."""


def arm_auth(min_valid_s):
    """({VAR: secret}, source) for the arm under an empty CLAUDE_CONFIG_DIR.

    The empty config dir hides the operator's login (on macOS the keychain
    entry is keyed to the default config dir), so auth is handed over as env:
    an operator ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN if set, else on
    macOS the short-lived OAuth ACCESS token from the operator's keychain
    login. The refresh token is never passed, so an arm cannot rotate the
    operator's login. Raises AuthError (token-free message) otherwise.
    """
    for var in AUTH_ENV:
        if os.environ.get(var):
            return {var: os.environ[var]}, "env:" + var
    if sys.platform != "darwin" or not os.access(SECURITY_BIN, os.X_OK):
        raise AuthError("no model auth: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN "
                        "(claude setup-token)")
    try:
        r = subprocess.run([SECURITY_BIN, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True, timeout=20)
        oauth = (json.loads(r.stdout).get("claudeAiOauth") or {}) if r.returncode == 0 else {}
        token, exp_ms = oauth.get("accessToken"), oauth.get("expiresAt")
    except Exception:  # noqa: BLE001 - never surface the keychain payload
        token = exp_ms = None
    if not isinstance(token, str) or not token:
        raise AuthError("no model auth: keychain entry %r unreadable; set ANTHROPIC_API_KEY or "
                        "CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)" % KEYCHAIN_SERVICE)
    # Fail closed: an expiry that is missing or not a number is unusable.
    if isinstance(exp_ms, bool) or not isinstance(exp_ms, (int, float)) \
            or exp_ms / 1000.0 < time.time() + min_valid_s:
        raise AuthError("keychain OAuth access token has no usable expiry or expires in under %ds; "
                        "run any claude command to refresh it, or set CLAUDE_CODE_OAUTH_TOKEN" % min_valid_s)
    return {"CLAUDE_CODE_OAUTH_TOKEN": token}, "keychain:claudeAiOauth.accessToken"


def prepare_checkout(task, rundir, env, log):
    """Fresh clone at repo.ref with only that history; origin -> local bare repo.

    repo.source is cloned once into a private bare copy, the checkout is
    cloned from that copy, and the copy is deleted before returning, so the
    arm's checkout, reflog and config never name repo.source and no full
    upstream history sits beside it.
    """
    work = os.path.join(rundir, "work")
    remote = os.path.join(rundir, "remote.git")
    seed = os.path.join(rundir, "seed.git")
    src, ref = task["repo"]["source"], task["repo"]["ref"]
    steps = [
        (["clone", "--bare", "--no-local", "--no-tags", "-q", src, seed], rundir),
        (["clone", "--no-local", "--no-tags", "-q", seed, work], rundir),
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
    shutil.rmtree(seed)
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
    # Loki arms: read the per-iteration efficiency records directly. Every
    # record must carry cost_source "provider" and a positive cost_usd; one
    # estimate (for example a context-tracker price-table fallback) or one
    # unpriced record makes the whole figure unknown. cost-summary.py cannot
    # make this call: it sums whatever cost_usd a record holds.
    d = os.path.join(work, EFFICIENCY_DIR)
    try:
        names = sorted(n for n in os.listdir(d) if re.fullmatch(r"iter(ation)?-\d+\.json", n))
    except OSError:
        return None, "not reported"
    total = 0.0
    for n in names:
        try:
            with open(os.path.join(d, n), encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, ValueError):
            return None, "not reported (unreadable record %s)" % n
        v = rec.get("cost_usd") if isinstance(rec, dict) else None
        if not isinstance(rec, dict) or rec.get("cost_source") != "provider" or isinstance(v, bool) \
                or not isinstance(v, (int, float)) or v <= 0:
            return None, "not reported (%s lacks a provider-sourced cost)" % n
        total += float(v)
    if not names:
        return None, "not reported"
    return round(total, 6), "loki efficiency records (cost_source=provider)"


# ---------------------------------------------------------------- one run

def runner_kind(cmd):
    """'pytest' or 'vitest' for a plain runner command, else None.

    Plain = one simple command: no shell operators outside quotes, no
    expansion. Accepted heads: pytest, <any path>/python[N[.N]] -m pytest,
    vitest, npx|bunx|yarn vitest, pnpm [exec] vitest. Quoted arguments such
    as -k "(a or b)" are fine.
    """
    if "`" in cmd or "$" in cmd or "\n" in cmd:
        return None
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:
        return None
    if not toks or any(t and set(t) <= set(";&|()<>") for t in toks):
        return None
    head = os.path.basename(toks[0])
    if head == "pytest" or (re.fullmatch(r"python(\d+(\.\d+)?)?", head) and toks[1:3] == ["-m", "pytest"]):
        return "pytest"
    if head == "vitest" or (head in ("npx", "bunx", "yarn") and toks[1:2] == ["vitest"]) \
            or (head == "pnpm" and (toks[1:2] == ["vitest"] or toks[1:3] == ["exec", "vitest"])):
        return "vitest"
    return None


def _counts(line):
    c = {}
    for n, w in re.findall(r"(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected|todo)", line):
        w = "error" if w.startswith("error") else w
        c[w] = c.get(w, 0) + int(n)
    return c


def runner_summary_ok(kind, text):
    """True only if the runner's own summary shows >= 1 passed, 0 failed, 0 errors.

    A conftest that skips everything reports "N skipped" and fails this.
    """
    lines = text.splitlines()
    if kind == "pytest":
        summ = [ln for ln in lines if re.search(r"\bin [\d.]+s\b", ln)
                and re.search(r"\b(passed|failed|errors?|skipped|no tests ran)\b", ln)]
        if not summ:
            return False
        c = _counts(summ[-1])
        return c.get("passed", 0) >= 1 and not c.get("failed") and not c.get("error")
    summ = [ln for ln in lines if re.match(r"^\s*Tests\s+\d", ln)]
    if not summ:
        return False
    c = _counts(summ[-1])
    errors = any(re.match(r"^\s*Errors?\s+\d", ln) for ln in lines)
    return c.get("passed", 0) >= 1 and not c.get("failed") and not errors


def hidden_path_problem(grade_dir, rel):
    """Why a hidden file cannot be placed safely in the PR tree, or None."""
    cur = grade_dir
    for part in rel.split("/")[:-1]:
        cur = os.path.join(cur, part)
        if os.path.islink(cur) or (os.path.lexists(cur) and not os.path.isdir(cur)):
            return "PR tree has a symlink or non-directory at %s" % os.path.relpath(cur, grade_dir)
    dst = os.path.join(grade_dir, rel)
    if os.path.islink(dst) or os.path.isdir(dst):
        return "PR tree has a symlink or directory at hidden path %s" % rel
    return None


def run_hidden(task, task_dir, grade_dir, env, log_prefix, cap):
    """Copy hidden files in and run hidden.run. Returns (passed, refused_reason)."""
    for rel in task["hidden"]["files"]:
        why = hidden_path_problem(grade_dir, rel)
        if why:
            with open(log_prefix + ".log", "a") as f:
                f.write("[harness] refused: %s\n" % why)
            return False, why
    for rel in task["hidden"]["files"]:
        dst = os.path.join(grade_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        # Unlink first: in the no-PR diagnostic path dst is in the arm's own
        # tree, where it may be a hardlink to a file outside the checkout.
        if os.path.lexists(dst):
            os.unlink(dst)
        shutil.copy2(os.path.join(task_dir, "hidden", rel), dst, follow_symlinks=False)
    # The nonce is minted after the arm has finished, so no arm can know it.
    nonce = secrets.token_hex(16)
    cmd = task["hidden"]["run"]
    out_path = log_prefix + ".stdout.log"
    open(out_path, "w").close()
    rc = capped_run(["bash", "-c", cmd], grade_dir, dict(env, LOKI_EVAL_NONCE=nonce), cap,
                    log_prefix + ".log", out_path)[0]
    with open(out_path, encoding="utf-8", errors="replace") as f:
        text = ANSI_RE.sub("", f.read())
    kind = runner_kind(cmd)
    if kind:
        passed = rc == 0 and runner_summary_ok(kind, text)
    else:
        last = [ln.strip() for ln in text.splitlines() if ln.strip()]
        passed = rc == 0 and bool(last) and last[-1] == nonce
    with open(log_prefix + ".log", "a") as f:
        f.write("[harness] rc=%d runner=%s verdict=%s%s\n" % (
            rc, kind or "custom", "pass" if passed else "fail", (" nonce=" + nonce) if passed else ""))
    return passed, None


def v10_marker_problem(work, started):
    """None when the v10 engine provably ran in this run, else the reason."""
    try:
        with open(os.path.join(work, V10_MARKER), encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError):
        return "no readable v10 engine marker at %s" % V10_MARKER
    if not isinstance(m, dict) or m.get("engine") != "v10":
        return "marker does not name engine v10"
    rid = m.get("run_id")
    if not isinstance(rid, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", rid) or rid in (".", ".."):
        return "marker has no valid run_id"
    rel = ".loki/runs/%s/events.jsonl" % rid
    # The events field is honored only when it is exactly the contract path;
    # anything else (another file, a path outside .loki) is refused.
    if "events" in m and m["events"] != rel:
        return "marker events field %r is not %s" % (m.get("events"), rel)
    ev = os.path.join(work, *rel.split("/"))
    if os.path.islink(ev):
        return "events file %s is a symlink" % rel
    try:
        mtime = os.stat(ev).st_mtime
    except OSError:
        return "no events file %s" % rel
    if mtime < int(started):
        return "events file %s predates the run start" % rel
    return None


def new_row(task, arm, cfg, slot, logs):
    return {"run_id": slot, "task": task["id"], "arm": arm, "status": "ok", "model": cfg["model"],
            "repo_ref": task["repo"]["ref"], "harness_sha": cfg["harness_sha"],
            "started": None, "ended": None, "wall_s": None, "time_to_pr_s": None,
            "pr_opened": False, "pr_branch": None, "hidden_pass": False, "completed": False,
            "cost_usd": None, "cost_source": "not reported", "exit_code": None,
            "capped": False, "logs": logs}


def run_one(task, task_dir, arm, cfg, row, rundir, logdir):
    """Fill `row` in place, so a crash part-way keeps what was already known."""
    tid = task["id"]
    cap = task.get("timeout_s", DEFAULT_TIMEOUT_S)
    L = row["logs"]
    env = apply_git_isolation(arm_env(rundir, cfg["model"], cfg["alias"]))

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
    pre = [p for p in PRE_ARM_FORBIDDEN if os.path.lexists(os.path.join(work, p))]
    if pre:
        # Delete nothing: the task itself is broken for scoring.
        row["status"] = "task_invalid"
        row["invalid_reason"] = "checkout holds %s before the arm" % ", ".join(pre)
        return row
    # The hidden tests must FAIL at repo.ref, or passing them proves nothing.
    base_dir = os.path.join(rundir, "baseline")
    if git(["clone", "-q", "--no-tags", "-b", BASE_BRANCH, remote, base_dir], rundir, env, L["prepare"]) != 0 \
            or (task.get("setup") and sh(task["setup"], base_dir, env, L["setup"], cap) != 0):
        row["status"] = "prepare_failed"
        return row
    base_pass, base_refused = run_hidden(task, task_dir, base_dir, env, os.path.join(logdir, "baseline"), cap)
    shutil.rmtree(base_dir)  # hidden files must be gone before the arm starts
    if base_pass or base_refused:
        row["status"] = "task_invalid"
        row["invalid_reason"] = "hidden tests already pass at repo.ref" if base_pass \
            else "hidden files cannot be placed at repo.ref: " + base_refused
        return row

    prompt = task["prompt"]
    if arm == "raw-claude":
        argv = [binary, "-p", prompt + PUSH_INSTRUCTION, "--output-format", "json",
                "--dangerously-skip-permissions", "--model", cfg["model"]]
    elif arm == "v10":
        env["LOKI_ENGINE"] = "v10"
        argv = [binary, prompt]
    else:
        # Pinned so the v10 default flip (E-31) cannot change what EV-5 measures.
        env["LOKI_ENGINE"] = "legacy"
        pfile = os.path.join(rundir, "prompt.md")
        with open(pfile, "w", encoding="utf-8") as f:
            f.write(prompt + PUSH_INSTRUCTION + "\n")
        argv = [binary, "start", pfile]

    # Resolved per run: a keychain access token must outlive this run's cap.
    try:
        auth, row["auth_source"] = arm_auth(cap + AUTH_MARGIN_S)
    except AuthError as e:
        row.update(status="auth_unavailable", unavailable_reason=str(e))
        return row
    started = time.time()
    rc, wall, capped = capped_run(argv, work, dict(env, **auth), cap, L["arm_stderr"], L["arm_stdout"])
    row.update(started=iso(started), ended=iso(time.time()), wall_s=wall, exit_code=rc, capped=capped)
    row["cost_usd"], row["cost_source"] = provider_cost(arm, L["arm_stdout"], work)

    if arm == "v10":
        why = v10_marker_problem(work, started)
        if why:
            row["status"] = "arm_unavailable"
            row["unavailable_reason"] = why
            return row

    base_sha = git_out(["rev-parse", BASE_BRANCH], remote)
    pr = find_pr(remote, base_sha)
    grade_dir = work
    if pr:
        branch, head, pushed_at = pr
        row.update(pr_opened=True, pr_branch=branch)
        if pushed_at < int(started):
            # Impossible for an honest push: a forged log or a clock problem.
            row["push_time_anomaly"] = True
        else:
            row["time_to_pr_s"] = pushed_at - int(started)
        L["pr_record"] = os.path.join(logdir, "pr.json")
        with open(L["pr_record"], "w") as f:
            json.dump({"task": tid, "arm": arm, "branch": branch, "head_sha": head,
                       "base_sha": base_sha, "pushed_at": iso(pushed_at)}, f, indent=2)
        # Grade exactly what the PR contains, in a fresh clone.
        grade_dir = os.path.join(rundir, "grade")
        if git(["clone", "-q", "--no-tags", "-b", branch, remote, grade_dir], rundir, env, L["grade"]) != 0 \
                or (task.get("setup") and sh(task["setup"], grade_dir, env, L["grade"], cap) != 0):
            return row
    row["hidden_pass"], row["grade_refused"] = run_hidden(
        task, task_dir, grade_dir, env, os.path.join(logdir, "grade_hidden"), cap)
    row["completed"] = row["pr_opened"] and row["hidden_pass"] and not capped \
        and not row.get("push_time_anomaly")
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
    if args.all:
        ids = sorted(d for d in os.listdir(tasks_dir) if os.path.isfile(os.path.join(tasks_dir, d, "task.json")))
    elif args.tasks:
        ids = sorted({t.strip() for t in args.tasks.split(",") if t.strip()})
    else:
        ids = [args.task]
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
    try:  # fail fast before any clone when there is no model auth at all
        _, auth_source = arm_auth(0)
    except AuthError as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    CHILDREN = Children(os.path.join(tmp, "child-pids"))
    harness_sha = git_out(["rev-parse", "HEAD"], HERE) or "unknown"
    if git_out(["status", "--porcelain"], REPO):
        harness_sha += "-dirty"  # results from uncommitted code are not reproducible
    cfg = {"tmp": tmp, "out": out, "model": model, "alias": alias,
           "harness_sha": harness_sha,
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
                            "isolation": "fresh CLAUDE_CONFIG_DIR per run", "auth_source": auth_source,
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
        task, task_dir = item
        slot = "%s.%s.%s" % (task["id"], args.arm, secrets.token_hex(6))
        rundir = os.path.join(cfg["tmp"], slot)
        logdir = os.path.join(cfg["out"], "logs", slot)
        os.makedirs(rundir)
        os.makedirs(logdir)
        logs = {k: os.path.join(logdir, k + ".log") for k in ("prepare", "setup", "arm_stdout", "arm_stderr", "grade")}
        row = new_row(task, args.arm, cfg, slot, logs)
        try:
            run_one(task, task_dir, args.arm, cfg, row, rundir, logdir)
        except Exception as e:
            # A harness crash is never a pass, but what the arm already did
            # (pr_opened) is kept so the run still counts as a miss.
            row.update(status="harness_error", error=repr(e), completed=False, hidden_pass=False)
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


def is_evaluated(r):
    """The arm ran, so the row counts toward its rate.

    A harness_error after the arm started still counts (as not completed):
    the arm did work, and dropping the row would flatter it.
    """
    return r.get("status") == "ok" or (
        r.get("status") == "harness_error" and bool(r.get("pr_opened") or r.get("started")))


def dedupe(rows):
    """Newest row per run_id, then newest row per (model, harness_sha, task, arm)."""
    def stamp(i, r):
        return (r.get("ended") or r.get("started") or "", i)
    by_run = {}
    for i, r in enumerate(rows):
        key = r.get("run_id") or ("line", i)
        if key not in by_run or stamp(i, r) >= by_run[key][0]:
            by_run[key] = (stamp(i, r), r)
    latest = {}
    for st, r in by_run.values():
        k = (r.get("model"), r.get("harness_sha"), r.get("task"), r.get("arm"))
        if k not in latest or st >= latest[k][0]:
            latest[k] = (st, r)
    return [r for _, r in sorted(latest.values(), key=lambda x: x[0])]


def arm_stats(rs):
    unavailable = [r for r in rs if r.get("status") == "arm_unavailable"]
    evaluated = [r for r in rs if is_evaluated(r)]
    infra = [r for r in rs if not is_evaluated(r) and r.get("status") != "arm_unavailable"]
    done = [r for r in evaluated if r.get("completed")]
    ttp = [r["time_to_pr_s"] for r in done if r.get("time_to_pr_s") is not None]
    costed = [r for r in evaluated if r.get("cost_usd") is not None]
    cost_per = None
    if done and len(costed) == len(evaluated):
        cost_per = round(sum(r["cost_usd"] for r in costed) / len(done), 4)
    return {
        "runs": len(rs), "evaluated": len(evaluated), "completed": len(done),
        "completion_rate": round(len(done) / len(evaluated), 4) if evaluated else None,
        "p50_time_to_pr_s": nearest_rank(ttp, 50), "p90_time_to_pr_s": nearest_rank(ttp, 90),
        "cost_per_completed_usd": cost_per, "cost_measured_runs": len(costed),
        "capped": sum(1 for r in rs if r.get("capped")), "unavailable": len(unavailable),
        "infra_or_interrupted": len(infra),
    }


def summarize_rows(rows):
    """One group per (model, harness_sha). A task that is task_invalid in a
    group is excluded from every arm in that group and listed instead."""
    groups = {}
    for r in dedupe(rows):
        groups.setdefault((r.get("model") or "unknown", r.get("harness_sha") or "unknown"), []).append(r)
    out = []
    for (model, sha), rs in sorted(groups.items()):
        invalid = {}
        for r in rs:
            if r.get("status") == "task_invalid":
                invalid.setdefault(r["task"], r.get("invalid_reason") or "task_invalid")
        live = [r for r in rs if r["task"] not in invalid]
        out.append({
            "model": model, "harness_sha": sha,
            "invalid_tasks": [{"task": t, "reason": invalid[t]} for t in sorted(invalid)],
            "arms": {a: arm_stats([r for r in live if r["arm"] == a]) for a in sorted({r["arm"] for r in rs})},
            "misses": [{"task": r["task"], "arm": r["arm"], "reason": miss_reason(r)}
                       for r in live if not r.get("completed")],
        })
    return out


def miss_reason(r):
    if r.get("status") != "ok":
        detail = r.get("unavailable_reason") or r.get("error")
        return r.get("status") + (": " + detail if detail else "") + \
            (" (after a push)" if r.get("pr_opened") else "")
    if r.get("capped"):
        return "capped at wall limit"
    if not r.get("pr_opened"):
        return "no branch pushed"
    if r.get("push_time_anomaly"):
        return "push time earlier than the run start (flagged)"
    if r.get("grade_refused"):
        return "hidden tests refused: " + r["grade_refused"]
    return "hidden tests failed"


def fmt(v, suffix=""):
    return "n/a" if v is None else "%s%s" % (v, suffix)


def cmd_summarize(args):
    with open(args.results, encoding="utf-8") as f:
        rows = [json.loads(ln) for ln in f if ln.strip()]
    groups = summarize_rows(rows)
    if args.json:
        print(json.dumps(groups, indent=2))
        return 0
    if not args.markdown:
        for g in groups:
            print("model %s, harness %s" % (g["model"], g["harness_sha"]))
            for arm, a in g["arms"].items():
                print("  %s: completion %s (%d/%d evaluated), p50 ttPR %s, p90 ttPR %s, cost/completed %s "
                      "(cost measured %d/%d), capped %d, unavailable %d, infra/interrupted %d" % (
                          arm, fmt(a["completion_rate"]), a["completed"], a["evaluated"],
                          fmt(a["p50_time_to_pr_s"], "s"), fmt(a["p90_time_to_pr_s"], "s"),
                          fmt(a["cost_per_completed_usd"]), a["cost_measured_runs"], a["evaluated"],
                          a["capped"], a["unavailable"], a["infra_or_interrupted"]))
            for t in g["invalid_tasks"]:
                print("  invalid task %s: %s" % (t["task"], t["reason"]))
        return 0
    print("### Loki 10 eval results\n")
    print("Completion = branch pushed to the local remote AND hidden tests pass (nonce or runner "
          "summary verified) AND not capped. One row per task and arm (newest). Rate denominator "
          "counts runs where the arm ran; unavailable, infrastructure and interrupted runs are "
          "counted separately, and invalid tasks are excluded from every arm. Time to PR "
          "percentiles are nearest-rank over completed runs. Cost is provider-reported only; n/a "
          "when any evaluated run lacks a figure.\n")
    for g in groups:
        print("#### model %s, harness %s\n" % (g["model"], g["harness_sha"]))
        print("| Arm | Completed | Rate | p50 time to PR | p90 time to PR | Cost per completed | Cost measured "
              "| Capped | Unavailable | Infra/interrupted |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for arm, a in g["arms"].items():
            rate = "n/a" if a["completion_rate"] is None else "%.1f%%" % (100 * a["completion_rate"])
            cost = "n/a" if a["cost_per_completed_usd"] is None else "$%.4f" % a["cost_per_completed_usd"]
            print("| %s | %d/%d | %s | %s | %s | %s | %d/%d | %d | %d | %d |" % (
                arm, a["completed"], a["evaluated"], rate, fmt(a["p50_time_to_pr_s"], "s"),
                fmt(a["p90_time_to_pr_s"], "s"), cost, a["cost_measured_runs"], a["evaluated"],
                a["capped"], a["unavailable"], a["infra_or_interrupted"]))
        if g["invalid_tasks"]:
            print("\nInvalid tasks (excluded from every arm):\n")
            for t in g["invalid_tasks"]:
                print("- %s: %s" % (t["task"], t["reason"]))
        print("\nMisses (%d):\n" % len(g["misses"]))
        for m in g["misses"]:
            print("- %s / %s: %s" % (m["task"], m["arm"], m["reason"]))
        print("")
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
    g.add_argument("--tasks", help="comma-separated task ids (e.g. a 5-task measurement)")
    g.add_argument("--all", action="store_true")
    r.add_argument("--parallel", type=int, default=3)
    r.add_argument("--out", default=os.path.join(HERE, "results"))
    # LOKI_EVAL_TASKS_DIR keeps the tasks path out of argv (visible in ps to
    # the arm); arm_env drops LOKI_* so the arm never inherits it.
    r.add_argument("--tasks-dir", default=os.environ.get("LOKI_EVAL_TASKS_DIR") or os.path.join(HERE, "tasks"))
    s = sub.add_parser("summarize")
    s.add_argument("results")
    s.add_argument("--markdown", action="store_true")
    s.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    return {"validate": cmd_validate, "run": cmd_run, "summarize": cmd_summarize}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
