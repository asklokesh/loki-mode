"""Forge SDK generation.

Takes a live forge state snapshot (or a JSON dump of it) and emits
typed SDK source files the user's app can import. Supported targets:

    typescript - Bun/Node/Deno; runtime: fetch + WebSocket
    python     - 3.10+; runtime: httpx + websockets (optional)

Future targets (F-5 follow-ups): kotlin, swift, go. The codegen is
deterministic so the same forge state always produces the same SDK
bytes - critical for diff-friendly check-in.
"""

from __future__ import annotations

from .codegen import (  # noqa: F401
    GenError,
    generate,
    list_targets,
    SUPPORTED_TARGETS,
)
