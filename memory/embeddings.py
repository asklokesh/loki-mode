"""
Loki Mode - Local Embeddings for Semantic Similarity Search

This module provides embedding generation and similarity search capabilities
using sentence-transformers (with TF-IDF fallback when not available).

Usage:
    from memory.embeddings import EmbeddingEngine

    engine = EmbeddingEngine()
    embedding = engine.embed("some text")
    results = engine.similarity_search(query_emb, corpus_embs, top_k=5)
"""

from typing import List, Optional, Tuple
import logging
import hashlib

# Numpy is required - fail clearly if not available
try:
    import numpy as np
except ImportError as e:
    raise ImportError(
        "numpy is required for the embeddings module. "
        "Install it with: pip install numpy"
    ) from e

# Optional: sentence-transformers for high-quality embeddings
_SENTENCE_TRANSFORMERS_AVAILABLE = False
try:
    from sentence_transformers import SentenceTransformer
    _SENTENCE_TRANSFORMERS_AVAILABLE = True
except ImportError:
    SentenceTransformer = None

logger = logging.getLogger(__name__)


class EmbeddingEngine:
    """
    Local embedding engine for semantic similarity search.

    Uses sentence-transformers when available, falls back to TF-IDF otherwise.
    Embeddings are cached to avoid redundant computation.
    """

    DEFAULT_MODEL = "all-MiniLM-L6-v2"
    DEFAULT_DIMENSION = 384

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        dimension: int = DEFAULT_DIMENSION,
    ):
        """
        Initialize the embedding engine.

        Args:
            model_name: Name of the sentence-transformers model to use.
                        Default: "all-MiniLM-L6-v2" (384 dimensions)
            dimension: Embedding dimension. Used for fallback mode and validation.
        """
        self.model_name = model_name
        self.dimension = dimension
        self._model: Optional[object] = None  # Lazy loaded
        self._cache: dict = {}
        self._using_fallback = False

        # Check if we need to use fallback
        if not _SENTENCE_TRANSFORMERS_AVAILABLE:
            logger.warning(
                "sentence-transformers not installed. "
                "Using TF-IDF fallback with degraded quality. "
                "Install with: pip install sentence-transformers"
            )
            self._using_fallback = True
            self._tfidf_vocab: dict = {}
            self._tfidf_idf: dict = {}
            self._tfidf_doc_count = 0

    def _load_model(self) -> None:
        """
        Lazy load the sentence-transformers model.

        Only loads when first embedding is requested.
        """
        if self._model is not None:
            return

        if not _SENTENCE_TRANSFORMERS_AVAILABLE:
            return

        logger.info(f"Loading sentence-transformers model: {self.model_name}")
        try:
            self._model = SentenceTransformer(self.model_name)
            # Update dimension from actual model
            test_embedding = self._model.encode(["test"], convert_to_numpy=True)
            self.dimension = test_embedding.shape[1]
            logger.info(f"Model loaded. Embedding dimension: {self.dimension}")
        except Exception as e:
            logger.warning(
                f"Failed to load model {self.model_name}: {e}. "
                "Falling back to TF-IDF."
            )
            self._using_fallback = True
            self._tfidf_vocab = {}
            self._tfidf_idf = {}
            self._tfidf_doc_count = 0

    def _get_cache_key(self, text: str) -> str:
        """Generate a cache key for the given text."""
        return hashlib.md5(text.encode('utf-8')).hexdigest()

    def _normalize(self, embedding: np.ndarray) -> np.ndarray:
        """
        L2 normalize an embedding vector.

        Args:
            embedding: Input embedding vector or matrix.

        Returns:
            Normalized embedding with unit L2 norm.
        """
        if embedding.ndim == 1:
            norm = np.linalg.norm(embedding)
            if norm == 0:
                return embedding
            return embedding / norm
        else:
            # Handle batch normalization
            norms = np.linalg.norm(embedding, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1, norms)  # Avoid division by zero
            return embedding / norms

    def _tfidf_embed(self, text: str) -> np.ndarray:
        """
        Generate TF-IDF based embedding (fallback mode).

        This is a simplified implementation that creates fixed-dimension
        embeddings using hashed TF-IDF features.

        Args:
            text: Input text to embed.

        Returns:
            Normalized embedding vector.
        """
        # Simple tokenization
        tokens = text.lower().split()
        tokens = [t.strip('.,!?;:()[]{}"\'-') for t in tokens if t.strip('.,!?;:()[]{}"\'-')]

        if not tokens:
            return np.zeros(self.dimension)

        # Compute term frequencies
        tf = {}
        for token in tokens:
            tf[token] = tf.get(token, 0) + 1

        # Normalize TF
        max_tf = max(tf.values()) if tf else 1
        for token in tf:
            tf[token] = 0.5 + 0.5 * (tf[token] / max_tf)

        # Create embedding using feature hashing
        embedding = np.zeros(self.dimension)
        for token, freq in tf.items():
            # Hash token to get index
            token_hash = int(hashlib.md5(token.encode('utf-8')).hexdigest(), 16)
            idx = token_hash % self.dimension
            # Use another hash for sign
            sign = 1 if (token_hash // self.dimension) % 2 == 0 else -1
            embedding[idx] += sign * freq

        return self._normalize(embedding)

    def embed(self, text: str) -> np.ndarray:
        """
        Generate embedding for a single text.

        Uses caching to avoid re-computing embeddings for the same text.

        Args:
            text: Input text to embed.

        Returns:
            Normalized embedding vector of shape (dimension,).
        """
        cache_key = self._get_cache_key(text)

        if cache_key in self._cache:
            return self._cache[cache_key]

        if self._using_fallback:
            embedding = self._tfidf_embed(text)
        else:
            self._load_model()
            if self._model is None:
                # Model failed to load, use fallback
                embedding = self._tfidf_embed(text)
            else:
                embedding = self._model.encode(
                    text,
                    convert_to_numpy=True,
                    normalize_embeddings=True
                )

        # Ensure proper shape and type
        embedding = np.asarray(embedding, dtype=np.float32)
        if embedding.ndim > 1:
            embedding = embedding.squeeze()

        self._cache[cache_key] = embedding
        return embedding

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """
        Generate embeddings for multiple texts.

        More efficient than calling embed() individually when using
        sentence-transformers, as it batches the computation.

        Args:
            texts: List of texts to embed.

        Returns:
            Normalized embedding matrix of shape (len(texts), dimension).
        """
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)

        # Check cache for all texts
        cache_keys = [self._get_cache_key(t) for t in texts]
        cached_results = {k: self._cache.get(k) for k in cache_keys}

        # Find texts that need computing
        texts_to_compute = []
        indices_to_compute = []
        for i, (text, key) in enumerate(zip(texts, cache_keys)):
            if cached_results[key] is None:
                texts_to_compute.append(text)
                indices_to_compute.append(i)

        # Compute missing embeddings
        if texts_to_compute:
            if self._using_fallback:
                new_embeddings = np.array([
                    self._tfidf_embed(t) for t in texts_to_compute
                ], dtype=np.float32)
            else:
                self._load_model()
                if self._model is None:
                    new_embeddings = np.array([
                        self._tfidf_embed(t) for t in texts_to_compute
                    ], dtype=np.float32)
                else:
                    new_embeddings = self._model.encode(
                        texts_to_compute,
                        convert_to_numpy=True,
                        normalize_embeddings=True,
                        batch_size=32
                    )

            # Update cache
            for idx, text_idx in enumerate(indices_to_compute):
                key = cache_keys[text_idx]
                self._cache[key] = new_embeddings[idx]

        # Assemble results
        results = np.zeros((len(texts), self.dimension), dtype=np.float32)
        for i, key in enumerate(cache_keys):
            results[i] = self._cache[key]

        return results

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """
        Compute cosine similarity between two embeddings.

        Assumes embeddings are already normalized.

        Args:
            a: First embedding vector.
            b: Second embedding vector.

        Returns:
            Cosine similarity score in range [-1, 1].
        """
        a = np.asarray(a, dtype=np.float32)
        b = np.asarray(b, dtype=np.float32)

        # Normalize in case they aren't already
        a_norm = self._normalize(a)
        b_norm = self._normalize(b)

        return float(np.dot(a_norm, b_norm))

    def similarity_search(
        self,
        query_embedding: np.ndarray,
        corpus_embeddings: np.ndarray,
        top_k: int = 5
    ) -> List[Tuple[int, float]]:
        """
        Find the top-k most similar embeddings from a corpus.

        Args:
            query_embedding: Query embedding vector of shape (dimension,).
            corpus_embeddings: Corpus embedding matrix of shape (n, dimension).
            top_k: Number of top results to return.

        Returns:
            List of (index, similarity_score) tuples, sorted by similarity
            in descending order.
        """
        query_embedding = np.asarray(query_embedding, dtype=np.float32)
        corpus_embeddings = np.asarray(corpus_embeddings, dtype=np.float32)

        if corpus_embeddings.size == 0:
            return []

        # Normalize
        query_norm = self._normalize(query_embedding)
        corpus_norm = self._normalize(corpus_embeddings)

        # Compute similarities (dot product of normalized vectors = cosine similarity)
        similarities = np.dot(corpus_norm, query_norm)

        # Get top-k indices
        k = min(top_k, len(similarities))
        if k <= 0:
            return []

        # Use argpartition for efficiency when k << n
        if k < len(similarities):
            # Get indices of k largest values
            indices = np.argpartition(similarities, -k)[-k:]
            # Sort these k indices by their similarity values
            indices = indices[np.argsort(similarities[indices])[::-1]]
        else:
            indices = np.argsort(similarities)[::-1]

        return [(int(idx), float(similarities[idx])) for idx in indices]

    def clear_cache(self) -> None:
        """Clear the embedding cache."""
        self._cache.clear()
        logger.debug("Embedding cache cleared")

    def get_dimension(self) -> int:
        """
        Get the embedding dimension.

        Returns:
            Dimension of embedding vectors.
        """
        return self.dimension

    def is_using_fallback(self) -> bool:
        """
        Check if using TF-IDF fallback mode.

        Returns:
            True if using fallback, False if using sentence-transformers.
        """
        return self._using_fallback

    def get_cache_size(self) -> int:
        """
        Get the number of cached embeddings.

        Returns:
            Number of entries in the cache.
        """
        return len(self._cache)


# Convenience function for one-off similarity checks
def quick_similarity(text_a: str, text_b: str) -> float:
    """
    Quick similarity check between two texts.

    Creates a temporary engine - for repeated use, create an EmbeddingEngine
    instance instead.

    Args:
        text_a: First text.
        text_b: Second text.

    Returns:
        Cosine similarity score.
    """
    engine = EmbeddingEngine()
    emb_a = engine.embed(text_a)
    emb_b = engine.embed(text_b)
    return engine.similarity(emb_a, emb_b)
