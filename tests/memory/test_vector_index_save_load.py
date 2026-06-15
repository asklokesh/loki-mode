"""
Regression test for VectorIndex.save() temp-file suffix corruption.

Bug: VectorIndex.save() created its atomic temp file with suffix ".npz.tmp".
numpy's np.savez appends ".npz" to any target whose name does not already end
in ".npz", so it wrote the real archive to <tmp>.npz.tmp.npz and left the
intended temp file (<tmp>.npz.tmp) at 0 bytes. The subsequent
os.replace(tmp_path, npz_path) then moved the EMPTY file into place and
orphaned the real data. Result: every persisted index was a 0-byte .npz that
crashed load() with "EOFError: No data left in file", plus an orphan
".npz.tmp.npz" file left behind in the directory.

Fix: give the temp file a ".npz" suffix so numpy does not rename it. The
os.replace is then a true atomic rename of the populated archive.

These tests save a 2-vector index and assert: the written .npz is non-empty,
load() round-trips, search() returns the correct neighbor, and no orphan temp
file remains in the directory.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

np = pytest.importorskip("numpy")

from memory.vector_index import VectorIndex  # noqa: E402


def _build_index():
    idx = VectorIndex(dimension=3)
    idx.add("a", np.array([1.0, 0.0, 0.0]))
    idx.add("b", np.array([0.0, 1.0, 0.0]))
    return idx


def test_save_writes_nonempty_npz(tmp_path):
    base = str(tmp_path / "idx")
    _build_index().save(base)

    npz_path = base + ".npz"
    assert os.path.exists(npz_path), "save() did not write the .npz file"
    assert os.path.getsize(npz_path) > 0, (
        "save() wrote a 0-byte .npz (temp-file suffix corruption regression)"
    )


def test_save_load_roundtrip_and_search(tmp_path):
    base = str(tmp_path / "idx")
    _build_index().save(base)

    loaded = VectorIndex(dimension=3)
    loaded.load(base)

    assert loaded.dimension == 3
    assert sorted(loaded.ids) == ["a", "b"]
    assert len(loaded.embeddings) == 2

    results = loaded.search(np.array([1.0, 0.0, 0.0]), top_k=1)
    assert len(results) == 1
    assert results[0][0] == "a", "nearest neighbor of [1,0,0] should be 'a'"
    assert results[0][1] > 0.99


def test_save_leaves_no_orphan_temp_file(tmp_path):
    base = str(tmp_path / "idx")
    _build_index().save(base)

    leftovers = sorted(os.listdir(tmp_path))
    # Only the two intended sidecar files should remain.
    assert leftovers == ["idx.json", "idx.npz"], (
        f"unexpected files after save (orphan temp regression): {leftovers}"
    )
    for name in leftovers:
        assert ".tmp" not in name, f"orphan temp file left behind: {name}"
