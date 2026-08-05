import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dashboard.control import find_skill_dir


class FindSkillDirTests(unittest.TestCase):
    def test_explicit_source_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "autonomy").mkdir()
            (root / "SKILL.md").write_text("test\n", encoding="utf-8")
            (root / "autonomy" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")

            with patch.dict(os.environ, {"LOKI_SKILL_DIR": str(root)}):
                self.assertEqual(find_skill_dir(), root.resolve())

    def test_invalid_explicit_source_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {"LOKI_SKILL_DIR": temp}):
                with self.assertRaisesRegex(RuntimeError, "LOKI_SKILL_DIR"):
                    find_skill_dir()


if __name__ == "__main__":
    unittest.main()
