#!/usr/bin/env python3
"""False-completion trap tasks (trap-01 .. trap-10 and judge-trap-1): controls.

Each trap task has visible tests the agent sees, a held-out acceptance overlay it
does not, a REFERENCE solution (positive control) and a STUB that passes the
visible tests while breaking a stated rule (negative control). It also carries
near-misses (<id>-controls/nearmiss.json): the reference with ONE boundary bug
(off-by-one, empty input, max length, ordering) that still passes the visible
tests. The grader must return rc 1 for every one, because a grader that lets a
near-miss through undercounts the false-pass rate. This test runs all of them
through runner.grade(), the same grader a bench cell uses, and checks the
pre-registered manifest (tasks/trap-manifest.json) so the tasks cannot drift
after a paid run starts.

Run: python3 -m pytest benchmarks/bench/tests/test_trap_tasks.py -q
Rewrite the manifest (only before any paid run):
     python3 benchmarks/bench/tests/test_trap_tasks.py --write-manifest
Print the near-miss table (task, near-miss, kind, visible rc, grader rc):
     python3 benchmarks/bench/tests/test_trap_tasks.py --table
"""
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
sys.path.insert(0, BENCH)
from bench_schema import _hash_fixture_dir, validate_task_spec  # noqa: E402
from runner import grade, prepare_workdir  # noqa: E402

TASKS_DIR = os.path.join(BENCH, "tasks")
MANIFEST = os.path.join(TASKS_DIR, "trap-manifest.json")
TOOL = {"python": "python3", "node": "node", "go": "go"}


def _specs():
    out = []
    paths = glob.glob(os.path.join(TASKS_DIR, "trap-*.json")) + [os.path.join(TASKS_DIR, "judge-trap-1.json")]
    for path in sorted(paths, key=lambda p: (os.path.basename(p).startswith("judge"), p)):
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


def test_eleven_tasks_registered_and_valid():
    specs = _specs()
    assert len(specs) == 11, [os.path.basename(p) for p, _ in specs]
    langs = {s["language"] for _, s in specs}
    assert {"python", "node", "go"} <= langs
    for path, spec in specs:
        assert validate_task_spec(spec) == [], path
        assert spec["id"] == os.path.basename(path)[: -len(".json")]
        assert spec["acceptance"]["overlay"] == "../fixtures/%s-overlay" % spec["id"]
        assert spec["acceptance"]["cmd"] == "python3 check_acceptance.py"
        assert os.path.isfile(os.path.join(_dir({"o": spec["acceptance"]["overlay"]}, "o"), "check_acceptance.py"))


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


def _load_nearmisses(spec):
    with open(os.path.join(_dir(spec, "controls"), "nearmiss.json")) as fh:
        return json.load(fh)


def _nearmiss_workdir(spec, case):
    """Reference solution with the near-miss applied; every edit must hit exactly once."""
    wd = _workdir_with(spec, "reference")
    path = os.path.join(wd, case["file"])
    if "source" in case:
        text = case["source"]
    else:
        with open(path) as fh:
            text = fh.read()
        for edit in case["edits"]:
            assert text.count(edit["old"]) == 1, (spec["id"], case["case"], edit["old"], text.count(edit["old"]))
            text = text.replace(edit["old"], edit["new"])
        assert text != open(path).read(), (spec["id"], case["case"], "edit changed nothing")
    with open(path, "w") as fh:
        fh.write(text)
    return wd


def run_nearmisses():
    """Rows of (task, near-miss, kind, visible rc, grader rc) for every near-miss."""
    rows = []
    for _, spec in _specs():
        if shutil.which(TOOL[spec["language"]]) is None:
            continue
        for case in _load_nearmisses(spec):
            wd = _nearmiss_workdir(spec, case)
            try:
                vis = _visible(spec, wd).returncode
                rc = grade(wd, spec, task_dir=TASKS_DIR)["acceptance_exit_code"]
            finally:
                shutil.rmtree(wd, ignore_errors=True)
            rows.append((spec["id"], case["case"], ",".join(str(r) for r in case["rules"]), case["kind"], vis, rc))
    return rows


def test_every_task_has_boundary_near_misses():
    kinds = {"off-by-one", "empty-input", "max-length", "ordering", "other"}
    for _, spec in _specs():
        cases = _load_nearmisses(spec)
        assert len(cases) >= 4, spec["id"]
        assert {c["kind"] for c in cases} <= kinds, spec["id"]
        assert len({c["case"] for c in cases}) == len(cases), spec["id"]


def _prompt_rules(spec):
    return {int(m) for m in re.findall(r"(?m)^(\d+)\. ", spec["prompt"])}


def test_every_numbered_prompt_rule_has_a_near_miss():
    for _, spec in _specs():
        rules = _prompt_rules(spec)
        assert rules, spec["id"]
        covered = set()
        for c in _load_nearmisses(spec):
            assert c["rules"] and set(c["rules"]) <= rules, (spec["id"], c["case"], c["rules"])
            covered |= set(c["rules"])
        assert covered == rules, (spec["id"], "rules without a near-miss", sorted(rules - covered))


def test_grader_rejects_every_near_miss_with_rc_1():
    rows = run_nearmisses()
    assert rows
    bad = [r for r in rows if r[4] != 0 or r[5] != 1]
    assert not bad, "near-miss must pass the visible tests (rc 0) and fail the grader (rc 1): %r" % (bad,)


def test_reference_runs_to_grader_pass_in_the_realistic_fixture():
    """The fixture a tool receives is a git repo with a dummy origin and a declared test
    command; the reference dropped into exactly that workdir passes visible and hidden."""
    markers = {"python": ("pyproject.toml", "pytest"), "node": ("package.json", '"test"'), "go": ("go.mod", "module ")}
    for _, spec in _specs():
        if shutil.which(TOOL[spec["language"]]) is None:
            continue
        wd = prepare_workdir(_dir(spec, "fixture"), "trapcheck")
        try:
            name, needle = markers[spec["language"]]
            with open(os.path.join(wd, name)) as fh:
                assert needle in fh.read(), (spec["id"], name)
            origin = subprocess.run(["git", "remote", "get-url", "origin"], cwd=wd, capture_output=True, text=True)
            assert origin.returncode == 0 and origin.stdout.startswith("https://"), (spec["id"], origin.stderr)
            assert subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=wd, capture_output=True).returncode == 0
            shutil.copytree(os.path.join(_dir(spec, "controls"), "reference"), wd, dirs_exist_ok=True)
            vis = _visible(spec, wd)
            assert vis.returncode == 0, (spec["id"], vis.stdout[-400:] + vis.stderr[-400:])
            assert grade(wd, spec, task_dir=TASKS_DIR)["acceptance_exit_code"] == 0, spec["id"]
        finally:
            shutil.rmtree(wd, ignore_errors=True)


def write_manifest():
    tasks = {s["id"]: {"sha256": task_digest(p, s), "language": s["language"]} for p, s in _specs()}
    with open(MANIFEST, "w") as fh:
        json.dump({"schema_version": "1.0", "preregistered_before_any_paid_run": True, "tasks": tasks}, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    if "--table" in sys.argv:
        print("%-22s %-40s %-5s %-11s %-3s %s" % ("task", "near-miss", "rule", "kind", "vis", "rc"))
        for row in run_nearmisses():
            print("%-22s %-40s %-5s %-11s %-3s %s" % row)
    elif "--write-manifest" in sys.argv:
        write_manifest()
        print("wrote " + MANIFEST)
    else:
        sys.exit(subprocess.call([sys.executable, "-m", "pytest", "-q", __file__]))
