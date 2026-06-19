"""
Tests for the lokistore pluggable storage adapter.

Covers:
- LocalStore round-trip (put/get/get_to/exists/list/delete) and idempotent delete
- Atomic write (no partial files left behind; overwrite is clean)
- Path-traversal rejection (a key with .. cannot escape the base)
- Concurrent writers do not corrupt a key
- get_store() defaults to local when nothing is configured
- Behavior parity: a LocalStore write lands at the same .loki/ path a direct
  write would
- Selecting s3/gcs/azure-blob WITHOUT the SDK installed raises a clear error
  naming the missing package (the SDK import is mocked to fail; the real SDKs
  are NOT required in CI)
"""

import importlib
import os
import threading
from pathlib import Path

import pytest

from lokistore import (
    LocalStore,
    get_store,
    build_store,
    get_metadata_backend,
    resolve_local_base,
    BackendNotAvailableError,
    StoreError,
)
from lokistore.base import normalize_key


# --------------------------------------------------------------------------
# LocalStore round-trip
# --------------------------------------------------------------------------

def test_localstore_put_get_roundtrip(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    key = "state/checkpoints/cp-1/metadata.json"
    payload = b'{"iteration": 1, "phase": "build"}'

    assert store.exists(key) is False
    store.put(key, payload)
    assert store.exists(key) is True
    assert store.get(key) == payload


def test_localstore_get_missing_raises(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    with pytest.raises(FileNotFoundError):
        store.get("does/not/exist.json")


def test_localstore_put_from_file_path(tmp_path):
    src = tmp_path / "source.bin"
    src.write_bytes(b"\x00\x01\x02source-bytes")
    store = LocalStore(tmp_path / ".loki")

    # A str/path source means "read this file", per the contract.
    store.put("blobs/copied.bin", str(src))
    assert store.get("blobs/copied.bin") == b"\x00\x01\x02source-bytes"


def test_localstore_get_to(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    store.put("a/b/c.txt", b"hello")
    dest = tmp_path / "out" / "restored.txt"
    store.get_to("a/b/c.txt", dest)
    assert dest.read_bytes() == b"hello"


def test_localstore_list_prefix(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    store.put("state/a.json", b"1")
    store.put("state/sub/b.json", b"2")
    store.put("other/c.json", b"3")

    assert store.list("state/") == ["state/a.json", "state/sub/b.json"]
    assert store.list("") == [
        "other/c.json",
        "state/a.json",
        "state/sub/b.json",
    ]
    assert store.list("nonexistent/") == []


def test_localstore_list_excludes_lock_and_temp(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    store.put("state/x.json", b"1")
    # The .lock sibling created by the write must not surface as a key.
    assert store.list("") == ["state/x.json"]


def test_localstore_list_prefix_matches_at_slash_boundary(tmp_path):
    # Documented contract (L2): prefix is a PATH prefix matched at slash
    # boundaries, NOT a raw substring. "state" must select keys under "state/"
    # and must NOT match a sibling that merely shares leading characters
    # ("stateful/..."). This is the behavior cloud backends now mirror via the
    # directory-form prefix coercion in cloud._dir_prefix.
    store = LocalStore(tmp_path / ".loki")
    store.put("state/a.json", b"1")
    store.put("state/sub/b.json", b"2")
    store.put("stateful/c.json", b"3")

    # Slash-terminated: the portable form, identical across backends.
    assert store.list("state/") == ["state/a.json", "state/sub/b.json"]
    # Non-slash form is normalized to the directory; "stateful/" is NOT matched.
    assert store.list("state") == ["state/a.json", "state/sub/b.json"]


def test_localstore_delete_idempotent(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    store.put("k.json", b"v")
    assert store.delete("k.json") is True
    assert store.exists("k.json") is False
    # Deleting a missing key is a no-op that returns False, never raises.
    assert store.delete("k.json") is False


def test_localstore_overwrite_is_clean(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    store.put("k.json", b"first")
    store.put("k.json", b"second-longer-value")
    assert store.get("k.json") == b"second-longer-value"


# --------------------------------------------------------------------------
# Atomic write: no partial/temp files leak
# --------------------------------------------------------------------------

def test_atomic_write_leaves_no_temp_files(tmp_path):
    base = tmp_path / ".loki"
    store = LocalStore(base)
    store.put("dir/file.json", b"payload")

    # Only the file (and its persistent .lock sibling) should exist; no
    # .tmp_* partials remain.
    leaked = [p.name for p in (base / "dir").iterdir() if p.name.startswith(".tmp_")]
    assert leaked == []


# --------------------------------------------------------------------------
# Path-traversal rejection
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "bad_key",
    [
        "../escape.json",
        "state/../../escape.json",
        "/abs/path.json",
        "a/../../b.json",
        "..",
        "",
    ],
)
def test_traversal_rejected(tmp_path, bad_key):
    store = LocalStore(tmp_path / ".loki")
    with pytest.raises(ValueError):
        store.put(bad_key, b"x")


def test_traversal_cannot_create_outside_base(tmp_path):
    base = tmp_path / "proj" / ".loki"
    store = LocalStore(base)
    outside = tmp_path / "secret.txt"
    with pytest.raises(ValueError):
        store.put("../../secret.txt", b"leak")
    assert not outside.exists()


# --------------------------------------------------------------------------
# Leaf-symlink read escape (M1): a file-symlink placed AT a key path inside the
# base, pointing OUTSIDE the base, must NOT be followed on read. Before the fix
# get/get_to/exists followed the leaf symlink and leaked the outside file's
# bytes because _resolve only realpath-checked the key's PARENT, not the final
# target.
# --------------------------------------------------------------------------

@pytest.mark.skipif(
    os.name == "nt", reason="POSIX symlink semantics"
)
def test_leaf_symlink_read_escape_blocked(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_bytes(b"TOP-SECRET-OUTSIDE-BASE")
    # Leaf file-symlink at the key path, pointing outside the base.
    os.symlink(str(outside), str(base / "innocent"))

    store = LocalStore(base)
    # Pre-fix, every one of these returned/observed the outside file. They must
    # now refuse rather than leak.
    with pytest.raises(ValueError):
        store.get("innocent")
    with pytest.raises(ValueError):
        store.exists("innocent")
    leaked = tmp_path / "leaked.txt"
    with pytest.raises(ValueError):
        store.get_to("innocent", leaked)
    assert not leaked.exists()


@pytest.mark.skipif(
    os.name == "nt", reason="POSIX symlink semantics"
)
def test_leaf_symlink_inside_base_still_works(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    target = base / "real.txt"
    target.write_bytes(b"in-base-bytes")
    # A leaf symlink whose real target stays under the base is legitimate.
    os.symlink(str(target), str(base / "inlink"))

    store = LocalStore(base)
    assert store.exists("inlink") is True
    assert store.get("inlink") == b"in-base-bytes"


@pytest.mark.skipif(
    os.name == "nt", reason="POSIX symlink semantics"
)
def test_nested_key_unaffected_by_symlink_guard(tmp_path):
    # Ordinary (non-symlink) nested keys keep working after the read guard.
    store = LocalStore(tmp_path / "base")
    store.put("a/b/c.json", b"nested")
    assert store.exists("a/b/c.json") is True
    assert store.get("a/b/c.json") == b"nested"
    # Overwrite/clobber via os.replace remains intact.
    store.put("a/b/c.json", b"second-longer-value")
    assert store.get("a/b/c.json") == b"second-longer-value"


def test_normalize_key_collapses_segments():
    assert normalize_key("a//b/./c.json") == "a/b/c.json"
    assert normalize_key("state/checkpoints/cp-1/metadata.json") == (
        "state/checkpoints/cp-1/metadata.json"
    )
    # Backslashes are normalized so a Windows-style key cannot bypass the guard.
    with pytest.raises(ValueError):
        normalize_key("..\\escape")


# --------------------------------------------------------------------------
# Concurrent writers: no corruption
# --------------------------------------------------------------------------

def test_concurrent_writers_no_corruption(tmp_path):
    store = LocalStore(tmp_path / ".loki")
    key = "contended/value.bin"
    # Each writer writes a distinct fixed-length payload. Whoever wins, the
    # final read must be ONE complete payload, never a torn mix.
    payloads = [bytes([i]) * 4096 for i in range(1, 9)]

    def writer(p):
        for _ in range(25):
            store.put(key, p)

    threads = [threading.Thread(target=writer, args=(p,)) for p in payloads]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    final = store.get(key)
    assert final in payloads
    assert len(final) == 4096


# --------------------------------------------------------------------------
# Factory: default-to-local
# --------------------------------------------------------------------------

def test_get_store_defaults_to_local(monkeypatch, tmp_path):
    for var in (
        "LOKI_STORAGE_BACKEND",
        "LOKI_STORAGE_BUCKET",
        "LOKI_STORAGE_PREFIX",
        "LOKI_STORAGE_REGION",
        "LOKI_DIR",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TARGET_DIR", str(tmp_path))

    store = get_store()
    assert isinstance(store, LocalStore)
    assert store.base_dir == Path(tmp_path) / ".loki"


def test_build_store_explicit_local(tmp_path):
    store = build_store({"backend": "local", "base_dir": str(tmp_path / "custom")})
    assert isinstance(store, LocalStore)
    assert store.base_dir == Path(tmp_path) / "custom"


def test_get_store_config_overrides_env(monkeypatch, tmp_path):
    monkeypatch.delenv("LOKI_STORAGE_BACKEND", raising=False)
    monkeypatch.delenv("LOKI_DIR", raising=False)
    monkeypatch.setenv("TARGET_DIR", str(tmp_path))
    # Explicit local config still yields local even though env is clean.
    store = get_store({"backend": "local"})
    assert isinstance(store, LocalStore)


def test_unknown_backend_raises(tmp_path):
    with pytest.raises(StoreError):
        build_store({"backend": "nonsense"})


# --------------------------------------------------------------------------
# resolve_local_base honors LOKI_DIR / TARGET_DIR like run.sh
# --------------------------------------------------------------------------

def test_resolve_local_base_prefers_loki_dir(monkeypatch):
    monkeypatch.setenv("LOKI_DIR", "/custom/loki")
    monkeypatch.setenv("TARGET_DIR", "/somewhere/else")
    assert resolve_local_base() == "/custom/loki"


def test_resolve_local_base_target_dir(monkeypatch):
    monkeypatch.delenv("LOKI_DIR", raising=False)
    monkeypatch.setenv("TARGET_DIR", "/proj")
    assert resolve_local_base() == os.path.join("/proj", ".loki")


def test_resolve_local_base_default(monkeypatch):
    monkeypatch.delenv("LOKI_DIR", raising=False)
    monkeypatch.delenv("TARGET_DIR", raising=False)
    assert resolve_local_base() == os.path.join(".", ".loki")


# --------------------------------------------------------------------------
# Behavior parity: LocalStore write lands at the same .loki/ path a direct
# write would, with identical bytes.
# --------------------------------------------------------------------------

def test_parity_with_direct_loki_write(monkeypatch, tmp_path):
    monkeypatch.delenv("LOKI_DIR", raising=False)
    monkeypatch.setenv("TARGET_DIR", str(tmp_path))

    key = "state/session.json"
    payload = b'{"status": "running"}'

    store = get_store()
    store.put(key, payload)

    # The exact path a direct ".loki/" writer would have used.
    direct_path = Path(tmp_path) / ".loki" / "state" / "session.json"
    assert direct_path.is_file()
    assert direct_path.read_bytes() == payload


# --------------------------------------------------------------------------
# Cloud backends: missing SDK raises a clear, named error (no real SDK needed)
# --------------------------------------------------------------------------

def _force_import_error(monkeypatch, module_name):
    """Make `import <module_name>` (and submodules) raise ImportError."""
    real_import = importlib.import_module
    import builtins

    real_builtins_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == module_name or name.startswith(module_name + "."):
            raise ImportError(f"No module named '{module_name}' (simulated)")
        return real_builtins_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)


def test_s3_missing_boto3_raises_named_error(monkeypatch):
    _force_import_error(monkeypatch, "boto3")
    with pytest.raises(BackendNotAvailableError) as exc:
        build_store({"backend": "s3", "bucket": "my-bucket"})
    assert "boto3" in str(exc.value)


def test_gcs_missing_sdk_raises_named_error(monkeypatch):
    _force_import_error(monkeypatch, "google")
    with pytest.raises(BackendNotAvailableError) as exc:
        build_store({"backend": "gcs", "bucket": "my-bucket"})
    assert "google-cloud-storage" in str(exc.value)


def test_azure_missing_sdk_raises_named_error(monkeypatch):
    _force_import_error(monkeypatch, "azure")
    with pytest.raises(BackendNotAvailableError) as exc:
        build_store({"backend": "azure-blob", "bucket": "my-container"})
    assert "azure-storage-blob" in str(exc.value)


def test_cloud_import_is_lazy():
    # Importing the package must NOT import any cloud SDK. The cloud module
    # itself imports no SDK at module scope either.
    import lokistore.cloud as cloud_mod

    src = Path(cloud_mod.__file__).read_text()
    # Module-level (col 0) SDK imports would be a regression; SDK imports must
    # live inside __init__/methods (indented).
    for banned in ("import boto3", "from google.cloud", "from azure."):
        for line in src.splitlines():
            if line.startswith(banned):
                raise AssertionError(
                    f"cloud.py imports an SDK at module scope: {line!r}"
                )


# --------------------------------------------------------------------------
# Metadata backend selector (stub)
# --------------------------------------------------------------------------

def test_metadata_backend_defaults_to_sqlite(monkeypatch):
    monkeypatch.delenv("LOKI_METADATA_BACKEND", raising=False)
    desc = get_metadata_backend()
    assert desc["backend"] == "sqlite"
    assert desc["implemented"] is True
    assert desc["dsn"].endswith("dashboard.db")


def test_metadata_backend_postgres_not_implemented(monkeypatch):
    monkeypatch.setenv("LOKI_METADATA_BACKEND", "postgres")
    monkeypatch.setenv("LOKI_METADATA_URL", "postgresql://x/y")
    desc = get_metadata_backend()
    assert desc["backend"] == "postgres"
    assert desc["implemented"] is False
    assert desc["dsn"] == "postgresql://x/y"


def test_metadata_backend_unknown_raises():
    with pytest.raises(StoreError):
        get_metadata_backend({"metadata_backend": "mongodb"})
