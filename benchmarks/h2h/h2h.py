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
import hashlib
import io
import json
import math
import os
import platform
import random
import pwd
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TASKS_DIR = HERE / "tasks"
# --suite replay: real closed issues from permissively licensed projects, replayed at the fix's parent commit
# (replay/<id>/meta.json "source" records the upstream, license, issue, fix PR and both commits).
# --suite hard: the same format, chosen for multi-file fixes in larger projects. It lives under fixtures/
# because two issue texts keep characters (emoji, en and em dashes) this repository's text rule bans.
# Both keep only meta.json and task.txt; materialize() rebuilds the snapshot from the pinned commits.
SUITES = {"tasks": TASKS_DIR, "replay": HERE / "replay", "hard": HERE / "fixtures" / "hard"}
CONFIGS = ["raw-haiku", "raw-sonnet", "raw-opus", "raw-haiku-verify", "raw-sonnet-verify", "raw-opus-verify",
           "loki-haiku", "loki-sonnet", "loki-opus", "loki-default", "loki-haiku-flag"]
# Low-effort Opus arms: every session runs at effort low (raw: `claude --effort low`; Loki: LOKI_E10_EFFORT=low, the
# user effort that wins over the per-stage and fix-round policy, contrib/effort_policy.ts resolveEffort), so a Loki
# multiple can be cited against what a user gets from raw Opus at low effort. Named with --configs only: they are not
# in the default list, so a default run's cost does not change.
LOW_EFFORT_CONFIGS = ["raw-opus-low", "loki-opus-low"]
LOW_EFFORT = "low"
# loki-haiku-flag is `loki start --haiku` as a user types it (no env pin): the cheap-model opt-in route.
# Loki pinned to one model for the whole run (every stage, escalation and Wall re-author); loki-default has
# no pin, so Loki's own routing picks the model per stage.
LOKI_PINS = {"loki-haiku": "haiku", "loki-sonnet": "sonnet", "loki-opus": "opus", "loki-opus-low": "opus"}
# The -verify configs are raw Claude Code with the same task text plus this one sentence: what a careful user
# types when driving Claude Code alone.
VERIFY_SENTENCE = "Before you finish, run the repository's tests and check that your change works."
# Offline configs for checking the task set itself: oracle applies tasks/<id>/solution, noop changes nothing.
CHECK_CONFIGS = ["oracle", "noop"]
# Learning protocol (--sequences): Loki on Haiku with what it learns from earlier runs in the same repo.
# learn: run lessons and the worked example both on; lessons: run lessons only; example: the worked example
# only; nolearn: both off. Each arm sets every knob explicitly, so an engine default never decides an arm.
# loki-<model>-<knob> pins that model; loki-auto-learn pins none and sets LOKI_ROUTER=auto (outcome-routed executor from
# router_history.json) with both learn knobs. The raw arms have no Loki memory: they are the same-model floor to compare against.
SEQUENCE_CONFIGS = ["loki-haiku-learn", "loki-haiku-lessons", "loki-haiku-example", "loki-haiku-nolearn",
                    "loki-sonnet-learn", "loki-sonnet-nolearn", "loki-auto-learn"]
SEQUENCE_RAW_CONFIGS = ["raw-haiku", "raw-sonnet"]
BOOTSTRAP_SEED = 20261104
BOOTSTRAP_RESAMPLES = 2000
# util/pr_lessons.ts RECURRING: the run-lesson classes a brief line can prevent on the same file.
RECURRING = ("check-failed", "edited-existing-test", "spec-conflict")
SEQUENCES_DIR = Path(os.environ.get("H2H_SEQUENCES_DIR") or HERE / "sequences")  # test hook, like H2H_CACHE
SCORE_TIMEOUT_S = 180
NOISE = (".loki/", "node_modules/", "__pycache__/", ".pytest_cache/", ".bun/", "target/")


RESULTS_PREFIX = "benchmarks/h2h/results/"


def _version(cmd):
    """First output line of a version command, run in an empty directory so it can read nothing of the repo."""
    try:
        with tempfile.TemporaryDirectory() as empty:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, cwd=empty, stdin=subprocess.DEVNULL)
        return (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr).strip() else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def provenance(root=ROOT):
    """What produced a results file: the exact engine commit, whether the tree had uncommitted changes
    (anything other than results files), and the tool versions. A run from a dirty tree is not citable:
    its numbers belong to code nobody can check out. Gitignored files under benchmarks/ count as dirt too
    (Python bytecode aside): a benchmark input the commit does not hold cannot be checked out either."""
    r = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True)
    st = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True)
    ig = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--ignored", "--untracked-files=all", "--", "benchmarks"],
                        capture_output=True, text=True)
    dirty = [line[3:] for line in st.stdout.splitlines() if line[3:] and not line[3:].startswith(RESULTS_PREFIX)]
    ignored = [line[3:] for line in ig.stdout.splitlines() if line.startswith("!! ")
               and "__pycache__/" not in line and not line.endswith(".pyc")]
    dirty += [f"{p} (gitignored)" for p in ignored]
    return {
        "engine_sha": r.stdout.strip() or None, "dirty_count": len(dirty), "dirty": dirty[:30],
        "citable": bool(r.stdout.strip()) and st.returncode == 0 and ig.returncode == 0 and not dirty,
        "bun": _version(["bun", "--version"]), "claude_cli": _version(["bash", "-c", "command claude --version"]),
        "python": platform.python_version(), "go": _version(["go", "version"]), "platform": platform.platform(),
    }


def provenance_gate(configs, prov, allow_dirty):
    """Loki configs never run from a dirty tree unless --allow-dirty is given, and then the results are
    stamped not citable. Returns an error message, or None when the run may go ahead."""
    if any(c.startswith("loki") for c in configs) and not prov["citable"] and not allow_dirty:
        return (f"refusing to run Loki configs from a tree that is not at a clean commit ({prov['dirty_count']} uncommitted "
                f"paths, e.g. {', '.join(prov['dirty'][:3]) or 'no git'}); commit first, or pass --allow-dirty to record "
                "results marked not citable")
    return None


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def load_task(task_id, tasks_dir=TASKS_DIR):
    d = tasks_dir / task_id
    meta = json.loads((d / "meta.json").read_text())
    meta["id"] = task_id
    meta["dir"] = materialize(task_id, meta) if "snapshot_sha256" in meta else d
    meta["text"] = (d / "task.txt").read_text().strip()
    return meta


# Replay and hard tasks keep only meta.json and task.txt in this repository. The snapshot (repo/, hidden/,
# solution/) is rebuilt on first use from the upstream at the pinned commits and cached outside the repository.
def cache_root():
    return Path(os.environ.get("H2H_CACHE") or Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "loki-h2h")


def snapshot_digest(root):
    """sha256 over every file under repo/, hidden/ and solution/: path, executable bit and content."""
    h = hashlib.sha256()
    files = sorted((p.relative_to(root).as_posix(), p) for sub in ("repo", "hidden", "solution") if (root / sub).is_dir()
                   for p in (root / sub).rglob("*") if p.is_file() or p.is_symlink())
    for rel, p in files:
        body = ("link:" + os.readlink(p)).encode() if p.is_symlink() else p.read_bytes()
        h.update(f"{rel}\0{os.access(p, os.X_OK) and not p.is_symlink():d}\0{hashlib.sha256(body).hexdigest()}\n".encode())
    return h.hexdigest()


def upstream_commit(url, sha):
    """A bare cache repository for url holding commit sha (a shallow fetch of exactly that commit)."""
    gd = cache_root() / "git" / (re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("://", 1)[-1]).strip("_") + ".git")
    if not (gd / "HEAD").is_file():
        gd.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=".init.", dir=gd.parent))
        git(tmp, "init", "-q", "--bare")
        try:
            tmp.rename(gd)
        except OSError:  # another invocation created it first
            shutil.rmtree(tmp, ignore_errors=True)
    has = lambda: subprocess.run(["git", "-C", str(gd), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True).returncode == 0
    if not has():
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        r = subprocess.run(["git", "-C", str(gd), "fetch", "-q", "--depth=1", "--no-tags", url, sha], capture_output=True, text=True, env=env)
        if r.returncode != 0 or not has():
            raise RuntimeError(f"h2h: cannot fetch {sha} from {url}: {r.stderr.strip()}")
    return gd


def git_archive(gd, sha, paths, dest):
    dest.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["git", "-C", str(gd), "archive", "--format=tar", sha, *paths], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"h2h: git archive {sha} failed: {r.stderr.decode(errors='replace').strip()}")
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tf:
        tf.extractall(dest, filter="data")


