"""tests/dashboard/test_migration_progress_unknown.py

S-150 / BACKLOG 118: get_progress() reported 0/0 for features and steps
whether the features.json / migration-plan.json file was missing, corrupt,
or a real, valid, empty plan -- three different states collapsed into one
number a consumer cannot tell apart. A missing or corrupt file now returns
None counts plus a "reason" string; a real empty plan still returns 0 with
no reason key, which is the control proving the fix does not just null
everything out.

Consumers checked (this slice touches ONLY get_progress in
dashboard/migration_engine.py, per S-150 scope):

- dashboard/server.py's GET /api/migration/{id}/status returns
  pipeline.get_progress() with no response_model/Pydantic schema, so a
  None count serializes to JSON null without a validation error.
- The legacy dashboard UI that consumed this (removed in CPE-24) guarded on
  `!total || x == null` before dividing; any client must treat null as unknown.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from dashboard import migration_engine as me
from dashboard.migration_engine import MigrationPipeline


class _PinnedMigrationsDir:
    """Pin migration_engine.MIGRATIONS_DIR to a tmp for the test body."""

    def __init__(self, tmp_migrations: str):
        self.tmp = tmp_migrations
        self._orig = None

    def __enter__(self):
        self._orig = me.MIGRATIONS_DIR
        me.MIGRATIONS_DIR = self.tmp
        return self

    def __exit__(self, exc_type, exc, tb):
        me.MIGRATIONS_DIR = self._orig


class MigrationProgressUnknownCounts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-mig-progress-")
        self.codebase = os.path.join(self.tmp, "legacy_app")
        os.makedirs(self.codebase, exist_ok=True)
        self.migrations_dir = os.path.join(self.tmp, "migrations")
        os.makedirs(self.migrations_dir, exist_ok=True)
        self._pin = _PinnedMigrationsDir(self.migrations_dir)
        self._pin.__enter__()

    def tearDown(self):
        self._pin.__exit__(None, None, None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _new_pipeline(self) -> MigrationPipeline:
        pipeline = MigrationPipeline(codebase_path=self.codebase, target="fastapi")
        pipeline.create_manifest()
        return pipeline

    # -- features.json ------------------------------------------------------

    def test_features_missing_reports_null_with_reason(self):
        pipeline = self._new_pipeline()
        features_path = pipeline.migration_dir / "features.json"
        self.assertFalse(features_path.exists())

        progress = pipeline.get_progress()

        self.assertIsNone(progress["features"]["total"])
        self.assertIsNone(progress["features"]["passing"])
        self.assertIn("reason", progress["features"])
        self.assertIn("not found", progress["features"]["reason"])

    def test_features_corrupt_reports_null_with_reason(self):
        pipeline = self._new_pipeline()
        features_path = pipeline.migration_dir / "features.json"
        features_path.write_text("{not valid json", encoding="utf-8")

        progress = pipeline.get_progress()

        self.assertIsNone(progress["features"]["total"])
        self.assertIsNone(progress["features"]["passing"])
        self.assertIn("reason", progress["features"])
        self.assertIn("corrupt", progress["features"]["reason"])

    def test_features_empty_list_is_a_real_zero_not_unknown(self):
        """Control: a valid, empty features.json is 0/0 with NO reason key."""
        pipeline = self._new_pipeline()
        features_path = pipeline.migration_dir / "features.json"
        features_path.write_text("[]", encoding="utf-8")

        progress = pipeline.get_progress()

        self.assertEqual(progress["features"]["total"], 0)
        self.assertEqual(progress["features"]["passing"], 0)
        self.assertNotIn("reason", progress["features"])

    # -- migration-plan.json -------------------------------------------------

    def test_plan_missing_reports_null_with_reason(self):
        pipeline = self._new_pipeline()
        plan_path = pipeline.migration_dir / "migration-plan.json"
        self.assertFalse(plan_path.exists())

        progress = pipeline.get_progress()

        self.assertIsNone(progress["steps"]["total"])
        self.assertIsNone(progress["steps"]["completed"])
        self.assertIn("reason", progress["steps"])
        self.assertIn("not found", progress["steps"]["reason"])

    def test_plan_corrupt_reports_null_with_reason(self):
        pipeline = self._new_pipeline()
        plan_path = pipeline.migration_dir / "migration-plan.json"
        plan_path.write_text("{not valid json", encoding="utf-8")

        progress = pipeline.get_progress()

        self.assertIsNone(progress["steps"]["total"])
        self.assertIsNone(progress["steps"]["completed"])
        self.assertIn("reason", progress["steps"])
        self.assertIn("corrupt", progress["steps"]["reason"])

    def test_plan_empty_steps_is_a_real_zero_not_unknown(self):
        """Control: a valid plan with an empty steps list is 0/0, no reason."""
        pipeline = self._new_pipeline()
        plan_path = pipeline.migration_dir / "migration-plan.json"
        plan_path.write_text(
            '{"version": 1, "steps": []}', encoding="utf-8"
        )

        progress = pipeline.get_progress()

        self.assertEqual(progress["steps"]["total"], 0)
        self.assertEqual(progress["steps"]["completed"], 0)
        self.assertNotIn("reason", progress["steps"])


if __name__ == "__main__":
    unittest.main()
