"""Loki 10 MCP tool helpers: start a v10 run, read its status, verify a receipt.

Plain functions returning dicts so they are testable without the MCP SDK; the
thin @mcp.tool wrappers live in mcp/server.py. Subprocesses use argument lists
only (never a shell), and every path is checked by the caller-supplied
validator before use.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

LOKI_BIN = str(Path(__file__).resolve().parent.parent / "bin" / "loki")
RUNS_REL = os.path.join(".loki", "runs")
V10_RUN_ID_WAIT_S = 2.0
V10_VERIFY_TIMEOUT_S = 120
SEAL_DIFF_TIMEOUT_S = int(os.environ.get("LOKI_SEAL_DIFF_TIMEOUT_S", "1800"))
_TERMINAL = {"stage.completed", "stage.failed", "stage.skipped"}


_DROPPED_ENV = ("LOKI_CONTROL_TOKEN", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_WEBHOOK_URL")


def _env() -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in _DROPPED_ENV}
    env["LOKI_ENGINE"] = "v10"
    env["LOKI_NO_BROWSER"] = "1"
    return env


def _run_ids(repo: str) -> List[str]:
    d = os.path.join(repo, RUNS_REL)
    if not os.path.isdir(d):
        return []
    return sorted(n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)))


def _log_tail(path: str, lines: int = 20) -> str:
    try:
        with open(path, "rb") as f:
            data = f.read()[-65536:]
    except OSError as e:
        return f"(log unreadable: {e})"
    return "\n".join(data.decode("utf-8", "replace").splitlines()[-lines:])


def v10_run(ref: str, repo_path: str, validate: Callable[[str], str]) -> dict:
    if not isinstance(ref, str) or not ref.strip() or ref.startswith("-") or "\x00" in ref:
        return {"error": "invalid ref: must be a non-empty task or issue reference that does not start with '-'"}
    try:
        repo = validate(repo_path)
    except Exception as e:  # PathTraversalError from the server validator
        return {"error": str(e)}
    if not os.path.isdir(repo):
        return {"error": f"repo_path is not a directory: {repo_path}"}
    before = set(_run_ids(repo))
    log_dir = os.path.join(repo, ".loki")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f"v10-mcp-{int(time.time() * 1000)}.log")
    try:
        with open(log_path, "ab") as log:
            proc = subprocess.Popen(
                [LOKI_BIN, ref],
                cwd=repo,
                env=_env(),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
    except OSError as e:
        return {"error": f"could not start loki: {e}"}
    run_id: Optional[str] = None
    deadline = time.time() + V10_RUN_ID_WAIT_S
    while True:
        new = [r for r in _run_ids(repo) if r not in before]
        if new:
            run_id = new[-1]
            break
        rc = proc.poll()
        if isinstance(rc, int):
            return {"error": f"loki exited {rc} before a run started. Log tail:\n{_log_tail(log_path)}",
                    "run_id": None, "pid": proc.pid, "log_path": log_path}
        if time.time() >= deadline:
            break
        time.sleep(0.1)
    return {"run_id": run_id, "pid": proc.pid, "log_path": log_path}


def _read_events(path: str) -> List[dict]:
    events = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict):
                events.append(e)
    return events


def v10_status(run_id: str, repo_path: str, validate: Callable[[str], str]) -> dict:
    if not repo_path:
        return {"error": "repo_path is required"}
    try:
        repo = validate(repo_path)
    except Exception as e:
        return {"error": str(e)}
    if run_id:
        if "/" in run_id or "\\" in run_id or run_id.startswith(".") or "\x00" in run_id:
            return {"error": "invalid run_id"}
    else:
        ids = _run_ids(repo)
        if not ids:
            return {"error": "no v10 runs found under .loki/runs"}
        run_id = ids[-1]
    events_path = os.path.join(repo, RUNS_REL, run_id, "events.jsonl")
    if not os.path.isfile(events_path):
        return {"error": f"no events.jsonl for run {run_id}"}
    events = _read_events(events_path)
    open_stages: Dict[str, bool] = {}
    verdict = None
    question = None
    done = False
    usd = 0.0
    saw_cost = False
    unmeasured = False
    for e in events:
        t, stage = e.get("type"), e.get("stage")
        data = e.get("data") if isinstance(e.get("data"), dict) else {}
        if stage:
            if t == "stage.started":
                open_stages[stage] = True
            elif t in _TERMINAL:
                open_stages.pop(stage, None)
        if t == "stage.completed" and stage in ("implement", "fix") and isinstance(data.get("spec_conflict_reason"), str) and data["spec_conflict_reason"]:  # mirror of conflictReasonOf (loki-ts/src/engine10/events.ts): a later fix reason overwrites implement's
            question = re.sub(r"[\x00-\x1f\x7f]+", " ", data["spec_conflict_reason"])[:500]
        if t == "run.completed":
            done = True
            verdict = data.get("verdict") if isinstance(data.get("verdict"), str) else None
        elif t == "cost":
            saw_cost = True
            if isinstance(data.get("usd"), (int, float)):
                usd += data["usd"]
            else:
                unmeasured = True
    phase = "done" if done else ("+".join(sorted(open_stages)) or "starting")
    result = {
        "run_id": run_id,
        "phase": phase,
        "done": done,
        "verdict": verdict,
        "cost_usd": usd if saw_cost and not unmeasured else None,
        "events": len(events),
    }
    if verdict == "BLOCKED":
        result["blocked_question"] = question or "see the receipt"
    return result


def v10_verify(receipt_path: str, repo_path: str, validate: Callable[[str], str]) -> dict:
    args = [LOKI_BIN, "verify"]
    try:
        if receipt_path:
            receipt = validate(receipt_path)
            if not os.path.isfile(receipt):
                return {"error": f"receipt not found: {receipt_path}"}
            args.append(receipt)
            cwd = os.path.dirname(receipt)
        elif repo_path:
            cwd = validate(repo_path)
            if not os.path.isdir(cwd):
                return {"error": f"repo_path is not a directory: {repo_path}"}
        else:
            return {"error": "receipt_path or repo_path is required"}
    except Exception as e:
        return {"error": str(e)}
    try:
        p = subprocess.run(
            args, cwd=cwd, env=_env(), stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=V10_VERIFY_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"loki verify timed out after {V10_VERIFY_TIMEOUT_S}s"}
    except OSError as e:
        return {"error": f"could not run loki verify: {e}"}
    out = ((p.stdout or "") + (p.stderr or "")).strip()
    return {"exit_code": p.returncode, "verified": p.returncode == 0, "output": out[-2000:]}


def _git(cwd: str, *args: str, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, timeout=120)


def seal_diff(repo_path: str, intent: str, validate: Callable[[str], str]) -> dict:
    """Seal changes already made in repo_path (CW-12): the existing engine runs on a scratch clone of HEAD with the
    working-tree diff handed to `--seal-existing`, so the Wall is authored from the intent alone and the diff only
    reaches the tree at implement. The user's tree, index and branch are never touched; only the run dir is copied back."""
    if not isinstance(intent, str) or not intent.strip() or intent.startswith("-") or "\x00" in intent:
        return {"error": "invalid intent: must be a non-empty description that does not start with '-'"}
    try:
        repo = validate(repo_path)
    except Exception as e:
        return {"error": str(e)}
    if not os.path.isdir(repo):
        return {"error": f"repo_path is not a directory: {repo_path}"}
    work = tempfile.mkdtemp(prefix="loki-seal-")
    try:
        if _git(repo, "rev-parse", "--verify", "-q", "HEAD").returncode != 0:
            return {"error": "repo_path is not a git repository with a commit to diff against"}
        # Snapshot the working tree (tracked edits plus new files) with a private index so the user's index is untouched.
        idx_env = dict(os.environ, GIT_INDEX_FILE=os.path.join(work, "index"))
        for step in (("read-tree", "HEAD"), ("add", "-A")):
            r = _git(repo, *step, env=idx_env)
            if r.returncode != 0:
                return {"error": f"could not snapshot the working tree: {r.stderr.decode('utf-8', 'replace').strip()[-300:]}"}
        d = _git(repo, "diff", "--cached", "--binary", "HEAD", env=idx_env)
        if d.returncode != 0 or not d.stdout.strip():
            return {"error": "no changes to seal: the working tree matches HEAD"}
        patch = os.path.join(work, "external.patch")
        with open(patch, "wb") as f:
            f.write(d.stdout)
        clone = os.path.join(work, "clone")
        c = _git(work, "clone", "--quiet", "--no-hardlinks", repo, clone)
        if c.returncode != 0:
            return {"error": f"could not clone the repository: {c.stderr.decode('utf-8', 'replace').strip()[-300:]}"}
        try:
            p = subprocess.run([LOKI_BIN, intent, "--seal-existing", patch], cwd=clone, env=_env(), stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=SEAL_DIFF_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return {"error": f"seal timed out after {SEAL_DIFF_TIMEOUT_S}s"}
        except OSError as e:
            return {"error": f"could not run loki: {e}"}
        out = ((p.stdout or "") + (p.stderr or "")).strip()
        try:
            with open(os.path.join(clone, ".loki", "engine.json"), "r", encoding="utf-8") as f:
                run_id = json.load(f)["run_id"]
            src = os.path.join(clone, RUNS_REL, run_id)
            with open(os.path.join(src, "receipt.json"), "r", encoding="utf-8") as f:
                receipt = json.load(f)
        except (OSError, ValueError, KeyError):
            return {"error": f"loki exited {p.returncode} without a receipt. Output tail:\n{out[-1500:]}"}
        dest = os.path.join(repo, RUNS_REL, run_id)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copytree(src, dest, dirs_exist_ok=True)
        verdict = receipt.get("verdict")
        return {"run_id": run_id, "verdict": verdict, "verified": verdict == "VERIFIED",
                "receipt_path": os.path.join(dest, "receipt.json"),
                "not_proven": receipt.get("not_proven", []), "exit_code": p.returncode}
    except subprocess.TimeoutExpired:
        return {"error": "git timed out"}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _cwd_validator(p: str) -> str:
    """Resolve p and require it to sit inside the current working directory (the MCP server's, as for the SDK path)."""
    root = os.path.realpath(os.getcwd())
    real = os.path.realpath(p)
    if real != root and not real.startswith(root + os.sep):
        raise ValueError(f"path outside the working directory: {p}")
    return real


def cli(argv: List[str]) -> int:
    """MCP-D adapter for the JS server's Tasks. Calls only v10_verify or v10_run and prints their dict as one
    sorted-key JSON line. Nothing else is reachable from here, and no verdict is computed or changed."""
    import sys
    if len(argv) != 3 or argv[0] not in ("verify", "run"):
        sys.stderr.write("usage: v10_tools.py verify <receipt_path|''> <repo_path|''> | run <ref> <repo_path>\n")
        return 2
    if argv[0] == "verify":
        result = v10_verify(argv[1], argv[2], _cwd_validator)
    else:
        result = v10_run(argv[1], argv[2], _cwd_validator)
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(cli(sys.argv[1:]))
