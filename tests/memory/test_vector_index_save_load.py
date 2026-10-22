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


def _unit_fixture(n=12, dim=8, seed=3):
    rng = np.random.RandomState(seed)
    mat = rng.randn(n, dim).astype(np.float32)
    return mat / np.linalg.norm(mat, axis=1, keepdims=True)


def _filled(normalized, mat, dtype="float32"):
    idx = VectorIndex(dimension=mat.shape[1], normalized=normalized, dtype=dtype)
    for i, row in enumerate(mat):
        idx.add(f"v{i}", row)
    return idx


def test_normalized_dot_product_matches_cosine_top3():
    mat = _unit_fixture()
    query = mat[0] * 0.7 + mat[5] * 0.3
    cosine = _filled(False, mat).search(query, top_k=3)
    dot = _filled(True, mat).search(query, top_k=3)
    assert [r[0] for r in dot] == [r[0] for r in cosine]
    for a, b in zip(dot, cosine):
        assert abs(a[1] - b[1]) < 1e-5


def test_normalized_flag_skips_renormalization_copy():
    mat = _unit_fixture()
    calls = {"n": 0}

    def spy(self):
        calls["n"] += 1
        VectorIndex._normalize_vectors_orig(self)

    VectorIndex._normalize_vectors_orig = VectorIndex._normalize_vectors
    VectorIndex._normalize_vectors = spy
    try:
        _filled(True, mat).search(mat[1], top_k=1)
        assert calls["n"] == 0, "normalized=True must not renormalize stored vectors"
        _filled(False, mat).search(mat[1], top_k=1)
        assert calls["n"] == 1, "default must still normalize for cosine"
    finally:
        VectorIndex._normalize_vectors = VectorIndex._normalize_vectors_orig
        del VectorIndex._normalize_vectors_orig


def test_default_index_files_have_unchanged_layout(tmp_path):
    base = str(tmp_path / "idx")
    _build_index().save(base)
    with np.load(base + ".npz") as data:
        assert sorted(data.files) == ["dimension", "embeddings"]
        assert data["embeddings"].dtype == np.float32
        assert data["embeddings"].tobytes() == np.array(
            [[1, 0, 0], [0, 1, 0]], dtype=np.float32
        ).tobytes()
    sidecar = open(base + ".json", encoding="utf-8").read()
    assert sidecar == (
        '{\n  "ids": [\n    "a",\n    "b"\n  ],\n  "metadata": [\n    {},\n    {}\n  ],\n'
        '  "dimension": 3\n}'
    )


def test_float16_dtype_halves_storage_and_keeps_ranking(tmp_path):
    mat = _unit_fixture()
    full = _filled(True, mat)
    half = _filled(True, mat, dtype="float16")
    assert half.embeddings[0].dtype == np.float16
    assert half.embeddings[0].nbytes * 2 == full.embeddings[0].nbytes
    query = mat[2]
    assert [r[0] for r in half.search(query, top_k=3)] == [
        r[0] for r in full.search(query, top_k=3)
    ]
    base = str(tmp_path / "h")
    half.save(base)
    with np.load(base + ".npz") as data:
        assert data["embeddings"].dtype == np.float16


def test_unknown_dtype_rejected():
    with pytest.raises(ValueError):
        VectorIndex(dimension=3, dtype="int3")


def _nonunit():
    rng = np.random.RandomState(11)
    mat = rng.randn(6, 8).astype(np.float32)
    return mat * np.array([3.0, 1.5, 0.4, 2.2, 5.0, 0.9], dtype=np.float32)[:, None]


def _cosine_scores(mat, query):
    unit = mat / np.linalg.norm(mat, axis=1, keepdims=True)
    return unit @ (query / np.linalg.norm(query))


def test_normalized_add_of_non_unit_vectors_still_scores_cosine():
    mat = _nonunit()
    query = mat[0] + 0.5 * mat[3]
    idx = _filled(True, mat)
    got = {r[0]: r[1] for r in idx.search(query, top_k=6)}
    want = _cosine_scores(mat, query)
    for i in range(6):
        assert abs(got[f"v{i}"] - want[i]) < 1e-5
    assert max(got.values()) <= 1.0 + 1e-5