def inside(root, rel):
    """root/rel, refused unless it stays inside root: no absolute path, no "..", no symlink on the way."""
    parts = Path(rel).parts
    if not parts or Path(rel).is_absolute() or ".." in parts:
        raise RuntimeError(f"h2h: path {rel!r} leaves the snapshot")
    p = root
    for part in parts:
        p = p / part
        if p.is_symlink():
            raise RuntimeError(f"h2h: path {rel!r} goes through a symlink")
    if not p.resolve().is_relative_to(root.resolve()):
        raise RuntimeError(f"h2h: path {rel!r} leaves the snapshot")
    return p


def materialize(task_id, meta):
    """Builds the task snapshot exactly as it was benchmarked: `git archive` of the vendored paths at the parent
    commit (plus pinned submodules), the fix's test files as hidden/, its other changed files as solution/, then
    meta's add_files and patch_files. The result must match meta's snapshot_sha256, or the task is refused."""
    s, want = meta["source"], meta["snapshot_sha256"]
    dest = cache_root() / "tasks" / f"{task_id}-{want[:16]}"
    if (dest / ".complete").is_file():
        got = snapshot_digest(dest)  # a cached snapshot is re-checked on every load: anything may have edited it
        if got != want:
            raise RuntimeError(f"h2h: {task_id}: cached snapshot {dest} has digest {got}, not snapshot_sha256 {want}; delete it to rebuild")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{task_id}.", dir=dest.parent))
    try:
        gd = upstream_commit(s["upstream"], s["parent_commit"])
        git_archive(gd, s["parent_commit"], s["vendored_paths"], tmp / "repo")
        for path, sm in (s.get("submodules") or {}).items():
            git_archive(upstream_commit(sm["upstream"], sm["commit"]), sm["commit"], sm["vendored_paths"], tmp / "repo" / path)
        upstream_commit(s["upstream"], s["fix_commit"])
        for sub, files in (("hidden", list(meta["hidden"])), ("solution", s["solution_files"])):
            for f in files:
                out = inside(tmp, f"{sub}/{f}")
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(subprocess.run(["git", "-C", str(gd), "show", f"{s['fix_commit']}:{f}"], capture_output=True, check=True).stdout)
        for rel, content in (s.get("add_files") or {}).items():
            inside(tmp, f"repo/{rel}").write_text(content)
        # patch_files: {"repo/<path>": [[old, new, count], ...]}; each old must occur exactly count times.
        for rel, pairs in (s.get("patch_files") or {}).items():
            t = inside(tmp, rel).read_text()
            for old, new, count in pairs:
                if t.count(old) != count:
                    raise RuntimeError(f"h2h: {task_id}: patch target in {rel} occurs {t.count(old)} times, expected {count}")
                t = t.replace(old, new)
            (tmp / rel).write_text(t)
        got = snapshot_digest(tmp)
        if got != want:
            raise RuntimeError(f"h2h: {task_id}: snapshot digest {got} does not match meta.json snapshot_sha256 {want}")
        (tmp / ".complete").write_text(got + "\n")
        try:
            tmp.rename(dest)
        except OSError:  # another invocation finished it first
            if not (dest / ".complete").is_file():
                raise
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
    return dest


def toolchain_env(env, shared):
    """Go and Rust must still resolve under the throwaway HOME: rustup's cargo proxy reads
    $RUSTUP_HOME (default ~/.rustup), so both homes point at the real user's when they exist.
    Go never downloads a toolchain and shares one build cache per benchmark invocation, so
    compiling the standard library is not billed to every contestant's wall time."""
    real = Path(pwd.getpwuid(os.getuid()).pw_dir)
    for var, sub in (("RUSTUP_HOME", ".rustup"), ("CARGO_HOME", ".cargo")):
        if not env.get(var) and (real / sub).is_dir():
            env[var] = str(real / sub)
    env["GOTOOLCHAIN"] = "local"
    if shared is not None:
        env["GOCACHE"] = str(shared / "gocache")
        env["GOPATH"] = str(shared / "gopath")
    return env


def contestant_env(home, shared=None):
    """The same scrubbed environment for every contestant: no parent Claude Code session
    variables, no inherited LOKI_* knobs, a throwaway HOME, no telemetry or update checks."""
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith("CLAUDE") or k.startswith("LOKI_") or k in ("AI_AGENT", "CLAUDECODE"))}
    toolchain_env(env, shared)
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
    if config.startswith("raw-") and config in CONFIGS + LOW_EFFORT_CONFIGS:
        model = config.split("-")[1]
        if config.endswith("-verify"):
            text = f"{text}\n\n{VERIFY_SENTENCE}"
        # `command claude` skips any shell function named claude in an interactive profile.
        return ["bash", "-c", 'command claude "$@"', "claude", "-p", text, "--model", model,
                "--output-format", "json", "--dangerously-skip-permissions"] + (
                    ["--effort", LOW_EFFORT] if config in LOW_EFFORT_CONFIGS else [])
    if config in LOKI_PINS or config == "loki-default" or config in SEQUENCE_CONFIGS:
        return ["bash", str(ROOT / "bin" / "loki"), text, "--no-pr"]
    if config == "loki-haiku-flag":
        return ["bash", str(ROOT / "bin" / "loki"), text, "--no-pr", "--haiku"]
    raise ValueError(f"unknown config {config}")


def config_env(config, env):
    if config in LOKI_PINS:
        # LOKI_SESSION_MODEL is the whole-run pin (loki-ts/src/engine10/session.ts resolveModel and
        # childEnv; runner/providers.ts sessionPinModel): every stage tier runs haiku, escalation stays
        # on the pinned model (runner/model_rank.ts escalationModel) and the Wall re-author is capped to
        # it (stages/wall.ts capToRunTier). LOKI_MODEL_OVERRIDE is not used: it is a pin key for the Wall
        # re-author, so that call would climb back to sonnet (engine10/sizing.ts wallModel).
        env["LOKI_SESSION_MODEL"] = LOKI_PINS[config]
    if config in SEQUENCE_CONFIGS and config != "loki-auto-learn":
        env["LOKI_SESSION_MODEL"] = config.split("-")[1]
    # util/pr_lessons.ts lessonsInjected (LOKI_PR_LESSONS, "0" off) and workedExampleInjected (LOKI_WORKED_EXAMPLE, "1" on).
    # The arm's knobs come from its name suffix, whatever the model.
    if config in SEQUENCE_CONFIGS:
        suffix = config.rsplit("-", 1)[1]
        if suffix == "learn":
            env["LOKI_PR_LESSONS"] = "1"
            env["LOKI_WORKED_EXAMPLE"] = "1"
        elif suffix == "lessons":
            env["LOKI_PR_LESSONS"] = "1"
            env["LOKI_WORKED_EXAMPLE"] = "0"
        elif suffix == "example":
            env["LOKI_PR_LESSONS"] = "0"
            env["LOKI_WORKED_EXAMPLE"] = "1"
        elif suffix == "nolearn":
            # LOKI_NO_PR_LESSONS=1 turns both off whatever else is set.
            env["LOKI_NO_PR_LESSONS"] = "1"
    if config == "loki-auto-learn":
        env["LOKI_ROUTER"] = "auto"  # runner/router/flag.ts routerActive: history-routed executor (repoHistoryFloor)
    if config.startswith("loki-"):
        env.update(loki_env_overrides())  # validated at startup; Loki contestants only (raw configs never see them)
    if config == "loki-auto-learn" and env.get("LOKI_ROUTER") != "auto":
        raise SystemExit(f"h2h: {config} runs with LOKI_ROUTER=auto; H2H_LOKI_ENV may not set LOKI_ROUTER={env['LOKI_ROUTER']}")
    if config in LOW_EFFORT_CONFIGS and config.startswith("loki-"):
        if env.get("LOKI_E10_EFFORT", LOW_EFFORT) != LOW_EFFORT:
            raise SystemExit(f"h2h: {config} runs at effort {LOW_EFFORT}; H2H_LOKI_ENV may not set LOKI_E10_EFFORT={env['LOKI_E10_EFFORT']}")
        env["LOKI_E10_EFFORT"] = LOW_EFFORT
    return env


