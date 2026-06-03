"""task_hash: pure-stdlib compute and verify of a benchmark task's content hash.

R2 benchmark harness, Slice A. No third-party imports, no network, no git.

A task_hash uniquely and reproducibly identifies a benchmark task by its
CONTENT, so a stranger can recompute it offline and confirm the task they ran
is byte-for-byte the task we published. This is the core trust primitive of the
"reproducible by a third party" credibility rule.

ALGORITHM (hash-of-hashes, fixed order, no concatenation ambiguity):

    h_spec       = sha256(spec.md bytes)
    h_acceptance = sha256(acceptance bytes)         # held-out from the agent
    h_fixture    = fixture_tree_hash(fixture dir)   # stdlib directory walk
    h_model      = sha256(model id, utf-8)

    task_hash    = sha256(
        "loki-bench-task-v1\n"                       # domain/version tag
        + h_spec + "\n"
        + h_acceptance + "\n"
        + h_fixture + "\n"
        + h_model + "\n"
    )

Each of the four components is hashed independently, then the four hex digests
are joined in a fixed order with a single separator and a leading domain tag.
This removes the "where does spec end and acceptance begin" ambiguity that a
naive byte-concatenation would introduce, and lets a verifier reason about
exactly one component at a time.

The fixture tree hash is a deterministic stdlib walk: sorted relative POSIX
paths, each contributing its path plus the sha256 of its file content. This is
intentionally NOT `git rev-parse`/`git hash-object`: keeping it pure-stdlib
makes the hash reproducible offline with no git dependency and no SHA-1.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Dict, Iterable, List, Tuple

DOMAIN_TAG = "loki-bench-task-v1"
ALGO = "sha256"

# Entries whose names are skipped while walking a fixture tree. The materialized
# task fixture is the agent's working tree; VCS metadata and editor cruft are not
# part of the task's content and would make the hash non-portable.
_SKIP_DIR_NAMES = {".git", ".hg", ".svn", "__pycache__", ".pytest_cache",
                   ".mypy_cache", ".ruff_cache", "node_modules", ".loki"}
_SKIP_FILE_NAMES = {".DS_Store"}


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    """sha256 of a file's raw bytes, streamed (no full read into memory)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _iter_fixture_files(root: str) -> Iterable[Tuple[str, str]]:
    """Yield (relative_posix_path, absolute_path) for every file under root.

    Deterministic: directories and files are walked in sorted order, skip lists
    applied. Symlinks are followed only for their target bytes via the content
    hash of the link's resolved file if it is a regular file; broken or non-file
    symlinks are recorded by their link path only (rare in fixtures).
    """
    root = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune skip dirs in place so os.walk does not descend into them, and
        # keep traversal order deterministic.
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIR_NAMES)
        for name in sorted(filenames):
            if name in _SKIP_FILE_NAMES:
                continue
            abs = os.path.join(dirpath, name)
            rel = os.path.relpath(abs, root)
            # Normalize to POSIX separators so the hash is identical on Windows.
            rel_posix = rel.replace(os.sep, "/")
            yield rel_posix, abs


def fixture_tree_hash(root: str) -> str:
    """Deterministic content hash of a directory tree (pure stdlib).

    For each file (sorted by relative POSIX path) we feed:
        "<rel_posix_path>\\0<sha256_of_content>\\n"
    into a running sha256. The path is included so that moving identical content
    to a different path changes the hash. NUL separates path from content hash so
    a path cannot be confused with a digest. Empty trees hash to a stable value.
    """
    if not os.path.isdir(root):
        raise FileNotFoundError("fixture tree not found: %s" % root)
    h = hashlib.sha256()
    h.update(b"loki-bench-fixture-v1\n")
    for rel_posix, abs_path in _iter_fixture_files(root):
        try:
            content_hash = sha256_file(abs_path)
        except (OSError, IOError):
            # Non-regular / unreadable entry: hash its path only, marked.
            content_hash = "UNREADABLE"
        h.update(rel_posix.encode("utf-8"))
        h.update(b"\x00")
        h.update(content_hash.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


def compute_components(
    spec_bytes: bytes,
    acceptance_bytes: bytes,
    fixture_root: str,
    model_id: str,
) -> Dict[str, str]:
    """Compute the four component hashes. Pure function over its inputs."""
    return {
        "spec": _sha256_bytes(spec_bytes),
        "acceptance": _sha256_bytes(acceptance_bytes),
        "fixture": fixture_tree_hash(fixture_root),
        "model": _sha256_bytes(model_id.encode("utf-8")),
    }


def combine_components(components: Dict[str, str]) -> str:
    """Combine the four component hex digests into the final task_hash.

    Fixed order: spec, acceptance, fixture, model. A leading domain tag binds the
    digest to this algorithm version.
    """
    ordered: List[str] = [
        components["spec"],
        components["acceptance"],
        components["fixture"],
        components["model"],
    ]
    payload = DOMAIN_TAG + "\n" + "\n".join(ordered) + "\n"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def compute_task_hash(
    spec_path: str,
    acceptance_path: str,
    fixture_root: str,
    model_id: str,
) -> str:
    """Compute task_hash from on-disk paths.

    spec_path        -> spec.md (the brief shown to the agent)
    acceptance_path  -> acceptance.sh (HELD-OUT; bytes feed the hash, never the agent)
    fixture_root     -> directory tree the agent starts from (base repo@commit)
    model_id         -> the model identifier string
    """
    with open(spec_path, "rb") as fh:
        spec_bytes = fh.read()
    with open(acceptance_path, "rb") as fh:
        acceptance_bytes = fh.read()
    components = compute_components(spec_bytes, acceptance_bytes, fixture_root, model_id)
    return combine_components(components)


def verify_task_hash(
    expected_hash: str,
    spec_path: str,
    acceptance_path: str,
    fixture_root: str,
    model_id: str,
) -> Tuple[bool, str]:
    """Recompute task_hash and compare to expected.

    Returns (ok, actual_hash). Comparison is constant-time on the hex strings.
    """
    actual = compute_task_hash(spec_path, acceptance_path, fixture_root, model_id)
    ok = hmac.compare_digest(expected_hash.strip().lower(), actual.lower())
    return ok, actual


def _build_arg_parser():
    import argparse

    p = argparse.ArgumentParser(
        prog="hash.py",
        description="Compute or verify a benchmark task_hash (pure stdlib, offline).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    common_args = [
        ("--spec", "path to spec.md"),
        ("--acceptance", "path to acceptance.sh (held-out)"),
        ("--fixture", "path to fixture directory tree"),
        ("--model", "model id string"),
    ]

    pc = sub.add_parser("compute", help="print the task_hash")
    for flag, helptext in common_args:
        pc.add_argument(flag, required=True, help=helptext)

    pv = sub.add_parser("verify", help="recompute and compare to --expected")
    pv.add_argument("--expected", required=True, help="expected task_hash to compare against")
    for flag, helptext in common_args:
        pv.add_argument(flag, required=True, help=helptext)
    return p


def main(argv=None):
    parser = _build_arg_parser()
    args = parser.parse_args(argv)
    if args.cmd == "compute":
        print(compute_task_hash(args.spec, args.acceptance, args.fixture, args.model))
        return 0
    if args.cmd == "verify":
        ok, actual = verify_task_hash(
            args.expected, args.spec, args.acceptance, args.fixture, args.model
        )
        if ok:
            print("OK %s" % actual)
            return 0
        print("MISMATCH expected=%s actual=%s" % (args.expected.strip(), actual))
        return 1
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    import sys

    sys.exit(main())
