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


def test_sync_with_discovery_persists_added_projects(
    temp_registry, tmp_path, monkeypatch
):
    # Regression: sync_registry_with_discovery() used to load the registry,
    # call register_project() inside the loop (which saved its own copy), then
    # save the STALE pre-loop registry over the top -- silently dropping every
    # newly added project. The summary said "added: N" while the on-disk file
    # kept zero of them.
    # Seed one already-registered project.
    existing = tmp_path / "existing"
    existing.mkdir()
    registry.register_project(str(existing), name="Existing")

    # Two NEW projects discovery will surface.
    new_a = tmp_path / "new_a"
    (new_a / ".loki").mkdir(parents=True)
    new_b = tmp_path / "new_b"
    (new_b / ".loki").mkdir(parents=True)

    monkeypatch.setattr(
        registry,
        "discover_projects",
        lambda *a, **k: [
            {"path": str(new_a)},
            {"path": str(new_b)},
        ],
    )

    result = registry.sync_registry_with_discovery()
    assert result["added"] == 2

    # The summary count must match what is actually persisted on disk.
    on_disk = json.loads(registry.REGISTRY_FILE.read_text())
    persisted_paths = {p["path"] for p in on_disk["projects"].values()}
    assert str(existing) in persisted_paths
    assert str(new_a) in persisted_paths
    assert str(new_b) in persisted_paths
    assert len(on_disk["projects"]) == 3


def test_register_project_sets_runtime_fields_atomically(temp_registry, tmp_path):
    # Regression for the missing atomic "register + set runtime fields" API.
    # Previously a caller had to register_project() and then do a SECOND,
    # unlocked load-mutate-save to stamp pid/port/status, which lost-updates a
    # concurrent writer. register_project() now accepts pid/port/status and sets
    # them inside the existing _registry_lock() so it is one locked write.
    proj_path = tmp_path / "runtimeproj"
    proj_path.mkdir()

    # Create branch: pid/port/status set on first registration.
    entry = registry.register_project(
        str(proj_path), name="RT", pid=4242, port=5001, status="running"
    )
    assert entry["pid"] == 4242
    assert entry["port"] == 5001
    assert entry["status"] == "running"

    # Persisted to disk in one write.
    on_disk = json.loads(registry.REGISTRY_FILE.read_text())
    persisted = next(
        p for p in on_disk["projects"].values() if p["path"] == str(proj_path)
    )
    assert persisted["pid"] == 4242
    assert persisted["port"] == 5001
    assert persisted["status"] == "running"

    # Update branch: re-register with new runtime fields updates in place.
    entry2 = registry.register_project(
        str(proj_path), pid=9999, port=5002, status="active"
    )
    assert entry2["pid"] == 9999
    assert entry2["port"] == 5002
    assert entry2["status"] == "active"
    assert entry2["id"] == entry["id"]


def test_register_project_runtime_fields_backward_compatible(temp_registry, tmp_path):
    # Omitting pid/port/status keeps the legacy behavior: no pid/port keys are
    # introduced and status defaults to "active" on create.
    proj_path = tmp_path / "legacyproj"
    proj_path.mkdir()

    entry = registry.register_project(str(proj_path), name="Legacy")
    assert entry["status"] == "active"
    assert "pid" not in entry
    assert "port" not in entry

    # A later register without runtime kwargs must not clobber a previously set
    # pid/port ("None means leave as-is").
    registry.register_project(str(proj_path), pid=777, port=8080, status="running")
    entry3 = registry.register_project(str(proj_path), name="LegacyRenamed")
    assert entry3["name"] == "LegacyRenamed"
    assert entry3["pid"] == 777
    assert entry3["port"] == 8080
    assert entry3["status"] == "running"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
