"""v7.7.22: deterministic READ-ONLY session replay.

Wow feature 1 from the memory excellence bar: no competitor offers
session replay. `loki memory replay <episode-id>` re-renders a past
episode's recorded action sequence as a timeline, annotated with the
CURRENT state of each touched file (still exists? changed since the
episode? present in git?). This answers "what did that session do, and
what has changed since" without re-executing anything.

DESIGN DECISION (v7.7.22): replay is READ-ONLY. It does NOT re-run the
recorded tool_use sequence. LLM tool_uses are non-deterministic and
re-running Edit/Write against the current repo could clobber
uncommitted work. The `--apply` re-execution mode is deliberately
deferred to a future release with proper sandboxing + confirmation.

Output: a structured dict (the CLI renders Markdown or emits JSON).
Never raises; returns an error dict on failure.
"""
from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _file_changed_since(repo_root: str, file_path: str, since_iso: Optional[str]) -> str:
    """Return a current-state annotation for `file_path`.

    One of: "missing", "unchanged-since", "changed-since",
    "exists-no-timestamp", "exists-not-in-git". Best-effort; never raises.
    """
    abs_path = file_path if os.path.isabs(file_path) else os.path.join(repo_root, file_path)
    if not os.path.exists(abs_path):
        return "missing"
    if not since_iso:
        return "exists-no-timestamp"
    # Use git to see if the file changed after the episode timestamp.
    try:
        # Normalize the ISO timestamp for git --since.
        since = since_iso.replace("Z", "+00:00")
        result = subprocess.run(
            ["git", "-C", repo_root, "log", "--oneline", f"--since={since}", "--", file_path],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return "exists-not-in-git"
        commits = [ln for ln in result.stdout.splitlines() if ln.strip()]
        return "changed-since" if commits else "unchanged-since"
    except (subprocess.SubprocessError, OSError):
        return "exists-no-timestamp"


def replay_episode(
    episode_id: str,
    memory_base: str,
    repo_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a read-only replay report for `episode_id`.

    Args:
        episode_id: The episode id (without the `task-` prefix).
        memory_base: Path to the project's `.loki/memory/` directory.
        repo_root: Repo root for current-state annotations. Defaults to
            the parent-of-parent of memory_base (i.e. the project root).

    Returns:
        dict: {episode_id, found, timestamp, goal, outcome, agent,
        timeline:[{step, tool, target, timestamp}], files:[{path,
        state}], summary:{steps, files_touched, files_missing,
        files_changed_since}} or {error: ...}.
    """
    try:
        from memory.storage import MemoryStorage
        storage = MemoryStorage(memory_base)
        episode = storage.load_episode(episode_id)
        if episode is None:
            return {"episode_id": episode_id, "found": False,
                    "error": f"episode '{episode_id}' not found in {memory_base}"}

        if repo_root is None:
            # memory_base is typically <root>/.loki/memory
            repo_root = str(Path(memory_base).resolve().parent.parent)

        ts = episode.get("timestamp")
        context = episode.get("context", {}) if isinstance(episode.get("context"), dict) else {}
        goal = context.get("goal") or episode.get("goal") or episode.get("summary", "")

        # Timeline from action_log (v7.7.18 format). Fall back to
        # tools_used (older episode format) if action_log is empty.
        timeline: List[Dict[str, Any]] = []
        action_log = episode.get("action_log") or []
        if action_log:
            for i, a in enumerate(action_log, 1):
                if isinstance(a, dict):
                    timeline.append({
                        "step": i,
                        "tool": a.get("action", a.get("tool", "?")),
                        "target": a.get("target", a.get("input", "")),
                        "timestamp": a.get("t", a.get("timestamp", 0)),
                    })
        else:
            for i, t in enumerate(episode.get("tools_used", []) or [], 1):
                timeline.append({"step": i, "tool": str(t), "target": "", "timestamp": 0})

        # Current-state annotations for touched files.
        touched = []
        seen = set()
        for f in (episode.get("files_modified") or []) + (episode.get("files_changed") or []):
            if f and f not in seen:
                seen.add(f)
                touched.append(f)
        files = []
        missing = 0
        changed = 0
        for f in touched:
            state = _file_changed_since(repo_root, f, ts)
            if state == "missing":
                missing += 1
            elif state == "changed-since":
                changed += 1
            files.append({"path": f, "state": state})

        return {
            "episode_id": episode_id,
            "found": True,
            "timestamp": ts,
            "goal": str(goal)[:500],
            "outcome": episode.get("outcome", "unknown"),
            "agent": episode.get("agent", "unknown"),
            "timeline": timeline,
            "files": files,
            "summary": {
                "steps": len(timeline),
                "files_touched": len(touched),
                "files_missing": missing,
                "files_changed_since": changed,
            },
            "mode": "read-only (dry-run); --apply re-execution deferred to a future release",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        return {"episode_id": episode_id, "found": False, "error": str(e)}


def render_markdown(report: Dict[str, Any]) -> str:
    """Render a replay report dict as a human-readable Markdown timeline."""
    if not report.get("found"):
        return f"# Replay: {report.get('episode_id', '?')}\n\nNot found: {report.get('error', 'unknown error')}\n"
    # v7.7.22 council fix (Opus 2): use .get() defaults throughout so a
    # hand-built or partial report dict cannot KeyError. The CLI always
    # passes a complete replay_episode() result, but render_markdown is
    # public and may be called with sparse input.
    lines = [
        f"# Replay: {report.get('episode_id', '?')}",
        "",
        f"- Goal: {report.get('goal', '')}",
        f"- Outcome: {report.get('outcome')}",
        f"- Agent: {report.get('agent')}",
        f"- Recorded: {report.get('timestamp')}",
        f"- Mode: {report.get('mode')}",
        "",
        "## Timeline",
        "",
    ]
    timeline = report.get("timeline") or []
    if timeline:
        for step in timeline:
            lines.append(f"{step.get('step', '?')}. **{step.get('tool', '?')}** {step.get('target', '')}")
    else:
        lines.append("(no recorded actions)")
    lines += ["", "## Files touched (current state)", ""]
    files = report.get("files") or []
    if files:
        for f in files:
            lines.append(f"- `{f.get('path', '?')}` -- {f.get('state', '?')}")
    else:
        lines.append("(none)")
    s = report.get("summary") or {}
    lines += [
        "",
        "## Summary",
        "",
        f"- Steps: {s['steps']}",
        f"- Files touched: {s['files_touched']}",
        f"- Now missing: {s['files_missing']}",
        f"- Changed since episode: {s['files_changed_since']}",
        "",
    ]
    return "\n".join(lines)
