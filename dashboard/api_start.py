"""First-run onboarding and the issue backlog (D51 Phase A).

Three onboarding steps (provider, GitHub PAT, repo) and a backlog that queues
v10 issue-mode runs through the existing launcher: `bin/loki owner/repo#N
--json` with LOKI_ENGINE=v10, one git worktree per issue, so each run gets its
own branch and PR from the engine.

Secrets: the PAT and any provider API key live in ~/.loki/credentials/ (dir
0700, files 0600). No response, log line or event carries them; the PAT reaches
GitHub only in an Authorization header and a child process env, never a URL or
argv.

ponytail: run state is in memory (a dashboard restart forgets the queue; the
runs themselves keep going and their worktrees keep the receipts). The
v10 engine has no resume-with-answer (--resume was removed), so a BLOCKED
question is shown with the re-run command instead of an answer box.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import auth

logger = logging.getLogger(__name__)
router = APIRouter(tags=["start"])

_LOKI_BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "loki")
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{10,255}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_\-.]{10,512}$")
_PROVIDER_KEY_ENV = {"claude": "ANTHROPIC_API_KEY", "codex": "OPENAI_API_KEY"}
_PROVIDER_BIN = {"claude": "claude", "codex": "codex"}
_SECRET_FILES = {"github": "github", "claude_api_key": "claude_api_key", "codex_api_key": "codex_api_key"}
_lock = threading.RLock()


def _pick(table: dict, key):
    """Return the table's own constant equal to key, so request data never reaches a sink."""
    for const in table.values():
        if const == key:
            return const
    return None


def _secret_path(name: str) -> Path:
    const = _pick(_SECRET_FILES, name)
    if const is None:
        raise ValueError("unknown secret name")
    base = _creds_dir().resolve()
    dest = (base / const).resolve()
    if dest.parent != base:
        raise ValueError("secret path escapes credentials dir")
    return dest
_RUNS: dict = {}


class GitHubError(Exception):
    pass


# --- storage -----------------------------------------------------------------

def _home() -> Path:
    return Path(os.path.expanduser("~")) / ".loki"


def _creds_dir() -> Path:
    d = _home() / "credentials"
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def _write_secret(name: str, value: str) -> None:
    dest = _secret_path(name)
    tmp = dest.with_name(".%s.%d.tmp" % (dest.name, os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (value + "\n").encode())
    finally:
        os.close(fd)
    os.replace(tmp, dest)


def _read_secret(name: str) -> Optional[str]:
    try:
        return _secret_path(name).read_text().strip() or None
    except (OSError, ValueError):
        return None


def _cfg() -> dict:
    try:
        return json.loads((_home() / "onboarding.json").read_text())
    except (OSError, ValueError):
        return {}


def _save_cfg(**kv) -> None:
    c = _cfg()
    c.update(kv)
    _home().mkdir(parents=True, exist_ok=True)
    (_home() / "onboarding.json").write_text(json.dumps(c))


# --- external edges (mocked in tests) ----------------------------------------

def _gh_api(path: str, token: str):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "User-Agent": "loki-mode"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise GitHubError("GitHub returned HTTP %d" % e.code)
    except (urllib.error.URLError, OSError, ValueError):
        raise GitHubError("could not reach GitHub")


def _cli_version(name: str) -> Optional[str]:
    """Version probe only. Never reads the CLI's credential files."""
    binary = _pick(_PROVIDER_BIN, name)
    if binary is None or not shutil.which(binary):
        return None
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.SubprocessError):
        return None
    return (out.stdout.strip().splitlines() or ["unknown"])[0] if out.returncode == 0 else None


def _git(*args, cwd=None, env=None) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError("git %s failed" % args[0])
    return r.stdout.strip()


def _project_dir() -> str:
    return os.environ.get("LOKI_PROJECT_DIR") or os.getcwd()


def _autonomy_lib():
    lib = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "autonomy", "lib")
    if lib not in sys.path:
        sys.path.insert(0, lib)