# Keys an A/B knob may not set: the model pin and model routing (a config's own model), and the learning arms' knobs.
LOKI_ENV_REFUSED = ("LOKI_SESSION_MODEL", "LOKI_MODEL_OVERRIDE", "LOKI_PROVIDER", "LOKI_PR_LESSONS", "LOKI_WORKED_EXAMPLE", "LOKI_NO_PR_LESSONS")
LOKI_ENV_REFUSED_PREFIX = ("LOKI_MODEL_", "LOKI_CLAUDE_MODEL", "LOKI_CODEX_MODEL", "LOKI_OPENCODE_MODEL")


def loki_env_overrides():
    """H2H_LOKI_ENV="LOKI_X=1,LOKI_Y=0": extra variables for Loki contestants, for on/off comparisons. Returns {} when unset;
    exits on a malformed entry or a refused key, so a knob can never silently change a config's model or learning arm."""
    out = {}
    for kv in filter(None, (x.strip() for x in os.environ.get("H2H_LOKI_ENV", "").split(","))):
        k, eq, v = kv.partition("=")
        if not eq or not k.startswith("LOKI_"):
            raise SystemExit(f"h2h: H2H_LOKI_ENV entry {kv!r} is not LOKI_NAME=value")
        if k in LOKI_ENV_REFUSED or k.startswith(LOKI_ENV_REFUSED_PREFIX):
            raise SystemExit(f"h2h: H2H_LOKI_ENV may not set {k} (it overrides a config's model pin or learning arm)")
        out[k] = v
    return out


def kill_group(pgid):
    """Stops the process group the runner itself created for one contestant. macOS answers
    EPERM, not ESRCH, for a group whose remaining members are only zombies awaiting their
    reaper; nothing in such a group can run, so it counts as gone."""
    for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 2)):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        deadline = time.time() + wait
        while time.time() < deadline:
            try:
                os.killpg(pgid, 0)
            except (ProcessLookupError, PermissionError):
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


def hidden_leaks(task, repo, base):
    """Hidden test files visible in the contestant's copy before scoring. A hidden file may be scored at
    a new path or over a visible test file of the same name (replay tasks score the fix's own test file
    at its own path). A file counts as leaked when it holds a hidden file's exact content under that
    file's name, or when it is not in the base commit and carries the name of a hidden file that is
    scored at a new path."""
    base_files = set(git(repo, "ls-tree", "-r", "--name-only", base).splitlines())
    content, new_names = {}, set()
    for src, dest in task["hidden"].items():
        content.setdefault(Path(dest).name, set()).add((task["dir"] / "hidden" / src).read_bytes())
        if dest not in base_files:
            new_names.add(Path(dest).name)
    leaked = []
    for p in repo.rglob("*"):
        if p.name not in content or ".git" in p.relative_to(repo).parts or not p.is_file():
            continue
        rel = str(p.relative_to(repo))
        if (rel not in base_files and p.name in new_names) or p.read_bytes() in content[p.name]:
            leaked.append(rel)
    return sorted(leaked)


TEST_NAME_SUFFIXES = ("_test.py", "_test.go", ".test.ts", ".test.js", ".spec.ts", ".spec.js")
TEST_DIRS = ("test", "tests", "__tests__")


def test_edits(task, files):
    """Changed files that are tests or test config: under a protected path, in a test directory, or named
    like a test. Informational; acceptance uses test_weakening()."""
    out = []
    for f in files:
        parts = f.split("/")
        name = parts[-1]
        if (any(f == p.rstrip("/") or f.startswith(p.rstrip("/") + "/") for p in task.get("protected", []))
                or any(d in TEST_DIRS for d in parts[:-1]) or name == "conftest.py"
                or (name.startswith("test_") and name.endswith(".py")) or name.endswith(TEST_NAME_SUFFIXES)):
            out.append(f)
    return out


# An added line that switches a test off (pytest, unittest, Go, bun/jest/vitest, Rust).
SKIP_MARKERS = re.compile(r"pytest\.mark\.(skip|skipif|xfail)\b|pytest\.(skip|xfail)\(|unittest\.(skip|skipIf|skipUnless|expectedFailure)\b"
                          r"|@skip\b|\bt\.Skip(f|Now)?\(|\b(test|it|describe)\.(skip|todo|only)\b|\bx(it|describe|test)\(|#\[ignore\]")
TEST_CONFIG_NAMES = ("conftest.py", "pytest.ini", "setup.cfg", "tox.ini", "pyproject.toml", "bunfig.toml", "go.mod",
                     "jest.config.js", "jest.config.ts", "vitest.config.ts", "Cargo.toml")


def _subsequence(small, big):
    it = iter(big)
    return all(any(x == y for y in it) for x in small)


def test_weakening(repo, base, edits):
    """The test edits a user would have to undo: a pre-existing test file deleted, or with any of its lines
    removed or changed (anything other than inserting new lines), or with an added line that skips a test;
    and any change to test or build config (a new conftest.py or bunfig.toml can switch tests off). New test
    files and new test cases appended to an existing file are normal and do not count."""
    base_files = set(git(repo, "ls-tree", "-r", "--name-only", base).splitlines())
    out = []
    for f in edits:
        name = f.rsplit("/", 1)[-1]
        if name in TEST_CONFIG_NAMES:
            out.append(f)
            continue
        if f not in base_files:
            continue
        p = repo / f
        if not p.is_file():
            out.append(f)
            continue
        old = [l.strip() for l in git(repo, "show", f"{base}:{f}").splitlines() if l.strip()]
        new = [l.strip() for l in p.read_text(errors="replace").splitlines() if l.strip()]
        added = list(new)
        for l in old:
            if l in added:
                added.remove(l)
        if not _subsequence(old, new) or any(SKIP_MARKERS.search(l) for l in added):
            out.append(f)
    return out


def changed_files(repo, base):
    names = set(git(repo, "diff", "--name-only", base).split())
    names |= set(git(repo, "ls-files", "--others", "--exclude-standard").split())
    return sorted(n for n in names if not any(n.startswith(p) or f"/{p}" in n for p in NOISE))


def loki_branches(repo):
    out = git(repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/loki/")
    return dict(line.split() for line in out.splitlines() if line.strip())


def loki_branch_checkout(repo, base, before=None):
    """If the run left its work on a loki/<id> branch and the checkout itself still sits at
    base, score the branch: that is what the user gets from the run. `before` (branch -> sha
    from before the run) skips branches an earlier run in the same repo left behind."""
    head = git(repo, "rev-parse", "HEAD").strip()
    if head != base or git(repo, "status", "--porcelain", "--untracked-files=no").strip():
        return None
    for br, sha in loki_branches(repo).items():
        if (before or {}).get(br) == sha:
            continue
        if sha != base:
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
        return {"cost_usd": None, "sessions": 0, "fix_rounds": 0, "run_id": None, "stages": {}, "verdict": None, "models": []}
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
    session_models = []  # [stage, model] for every model session, in order
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
            session_models.append([st, str(data.get("model") or "unknown")])
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
        # One fix.round event per fix session the engine ran (engine10/stages/fix.ts).
        "fix_rounds": sum(1 for e in events if e.get("type") == "fix.round"),
        "not_proven": [str(x)[:200] for x in (cdata.get("not_proven") or [])][:5],
        "spec_conflict_reason": next((str((e.get("data") or {}).get("spec_conflict_reason"))[:300] for e in reversed(events)
                                      if e.get("type") == "stage.completed" and (e.get("data") or {}).get("spec_conflict_reason")), None),
        "wall_s": cdata.get("wall_s"),
        "stages": {k: v for k, v in stages.items() if v["sessions"] or v["seconds"]},
        "models": sorted(models),
        "session_models": session_models,
        "event_types": sorted({e.get("type") for e in events if e.get("type")}),
    }


