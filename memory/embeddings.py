"""
Loki Mode - Multi-Provider Embedding System

This module provides embedding generation and similarity search capabilities
with support for multiple providers:
- Local: sentence-transformers (default, no API key required)
- OpenAI: text-embedding-3-small/large
- Cohere: embed-english-v3.0

Features:
- Provider fallback chain for resilience
- Chunking strategies for long text
- Context-aware embedding (include surrounding code)
- Semantic deduplication
- Quality scoring for embeddings
- Caching with provider-specific keys

Usage:
    from memory.embeddings import EmbeddingEngine, EmbeddingConfig

    # Use default local provider
    engine = EmbeddingEngine()
    embedding = engine.embed("some text")

    # Use specific provider
    config = EmbeddingConfig(provider="openai", model="text-embedding-3-small")
    engine = EmbeddingEngine(config=config)
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple, Any
import hashlib
import json
import logging
import os
import re
import time

# Numpy is required - fail clearly if not available
try:
    import numpy as np
except ImportError as e:
    raise ImportError(
        "numpy is required for the embeddings module. "
        "Install it with: pip install numpy"
    ) from e

logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------


class EmbeddingProvider(Enum):
    """Supported embedding providers."""
    LOCAL = "local"
    OPENAI = "openai"
    COHERE = "cohere"


class ChunkingStrategy(Enum):
    """Text chunking strategies for long documents."""
    NONE = "none"  # No chunking, truncate if needed
    FIXED = "fixed"  # Fixed size chunks with overlap
    SENTENCE = "sentence"  # Split on sentence boundaries
    SEMANTIC = "semantic"  # Split on semantic boundaries (paragraphs, code blocks)


@dataclass
class EmbeddingConfig:
    """
    Configuration for the embedding engine.

    Can be loaded from environment variables or JSON config file.
    """
    # Provider settings
    provider: str = "local"
    model: Optional[str] = None  # Provider-specific model name
    fallback_providers: List[str] = field(default_factory=lambda: ["local"])

    # Dimension settings
    dimension: int = 384  # Default for MiniLM-L6-v2

    # API keys (loaded from env if not provided)
    openai_api_key: Optional[str] = None
    cohere_api_key: Optional[str] = None

    # Chunking settings
    chunking_strategy: str = "semantic"
    max_chunk_size: int = 512  # Max tokens per chunk
    chunk_overlap: int = 50  # Overlap between chunks

    # Context settings
    include_context: bool = True
    context_lines: int = 3  # Lines of context to include

    # Quality settings
    min_quality_score: float = 0.5  # Minimum acceptable quality score
    dedup_threshold: float = 0.95  # Similarity threshold for deduplication

    # Performance settings
    batch_size: int = 32
    cache_enabled: bool = True
    timeout: float = 30.0  # API timeout in seconds

    # Provider-specific models
    LOCAL_MODELS = {
        "default": "all-MiniLM-L6-v2",
        "large": "all-mpnet-base-v2",
        "multilingual": "paraphrase-multilingual-MiniLM-L12-v2",
    }

    OPENAI_MODELS = {
        "default": "text-embedding-3-small",
        "large": "text-embedding-3-large",
        "legacy": "text-embedding-ada-002",
    }

    COHERE_MODELS = {
        "default": "embed-english-v3.0",
        "light": "embed-english-light-v3.0",
        "multilingual": "embed-multilingual-v3.0",
    }

    # Model dimensions
    MODEL_DIMENSIONS = {
        "all-MiniLM-L6-v2": 384,
        "all-mpnet-base-v2": 768,
        "paraphrase-multilingual-MiniLM-L12-v2": 384,
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
        "embed-english-v3.0": 1024,
        "embed-english-light-v3.0": 384,
        "embed-multilingual-v3.0": 1024,
    }

    def __post_init__(self):
        """Load API keys from environment if not provided."""
        if self.openai_api_key is None:
            self.openai_api_key = os.environ.get("OPENAI_API_KEY")
        if self.cohere_api_key is None:
            self.cohere_api_key = os.environ.get("COHERE_API_KEY")

        # Set default model based on provider
        if self.model is None:
            if self.provider == "local":
                self.model = self.LOCAL_MODELS["default"]
            elif self.provider == "openai":
                self.model = self.OPENAI_MODELS["default"]
            elif self.provider == "cohere":
                self.model = self.COHERE_MODELS["default"]

        # Update dimension based on model
        if self.model in self.MODEL_DIMENSIONS:
            self.dimension = self.MODEL_DIMENSIONS[self.model]

    @classmethod
    def from_env(cls) -> "EmbeddingConfig":
        """Create config from environment variables."""
        return cls(
            provider=os.environ.get("LOKI_EMBEDDING_PROVIDER", "local"),
            model=os.environ.get("LOKI_EMBEDDING_MODEL"),
            openai_api_key=os.environ.get("OPENAI_API_KEY"),
            cohere_api_key=os.environ.get("COHERE_API_KEY"),
            chunking_strategy=os.environ.get("LOKI_EMBEDDING_CHUNKING", "semantic"),
            include_context=os.environ.get("LOKI_EMBEDDING_CONTEXT", "true").lower() == "true",
        )

    @classmethod
    def from_file(cls, path: str) -> "EmbeddingConfig":
        """Load config from JSON file."""
        if not os.path.exists(path):
            logger.warning(f"Config file not found: {path}, using defaults")
            return cls()

        with open(path, "r") as f:
            data = json.load(f)

        return cls(
            provider=data.get("provider", "local"),
            model=data.get("model"),
            fallback_providers=data.get("fallback_providers", ["local"]),
            dimension=data.get("dimension", 384),
            chunking_strategy=data.get("chunking_strategy", "semantic"),
            max_chunk_size=data.get("max_chunk_size", 512),
            chunk_overlap=data.get("chunk_overlap", 50),
            include_context=data.get("include_context", True),
            context_lines=data.get("context_lines", 3),
            min_quality_score=data.get("min_quality_score", 0.5),
            dedup_threshold=data.get("dedup_threshold", 0.95),
            batch_size=data.get("batch_size", 32),
            cache_enabled=data.get("cache_enabled", True),
            timeout=data.get("timeout", 30.0),
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary (without sensitive data)."""
        return {
            "provider": self.provider,
            "model": self.model,
            "fallback_providers": self.fallback_providers,
            "dimension": self.dimension,
            "chunking_strategy": self.chunking_strategy,
            "max_chunk_size": self.max_chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "include_context": self.include_context,
            "context_lines": self.context_lines,
            "min_quality_score": self.min_quality_score,
            "dedup_threshold": self.dedup_threshold,
            "batch_size": self.batch_size,
            "cache_enabled": self.cache_enabled,
            "timeout": self.timeout,
            "has_openai_key": self.openai_api_key is not None,
            "has_cohere_key": self.cohere_api_key is not None,
        }


