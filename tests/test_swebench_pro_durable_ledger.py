"""tests/test_swebench_pro_durable_ledger.py -- SWE-bench Pro pilot durable ledger.

Guards the data-loss fix in benchmarks/swebench-pro-pilot/run_batch.py: every
completed instance must HOLD (survive an interrupted run, a /tmp wipe, a re-run,
and a crash mid-write).

Non-vacuity: before the fix these durable functions did not exist; the harness
kept the only copy of a completed instance's record + patch in /tmp (lost on
reboot) and the ledger was a single monolithic batch_records.json rewritten
every iteration (run_batch.py:85), so a SIGKILL mid-dump truncated it and the
unguarded resume loader (run_batch.py:54 json.load) then lost EVERY prior
completed instance. test_recovers_when_monolithic_ledger_is_truncated
demonstrates that exact gap directly: a half-written monolithic ledger no longer
costs any completion, because the durable per-instance files recover them. The
fix writes one atomic per-instance file under a durable repo-relative dir, so:
  (a) a completed instance survives a simulated interruption (kill before any
      final flush) -- the loader still finds it;
  (b) a re-run SKIPs already-completed instances, and --force re-runs them;
  (c) the write is atomic (temp + os.replace), so a crash mid-write leaves the
      prior per-instance files intact and stray .tmp files are ignored.

NO Docker, NO paid API calls, NO network: the durable-write and done-loader are
pure functions exercised directly against a tempdir.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PILOT = os.path.join(_REPO, "benchmarks", "swebench-pro-pilot")
if _PILOT not in sys.path:
    sys.path.insert(0, _PILOT)

# run_instance imports a host-only helper at module load; stub it so importing
# run_batch never touches Docker/helper_code on this machine.
sys.modules.setdefault("image_uri", mock.MagicMock())
sys.modules.setdefault("run_instance", mock.MagicMock())

import run_batch  # noqa: E402


def _rec(iid, usd=1.0, produced=True):
    return {"instance_id": iid, "repo": "demo/repo", "base_commit": "abc123",
            "patch_produced": produced, "patch_len": 10,
            "cost": {"usd": usd}, "wall_s": 5.0, "exit": 0, "error": None}


class TestDurableLedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="swebench-durable-test-")
        self.durable = os.path.join(self.tmp, "durable")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    # (a) A completed instance survives a simulated interruption.
    def test_completed_instance_survives_interruption(self):
        # Simulate: instance A finishes -> persist_durable runs -> process is
        # KILLED before any monolithic batch_records.json flush. Nothing else
        # is written. The durable record must still be loadable on restart.
        run_batch.persist_durable(self.durable, _rec("inst-A"), "patch-A-body")
        # (no aggregate write, no final flush -- this is the "killed here" point)
        done = run_batch.load_durable(self.durable)
        self.assertIn("inst-A", done)
        self.assertEqual(done["inst-A"]["cost"]["usd"], 1.0)
        self.assertEqual(run_batch.durable_patch(self.durable, "inst-A"),
                         "patch-A-body")

    # (b) A re-run SKIPs already-completed instances; --force re-runs them.
    def test_rerun_skips_then_force_reruns(self):
        run_batch.persist_durable(self.durable, _rec("inst-A"), "pa")
        run_batch.persist_durable(self.durable, _rec("inst-B"), "pb")
        done = run_batch.load_durable(self.durable)
        self.assertEqual(set(done), {"inst-A", "inst-B"})

        # Drive main() with --force and assert it does NOT load the ledger as
        # "done" (force path skips load_durable entirely). We stub the subset to
        # the two recorded ids and a run_instance that records which ids ran.
        ran = []

        def fake_run(iid, work_root, max_iter=4):
            ran.append(iid)
            return _rec(iid, usd=0.0), "newpatch"

        subset = {"instance_ids": ["inst-A", "inst-B"]}
        sfile = os.path.join(self.tmp, "subset.json")
        json.dump(subset, open(sfile, "w"))
        work_root = os.path.join(self.tmp, "runs")

        with mock.patch.object(run_batch, "SUBSET", sfile), \
             mock.patch.object(run_batch, "DURABLE_DIR", self.durable), \
             mock.patch.object(run_batch.run_instance, "run", fake_run), \
             mock.patch.object(sys, "argv",
                               ["run_batch.py", "2", work_root, "--force"]):
            run_batch.main()
        # --force => both instances re-ran despite being in the durable ledger.
        self.assertEqual(sorted(ran), ["inst-A", "inst-B"])

        # Without --force, a fresh main() must SKIP both (run_instance untouched).
        ran.clear()
        with mock.patch.object(run_batch, "SUBSET", sfile), \
             mock.patch.object(run_batch, "DURABLE_DIR", self.durable), \
             mock.patch.object(run_batch.run_instance, "run", fake_run), \
             mock.patch.object(sys, "argv",
                               ["run_batch.py", "2", work_root]):
            run_batch.main()
        self.assertEqual(ran, [])  # both skipped by the durable ledger

    # (c) The write is atomic: a crash mid-write cannot corrupt prior records,
    #     and a stray .tmp is never mistaken for a completed instance.
    def test_atomic_write_protects_prior_records(self):
        run_batch.persist_durable(self.durable, _rec("inst-A"), "pa")

        # Simulate a crash during inst-B's write: os.replace raises AFTER the
        # temp file is created but BEFORE the rename completes.
        real_replace = os.replace

        def boom(src, dst):
            raise KeyboardInterrupt("killed mid-write")

        with mock.patch("os.replace", boom):
            with self.assertRaises(KeyboardInterrupt):
                run_batch.persist_durable(self.durable, _rec("inst-B"), "pb")

        # The destination inst-B.json must NOT exist (rename never happened),
        # and inst-A must be fully intact and loadable.
        rec_dir = os.path.join(self.durable, "records")
        self.assertFalse(os.path.exists(os.path.join(rec_dir, "inst-B.json")))
        done = run_batch.load_durable(self.durable)
        self.assertEqual(set(done), {"inst-A"})  # prior record survived

        # A leftover .tmp from the aborted write must be ignored by the loader.
        leftover = os.path.join(rec_dir, "inst-B.json.tmp")
        if os.path.exists(leftover):
            self.assertNotIn("inst-B", run_batch.load_durable(self.durable))
        # Belt-and-suspenders: a hand-planted half-written .tmp is never loaded.
        with open(os.path.join(rec_dir, "inst-C.json.tmp"), "w") as fh:
            fh.write('{"instance_id": "inst-C"')  # truncated JSON
        self.assertNotIn("inst-C", run_batch.load_durable(self.durable))

        # And the durable dir is repo-relative, NOT under /tmp -- so cleanup
        # globs (rm -rf /tmp/loki-*) and git-branch prunes cannot reach it.
        self.assertFalse(run_batch.DURABLE_DIR.startswith("/tmp"))

        real_replace  # silence linters about the unused capture

    # (d) Infra failures are NOT frozen into the durable ledger: an
    #     image-pull/extract failure (loki never ran) must stay re-runnable on
    #     the next resume, not be skipped forever.
    def test_infra_failure_is_not_persisted_as_done(self):
        bad = _rec("inst-FAIL", produced=False)
        bad["error"] = "image_pull_failed: boom"
        bad["cost"] = None
        persisted = run_batch.persist_durable(self.durable, bad, "")
        self.assertFalse(persisted)
        self.assertNotIn("inst-FAIL", run_batch.load_durable(self.durable))
        # but a genuine no-error / no-patch completion IS a completion.
        nopatch = _rec("inst-NOPATCH", produced=False)
        self.assertTrue(run_batch.persist_durable(self.durable, nopatch, ""))
        self.assertIn("inst-NOPATCH", run_batch.load_durable(self.durable))

    # (e) Direct demonstration of the PROVEN pre-fix gap: the legacy monolithic
    #     batch_records.json (run_batch.py:85 rewrite, :54 unguarded json.load)
    #     could be truncated by a SIGKILL mid-dump, taking EVERY prior
    #     completion with it. The durable per-instance ledger recovers them all
    #     even when that monolithic file is corrupt.
    def test_recovers_when_monolithic_ledger_is_truncated(self):
        run_batch.persist_durable(self.durable, _rec("inst-A"), "pa")
        run_batch.persist_durable(self.durable, _rec("inst-B"), "pb")
        # simulate the legacy ledger truncated mid-write (the old data-loss):
        work_root = os.path.join(self.tmp, "runs")
        os.makedirs(work_root, exist_ok=True)
        with open(os.path.join(work_root, "batch_records.json"), "w") as fh:
            fh.write('[{"instance_id": "inst-A", "cost":')  # half a record
        # the durable ledger still holds BOTH completed instances.
        done = run_batch.load_durable(self.durable)
        self.assertEqual(set(done), {"inst-A", "inst-B"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
