"""
Regression tests for memory/embeddings.py edge-case bugs found in the
2026-06 adversarial bug-hunt.

Each test is self-contained (no pytest fixtures, runnable via
`python3 tests/test_embeddings_edge_cases.py`) and is NON-VACUOUS: it
asserts on concrete values/behaviors, not merely "no exception".
"""
import math
import os
import sys

try:
    import numpy as np
except ImportError:  # numpy is an optional dep; skip cleanly when absent (CI gate env)
    try:
        import pytest

        pytest.skip("numpy not installed; embeddings edge-case tests skipped", allow_module_level=True)
    except ImportError:
        print("SKIP: numpy not installed; embeddings edge-case tests skipped")
        sys.exit(0)

# Make the repo root importable so `memory` resolves regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from memory.embeddings import (  # noqa: E402
    EmbeddingConfig,
    EmbeddingEngine,
    compute_quality_score,
)


def _engine() -> EmbeddingEngine:
    # cache disabled so each call exercises the real compute path.
    return EmbeddingEngine(config=EmbeddingConfig(provider="local", cache_enabled=False))


def test_similarity_search_single_1d_corpus():
    """
    BUG: similarity_search() crashed with
    "object of type 'numpy.float32' has no len()" when the corpus was a
    single 1-D vector (shape (dimension,)) rather than 2-D (1, dimension).
    np.dot of a 1-D corpus with the 1-D query collapses to a 0-d scalar
    on which len() then fails.

    Non-vacuous: assert the single result is returned AND that its score
    matches the directly-computed cosine similarity (a self-match must be
    ~1.0), proving the promotion produced correct math, not just no-throw.
    """
    eng = _engine()
    query = eng.embed("the quick brown fox")
    single = eng.embed("the quick brown fox")  # shape (dimension,), self-match

    results = eng.similarity_search(query, single, top_k=3)

    assert len(results) == 1, f"expected exactly 1 result, got {len(results)}"
    idx, score = results[0]
    assert idx == 0, f"expected index 0, got {idx}"
    # Self-match of L2-normalized vectors -> cosine ~ 1.0.
    assert abs(score - 1.0) < 1e-4, f"expected self-match score ~1.0, got {score}"


def test_similarity_search_2d_corpus_unchanged():
    """
    Guard against the 1-D fix regressing the normal 2-D path: the promotion
    must be a no-op for a (n, dimension) corpus and still rank the exact
    match first.
    """
    eng = _engine()
    texts = ["alpha document", "beta document", "gamma document"]
    corpus = eng.embed_batch(texts)
    assert corpus.ndim == 2 and corpus.shape[0] == 3

    query = eng.embed("beta document")
    results = eng.similarity_search(query, corpus, top_k=3)

    assert len(results) == 3
    # The exact-text match (index 1) must rank first.
    assert results[0][0] == 1, f"expected index 1 ranked first, got {results[0][0]}"
    assert abs(results[0][1] - 1.0) < 1e-4


def test_compute_quality_score_zero_length_embedding():
    """
    HARDENING: compute_quality_score() on a zero-length embedding used to
    produce variance=NaN (np.var of an empty array) which silently
    propagated through min(variance*10, 1.0) into a bogus perfect
    score=1.0 (min(1.0, NaN) returns 1.0). An empty embedding must never
    be rated as high quality.

    Non-vacuous: assert variance is finite (not NaN) and the score is the
    low value implied by zero density + zero variance, not 1.0.
    """
    q = compute_quality_score(np.array([], dtype=np.float32), "hello", "local")

    assert not math.isnan(q.variance), "variance must not be NaN for empty embedding"
    assert q.variance == 0.0, f"expected zero variance, got {q.variance}"
    assert not math.isnan(q.score), "score must not be NaN"
    assert q.score < 0.5, (
        f"empty embedding must not score as high quality, got {q.score}"
    )


def test_compute_quality_score_zero_vector_normalize():
    """
    HARDENING (zero-vector): a full-dimension all-zero embedding (what the
    TF-IDF fallback yields for empty/whitespace text) must score low and
    finite, never NaN.
    """
    zero = np.zeros(384, dtype=np.float32)
    q = compute_quality_score(zero, "", "local")

    assert q.density == 0.0
    assert q.variance == 0.0
    assert not math.isnan(q.score)
    assert q.score < 0.5, f"all-zero embedding scored too high: {q.score}"