# -----------------------------------------------------------------------------
# Quality Scoring
# -----------------------------------------------------------------------------


@dataclass
class EmbeddingQuality:
    """Quality metrics for an embedding."""
    score: float  # Overall quality score (0-1)
    coverage: float  # How much of the text was embedded (0-1)
    density: float  # Non-zero element ratio (0-1)
    variance: float  # Embedding variance (higher = more diverse)
    provider: str  # Which provider generated it


def compute_quality_score(
    embedding: np.ndarray,
    text: str,
    provider: str,
    max_tokens: int = 512
) -> EmbeddingQuality:
    """
    Compute quality metrics for an embedding.

    Args:
        embedding: The embedding vector.
        text: Original text that was embedded.
        provider: Provider that generated the embedding.
        max_tokens: Maximum expected tokens.

    Returns:
        EmbeddingQuality with computed metrics.
    """
    # Density: ratio of non-zero elements
    non_zero = np.count_nonzero(embedding)
    density = non_zero / len(embedding) if len(embedding) > 0 else 0

    # Variance: measure of embedding diversity
    variance = float(np.var(embedding))

    # Coverage: estimate based on text length vs max tokens
    # Rough estimate: 4 chars per token
    estimated_tokens = len(text) / 4
    coverage = min(1.0, estimated_tokens / max_tokens)

    # Overall score: weighted combination
    # Higher density and variance generally indicate better embeddings
    # TF-IDF fallback tends to have lower density
    score = 0.4 * density + 0.3 * min(variance * 10, 1.0) + 0.3 * coverage

    return EmbeddingQuality(
        score=min(1.0, score),
        coverage=coverage,
        density=density,
        variance=variance,
        provider=provider,
    )


