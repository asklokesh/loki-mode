"""
LokiStore interface and shared helpers.

Defines the abstract blob-store contract that every backend implements, plus
errors and a key-normalization helper shared across backends.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import List, Union


class StoreError(Exception):
    """Base class for LokiStore errors."""


class BackendNotAvailableError(StoreError):
    """
    Raised when a cloud backend is explicitly selected but its SDK (or
    required configuration) is not available. The message names the missing
    package and how to install it so the failure is actionable.
    """


def normalize_key(key: str) -> str:
    """
    Normalize a store key to a clean POSIX-style relative path.

    Keys are relative paths like "state/checkpoints/cp-1/metadata.json".
    This rejects absolute paths and any key that would traverse outside the
    store root (a leading or embedded ".." segment). The same guard is used
    by every backend so traversal is rejected uniformly, whether the bytes
    land on a local filesystem or in an object-store key namespace.

    Args:
        key: A POSIX-style relative path.

    Returns:
        The normalized key (forward slashes, no leading slash, no "."/".."
        segments collapsed away).

    Raises:
        ValueError: If the key is empty, absolute, or escapes the root.
    """
    if not isinstance(key, str) or not key:
        raise ValueError("store key must be a non-empty string")

    # Treat backslashes as separators too, so a Windows-style key cannot
    # smuggle a traversal past the split() check below.
    candidate = key.replace("\\", "/")

    if candidate.startswith("/"):
        raise ValueError(f"absolute keys are not allowed: {key!r}")

    parts: List[str] = []
    for segment in candidate.split("/"):
        if segment == "" or segment == ".":
            # Collapse empty (e.g. "a//b") and current-dir segments.
            continue
        if segment == "..":
            raise ValueError(f"path traversal is not allowed in key: {key!r}")
        parts.append(segment)

    if not parts:
        raise ValueError(f"key resolves to an empty path: {key!r}")

    return "/".join(parts)


def read_source_bytes(data: Union[bytes, bytearray, str, os.PathLike]) -> bytes:
    """
    Coerce a put() source argument into bytes.

    Accepts raw bytes (returned as-is) or a path-like pointing at a file whose
    contents are read in binary. A plain str is treated as a FILESYSTEM PATH,
    not as text, to match the put(key, bytes_or_path) contract; callers that
    want to store a string must encode it themselves.

    Args:
        data: bytes/bytearray, or a path-like to an existing file.

    Returns:
        The bytes to store.

    Raises:
        FileNotFoundError: If a path is given and the file does not exist.
        TypeError: If the argument is neither bytes nor a path-like.
    """
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    if isinstance(data, (str, os.PathLike)):
        with open(data, "rb") as f:
            return f.read()
    raise TypeError(
        "put() source must be bytes or a path-like to a file, "
        f"got {type(data).__name__}"
    )


class LokiStore(ABC):
    """
    Abstract pluggable blob store.

    All keys are POSIX-style relative paths (see normalize_key). Implementations
    must apply normalize_key to every incoming key so traversal is rejected and
    behavior is uniform across backends.

    The contract is intentionally small (no streaming, no multipart, no
    credential framework) so backends stay thin. Larger payload handling can be
    layered on later without changing this interface.
    """

    @abstractmethod
    def put(self, key: str, data: Union[bytes, bytearray, str, os.PathLike]) -> None:
        """
        Store bytes under key. The source is either raw bytes or a path-like
        to a file whose contents are stored. Overwrites any existing value
        atomically where the backend supports it.
        """

    @abstractmethod
    def get(self, key: str) -> bytes:
        """
        Return the bytes stored under key.

        Raises:
            FileNotFoundError: If the key does not exist.
        """

    @abstractmethod
    def get_to(self, key: str, dest_path: Union[str, os.PathLike]) -> None:
        """
        Write the bytes stored under key to dest_path (a local filesystem
        path). Parent directories are created as needed.

        Raises:
            FileNotFoundError: If the key does not exist.
        """

    @abstractmethod
    def exists(self, key: str) -> bool:
        """Return True if key exists in the store."""

    @abstractmethod
    def list(self, prefix: str = "") -> List[str]:
        """
        List keys under prefix (a POSIX-style relative PATH prefix). An empty
        prefix lists every key. Returns normalized keys, sorted, relative to
        the store root.

        Prefix semantics (portable contract):
        - prefix is a PATH prefix matched at slash boundaries, NOT a raw
          substring. A slash-terminated prefix like "state/" selects every key
          beneath the "state" directory and is the portable form that behaves
          IDENTICALLY across all backends (local and cloud).
        - An empty prefix lists everything.

        A non-slash-terminated prefix (e.g. "state") is normalized to its
        directory form before matching, so it selects keys under "state/" and
        does NOT match siblings that merely share the leading characters (e.g.
        "stateful/x.json"). Callers wanting portable results should pass a
        slash-terminated prefix.
        """

    @abstractmethod
    def delete(self, key: str) -> bool:
        """
        Delete key. Returns True if a value was removed, False if the key did
        not exist (delete is idempotent and never raises on a missing key).
        """
