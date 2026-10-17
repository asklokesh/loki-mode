"""Offline localization eval (TEN-QUALITY-09): gold_files and the localization command.

No existing test file owns benchmarks/swebench/loader.py, so this is the first.
"""
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "benchmarks", "swebench"))
import loader  # noqa: E402

PATCH = (
    "diff --git a/pkg/alpha.py b/pkg/alpha.py\n--- a/pkg/alpha.py\n+++ b/pkg/alpha.py\n@@ -1 +1 @@\n-a\n+b\n"
    "diff --git a/pkg/new.py b/pkg/new.py\nnew file mode 100644\n--- /dev/null\n+++ b/pkg/new.py\n@@ -0,0 +1 @@\n+x\n"
)


def test_gold_files_two_paths_ignores_dev_null():
    assert loader.gold_files(PATCH) == ["pkg/alpha.py", "pkg/new.py"]


def _setup(tmp_path, with_checkout):
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"instances": [{"id": "x__y-1", "repo": "x/y"}]}))
    inst = {"instance_id": "x__y-1", "repo": "x/y", "base_commit": "abc",
            "problem_statement": "fix the zebrafinch handler",
            "patch": "--- a/src/zebrafinch.py\n+++ b/src/zebrafinch.py\n@@ -1 +1 @@\n-a\n+b\n"}
    ds = tmp_path / "d.json"
    ds.write_text(json.dumps([inst]))
    repos = tmp_path / "repos"
    repos.mkdir()
    if with_checkout:
        co = repos / "x__y@abc"
        (co / "src").mkdir(parents=True)
        (co / "src" / "zebrafinch.py").write_text("def handler():\n    pass\n")
        (co / "src" / "other.py").write_text("def other():\n    pass\n")
        for cmd in (["init", "-q"], ["add", "."]):
            subprocess.run(["git", "-C", str(co)] + cmd, check=True)
    return str(ds), str(repos), str(manifest)


def test_localization_recall_when_gold_named(tmp_path):
    ds, repos, mf = _setup(tmp_path, True)
    out = loader.run_localization(ds, repos, mf)
    assert out["scored"] == 1 and out["skipped"] == 0
    assert out["recall_at_8"] == 1.0 and out["recall_at_20"] == 1.0
    assert out["instances"][0]["hits_at_8"] == ["src/zebrafinch.py"]


def test_missing_checkout_is_skipped_not_zero(tmp_path):
    ds, repos, mf = _setup(tmp_path, False)
    out = loader.run_localization(ds, repos, mf)
    row = out["instances"][0]
    assert row["skipped"] is True and row["recall_at_8"] is None
    assert out["scored"] == 0 and out["recall_at_8"] is None
    assert row["reason"]