# -----------------------------------------------------------------------------
# Chunking Strategies
# -----------------------------------------------------------------------------


class TextChunker:
    """Handles text chunking for long documents."""

    @staticmethod
    def chunk_fixed(
        text: str,
        max_size: int = 512,
        overlap: int = 50
    ) -> List[str]:
        """
        Split text into fixed-size chunks with overlap.

        Args:
            text: Input text.
            max_size: Maximum characters per chunk.
            overlap: Character overlap between chunks.

        Returns:
            List of text chunks.
        """
        if len(text) <= max_size:
            return [text]

        # Guard against infinite loop when overlap >= max_size
        if overlap >= max_size:
            overlap = 0

        chunks = []
        start = 0
        while start < len(text):
            end = start + max_size
            chunk = text[start:end]
            chunks.append(chunk)
            start = end - overlap

        return chunks

    @staticmethod
    def chunk_sentence(text: str, max_size: int = 512) -> List[str]:
        """
        Split text on sentence boundaries.

        Args:
            text: Input text.
            max_size: Maximum characters per chunk.

        Returns:
            List of text chunks.
        """
        # Simple sentence splitting (handles common cases)
        sentence_endings = re.compile(r'(?<=[.!?])\s+')
        sentences = sentence_endings.split(text)

        chunks = []
        current_chunk = ""

        for sentence in sentences:
            if len(current_chunk) + len(sentence) <= max_size:
                current_chunk += sentence + " "
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = sentence + " "

        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks if chunks else [text]

    @staticmethod
    def chunk_semantic(text: str, max_size: int = 512) -> List[str]:
        """
        Split text on semantic boundaries (paragraphs, code blocks).

        Args:
            text: Input text.
            max_size: Maximum characters per chunk.

        Returns:
            List of text chunks.
        """
        # Split on double newlines (paragraphs) or code block markers
        semantic_breaks = re.compile(r'\n\n+|```[\s\S]*?```')
        parts = semantic_breaks.split(text)

        chunks = []
        current_chunk = ""

        for part in parts:
            part = part.strip()
            if not part:
                continue

            if len(current_chunk) + len(part) <= max_size:
                current_chunk += part + "\n\n"
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                # If single part is too large, use sentence chunking
                if len(part) > max_size:
                    chunks.extend(TextChunker.chunk_sentence(part, max_size))
                    current_chunk = ""
                else:
                    current_chunk = part + "\n\n"

        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks if chunks else [text]

    @staticmethod
    def add_context(
        text: str,
        full_content: str,
        context_lines: int = 3
    ) -> str:
        """
        Add surrounding context to a text chunk.

        Args:
            text: The chunk to add context to.
            full_content: The full document content.
            context_lines: Number of lines of context.

        Returns:
            Text with context added.
        """
        if text not in full_content:
            return text

        # Find position in full content
        pos = full_content.find(text)
        if pos == -1:
            return text

        # Get lines before
        before = full_content[:pos]
        before_lines = before.split('\n')[-context_lines:]
        prefix = '\n'.join(before_lines)

        # Get lines after
        after = full_content[pos + len(text):]
        after_lines = after.split('\n')[:context_lines]
        suffix = '\n'.join(after_lines)

        return f"{prefix}\n{text}\n{suffix}".strip()


# -----------------------------------------------------------------------------
# Provider Implementations
# -----------------------------------------------------------------------------


class BaseEmbeddingProvider(ABC):
    """Base class for embedding providers."""

    @abstractmethod
    def embed(self, text: str) -> np.ndarray:
        """Generate embedding for a single text."""
        pass

    @abstractmethod
    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """Generate embeddings for multiple texts."""
        pass

    @abstractmethod
    def get_dimension(self) -> int:
        """Return the embedding dimension."""
        pass

    @abstractmethod
    def get_name(self) -> str:
        """Return the provider name."""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """Check if provider is available (dependencies, API key, etc.)."""
        pass