def _workspaces_enabled() -> bool:
    """Same rule as `loki workspace`: on by default, LOKI_WORKSPACES=0 disables."""
    _autonomy_lib()
    import workspace
    return workspace.enabled()


def _worktree_prep():
    _autonomy_lib()
    import worktree_prep
    return worktree_prep


def _prepare_workdir(repo: str, number: int, token: str) -> str:
    """One git worktree per issue, off the repo's default branch."""
    env = dict(os.environ, GH_TOKEN=token, GIT_TERMINAL_PROMPT="0")
    slug = repo.replace("/", "__")
    base = _project_dir()
    try:
        origin = _git("remote", "get-url", "origin", cwd=base)
    except (RuntimeError, OSError):
        origin = ""
    if not re.search(r"[:/]" + re.escape(repo) + r"(\.git)?/?$", origin):
        base = str(_home() / "repos" / slug)
        if not os.path.isdir(base):
            os.makedirs(os.path.dirname(base), exist_ok=True)
            subprocess.run(["gh", "repo", "clone", "--", repo, base], env=env, check=True,
                           capture_output=True, timeout=600)
    try:
        _git("fetch", "origin", cwd=base, env=env)
        start = "origin/HEAD"
        _git("rev-parse", "--verify", start, cwd=base)
    except (RuntimeError, OSError):
        start = "HEAD"
    stamp = time.strftime("%Y%m%d%H%M%S")
    wt = _home() / "worktrees" / slug / ("issue-%d-%s" % (number, stamp))
    wt.parent.mkdir(parents=True, exist_ok=True)
    branch = "loki/backlog-%d-%s" % (number, stamp)
    if _workspaces_enabled():
        # Shared worktree prep (D51-B06): same per-base lock and dep copy as backlog and workspace runs.
        _worktree_prep().prepare_worktree(base, str(wt), branch, base=start)
        return str(wt)
    _git("worktree", "add", "-b", branch, str(wt), start, cwd=base)
    return str(wt)


def _out_path(workdir: str) -> Path:
    """Run output lives beside, never inside, the worktree the engine commits from."""
    w = Path(workdir)
    d = _home() / "backlog"
    d.mkdir(parents=True, exist_ok=True)
    return d / ("%s__%s.out" % (w.parent.name, w.name))


def launch_run(repo: str, number: int, workdir: str, env: dict):
    """The existing launcher: `loki owner/repo#N --json` in the issue's worktree."""
    with open(_out_path(workdir), "w") as out:
        return subprocess.Popen([_LOKI_BIN, "%s#%d" % (repo, number), "--json"], cwd=workdir, env=env,
                                stdout=out, stderr=subprocess.STDOUT, start_new_session=True)


def _read_outcome(workdir: str, rc: int) -> dict:
    run_id, outcome = None, None
    try:
        j = json.loads(_out_path(workdir).read_text().strip().splitlines()[-1])
        run_id, outcome = j.get("run_id"), j.get("outcome")
    except (OSError, ValueError, IndexError, AttributeError):
        pass
    pr_url, question = None, None
    runs = Path(workdir, ".loki", "runs")
    ev = runs / run_id / "events.jsonl" if run_id else None
    if ev is None or not ev.is_file():
        found = sorted(runs.glob("*/events.jsonl")) if runs.is_dir() else []
        ev = found[-1] if found else None
    if ev:
        for line in ev.read_text(errors="replace").splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            d = e.get("data") or {}
            if e.get("type") == "pr.opened" and d.get("url"):
                pr_url = d["url"] if str(d["url"]).startswith("https://") else None
            if e.get("type") == "stage.completed" and e.get("stage") == "implement" and d.get("spec_conflict_reason"):
                question = str(d["spec_conflict_reason"])
    if rc == 0:
        return {"status": "pr_open", "pr_url": pr_url} if pr_url else {"status": "done", "detail": outcome or "no change needed"}
    if rc == 4:
        return {"status": "blocked", "question": question or "see the run receipt"}
    return {"status": "failed", "detail": "%s (exit %s)" % (outcome or "FAILED", rc)}


