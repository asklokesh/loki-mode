"""Loki 10 MCP tool helpers: start a v10 run, read its status, verify a receipt.

Plain functions returning dicts so they are testable without the MCP SDK; the
thin @mcp.tool wrappers live in mcp/server.py. Subprocesses use argument lists
only (never a shell), and every path is checked by the caller-supplied
validator before use.
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

LOKI_BIN = str(Path(__file__).resolve().parent.parent / "bin" / "loki")
RUNS_REL = os.path.join(".loki", "runs")
V10_RUN_ID_WAIT_S = 2.0
V10_VERIFY_TIMEOUT_S = 120
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
        if t == "stage.completed" and stage == "implement" and isinstance(data.get("spec_conflict_reason"), str):
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
