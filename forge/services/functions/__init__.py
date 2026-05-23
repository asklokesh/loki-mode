"""Forge edge functions service.

A forge function is a small piece of code (TypeScript/JavaScript via Bun
in F-2, Python via the existing sandbox image in F-4, Deno parity in
F-4) that runs in response to HTTP, cron, webhook, or event triggers.

Storage layout under <forge_dir>/functions/<name>/:
    manifest.json   - runtime, entry, env_secrets[], timeout_ms, memory_mb,
                      triggers[], versions[]
    versions/<n>/   - per-version source (atomic deploy + rollback)
    logs/           - structured per-invocation log files

Invocation contract: the request is JSON-serialised into a temp file;
the function reads it from stdin, writes its JSON response to stdout.
Non-zero exit codes are surfaced to callers as errors.
"""

from __future__ import annotations

from .deploy import (  # noqa: F401
    FunctionError,
    deploy,
    delete_function,
    get_function,
    list_functions,
    list_versions,
    rollback,
)
from .invoke import invoke  # noqa: F401
from .logs import list_runs, read_run_log  # noqa: F401
