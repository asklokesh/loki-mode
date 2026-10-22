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

    def embed(self, text, input_type="document"):
        raise RuntimeError("primary embed down")

    def embed_batch(self, texts, input_type="document"):
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


def _clean_env(monkeypatch_env):
    saved = {k: os.environ.pop(k, None) for k in monkeypatch_env}
    return saved


def _restore_env(saved):
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_voyage_key_alone_never_selects_voyage():
    """VOYAGE_API_KEY with LOKI_EMBEDDING_PROVIDER unset must stay local (privacy)."""
    saved = _clean_env(["LOKI_EMBEDDING_PROVIDER", "LOKI_EMBEDDING_MODEL"])
    os.environ["VOYAGE_API_KEY"] = "pa-test-key"
    try:
        config = EmbeddingConfig.from_env()
        assert config.provider == "local", config.provider
        assert "voyage" not in config.fallback_providers
        engine = EmbeddingEngine(config=config)
        assert engine._current_provider_name == "local", engine._current_provider_name
        assert "voyage" not in engine._providers, "voyage must not be registered from key alone"
    finally:
        os.environ.pop("VOYAGE_API_KEY", None)
        _restore_env(saved)


def test_voyage_selected_only_when_named():
    """LOKI_EMBEDDING_PROVIDER=voyage registers Voyage with the code model default."""
    saved = _clean_env(["LOKI_EMBEDDING_MODEL"])
    os.environ["VOYAGE_API_KEY"] = "pa-test-key"
    os.environ["LOKI_EMBEDDING_PROVIDER"] = "voyage"
    try:
        config = EmbeddingConfig.from_env()
        assert config.provider == "voyage"
        assert config.model == "voyage-code-4", config.model
        assert config.dimension == 1024, config.dimension
        engine = EmbeddingEngine(config=config)
        assert "voyage" in engine._providers
        assert engine._providers["voyage"].get_name() == "voyage"
        assert engine._providers["voyage"].api_key == "pa-test-key"
        assert "voyage" not in config.to_dict().get("fallback_providers")
        assert config.to_dict()["has_voyage_key"] is True
    finally:
        os.environ.pop("VOYAGE_API_KEY", None)
        os.environ.pop("LOKI_EMBEDDING_PROVIDER", None)
        _restore_env(saved)


def test_voyage_named_without_key_falls_back_local():
    saved = _clean_env(["VOYAGE_API_KEY", "LOKI_EMBEDDING_MODEL"])
    os.environ["LOKI_EMBEDDING_PROVIDER"] = "voyage"
    try:
        engine = EmbeddingEngine(config=EmbeddingConfig.from_env())
        assert engine._current_provider_name == "local", engine._current_provider_name
    finally:
        os.environ.pop("LOKI_EMBEDDING_PROVIDER", None)
        _restore_env(saved)


class _Resp:
    def __init__(self, n):
        self.embeddings = [[1.0, 0.0, 0.0, 0.0]] * n


class _RecordingClient:
    """Stands in for cohere.Client / voyageai.Client; records input_type."""

    def __init__(self):
        self.input_types = []

    def embed(self, *args, **kwargs):
        self.input_types.append(kwargs.get("input_type"))
        texts = kwargs.get("texts", args[0] if args else [])
        return _Resp(len(texts))


def _remote(cls_name):
    import memory.embeddings as m

    prov = getattr(m, cls_name)(api_key="test-key", dimension=4)
    prov._cohere_available = True
    prov._voyage_available = True
    client = _RecordingClient()
    prov._client = client
    return prov, client


def test_cohere_maps_input_type():
    prov, client = _remote("CohereEmbeddingProvider")
    prov.embed("q", input_type="query")
    prov.embed("d")
    prov.embed("d2", input_type="document")
    prov.embed_batch(["a", "b"], input_type="query")
    assert client.input_types == [
        "search_query", "search_document", "search_document", "search_query"
    ], client.input_types