# bin/loki exit codes (loki-ts/src/engine10/output.ts EXIT). Only 0 is Loki's own claim that the
# task is done and proven; 6 (PARTIAL) is reported separately because it is neither a claim nor a refusal.
LOKI_EXIT = {0: "VERIFIED", 6: "PARTIAL", 1: "FAILED", 3: "BUDGET_STOP", 4: "BLOCKED", 5: "STALLED", 130: "CANCELLED", 143: "CANCELLED"}


def tail_text(path, n):
    try:
        return Path(path).read_text(errors="replace")[-n:]
    except OSError:
        return ""


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
    env = config_env(config, contestant_env(make_home(d / "home"), work))
    rec = {"config": config, "task": task["id"], "kind": task["kind"], "lang": task["lang"],
           "difficulty": task.get("difficulty", "normal"), "shape": task.get("shape"), "rep": rep}
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
    leaked = hidden_leaks(task, repo, base)
    branch = loki_branch_checkout(repo, base) if config.startswith("loki") else None
    files = changed_files(repo, base)
    edits = test_edits(task, files)
    weakened = test_weakening(repo, base, edits)
    # Kept so acceptance can be audited or recomputed after the work dir is gone (untracked files are not in it).
    test_diff = git(repo, "diff", base, "--", *edits)[-6000:] if edits else ""
    if config.startswith("raw"):
        m = raw_metrics(d / "contestant.out")
    elif config.startswith("loki"):
        m = loki_metrics(repo)
        m["loki_outcome"] = LOKI_EXIT.get(rc, "OTHER")
        m["loki_tail"] = tail_text(d / "contestant.out", 800)
    else:
        m = {"cost_usd": 0.0, "sessions": 0}
    restore_protected(task, repo, base)
    passed, tail = score(task, repo, env, d / "hidden.log")
    rec.update({
        "pass": passed, "seconds": round(secs, 2), "exit_code": rc, "timed_out": timed_out,
        # Accepted without edit: the hidden tests pass on the tree as left, and it weakens no existing test.
        "test_edits": edits, "test_weakened": weakened, "accepted": int(bool(passed) and not weakened),
        "test_diff": test_diff,
        "files_changed": len(files), "files": files, "hidden_leaked_before_scoring": leaked,
        "scored_branch": branch, "hidden_tail": tail if not passed else "", **m,
    })
    if not keep_dir:
        shutil.rmtree(d, ignore_errors=True)
    else:
        rec["workdir"] = str(d)
    return rec


def load_sequence(seq_id):
    d = SEQUENCES_DIR / seq_id
    meta = json.loads((d / "meta.json").read_text())
    steps = []
    for st in meta["steps"]:
        sd = d / "steps" / st["id"]
        steps.append({**st, "dir": sd, "text": (sd / "task.txt").read_text().strip(), "lang": meta["lang"],
                      "protected": meta.get("protected", []), "kind": "sequence", "task_id": f"{seq_id}/{st['id']}"})
    return {"id": seq_id, "dir": d, "lang": meta["lang"], "steps": steps}


def lesson_counts(repo):
    """What Loki could learn from before a step: the repo's lessons file (util/pr_lessons.ts lessonsPath)."""
    p = repo / ".loki" / "memory" / "semantic" / "pr-lessons.json"
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return {"run": 0, "receipt": 0, "worked_example": 0}
    items = data if isinstance(data, list) else data.get("lessons", []) if isinstance(data, dict) else []
    return {
        "run": sum(1 for x in items if isinstance(x, dict) and x.get("kind") == "run"),
        "receipt": sum(1 for x in items if isinstance(x, dict) and x.get("kind") == "receipt"),
        "worked_example": sum(1 for x in items if isinstance(x, dict) and x.get("kind") == "receipt" and x.get("example")
                              and (x.get("justified_by") or {}).get("verdict") == "VERIFIED"),
    }


def run_lessons(repo):
    p = repo / ".loki" / "memory" / "semantic" / "pr-lessons.json"
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return []
    items = data.get("lessons", []) if isinstance(data, dict) else data if isinstance(data, list) else []
    return [x for x in items if isinstance(x, dict) and x.get("kind") == "run"]


def step_learning(repo, before_ids, run_id):
    """What one step taught and what it was told. `mistakes`: the recurring-class lessons this run added a
    sub-lesson to (its own mistakes, recorded in every arm); `repeats`: those whose class an earlier step in
    this repo had already made; `injected_*`: the run's lessons-injected.json (util/pr_lessons.ts lessonsForBrief)."""
    mine = [l for l in run_lessons(repo) if l.get("category") in RECURRING
            and any((s or {}).get("run_id") == run_id for s in l.get("subs") or [])] if run_id else []
    inj = {}
    if run_id:
        try:
            inj = json.loads((repo / ".loki" / "runs" / run_id / "lessons-injected.json").read_text())
        except (OSError, ValueError):
            inj = {}
    return {"mistakes": sorted(l["id"] for l in mine), "repeats": sorted(l["id"] for l in mine if l["id"] in before_ids),
            "injected_ids": inj.get("ids", []), "injected_bytes": inj.get("bytes", 0), "injected_run_bytes": inj.get("run_bytes", 0),
            "worked_example": inj.get("worked")}


def commit_step_state(repo, step):
    """Commit the scored tree so the next step starts clean. Loki's own .loki state stays out of
    the commit but stays on disk. A pathspec exclude is not used: once Loki has gitignored .loki,
    git refuses any pathspec that names an ignored path."""
    git(repo, "add", "-A", "--", ".")
    git(repo, "reset", "-q", "--", ".loki", check=False)
    if git(repo, "diff", "--cached", "--name-only").strip():
        git(repo, "commit", "-q", "-m", f"h2h: state after step {step}")


def reset_lap(repo, base0):
    """Back to the sequence's base commit for the next lap: main at base0, no step work left in the tree.
    Loki's .loki memory (lessons, worked examples) is never removed: that is what a lap measures."""
    git(repo, "checkout", "-q", "-f", "main")
    git(repo, "reset", "-q", "--hard", base0)
    git(repo, "clean", "-fdq", "-e", ".loki")


