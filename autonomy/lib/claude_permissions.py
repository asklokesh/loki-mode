"""P12-26b: Python entry to the shared Claude permission policy.

New file: the python launch sites (dashboard, magic) need the same argv as the
bash and TS routes; this is a thin caller of src/policies/claude_permissions.js
(the single compiler), not a second implementation. LOKI_PERMISSION_POLICY=legacy returns
the legacy flag byte-identically; unset resolves to compiled only when an operator
claude_permissions policy exists (asked of the same js helper), else legacy (C-C2).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

_FAIL_CLOSED = ["--permission-mode", "plan"]
_unknown_warned = False


def _has_operator_policy(node: str | None, helper: Path, env: dict) -> bool:
    if node is None or not helper.is_file():
        return False
    try:
        done = subprocess.run([node, str(helper), "--has-operator-policy"], capture_output=True,
                              text=True, timeout=30, env=dict(env), check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.stdout.strip() == "1"


def _legacy_argv(env: dict) -> list:
    """Legacy bypass flag plus the default web/credential deny rules (w2-07), from the same js helper.

    An unusable compiler fails closed to plan with a warning, like compiled mode and the TS route.
    """
    helper = Path(__file__).resolve().parents[2] / "src" / "policies" / "claude_permissions.js"
    node = shutil.which("node")
    if node is None or not helper.is_file():
        print("[loki] WARNING: legacy permission policy: compiler unavailable; using most restrictive mode (plan)", file=sys.stderr)
        return list(_FAIL_CLOSED)
    try:
        done = subprocess.run([node, str(helper), "--legacy-args"], capture_output=True, text=True,
                              timeout=30, env=dict(env), check=False)
    except (OSError, subprocess.SubprocessError):
        return list(_FAIL_CLOSED)
    if done.stderr:
        sys.stderr.write(done.stderr)
    args = [a for a in done.stdout.split("\n") if a]
    return args if done.returncode == 0 and args else list(_FAIL_CLOSED)


def claude_permission_argv(project_dir: str | None = None, env: dict | None = None) -> list:
    env = os.environ if env is None else env
    mode = env.get("LOKI_PERMISSION_POLICY", "")
    if mode == "legacy":
        return _legacy_argv(env)
    global _unknown_warned
    helper = Path(__file__).resolve().parents[2] / "src" / "policies" / "claude_permissions.js"
    node = shutil.which("node")
    if mode == "" and not _has_operator_policy(node, helper, env):
        return _legacy_argv(env)
    if mode not in ("", "compiled") and not _unknown_warned:
        _unknown_warned = True
        print(f"[loki] WARNING: LOKI_PERMISSION_POLICY={mode}: unknown value; using compiled", file=sys.stderr)
    if node is None or not helper.is_file():
        print("[loki] WARNING: compiled permission policy: compiler unavailable; using most restrictive mode (plan)", file=sys.stderr)
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
