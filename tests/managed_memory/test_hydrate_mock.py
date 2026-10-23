"""
tests/managed_memory/test_hydrate_mock.py
v6.83.x Phase 2: unit tests for the session-boot hydrate path using
FakeManagedClient.

Covers:
    - hydrate() merges new patterns into .loki/memory/semantic/patterns.json
    - hydrate() merges new skills into .loki/memory/skills/{name}.json
    - hydrate() respects mtime_floor (epoch timestamps below the floor are skipped)
    - hydrate() is a no-op when LOKI_MANAGED_* flags are off
    - local version wins on pattern_id conflict
    - hydrate() is idempotent within a session (sentinel lock file)
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path


os.environ["LOKI_MANAGED_AGENTS"] = "true"
os.environ["LOKI_MANAGED_MEMORY"] = "true"


class HydrateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-managed-hydrate-")
        os.environ["LOKI_TARGET_DIR"] = self.tmp

        from memory.managed_memory import client as _client_mod
        from memory.managed_memory.fakes import FakeManagedClient

        self._client_mod = _client_mod
        self.fake = FakeManagedClient()
        _client_mod._singleton = self.fake  # type: ignore[attr-defined]

        # Ensure flags are on for the happy-path tests.
        os.environ["LOKI_MANAGED_AGENTS"] = "true"
        os.environ["LOKI_MANAGED_MEMORY"] = "true"

    def tearDown(self):
        self._client_mod.reset_client()

    # --- helpers ----------------------------------------------------------

    def _seed_remote(self, patterns=None, skills=None):
        store = self.fake.stores_get_or_create(
            name="loki-rarv-c-learnings", description="", scope="project"
        )
        sid = store["id"]
        for p in patterns or []:
            path = f"/patterns/{p['pattern_id']}.json"
            self.fake.memory_create(store_id=sid, path=path, content=json.dumps(p))
        for s in skills or []:
            name = s.get("name") or s["id"]
            path = f"/skills/{name}.json"
            self.fake.memory_create(store_id=sid, path=path, content=json.dumps(s))
        return sid

    def _patterns_path(self):
        return (
            Path(self.tmp)
            / ".loki"
            / "memory"
            / "semantic"
            / "patterns.json"
        )

    def _skills_dir(self):
        return Path(self.tmp) / ".loki" / "memory" / "skills"

    def _clear_sentinel(self):
        """Remove the idempotency sentinel so a fresh hydrate can run."""
        sentinel = Path(self.tmp) / ".loki" / "managed" / "hydrate.lock"
        if sentinel.exists():
            sentinel.unlink()

    # --- tests ------------------------------------------------------------

    def test_hydrate_merges_new_patterns_and_skills(self):
        from memory.managed_memory.retrieve import hydrate

        self._seed_remote(
            patterns=[
                {"pattern_id": "p-remote-1", "body": "remote-pattern-1"},
                {"pattern_id": "p-remote-2", "body": "remote-pattern-2"},
            ],
            skills=[
                {"id": "sk-1", "name": "refactor-loop", "body": "pseudo"},
                {"id": "sk-2", "name": "test-harness", "body": "pseudo"},
            ],
        )

        result = hydrate(target_dir=self.tmp)

        self.assertFalse(result["skipped"])
        self.assertEqual(result["patterns"], 2)
        self.assertEqual(result["skills"], 2)

        with open(self._patterns_path(), "r", encoding="utf-8") as f:
            doc = json.load(f)
        self.assertIn("p-remote-1", doc["patterns"])
        self.assertIn("p-remote-2", doc["patterns"])

        self.assertTrue((self._skills_dir() / "refactor-loop.json").exists())
        self.assertTrue((self._skills_dir() / "test-harness.json").exists())

    def test_hydrate_respects_mtime_floor(self):
        """Patterns with updated_at below the floor are skipped."""
        from memory.managed_memory.retrieve import hydrate

        now = time.time()
        # One new, one stale.
        self._seed_remote(
            patterns=[
                {
                    "pattern_id": "p-fresh",
                    "body": "fresh",
                    "updated_at": now,
                },
                {
                    "pattern_id": "p-stale",
                    "body": "stale",
                    "updated_at": now - 3600,
                },
            ],
        )

        # Floor is halfway between stale and fresh.
        result = hydrate(mtime_floor=now - 60, target_dir=self.tmp)
        self.assertFalse(result["skipped"])

        with open(self._patterns_path(), "r", encoding="utf-8") as f:
            doc = json.load(f)
        self.assertIn("p-fresh", doc["patterns"])
        self.assertNotIn("p-stale", doc["patterns"])

    def test_hydrate_noop_when_flags_off(self):
        """With flags off, hydrate() returns skipped=True and touches nothing."""
        from memory.managed_memory.retrieve import hydrate

        # Seed remote so we can confirm it is NOT pulled.
        self._seed_remote(
            patterns=[{"pattern_id": "p-x", "body": "x"}],
            skills=[{"id": "s-x", "name": "x-skill"}],
        )

        old_p = os.environ.get("LOKI_MANAGED_AGENTS")
        old_c = os.environ.get("LOKI_MANAGED_MEMORY")
        os.environ["LOKI_MANAGED_AGENTS"] = "false"
        os.environ["LOKI_MANAGED_MEMORY"] = "false"
        try:
            result = hydrate(target_dir=self.tmp)
        finally:
            # v7.0.2: unconditional restore (None -> pop, value -> set).
            if old_p is None:
                os.environ.pop("LOKI_MANAGED_AGENTS", None)
            else:
                os.environ["LOKI_MANAGED_AGENTS"] = old_p
            if old_c is None:
                os.environ.pop("LOKI_MANAGED_MEMORY", None)
            else:
                os.environ["LOKI_MANAGED_MEMORY"] = old_c

        self.assertTrue(result["skipped"])
        self.assertEqual(result["patterns"], 0)
        self.assertEqual(result["skills"], 0)
        # No local files should have been written.
        self.assertFalse(self._patterns_path().exists())
        self.assertFalse((self._skills_dir() / "x-skill.json").exists())

    def test_local_wins_on_pattern_id_conflict(self):
        """A local pattern with the same id is NOT clobbered by the remote copy."""
        from memory.managed_memory.retrieve import hydrate

        # Local: the same id, with a distinctive body.
        local_file = self._patterns_path()
        local_file.parent.mkdir(parents=True, exist_ok=True)
        local_doc = {
            "patterns": {
                "p-shared": {"pattern_id": "p-shared", "body": "LOCAL-VERSION"}
            }
        }
        with open(local_file, "w", encoding="utf-8") as f:
            json.dump(local_doc, f)

        # Remote: the same id, different body; plus a brand-new id.
        self._seed_remote(
            patterns=[
                {"pattern_id": "p-shared", "body": "REMOTE-VERSION"},
                {"pattern_id": "p-new", "body": "new-body"},
            ]
        )

        result = hydrate(target_dir=self.tmp)
        self.assertFalse(result["skipped"])
        # Only p-new should be merged.
        self.assertEqual(result["patterns"], 1)

        with open(local_file, "r", encoding="utf-8") as f:
            final = json.load(f)
        self.assertEqual(
            final["patterns"]["p-shared"]["body"], "LOCAL-VERSION"
        )
        self.assertIn("p-new", final["patterns"])

    def test_local_wins_on_skill_filename_conflict(self):
        """A local skill file is NOT overwritten by the remote copy."""
        from memory.managed_memory.retrieve import hydrate

        # Seed local skill file first.
        skills_dir = self._skills_dir()
        skills_dir.mkdir(parents=True, exist_ok=True)
        local_skill_path = skills_dir / "shared-skill.json"
        with open(local_skill_path, "w", encoding="utf-8") as f:
            json.dump(
                {"id": "sk-shared", "name": "shared-skill", "body": "LOCAL"}, f
            )

        self._seed_remote(
            skills=[
                {"id": "sk-shared", "name": "shared-skill", "body": "REMOTE"},
                {"id": "sk-new", "name": "new-skill", "body": "NEW"},
            ]
        )

        result = hydrate(target_dir=self.tmp)
        self.assertFalse(result["skipped"])
        self.assertEqual(result["skills"], 1)

        with open(local_skill_path, "r", encoding="utf-8") as f:
            kept = json.load(f)
        self.assertEqual(kept["body"], "LOCAL")
        self.assertTrue((skills_dir / "new-skill.json").exists())

    def test_hydrate_is_idempotent_within_session(self):
        """Second hydrate() call within the same session is a no-op."""
        from memory.managed_memory.retrieve import hydrate

        self._seed_remote(
            patterns=[{"pattern_id": "p-once", "body": "once"}],
        )

        first = hydrate(target_dir=self.tmp)
        self.assertFalse(first["skipped"])
        self.assertEqual(first["patterns"], 1)

        # Now mutate the remote; a second hydrate should NOT pull it.
        store = self.fake.stores_get_or_create(
            name="loki-rarv-c-learnings", description="", scope="project"
        )
        self.fake.memory_create(
            store_id=store["id"],
            path="/patterns/p-late.json",
            content=json.dumps({"pattern_id": "p-late", "body": "late"}),
        )

        second = hydrate(target_dir=self.tmp)
        self.assertTrue(second["skipped"])
        self.assertEqual(second["patterns"], 0)

        with open(self._patterns_path(), "r", encoding="utf-8") as f:
            doc = json.load(f)
        self.assertIn("p-once", doc["patterns"])
        self.assertNotIn("p-late", doc["patterns"])

        # After clearing the sentinel (simulating a new session), hydrate resumes.
        self._clear_sentinel()
        third = hydrate(target_dir=self.tmp)
        self.assertFalse(third["skipped"])
        self.assertEqual(third["patterns"], 1)  # just p-late
        with open(self._patterns_path(), "r", encoding="utf-8") as f:
            doc = json.load(f)
        self.assertIn("p-late", doc["patterns"])


if __name__ == "__main__":
    unittest.main()
