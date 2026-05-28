"""v7.7.17: structured error log for memory subsystem failures.

Replaces the silent-fail (`except Exception: pass`) pattern in
`autonomy/run.sh` memory call sites with explicit error logging to
`.loki/memory/.errors.log`. Surfaces in `loki doctor --json` so
developers see regressions early.

Record format (tab-separated, one record per line):
    <iso_timestamp>\\t<function_name>\\t<error_class>\\t<message>\\t<traceback_snippet>

Rotation:
    - At 10 MB the current file is renamed to `.errors.log.1`.
    - Older generations shift down (`.1` -> `.2` -> `.3`).
    - Up to 3 historical files retained; older ones are dropped.

Failure mode:
    - Logging never raises. If the log itself is unwriteable (perms,
      read-only fs, full disk) the call silently drops the record.
      Observability must not break the memory pipeline.
"""
from __future__ import annotations

import re
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import List

MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_HISTORICAL_FILES = 3
# Doctor surface and read_recent_errors only consider the tail of the file.
# Prevents an OOM on the doctor command if rotation ever fails (perms,
# disk full mid-rotation, or external writer appending).
TAIL_READ_BYTES = 64 * 1024  # 64 KB

# v7.7.17 (council fix Opus 2): scrub credential-shaped substrings from
# exception messages before writing to .errors.log. Doctor --json is
# commonly pasted into bug reports / chats; without this scrub, a stray
# `RuntimeError: Bearer sk-...` would leak.
# Mirrors the v7.7.10 USAGE.md regen scrubber (autonomy/run.sh).
_CREDENTIAL_KEYWORD_RE = re.compile(
    r"(?i)(api[_-]?key|secret|password|token|private[_-]?key|credential|bearer)"
)
_HIGH_ENTROPY_TOKEN_RE = re.compile(
    r"sk-[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|"
    r"ghs_[A-Za-z0-9]{16,}|xox[bpoa]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{32,}|"
    r"AKIA[A-Z0-9]{12,}"
)


def _scrub(text: str) -> str:
    """Redact credential-shaped substrings from `text`.

    Two passes:
        1. Any token containing a credential keyword: replace the whole
           token (whitespace-delimited) with `[REDACTED]`.
        2. Any literal high-entropy token shape (Stripe sk-, GitHub
           ghp_/ghs_, Slack xox*, GCP AIza, AWS AKIA): replace inline
           with `[REDACTED]`.
    """
    if not text:
        return text
    scrubbed_tokens = []
    for token in text.split():
        if _CREDENTIAL_KEYWORD_RE.search(token):
            scrubbed_tokens.append("[REDACTED]")
        else:
            scrubbed_tokens.append(_HIGH_ENTROPY_TOKEN_RE.sub("[REDACTED]", token))
    return " ".join(scrubbed_tokens)


def _errors_log_path(memory_base: str) -> Path:
    return Path(memory_base) / ".errors.log"


def _rotate_if_needed(path: Path) -> None:
    """Rotate `path` if it has grown past MAX_LOG_SIZE_BYTES.

    Sequence (for MAX_HISTORICAL_FILES=3):
        1. If `path.log.3` exists, delete it (it falls off the back).
        2. Shift `path.log.2` -> `path.log.3`, `path.log.1` -> `path.log.2`.
        3. Rename `path` -> `path.log.1`.

    All failures are silently absorbed via fallback truncation. The
    caller cannot afford rotation errors to propagate.
    """
    try:
        if not path.exists() or path.stat().st_size < MAX_LOG_SIZE_BYTES:
            return
        # Drop oldest generation
        oldest = path.with_suffix(f".log.{MAX_HISTORICAL_FILES}")
        if oldest.exists():
            oldest.unlink()
        # Shift older -> newer (going from N-1 down to 1)
        for n in range(MAX_HISTORICAL_FILES - 1, 0, -1):
            src = path.with_suffix(f".log.{n}")
            dst = path.with_suffix(f".log.{n + 1}")
            if src.exists():
                src.rename(dst)
        # Move current -> .log.1
        path.rename(path.with_suffix(".log.1"))
    except OSError:
        # Last-ditch: try to truncate the current file so future writes
        # do not keep failing. Silent on failure.
        try:
            path.unlink()
        except OSError:
            pass


def log_memory_error(memory_base: str, function_name: str, exc: BaseException) -> None:
    """Append a structured error record to `<memory_base>/.errors.log`.

    Never raises. Falls back to silent drop if the log is unwriteable.

    Args:
        memory_base: Absolute or relative path to a `.loki/memory/`
            directory. Will be created if missing.
        function_name: Short identifier of the call site (e.g.
            "store_episode_trace", "auto_capture_episode").
        exc: The caught exception to record.
    """
    try:
        memory_dir = Path(memory_base)
        memory_dir.mkdir(parents=True, exist_ok=True)
        log_path = _errors_log_path(memory_base)
        _rotate_if_needed(log_path)
        # Tab-separated single-line record. Replace embedded tabs/newlines
        # in user-provided strings so the format stays parseable.
        tb_snippet = "".join(
            traceback.format_exception_only(type(exc), exc)
        ).strip()[:200].replace("\t", " ").replace("\n", " ")
        msg = str(exc).replace("\t", " ").replace("\n", " ")[:200]
        # v7.7.17 council fix (Opus 2): scrub credentials BEFORE writing
        # to disk so doctor --json (often pasted in bug reports) cannot
        # leak Bearer tokens, API keys, etc. embedded in exception text.
        msg = _scrub(msg)
        tb_snippet = _scrub(tb_snippet)
        record = "\t".join([
            datetime.now(timezone.utc).isoformat(),
            function_name,
            type(exc).__name__,
            msg,
            tb_snippet,
        ])
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(record + "\n")
    except Exception:
        return


def read_recent_errors(memory_base: str, limit: int = 5) -> List[str]:
    """Read the last `limit` error records as raw lines (oldest-to-newest).

    Returns an empty list if the log does not exist or cannot be read.
    Never raises. The current file only is read (historical rotated
    files are not consulted; recent enough for the doctor surface).

    v7.7.17 council fix (Opus 2): seeks from end and reads at most
    TAIL_READ_BYTES so an oversize log (rotation failed, disk-full
    mid-rotate, external writer) cannot OOM the doctor command.
    """
    log_path = _errors_log_path(memory_base)
    if not log_path.exists():
        return []
    try:
        with open(log_path, "rb") as f:
            f.seek(0, 2)  # end
            size = f.tell()
            offset = max(0, size - TAIL_READ_BYTES)
            f.seek(offset)
            chunk = f.read()
        text = chunk.decode("utf-8", errors="replace")
        # If we seeked into the middle of a line, drop the (possibly
        # corrupt) first partial line.
        lines = text.split("\n")
        if offset > 0 and lines:
            lines = lines[1:]
        lines = [ln.strip() for ln in lines if ln.strip()]
        return lines[-limit:]
    except OSError:
        return []