class _FailingPrimary:
    """A provider whose embed/embed_batch always raise, forcing the fallback.

    Delegates is_available/get_dimension to a real inner provider so the engine
    treats it as a usable primary until embed() is actually called.
    """

    def __init__(self, inner):
        self._inner = inner

    def embed(self, text):
        raise RuntimeError("primary embed down")

    def embed_batch(self, texts):
        raise RuntimeError("primary batch down")

    def is_available(self):
        return True

    def get_dimension(self):
        return self._inner.get_dimension()


def test_fallback_embed_caches_and_hits_on_repeat():
    """
    BUG: when the primary provider failed, embed() computed the cache key with
    the pre-fallback provider name, then _use_fallback() switched the provider
    and stored the vector under that OLD key. The next call recomputed the key
    with the NEW provider name, so it never hit -> permanent cache miss and a
    re-embed on every fallback request.

    The fix recomputes the cache key AFTER _use_fallback(). This test forces the
    primary to fail, simulates a provider-name change across the fallback, and
    asserts the SECOND identical call is served from cache.

    Non-vacuous: against the OLD code, cache_hits does not increase on the repeat
    call (delta 0); the assertion of delta == 1 fails.
    """
    eng = EmbeddingEngine(config=EmbeddingConfig(provider="local", cache_enabled=True))
    eng._primary_provider = _FailingPrimary(eng._primary_provider)
    # Make the current provider name differ from the fallback ("local") so the
    # pre/post-fallback cache keys genuinely diverge (the real openai->local case).
    eng._current_provider_name = "openai"

    text = "embed me please " * 5

    before = eng._metrics["cache_hits"]
    eng.embed(text)  # falls back, must store under the post-fallback key
    after_first = eng._metrics["cache_hits"]
    eng.embed(text)  # identical -> must hit cache
    after_second = eng._metrics["cache_hits"]

    assert after_first == before, "first fallback call must not be a cache hit"
    assert after_second - after_first == 1, (
        "repeat fallback call must hit the cache; got delta %d (the old code "
        "stored under the pre-fallback key and missed forever)"
        % (after_second - after_first)
    )


def test_fallback_embed_uses_chunked_path_for_multichunk():
    """
    BUG (companion): the fallback path embedded the raw, un-chunked text, while
    the success path chunks long text and length-weighted-averages the chunk
    vectors. For multi-chunk input the two paths produced different vectors. The
    fix runs the fallback through the same _chunk_text + weighted-average path.

    Non-vacuous: we force a multi-chunk input (small max_chunk_size) and assert
    the fallback vector equals the vector the same provider produces via the
    explicit chunk + weighted-average computation, NOT the raw single-shot embed.
    """
    cfg = EmbeddingConfig(
        provider="local",
        cache_enabled=False,
        chunking_strategy="fixed",
        max_chunk_size=20,
    )
    eng = EmbeddingEngine(config=cfg)
    inner = eng._primary_provider  # real local provider
    eng._primary_provider = _FailingPrimary(inner)
    eng._current_provider_name = "openai"

    text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
    chunks = eng._chunk_text(text)
    assert len(chunks) > 1, "test setup must yield multiple chunks"

    got = eng.embed(text)

    # Expected: the fallback (local) provider's chunked + length-weighted average.
    chunk_vecs = inner.embed_batch(chunks)
    w = np.array([len(c) for c in chunks], dtype=np.float32)
    w = w / w.sum()
    expected = np.average(chunk_vecs, axis=0, weights=w)
    expected = eng._normalize(expected).astype(np.float32)
    if expected.ndim > 1:
        expected = expected.squeeze()

    # And the raw single-shot embed (the OLD buggy path) for a distinctness check.
    raw = eng._normalize(inner.embed(text)).astype(np.float32)

    assert np.allclose(got, expected, atol=1e-5), (
        "fallback vector must match the chunked + weighted-average path"
    )
    # Only meaningful when the two paths actually differ for this input.
    if not np.allclose(expected, raw, atol=1e-5):
        assert not np.allclose(got, raw, atol=1e-5), (
            "fallback must NOT use the raw un-chunked path when chunking applies"
        )


def _run():
    tests = [
        test_similarity_search_single_1d_corpus,
        test_similarity_search_2d_corpus_unchanged,
        test_compute_quality_score_zero_length_embedding,
        test_compute_quality_score_zero_vector_normalize,
        test_fallback_embed_caches_and_hits_on_repeat,
        test_fallback_embed_uses_chunked_path_for_multichunk,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"[PASS] {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"[FAIL] {t.__name__}: {e}")
        except Exception as e:  # surface unexpected crashes (e.g. the original bug)
            failed += 1
            print(f"[ERROR] {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run())
