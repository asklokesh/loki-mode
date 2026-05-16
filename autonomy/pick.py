#!/usr/bin/env python3
"""
loki pick - Retro-pixel agent/provider picker (v7.6.0)

Interactive picker that lets the user choose which provider to launch.
Drawn with box-drawing and shading characters; no external dependencies.
Falls back to a plain list when stdin is not a TTY.

Mirrors the LAP agent picker UX but ships nine providers (vs LAP's three)
and surfaces credential availability + degraded-mode tier inline.

Exit codes:
  0 - selection made, command printed to stdout (and copied to clipboard
      when an OSC 52 sequence can be emitted)
  1 - cancelled (q / ESC / Ctrl-C / no TTY + no --provider)
  2 - argument or runtime error
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import termios
import tty
from dataclasses import dataclass
from typing import List, Optional


# ANSI escape sequences -------------------------------------------------------
CSI = "\x1b["
RESET = CSI + "0m"
BOLD = CSI + "1m"
DIM = CSI + "2m"
INV = CSI + "7m"
FG_CYAN = CSI + "36m"
FG_BRIGHT_CYAN = CSI + "96m"
FG_YELLOW = CSI + "33m"
FG_GREEN = CSI + "32m"
FG_RED = CSI + "31m"
FG_GREY = CSI + "90m"
FG_WHITE = CSI + "97m"

# Pixel-art LOKI MODE banner. Block chars only (no emoji). Reads "L O K I".
BANNER = [
    "  ##      ######   ##   ##   ######",
    "  ##      ##  ##   ##  ##      ##",
    "  ##      ##  ##   ####        ##",
    "  ##      ##  ##   ##  ##      ##",
    "  ######  ######   ##   ##   ######",
]


@dataclass
class Provider:
    name: str
    label: str
    tagline: str
    tier: int          # 1=full features, 2=reduced, 3=degraded
    env_var: str       # which env var would carry its credential
    command: str       # what `loki pick` will print on selection
    binary: str        # CLI binary we check on PATH for availability


PROVIDERS: List[Provider] = [
    Provider(
        name="claude",
        label="claude",
        tagline="Anthropic - Claude Code (full features, Task tool, parallel)",
        tier=1,
        env_var="ANTHROPIC_API_KEY",
        command="loki start --provider claude",
        binary="claude",
    ),
    Provider(
        name="cline",
        label="cline",
        tagline="VSCode - Cline (reduced parallelism)",
        tier=2,
        env_var="ANTHROPIC_API_KEY",
        command="loki start --provider cline",
        binary="cline",
    ),
    Provider(
        name="codex",
        label="codex",
        tagline="OpenAI - Codex CLI (sequential only, no Task tool)",
        tier=3,
        env_var="OPENAI_API_KEY",
        command="loki start --provider codex",
        binary="codex",
    ),
    Provider(
        name="gemini",
        label="gemini",
        tagline="Google - Gemini CLI (sequential only, no Task tool)",
        tier=3,
        env_var="GOOGLE_API_KEY",
        command="loki start --provider gemini",
        binary="gemini",
    ),
    Provider(
        name="aider",
        label="aider",
        tagline="Aider (degraded mode)",
        tier=3,
        env_var="OPENAI_API_KEY",
        command="loki start --provider aider",
        binary="aider",
    ),
]


# Special meta-entries appended after providers. Surfacing these here is the
# headline differentiator vs the LAP picker (which only lists agent harnesses).
META_ENTRIES: List[Provider] = [
    Provider(
        name="heal",
        label="heal     ",
        tagline="Legacy system healing (Amazon AGI Lab patterns, v6.67+)",
        tier=1,
        env_var="",
        command="loki heal .",
        binary="loki",
    ),
    Provider(
        name="sandbox",
        label="sandbox  ",
        tagline="Hardened Docker sandbox + diagnose (v7.6 LAP-parity)",
        tier=1,
        env_var="",
        command="loki sandbox start",
        binary="docker",
    ),
    Provider(
        name="dashboard",
        label="dashboard",
        tagline="Live FastAPI dashboard (100+ endpoints, WebSocket)",
        tier=1,
        env_var="",
        command="loki dashboard",
        binary="python3",
    ),
    Provider(
        name="memory",
        label="memory   ",
        tagline="Episodic / semantic memory explorer",
        tier=1,
        env_var="",
        command="loki memory index",
        binary="python3",
    ),
]


def _has_binary(name: str) -> bool:
    return shutil.which(name) is not None


def _has_credential(env_var: str) -> bool:
    if not env_var:
        return True
    return bool(os.environ.get(env_var, ""))


def _tier_marker(tier: int) -> str:
    # Three filled blocks for tier 1, two for tier 2, one for tier 3.
    filled = {1: "###", 2: "## ", 3: "#  "}[tier]
    color = {1: FG_GREEN, 2: FG_YELLOW, 3: FG_RED}[tier]
    return f"{color}[{filled}]{RESET}"


def _render(entries: List[Provider], selected: int, term_cols: int,
            version: str) -> str:
    out: List[str] = []
    # Banner.
    for line in BANNER:
        out.append(f"{FG_BRIGHT_CYAN}{line}{RESET}")
    out.append("")
    sub = f"loki-mode {version} - multi-agent sandbox - vault-stubbed credentials"
    out.append(f"  {DIM}{sub}{RESET}")
    out.append("")
    out.append(f"  {BOLD}Pick a provider{RESET}     "
               f"{DIM}up/down to move, Enter to open, q to cancel{RESET}")
    out.append("")

    for i, p in enumerate(entries):
        marker = "->" if i == selected else "  "
        cred_ok = _has_credential(p.env_var)
        bin_ok = _has_binary(p.binary)
        cred_glyph = ("ok " if (cred_ok and bin_ok) else "miss")
        cred_color = FG_GREEN if (cred_ok and bin_ok) else FG_RED
        tier = _tier_marker(p.tier)
        # Truncate tagline to fit narrow terms.
        tagline_max = max(20, term_cols - 60)
        tagline = p.tagline
        if len(tagline) > tagline_max:
            tagline = tagline[: tagline_max - 1] + "."
        line = (f"  {FG_CYAN}{marker}{RESET}  "
                f"{BOLD}{p.label:10s}{RESET}  "
                f"{tier}  "
                f"{cred_color}{cred_glyph}{RESET}  "
                f"{tagline}")
        if i == selected:
            line += f"   {DIM}{p.command}{RESET}"
        out.append(line)

    out.append("")
    out.append(f"  {DIM}One terminal command opens a sandboxed coding agent.{RESET}")
    out.append(f"  {DIM}Phase A (shipped): sandbox config + diagnose + reserved-key "
               f"contract.{RESET}")
    out.append(f"  {DIM}Phase B (coming): vault sidecar swaps stub credentials at "
               f"egress.{RESET}")
    return "\n".join(out)


def _read_key() -> str:
    """Read one keystroke; return a normalized name."""
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = os.read(fd, 1).decode("utf-8", errors="replace")
        if ch == "\x1b":
            # Could be an arrow key. Read up to two more bytes.
            try:
                ch2 = os.read(fd, 1).decode("utf-8", errors="replace")
                ch3 = os.read(fd, 1).decode("utf-8", errors="replace")
            except OSError:
                return "ESC"
            seq = ch + ch2 + ch3
            return {
                "\x1b[A": "UP",
                "\x1b[B": "DOWN",
                "\x1b[C": "RIGHT",
                "\x1b[D": "LEFT",
            }.get(seq, "ESC")
        if ch in ("\r", "\n"):
            return "ENTER"
        if ch == "\x03":
            return "INT"  # Ctrl-C
        if ch == "\t":
            return "TAB"
        if ch.lower() == "q":
            return "Q"
        if ch.lower() == "j":
            return "DOWN"
        if ch.lower() == "k":
            return "UP"
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _load_version() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "VERSION"),
        os.path.join(os.getcwd(), "VERSION"),
    ]
    for p in candidates:
        try:
            with open(p, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            continue
    return "unknown"


def _emit_clipboard(text: str) -> None:
    # OSC 52: terminals that support it copy the payload to the system clipboard.
    # Silently ignored by terminals that don't.
    import base64
    payload = base64.b64encode(text.encode("utf-8")).decode("ascii")
    sys.stderr.write(f"\x1b]52;c;{payload}\x07")
    sys.stderr.flush()


def _interactive(entries: List[Provider], version: str) -> Optional[Provider]:
    cols = shutil.get_terminal_size((80, 24)).columns
    selected = 0
    # Hide cursor while drawing.
    sys.stderr.write(CSI + "?25l")
    sys.stderr.flush()
    try:
        while True:
            screen = _render(entries, selected, cols, version)
            sys.stderr.write("\x1b[2J\x1b[H" + screen + "\n")
            sys.stderr.flush()
            key = _read_key()
            if key == "UP":
                selected = (selected - 1) % len(entries)
            elif key == "DOWN" or key == "TAB":
                selected = (selected + 1) % len(entries)
            elif key == "ENTER":
                return entries[selected]
            elif key in ("Q", "ESC", "INT"):
                return None
            elif key.isdigit():
                idx = int(key) - 1
                if 0 <= idx < len(entries):
                    selected = idx
    finally:
        # Restore cursor + clear screen.
        sys.stderr.write(CSI + "?25h")
        sys.stderr.flush()


def _plain_list(entries: List[Provider]) -> None:
    for i, p in enumerate(entries, 1):
        tier = {1: "tier-1", 2: "tier-2", 3: "tier-3"}[p.tier]
        sys.stdout.write(f"{i:2d}  {p.name:10s}  {tier:7s}  {p.tagline}\n")
        sys.stdout.write(f"      command: {p.command}\n")


def _json_output(entries: List[Provider]) -> None:
    data = [
        {
            "name": p.name,
            "tier": p.tier,
            "tagline": p.tagline,
            "env_var": p.env_var,
            "binary": p.binary,
            "binary_present": _has_binary(p.binary),
            "credential_present": _has_credential(p.env_var),
            "command": p.command,
            "category": "provider" if p in PROVIDERS else "meta",
        }
        for p in entries
    ]
    sys.stdout.write(json.dumps({
        "schema": "loki.pick/v1",
        "version": _load_version(),
        "entries": data,
    }, indent=2) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="loki pick",
        description="Retro-pixel picker for Loki Mode providers and entry points.",
    )
    parser.add_argument("--list", action="store_true",
                        help="non-interactive plain list (also auto-used if stdin is not a TTY)")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable JSON (schema loki.pick/v1)")
    parser.add_argument("--providers-only", action="store_true",
                        help="omit the meta entries (heal, sandbox, dashboard, memory)")
    parser.add_argument("--no-clipboard", action="store_true",
                        help="skip the OSC 52 clipboard emit on selection")
    args = parser.parse_args(argv)

    entries = list(PROVIDERS)
    if not args.providers_only:
        entries.extend(META_ENTRIES)

    if args.json:
        _json_output(entries)
        return 0

    if args.list or not sys.stdin.isatty():
        _plain_list(entries)
        return 0

    version = _load_version()
    choice = _interactive(entries, version)
    if choice is None:
        sys.stderr.write("cancelled\n")
        return 1

    if not args.no_clipboard:
        _emit_clipboard(choice.command)

    # Stdout gets ONLY the command, so callers can pipe it directly:
    #   eval "$(loki pick)"
    sys.stdout.write(choice.command + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