def test_voyage_maps_input_type():
    prov, client = _remote("VoyageEmbeddingProvider")
    prov.embed("q", input_type="query")
    prov.embed("d")
    assert client.input_types == ["query", "document"], client.input_types


def test_input_type_rejects_unknown_value():
    prov, _ = _remote("CohereEmbeddingProvider")
    for call in (lambda: prov.embed("x", input_type="search_query"), lambda: _engine().embed("x", input_type="bogus")):
        try:
            call()
        except ValueError:
            continue
        raise AssertionError("unknown input_type must raise ValueError")


def test_local_and_openai_accept_and_ignore_input_type():
    import memory.embeddings as m

    eng = _engine()
    a = eng.embed("same text", input_type="query")
    b = eng.embed("same text")
    assert np.allclose(a, b), "local provider must ignore input_type"
    local = eng._providers["local"]
    assert np.allclose(local.embed("t", "query"), local.embed("t", "document"))
    oa = m.OpenAIEmbeddingProvider(api_key="k")
    seen = []

    class _OA:
        class embeddings:
            @staticmethod
            def create(**kw):
                seen.append(sorted(kw))

                class R:
                    data = [type("D", (), {"embedding": [0.1, 0.2]})()] * len(
                        kw["input"] if isinstance(kw["input"], list) else [1]
                    )

                return R

    oa._client = _OA
    oa._openai_available = True
    oa.embed("x", input_type="query")
    oa.embed_batch(["x"], input_type="query")
    assert all("input_type" not in k for k in seen), seen


def test_engine_cache_separates_query_from_document():
    import memory.embeddings as m

    cfg = EmbeddingConfig(provider="local", cache_enabled=True)
    eng = EmbeddingEngine(config=cfg)
    calls = []
    real = eng._primary_provider

    class _Spy:
        def __getattr__(self, n):
            return getattr(real, n)

        def embed(self, text, input_type="document"):
            calls.append(input_type)
            return real.embed(text, input_type)

    eng._primary_provider = _Spy()
    eng.embed("hello world", input_type="query")
    eng.embed("hello world")
    eng.embed("hello world", input_type="query")
    assert calls == ["query", "document"], calls


def test_retrieval_query_path_passes_query_input_type():
    from memory.retrieval import MemoryRetrieval

    seen = []

    class _SpyEngine:
        def embed(self, text, *args, **kwargs):
            seen.append((text, args, kwargs))
            return np.zeros(4, dtype=np.float32)

    class _Index:
        def search(self, vec, top_k):
            return []

    r = MemoryRetrieval.__new__(MemoryRetrieval)
    r.embedding_engine = _SpyEngine()
    r.vector_indices = {"episodic": _Index()}
    r._indices_built_at = None
    r.retrieve_by_similarity("find the thing", "episodic")
    assert len(seen) == 1, seen
    text, args, kwargs = seen[0]
    assert text == "find the thing"
    assert kwargs.get("input_type") == "query" or "query" in args, seen


class _StubProvider:
    """Deterministic non-unit provider of a given native dimension."""

    normalized = False

    def __init__(self, dim):
        self.dim = dim

    def embed(self, text, input_type="document"):
        return self.embed_batch([text], input_type)[0]

    def embed_batch(self, texts, input_type="document"):
        rng = np.random.RandomState(7)
        return (rng.rand(len(texts), self.dim).astype(np.float32) + 0.5) * 3.0

    def get_dimension(self):
        return self.dim

    def get_name(self):
        return "stub"

    def is_available(self):
        return True


def _stub_engine(native_dim, **cfg):
    config = EmbeddingConfig(
        provider="local", cache_enabled=False, fallback_providers=["stub"], **cfg
    )
    engine = EmbeddingEngine(config=config)
    engine._providers["stub"] = _StubProvider(native_dim)
    engine._use_fallback()
    return engine


