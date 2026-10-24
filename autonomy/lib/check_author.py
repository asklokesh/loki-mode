#!/usr/bin/env python3
"""Check-author context (moat P3, interface A in tests/moat/p3-the-wall.sh).

  check_author.py context --spec <file> --repo <dir>

Prints ONE JSON object on stdout: the exact and complete input handed to the
check-authoring model. No model call, no network, deterministic.

  {"spec_sha256": "<hex>", "inputs": [{"path", "sha256"}...], "prompt": "<text>"}

Input selection mirrors the engine10 Wall (loki-ts/src/features/wall_manifest_wire.ts,
the manifest builder wallManifestFor) and is deliberately narrower: of the files
the Wall manifest reads, only the CONFIG class (runner and project config, same
regex as CONFIG there, applied anchored to the whole repo-relative path, so
only root-level config files qualify) is kept. Files come from git ls-files
(tracked regular files, no symlinks), never a filesystem walk, so untracked and
ignored files cannot reach the author. A non-git --repo fails closed: spec only.
Same MAX_BLOB size cap and control-character path rule as the Wall. The Wall's
other two classes are implementation-bearing and are excluded here: TESTISH test
sources (style examples) and "named" source files (signatures of files the task
names). Anything outside the spec and CONFIG files never reaches the author.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

# Mirrors CONFIG, MAX_BLOB, MAX_FILES in wall_manifest_wire.ts.
CONFIG = re.compile(
    r"^(package\.json|bunfig\.toml|(vitest|jest)\.config\.[cm]?[jt]s|pytest\.ini|"
    r"pyproject\.toml|setup\.cfg|tox\.ini|go\.mod|Cargo\.toml)$"
)
MAX_BLOB = 200_000
MAX_FILES = 300
# Mirrors TESTISH in wall_manifest_wire.ts.
TESTISH = re.compile(r"(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]*\.py$|_test\.(py|go)$")
CTRL = re.compile(r"[\x00-\x1f\x7f]")

PROMPT_HEAD = (
    "You are the acceptance check author. You see only the specification and the "
    "project's runner configuration below. You cannot see the implementation. "
    "Write acceptance checks that prove the specification is met."
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def config_files(repo: str, spec_real: str):
    found = []
    for rel in tracked_regular_files(repo) or []:
        # Anchored CONFIG against the whole repo-relative path, as the Wall does
        # (CONFIG.test(e.path)): only root-level config files qualify.
        if not CONFIG.match(rel) or TESTISH.search(rel) or CTRL.search(rel):
            continue
        full = os.path.join(repo, rel)
        if os.path.islink(full) or not os.path.isfile(full) or os.path.realpath(full) == spec_real:
            continue
        try:
            if os.path.getsize(full) > MAX_BLOB:
                continue
        except OSError:
            continue
        found.append((rel, full))
        if len(found) >= MAX_FILES:
            break
    return found


def tracked_regular_files(repo: str):
    """git ls-files regular blobs (modes 100644/100755), like the Wall's ls-tree
    read. None when repo is not a git repo or git fails: the caller fails closed."""
    # Hardening mirrors SAFE_GIT_CONFIG in loki-ts/src/util/safe_git.ts: a repo-planted
    # fsmonitor, hook or ssh command must never run, and a caller GIT_DIR must not
    # redirect the listing.
    env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    try:
        r = subprocess.run(["git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null",
                            "-c", "core.sshCommand=", "-c", "protocol.ext.allow=never",
                            "-C", repo, "--no-replace-objects", "ls-files", "-s", "-z"],
                           capture_output=True, timeout=10, check=False, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    out = []
    for raw in r.stdout.split(b"\0"):
        if not raw:
            continue
        meta, _, path = raw.partition(b"\t")
        if meta.split(b" ")[0] not in (b"100644", b"100755"):
            continue
        try:
            out.append(path.decode("utf-8"))
        except UnicodeDecodeError:
            continue
    return out


def build_context(spec: str, repo: str) -> dict:
    spec_bytes = read_bytes(spec)
    spec_real = os.path.realpath(spec)
    repo_real = os.path.realpath(repo)
    if spec_real.startswith(repo_real + os.sep):
        spec_path = os.path.relpath(spec_real, repo_real).replace(os.sep, "/")
    else:
        spec_path = spec_real
    inputs = [{"path": spec_path, "sha256": sha256(spec_bytes)}]
    parts = [PROMPT_HEAD, "Specification (%s):\n%s" % (spec_path, spec_bytes.decode("utf-8", "replace"))]
    for rel, full in config_files(repo, spec_real):
        data = read_bytes(full)
        inputs.append({"path": rel, "sha256": sha256(data)})
        parts.append("Runner config (%s):\n%s" % (rel, data.decode("utf-8", "replace")))
    return {"spec_sha256": inputs[0]["sha256"], "inputs": inputs, "prompt": "\n\n".join(parts)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="check_author.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("context", help="print the exact check-author input as JSON")
    c.add_argument("--spec", required=True)
    c.add_argument("--repo", required=True)
    args = ap.parse_args(argv)
    if not os.path.isfile(args.spec):
        print("check_author: spec not found: %s" % args.spec, file=sys.stderr)
        return 2
    if not os.path.isdir(args.repo):
        print("check_author: repo not a directory: %s" % args.repo, file=sys.stderr)
        return 2
    json.dump(build_context(args.spec, args.repo), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
