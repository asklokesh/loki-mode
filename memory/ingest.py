"""v7.7.18: ingest non-`loki start` sessions into the memory store.

Diagnosis at ~/git/loki-plan/MEMORY-DIAGNOSIS-2026-05-27.md root cause:
`auto_capture_episode` only fires inside `run_autonomous()` reached via
`loki start <prd>`. The 167 release sessions in 2026 happened in regular
Claude Code, never producing episodes. This module + the MCP capture
tool in `mcp/server.py` + the `loki memory ingest` CLI together close
that gap.

Two entry points:
    - `ingest_from_claude_transcript(path)` -> reads a Claude Code
      session transcript JSONL, extracts tool_use traces, produces an
      EpisodeTrace with populated action_log + files_read + files_modified.
    - `ingest_from_summary(goal, outcome, files_modified, ...)` -> builds
      an episode from explicit fields (used by the MCP capture tool the
      agent calls at iteration close).

Both call `memory.engine.MemoryEngine.store_episode` under the hood.

Safety:
    - Secret scrubber (mirrors memory/error_log.py + v7.7.10) applied
      to goal text, tool inputs, file paths.
    - Honors `LOKI_MEMORY_CAPTURE_DISABLED=true` env var (capture wedge
      escape hatch).
    - Never raises; returns None on any failure and logs to .errors.log.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Local imports deferred to call time to keep this module importable
# without the heavier memory.engine + memory.schemas dependency tree.


# Same scrubber regex set as memory/error_log.py + v7.7.10 USAGE.md regen.
_CREDENTIAL_KEYWORD_RE = re.compile(
    r"(?i)(api[_-]?key|secret|password|token|private[_-]?key|credential|bearer)"
)
_HIGH_ENTROPY_TOKEN_RE = re.compile(
    r"sk-[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|"
    r"ghs_[A-Za-z0-9]{16,}|xox[bpoa]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{32,}|"
    r"AKIA[A-Z0-9]{12,}"
)

# Tool names that indicate a file was READ.
READ_TOOL_NAMES = frozenset({"Read", "ReadFile", "read_file", "Grep", "Glob"})
# Tool names that indicate a file was MODIFIED (created or edited).
WRITE_TOOL_NAMES = frozenset(
    {"Edit", "Write", "MultiEdit", "Patch", "NotebookEdit", "ApplyDiff"}
)
# Tool names that are shell command executions (no specific file).
SHELL_TOOL_NAMES = frozenset({"Bash", "Shell", "Exec"})


def _scrub(text: str) -> str:
    """Redact credential-shaped substrings. Single-pass tokenizer."""
    if not text:
        return text
    out_tokens = []
    for token in text.split():
        if _CREDENTIAL_KEYWORD_RE.search(token):
            out_tokens.append("[REDACTED]")
        else:
            out_tokens.append(_HIGH_ENTROPY_TOKEN_RE.sub("[REDACTED]", token))
    return " ".join(out_tokens)


# v7.7.18 council fix (Opus 2): path-aware redaction for file paths.
# `_scrub` is whitespace-tokenized and misses sensitive paths like
# `/Users/me/.aws/credentials` (no whitespace, no credential keyword).
# Per Opus 2: "Document as known boundary or add path-aware redaction
# (e.g. drop `.aws/`, `.ssh/`, `credentials`, `.env*` segments)."
_SENSITIVE_PATH_SUBSTRINGS = (
    "/.aws/",
    "/.ssh/",
    "/.gnupg/",
    "/.docker/config",
    "/credentials",
    "/.netrc",
    "/.npmrc",
    "/.pypirc",
)
_SENSITIVE_PATH_BASENAMES = (
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.staging",
    "credentials",
    "credentials.json",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
    "private.key",
)


def _scrub_path(path: str) -> str:
    """Redact file paths that point to commonly-sensitive locations.

    Returns the original path if benign; returns a `[REDACTED:<reason>]`
    marker (with the directory portion preserved) if the path looks
    sensitive. Preserves directory context so dashboards can still
    surface "this session touched credential files" without leaking
    the specific file name.
    """
    if not path:
        return path
    # Normalize separators for matching but keep original for return
    norm = path.replace("\\", "/")
    lowered = norm.lower()
    for substr in _SENSITIVE_PATH_SUBSTRINGS:
        if substr in lowered:
            head = path.rsplit("/", 1)[0] if "/" in path else ""
            return f"{head}/[REDACTED:sensitive-dir]" if head else "[REDACTED:sensitive-dir]"
    basename = path.rsplit("/", 1)[-1] if "/" in path else path
    if basename.lower() in _SENSITIVE_PATH_BASENAMES or basename.lower().startswith(".env"):
        head = path.rsplit("/", 1)[0] if "/" in path else ""
        return f"{head}/[REDACTED:sensitive-file]" if head else "[REDACTED:sensitive-file]"
    return path


def _capture_disabled(memory_base: Optional[str] = None) -> bool:
    """True when capture should be skipped.

    Honors the `LOKI_MEMORY_CAPTURE_DISABLED=true` env escape hatch AND
    (v7.7.23 privacy opt-out, excellence bar 6) a per-project
    `.loki/config.json` `{"memory": {"disabled": true}}` flag. When
    `memory_base` is provided (e.g. `<root>/.loki/memory`), the config
    is resolved as its sibling `<root>/.loki/config.json`.
    """
    if os.environ.get("LOKI_MEMORY_CAPTURE_DISABLED", "").lower() in ("true", "1", "yes"):
        return True
    if memory_base:
        # v7.7.23 council fix (Opus 2): FAIL-CLOSED. If a config.json
        # EXISTS but cannot be parsed, the user's intent is ambiguous and
        # the safe privacy default is to SUPPRESS capture (leaked data is
        # irreversible; lost memory is recoverable). Only the no-config
        # case fails open (capture proceeds = default behavior).
        config_path = Path(memory_base).parent / "config.json"
        if config_path.is_file():
            try:
                with open(config_path) as f:
                    cfg = json.load(f)
            except Exception:
                # Config present but unreadable/malformed -> fail closed.
                return True
            if isinstance(cfg, dict) and cfg.get("memory", {}).get("disabled") is True:
                return True
    return False


def _log_to_errors(memory_base: str, function_name: str, exc: BaseException) -> None:
    """Best-effort error log; never raises. Mirrors error_log.log_memory_error
    but accessed lazily so this module imports without circular deps."""
    try:
        from memory.error_log import log_memory_error
        log_memory_error(memory_base, function_name, exc)
    except Exception:
        return


def _parse_transcript_line(line: str) -> Optional[Dict[str, Any]]:
    """Parse one JSONL line; return None on parse error."""
    try:
        return json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None


def _extract_tool_uses(transcript_entries: List[Dict[str, Any]]) -> List[Tuple[str, Dict[str, Any], Optional[str]]]:
    """Walk transcript entries; yield (tool_name, input_dict, timestamp) tuples.

    Claude Code transcript shape (observed v7.7.x): top-level entries
    with `type: assistant|user|...`. Assistant entries have a nested
    `message.content` array containing items with `type: text|tool_use`.
    """
    tool_uses = []
    for entry in transcript_entries:
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message") or {}
        if not isinstance(msg, dict):
            continue
        content = msg.get("content") or []
        if not isinstance(content, list):
            continue
        ts = entry.get("timestamp") or msg.get("timestamp")
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use":
                name = item.get("name", "")
                inp = item.get("input", {})
                if not isinstance(inp, dict):
                    inp = {}
                tool_uses.append((name, inp, ts))
    return tool_uses


def _extract_files(tool_uses: List[Tuple[str, Dict[str, Any], Optional[str]]]) -> Tuple[List[str], List[str]]:
    """Return (files_read, files_modified) deduped, in first-seen order."""
    read_seen: Dict[str, None] = {}
    mod_seen: Dict[str, None] = {}
    for name, inp, _ts in tool_uses:
        path = inp.get("file_path") or inp.get("path") or inp.get("filepath")
        if not isinstance(path, str) or not path:
            continue
        if name in READ_TOOL_NAMES and path not in read_seen:
            read_seen[path] = None
        if name in WRITE_TOOL_NAMES and path not in mod_seen:
            mod_seen[path] = None
    return list(read_seen.keys()), list(mod_seen.keys())


def _build_action_log(
    tool_uses: List[Tuple[str, Dict[str, Any], Optional[str]]],
    start_ts: Optional[datetime],
    max_entries: int = 100,
) -> List[Any]:
    """Convert tool_use tuples to ActionEntry objects (scrubbed).

    Returns a list of `memory.schemas.ActionEntry` instances. Defers the
    import so this module is testable without the full schema chain.
    Caps at `max_entries` to bound episode size on long sessions.
    """
    from memory.schemas import ActionEntry
    entries = []
    for i, (name, inp, ts) in enumerate(tool_uses[:max_entries]):
        rel_ts = 0
        if start_ts and ts:
            try:
                t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                rel_ts = int((t - start_ts).total_seconds())
            except (ValueError, TypeError):
                rel_ts = i
        # Choose a compact input representation
        target = (
            inp.get("file_path")
            or inp.get("path")
            or inp.get("command")
            or inp.get("query")
            or json.dumps(inp, default=str)[:200]
        )
        target = _scrub(str(target))[:300]
        entries.append(ActionEntry(
            tool=name or "?",
            input=target,
            output="",  # transcript does not always include tool_result inline; v7.7.19 may enrich
            timestamp=rel_ts,
        ))
    return entries


def _derive_goal(transcript_entries: List[Dict[str, Any]]) -> str:
    """Best-effort goal extraction: first user message text, OR aiTitle, OR ''."""
    for entry in transcript_entries:
        if entry.get("type") == "user":
            msg = entry.get("message") or {}
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str):
                    return _scrub(content)[:500]
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            t = item.get("text", "")
                            if t:
                                return _scrub(t)[:500]
    for entry in transcript_entries:
        if entry.get("type") == "ai-title":
            title = entry.get("title") or entry.get("aiTitle")
            if title:
                return _scrub(str(title))[:500]
    return ""


def _derive_timestamps(transcript_entries: List[Dict[str, Any]]) -> Tuple[Optional[datetime], Optional[datetime]]:
    """Return (start, end) datetimes from first/last entry with timestamp."""
    timestamps: List[datetime] = []
    for entry in transcript_entries:
        for key in ("timestamp", "ts", "createdAt"):
            v = entry.get(key)
            if v:
                try:
                    timestamps.append(datetime.fromisoformat(str(v).replace("Z", "+00:00")))
                    break
                except (ValueError, TypeError):
                    pass
    if not timestamps:
        return None, None
    return min(timestamps), max(timestamps)


def ingest_from_claude_transcript(
    transcript_path: str,
    memory_base: str,
    *,
    task_id: Optional[str] = None,
    agent: str = "claude-code",
    phase: str = "INTERACTIVE",
    outcome: str = "success",
) -> Optional[str]:
    """Read a Claude Code session transcript JSONL and store an Episode.

    Args:
        transcript_path: Path to a Claude Code session transcript JSONL
            (typically under `~/.claude/projects/<dir>/<session>.jsonl`).
        memory_base: Path to the project's `.loki/memory/` directory.
        task_id: Override the task id. Default: `claude-session-<8-char>`
            from the transcript's `sessionId` field or filename.
        agent: Stamped on the episode. Default "claude-code".
        phase: Stamped on the episode. Default "INTERACTIVE".
        outcome: Stamped on the episode. Default "success".

    Returns:
        Path to the written episode JSON on success; None on failure
        (silent fail, error logged to `.errors.log`).
    """
    if _capture_disabled(memory_base):
        return None
    try:
        path = Path(transcript_path)
        if not path.is_file():
            return None
        # v7.7.18 council fix (Opus 2): cap transcript file size at 50 MB
        # so a runaway transcript cannot OOM the ingester. Long sessions
        # are rare; 50 MB is ~100k tool_use entries which is plenty.
        try:
            file_size = path.stat().st_size
            if file_size > 50 * 1024 * 1024:
                _log_to_errors(
                    memory_base,
                    "ingest_from_claude_transcript",
                    RuntimeError(
                        f"transcript too large ({file_size} bytes); skipping ingest"
                    ),
                )
                return None
        except OSError:
            pass
        entries: List[Dict[str, Any]] = []
        # Also cap entry count at 50k to bound memory regardless of file size.
        MAX_ENTRIES = 50_000
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                obj = _parse_transcript_line(line.strip())
                if obj is not None:
                    entries.append(obj)
                    if len(entries) >= MAX_ENTRIES:
                        break
        if not entries:
            return None

        tool_uses = _extract_tool_uses(entries)
        files_read, files_modified = _extract_files(tool_uses)
        start_ts, end_ts = _derive_timestamps(entries)
        goal = _derive_goal(entries)
        duration = 0
        if start_ts and end_ts:
            duration = max(0, int((end_ts - start_ts).total_seconds()))

        # Derive task_id from transcript metadata or filename
        if task_id is None:
            session_id = None
            for entry in entries:
                sid = entry.get("sessionId") or entry.get("session_id")
                if sid:
                    session_id = str(sid)
                    break
            if not session_id:
                session_id = path.stem
            task_id = f"claude-session-{session_id[:12]}"

        # Lazy imports
        from memory.engine import MemoryEngine, create_storage
        from memory.schemas import EpisodeTrace

        storage = create_storage(memory_base)
        engine = MemoryEngine(storage=storage, base_path=memory_base)
        engine.initialize()

        trace = EpisodeTrace.create(
            task_id=task_id,
            agent=agent,
            phase=phase,
            goal=goal,
        )
        trace.outcome = outcome
        trace.duration_seconds = duration
        # v7.7.18 council fix: apply BOTH scrubbers to file paths --
        # _scrub catches inline credentials, _scrub_path catches sensitive
        # paths the whitespace tokenizer misses (~/.aws/, .env, etc.).
        trace.files_read = [_scrub_path(_scrub(p)) for p in files_read]
        trace.files_modified = [_scrub_path(_scrub(p)) for p in files_modified]
        trace.action_log = _build_action_log(tool_uses, start_ts)

        engine.store_episode(trace)
        # storage.py:439-442 writes to episodic/<date>/task-<id>.json.
        # Reconstruct that path here so the caller gets the real file.
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return str(Path(memory_base) / "episodic" / date_str / f"task-{trace.id}.json")
    except Exception as e:
        _log_to_errors(memory_base, "ingest_from_claude_transcript", e)
        return None


def ingest_from_summary(
    memory_base: str,
    *,
    goal: str,
    outcome: str = "success",
    files_modified: Optional[List[str]] = None,
    files_read: Optional[List[str]] = None,
    tool_calls_summary: Optional[str] = None,
    task_id: Optional[str] = None,
    agent: str = "claude-code-mcp",
    phase: str = "INTERACTIVE",
    duration_seconds: int = 0,
) -> Optional[str]:
    """Build an Episode from explicit summary fields.

    Called by the MCP capture tool when the agent voluntarily reports
    iteration close. Pre-validated inputs; minimal heuristics.

    Returns episode path on success, None on failure.
    """
    if _capture_disabled(memory_base):
        return None
    try:
        from memory.engine import MemoryEngine, create_storage
        from memory.schemas import EpisodeTrace, ActionEntry

        storage = create_storage(memory_base)
        engine = MemoryEngine(storage=storage, base_path=memory_base)
        engine.initialize()

        if task_id is None:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            task_id = f"mcp-capture-{ts}"

        trace = EpisodeTrace.create(
            task_id=task_id,
            agent=agent,
            phase=phase,
            goal=_scrub(goal)[:500],
        )
        trace.outcome = outcome if outcome in ("success", "failure", "partial") else "success"
        trace.duration_seconds = max(0, int(duration_seconds))
        trace.files_read = [_scrub_path(_scrub(p)) for p in (files_read or [])]
        trace.files_modified = [_scrub_path(_scrub(p)) for p in (files_modified or [])]
        if tool_calls_summary:
            trace.action_log = [ActionEntry(
                tool="mcp-summary",
                input=_scrub(tool_calls_summary)[:1000],
                output="",
                timestamp=0,
            )]
        engine.store_episode(trace)
        # storage.py:439-442 writes to episodic/<date>/task-<id>.json.
        # Reconstruct that path here so the caller gets the real file.
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return str(Path(memory_base) / "episodic" / date_str / f"task-{trace.id}.json")
    except Exception as e:
        _log_to_errors(memory_base, "ingest_from_summary", e)
        return None