def test_normalized_update_and_batch_also_normalize():
    mat = _nonunit()
    idx = VectorIndex(dimension=8, normalized=True)
    idx.add_batch([f"v{i}" for i in range(6)], mat)
    idx.update("v1", embedding=mat[1] * 9.0)
    for emb in idx.embeddings:
        assert abs(float(np.linalg.norm(emb)) - 1.0) < 1e-5


def test_old_non_unit_index_loaded_as_normalized_scores_cosine(tmp_path):
    mat = _nonunit()
    base = str(tmp_path / "old")
    _filled(False, mat).save(base)  # the legacy layout, vectors stored non-unit
    query = mat[2] + mat[4]
    loaded = VectorIndex(dimension=8, normalized=True)
    loaded.load(base)
    got = {r[0]: r[1] for r in loaded.search(query, top_k=6)}
    want = _cosine_scores(mat, query)
    for i in range(6):
        assert abs(got[f"v{i}"] - want[i]) < 1e-5


def test_normalized_flag_round_trips_and_default_stays_absent(tmp_path):
    mat = _unit_fixture()
    base = str(tmp_path / "n")
    _filled(True, mat).save(base)
    assert '"normalized": true' in open(base + ".json", encoding="utf-8").read()
    fresh = VectorIndex.from_file(base)
    assert fresh.assume_normalized is True
    plain = str(tmp_path / "p")
    _filled(False, mat).save(plain)
    assert "normalized" not in open(plain + ".json", encoding="utf-8").read()
    assert VectorIndex.from_file(plain).assume_normalized is False


def test_load_casts_to_the_index_dtype(tmp_path):
    mat = _unit_fixture()
    base = str(tmp_path / "h")
    _filled(True, mat, dtype="float16").save(base)
    wide = VectorIndex(dimension=8, normalized=True, dtype="float32")
    wide.load(base)
    assert all(e.dtype == np.float32 for e in wide.embeddings)
    narrow = VectorIndex(dimension=8, normalized=True, dtype="float16")
    narrow.load(base)
    assert all(e.dtype == np.float16 for e in narrow.embeddings)


def test_engine_kwargs_follow_the_provider_normalized_flag():
    from memory.embeddings import EmbeddingEngine

    class _P:
        def __init__(self, n):
            self.normalized = n

    eng = EmbeddingEngine.__new__(EmbeddingEngine)
    eng.dimension = 8
    eng.config = type("C", (), {"dtype": "float32"})()
    eng._primary_provider = _P(False)
    assert eng.vector_index_kwargs()["normalized"] is False
    eng._primary_provider = _P(True)
    assert eng.vector_index_kwargs()["normalized"] is True


def test_normalized_zero_vector_stores_zeros_and_survives_reload(tmp_path):
    idx = VectorIndex(dimension=4, normalized=True)
    idx.add("zero", np.zeros(4, dtype=np.float32))
    idx.add("unit", np.array([3.0, 4.0, 0.0, 0.0]))
    assert not np.isnan(idx.embeddings[0]).any()
    assert not idx.embeddings[0].any()
    path = str(tmp_path / "z")
    idx.save(path)
    loaded = VectorIndex(dimension=4, normalized=True)
    loaded.load(path)
    assert not np.isnan(np.stack(loaded.embeddings)).any()
    assert not loaded.embeddings[loaded.ids.index("zero")].any()
    assert abs(float(np.linalg.norm(loaded.embeddings[loaded.ids.index("unit")])) - 1.0) < 1e-6
    hits = loaded.search(np.array([1.0, 0.0, 0.0, 0.0]), top_k=2)
    assert all(np.isfinite(h[1]) for h in hits)


@pytest.mark.parametrize("bad", [np.inf, -np.inf, np.nan])
def test_normalized_non_finite_vector_is_kept_unnormalized(bad):
    idx = VectorIndex(dimension=3, normalized=True)
    idx.add("bad", np.array([bad, 1.0, 0.0], dtype=np.float32))
    stored = idx.embeddings[0]
    assert stored[0] == bad or (np.isnan(bad) and np.isnan(stored[0]))
    assert stored[1] == 1.0 and stored[2] == 0.0, "finite lanes must not be divided into NaN"
