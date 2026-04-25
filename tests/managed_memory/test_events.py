"""
tests/managed_memory/test_events.py
v7.1.0 T1: unit tests for correlation stamping in emit_managed_event.

Covers:
    - loki_version is ALWAYS present (cached at module load).
    - iteration_id stamped when LOKI_ITERATION_COUNT is set.
    - session_id stamped when LOKI_SESSION_ID is set.
    - Missing env vars OMIT the key (not stamp null).
    - Caller-supplied keys WIN over env-derived stamp values.
    - Missing env vars never raise.

These tests do NOT touch the network and do NOT require any SDK.
They isolate writes to a per-test tempdir via LOKI_TARGET_DIR.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from memory.managed_memory import events as events_mod
from memory.managed_memory.events import emit_managed_event


def _read_events(target_dir: str):
    path = Path(target_dir) / ".loki" / "managed" / "events.ndjson"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class StampingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-events-test-")
        # Snapshot env so each test starts clean.
        self._saved = {
            "LOKI_ITERATION_COUNT": os.environ.pop("LOKI_ITERATION_COUNT", None),
            "LOKI_SESSION_ID": os.environ.pop("LOKI_SESSION_ID", None),
            "LOKI_TARGET_DIR": os.environ.get("LOKI_TARGET_DIR"),
        }
        os.environ["LOKI_TARGET_DIR"] = self.tmp

    def tearDown(self):
        for key, val in self._saved.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val

    # ---- loki_version always present ----

    def test_loki_version_always_present(self):
        emit_managed_event("t_version", {"hello": "world"})
        rows = _read_events(self.tmp)
        self.assertEqual(len(rows), 1)
        payload = rows[0]["payload"]
        self.assertIn("loki_version", payload)
        self.assertIsInstance(payload["loki_version"], str)
        self.assertNotEqual(payload["loki_version"], "")

    def test_loki_version_is_module_cached(self):
        # Sanity: module-level cache exists and is a non-empty string.
        self.assertIsInstance(events_mod._LOKI_VERSION, str)
        self.assertNotEqual(events_mod._LOKI_VERSION, "")

    # ---- iteration_id / session_id stamping from env ----

    def test_iteration_id_stamped_from_env(self):
        os.environ["LOKI_ITERATION_COUNT"] = "42"
        emit_managed_event("t_iter", {})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["iteration_id"], "42")

    def test_session_id_stamped_from_env(self):
        os.environ["LOKI_SESSION_ID"] = "sess-xyz"
        emit_managed_event("t_sess", {})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["session_id"], "sess-xyz")

    def test_both_correlation_ids_stamped(self):
        os.environ["LOKI_ITERATION_COUNT"] = "7"
        os.environ["LOKI_SESSION_ID"] = "abc"
        emit_managed_event("t_both", {"k": "v"})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["iteration_id"], "7")
        self.assertEqual(payload["session_id"], "abc")
        self.assertEqual(payload["k"], "v")
        self.assertIn("loki_version", payload)

    # ---- Missing env vars must OMIT keys ----

    def test_missing_env_omits_keys(self):
        # Both env vars unset by setUp.
        emit_managed_event("t_missing", {"only": "this"})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertNotIn("iteration_id", payload)
        self.assertNotIn("session_id", payload)
        self.assertIn("loki_version", payload)
        self.assertEqual(payload["only"], "this")

    def test_empty_string_env_omits_keys(self):
        # Empty string is treated as "unset" (avoids stamping useless "" values).
        os.environ["LOKI_ITERATION_COUNT"] = ""
        os.environ["LOKI_SESSION_ID"] = ""
        emit_managed_event("t_empty_env", {})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertNotIn("iteration_id", payload)
        self.assertNotIn("session_id", payload)
        self.assertIn("loki_version", payload)

    def test_missing_env_does_not_raise(self):
        # Already unset; calling should silently succeed.
        try:
            emit_managed_event("t_no_raise", {})
        except Exception as exc:  # pragma: no cover - defensive
            self.fail(f"emit_managed_event raised on missing env: {exc!r}")

    # ---- Caller-supplied keys WIN ----

    def test_caller_iteration_id_wins(self):
        os.environ["LOKI_ITERATION_COUNT"] = "FROM_ENV"
        emit_managed_event("t_iter_override", {"iteration_id": "CUSTOM"})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["iteration_id"], "CUSTOM")

    def test_caller_session_id_wins(self):
        os.environ["LOKI_SESSION_ID"] = "FROM_ENV"
        emit_managed_event("t_sess_override", {"session_id": "CUSTOM_SESS"})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["session_id"], "CUSTOM_SESS")

    def test_caller_loki_version_wins(self):
        emit_managed_event("t_ver_override", {"loki_version": "9.9.9-test"})
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["loki_version"], "9.9.9-test")

    def test_caller_extra_fields_preserved(self):
        os.environ["LOKI_ITERATION_COUNT"] = "5"
        emit_managed_event(
            "t_extras",
            {"foo": 1, "bar": ["a", "b"], "nested": {"x": 1}},
        )
        payload = _read_events(self.tmp)[0]["payload"]
        self.assertEqual(payload["foo"], 1)
        self.assertEqual(payload["bar"], ["a", "b"])
        self.assertEqual(payload["nested"], {"x": 1})
        self.assertEqual(payload["iteration_id"], "5")
        self.assertIn("loki_version", payload)


if __name__ == "__main__":
    unittest.main()