class LocalEmbeddingProvider(BaseEmbeddingProvider):
    """
    Local embedding provider using sentence-transformers.

    Falls back to TF-IDF when sentence-transformers is not available.
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2", dimension: int = 384):
        self.model_name = model_name
        self.dimension = dimension
        self._model: Optional[Any] = None
        self._using_fallback = False
        self._sentence_transformers_available = False

        # Check if sentence-transformers is available
        try:
            from sentence_transformers import SentenceTransformer
            self._sentence_transformers_available = True
        except ImportError:
            logger.warning(
                "sentence-transformers not installed. "
                "Using TF-IDF fallback with degraded quality. "
                "Install with: pip install sentence-transformers"
            )
            self._using_fallback = True

    def _load_model(self) -> None:
        """Lazy load the sentence-transformers model."""
        if self._model is not None:
            return

        if not self._sentence_transformers_available:
            return

        logger.info(f"Loading sentence-transformers model: {self.model_name}")
        try:
            from sentence_transformers import SentenceTransformer
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

    def _tfidf_embed(self, text: str) -> np.ndarray:
        """
        Generate TF-IDF based embedding (fallback mode).

        This is a simplified implementation that creates fixed-dimension
        embeddings using hashed TF-IDF features.
        """
        # Simple tokenization
        tokens = text.lower().split()
        tokens = [t.strip('.,!?;:()[]{}"\'-') for t in tokens if t.strip('.,!?;:()[]{}"\'-')]

        if not tokens:
            return np.zeros(self.dimension, dtype=np.float32)

        # Compute term frequencies
        tf: Dict[str, float] = {}
        for token in tokens:
            tf[token] = tf.get(token, 0) + 1

        # Normalize TF
        max_tf = max(tf.values()) if tf else 1
        for token in tf:
            tf[token] = 0.5 + 0.5 * (tf[token] / max_tf)

        # Create embedding using feature hashing
        embedding = np.zeros(self.dimension, dtype=np.float32)
        for token, freq in tf.items():
            # Hash token to get index
            token_hash = int(hashlib.md5(token.encode('utf-8')).hexdigest(), 16)
            idx = token_hash % self.dimension
            # Use another hash for sign
            sign = 1 if (token_hash // self.dimension) % 2 == 0 else -1
            embedding[idx] += sign * freq

        return self._normalize(embedding)

    def _normalize(self, embedding: np.ndarray) -> np.ndarray:
        """L2 normalize an embedding vector."""
        norm = np.linalg.norm(embedding)
        if norm == 0:
            return embedding
        return embedding / norm

    def embed(self, text: str) -> np.ndarray:
        """Generate embedding for a single text."""
        if self._using_fallback:
            return self._tfidf_embed(text)

        self._load_model()
        if self._model is None:
            return self._tfidf_embed(text)

        embedding = self._model.encode(
            text,
            convert_to_numpy=True,
            normalize_embeddings=True
        )

        embedding = np.asarray(embedding, dtype=np.float32)
        if embedding.ndim > 1:
            embedding = embedding.squeeze()

        return embedding

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """Generate embeddings for multiple texts."""
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)

        if self._using_fallback:
            return np.array([self._tfidf_embed(t) for t in texts], dtype=np.float32)

        self._load_model()
        if self._model is None:
            return np.array([self._tfidf_embed(t) for t in texts], dtype=np.float32)

        embeddings = self._model.encode(
            texts,
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=32
        )

        return np.asarray(embeddings, dtype=np.float32)

    def get_dimension(self) -> int:
        return self.dimension

    def get_name(self) -> str:
        return "local"

    def is_available(self) -> bool:
        return True  # Always available (has TF-IDF fallback)


class OpenAIEmbeddingProvider(BaseEmbeddingProvider):
    """OpenAI embedding provider using text-embedding-3 models."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "text-embedding-3-small",
        dimension: int = 1536,
        timeout: float = 30.0
    ):
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self.model = model
        self.dimension = dimension
        self.timeout = timeout
        self._client: Optional[Any] = None
        self._openai_available = False

        # Check if openai is available
        try:
            import openai
            self._openai_available = True
        except ImportError:
            logger.warning("openai package not installed. Install with: pip install openai")

    def _get_client(self) -> Any:
        """Get or create OpenAI client."""
        if self._client is None:
            import openai
            self._client = openai.OpenAI(
                api_key=self.api_key,
                timeout=self.timeout
            )
        return self._client

    def embed(self, text: str) -> np.ndarray:
        """Generate embedding for a single text."""
        if not self.is_available():
            raise RuntimeError("OpenAI provider not available")

        client = self._get_client()
        response = client.embeddings.create(
            input=text,
            model=self.model
        )

        embedding = response.data[0].embedding
        return np.array(embedding, dtype=np.float32)

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """Generate embeddings for multiple texts."""
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)

        if not self.is_available():
            raise RuntimeError("OpenAI provider not available")

        client = self._get_client()

        # OpenAI supports batching up to 2048 inputs
        embeddings = []
        batch_size = 100  # Safe batch size

        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            response = client.embeddings.create(
                input=batch,
                model=self.model
            )
            batch_embeddings = [item.embedding for item in response.data]
            embeddings.extend(batch_embeddings)

        return np.array(embeddings, dtype=np.float32)

    def get_dimension(self) -> int:
        return self.dimension

    def get_name(self) -> str:
        return "openai"

    def is_available(self) -> bool:
        return self._openai_available and self.api_key is not None


