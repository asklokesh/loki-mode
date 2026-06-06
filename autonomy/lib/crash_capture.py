#!/usr/bin/env python3
"""Crash context capture for Loki Mode (Phase 0, local-only, no egress).

Builds the raw pre-scrub crash context, runs it through the shared scrubber
(crash_redact.scrub_and_whitelist), and writes the WHITELISTED payload to
.loki/crash/<fingerprint>-<unixts>.json. Never writes unscrubbed data. There is
no network egress in Phase 0.

FAIL CLOSED: if any step fails such that we cannot guarantee a scrubbed result,
exit nonzero and write nothing rather than risk a leak. If the scrubber returns
its safe minimal (ScrubError) shape we still write that record so we have a
trace, but it carries no raw data.
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

# Make crash_redact importable regardless of cwd (same trick as
# proof-generator.py lines 32-37).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import crash_redact  # noqa: E402


def _read_loki_version():
    """Read VERSION from the repo root (../../VERSION relative to this file).

    Best-effort; returns None if unreadable.
    """
    try:
        path = os.path.normpath(os.path.join(_HERE, "..", "..", "VERSION"))
        with open(path, "r") as f:
            v = f.read().strip()
            return v or None
    except Exception:
        return None


def _discover_runtime_version(env_keys, cmd):
    """Best-effort runtime version. Tries env keys first, then `<cmd> --version`.

    Never raises; returns None on any failure.
    """
    for key in env_keys:
        val = os.environ.get(key)
        if val:
            return val.strip()
    try:
        exe = shutil.which(cmd)
        if not exe:
            return None
        proc = subprocess.run(
            [exe, "--version"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        out = (proc.stdout or proc.stderr or "").strip()
        return out.splitlines()[0].strip() if out else None
    except Exception:
        return None


def _discover_git_remote(cwd=None):
    """Best-effort git remote origin URL via git config. Never raises."""
    try:
        target = cwd or os.getcwd()
        exe = shutil.which("git")
        if not exe:
            return None
        proc = subprocess.run(
            [exe, "-C", target, "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        out = (proc.stdout or "").strip()
        return out or None
    except Exception:
        return None


def _captured_at():
    """UTC timestamp, second precision. Uses datetime.now(timezone.utc) (NOT the
    banned utcnow())."""
    try:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


def build_raw_context(
    error_class,
    message,
    stack,
    rarv_phase=None,
    exit_code=None,
    friction_kind=None,
):
    """Assemble the raw, pre-scrub crash context.

    It is FINE for raw to contain unsafe data (message, full stack with paths,
    git remote). The scrub step strips and whitelists everything next. The
    returned dict is NEVER written to disk directly.
    """
    raw = {
        "os": platform.system() or None,
        "arch": platform.machine() or None,
        "loki_version": _read_loki_version(),
        "node_version": _discover_runtime_version(
            ["LOKI_NODE_VERSION", "NODE_VERSION"], "node"
        ),
        "bun_version": _discover_runtime_version(
            ["LOKI_BUN_VERSION", "BUN_VERSION"], "bun"
        ),
        "error_class": error_class,
        "message": message,
        # Raw frames; normalize_stack inside scrub reduces these to symbols.
        "stack": stack if isinstance(stack, list) else (
            stack.splitlines() if isinstance(stack, str) else []
        ),
        "rarv_phase": rarv_phase,
        "exit_code": exit_code,
        "friction_kind": friction_kind,
        "captured_at": _captured_at(),
    }
    return raw


def capture(
    error_class,
    message,
    stack,
    rarv_phase=None,
    exit_code=None,
    friction_kind=None,
    target_dir=None,
):
    """Build raw context, scrub, and write the whitelisted payload.

    Writes to <target_dir or cwd>/.loki/crash/<fingerprint>-<unixts>.json.
    Returns the written path, or None if the write itself failed.

    NEVER writes unscrubbed data. If scrub returns the safe minimal (ScrubError)
    shape, that minimal dict is still written (under a scruberror-<ts> name,
    since it carries no fingerprint) so a trace exists with no leak.
    """
    raw = build_raw_context(
        error_class=error_class,
        message=message,
        stack=stack,
        rarv_phase=rarv_phase,
        exit_code=exit_code,
        friction_kind=friction_kind,
    )

    base = target_dir or os.getcwd()
    home = os.environ.get("HOME")
    repo_root = _detect_repo_root(base)
    git_remote = _discover_git_remote(base)

    scrubbed = crash_redact.scrub_and_whitelist(
        raw,
        home=home,
        repo_root=repo_root,
        git_remote=git_remote,
    )

    if not isinstance(scrubbed, dict):
        # Defensive: scrub_and_whitelist always returns a dict, but never trust.
        scrubbed = {
            "error_class": "ScrubError",
            "rules_version": crash_redact.CRASH_RULES_VERSION,
            "redactions_count": 0,
        }

    ts = int(time.time())
    fingerprint = scrubbed.get("fingerprint")
    if isinstance(fingerprint, str) and fingerprint:
        name = "{}-{}.json".format(fingerprint, ts)
    else:
        # ScrubError shape has no fingerprint; still write a trace.
        name = "scruberror-{}.json".format(ts)

    crash_dir = os.path.join(base, ".loki", "crash")
    try:
        os.makedirs(crash_dir, exist_ok=True)
        out_path = os.path.join(crash_dir, name)
        with open(out_path, "w") as f:
            json.dump(scrubbed, f, indent=2, sort_keys=True)
        return out_path
    except Exception:
        # Fail closed: if we cannot write the scrubbed file, write nothing.
        return None


def _detect_repo_root(start):
    """Best-effort: walk up from start to find a .git directory. Never raises."""
    try:
        cur = os.path.abspath(start)
        while True:
            if os.path.isdir(os.path.join(cur, ".git")):
                return cur
            parent = os.path.dirname(cur)
            if parent == cur:
                return None
            cur = parent
    except Exception:
        return None


def _main():
    parser = argparse.ArgumentParser(
        description="Capture and scrub a Loki Mode crash report (local only)."
    )
    parser.add_argument("--error-class", default="UnknownError")
    parser.add_argument("--message", default="")
    parser.add_argument(
        "--stack",
        default=None,
        help="Stack/traceback text. If omitted, read from stdin.",
    )
    parser.add_argument("--rarv-phase", default=None)
    parser.add_argument("--exit-code", default=None)
    parser.add_argument("--friction-kind", default=None)
    parser.add_argument("--target-dir", default=None)
    args = parser.parse_args()

    stack_text = args.stack
    # Read the stack from stdin when --stack is omitted (None) OR when it is the
    # explicit "-" sentinel. The bash hook (autonomy/crash.sh) passes
    # `--stack -` while piping the real stack to stdin; treating "-" as the
    # stdin sentinel keeps the bash and TS routes producing the same
    # stack_signature (and therefore the same fingerprint) for one crash.
    if stack_text is None or stack_text == "-":
        try:
            if not sys.stdin.isatty():
                stack_text = sys.stdin.read()
            else:
                stack_text = ""
        except Exception:
            stack_text = ""
    stack_text = stack_text or ""

    exit_code = args.exit_code
    if exit_code is not None:
        try:
            exit_code = int(exit_code)
        except (TypeError, ValueError):
            # Keep as-is; scrub drops it unless whitelisted, and it is.
            pass

    path = capture(
        error_class=args.error_class,
        message=args.message,
        stack=stack_text,
        rarv_phase=args.rarv_phase,
        exit_code=exit_code,
        friction_kind=args.friction_kind,
        target_dir=args.target_dir,
    )

    if path is None:
        # Fail closed: nothing written, signal failure.
        sys.exit(1)
    print(path)
    sys.exit(0)


if __name__ == "__main__":
    try:
        _main()
    except SystemExit:
        raise
    except Exception:
        # FAIL CLOSED: any unexpected failure exits nonzero, writes nothing.
        sys.exit(1)