# --- onboarding --------------------------------------------------------------

def _scope(s):
    return [Depends(auth.require_scope(s))]


def _github() -> dict:
    tok = _read_secret("github")
    return {"configured": bool(tok), "login": _cfg().get("github_login") if tok else None}


class ProviderIn(BaseModel):
    provider: str
    api_key: Optional[str] = None


class TokenIn(BaseModel):
    token: str


class RepoIn(BaseModel):
    repo: str


class RunIn(BaseModel):
    issues: list[int] = []
    all: bool = False


@router.get("/api/onboarding/state", dependencies=_scope("read"))
def onboarding_state():
    detected = []
    for n in ("claude", "codex"):
        v = _cli_version(n)
        if v:
            detected.append({"name": n, "version": v})
    c = _cfg()
    return {"provider": {"configured": bool(c.get("provider")), "name": c.get("provider"), "detected": detected},
            "github": _github(), "repo": c.get("repo")}


@router.post("/api/onboarding/provider", dependencies=_scope("control"))
def set_provider(body: ProviderIn):
    if body.provider not in _PROVIDER_KEY_ENV:
        raise HTTPException(400, "provider must be claude or codex")
    if body.api_key:
        if not _KEY_RE.match(body.api_key):
            raise HTTPException(400, "api key format not accepted")
        _write_secret(body.provider + "_api_key", body.api_key)
    elif not _cli_version(body.provider):
        raise HTTPException(400, "%s CLI not found on PATH; install it or provide an API key" % body.provider)
    _save_cfg(provider=body.provider)
    return {"configured": True, "name": body.provider}


@router.post("/api/onboarding/github", dependencies=_scope("control"))
def set_github(body: TokenIn):
    tok = body.token.strip()
    if not _TOKEN_RE.match(tok):
        raise HTTPException(400, "token format not accepted")
    try:
        login = _gh_api("/user", tok).get("login")
    except GitHubError as e:
        raise HTTPException(400, str(e))
    _write_secret("github", tok)
    _save_cfg(github_login=login)
    return {"configured": True, "login": login}


def _token() -> str:
    tok = _read_secret("github")
    if not tok:
        raise HTTPException(409, "GitHub is not connected yet")
    return tok


@router.get("/api/onboarding/repos", dependencies=_scope("read"))
def list_repos():
    try:
        rows = _gh_api("/user/repos?per_page=100&sort=updated", _token())
    except GitHubError as e:
        raise HTTPException(502, str(e))
    return {"repos": [r["full_name"] for r in rows]}


@router.post("/api/onboarding/repo", dependencies=_scope("control"))
def set_repo(body: RepoIn):
    if not _REPO_RE.match(body.repo) or ".." in body.repo or body.repo.startswith("-"):
        raise HTTPException(400, "repo must look like owner/repo")
    _save_cfg(repo=body.repo)
    return {"repo": body.repo}


# --- backlog -----------------------------------------------------------------

def _size(body: str) -> str:
    # ponytail: no issue-text sizing rule found in autonomy/ or dashboard/ (grep size_estimate,
    # estimate_size); body length is the proxy. Swap in a real rule if one appears.
    n = len(body or "")
    return "S" if n < 500 else "M" if n < 2000 else "L"


def _open_issues() -> list:
    repo = _cfg().get("repo")
    if not repo:
        raise HTTPException(409, "choose a repo first")
    try:
        rows = _gh_api("/repos/%s/issues?state=open&per_page=100" % repo, _token())
    except GitHubError as e:
        raise HTTPException(502, str(e))
    return [{"number": r["number"], "title": r.get("title", ""), "url": r.get("html_url"),
             "labels": [l["name"] for l in r.get("labels", [])], "size": _size(r.get("body"))}
            for r in rows if "pull_request" not in r]


@router.get("/api/backlog/issues", dependencies=_scope("read"))
def backlog_issues():
    return {"repo": _cfg().get("repo"), "issues": _open_issues()}


