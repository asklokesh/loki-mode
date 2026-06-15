"""
tests/test_registry_atomic_save.py

Covers the concurrent-write race fix in dashboard/registry.py:

- _save_registry writes atomically (temp file in REGISTRY_DIR + os.replace), so
  a reader never sees a torn (half-written) projects.json.
- An error mid-write leaves the original file intact and leaves no stray temp
  file behind in REGISTRY_DIR.
- register_project round-trips: save then load returns the persisted entry and
  the on-disk file is valid JSON.
- The advisory lock degrades gracefully when fcntl is unavailable.

All tests are hermetic: REGISTRY_DIR / REGISTRY_FILE are monkeypatched to a
tmp_path so the real ~/.loki is never touched.
"""

import json
import os

import pytest

from dashboard import registry


@pytest.fixture
def temp_registry(tmp_path, monkeypatch):
    """Point the registry at an isolated temp dir for the duration of a test."""
    reg_dir = tmp_path / "dashboard"
    monkeypatch.setattr(registry, "REGISTRY_DIR", reg_dir)
    monkeypatch.setattr(registry, "REGISTRY_FILE", reg_dir / "projects.json")
    return reg_dir


def test_save_load_round_trips(temp_registry):
    data = {"version": "1.0", "projects": {"abc": {"id": "abc", "path": "/x"}}}
    registry._save_registry(data)

    # File exists and is valid JSON on disk.
    assert registry.REGISTRY_FILE.exists()
    on_disk = json.loads(registry.REGISTRY_FILE.read_text())
    assert on_disk == data

    # _load_registry returns the same structure.
    assert registry._load_registry() == data


def test_register_project_persists(temp_registry, tmp_path):
    proj_path = tmp_path / "myproject"
    proj_path.mkdir()

    entry = registry.register_project(str(proj_path), name="MyProject")
    assert entry["name"] == "MyProject"
    assert entry["status"] == "active"

    # Reloads from disk and the project survives.
    projects = registry.list_projects()
    assert any(p["path"] == str(proj_path) for p in projects)

    # The file on disk is valid JSON (not torn).
    json.loads(registry.REGISTRY_FILE.read_text())


def test_atomic_write_leaves_original_intact_on_error(temp_registry, monkeypatch):
    # Seed a known-good registry.
    good = {"version": "1.0", "projects": {"keep": {"id": "keep"}}}
    registry._save_registry(good)
    assert json.loads(registry.REGISTRY_FILE.read_text()) == good

    # Force json.dump to blow up mid-write.
    def boom(*args, **kwargs):
        raise RuntimeError("simulated write failure")

    monkeypatch.setattr(registry.json, "dump", boom)

    with pytest.raises(RuntimeError):
        registry._save_registry({"version": "1.0", "projects": {"new": {}}})

    # Original file is untouched (no torn / truncated write).
    assert json.loads(registry.REGISTRY_FILE.read_text()) == good

    # No stray temp file left behind in REGISTRY_DIR.
    leftovers = [
        p.name
        for p in temp_registry.iterdir()
        if p.name.startswith(".projects.") and p.name.endswith(".tmp")
    ]
    assert leftovers == [], f"temp file leaked: {leftovers}"


def test_lock_degrades_gracefully_without_fcntl(temp_registry, tmp_path, monkeypatch):
    # Simulate a platform without fcntl (e.g. Windows): the import inside the
    # context manager raises ImportError, and the mutator must still work.
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "fcntl":
            raise ImportError("no fcntl on this platform")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    proj_path = tmp_path / "nolock"
    proj_path.mkdir()
    entry = registry.register_project(str(proj_path))
    assert entry["path"] == str(proj_path)
    # Persisted despite no lock available.
    assert any(p["path"] == str(proj_path) for p in registry.list_projects())


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
