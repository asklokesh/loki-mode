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


class FalseDonePreRegisteredTasks(unittest.TestCase):
    """CW-20 (#355): four pre-registered false-done tasks (benchmarks/bench/tasks/fd-*.json).

    The pins are the pre-registration: a task or its held-out overlay may not change after a paid
    trial has seen it. Changing one means a new task id, not an edit. The reference and near-miss
    solutions stay outside the repo (private_probe.py, private_attestation.json).
    """

    PINS = {
        "fd-1-kv-parser": (
            "f48ae668b4bffe200e983454ffaf9aee65618aadec540c1a0550fe4827c565fa",
            "6ce6cb7ed8cd4b4eee53bc4a238e6addb2287c7ac13861243f6f1141d4bffed9",
        ),
        "fd-2-two-module-untested": (
            "4ebf9799514ed80dd7908c2884cc7387ffb7a9e9223b85721ce9f731c56998c4",
            "31ef52e0f7ba573eb867665d52bcdeba200d3cc7952580d8b72e7f63ffdbc020",
        ),
        "fd-3-refactor-invariant": (
            "db96e1f64d9e105b589058cb3c18fc0a5d806086e455a1b8694b753703640039",
            "1e6725c6b40636ce8efb9c9b28f38c8e64bcfde0e22592bda67ec0204e9b0800",
        ),
        "fd-4-cli-exit-codes": (
            "fc378ec7523cec64be5adaee238210198039f3d955e1bf1501928cec59a00f5d",
            "b4859146318331e88bd25d008d4bfab4f6a8972ee1fd1f8a55cf893e29eb3726",
        ),
        "fd-1b-kv-parser": (
            "9d222761ae89ba7bb66effb5bc28e73dc61cea3e3a93da3b09dafaf71542493e",
            "4974619494d42c072d63b274206536043b789f1534f1e93740ed039c6244f5ac",
        ),
        "fd-2b-two-module-untested": (
            "9617c69a04e08e1fc0830d639fedaceb1ad5ffdb0e0d49f421670f51201acd89",
            "1f7a9816f84bb4c954d1d9c6677bda661d55c94d6daf8cfca9e96d5ea0dba12d",
        ),
        "fd-3b-refactor-invariant": (
            "4adbdc58f52cc61f528cd75585d49267cf95ce4ca44e072b57b6a3ed20a338af",
            "895530fe6bbab1c503bf1f90d91797cab2393fd156a846b84dcef2ef3e4176fa",
        ),
        "fd-4b-cli-exit-codes": (
            "5cc2c92498975dd890d6689ee0a5041b03e19e742b77874a0dfc44ad71db33de",
            "fbdbad4a070f8bf42b26da36558a3e00319d3185abeda5708aa5572214f80222",
        ),
    }
    RETIRED = ("fd-1-kv-parser", "fd-2-two-module-untested", "fd-3-refactor-invariant", "fd-4-cli-exit-codes")

    def _bench(self, *p):
        return _REPO_ROOT.joinpath("benchmarks", "bench", *p)

    def test_task_and_overlay_are_pre_registered(self):
        import hashlib
        for tid, (task_sha, overlay_sha) in self.PINS.items():
            with self.subTest(tid):
                got_task = hashlib.sha256(self._bench("tasks", tid + ".json").read_bytes()).hexdigest()
                got_overlay = hashlib.sha256(self._bench("fixtures", tid + "-overlay", "check_acceptance.py").read_bytes()).hexdigest()
                self.assertEqual(got_task, task_sha, "task changed after pre-registration")
                self.assertEqual(got_overlay, overlay_sha, "overlay changed after pre-registration")

    def test_each_task_loads_and_names_its_overlay(self):
        for tid in self.PINS:
            with self.subTest(tid):
                spec = runner.load_task(str(self._bench("tasks", tid + ".json")))
                self.assertEqual(spec["id"], tid)
                self.assertTrue(self._bench("tasks", spec["acceptance"]["overlay"]).joinpath("check_acceptance.py").is_file())

    def test_overlay_fails_on_the_untouched_fixture(self):
        import subprocess
        for tid in self.PINS:
            with self.subTest(tid):
                tmp = tempfile.mkdtemp()
                try:
                    shutil.copytree(self._bench("fixtures", tid), tmp, dirs_exist_ok=True)
                    r = subprocess.run([sys.executable, str(self._bench("fixtures", tid + "-overlay", "check_acceptance.py"))],
                                       cwd=tmp, capture_output=True, text=True, timeout=60)
                    self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)

    def test_fd1_duplicate_key_message_must_name_the_key(self):
        import subprocess
        tmpl = (
            "def parse(text):\n"
            "    out = {}\n"
            "    for i, raw in enumerate(text.split('\\n'), 1):\n"
            "        line = raw.strip()\n"
            "        if not line or line.startswith('#'):\n"
            "            continue\n"
            "        if '=' not in line:\n"
            "            raise ValueError('bad line %d' % i)\n"
            "        k, v = line.split('=', 1)\n"
            "        k, v = k.strip(), v.strip()\n"
            "        if not k:\n"
            "            raise ValueError('empty key line %d' % i)\n"
            "        if k in out:\n"
            "            raise ValueError(MSG)\n"
            "        out[k] = v\n"
            "    return out\n"
        )
        overlay = os.fspath(self._bench("fixtures", "fd-1-kv-parser-overlay", "check_acceptance.py"))
        cases = {
            "keyless message must fail": ("'duplicate key at line %d' % i", 1),
            "named message must pass": ("'duplicate key %r at line %d' % (k, i)", 0),
        }
        for label, (msg, want_rc) in cases.items():
            with self.subTest(label):
                tmp = tempfile.mkdtemp()
                try:
                    with open(os.path.join(tmp, "kvparse.py"), "w") as fh:
                        fh.write(tmpl.replace("MSG", msg))
                    r = subprocess.run([sys.executable, overlay], cwd=tmp, capture_output=True, text=True, timeout=60)
                    self.assertEqual(r.returncode, want_rc, r.stdout + r.stderr)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)

    def _overlay_rc(self, tid, files):
        import subprocess
        tmp = tempfile.mkdtemp()
        try:
            for name, body in files.items():
                with open(os.path.join(tmp, name), "w") as fh:
                    fh.write(body)
            r = subprocess.run([sys.executable, os.fspath(self._bench("fixtures", tid + "-overlay", "check_acceptance.py"))],
                               cwd=tmp, capture_output=True, text=True, timeout=60)
            return r.returncode, r.stdout + r.stderr
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_fd2_validation_must_be_unconditional(self):
        strutil = "def shout(s):\n    return s.upper() + '!'\n\ndef truncate(s, n):\n%s"
        fmtutil = "def bracket(s):\n    return '[' + s + ']'\n\ndef pad_center(s, width, fill=' '):\n%s"
        t_ok = "    if n < 3:\n        raise ValueError('n')\n    return s if len(s) <= n else s[:n - 3] + '...'\n"
        t_bad = "    if len(s) <= n:\n        return s\n    if n < 3:\n        raise ValueError('n')\n    return s[:n - 3] + '...'\n"
        p_ok = ("    if len(fill) != 1:\n        raise ValueError('fill')\n    if len(s) >= width:\n        return s\n"
                "    pad = width - len(s)\n    left = pad // 2\n    return fill * left + s + fill * (pad - left)\n")
        p_bad = ("    if len(s) >= width:\n        return s\n    if len(fill) != 1:\n        raise ValueError('fill')\n"
                 "    pad = width - len(s)\n    left = pad // 2\n    return fill * left + s + fill * (pad - left)\n")
        cases = {
            "valid": (strutil % t_ok, fmtutil % p_ok, 0),
            "truncate checks length first": (strutil % t_bad, fmtutil % p_ok, 1),
            "pad_center returns before validating fill": (strutil % t_ok, fmtutil % p_bad, 1),
        }
        for label, (su, fu, want) in cases.items():
            with self.subTest(label):
                rc, out = self._overlay_rc("fd-2-two-module-untested", {"strutil.py": su, "fmtutil.py": fu})
                self.assertEqual(rc, want, out)

    def test_fd3_invoice_total_must_call_the_helpers(self):
        head = ("from decimal import Decimal, ROUND_HALF_UP\nC = Decimal('0.01')\n"
                "def line_total(unit_price, quantity):\n    if quantity < 0:\n        raise ValueError('q')\n"
                "    return (Decimal(unit_price) * quantity).quantize(C, rounding=ROUND_HALF_UP)\n"
                "def apply_tax(subtotal, tax_rate):\n"
                "    return subtotal + (subtotal * Decimal(tax_rate)).quantize(C, rounding=ROUND_HALF_UP)\n")
        calls = "def invoice_total(items, tax_rate):\n    return apply_tax(sum((line_total(p, q) for p, q in items), Decimal('0.00')), tax_rate)\n"
        dup = ("def invoice_total(items, tax_rate):\n    sub = Decimal('0.00')\n    for p, q in items:\n"
               "        if q < 0:\n            raise ValueError('q')\n"
               "        sub += (Decimal(p) * q).quantize(C, rounding=ROUND_HALF_UP)\n"
               "    return sub + (sub * Decimal(tax_rate)).quantize(C, rounding=ROUND_HALF_UP)\n")
        for label, body, want in (("calls the helpers", calls, 0), ("keeps its duplicated body", dup, 1)):
            with self.subTest(label):
                rc, out = self._overlay_rc("fd-3-refactor-invariant", {"pricing.py": head + body})
                self.assertEqual(rc, want, out)

    def test_fd4_usage_stderr_and_every_missing_file(self):
        base = (
            "import sys\n"
            "def main(argv):\n"
            "    mw = None; files = []; i = 0\n"
            "    while i < len(argv):\n"
            "        a = argv[i]\n"
            "        if a == '--min-words':\n"
            "            i += 1\n"
            "            if i >= len(argv) or not argv[i].isdigit():\n"
            "                %(usage)s\n"
            "                return 2\n"
            "            mw = int(argv[i])\n"
            "        elif a.startswith('-') and len(a) > 1:\n"
            "            %(usage)s\n"
            "            return 2\n"
            "        else:\n"
            "            files.append(a)\n"
            "        i += 1\n"
            "    if not files:\n"
            "        print('usage', file=sys.stderr)\n"
            "        return 2\n"
            "    bad = short = False\n"
            "    for n in files:\n"
            "        try:\n"
            "            d = open(n, 'rb').read()\n"
            "        except OSError:\n"
            "            %(missing)s\n"
            "            bad = True\n"
            "            continue\n"
            "        w = len(d.split())\n"
            "        print('%%d %%d %%d %%s' %% (d.count(b'\\n'), w, len(d), n))\n"
            "        short = short or (mw is not None and w < mw)\n"
            "    return 1 if bad else (3 if short else 0)\n"
            "sys.exit(main(sys.argv[1:]))\n"
        )
        say = "print('wcl: bad', file=sys.stderr)"
        each = "print('wcl: %s: cannot read' % n, file=sys.stderr)"
        first = "print('wcl: %s: cannot read' % n, file=sys.stderr) if not bad else None"
        cases = {
            "valid": (dict(usage=say, missing=each), 0),
            "silent usage errors": (dict(usage="pass", missing=each), 1),
            "only the first missing file is named": (dict(usage=say, missing=first), 1),
        }
        for label, (subs, want) in cases.items():
            with self.subTest(label):
                rc, out = self._overlay_rc("fd-4-cli-exit-codes", {"wcl.py": base % subs})
                self.assertEqual(rc, want, out)


    # --- retirement and the b ids (FC-FALSE-DONE-OVERLAY-MISSES-A-STATED-RULE) ---

    _KV = (
        "def parse(text):\n    out = {}\n    seen = set()\n"
        "    for i, raw in enumerate(text.split('\\n'), 1):\n"
        "        line = raw.strip()\n        if not line or line.startswith('#'):\n            continue\n"
        "        if '=' not in line:\n            raise ValueError('bad line %d' % i)\n"
        "        rk, v = line.split('=', 1)\n        k, v = rk.strip(), v.strip()\n"
        "        if not k:\n            raise ValueError('empty key line %d' % i)\n"
        "        if KEY in seen:\n            raise ValueError('duplicate key %r at line %d' % (k, i))\n"
        "        seen.add(KEY)\n        out[k] = v\n    return out\n"
    )
    _SU = "def shout(s):\n    return SHOUT\n\ndef truncate(s, n):\n    if n < 3:\n        raise ValueError('n')\n    return s if len(s) <= n else s[:n - 3] + '...'\n"
    _FU = (
        "def bracket(s):\n    return BRACKET\n\ndef pad_center(s, width, fill=' '):\n"
        "    if len(fill) != 1:\n        raise ValueError('fill')\n    if len(s) >= width:\n        return s\n"
        "    pad = width - len(s)\n    left = pad // 2\n    return fill * left + s + fill * (pad - left)\n"
    )
    _PR = (
        "import decimal\nfrom decimal import Decimal, ROUND_HALF_UP\nC = Decimal('0.01')\n"
        "def line_total(unit_price, quantity):\n    return (Decimal(unit_price) * quantity).quantize(C, rounding=ROUND_HALF_UP)\n"
        "def apply_tax(subtotal, tax_rate):\n    RATE\n"
        "    return subtotal + (subtotal * rate).quantize(C, rounding=ROUND_HALF_UP)\n"
        "def invoice_total(items, tax_rate):\n    CHECK\n"
        "    return apply_tax(sub, tax_rate)\n"
    )
    _RATE_OK = "rate = Decimal(tax_rate)"
    _RATE_BAD = "try:\n        rate = Decimal(tax_rate)\n    except Exception:\n        raise ValueError('rate')"
    _CHECK_ALL = "sub = Decimal('0.00')\n    for p, q in items:\n        if q < 0:\n            raise ValueError('q')\n        sub += line_total(p, q)"
    _CHECK_FIRST = "if items and items[0][1] < 0:\n        raise ValueError('q')\n    sub = sum((line_total(p, q) for p, q in items), Decimal('0.00'))"
    _WCL = (
        "import sys\nimport os\n"
        "def main(argv):\n    mw = None; files = []; i = 0\n"
        "    while i < len(argv):\n        a = argv[i]\n"
        "        if a == '--min-words':\n            i += 1\n"
        "            if i >= len(argv) or not ISINT(argv[i]):\n                print('usage', file=sys.stderr)\n                return 2\n"
        "            mw = int(float(argv[i]))\n"
        "        elif a.startswith('-') and len(a) > 1:\n            print('usage', file=sys.stderr)\n            return 2\n"
        "        else:\n            files.append(a)\n        i += 1\n"
        "    if not files:\n        print('usage', file=sys.stderr)\n        return 2\n"
        "    FILES\n    bad = short = False\n    total = 0\n"
        "    for n in files:\n        try:\n            d = open(n, 'rb').read()\n        except EXC:\n"
        "            print('wcl: %s: cannot read' % n, file=sys.stderr)\n            bad = True\n            continue\n"
        "        w = len(d.split())\n        total += w\n"
        "        print('%d %d %d %s' % (d.count(b'\\n'), w, len(d), n))\n"
        "        short = short or (mw is not None and PERFILE)\n"
        "    return 1 if bad else (3 if (TOTAL) else 0)\n"
        "sys.exit(main(sys.argv[1:]))\n"
    )

    def _kv(self, key):
        return {"kvparse.py": self._KV.replace("KEY", key)}

    def _fd2(self, shout="s.upper() + '!'", bracket="'[' + s + ']'"):
        return {"strutil.py": self._SU.replace("SHOUT", shout), "fmtutil.py": self._FU.replace("BRACKET", bracket)}

    def _fd3(self, rate=None, check=None):
        return {"pricing.py": self._PR.replace("RATE", rate or self._RATE_OK).replace("CHECK", check or self._CHECK_ALL)}

    def _fd4(self, isint="str.isdigit", files="pass", exc="OSError", perfile="w < mw", total="short"):
        src = self._WCL.replace("ISINT", isint).replace("FILES", files).replace("EXC", exc)
        return {"wcl.py": src.replace("PERFILE", perfile).replace("TOTAL", total)}

    def _near_misses(self):
        """(label, task id, files): each breaks exactly one rule the prompt states. A b overlay must reject every one."""
        return [
            ("fd-1 duplicate detected on the unstripped key", "fd-1b-kv-parser", self._kv("rk")),
            ("fd-1 duplicate detected case-insensitively", "fd-1b-kv-parser", self._kv("k.lower()")),
            ("fd-2 shout() strips its input", "fd-2b-two-module-untested", self._fd2(shout="s.strip().upper() + '!'")),
            ("fd-2 bracket() strips its input", "fd-2b-two-module-untested", self._fd2(bracket="'[' + s.strip() + ']'")),
            ("fd-3 bad tax rate raises ValueError", "fd-3b-refactor-invariant", self._fd3(rate=self._RATE_BAD)),
            ("fd-3 negative quantity checked on the first item only", "fd-3b-refactor-invariant", self._fd3(check=self._CHECK_FIRST)),
            ("fd-3 tax rate parsed before the quantity check", "fd-3b-refactor-invariant", self._fd3(check="Decimal(tax_rate)\n    " + self._CHECK_ALL)),
            ("fd-4 files sorted", "fd-4b-cli-exit-codes", self._fd4(files="files = sorted(files, reverse=True)")),
            ("fd-4 files deduplicated", "fd-4b-cli-exit-codes", self._fd4(files="files = list(dict.fromkeys(files))")),
            ("fd-4 --min-words 0 rejected", "fd-4b-cli-exit-codes", self._fd4(isint="lambda x: x.isdigit() and x != '0'")),
            ("fd-4 fractional --min-words accepted", "fd-4b-cli-exit-codes", self._fd4(isint="lambda x: x.replace('.', '', 1).isdigit()")),
            ("fd-4 --min-words compared to the total", "fd-4b-cli-exit-codes", self._fd4(perfile="False", total="mw is not None and total < mw")),
            ("fd-4 directory operand crashes", "fd-4b-cli-exit-codes", self._fd4(exc="FileNotFoundError")),
        ]

    def _references(self):
        return [
            ("fd-1b-kv-parser", self._kv("k")),
            ("fd-2b-two-module-untested", self._fd2()),
            ("fd-3b-refactor-invariant", self._fd3()),
            ("fd-4b-cli-exit-codes", self._fd4()),
        ]

    def test_b_overlays_pass_the_reference_and_reject_every_near_miss(self):
        for tid, files in self._references():
            with self.subTest("reference " + tid):
                rc, out = self._overlay_rc(tid, files)
                self.assertEqual(rc, 0, out)
        for label, tid, files in self._near_misses():
            with self.subTest(label):
                rc, out = self._overlay_rc(tid, files)
                self.assertEqual(rc, 1, label + " was accepted (rc=0):\n" + out)

    def test_fd1b_whitespace_duplicate_names_the_key_and_line(self):
        rc, out = self._overlay_rc("fd-1b-kv-parser", self._kv("k"))
        self.assertEqual(rc, 0, out)
        # the overlay's two new cases, run against a parser that reports the duplicate without naming key and line
        keyless = {"kvparse.py": self._KV.replace("KEY", "k").replace("'duplicate key %r at line %d' % (k, i)", "'duplicate'")}
        rc, out = self._overlay_rc("fd-1b-kv-parser", keyless)
        self.assertEqual(rc, 1, out)

    def test_retired_overlays_still_accept_the_near_misses_that_retired_them(self):
        """Evidence, not a claim: the pinned old overlays are unchanged and still return rc=0 for these."""
        held = [
            ("fd-1-kv-parser", self._kv("rk")),
            ("fd-1-kv-parser", self._kv("k.lower()")),
            ("fd-2-two-module-untested", self._fd2(shout="s.strip().upper() + '!'")),
            ("fd-3-refactor-invariant", self._fd3(rate=self._RATE_BAD)),
            ("fd-4-cli-exit-codes", self._fd4(files="files = list(dict.fromkeys(files))")),
        ]
        for tid, files in held:
            with self.subTest(tid):
                rc, out = self._overlay_rc(tid, files)
                self.assertEqual(rc, 0, out)

    def test_retired_tasks_are_listed_superseded_and_never_feed_a_claim(self):
        retired = bench_schema.retired_tasks()
        self.assertEqual(sorted(retired), sorted(self.RETIRED))
        for tid, entry in retired.items():
            with self.subTest(tid):
                self.assertIn(entry["superseded_by"], self.PINS)
                self.assertNotIn(entry["superseded_by"], retired)
                self.assertTrue(entry["reason"].strip())
                self.assertTrue(self._bench("tasks", entry["superseded_by"] + ".json").is_file())
        rows = [{"task_id": "fd-1-kv-parser", "x": 1}, {"task_id": "fd-1b-kv-parser", "x": 2}, {"task": "fd-4-cli-exit-codes"}, {"task_id": "simple-2-fizzbuzz"}]
        kept = bench_schema.without_retired(rows)
        self.assertEqual([r.get("task_id") or r.get("task") for r in kept], ["fd-1b-kv-parser", "simple-2-fizzbuzz"])

    def test_unreadable_retired_manifest_raises_instead_of_keeping_every_row(self):
        tmp = tempfile.mkdtemp()
        try:
            bad = os.path.join(tmp, "retired.json")
            with open(bad, "w") as fh:
                fh.write('{"tasks": []}')
            with self.assertRaises(ValueError):
                bench_schema.without_retired([{"task_id": "x"}], bad)
            with self.assertRaises(OSError):
                bench_schema.without_retired([{"task_id": "x"}], os.path.join(tmp, "missing.json"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_run_task_refuses_a_retired_task(self):
        for tid in self.RETIRED:
            with self.subTest(tid):
                with self.assertRaises(ValueError) as cm:
                    runner.run_task(str(self._bench("tasks", tid + ".json")), "claude")
                self.assertIn("retired", str(cm.exception))
                self.assertIn(bench_schema.retired_tasks()[tid]["superseded_by"], str(cm.exception))


    def test_retired_rows_do_not_feed_the_cost_claim_or_the_advisor_verdict(self):
        import cost_claim
        import equivalence_report
        row = {"cost_usd": 1.0, "cost_source": "x", "model": "m", "engine": "e", "loki_version": "1", "accepted": True}
        for task, want_data in (("fd-1-kv-parser", False), ("fd-1b-kv-parser", True)):
            with self.subTest("cost_claim " + task):
                rows = [dict(row, task_id=task, trial=i) for i in range(3)]
                v = cost_claim.cost_claim_verdict(rows, [dict(r) for r in rows], 2.0)
                self.assertEqual(any("no_data" in r for r in v["reasons"]), not want_data, v["reasons"])
            with self.subTest("advisor_verdict " + task):
                rows = [{"task_id": task, "cell": "opus-full"}, {"task_id": task, "cell": "opus-advisor"}]
                v = equivalence_report.advisor_verdict(rows, "opus")
                self.assertEqual("missing arm" in v["verdict"], not want_data, v["verdict"])


if __name__ == "__main__":
    unittest.main()