def test_output_dimension_truncates_stub_provider_to_256():
    engine = _stub_engine(1024, output_dimension=256)
    assert engine.dimension == 256, engine.dimension
    vec = engine.embed("alpha beta")
    assert vec.shape == (256,), vec.shape
    assert abs(float(np.linalg.norm(vec)) - 1.0) < 1e-5, "truncated vector must be re-normalized"
    mat = engine.embed_batch(["alpha", "beta", "gamma"])
    assert mat.shape == (3, 256), mat.shape


def test_default_config_keeps_native_dimension():
    engine = _stub_engine(1024)
    assert engine.config.output_dimension is None
    assert engine.config.dtype == "float32"
    assert engine.dimension == 1024, engine.dimension
    assert engine.embed("alpha").shape == (1024,)


def test_output_dimension_above_native_is_clamped_and_invalid_rejected():
    engine = _stub_engine(1024, output_dimension=4096)
    assert engine.dimension == 1024, engine.dimension
    for bad in (0, -5):
        try:
            EmbeddingConfig(output_dimension=bad)
        except ValueError:
            continue
        raise AssertionError(f"output_dimension={bad} should raise ValueError")
    try:
        EmbeddingConfig(dtype="int3")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown dtype should raise ValueError")


def test_config_reads_output_dimension_and_dtype_from_env_and_file():
    saved = _clean_env(["LOKI_EMBEDDING_PROVIDER", "LOKI_EMBEDDING_MODEL"])
    os.environ["LOKI_EMBEDDING_OUTPUT_DIMENSION"] = "256"
    os.environ["LOKI_EMBEDDING_DTYPE"] = "float16"
    try:
        config = EmbeddingConfig.from_env()
        assert (config.output_dimension, config.dtype) == (256, "float16")
        assert config.to_dict()["output_dimension"] == 256
    finally:
        os.environ.pop("LOKI_EMBEDDING_OUTPUT_DIMENSION", None)
        os.environ.pop("LOKI_EMBEDDING_DTYPE", None)
        _restore_env(saved)
    import json
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "cfg.json")
        with open(path, "w") as f:
            json.dump({"output_dimension": 128, "dtype": "float16"}, f)
        config = EmbeddingConfig.from_file(path)
    assert (config.output_dimension, config.dtype) == (128, "float16")


def test_provider_normalized_declarations_and_index_kwargs():
    import memory.embeddings as m

    assert m.LocalEmbeddingProvider.normalized is True
    assert m.VoyageEmbeddingProvider.normalized is True
    assert m.BaseEmbeddingProvider.normalized is False
    engine = _stub_engine(1024, output_dimension=256, dtype="float16")
    # kwargs follow the active provider's declaration (the stub declares none)
    assert engine.vector_index_kwargs() == {
        "dimension": 256, "normalized": False, "dtype": "float16"
    }
    engine._primary_provider.normalized = True
    assert engine.vector_index_kwargs() == {
        "dimension": 256, "normalized": True, "dtype": "float16"
    }


def _run():
    tests = [
        test_similarity_search_single_1d_corpus,
        test_similarity_search_2d_corpus_unchanged,
        test_compute_quality_score_zero_length_embedding,
        test_compute_quality_score_zero_vector_normalize,
        test_fallback_embed_caches_and_hits_on_repeat,
        test_fallback_embed_uses_chunked_path_for_multichunk,
        test_voyage_key_alone_never_selects_voyage,
        test_voyage_selected_only_when_named,
        test_voyage_named_without_key_falls_back_local,
        test_cohere_maps_input_type,
        test_voyage_maps_input_type,
        test_input_type_rejects_unknown_value,
        test_local_and_openai_accept_and_ignore_input_type,
        test_engine_cache_separates_query_from_document,
        test_retrieval_query_path_passes_query_input_type,
        test_output_dimension_truncates_stub_provider_to_256,
        test_default_config_keeps_native_dimension,
        test_output_dimension_above_native_is_clamped_and_invalid_rejected,
        test_config_reads_output_dimension_and_dtype_from_env_and_file,
        test_provider_normalized_declarations_and_index_kwargs,
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