def _concurrency() -> int:
    # ponytail: env now; loki.yaml (D51 item 2) owns this when it lands. No
    # provider rate-limit mechanism exists to honour, so this is the only cap.
    try:
        return max(1, int(os.environ.get("LOKI_BACKLOG_CONCURRENCY", "2")))
    except ValueError:
        return 2


def _child_env(token: str) -> dict:
    e = dict(os.environ, GH_TOKEN=token, GITHUB_TOKEN=token, LOKI_ENGINE="v10", LOKI_NO_BROWSER="1")
    prov = _cfg().get("provider")
    if prov:
        e["LOKI_PROVIDER"] = prov
        key = _read_secret(prov + "_api_key")
        if key:
            e[_PROVIDER_KEY_ENV[prov]] = key
    return e


def _pump() -> None:
    """Reap finished runs, then start queued ones up to the concurrency cap.

    Clone/worktree prep happens outside the lock (a first clone can take
    minutes); a row is marked "preparing" so a concurrent pump cannot double-start it.
    """
    with _lock:
        for r in _RUNS.values():
            if r["status"] == "running" and r["proc"].poll() is not None:
                r.update(_read_outcome(r["workdir"], r["proc"].returncode))
        busy = sum(1 for r in _RUNS.values() if r["status"] in ("running", "preparing"))
        batch = [r for r in _RUNS.values() if r["status"] == "queued"][:max(0, _concurrency() - busy)]
        for r in batch:
            r["status"] = "preparing"
        repo, token = _cfg().get("repo"), _read_secret("github")
    for r in batch:
        try:
            wd = _prepare_workdir(repo, r["number"], token)
            proc = launch_run(repo, r["number"], wd, _child_env(token))
            with _lock:
                r.update(workdir=wd, proc=proc, status="running")
        except Exception as e:  # never echo env or token
            logger.error("backlog launch failed for #%s: %s", r["number"], type(e).__name__)
            with _lock:
                r.update(status="failed", detail="could not start: %s" % type(e).__name__)


_thread = None


def _ensure_pump_thread() -> None:
    """Advance the queue without a browser polling (close the tab, runs still drain)."""
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return

        def loop():
            while True:
                time.sleep(3)
                try:
                    _pump()
                except Exception as e:
                    logger.error("backlog pump failed: %s", type(e).__name__)
                with _lock:
                    if not any(r["status"] in ("queued", "preparing", "running") for r in _RUNS.values()):
                        return

        _thread = threading.Thread(target=loop, daemon=True, name="backlog-pump")
        _thread.start()


@router.post("/api/backlog/run", dependencies=_scope("control"))
def backlog_run(body: RunIn):
    _token()
    issues = {i["number"]: i for i in _open_issues()}
    nums = list(issues) if body.all else [n for n in body.issues if n in issues]
    queued = []
    with _lock:
        for n in nums:
            if _RUNS.get(n, {}).get("status") in ("queued", "preparing", "running"):
                continue
            _RUNS[n] = {"number": n, "title": issues[n]["title"], "status": "queued", "proc": None, "workdir": None}
            queued.append(n)
    _pump()
    _ensure_pump_thread()
    return {"queued": queued}


@router.get("/api/backlog/status", dependencies=_scope("read"))
def backlog_status():
    _pump()
    repo = _cfg().get("repo")
    out = []
    with _lock:
        for r in _RUNS.values():
            row = {k: r.get(k) for k in ("number", "title", "status", "pr_url", "question", "detail")}
            if r["status"] == "blocked":
                row["resume_hint"] = ("The engine cannot resume with an answer (--resume was removed). "
                                      "Answer on the issue, then re-run: loki %s#%d" % (repo, r["number"]))
            out.append(row)
    return {"repo": repo, "concurrency": _concurrency(), "issues": out}


def reset_runs_for_tests() -> None:
    with _lock:
        _RUNS.clear()


def reset_for_tests() -> None:
    reset_runs_for_tests()
