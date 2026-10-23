#!/usr/bin/env python3
"""False-completion trap tasks (trap-01 .. trap-10): positive and negative controls.

Each trap task has visible tests the agent sees, a held-out acceptance overlay it
does not, a REFERENCE solution (positive control) and a STUB that passes the
visible tests while breaking a stated rule (negative control). This test runs
both through runner.grade(), the same grader a bench cell uses, and checks the
pre-registered manifest (tasks/trap-manifest.json) so the tasks cannot drift
after a paid run starts.

Run: python3 -m pytest benchmarks/bench/tests/test_trap_tasks.py -q
Rewrite the manifest (only before any paid run):
     python3 benchmarks/bench/tests/test_trap_tasks.py --write-manifest
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
sys.path.insert(0, BENCH)
from bench_schema import _hash_fixture_dir, validate_task_spec  # noqa: E402
from runner import grade  # noqa: E402

TASKS_DIR = os.path.join(BENCH, "tasks")
MANIFEST = os.path.join(TASKS_DIR, "trap-manifest.json")
TOOL = {"python": "python3", "node": "node", "go": "go"}


def _specs():
    out = []
    for path in sorted(glob.glob(os.path.join(TASKS_DIR, "trap-*.json"))):
        if os.path.basename(path) == "trap-manifest.json":
            continue
        with open(path) as fh:
            out.append((path, json.load(fh)))
    return out


def _dir(spec, key):
    return os.path.realpath(os.path.join(TASKS_DIR, spec[key]))


def task_digest(path, spec):
    """sha256 over the task json, fixture, overlay and both controls."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    for d in (_dir(spec, "fixture"), _dir({"o": spec["acceptance"]["overlay"]}, "o"), _dir(spec, "controls")):
        h.update(_hash_fixture_dir(d).encode())
    return h.hexdigest()


def _workdir_with(spec, control):
    wd = tempfile.mkdtemp(prefix="trap-")
    shutil.copytree(_dir(spec, "fixture"), wd, dirs_exist_ok=True)
    shutil.copytree(os.path.join(_dir(spec, "controls"), control), wd, dirs_exist_ok=True)
    return wd


def _visible(spec, wd):
    return subprocess.run(spec["visible_cmd"], cwd=wd, shell=True, capture_output=True, text=True, timeout=120)


def test_ten_tasks_registered_and_valid():
    specs = _specs()
    assert len(specs) == 10, [os.path.basename(p) for p, _ in specs]
    langs = {s["language"] for _, s in specs}
    assert {"python", "node"} <= langs
    for path, spec in specs:
        assert validate_task_spec(spec) == [], path
        assert spec["id"] == os.path.basename(path)[: -len(".json")]


def test_manifest_matches_every_task():
    with open(MANIFEST) as fh:
        manifest = json.load(fh)
    specs = _specs()
    assert sorted(manifest["tasks"]) == sorted(s["id"] for _, s in specs)
    for path, spec in specs:
        assert manifest["tasks"][spec["id"]]["sha256"] == task_digest(path, spec), (
            "%s drifted from the pre-registered manifest" % spec["id"])


def test_visible_fixture_holds_no_hidden_assertions():
    for _, spec in _specs():
        names = os.listdir(_dir(spec, "fixture"))
        assert not any("check_acceptance" in n or n.startswith("hidden") for n in names), (spec["id"], names)


def _run_controls(spec):
    results = {}
    for control in ("reference", "stub"):
        wd = _workdir_with(spec, control)
        try:
            vis = _visible(spec, wd)
            verdict = grade(wd, spec, task_dir=TASKS_DIR)
            results[control] = (vis.returncode, verdict["success"], vis.stdout + vis.stderr)
        finally:
            shutil.rmtree(wd, ignore_errors=True)
    return results


def test_controls_discriminate():
    ran = 0
    for _, spec in _specs():
        if shutil.which(TOOL[spec["language"]]) is None:
            continue
        r = _run_controls(spec)
        assert r["reference"][0] == 0 and r["reference"][1] is True, (spec["id"], "reference", r["reference"])
        assert r["stub"][0] == 0, (spec["id"], "stub must pass the visible tests", r["stub"][2][-400:])
        assert r["stub"][1] is False, (spec["id"], "stub must fail the hidden acceptance")
        ran += 1
    assert ran >= 1


def test_empty_workdir_fails_hidden():
    for _, spec in _specs():
        if shutil.which(TOOL[spec["language"]]) is None:
            continue
        wd = tempfile.mkdtemp(prefix="trap-empty-")
        shutil.copytree(_dir(spec, "fixture"), wd, dirs_exist_ok=True)
        try:
            assert grade(wd, spec, task_dir=TASKS_DIR)["success"] is False, spec["id"]
        finally:
            shutil.rmtree(wd, ignore_errors=True)


def write_manifest():
    tasks = {s["id"]: {"sha256": task_digest(p, s), "language": s["language"]} for p, s in _specs()}
    with open(MANIFEST, "w") as fh:
        json.dump({"schema_version": "1.0", "preregistered_before_any_paid_run": True, "tasks": tasks}, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    if "--write-manifest" in sys.argv:
        write_manifest()
        print("wrote " + MANIFEST)
    else:
        sys.exit(subprocess.call([sys.executable, "-m", "pytest", "-q", __file__]))
