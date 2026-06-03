"""SWE-bench Verified loader: materialize pinned instances into the task-spec format.

R2 benchmark harness, Slice A. Pure stdlib. NO network calls. NO full-dataset
download. The loader reads a LOCAL cached dataset (json/jsonl) and materializes a
pinned subset of instances into the frozen task-spec layout documented in
`benchmarks/tasks/SCHEMA.md`.

Design constraints (from R2 spec + user decision):
- FROZEN PUBLIC tasks only. We never author tasks; we materialize real SWE-bench
  instances. The pinned subset is `benchmarks/swebench/pinned-subset.json`.
- Offline. If the dataset is absent we DEGRADE GRACEFULLY with a clear message;
  we never reach for the network.
- Held-out grading. `spec.md` is built ONLY from `problem_statement`. The held-out
  tests (FAIL_TO_PASS / PASS_TO_PASS) go into `acceptance.sh` and NEVER into
  `spec.md`. This is the anti-contamination guarantee, enforced here, not just
  checked in tests.
- The agent NEVER sees acceptance. The grader (Slice B) runs it on a read-only
  host outside the agent container.

A SWE-bench instance (per the official dataset schema) carries at least:
  instance_id, repo, base_commit, problem_statement, FAIL_TO_PASS, PASS_TO_PASS,
  and optionally test_patch / environment_setup_commit / version.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

# Import sibling task hash module without assuming it is on sys.path.
import sys

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_TASKS_DIR = os.path.join(os.path.dirname(_THIS_DIR), "tasks")
if _TASKS_DIR not in sys.path:
    sys.path.insert(0, _TASKS_DIR)

import hash as task_hash  # noqa: E402  (benchmarks/tasks/hash.py)

DEFAULT_MODEL = "claude-opus-4-8"
DEFAULT_TIMEOUT_S = 1800
# Must match benchmarks/bench/bench_schema.SCHEMA_VERSION. The materialized
# task.json declares the frozen contract version it validates against.
TASK_SPEC_SCHEMA_VERSION = "1.0"
PINNED_MANIFEST = os.path.join(_THIS_DIR, "pinned-subset.json")


class DatasetUnavailable(Exception):
    """Raised when the local SWE-bench dataset cannot be found or parsed.

    Carries a human-readable, actionable message. Callers should catch this and
    present it rather than crashing, so the harness degrades gracefully offline.
    """


class InstanceNotFound(Exception):
    """Raised when a pinned instance id is absent from the local dataset."""


def _parse_test_list(value: Any) -> List[str]:
    """SWE-bench stores FAIL_TO_PASS / PASS_TO_PASS as a list or a JSON string."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return []
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(v) for v in parsed]
        except (ValueError, TypeError):
            pass
        return [value]
    return [str(value)]