class CohereEmbeddingProvider(BaseEmbeddingProvider):
    """Cohere embedding provider using embed-v3 models."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "embed-english-v3.0",
        dimension: int = 1024,
        timeout: float = 30.0
    ):
        self.api_key = api_key or os.environ.get("COHERE_API_KEY")
        self.model = model
        self.dimension = dimension
        self.timeout = timeout
        self._client: Optional[Any] = None
        self._cohere_available = False

        # Check if cohere is available
        try:
            import cohere
            self._cohere_available = True
        except ImportError:
            logger.warning("cohere package not installed. Install with: pip install cohere")

    def _get_client(self) -> Any:
        """Get or create Cohere client."""
        if self._client is None:
            import cohere
            self._client = cohere.Client(
                api_key=self.api_key,
                timeout=self.timeout
            )
        return self._client

    def embed(self, text: str) -> np.ndarray:
        """Generate embedding for a single text."""
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """Generate embeddings for multiple texts."""
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)

        if not self.is_available():
            raise RuntimeError("Cohere provider not available")

        client = self._get_client()

        # Cohere supports batching up to 96 texts
        embeddings = []
        batch_size = 96

        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            response = client.embed(
                texts=batch,
                model=self.model,
                input_type="search_document"
            )
            embeddings.extend(response.embeddings)

        return np.array(embeddings, dtype=np.float32)

    def get_dimension(self) -> int:
        return self.dimension

    def get_name(self) -> str:
        return "cohere"

    def is_available(self) -> bool:
        return self._cohere_available and self.api_key is not None


# -----------------------------------------------------------------------------
# Main Embedding Engine
# -----------------------------------------------------------------------------


class EmbeddingEngine:
    """
    Multi-provider embedding engine with fallback support.

    Uses a primary provider with automatic fallback to alternatives
    if the primary fails or is unavailable.
    """

    DEFAULT_MODEL = "all-MiniLM-L6-v2"
    DEFAULT_DIMENSION = 384

    def __init__(
        self,
        config: Optional[EmbeddingConfig] = None,
        model_name: Optional[str] = None,
        dimension: Optional[int] = None,
    ):
        """
        Initialize the embedding engine.

        Args:
            config: EmbeddingConfig object with full configuration.
            model_name: (Deprecated) Name of the sentence-transformers model.
                        Use config instead.
            dimension: (Deprecated) Embedding dimension. Use config instead.
        """
        # Load config from environment or default
        if config is None:
            config_path = os.path.join(".loki", "config", "embeddings.json")
            if os.path.exists(config_path):
                config = EmbeddingConfig.from_file(config_path)
            else:
                config = EmbeddingConfig.from_env()

        # Support legacy arguments
        if model_name is not None:
            config.model = model_name
        if dimension is not None:
            config.dimension = dimension

        self.config = config
        self.dimension = config.dimension
        self.model_name = config.model or self.DEFAULT_MODEL

        # Initialize providers
        self._providers: Dict[str, BaseEmbeddingProvider] = {}
        self._primary_provider: Optional[BaseEmbeddingProvider] = None
        self._using_fallback = False
        self._current_provider_name = ""

        # Cache
        self._cache: Dict[str, np.ndarray] = {}
        self._max_cache_size = 10000
        self._quality_cache: Dict[str, EmbeddingQuality] = {}

        # Metrics
        self._metrics = {
            "total_requests": 0,
            "cache_hits": 0,
            "provider_calls": {},
            "fallback_count": 0,
            "total_latency_ms": 0,
        }

        # Initialize primary provider
        self._init_providers()

    def _init_providers(self) -> None:
        """Initialize embedding providers based on config."""
        # Always initialize local provider as fallback
        local_provider = LocalEmbeddingProvider(
            model_name=self.config.model if self.config.provider == "local" else "all-MiniLM-L6-v2",
            dimension=self.config.dimension if self.config.provider == "local" else 384,
        )
        self._providers["local"] = local_provider

        # Initialize OpenAI if API key is available
        if self.config.openai_api_key:
            openai_model = self.config.model if self.config.provider == "openai" else "text-embedding-3-small"
            openai_dim = self.config.MODEL_DIMENSIONS.get(openai_model, 1536)
            self._providers["openai"] = OpenAIEmbeddingProvider(
                api_key=self.config.openai_api_key,
                model=openai_model,
                dimension=openai_dim,
                timeout=self.config.timeout,
            )

        # Initialize Cohere if API key is available
        if self.config.cohere_api_key:
            cohere_model = self.config.model if self.config.provider == "cohere" else "embed-english-v3.0"
            cohere_dim = self.config.MODEL_DIMENSIONS.get(cohere_model, 1024)
            self._providers["cohere"] = CohereEmbeddingProvider(
                api_key=self.config.cohere_api_key,
                model=cohere_model,
                dimension=cohere_dim,
                timeout=self.config.timeout,
            )

        # Set primary provider
        if self.config.provider in self._providers:
            provider = self._providers[self.config.provider]
            if provider.is_available():
                self._primary_provider = provider
                self._current_provider_name = self.config.provider
                self.dimension = provider.get_dimension()
                logger.info(f"Using {self.config.provider} embedding provider")
            else:
                logger.warning(f"{self.config.provider} provider not available, using fallback")
                self._use_fallback()
        else:
            logger.warning(f"Unknown provider: {self.config.provider}, using local")
            self._use_fallback()

    def _use_fallback(self) -> None:
        """Switch to fallback provider."""
        for fallback in self.config.fallback_providers:
            if fallback in self._providers:
                provider = self._providers[fallback]
                if provider.is_available():
                    self._primary_provider = provider
                    self._current_provider_name = fallback
                    self._using_fallback = True
                    self.dimension = provider.get_dimension()
                    self._metrics["fallback_count"] += 1
                    logger.info(f"Switched to fallback provider: {fallback}")
                    return

        # Last resort: local provider (always available)
        self._primary_provider = self._providers["local"]
        self._current_provider_name = "local"
        self._using_fallback = True
        self.dimension = self._primary_provider.get_dimension()

    def _get_cache_key(self, text: str, provider: Optional[str] = None) -> str:
        """Generate a cache key for the given text and provider."""
        provider_name = provider or self._current_provider_name
        content = f"{provider_name}:{self.model_name}:{text}"
        return hashlib.md5(content.encode('utf-8')).hexdigest()

    def _normalize(self, embedding: np.ndarray) -> np.ndarray:
        """L2 normalize an embedding vector."""
        if embedding.ndim == 1:
            norm = np.linalg.norm(embedding)
            if norm == 0:
                return embedding
            return embedding / norm
        else:
            norms = np.linalg.norm(embedding, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1, norms)
            return embedding / norms

    def _chunk_text(self, text: str) -> List[str]:
        """Chunk text according to configured strategy."""
        strategy = self.config.chunking_strategy

        if strategy == "none":
            return [text]
        elif strategy == "fixed":
            return TextChunker.chunk_fixed(
                text,
                self.config.max_chunk_size,
                self.config.chunk_overlap
            )
        elif strategy == "sentence":
            return TextChunker.chunk_sentence(text, self.config.max_chunk_size)
        elif strategy == "semantic":
            return TextChunker.chunk_semantic(text, self.config.max_chunk_size)
        else:
            return [text]

    def embed(
        self,
        text: str,
        with_context: bool = False,
        full_content: Optional[str] = None
    ) -> np.ndarray:
        """
        Generate embedding for a single text.

        Uses caching to avoid re-computing embeddings for the same text.

        Args:
            text: Input text to embed.
            with_context: Whether to add surrounding context.
            full_content: Full document content for context extraction.

        Returns:
            Normalized embedding vector of shape (dimension,).
        """
        self._metrics["total_requests"] += 1
        start_time = time.time()

        # Add context if requested
        if with_context and full_content and self.config.include_context:
            text = TextChunker.add_context(
                text, full_content, self.config.context_lines
            )

        # Check cache
        if self.config.cache_enabled:
            cache_key = self._get_cache_key(text)
            if cache_key in self._cache:
                self._metrics["cache_hits"] += 1
                return self._cache[cache_key]

        # Chunk text if needed
        chunks = self._chunk_text(text)

        # Generate embeddings
        try:
            if len(chunks) == 1:
                embedding = self._primary_provider.embed(chunks[0])
            else:
                # Embed chunks and combine (weighted average)
                chunk_embeddings = self._primary_provider.embed_batch(chunks)
                # Weight by chunk length
                weights = np.array([len(c) for c in chunks], dtype=np.float32)
                weights = weights / weights.sum()
                embedding = np.average(chunk_embeddings, axis=0, weights=weights)

            # Normalize
            embedding = self._normalize(embedding)

            # Track metrics
            provider_name = self._current_provider_name
            if provider_name not in self._metrics["provider_calls"]:
                self._metrics["provider_calls"][provider_name] = 0
            self._metrics["provider_calls"][provider_name] += 1

        except Exception as e:
            logger.warning(f"Primary provider failed: {e}, trying fallback")
            self._use_fallback()
            embedding = self._primary_provider.embed(text)
            embedding = self._normalize(embedding)

        # Ensure proper shape and type
        embedding = np.asarray(embedding, dtype=np.float32)
        if embedding.ndim > 1:
            embedding = embedding.squeeze()

        # Cache result
        if self.config.cache_enabled:
            if len(self._cache) >= self._max_cache_size:
                # Remove oldest entry (first key in dict - insertion order in Python 3.7+)
                oldest_key = next(iter(self._cache))
                del self._cache[oldest_key]
            self._cache[cache_key] = embedding

        # Track latency
        latency_ms = (time.time() - start_time) * 1000
        self._metrics["total_latency_ms"] += latency_ms

        return embedding

    def embed_batch(
        self,
        texts: List[str],
        with_context: bool = False,
        full_contents: Optional[List[str]] = None
    ) -> np.ndarray:
        """
        Generate embeddings for multiple texts.

        More efficient than calling embed() individually when using
        sentence-transformers, as it batches the computation.

        Args:
            texts: List of texts to embed.
            with_context: Whether to add surrounding context.
            full_contents: Full document contents for context extraction.

        Returns:
            Normalized embedding matrix of shape (len(texts), dimension).
        """
        if not texts:
            return np.empty((0, self.dimension), dtype=np.float32)

        self._metrics["total_requests"] += len(texts)

        # Add context if requested
        if with_context and full_contents and self.config.include_context:
            texts = [
                TextChunker.add_context(t, fc, self.config.context_lines)
                for t, fc in zip(texts, full_contents)
            ]

        # Check cache for all texts
        cache_keys = [self._get_cache_key(t) for t in texts] if self.config.cache_enabled else []
        cached_results = {
            k: self._cache.get(k) for k in cache_keys
        } if self.config.cache_enabled else {}

        # Find texts that need computing
        texts_to_compute = []
        indices_to_compute = []
        if not self.config.cache_enabled:
            # No cache - all texts need computing
            texts_to_compute = list(texts)
            indices_to_compute = list(range(len(texts)))
        else:
            for i, (text, key) in enumerate(zip(texts, cache_keys)):
                if cached_results.get(key) is None:
                    texts_to_compute.append(text)
                    indices_to_compute.append(i)
                else:
                    self._metrics["cache_hits"] += 1

        # Compute missing embeddings
        new_embeddings = None
        if texts_to_compute:
            try:
                new_embeddings = self._primary_provider.embed_batch(texts_to_compute)
                new_embeddings = self._normalize(new_embeddings)

                # Track metrics
                provider_name = self._current_provider_name
                if provider_name not in self._metrics["provider_calls"]:
                    self._metrics["provider_calls"][provider_name] = 0
                self._metrics["provider_calls"][provider_name] += len(texts_to_compute)

            except Exception as e:
                logger.warning(f"Primary provider failed: {e}, trying fallback")
                self._use_fallback()
                new_embeddings = self._primary_provider.embed_batch(texts_to_compute)
                new_embeddings = self._normalize(new_embeddings)

            # Update cache
            if self.config.cache_enabled:
                for idx, text_idx in enumerate(indices_to_compute):
                    key = cache_keys[text_idx]
                    self._cache[key] = new_embeddings[idx]

        # Assemble results
        results = np.zeros((len(texts), self.dimension), dtype=np.float32)
        computed_idx = 0
        for i in range(len(texts)):
            if self.config.cache_enabled and cache_keys[i] in cached_results and cached_results[cache_keys[i]] is not None:
                results[i] = cached_results[cache_keys[i]]
            elif new_embeddings is not None and computed_idx < len(new_embeddings):
                results[i] = new_embeddings[computed_idx]
                computed_idx += 1

        return results

    def embed_with_quality(
        self,
        text: str,
        with_context: bool = False,
        full_content: Optional[str] = None
    ) -> Tuple[np.ndarray, EmbeddingQuality]:
        """
        Generate embedding with quality metrics.

        Args:
            text: Input text to embed.
            with_context: Whether to add surrounding context.
            full_content: Full document content for context extraction.

        Returns:
            Tuple of (embedding, quality_metrics).
        """
        embedding = self.embed(text, with_context, full_content)
        quality = compute_quality_score(
            embedding, text, self._current_provider_name
        )
        return embedding, quality

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

        # Compute similarities
        similarities = np.dot(corpus_norm, query_norm)

        # Get top-k indices
        k = min(top_k, len(similarities))
        if k <= 0:
            return []

        if k < len(similarities):
            indices = np.argpartition(similarities, -k)[-k:]
            indices = indices[np.argsort(similarities[indices])[::-1]]
        else:
            indices = np.argsort(similarities)[::-1]

        return [(int(idx), float(similarities[idx])) for idx in indices]

    def deduplicate(
        self,
        texts: List[str],
        threshold: Optional[float] = None
    ) -> List[int]:
        """
        Semantic deduplication of texts.

        Returns indices of unique texts (removes near-duplicates).

        Args:
            texts: List of texts to deduplicate.
            threshold: Similarity threshold for deduplication.
                      Defaults to config.dedup_threshold.

        Returns:
            List of indices of unique texts.
        """
        if not texts:
            return []

        threshold = threshold or self.config.dedup_threshold
        embeddings = self.embed_batch(texts)

        unique_indices = [0]  # First text is always unique

        for i in range(1, len(texts)):
            is_unique = True
            for j in unique_indices:
                sim = self.similarity(embeddings[i], embeddings[j])
                if sim >= threshold:
                    is_unique = False
                    break
            if is_unique:
                unique_indices.append(i)

        return unique_indices

    def clear_cache(self) -> None:
        """Clear the embedding cache."""
        self._cache.clear()
        self._quality_cache.clear()
        logger.debug("Embedding cache cleared")

    def get_dimension(self) -> int:
        """Get the embedding dimension."""
        return self.dimension

    def is_using_fallback(self) -> bool:
        """Check if using fallback provider."""
        return self._using_fallback

    def get_cache_size(self) -> int:
        """Get the number of cached embeddings."""
        return len(self._cache)

    def get_provider_name(self) -> str:
        """Get the name of the current provider."""
        return self._current_provider_name

    def get_metrics(self) -> Dict[str, Any]:
        """Get embedding metrics."""
        return {
            **self._metrics,
            "cache_size": len(self._cache),
            "current_provider": self._current_provider_name,
            "using_fallback": self._using_fallback,
            "avg_latency_ms": (
                self._metrics["total_latency_ms"] / self._metrics["total_requests"]
                if self._metrics["total_requests"] > 0 else 0
            ),
        }

    def get_config(self) -> Dict[str, Any]:
        """Get current configuration."""
        return self.config.to_dict()


# -----------------------------------------------------------------------------
# Convenience Functions
# -----------------------------------------------------------------------------


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


def create_config_file(path: str, config: Optional[EmbeddingConfig] = None) -> None:
    """
    Create a configuration file with default or provided settings.

    Args:
        path: Path to save the configuration file.
        config: Optional config to save. Uses defaults if not provided.
    """
    if config is None:
        config = EmbeddingConfig()

    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)

    data = config.to_dict()
    # Remove sensitive keys
    data.pop("has_openai_key", None)
    data.pop("has_cohere_key", None)

    with open(path, "w") as f:
        json.dump(data, f, indent=2)

    logger.info(f"Configuration saved to: {path}")
