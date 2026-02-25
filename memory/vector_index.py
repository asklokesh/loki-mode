"""
Loki Mode Vector Index

A simple numpy-based vector index for similarity search.
No FAISS dependency required - uses pure numpy for cosine similarity.

This module provides efficient vector storage and retrieval for the
memory system's embedding-based search capabilities.
"""
from __future__ import annotations

import json
import os
from typing import Callable, Dict, List, Optional, Tuple

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    np = None  # type: ignore
    NUMPY_AVAILABLE = False


class VectorIndex:
    """
    A numpy-based vector index for similarity search.

    Supports adding, searching, updating, and removing vectors with
    associated metadata. Uses cosine similarity for search ranking.

    Attributes:
        dimension: The dimensionality of vectors in this index.
        embeddings: List of stored embedding vectors.
        ids: List of unique identifiers for each vector.
        metadata: List of metadata dictionaries for each vector.
    """

    def __init__(self, dimension: int = 384):
        """
        Initialize a new vector index.

        Args:
            dimension: The dimensionality of vectors. Default is 384
                      which matches MiniLM embedding size.
        """
        self.dimension = dimension
        self.embeddings: List[np.ndarray] = []
        self.ids: List[str] = []
        self.metadata: List[Dict] = []
        self._normalized: bool = False
        self._id_to_index: Dict[str, int] = {}

    def add(
        self,
        id: str,
        embedding: np.ndarray,
        metadata: Optional[Dict] = None
    ) -> None:
        """
        Add a single vector to the index.

        If the ID already exists, updates the existing entry instead.

        Args:
            id: Unique identifier for this vector.
            embedding: The vector to add (must match index dimension).
            metadata: Optional metadata dictionary to associate.

        Raises:
            ValueError: If embedding dimension does not match index dimension.
        """
        # Validate dimension
        if embedding.shape[0] != self.dimension:
            raise ValueError(
                f"Embedding dimension {embedding.shape[0]} does not match "
                f"index dimension {self.dimension}"
            )

        # Handle duplicate IDs by updating
        if id in self._id_to_index:
            self.update(id, embedding=embedding, metadata=metadata)
            return

        # Add new entry
        self.embeddings.append(embedding.astype(np.float32))
        self.ids.append(id)
        self.metadata.append(metadata or {})
        self._id_to_index[id] = len(self.ids) - 1
        self._normalized = False

    def add_batch(
        self,
        ids: List[str],
        embeddings: np.ndarray,
        metadata: Optional[List[Dict]] = None
    ) -> None:
        """
        Add multiple vectors to the index efficiently.

        Args:
            ids: List of unique identifiers.
            embeddings: 2D numpy array of shape (n_vectors, dimension).
            metadata: Optional list of metadata dictionaries.

        Raises:
            ValueError: If embeddings shape does not match expected dimensions.
            ValueError: If length of ids does not match number of embeddings.
        """
        if len(embeddings.shape) != 2:
            raise ValueError("Embeddings must be a 2D array")

        if embeddings.shape[1] != self.dimension:
            raise ValueError(
                f"Embedding dimension {embeddings.shape[1]} does not match "
                f"index dimension {self.dimension}"
            )

        if len(ids) != embeddings.shape[0]:
            raise ValueError(
                f"Number of IDs ({len(ids)}) does not match "
                f"number of embeddings ({embeddings.shape[0]})"
            )

        if metadata is not None and len(metadata) != len(ids):
            raise ValueError(
                f"Number of metadata entries ({len(metadata)}) does not match "
                f"number of IDs ({len(ids)})"
            )

        # Add each vector
        for i, (vec_id, embedding) in enumerate(zip(ids, embeddings)):
            meta = metadata[i] if metadata else None
            self.add(vec_id, embedding, meta)

    def search(
        self,
        query: np.ndarray,
        top_k: int = 5,
        filter_fn: Optional[Callable[[Dict], bool]] = None
    ) -> List[Tuple[str, float, Dict]]:
        """
        Find the top-k most similar vectors to the query.

        Uses cosine similarity for ranking.

        Args:
            query: The query vector to search for.
            top_k: Maximum number of results to return.
            filter_fn: Optional function to filter results by metadata.
                      Should return True for entries to include.

        Returns:
            List of (id, score, metadata) tuples, sorted by descending score.

        Raises:
            ValueError: If query dimension does not match index dimension.
        """
        # Handle empty index
        if len(self.embeddings) == 0:
            return []

        # Validate dimension
        if query.shape[0] != self.dimension:
            raise ValueError(
                f"Query dimension {query.shape[0]} does not match "
                f"index dimension {self.dimension}"
            )

        # Ensure vectors are normalized for cosine similarity
        if not self._normalized:
            self._normalize_vectors()

        # Normalize query
        query_norm = query / (np.linalg.norm(query) + 1e-10)

        # Stack normalized embeddings into matrix for efficient computation
        embeddings_matrix = np.vstack(self._normalized_embeddings)

        # Compute cosine similarities
        similarities = np.dot(embeddings_matrix, query_norm)

        # Build results with optional filtering
        results = []
        for i, score in enumerate(similarities):
            meta = self.metadata[i]

            # Apply filter if provided
            if filter_fn is not None and not filter_fn(meta):
                continue

            results.append((self.ids[i], float(score), meta))

        # Sort by score descending and return top-k
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]

    def remove(self, id: str) -> bool:
        """
        Remove a vector from the index by ID.

        Args:
            id: The ID of the vector to remove.

        Returns:
            True if the vector was found and removed, False otherwise.
        """
        if id not in self._id_to_index:
            return False

        index = self._id_to_index[id]

        # Remove from lists
        del self.embeddings[index]
        del self.ids[index]
        del self.metadata[index]

        # Rebuild index mapping
        self._rebuild_id_index()
        self._normalized = False

        return True

    def update(
        self,
        id: str,
        embedding: Optional[np.ndarray] = None,
        metadata: Optional[Dict] = None
    ) -> bool:
        """
        Update an existing entry in the index.

        Args:
            id: The ID of the vector to update.
            embedding: Optional new embedding vector.
            metadata: Optional new metadata (replaces existing).

        Returns:
            True if the entry was found and updated, False otherwise.

        Raises:
            ValueError: If embedding dimension does not match index dimension.
        """
        if id not in self._id_to_index:
            return False

        index = self._id_to_index[id]

        if embedding is not None:
            if embedding.shape[0] != self.dimension:
                raise ValueError(
                    f"Embedding dimension {embedding.shape[0]} does not match "
                    f"index dimension {self.dimension}"
                )
            self.embeddings[index] = embedding.astype(np.float32)
            self._normalized = False

        if metadata is not None:
            self.metadata[index] = metadata

        return True

    def save(self, path: str) -> None:
        """
        Save the index to disk.

        Creates a .npz file for embeddings and a .json sidecar for metadata.

        Args:
            path: Base path for the save files (without extension).
        """
        # Ensure directory exists
        os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)

        # Save embeddings
        if len(self.embeddings) > 0:
            embeddings_matrix = np.vstack(self.embeddings)
        else:
            embeddings_matrix = np.array([]).reshape(0, self.dimension)

        np.savez(
            f"{path}.npz",
            embeddings=embeddings_matrix,
            dimension=np.array([self.dimension])
        )

        # Save metadata as JSON sidecar
        sidecar_data = {
            "ids": self.ids,
            "metadata": self.metadata,
            "dimension": self.dimension
        }

        with open(f"{path}.json", "w") as f:
            json.dump(sidecar_data, f, indent=2)

    def load(self, path: str) -> None:
        """
        Load the index from disk.

        Args:
            path: Base path for the save files (without extension).

        Raises:
            FileNotFoundError: If the index files do not exist.
        """
        npz_path = f"{path}.npz"
        json_path = f"{path}.json"

        if not os.path.exists(npz_path):
            raise FileNotFoundError(f"Index file not found: {npz_path}")

        if not os.path.exists(json_path):
            raise FileNotFoundError(f"Metadata file not found: {json_path}")

        # Load embeddings
        data = np.load(npz_path)
        embeddings_matrix = data["embeddings"]
        self.dimension = int(data["dimension"][0])

        # Load metadata
        with open(json_path, "r") as f:
            sidecar_data = json.load(f)

        self.ids = sidecar_data["ids"]
        self.metadata = sidecar_data["metadata"]

        # Convert embeddings matrix to list
        if embeddings_matrix.shape[0] > 0:
            self.embeddings = [embeddings_matrix[i] for i in range(embeddings_matrix.shape[0])]
        else:
            self.embeddings = []

        # Rebuild index
        self._rebuild_id_index()
        self._normalized = False

    @classmethod
    def from_file(cls, path: str) -> "VectorIndex":
        """
        Factory method to create and load an index from file.

        Args:
            path: Base path for the save files (without extension).

        Returns:
            A VectorIndex instance loaded from the specified files.
        """
        index = cls()
        index.load(path)
        return index

    def _normalize_vectors(self) -> None:
        """
        Normalize copies of all vectors for cosine similarity search.

        This is called automatically before search operations.
        Uses explicit copies to avoid corrupting the original stored embeddings.
        """
        self._normalized_embeddings = []
        for embedding in self.embeddings:
            vec_copy = embedding.copy()
            norm = np.linalg.norm(vec_copy)
            if norm > 0:
                vec_copy = vec_copy / norm
            self._normalized_embeddings.append(vec_copy)
        self._normalized = True

    def _cosine_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        """
        Compute cosine similarity between two vectors.

        Args:
            a: First vector.
            b: Second vector.

        Returns:
            Cosine similarity score between -1 and 1.
        """
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)

        if norm_a == 0 or norm_b == 0:
            return 0.0

        return float(np.dot(a, b) / (norm_a * norm_b))

    def _rebuild_id_index(self) -> None:
        """Rebuild the ID to index mapping after modifications."""
        self._id_to_index = {id_: i for i, id_ in enumerate(self.ids)}

    def __len__(self) -> int:
        """Return the number of vectors in the index."""
        return len(self.embeddings)

    def __contains__(self, id: str) -> bool:
        """Check if an ID exists in the index."""
        return id in self._id_to_index

    def get_ids(self) -> List[str]:
        """
        Get all IDs in the index.

        Returns:
            List of all vector IDs.
        """
        return list(self.ids)

    def get_metadata(self, id: str) -> Optional[Dict]:
        """
        Get metadata for a specific ID.

        Args:
            id: The ID to look up.

        Returns:
            The metadata dictionary, or None if ID not found.
        """
        if id not in self._id_to_index:
            return None

        return self.metadata[self._id_to_index[id]]

    def clear(self) -> None:
        """Remove all vectors from the index."""
        self.embeddings = []
        self.ids = []
        self.metadata = []
        self._id_to_index = {}
        self._normalized = False

    def get_stats(self) -> Dict:
        """
        Get statistics about the index.

        Returns:
            Dictionary containing:
                - count: Number of vectors
                - dimension: Vector dimensionality
                - memory_bytes: Estimated memory usage in bytes
        """
        count = len(self.embeddings)

        # Estimate memory usage
        # Each float32 is 4 bytes
        embedding_bytes = count * self.dimension * 4

        # Rough estimate for IDs and metadata (varies with content)
        id_bytes = sum(len(id_) for id_ in self.ids)
        metadata_bytes = sum(
            len(json.dumps(m)) for m in self.metadata
        ) if self.metadata else 0

        total_bytes = embedding_bytes + id_bytes + metadata_bytes

        return {
            "count": count,
            "dimension": self.dimension,
            "memory_bytes": total_bytes
        }
