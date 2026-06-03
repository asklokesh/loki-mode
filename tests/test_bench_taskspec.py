"""Tests for the R2 benchmark task-spec format, task_hash, and SWE-bench loader.

Slice A. NO network calls. A tiny local fixture instance drives the loader so the
materialization path is exercised entirely offline.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "benchmarks" / "tasks"))
sys.path.insert(0, str(_REPO_ROOT / "benchmarks" / "swebench"))
sys.path.insert(0, str(_REPO_ROOT / "benchmarks" / "bench"))

import hash as task_hash  # noqa: E402
import loader  # noqa: E402  (benchmarks/swebench/loader.py)
import bench_schema  # noqa: E402  (benchmarks/bench/bench_schema.py -- FROZEN contract)
import runner  # noqa: E402  (benchmarks/bench/runner.py -- the loki bench run seam)


def _mock_adapter(workdir, spec, *, model="mock-model", timeout=900, runner=None):
    """A well-behaved mock adapter: touches a file, reports cost, never judges.

    Mirrors test_bench_runner.mock_adapter_with_cost so a materialized task can be
    driven through runner.run_task with zero network and zero paid API calls.
    """
    with open(os.path.join(workdir, "agent-touched.txt"), "w") as fh:
        fh.write("done\n")
    return {
        "tool": "mock",
        "tool_version": "0.0.1",
        "model_used": model or "mock-model",
        "duration_s": 1.0,
        "exit_status": "completed",
        "provenance": {"command": "mock", "verified": True},
        "cost_usd": 0.01,
    }


# A tiny, self-contained SWE-bench-shaped instance. The problem_statement is
# clean (no test names) so the anti-contamination invariant genuinely holds.
TINY_INSTANCE = {
    "instance_id": "tinyorg__tinyrepo-1",
    "repo": "tinyorg/tinyrepo",
    "base_commit": "0123456789abcdef0123456789abcdef01234567",
    "problem_statement": (
        "The add() helper returns the wrong value for negative inputs. "
        "It should return the arithmetic sum of its two arguments."
    ),
    "FAIL_TO_PASS": ["tests/test_calc.py::test_add_negatives"],
    "PASS_TO_PASS": ["tests/test_calc.py::test_add_positives"],
}


class FixtureMixin(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-bench-test-")
        # Materialize a small fixture tree (a few files in nested dirs) so the
        # fixture_tree_hash has real content to hash.
        self.fixture = os.path.join(self.tmp, "fixture")
        os.makedirs(os.path.join(self.fixture, "src"))
        os.makedirs(os.path.join(self.fixture, "tests"))
        with open(os.path.join(self.fixture, "src", "calc.py"), "w") as fh:
            fh.write("def add(a, b):\n    return a - b  # bug\n")
        with open(os.path.join(self.fixture, "tests", "test_calc.py"), "w") as fh:
            fh.write("def test_add_positives():\n    pass\n")
        with open(os.path.join(self.fixture, "README"), "w") as fh:
            fh.write("tiny repo\n")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestTaskHash(FixtureMixin):
    def _write_spec_acceptance(self):
        spec = os.path.join(self.tmp, "spec.md")
        acc = os.path.join(self.tmp, "acceptance.sh")
        with open(spec, "w") as fh:
            fh.write("# brief\nfix the add() helper\n")
        with open(acc, "w") as fh:
            fh.write("#!/usr/bin/env bash\nrun held-out tests\n")
        return spec, acc

    def test_fixture_tree_hash_deterministic(self):
        h1 = task_hash.fixture_tree_hash(self.fixture)
        h2 = task_hash.fixture_tree_hash(self.fixture)
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)

    def test_fixture_tree_hash_changes_on_content(self):
        h1 = task_hash.fixture_tree_hash(self.fixture)
        with open(os.path.join(self.fixture, "src", "calc.py"), "a") as fh:
            fh.write("# changed\n")
        h2 = task_hash.fixture_tree_hash(self.fixture)
        self.assertNotEqual(h1, h2)

    def test_fixture_tree_hash_changes_on_path_move(self):
        # Same content, different path -> different hash.
        h1 = task_hash.fixture_tree_hash(self.fixture)
        os.rename(
            os.path.join(self.fixture, "README"),
            os.path.join(self.fixture, "README.txt"),
        )
        h2 = task_hash.fixture_tree_hash(self.fixture)
        self.assertNotEqual(h1, h2)

    def test_fixture_tree_hash_ignores_vcs_and_cache(self):
        h1 = task_hash.fixture_tree_hash(self.fixture)
        os.makedirs(os.path.join(self.fixture, ".git", "objects"))
        with open(os.path.join(self.fixture, ".git", "config"), "w") as fh:
            fh.write("[core]\n")
        os.makedirs(os.path.join(self.fixture, "__pycache__"))
        with open(os.path.join(self.fixture, "__pycache__", "x.pyc"), "w") as fh:
            fh.write("bytecode")
        h2 = task_hash.fixture_tree_hash(self.fixture)
        self.assertEqual(h1, h2, "vcs/cache files must not affect the fixture hash")

    def test_compute_task_hash_deterministic_and_recomputes(self):
        spec, acc = self._write_spec_acceptance()
        h1 = task_hash.compute_task_hash(spec, acc, self.fixture, "claude-opus-4-8")
        h2 = task_hash.compute_task_hash(spec, acc, self.fixture, "claude-opus-4-8")
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)
        ok, actual = task_hash.verify_task_hash(
            h1, spec, acc, self.fixture, "claude-opus-4-8"
        )
        self.assertTrue(ok)
        self.assertEqual(actual, h1)

    def test_task_hash_sensitive_to_each_component(self):
        spec, acc = self._write_spec_acceptance()
        base = task_hash.compute_task_hash(spec, acc, self.fixture, "claude-opus-4-8")
        # model id
        self.assertNotEqual(
            base, task_hash.compute_task_hash(spec, acc, self.fixture, "other-model")
        )
        # spec
        with open(spec, "a") as fh:
            fh.write("extra\n")
        self.assertNotEqual(
            base, task_hash.compute_task_hash(spec, acc, self.fixture, "claude-opus-4-8")
        )

    def test_combine_components_is_pure(self):
        comps = {"spec": "a" * 64, "acceptance": "b" * 64,
                 "fixture": "c" * 64, "model": "d" * 64}
        self.assertEqual(
            task_hash.combine_components(comps),
            task_hash.combine_components(dict(comps)),
        )

    def test_verify_detects_mismatch(self):
        spec, acc = self._write_spec_acceptance()
        ok, _ = task_hash.verify_task_hash(
            "0" * 64, spec, acc, self.fixture, "claude-opus-4-8"
        )
        self.assertFalse(ok)


class TestLoaderMaterialize(FixtureMixin):
    def test_materialize_instance_produces_valid_taskspec(self):
        out_dir = os.path.join(self.tmp, "tasks", TINY_INSTANCE["instance_id"])
        task = loader.materialize_instance(
            TINY_INSTANCE, out_dir, fixture_root=self.fixture
        )
        # Files landed. The held-out grader now lives in the acceptance/ overlay.
        self.assertTrue(os.path.isfile(os.path.join(out_dir, "task.json")))
        self.assertTrue(os.path.isfile(os.path.join(out_dir, "spec.md")))
        self.assertTrue(
            os.path.isfile(os.path.join(out_dir, "acceptance", "acceptance.sh")))

        # Required FROZEN-contract fields present and well-formed (flat shape).
        with open(os.path.join(out_dir, "task.json")) as fh:
            on_disk = json.load(fh)
        for field in bench_schema.TASK_SPEC_REQUIRED:
            self.assertIn(field, on_disk, "missing required field: %s" % field)
        # source/fixture/prompt/default_model are STRINGS under the contract.
        self.assertIsInstance(on_disk["source"], str)
        self.assertIsInstance(on_disk["fixture"], str)
        self.assertIsInstance(on_disk["prompt"], str)
        self.assertIsInstance(on_disk["default_model"], str)
        self.assertIn("cmd", on_disk["acceptance"])
        self.assertIn("timeout_s", on_disk["acceptance"])
        self.assertIsInstance(on_disk["acceptance"]["timeout_s"], int)
        # Provenance now lives in extra keys (validator ignores unknown keys).
        self.assertEqual(on_disk["fixture_source"]["kind"], "git")
        self.assertEqual(
            on_disk["fixture_source"]["git_ref"], TINY_INSTANCE["base_commit"])
        self.assertEqual(len(on_disk["task_hash"]), 64)

        # The written task_hash actually recomputes from the materialized files.
        ok, actual = task_hash.verify_task_hash(
            on_disk["task_hash"],
            os.path.join(out_dir, "spec.md"),
            os.path.join(out_dir, "acceptance", "acceptance.sh"),
            self.fixture,
            on_disk["default_model"],
        )
        self.assertTrue(ok, "task_hash does not recompute from materialized files")

    def test_materialized_task_validates_against_runner_contract(self):
        """THE SEAM that was missing: a loader-materialized task.json must pass
        the runner's OWN validator (bench_schema.validate_task_spec) and the
        runner's task_hash must compute. Previously the loader emitted `model`,
        nested `fixture`/`source` dicts, and no `prompt`, so validate_task_spec
        raised ~4 errors and `loki bench run`/`verify` could not run the task."""
        out_dir = os.path.join(self.tmp, "tasks", TINY_INSTANCE["instance_id"])
        # Materialize with a default (empty) fixture so the path is exercised the
        # same way load_pinned_subset does (fixture_root=None).
        loader.materialize_instance(TINY_INSTANCE, out_dir)
        task_json_path = os.path.join(out_dir, "task.json")
        with open(task_json_path) as fh:
            on_disk = json.load(fh)

        # 1. The runner's FROZEN validator accepts it with zero problems.
        errs = bench_schema.validate_task_spec(on_disk)
        self.assertEqual(errs, [], "loader task.json rejected by runner: %s" % errs)

        # 2. fixture resolves relative to task.json (as the runner does it) and
        #    the runner's own task_hash computes over (spec, fixture_dir).
        fixture_dir = os.path.realpath(
            os.path.join(os.path.dirname(task_json_path), on_disk["fixture"]))
        self.assertTrue(os.path.isdir(fixture_dir))
        runner_hash = bench_schema.compute_task_hash(on_disk, fixture_dir)
        self.assertEqual(len(runner_hash), 64)
        # Deterministic: recompute matches (what `loki bench verify` relies on).
        self.assertEqual(runner_hash,
                         bench_schema.compute_task_hash(on_disk, fixture_dir))

        # 3. Anti-contamination holds in the contract field too: the agent-facing
        #    prompt must not carry the held-out acceptance content.
        for marker in ("FAIL_TO_PASS", "PASS_TO_PASS", "acceptance.sh",
                       "test_add_negatives"):
            self.assertNotIn(marker, on_disk["prompt"],
                             "acceptance content leaked into prompt: %s" % marker)

    def test_materialized_task_runs_through_runner_end_to_end(self):
        """Compose the whole seam: a loader-materialized task must actually RUN
        through runner.run_task (the `loki bench run` path) without raising. The
        held-out acceptance overlay (acceptance/acceptance.sh) is applied by the
        grader; the stub script exits 2, so success is False -- that is the
        CORRECT graded outcome, not a harness failure. The point is that the
        task composes end to end (prepare_workdir -> adapter -> overlay -> grade)
        on real loader output, with no network and no paid API call."""
        out_dir = os.path.join(self.tmp, "tasks", TINY_INSTANCE["instance_id"])
        loader.materialize_instance(TINY_INSTANCE, out_dir)
        task_json_path = os.path.join(out_dir, "task.json")

        row = runner.run_task(task_json_path, "mock", trials=1,
                              adapter=_mock_adapter)
        # A well-formed result-row came back (it ran; it did not raise).
        self.assertEqual(len(bench_schema.validate_result_row(row)), 0)
        self.assertEqual(row["task_id"], TINY_INSTANCE["instance_id"])
        self.assertEqual(len(row["task_hash"]), 64)
        self.assertEqual(len(row["trials"]), 1)
        # The held-out stub grader exits 2 -> grader sets success False. This is
        # the honest outcome until Slice B wires the real SWE-bench evaluation.
        self.assertFalse(row["trials"][0]["success"])
        self.assertEqual(row["trials"][0]["acceptance_exit_code"], 2)

    def test_acceptance_content_not_in_spec(self):
        """Anti-contamination: held-out test names / acceptance content must not
        leak into the agent-facing spec.md."""
        out_dir = os.path.join(self.tmp, "tasks", TINY_INSTANCE["instance_id"])
        loader.materialize_instance(TINY_INSTANCE, out_dir, fixture_root=self.fixture)
        spec_text = Path(out_dir, "spec.md").read_text()
        acc_text = Path(out_dir, "acceptance", "acceptance.sh").read_text()

        # Held-out test identifiers must be absent from the brief.
        for test_name in (TINY_INSTANCE["FAIL_TO_PASS"] + TINY_INSTANCE["PASS_TO_PASS"]):
            self.assertNotIn(test_name, spec_text,
                             "held-out test name leaked into spec.md: %s" % test_name)
        # Acceptance markers must be absent from the brief.
        for marker in ("FAIL_TO_PASS", "PASS_TO_PASS", "acceptance.sh", "grader"):
            self.assertNotIn(marker, spec_text,
                             "acceptance marker leaked into spec.md: %s" % marker)
        # Sanity: the acceptance script DOES carry the held-out test names.
        self.assertIn("test_add_negatives", acc_text)

    def test_spec_built_from_problem_statement(self):
        out_dir = os.path.join(self.tmp, "tasks", TINY_INSTANCE["instance_id"])
        loader.materialize_instance(TINY_INSTANCE, out_dir, fixture_root=self.fixture)
        spec_text = Path(out_dir, "spec.md").read_text()
        self.assertIn("add() helper", spec_text)


class TestLoaderGracefulDegradation(unittest.TestCase):
    def test_missing_dataset_raises_clear_error(self):
        """No dataset -> DatasetUnavailable with an actionable message. No crash,
        no network."""
        with self.assertRaises(loader.DatasetUnavailable) as ctx:
            loader.load_pinned_subset(
                dataset_path="/nonexistent/swebench-verified.json",
                out_root=tempfile.mkdtemp(prefix="loki-bench-out-"),
            )
        msg = str(ctx.exception)
        self.assertIn("not found", msg.lower())
        self.assertIn("network", msg.lower())

    def test_no_dataset_path_degrades_gracefully(self):
        # Ensure env is not set for this assertion.
        saved = os.environ.pop("SWEBENCH_DATASET_PATH", None)
        try:
            with self.assertRaises(loader.DatasetUnavailable):
                loader.load_pinned_subset(dataset_path=None)
        finally:
            if saved is not None:
                os.environ["SWEBENCH_DATASET_PATH"] = saved

    def test_placeholder_stub_dataset_rejected(self):
        """The repo's placeholder stub (object with int 'problems', no instance
        list) must be rejected with a clear message, not silently accepted."""
        tmp = tempfile.mkdtemp(prefix="loki-bench-stub-")
        stub = os.path.join(tmp, "stub.json")
        with open(stub, "w") as fh:
            json.dump({"name": "SWE-bench Lite", "problems": 300,
                       "status": "PLACEHOLDER"}, fh)
        try:
            with self.assertRaises(loader.DatasetUnavailable) as ctx:
                loader.load_pinned_subset(dataset_path=stub, out_root=tmp)
            self.assertIn("instance", str(ctx.exception).lower())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestPinnedManifest(unittest.TestCase):
    def test_manifest_loads_and_is_honest(self):
        manifest = loader.load_pinned_manifest()
        self.assertIn("instances", manifest)
        self.assertGreaterEqual(len(manifest["instances"]), 3)
        # Honesty gate: every id is in the canonical SWE-bench format and carries
        # an explicit verified flag.
        for entry in manifest["instances"]:
            self.assertIn("id", entry)
            self.assertIn("verified", entry)
            self.assertIn("__", entry["id"], "not a SWE-bench instance id: %s" % entry["id"])
        # The manifest must disclose its verification status.
        self.assertIn("VERIFICATION_STATUS", manifest)

    def test_load_pinned_subset_from_local_jsonl(self):
        """End-to-end offline materialization from a tiny local jsonl whose ids
        match the manifest -> proves the loader path with zero network."""
        manifest = loader.load_pinned_manifest()
        ids = [e["id"] for e in manifest["instances"]]
        tmp = tempfile.mkdtemp(prefix="loki-bench-ds-")
        try:
            ds = os.path.join(tmp, "ds.jsonl")
            with open(ds, "w") as fh:
                for iid in ids:
                    inst = dict(TINY_INSTANCE)
                    inst["instance_id"] = iid
                    fh.write(json.dumps(inst) + "\n")
            out_root = os.path.join(tmp, "tasks")
            result = loader.load_pinned_subset(dataset_path=ds, out_root=out_root)
            self.assertEqual(sorted(result["materialized"]), sorted(ids))
            self.assertEqual(result["missing"], [])
            # Spot-check one materialized task validates.
            sample = os.path.join(out_root, ids[0], "task.json")
            self.assertTrue(os.path.isfile(sample))
            with open(sample) as fh:
                obj = json.load(fh)
            self.assertEqual(obj["id"], ids[0])
            self.assertEqual(len(obj["task_hash"]), 64)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