def run_sequence(config, seq, rep, work, timeout_s, keep_dir, laps=1):
    """Every step of one sequence, in order, in ONE repo copy with ONE throwaway HOME, so whatever
    Loki records about a run is there for the next. Each step is scored by its own hidden tests,
    which are removed again before the next step starts; the step's result (contestant work as
    scored) is committed so the next step starts from a clean tree. With laps > 1 the repo is reset
    to its base between laps (reset_lap) and the steps run again; Loki's .loki memory is kept."""
    d = Path(tempfile.mkdtemp(prefix=f"{config}.{seq['id']}.{rep}.", dir=work))
    repo = d / "repo"
    prepare_repo({"dir": seq["dir"]}, repo)
    home = make_home(d / "home")
    base0 = git(repo, "rev-parse", "HEAD").strip()
    recs = []
    nsteps = len(seq["steps"])
    for lap, i in ((lap, i) for lap in range(1, laps + 1) for i in range(1, nsteps + 1)):
        st = seq["steps"][i - 1]
        if i == 1 and lap > 1:
            reset_lap(repo, base0)
        env = config_env(config, contestant_env(home, work))
        base = git(repo, "rev-parse", "HEAD").strip()
        rec = {"config": config, "sequence": seq["id"], "step": i, "task": st["task_id"], "lang": seq["lang"], "rep": rep,
               "lap": lap, "run_index": (lap - 1) * nsteps + i,
               "lessons_before": lesson_counts(repo),
               # Any step's hidden test file already in the repo when this step starts (must stay empty).
               "stale_hidden": sorted(dest for other in seq["steps"] for dest in other["hidden"].values() if (repo / dest).exists())}
        if i == 1:
            rec["lap_start_clean"] = git(repo, "rev-parse", "HEAD^{tree}").strip() == git(repo, "rev-parse", f"{base0}^{{tree}}").strip()
        before = loki_branches(repo)
        before_ids = {l["id"] for l in run_lessons(repo) if l.get("category") in RECURRING and (l.get("seen") or 0) > 0}
        if config == "oracle":
            apply_oracle(st, repo)
            rc, secs, timed_out = 0, 0.0, False
        elif config == "noop":
            rc, secs, timed_out = 0, 0.0, False
        else:
            rc, secs, timed_out = run_contestant(contestant_cmd(config, st), repo, env, timeout_s,
                                                 d / f"step{i}.out", d / f"step{i}.err")
        leaked = hidden_leaks(st, repo, base)
        branch = loki_branch_checkout(repo, base, before) if config.startswith("loki") else None
        files = changed_files(repo, base)
        if config.startswith("loki"):
            m = loki_metrics(repo)
            m["loki_outcome"] = LOKI_EXIT.get(rc, "OTHER")
            m["loki_tail"] = tail_text(d / f"step{i}.out", 800)
            m.update(step_learning(repo, before_ids, m.get("run_id")))
        elif config.startswith("raw"):
            m = raw_metrics(d / f"step{i}.out")
        else:
            m = {"cost_usd": 0.0, "sessions": 0}
        restore_protected(st, repo, base)
        passed, tail = score(st, repo, env, d / f"step{i}.hidden.log")
        for dest in st["hidden"].values():
            (repo / dest).unlink(missing_ok=True)
        commit_step_state(repo, i)
        rec.update({"pass": passed, "seconds": round(secs, 2), "exit_code": rc, "timed_out": timed_out,
                    "files_changed": len(files), "files": files, "hidden_leaked_before_scoring": leaked,
                    "scored_branch": branch, "hidden_tail": tail if not passed else "", **m})
        recs.append(rec)
    if not keep_dir:
        shutil.rmtree(d, ignore_errors=True)
    return recs


def summarize_sequences(results, configs):
    """Per config: step 1 (nothing to learn from yet) and the later steps separately."""
    rows = []
    for c in configs:
        for label, pick in (("first", lambda r: r["step"] == 1), ("later", lambda r: r["step"] > 1)):
            rs = [r for r in results if r["config"] == c and pick(r)]
            if not rs:
                continue
            passed = sum(r["pass"] for r in rs)
            costs = [r["cost_usd"] for r in rs if isinstance(r.get("cost_usd"), (int, float))]
            rows.append({
                "config": c, "steps": label, "n": len(rs), "passed": passed, "pass_ci95": wilson(passed, len(rs)),
                "total_cost_usd": round(sum(costs), 4), "cost_per_pass_usd": round(sum(costs) / passed, 4) if passed else None,
                "median_s": round(statistics.median(r["seconds"] for r in rs), 1),
                "mean_sessions": round(statistics.mean(r.get("sessions") or 0 for r in rs), 2),
                "mean_fix_rounds": round(statistics.mean(r.get("fix_rounds") or 0 for r in rs), 2),
                "steps_with_worked_example_available": sum(1 for r in rs if r["lessons_before"]["worked_example"]),
                "steps_with_run_lessons_available": sum(1 for r in rs if r["lessons_before"]["run"]),
                "steps_with_lessons_injected": sum(1 for r in rs if r.get("injected_run_bytes")),
                "steps_with_worked_example_injected": sum(1 for r in rs if r.get("worked_example")),
                "mean_injected_bytes": round(statistics.mean(r.get("injected_bytes") or 0 for r in rs), 1),
                "steps_with_a_mistake": sum(1 for r in rs if r.get("mistakes")),
                "steps_repeating_a_mistake": sum(1 for r in rs if r.get("repeats")),
                "repeat_ci95": wilson(sum(1 for r in rs if r.get("repeats")), len(rs)),
                **({k: v for k, v in verdict_stats(rs).items() if k in ("verdict_agree_n", "false_verified")} if c.startswith("loki") else {}),
            })
    return rows


def first_pass(r):
    """Right on the first attempt. Loki: hidden tests pass with zero fix rounds. Raw Claude Code has no repair
    loop (one `claude -p` call), so for a raw arm first-pass is the pass itself."""
    return bool(r["pass"]) and (not r["config"].startswith("loki") or not (r.get("fix_rounds") or 0))


def _cost(r):
    return r["cost_usd"] if isinstance(r.get("cost_usd"), (int, float)) else None


def summarize_curve(results, configs):
    """Per config and run index (lap-major step count, 1..laps*steps): n, passes, first-pass count, mean measured
    cost. `first_vs_last` compares run index 1 with the last run index of each config (Wilson CIs, $ per pass).
    Records without a run_index (harness errors) are left out."""
    rows, fvl = [], []
    for c in configs:
        rs = [r for r in results if r["config"] == c and r.get("run_index")]
        by = {}
        for r in rs:
            by.setdefault(r["run_index"], []).append(r)
        for idx in sorted(by):
            g = by[idx]
            costs = [x for x in map(_cost, g) if x is not None]
            rows.append({"config": c, "run_index": idx, "n": len(g), "passed": sum(bool(r["pass"]) for r in g),
                         "first_pass": sum(first_pass(r) for r in g),
                         "mean_cost_usd": round(sum(costs) / len(costs), 4) if costs else None,
                         "cost_unmeasured": len(g) - len(costs)})
        if by:
            ends = {}
            for label, idx in (("first", min(by)), ("last", max(by))):
                g = by[idx]
                n, k = len(g), sum(bool(r["pass"]) for r in g)
                costs = [x for x in map(_cost, g) if x is not None]
                ends[label] = {"run_index": idx, "n": n, "passed": k, "pass_ci95": wilson(k, n),
                               "cost_per_pass_usd": round(sum(costs) / k, 4) if k and costs else None}
            fvl.append({"config": c, **ends})
    return {"by_run_index": rows, "first_vs_last": fvl}


def _boot_ci(vals):
    vals = sorted(v for v in vals if v is not None)
    if len(vals) < 20:
        return None
    n = len(vals)
    return [round(vals[int(0.025 * n)], 4), round(vals[int(0.975 * n) - 1], 4)]


def paired(results, a, b):
    """Config a against config b on the same (sequence, rep, run_index). delta_pass and delta_first_pass are
    mean differences (a minus b); cost_ratio is sum(a cost) / sum(b cost) over pairs where both costs were
    measured. Each carries a 95% percentile bootstrap CI (seeded, so a second call gives the same interval)."""
    def idx(c):
        return {(r["sequence"], r["rep"], r["run_index"]): r for r in results if r["config"] == c and r.get("run_index")}
    ia, ib = idx(a), idx(b)
    pairs = [(ia[k], ib[k]) for k in sorted(ia) if k in ib]
    n = len(pairs)
    out = {"a": a, "b": b, "n_pairs": n, "bootstrap": {"seed": BOOTSTRAP_SEED, "resamples": BOOTSTRAP_RESAMPLES}}
    if not n:
        return {**out, "delta_pass": None, "delta_first_pass": None, "cost_ratio": None}
    dp = [int(bool(x["pass"])) - int(bool(y["pass"])) for x, y in pairs]
    df = [int(first_pass(x)) - int(first_pass(y)) for x, y in pairs]
    cp = [(_cost(x), _cost(y)) for x, y in pairs if _cost(x) is not None and _cost(y) is not None]

    def ratio(sub):
        den = sum(y for _, y in sub)
        return sum(x for x, _ in sub) / den if den else None

    rng = random.Random(BOOTSTRAP_SEED)
    bp, bf, bc = [], [], []
    for _ in range(BOOTSTRAP_RESAMPLES):
        pick = [rng.randrange(n) for _ in range(n)]
        bp.append(sum(dp[i] for i in pick) / n)
        bf.append(sum(df[i] for i in pick) / n)
        bc.append(ratio([cp[rng.randrange(len(cp))] for _ in range(len(cp))]) if cp else None)
    r0 = ratio(cp) if cp else None
    return {**out, "delta_pass": {"point": round(sum(dp) / n, 4), "ci95": _boot_ci(bp)},
            "delta_first_pass": {"point": round(sum(df) / n, 4), "ci95": _boot_ci(bf)},
            "cost_ratio": {"point": round(r0, 4) if r0 is not None else None, "ci95": _boot_ci(bc), "n_cost_pairs": len(cp)}}


