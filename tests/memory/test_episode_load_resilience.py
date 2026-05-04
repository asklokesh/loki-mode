"""
Per-file resilience tests for episode JSON loading (Triage #15).

Background: prior to this fix, ``MemoryStorage._load_json`` (the central
loader used by ``read_json``, ``load_episode``, ``load_pattern``, etc.)
caught only ``json.JSONDecodeError``. A single corrupt, unreadable, or
non-UTF8 file in ``.loki/memory/episodic/`` could therefore crash the
entire memory load (one bad apple killing the harvest).

These tests assert that:
  1. Valid episode files are still loaded normally.
  2. Corrupt JSON, empty files, and non-UTF8 bytes are skipped (return None).
  3. Each skip emits a warning via ``logging``.
  4. No exception bubbles up from the loader.
  5. Bulk callers (``list_episodes`` + ``read_json`` per file, mirroring
     ``engine.get_recent_episodes`` and ``retrieval`` flows) yield only
     the valid records, not zero-and-error.
"""

import json
import logging
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Allow `import memory.storage` when run via `pytest` from repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from memory.storage import MemoryStorage  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def storage(tmp_path):
    """Fresh MemoryStorage rooted in a tmp directory."""
    base = tmp_path / "memory"
    return MemoryStorage(base_path=str(base))


@pytest.fixture
def episodic_dir(storage):
    """Pre-populated ``episodic/<date>/`` directory with a mix of files."""
    date_str = "2026-05-03"
    date_dir = Path(storage.base_path) / "episodic" / date_str
    date_dir.mkdir(parents=True, exist_ok=True)

    # 2 valid JSON files
    valid_a = {
        "id": "episode-valid-a",
        "timestamp": "2026-05-03T10:00:00+00:00",
        "outcome": "success",
        "_namespace": "default",
    }
    valid_b = {
        "id": "episode-valid-b",
        "timestamp": "2026-05-03T11:00:00+00:00",
        "outcome": "success",
        "_namespace": "default",
    }
    (date_dir / "task-episode-valid-a.json").write_text(json.dumps(valid_a))
    (date_dir / "task-episode-valid-b.json").write_text(json.dumps(valid_b))

    # 1 corrupt JSON (unterminated)
    (date_dir / "task-episode-corrupt.json").write_text('{"unterminated')

    # 1 empty file
    (date_dir / "task-episode-empty.json").write_text("")

    # 1 file with non-UTF8 bytes (binary garbage)
    (date_dir / "task-episode-binary.json").write_bytes(
        b"\xff\xfe\x00\x00not valid utf8 \xc3\x28"
    )

    return date_dir


# ---------------------------------------------------------------------------
# Tests: low-level _load_json / read_json
# ---------------------------------------------------------------------------

def test_load_json_valid_returns_dict(storage, episodic_dir, caplog):
    caplog.set_level(logging.WARNING, logger="memory.storage")
    data = storage.read_json("episodic/2026-05-03/task-episode-valid-a.json")
    assert data is not None
    assert data["id"] == "episode-valid-a"
    # No warnings for clean files.
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_load_json_corrupt_returns_none_logs_warning(storage, episodic_dir, caplog):
    caplog.set_level(logging.WARNING, logger="memory.storage")
    result = storage.read_json("episodic/2026-05-03/task-episode-corrupt.json")
    assert result is None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("corrupt" in r.getMessage().lower() for r in warnings), \
        f"expected corrupt-JSON warning, got: {[r.getMessage() for r in warnings]}"


def test_load_json_empty_file_returns_none_logs_warning(storage, episodic_dir, caplog):
    caplog.set_level(logging.WARNING, logger="memory.storage")
    result = storage.read_json("episodic/2026-05-03/task-episode-empty.json")
    assert result is None
    # Empty file fails json parsing; we expect a warning.
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "expected at least one warning for empty file"


def test_load_json_non_utf8_returns_none_logs_warning(storage, episodic_dir, caplog):
    caplog.set_level(logging.WARNING, logger="memory.storage")
    result = storage.read_json("episodic/2026-05-03/task-episode-binary.json")
    assert result is None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "expected at least one warning for non-UTF8 file"
    assert any(
        ("utf8" in r.getMessage().lower())
        or ("non-utf8" in r.getMessage().lower())
        or ("corrupt" in r.getMessage().lower())
        or ("unreadable" in r.getMessage().lower())
        for r in warnings
    )


def test_load_json_missing_file_returns_none_no_warning(storage, caplog):
    caplog.set_level(logging.WARNING, logger="memory.storage")
    result = storage.read_json("episodic/2026-05-03/task-does-not-exist.json")
    assert result is None
    # Missing files are normal; should NOT log a warning.
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_load_json_no_exception_bubbles(storage, episodic_dir):
    """No matter how broken a file is, the loader returns None, never raises."""
    for filename in (
        "task-episode-corrupt.json",
        "task-episode-empty.json",
        "task-episode-binary.json",
    ):
        # Must not raise.
        storage.read_json(f"episodic/2026-05-03/{filename}")


# ---------------------------------------------------------------------------
# Tests: bulk-loader resilience (mirrors engine/retrieval flows)
# ---------------------------------------------------------------------------

def test_bulk_episode_load_returns_only_valid(storage, episodic_dir, caplog):
    """Simulate ``engine.get_recent_episodes`` style bulk load.

    Iterates all episode files and asserts:
      - exactly 2 valid records returned (not 0, not 5, no exception)
      - >=3 warnings logged (one per bad file: corrupt / empty / binary)
    """
    caplog.set_level(logging.WARNING, logger="memory.storage")

    loaded = []
    for episode_file in sorted(episodic_dir.glob("*.json")):
        data = storage.read_json(f"episodic/{episodic_dir.name}/{episode_file.name}")
        if data:
            loaded.append(data)

    assert len(loaded) == 2, (
        f"expected 2 valid episodes, got {len(loaded)}: "
        f"{[d.get('id') for d in loaded]}"
    )
    ids = {d["id"] for d in loaded}
    assert ids == {"episode-valid-a", "episode-valid-b"}

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) >= 3, (
        f"expected >=3 warnings (corrupt + empty + binary), got "
        f"{len(warnings)}: {[r.getMessage() for r in warnings]}"
    )


def test_load_episode_skips_corrupt_files(storage, episodic_dir):
    """``MemoryStorage.load_episode`` must locate valid IDs even when
    sibling corrupt files exist in the same date directory."""
    found = storage.load_episode("episode-valid-a")
    assert found is not None
    assert found["id"] == "episode-valid-a"

    # Looking up a corrupt episode by ID returns None gracefully.
    missing = storage.load_episode("episode-corrupt")
    assert missing is None
