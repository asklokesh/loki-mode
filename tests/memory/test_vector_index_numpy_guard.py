"""
Regression test for VectorIndex numpy-optional handling.

Bug: memory/vector_index.py declared a module-level NUMPY_AVAILABLE flag and
set ``np = None`` when numpy could not be imported, advertising itself as
"No FAISS dependency required - uses pure numpy". But NUMPY_AVAILABLE was
never read anywhere, and every method (add, search, save, load) calls
``np.*`` unconditionally. With numpy absent, construction succeeded and the
crash surfaced only later, deep inside a method, as an opaque
``AttributeError: 'NoneType' object has no attribute 'array'`` (e.g. in
save() at ``np.array(...)``) rather than an honest, fail-fast message.

Fix: VectorIndex.__init__ consults NUMPY_AVAILABLE and raises a clear
ImportError immediately, mirroring memory/embeddings.py's numpy guard.

These tests do not require numpy to be uninstalled: they monkeypatch the
module's NUMPY_AVAILABLE flag (and ``np``) to simulate the absent-dependency
environment, then assert the clear ImportError instead of a late
AttributeError.
"""

import importlib
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# numpy is genuinely required to exercise the happy path below; skip cleanly
# if the host lacks it (the guard itself is verified via monkeypatch, which
# does not need real numpy, but the round-trip assertion does).
np = pytest.importorskip("numpy")

import memory.vector_index as vi  # noqa: E402


def test_constructor_raises_clear_error_when_numpy_missing(monkeypatch):
    """
    With numpy unavailable, constructing a VectorIndex must raise a clear
    ImportError that names numpy, NOT succeed and then crash later with an
    opaque AttributeError on a None np.
    """
    monkeypatch.setattr(vi, "NUMPY_AVAILABLE", False)
    monkeypatch.setattr(vi, "np", None)

    with pytest.raises(ImportError) as exc:
        vi.VectorIndex(dimension=3)

    assert "numpy" in str(exc.value).lower(), (
        f"error message should name numpy, got: {exc.value}"
    )


def test_numpy_available_flag_is_consulted(monkeypatch):
    """
    Pin that NUMPY_AVAILABLE is actually read (it was previously dead code).
    Forcing it False must block construction even though the real ``np`` is
    still importable in this process.
    """
    monkeypatch.setattr(vi, "NUMPY_AVAILABLE", False)
    # Leave vi.np as the real module on purpose: if the guard keyed off
    # ``np is None`` instead of the flag, this would wrongly succeed.
    with pytest.raises(ImportError):
        vi.VectorIndex(dimension=3)


def test_constructor_succeeds_when_numpy_present():
    """Guard against the check regressing into a false-positive that blocks
    the normal (numpy-present) path."""
    idx = vi.VectorIndex(dimension=3)
    idx.add("a", np.array([1.0, 0.0, 0.0]))
    results = idx.search(np.array([1.0, 0.0, 0.0]), top_k=1)
    assert results[0][0] == "a"
