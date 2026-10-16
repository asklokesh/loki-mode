"""P12-26b: Python entry to the shared Claude permission policy.

New file: the python launch sites (dashboard, magic) need the same argv as the
bash and TS routes; this is a thin caller of src/policies/claude_permissions.js
(the single compiler), not a second implementation. Unset LOKI_PERMISSION_POLICY
returns the legacy flag byte-identically.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

_LEGACY = ["--dangerously-skip-permissions"]
_FAIL_CLOSED = ["--permission-mode", "plan"]


def claude_permission_argv(project_dir: str | None = None, env: dict | None = None) -> list:
    env = os.environ if env is None else env
    if env.get("LOKI_PERMISSION_POLICY", "") != "compiled":
        return list(_LEGACY)
    helper = Path(__file__).resolve().parents[2] / "src" / "policies" / "claude_permissions.js"
    node = shutil.which("node")
    if node is None or not helper.is_file():
        print("[loki] WARNING: LOKI_PERMISSION_POLICY=compiled: compiler unavailable; using most restrictive mode (plan)", file=sys.stderr)
        return list(_FAIL_CLOSED)
    target = project_dir or env.get("LOKI_PROJECT_DIR") or os.getcwd()
    try:
        done = subprocess.run([node, str(helper), str(target)], capture_output=True, text=True,
                              timeout=30, env=dict(env), check=False)
    except (OSError, subprocess.SubprocessError):
        return list(_FAIL_CLOSED)
    if done.stderr:
        sys.stderr.write(done.stderr)
    args = [a for a in done.stdout.split("\n") if a]
    if done.returncode != 0 or not args:
        return list(_FAIL_CLOSED)
    return args