def load_pinned_manifest(manifest_path: str = PINNED_MANIFEST) -> Dict[str, Any]:
    """Load and validate the pinned-subset manifest."""
    if not os.path.isfile(manifest_path):
        raise DatasetUnavailable(
            "Pinned manifest not found: %s. This file lists the frozen public "
            "instance ids the harness materializes." % manifest_path
        )
    with open(manifest_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if "instances" not in data or not isinstance(data["instances"], list):
        raise DatasetUnavailable(
            "Pinned manifest %s is missing an 'instances' list." % manifest_path
        )
    return data


def _read_dataset(dataset_path: str) -> List[Dict[str, Any]]:
    """Read a local SWE-bench dataset (json array or jsonl). No network."""
    if not os.path.exists(dataset_path):
        raise DatasetUnavailable(
            "SWE-bench dataset not found at: %s\n"
            "The loader makes NO network calls. To use it, download the "
            "SWE-bench Verified dataset locally (e.g. via the official "
            "`datasets` export to json/jsonl) and pass its path, or set "
            "SWEBENCH_DATASET_PATH. Without it, the harness degrades to "
            "manifest-only mode (ids known, instances not materialized)."
            % dataset_path
        )
    instances: List[Dict[str, Any]] = []
    try:
        if dataset_path.endswith(".jsonl"):
            with open(dataset_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        instances.append(json.loads(line))
        else:
            with open(dataset_path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            if isinstance(doc, list):
                instances = doc
            elif isinstance(doc, dict):
                # Accept a wrapped form, but reject the placeholder stub form
                # (where "problems" is an int and there is no instance list).
                for key in ("instances", "data", "rows", "test"):
                    if isinstance(doc.get(key), list):
                        instances = doc[key]
                        break
                else:
                    raise DatasetUnavailable(
                        "Dataset at %s has no recognizable instance list "
                        "(expected a json array, jsonl, or an object with an "
                        "'instances'/'data' list). Got top-level keys: %s. "
                        "If this is the placeholder stub, replace it with a real "
                        "SWE-bench Verified export."
                        % (dataset_path, sorted(doc.keys()))
                    )
    except json.JSONDecodeError as exc:
        raise DatasetUnavailable(
            "Failed to parse dataset %s as JSON/JSONL: %s" % (dataset_path, exc)
        )
    if not instances:
        raise DatasetUnavailable(
            "Dataset %s parsed but contains zero instances." % dataset_path
        )
    return instances


def _index_by_id(instances: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for inst in instances:
        iid = inst.get("instance_id")
        if iid:
            out[str(iid)] = inst
    return out


def build_spec_md(instance: Dict[str, Any]) -> str:
    """Build the agent-facing brief from the problem_statement ONLY.

    Anti-contamination: this function deliberately ignores FAIL_TO_PASS,
    PASS_TO_PASS, test_patch, and acceptance. The agent must never learn the
    held-out tests from the brief.
    """
    iid = str(instance.get("instance_id", "unknown"))
    repo = str(instance.get("repo", "unknown"))
    problem = (instance.get("problem_statement") or "").strip()
    lines = [
        "# Task: %s" % iid,
        "",
        "Repository: %s" % repo,
        "",
        "## Problem statement",
        "",
        problem if problem else "(no problem statement provided in the dataset)",
        "",
        "## What to do",
        "",
        "Resolve the issue described above by modifying the code in the working "
        "tree. Do not add new top-level dependencies unless required. The change "
        "is graded by a held-out test suite that you will not see.",
        "",
    ]
    return "\n".join(lines)


def build_acceptance_sh(instance: Dict[str, Any]) -> str:
    """Build the HELD-OUT grader script that runs the instance's tests.

    The grader (Slice B) runs this OUTSIDE the agent container on a read-only
    host. Loki never grades itself. The script exits non-zero if any held-out
    test fails. The agent never sees this file.
    """
    iid = str(instance.get("instance_id", "unknown"))
    repo = str(instance.get("repo", "unknown"))
    base_commit = str(instance.get("base_commit", ""))
    fail_to_pass = _parse_test_list(instance.get("FAIL_TO_PASS"))
    pass_to_pass = _parse_test_list(instance.get("PASS_TO_PASS"))

    def _shell_array(name: str, items: List[str]) -> str:
        if not items:
            return "%s=()" % name
        quoted = " ".join("'%s'" % t.replace("'", "'\\''") for t in items)
        return "%s=(%s)" % (name, quoted)

    body = [
        "#!/usr/bin/env bash",
        "# HELD-OUT acceptance grader for %s" % iid,
        "# Repo: %s @ %s" % (repo, base_commit),
        "# Run by the OUT-OF-CONTAINER grader on a read-only host. The agent",
        "# under test never sees this file. Exit 0 = solved, non-zero = failed.",
        "set -uo pipefail",
        "",
        "# The official SWE-bench harness is the source of truth for running",
        "# these tests in the correct environment. This script records the",
        "# held-out test sets so the grader can drive them; integrate with",
        "# `python -m swebench.harness.run_evaluation` (Slice B owns wiring).",
        "",
        _shell_array("FAIL_TO_PASS", fail_to_pass),
        _shell_array("PASS_TO_PASS", pass_to_pass),
        "",
        'INSTANCE_ID="%s"' % iid,
        'BASE_COMMIT="%s"' % base_commit,
        "",
        'echo "[grader] instance=$INSTANCE_ID fail_to_pass=${#FAIL_TO_PASS[@]} '
        'pass_to_pass=${#PASS_TO_PASS[@]}"',
        "",
        "# Slice B replaces the following with a real invocation of the official",
        "# SWE-bench evaluation harness against the agent's patched fixture.",
        'if [ -n "${LOKI_BENCH_GRADER_CMD:-}" ]; then',
        '  exec bash -c "$LOKI_BENCH_GRADER_CMD"',
        "fi",
        'echo "[grader] no LOKI_BENCH_GRADER_CMD set; grading not wired in this slice" >&2',
        "exit 2",
        "",
    ]
    return "\n".join(body)


def materialize_instance(
    instance: Dict[str, Any],
    out_dir: str,
    model: str = DEFAULT_MODEL,
    timeout_s: int = DEFAULT_TIMEOUT_S,
    fixture_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Write task.json, spec.md, acceptance/acceptance.sh into out_dir, compute
    task_hash, and emit a task.json that validates against the FROZEN runner
    contract (benchmarks/bench/bench_schema.validate_task_spec).

    fixture_root: if given, an existing materialized fixture tree to hash. If
    None, an empty `fixture/` directory is created (placeholder until Slice B /
    an operator checks out repo@base_commit). The task_hash always reflects the
    actual fixture tree on disk.
    """
    iid = str(instance.get("instance_id", "unknown"))
    repo = str(instance.get("repo", "unknown"))
    base_commit = str(instance.get("base_commit", ""))

    os.makedirs(out_dir, exist_ok=True)
    spec_path = os.path.join(out_dir, "spec.md")
    acceptance_dir = os.path.join(out_dir, "acceptance")
    acceptance_path = os.path.join(acceptance_dir, "acceptance.sh")
    fixture_dir = os.path.join(out_dir, "fixture")

    spec_text = build_spec_md(instance)
    acceptance_text = build_acceptance_sh(instance)

    with open(spec_path, "w", encoding="utf-8") as fh:
        fh.write(spec_text)
    # The held-out grader script lives in a SEPARATE `acceptance/` overlay dir,
    # never inside `fixture/`. The runner copies only `fixture/` into the agent's
    # workdir; the grader applies `acceptance.overlay` AFTER the agent finishes,
    # so the agent under test never sees acceptance.sh. This is the
    # anti-contamination guarantee carried over from the SWE-bench test-patch
    # pattern and is what makes acceptance.cmd actually runnable by the grader.
    os.makedirs(acceptance_dir, exist_ok=True)
    with open(acceptance_path, "w", encoding="utf-8") as fh:
        fh.write(acceptance_text)
    os.chmod(acceptance_path, 0o755)

    if fixture_root and os.path.isdir(fixture_root):
        hash_fixture_root = fixture_root
        fixture_path_field = os.path.relpath(fixture_root, out_dir)
    else:
        os.makedirs(fixture_dir, exist_ok=True)
        hash_fixture_root = fixture_dir
        fixture_path_field = "fixture"

    # task_hash here is the OFFLINE third-party verification anchor computed by
    # benchmarks/tasks/hash.py over (spec.md bytes, acceptance.sh bytes, fixture
    # tree, model id). It is independent of the runner's own result-row hash
    # (benchmarks/bench/bench_schema.compute_task_hash), which the runner
    # recomputes at run time and never reads from this file. See SCHEMA.md.
    th = task_hash.compute_task_hash(
        spec_path=spec_path,
        acceptance_path=acceptance_path,
        fixture_root=hash_fixture_root,
        model_id=model,
    )

    # The agent-facing brief (spec.md) IS the prompt the runner hands the agent.
    # The runner materializes spec["prompt"] into a file inside the workdir; the
    # held-out acceptance is deliberately NOT part of the prompt.
    task_obj = {
        # --- bench_schema TASK_SPEC_REQUIRED contract (flat shape) ---
        "schema_version": TASK_SPEC_SCHEMA_VERSION,
        "id": iid,
        "source": "swe-bench-verified",
        "fixture": fixture_path_field,
        "prompt": spec_text,
        "acceptance": {
            "cmd": "bash acceptance.sh",
            "timeout_s": int(timeout_s),
            # The grader copies this overlay dir into the workdir AFTER the agent
            # finishes, then runs cmd. This is how acceptance.sh reaches the
            # workdir without ever being visible to the agent.
            "overlay": "acceptance",
        },
        "default_model": model,
        "agent_timeout_s": int(timeout_s),
        "quality": {"lint_cmd": None, "test_cmd": None},
        # --- provenance / SWE-bench specifics (extra keys; validator ignores) ---
        "title": iid,
        "source_ref": iid,
        "spec_path": "spec.md",
        "task_hash": th,
        "fixture_source": {
            "kind": "git",
            "repo": repo,
            "git_ref": base_commit,
            "path": fixture_path_field,
        },
        "source_info": {
            "dataset": "SWE-bench Verified",
            "split": "test",
            "url": "https://www.swebench.com/",
        },
    }
    task_json_path = os.path.join(out_dir, "task.json")
    with open(task_json_path, "w", encoding="utf-8") as fh:
        json.dump(task_obj, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return task_obj


def load_pinned_subset(
    dataset_path: Optional[str] = None,
    out_root: Optional[str] = None,
    manifest_path: str = PINNED_MANIFEST,
    model: str = DEFAULT_MODEL,
) -> Dict[str, Any]:
    """Materialize the pinned subset from a LOCAL dataset.

    Returns a result dict: {materialized: [...], missing: [...], manifest: {...}}.
    Raises DatasetUnavailable (caught by callers) when the dataset is absent, so
    the harness degrades gracefully offline.
    """
    manifest = load_pinned_manifest(manifest_path)
    pinned_ids = [str(e["id"]) for e in manifest["instances"] if "id" in e]

    if dataset_path is None:
        dataset_path = os.environ.get("SWEBENCH_DATASET_PATH", "")
    if not dataset_path:
        raise DatasetUnavailable(
            "No dataset path provided and SWEBENCH_DATASET_PATH is unset. "
            "Pinned ids are known (%d) but cannot be materialized without a "
            "local SWE-bench Verified dataset. No network call is made."
            % len(pinned_ids)
        )

    instances = _read_dataset(dataset_path)
    by_id = _index_by_id(instances)

    if out_root is None:
        out_root = os.path.join(_THIS_DIR, "tasks")

    materialized: List[str] = []
    missing: List[str] = []
    for iid in pinned_ids:
        inst = by_id.get(iid)
        if inst is None:
            missing.append(iid)
            continue
        out_dir = os.path.join(out_root, iid)
        materialize_instance(inst, out_dir, model=model)
        materialized.append(iid)

    return {
        "materialized": materialized,
        "missing": missing,
        "manifest": manifest,
        "dataset_path": dataset_path,
        "out_root": out_root,
    }


def _main(argv=None):
    import argparse

    p = argparse.ArgumentParser(
        prog="loader.py",
        description="Materialize the pinned SWE-bench subset into task-spec format (offline).",
    )
    p.add_argument("--dataset", default=None, help="path to local SWE-bench json/jsonl")
    p.add_argument("--out", default=None, help="output root for materialized tasks")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--manifest", default=PINNED_MANIFEST)
    args = p.parse_args(argv)
    try:
        result = load_pinned_subset(
            dataset_path=args.dataset,
            out_root=args.out,
            manifest_path=args.manifest,
            model=args.model,
        )
    except DatasetUnavailable as exc:
        print("dataset unavailable: %s" % exc)
        return 3
    print(
        "materialized %d, missing %d: %s"
        % (len(result["materialized"]), len(result["missing"]), result["missing"])
    )
    return 0


if __name__ == "__main__":
    import sys as _sys

    _sys.exit(_main())
