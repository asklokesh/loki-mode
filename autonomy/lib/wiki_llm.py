"""wiki_llm.py -- stub-aware LLM invocation + citation validation for R5 wiki.

Keeps every paid-call and grounding-guarantee concern in one place so the
generator and the ask script behave identically.

LLM stub contract (CI-safe, zero paid calls in tests):
  LOKI_WIKI_LLM_STUB unset       -> call the real provider (claude -p / codex / ...)
                                    via the same mechanism loki docs uses; if no
                                    provider is on PATH, return None (callers then
                                    fall back to extractive/template output).
  LOKI_WIKI_LLM_STUB=<file path> -> read the completion from that file.
  LOKI_WIKI_LLM_STUB=<other>     -> use the value literally as the completion.

No third-party dependencies.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path


_LEAN_FLAGS = (
    ("--setting-sources", ["project"]),
    ("--strict-mcp-config", []),
    ("--mcp-config", ['{"mcpServers":{}}']),
    ("--disable-slash-commands", []),
    ("--tools", [""]),
)


def lean_claude_flags():
    """Flags for a one-shot text-only claude child (cost lever L1).

    --bare only when an API key is present (OAuth-only hosts would fail auth);
    otherwise narrowed setting sources. A flag the installed claude does not
    list in --help is dropped, never passed. Returns [] when claude is absent.
    """
    claude = _which("claude")
    if not claude:
        return []
    try:
        help_txt = subprocess.run(
            [claude, "--help"], capture_output=True, text=True, timeout=15,
            stdin=subprocess.DEVNULL,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    if os.environ.get("ANTHROPIC_API_KEY") and "--bare" in help_txt:
        return ["--bare", "--tools", ""] if "--tools" in help_txt else ["--bare"]
    flags = []
    for name, vals in _LEAN_FLAGS:
        if name in help_txt:
            flags.append(name)
            flags.extend(vals)
    return flags


def invoke_llm(prompt, timeout=120, lean=False):
    """Return the LLM completion string, or None if unavailable.

    Honors LOKI_WIKI_LLM_STUB for CI. Otherwise shells out to the configured
    provider, mirroring loki docs `_docs_invoke_provider`. lean=True adds the
    lean child flags for the claude provider.
    """
    stub = os.environ.get("LOKI_WIKI_LLM_STUB")
    if stub is not None:
        # A path to a file with the canned completion, else the literal value.
        if os.path.sep in stub or stub.endswith(".txt"):
            p = Path(stub)
            if p.is_file():
                try:
                    return p.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    return ""
        return stub

    provider = os.environ.get("LOKI_PROVIDER", "claude")
    state_provider = Path(".loki/state/provider")
    if state_provider.is_file():
        try:
            provider = state_provider.read_text().strip() or provider
        except OSError:
            pass

    # Resolve a timeout wrapper if present (matches the bash docs helper).
    timeout_cmd = None
    for cand in ("timeout", "gtimeout"):
        if _which(cand):
            timeout_cmd = cand
            break

    cmds = {
        "claude": ["claude", "-p", prompt],
        "codex": ["codex", "exec", "--sandbox", "workspace-write", prompt],
        "cline": ["cline", "-y", prompt],
        "aider": ["aider", "--message", prompt, "--yes-always", "--no-auto-commits"],
    }
    base = cmds.get(provider)
    if base is None or not _which(base[0]):
        return None
    if lean and provider == "claude":
        base = ["claude", "-p"] + lean_claude_flags() + [prompt]
    cmd = ([timeout_cmd, str(timeout)] + base) if timeout_cmd else base
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout + 10,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 and not out.stdout.strip():
        return None
    return out.stdout


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        cand = os.path.join(d, name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


_CITE_RE = re.compile(r"\[(\d+)\]")


def map_and_validate_citations(answer_text, chunks, root):
    """Map [n] indices in answer_text to real {file,line} citations.

    chunks: the numbered chunk list shown to the LLM. chunks[n-1] is the chunk
    referenced by [n] (1-based). A citation is kept only if:
      - the index is in range (it references a chunk we actually supplied), and
      - the file exists on disk AND start_line <= file length.
    This makes a fabricated citation structurally impossible to survive.

    Returns (clean_text, citations) where citations is a de-duplicated list of
    {"file": rel, "line": int} in first-appearance order, and clean_text has the
    [n] markers rewritten to [file:line] for human-readable output.
    """
    root = Path(root)
    citations = []
    seen = set()

    def _resolve(idx):
        if idx < 1 or idx > len(chunks):
            return None
        ch = chunks[idx - 1]
        rel = ch.get("file")
        line = int(ch.get("start_line", 1))
        abs_path = root / rel
        try:
            if not abs_path.is_file():
                return None
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                nlines = sum(1 for _ in f)
        except OSError:
            return None
        if line < 1 or line > max(nlines, 1):
            return None
        return {"file": rel, "line": line}

    def _sub(m):
        idx = int(m.group(1))
        cite = _resolve(idx)
        if cite is None:
            return ""  # drop a bogus/non-resolving citation marker
        key = (cite["file"], cite["line"])
        if key not in seen:
            seen.add(key)
            citations.append(cite)
        return "[%s:%d]" % (cite["file"], cite["line"])

    clean = _CITE_RE.sub(_sub, answer_text or "")
    # Collapse any double spaces left by dropped markers.
    clean = re.sub(r"[ \t]{2,}", " ", clean)
    return clean, citations