# (loki arm prefix, raw baseline). loki-auto-learn has no model pin, so its baseline is labelled mixed-model.
PAIR_BASELINES = (("loki-haiku-", "raw-haiku"), ("loki-sonnet-", "raw-sonnet"), ("loki-auto-learn", "raw-sonnet"))


def paired_all(results, configs):
    out = []
    for c in configs:
        for prefix, raw in PAIR_BASELINES:
            if c.startswith(prefix) and c in SEQUENCE_CONFIGS and raw in configs:
                p = paired(results, c, raw)
                if c == "loki-auto-learn":
                    p["note"] = "mixed-model: the router picks the executor, raw-sonnet is pinned"
                out.append(p)
    return out


def _ci_txt(d, pct_=False):
    if not d or d["point"] is None:
        return "-"
    f = (lambda v: f"{v * 100:+.0f}%") if pct_ else (lambda v: f"{v:.2f}")
    ci = d["ci95"]
    return f"{f(d['point'])} ({f(ci[0])} to {f(ci[1])})" if ci else f"{f(d['point'])} (CI n/a)"


def main_sequences(a, ap):
    configs = [c for c in a.configs.split(",") if c]
    for c in configs:
        if c not in SEQUENCE_CONFIGS + SEQUENCE_RAW_CONFIGS + CHECK_CONFIGS:
            ap.error(f"--sequences takes configs from {SEQUENCE_CONFIGS + SEQUENCE_RAW_CONFIGS + CHECK_CONFIGS}")
        if c in SEQUENCE_CONFIGS:
            config_env(c, {})  # refuse a contradicting H2H_LOKI_ENV before any run starts
    all_seqs = sorted(p.name for p in SEQUENCES_DIR.iterdir() if (p / "meta.json").is_file()) if SEQUENCES_DIR.is_dir() else []
    ids = all_seqs if a.sequences == "all" else [x for x in a.sequences.split(",") if x]
    for x in ids:
        if x not in all_seqs:
            ap.error(f"unknown sequence {x}")
    seqs = [load_sequence(x) for x in ids]
    prov = provenance()
    blocked = provenance_gate(configs, prov, a.allow_dirty)
    if blocked:
        log(f"h2h: {blocked}")
        return 6
    if not prov["citable"]:
        log(f"h2h: DIRTY TREE ({prov['dirty_count']} uncommitted paths): these results are NOT CITABLE")
    provs = [prov] + (json.loads(Path(a.resume).read_text()).get("provenance", []) if a.resume else [])
    sha = (prov["engine_sha"] or "nogit")[:9]
    out = Path(a.out) if a.out else HERE / "results" / f"{dt.date.today().isoformat()}-{sha}-learning.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp_root = Path(os.environ.get("TMPDIR") or "/tmp").resolve()
    work = Path(tempfile.mkdtemp(prefix="loki-h2h.", dir=tmp_root))
    results = json.loads(Path(a.resume).read_text())["runs"] if a.resume else []
    done = {(r["config"], r["sequence"], r["rep"]) for r in results}
    queue = [(rep, sq, c) for rep in range(1, a.reps + 1) for sq in seqs for c in configs if (c, sq["id"], rep) not in done]
    lock = threading.Lock()
    state = {"stopped": None}

    def save():
        doc = {"benchmark": "h2h-learning", "loki_sha": sha, "date": dt.datetime.now().isoformat(timespec="seconds"),
               "citable": all(p["citable"] for p in provs), "provenance": provs,
               "configs": configs, "reps": a.reps, "laps": a.laps, "jobs": a.jobs, "timeout_s": a.timeout, "stopped": state["stopped"],
               "loki_env": loki_env_overrides(), "sequences": [sq["id"] for sq in seqs], "summary": summarize_sequences(results, configs),
               "curve": summarize_curve(results, configs), "paired": paired_all(results, configs), "runs": results}
        out.write_text(json.dumps(doc, indent=2) + "\n")

    def worker():
        while True:
            with lock:
                if state["stopped"] or not queue:
                    return
                spent = ledger_total(a.ledger)
                if a.budget is not None and spent >= a.budget:
                    state["stopped"] = f"budget {a.budget} reached (ledger {spent:.4f})"
                    return
                rep, sq, c = queue.pop(0)
                log(f"h2h: {c} sequence {sq['id']} rep {rep} (ledger ${spent:.4f}, {len(queue)} queued)")
            try:
                recs = run_sequence(c, sq, rep, work, a.timeout, a.keep, laps=a.laps)
            except Exception as exc:
                recs = [{"config": c, "sequence": sq["id"], "step": 0, "task": sq["id"], "rep": rep, "pass": 0, "seconds": 0.0,
                         "exit_code": None, "timed_out": False, "files_changed": 0, "files": [], "cost_usd": None,
                         "hidden_leaked_before_scoring": [], "lessons_before": {"run": 0, "receipt": 0, "worked_example": 0},
                         "harness_error": repr(exc)[:300], "harness_traceback": traceback.format_exc()[-1500:]}]
            with lock:
                results.extend(recs)
                if a.ledger and c not in CHECK_CONFIGS:
                    with open(a.ledger, "a") as fh:
                        for r in recs:
                            fh.write(json.dumps({"config": c, "task": r["task"], "rep": rep, "cost_usd": r.get("cost_usd"),
                                                 "at": dt.datetime.now().isoformat()}) + "\n")
                for r in recs:
                    log(f"h2h:   {c} {r['task']} rep {rep}: pass={r['pass']} exit={r['exit_code']} {r['seconds']}s "
                        f"cost={r.get('cost_usd')} lessons_before={r['lessons_before']}")
                save()

    try:
        if any(c not in CHECK_CONFIGS for c in configs) and queue:
            ok, detail = auth_ok(work)
            if not ok:
                log(f"h2h: claude auth does not resolve under the throwaway HOME; refusing to run\n{detail}")
                return 3
        threads = [threading.Thread(target=worker) for _ in range(min(a.jobs, max(1, len(queue))))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        if work.name.startswith("loki-h2h.") and work.parent == tmp_root and not a.keep:
            shutil.rmtree(work, ignore_errors=True)
    results.sort(key=lambda r: (configs.index(r["config"]) if r["config"] in configs else 99, r["sequence"], r["rep"], r.get("run_index") or r["step"]))
    save()
    print("| config | steps | pass | 95% CI | $ / pass | median s | sessions | fix rounds | lessons injected | example injected | mean bytes | repeat mistakes |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in summarize_sequences(results, configs):
        ci = r["pass_ci95"]
        cpp = f"{r['cost_per_pass_usd']:.4f}" if r["cost_per_pass_usd"] is not None else "-"
        print(f"| {r['config']} | {r['steps']} | {r['passed']}/{r['n']} | {ci[0] * 100:.0f}-{ci[1] * 100:.0f}% | {cpp} | {r['median_s']} "
              f"| {r['mean_sessions']} | {r['mean_fix_rounds']} | {r['steps_with_lessons_injected']}/{r['n']} "
              f"| {r['steps_with_worked_example_injected']}/{r['n']} | {r['mean_injected_bytes']} | {r['steps_repeating_a_mistake']}/{r['n']} |")
    curve = summarize_curve(results, configs)
    print("\n| config | run | n | pass | first-pass | mean $ |")
    print("|---|---|---|---|---|---|")
    for r in curve["by_run_index"]:
        mean = f"{r['mean_cost_usd']:.4f}" if r["mean_cost_usd"] is not None else "-"
        print(f"| {r['config']} | {r['run_index']} | {r['n']} | {r['passed']}/{r['n']} | {r['first_pass']}/{r['n']} | {mean}"
              f"{' (' + str(r['cost_unmeasured']) + ' unmeasured)' if r['cost_unmeasured'] else ''} |")
    pairs = paired_all(results, configs)
    if pairs:
        print("\n| loki | raw | pairs | d pass (95% CI) | d first-pass (95% CI) | cost ratio (95% CI) |")
        print("|---|---|---|---|---|---|")
        for p in pairs:
            print(f"| {p['a']} | {p['b']}{' (mixed-model)' if p.get('note') else ''} | {p['n_pairs']} | {_ci_txt(p['delta_pass'], True)} "
                  f"| {_ci_txt(p['delta_first_pass'], True)} | {_ci_txt(p['cost_ratio'])} |")
    print(f"\nresults: {out}")
    if any(r["hidden_leaked_before_scoring"] or r.get("stale_hidden") for r in results):
        log("h2h: hidden test files were visible to a contestant before scoring")
        return 4
    return 5 if any(r.get("harness_error") for r in results) else 0


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[k]


def wilson(k, n, z=1.959964):
    """95% Wilson score interval for k passes out of n runs."""
    if n == 0:
        return None
    p = k / n
    den = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(max(0.0, mid - half), 4), round(min(1.0, mid + half), 4)]


def verdict_stats(rs):
    """Loki's own verdict against the hidden tests. Agreement counts exit 0 with a hidden pass and
    any other exit with a hidden fail; PARTIAL (exit 6) is a disagreement when the hidden tests pass
    and is also split out. false_verified (exit 0, hidden fail) is the worst error, counted on its own."""
    n = len(rs)
    partial = [r for r in rs if r["exit_code"] == 6]
    agree = sum(1 for r in rs if (r["exit_code"] == 0) == bool(r["pass"]))
    return {
        "verdict_agreement": round(agree / n, 4) if n else None, "verdict_agree_n": agree,
        "false_verified": sum(1 for r in rs if r["exit_code"] == 0 and not r["pass"]),
        "missed_pass": sum(1 for r in rs if r["exit_code"] != 0 and r["pass"]),
        # VERIFIED recall: of the runs whose work passed the hidden tests, the share Loki sealed VERIFIED. Read
        # next to false_verified, so a config cannot look safe by never claiming VERIFIED.
        "verified_recall": (round(sum(1 for r in rs if r["exit_code"] == 0 and r["pass"]) / sum(1 for r in rs if r["pass"]), 4)
                            if any(r["pass"] for r in rs) else None),
        "partial_pass": sum(1 for r in partial if r["pass"]), "partial_fail": sum(1 for r in partial if not r["pass"]),
        "outcomes": {o: sum(1 for r in rs if (r.get("loki_outcome") or "OTHER") == o)
                     for o in sorted({r.get("loki_outcome") or "OTHER" for r in rs})},
    }


def summarize(results, configs):
    rows = []
    for c in configs:
        rs = [r for r in results if r["config"] == c]
        if not rs:
            continue
        secs = [r["seconds"] for r in rs]
        costs = [r["cost_usd"] for r in rs if isinstance(r.get("cost_usd"), (int, float))]
        passed = sum(r["pass"] for r in rs)
        row = {
            "config": c, "n": len(rs), "passed": passed,
            "pass_rate": round(passed / len(rs), 4), "pass_ci95": wilson(passed, len(rs)),
            "median_s": round(statistics.median(secs), 1), "p90_s": round(pct(secs, 0.9), 1),
            "total_cost_usd": round(sum(costs), 4), "cost_per_task_usd": round(sum(costs) / len(rs), 4),
            "cost_per_pass_usd": round(sum(costs) / passed, 4) if passed else None,
            "cost_unmeasured": len(rs) - len(costs),
            "mean_sessions": round(statistics.mean(r.get("sessions") or 0 for r in rs), 2),
            "mean_fix_rounds": round(statistics.mean(r.get("fix_rounds") or 0 for r in rs), 2) if c.startswith("loki") else None,
            "timeouts": sum(1 for r in rs if r["timed_out"]),
            "by_difficulty": {d: [sum(r["pass"] for r in rs if r.get("difficulty", "normal") == d),
                                  sum(1 for r in rs if r.get("difficulty", "normal") == d)]
                              for d in sorted({r.get("difficulty", "normal") for r in rs})},
        }
        scored = [r for r in rs if "accepted" in r]  # results written before accepted-without-edit existed lack it
        if scored:
            acc = sum(r["accepted"] for r in scored)
            ci = wilson(acc, len(scored))
            per_task = sum(r["cost_usd"] for r in scored if isinstance(r.get("cost_usd"), (int, float))) / len(scored)
            row.update({
                "accepted": acc, "accepted_n": len(scored), "accept_ci95": ci,
                "runs_with_test_edits": sum(1 for r in scored if r.get("test_edits")),
                "runs_weakening_tests": sum(1 for r in scored if r.get("test_weakened")),
                "cost_per_accepted_usd": round(per_task / (acc / len(scored)), 4) if acc else None,
                # $ per accepted task = $ per task / acceptance rate, so the acceptance rate's Wilson bounds give
                # its interval (cost per task held at its measured mean).
                "cost_per_accepted_ci95": [round(per_task / ci[1], 4), round(per_task / ci[0], 4) if ci[0] else None],
            })
        if c.startswith("loki"):
            row.update(verdict_stats(rs))
        rows.append(row)
    return rows


def markdown(rows, results, configs):
    out = ["| config | pass | 95% CI | accepted | 95% CI | hard | median s | p90 s | total $ | $ / task | $ / pass "
           "| $ / accepted | sessions | fix rounds | verdict agrees | false VERIFIED | timeouts |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        unm = f" ({r['cost_unmeasured']} unmeasured)" if r["cost_unmeasured"] else ""
        ci = r["pass_ci95"]
        hard = r["by_difficulty"].get("hard")
        cpp = f"{r['cost_per_pass_usd']:.4f}" if r["cost_per_pass_usd"] is not None else "-"
        fr = r["mean_fix_rounds"] if r["mean_fix_rounds"] is not None else "-"
        agree = f"{r['verdict_agree_n']}/{r['n']} ({r['verdict_agreement'] * 100:.0f}%)" if "verdict_agreement" in r else "-"
        if "accepted" in r:
            aci = r["accept_ci95"]
            acc = f"{r['accepted']}/{r['accepted_n']} | {aci[0] * 100:.0f}-{aci[1] * 100:.0f}%"
            cpa = f"{r['cost_per_accepted_usd']:.4f}" if r["cost_per_accepted_usd"] is not None else "-"
        else:
            acc, cpa = "- | -", "-"
        out.append(f"| {r['config']} | {r['passed']}/{r['n']} ({r['pass_rate'] * 100:.0f}%) | {ci[0] * 100:.0f}-{ci[1] * 100:.0f}% "
                   f"| {acc} | {f'{hard[0]}/{hard[1]}' if hard else '-'} | {r['median_s']} | {r['p90_s']} "
                   f"| {r['total_cost_usd']:.4f}{unm} | {r['cost_per_task_usd']:.4f} | {cpp} | {cpa} | {r['mean_sessions']} | {fr} "
                   f"| {agree} | {r.get('false_verified', '-')} | {r['timeouts']} |")
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


def select_tasks(tasks, configs, named):
    """A suite with a selection rule (fixtures/hard: the fix touches 2+ files and raw-haiku-verify passed under
    half its pilot runs) runs only qualifying tasks unless tasks are named; the oracle/noop self-check covers all."""
    if named or all(c in CHECK_CONFIGS for c in configs):
        return tasks
    return [t for t in tasks if t.get("qualified", True)]


def main(argv=None):
    loki_env_overrides()  # refuse a bad H2H_LOKI_ENV before any run starts
    ap = argparse.ArgumentParser(prog="benchmarks/h2h/run.sh", description=__doc__.splitlines()[0])
    ap.add_argument("--configs", default=",".join(CONFIGS), help=f"comma list from {CONFIGS + LOW_EFFORT_CONFIGS + CHECK_CONFIGS} "
                    f"(default: {','.join(CONFIGS)})")
    ap.add_argument("--suite", default="tasks", choices=sorted(SUITES), help="task suite: tasks (synthetic, default) "
                    "or replay (real closed issues replayed at the fix's parent commit)")
    ap.add_argument("--tasks", default="", help="comma list of task ids from the suite (default: all)")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=600, help="contestant timeout in seconds (default 600)")
    ap.add_argument("--budget", type=float, default=None, help="stop before starting a run once the ledger total reaches this many USD")
    ap.add_argument("--ledger", default=os.environ.get("H2H_LEDGER", ""), help="JSONL file of spend across invocations (one line per run)")
    ap.add_argument("--out", default="", help="results JSON path (default results/<date>-<shortsha>.json)")
    ap.add_argument("--keep", action="store_true", help="keep each run's work dir and print its path")
    ap.add_argument("--jobs", type=int, default=1, help="runs in flight at once (default 1); the budget check can "
                    "overshoot by at most jobs-1 runs, and wall times are measured under that concurrency")
    ap.add_argument("--sequences", default="", help="learning protocol: comma list of sequence ids under sequences/ "
                    f"(or 'all'); configs from {SEQUENCE_CONFIGS + SEQUENCE_RAW_CONFIGS + CHECK_CONFIGS}")
    ap.add_argument("--laps", type=int, default=1, help="with --sequences: run every sequence this many times in a row in "
                    "the same repo (reset to base between laps, .loki memory kept); run_index counts across laps")
    ap.add_argument("--resume", default="", help="results JSON from an interrupted invocation: its runs are kept "
                    "and every (config, task, rep) already in it is skipped")
    ap.add_argument("--allow-dirty", action="store_true", help="run Loki configs from a tree with uncommitted changes; "
                    "the results file is stamped citable: false")
    a = ap.parse_args(argv)
    if a.reps < 1 or a.jobs < 1 or a.laps < 1:
        ap.error("--reps, --jobs and --laps must be at least 1")
    if a.sequences:
        return main_sequences(a, ap)

    configs = [c for c in a.configs.split(",") if c]
    for c in configs:
        if c not in CONFIGS + LOW_EFFORT_CONFIGS + CHECK_CONFIGS:
            ap.error(f"unknown config {c}")
        if c in LOW_EFFORT_CONFIGS and c.startswith("loki-"):
            config_env(c, {})  # refuse an H2H_LOKI_ENV effort that contradicts the arm before any paid run starts
    tasks_dir = SUITES[a.suite]
    all_tasks = sorted(p.name for p in tasks_dir.iterdir() if (p / "meta.json").is_file())
    task_ids = [t for t in a.tasks.split(",") if t] or all_tasks
    for t in task_ids:
        if t not in all_tasks:
            ap.error(f"unknown task {t} in suite {a.suite}")
    tasks = select_tasks([load_task(t, tasks_dir) for t in task_ids], configs, bool(a.tasks))

    prov = provenance()
    blocked = provenance_gate(configs, prov, a.allow_dirty)
    if blocked:
        log(f"h2h: {blocked}")
        return 6
    if not prov["citable"]:
        log(f"h2h: DIRTY TREE ({prov['dirty_count']} uncommitted paths): these results are NOT CITABLE")
    a.provenance = [prov] + (json.loads(Path(a.resume).read_text()).get("provenance", []) if a.resume else [])
    sha = (prov["engine_sha"] or "nogit")[:9]
    suffix = "" if a.suite == "tasks" else f"-{a.suite}"
    out = Path(a.out) if a.out else HERE / "results" / f"{dt.date.today().isoformat()}-{sha}{suffix}.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    tmp_root = Path(os.environ.get("TMPDIR") or "/tmp").resolve()
    work = Path(tempfile.mkdtemp(prefix="loki-h2h.", dir=tmp_root))
    results = json.loads(Path(a.resume).read_text())["runs"] if a.resume else []
    done = {(r["config"], r["task"], r["rep"]) for r in results}
    # Rep-major order: every config sees every task once before any second rep starts, so a budget
    # stop leaves whole reps behind it rather than a config that has run every rep.
    queue = [(rep, task, c) for rep in range(1, a.reps + 1) for task in tasks for c in configs
             if (c, task["id"], rep) not in done]
    lock = threading.Lock()
    state = {"stopped": None}

    def worker():
        while True:
            with lock:
                if state["stopped"] or not queue:
                    return
                spent = ledger_total(a.ledger)
                if a.budget is not None and spent >= a.budget:
                    state["stopped"] = f"budget {a.budget} reached (ledger {spent:.4f})"
                    return
                rep, task, c = queue.pop(0)
                log(f"h2h: {c} {task['id']} rep {rep} (ledger ${spent:.4f}, {len(queue)} queued)")
            try:
                rec = run_one(c, task, rep, work, a.timeout, a.keep)
            except Exception as exc:  # a harness fault is recorded as a failed run, never dropped
                rec = {"config": c, "task": task["id"], "kind": task["kind"], "lang": task["lang"],
                       "difficulty": task.get("difficulty", "normal"), "shape": task.get("shape"), "rep": rep,
                       "pass": 0, "accepted": 0, "test_edits": [], "test_weakened": [], "seconds": 0.0, "exit_code": None, "timed_out": False,
                       "files_changed": 0, "files": [], "hidden_leaked_before_scoring": [], "cost_usd": None, "sessions": 0, "harness_error": repr(exc)[:300],
                       "harness_traceback": traceback.format_exc()[-1500:]}
            with lock:
                results.append(rec)
                if a.ledger and c not in CHECK_CONFIGS:
                    with open(a.ledger, "a") as fh:
                        fh.write(json.dumps({"config": c, "task": task["id"], "rep": rep, "cost_usd": rec.get("cost_usd"),
                                             "at": dt.datetime.now().isoformat()}) + "\n")
                log(f"h2h:   {c} {task['id']} rep {rep}: pass={rec['pass']} exit={rec['exit_code']} {rec['seconds']}s "
                    f"cost={rec.get('cost_usd')} sessions={rec.get('sessions')} files={rec['files_changed']}")
                write_results(out, results, configs, sha, a, state["stopped"])

    try:
        if any(c not in CHECK_CONFIGS for c in configs) and queue:
            ok, detail = auth_ok(work)
            if not ok:
                log(f"h2h: claude auth does not resolve under the throwaway HOME; refusing to run\n{detail}")
                return 3
        threads = [threading.Thread(target=worker) for _ in range(min(a.jobs, max(1, len(queue))))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        if state["stopped"]:
            log(f"h2h: stopped: {state['stopped']}")
    finally:
        if work.name.startswith("loki-h2h.") and work.parent == tmp_root and not a.keep:
            shutil.rmtree(work, ignore_errors=True)
    order = {(c, t["id"], r): i for i, (r, t, c) in enumerate(
        (r, t, c) for r in range(1, a.reps + 1) for t in tasks for c in configs)}
    results.sort(key=lambda r: order.get((r["config"], r["task"], r["rep"]), len(order)))
    write_results(out, results, configs, sha, a, state["stopped"])
    rows = summarize(results, configs)
    print(markdown(rows, results, configs))
    print(f"\nresults: {out}")
    leaks = [r for r in results if r["hidden_leaked_before_scoring"]]
    if leaks:
        log(f"h2h: hidden test files were present before scoring in {len(leaks)} runs")
        return 4
    errors = [r for r in results if r.get("harness_error")]
    if errors:
        log(f"h2h: {len(errors)} runs hit a harness error (recorded as failed): {errors[0]['harness_error']}")
        return 5
    return 0


def write_results(out, results, configs, sha, a, stopped):
    doc = {
        "benchmark": "h2h-b1", "suite": a.suite, "loki_sha": sha, "date": dt.datetime.now().isoformat(timespec="seconds"),
        # Every invocation that added runs to this file, newest first; citable only if all of them were.
        "citable": all(p["citable"] for p in getattr(a, "provenance", [])) if getattr(a, "provenance", None) else None,
        "provenance": getattr(a, "provenance", []),
        "configs": configs, "reps": a.reps, "jobs": a.jobs, "timeout_s": a.timeout, "stopped": stopped,
        "loki_env": loki_env_overrides(), "tasks": sorted({r["task"] for r in results}),
        "summary": summarize(results, configs), "runs": results,
    }
    out.write_text(json.dumps(doc, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
