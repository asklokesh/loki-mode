"""
Optional cloud LokiStore backends: S3, GCS, Azure Blob.

Each backend's SDK is imported ONLY inside its __init__, so:
- The SDK is never imported at module import time.
- Local-only users never touch these classes and never pay an import cost.
- Selecting a cloud backend without its SDK installed raises a clear,
  actionable BackendNotAvailableError naming the missing package.

Backends are intentionally thin. They do not add retry/credential frameworks;
they rely on each SDK's default credential chain (env vars, instance metadata,
etc.). Keys are normalized identically to LocalStore (traversal rejected) and
an optional store-level prefix is prepended to every object key.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional, Union

from .base import (
    BackendNotAvailableError,
    LokiStore,
    normalize_key,
    read_source_bytes,
)


def _join_prefix(prefix: str, key: str) -> str:
    """Join a normalized store prefix and a normalized key into an object key."""
    key = normalize_key(key)
    if not prefix:
        return key
    return f"{prefix.rstrip('/')}/{key}"


def _normalize_prefix(prefix: Optional[str]) -> str:
    """Normalize an optional store prefix to a clean POSIX-style path (or '')."""
    if not prefix:
        return ""
    # Reuse the key guard so a prefix cannot smuggle traversal either.
    return normalize_key(prefix)


def _dir_prefix(obj_prefix: str) -> str:
    """
    Coerce a non-empty object-key prefix to its directory form (slash
    terminated) so cloud list() matches at slash boundaries like LocalStore's
    directory walk, per the LokiStore.list contract. An empty prefix (list
    everything) is returned unchanged.
    """
    if obj_prefix and not obj_prefix.endswith("/"):
        return obj_prefix + "/"
    return obj_prefix


class S3Store(LokiStore):
    """Amazon S3 (or S3-compatible) backend (requires boto3)."""

    def __init__(
        self,
        bucket: str,
        prefix: Optional[str] = None,
        region: Optional[str] = None,
        endpoint: Optional[str] = None,
    ):
        if not bucket:
            raise ValueError("S3Store requires a bucket name")
        try:
            import boto3  # noqa: F401  (imported here so missing dep is lazy)
        except ImportError as exc:
            raise BackendNotAvailableError(
                "The s3 storage backend requires the 'boto3' package. "
                "Install it with: pip install boto3"
            ) from exc

        self._bucket = bucket
        self._prefix = _normalize_prefix(prefix)
        # boto3 picks up credentials from its default chain (env, shared
        # config, instance/role metadata). region_name is optional.
        # endpoint_url targets an S3-COMPATIBLE store (MinIO, Ceph, R2,
        # Wasabi, ...) instead of real AWS S3; without it the docstring's
        # "(or S3-compatible)" claim was false. Read from the arg or the
        # AWS_ENDPOINT_URL env (boto3's own convention) as a fallback.
        kwargs = {}
        endpoint = endpoint or os.environ.get("AWS_ENDPOINT_URL")
        if endpoint:
            kwargs["endpoint_url"] = endpoint
        if region:
            kwargs["region_name"] = region
        elif endpoint:
            # A custom S3-compatible endpoint (MinIO/Ceph/...) still needs a
            # region for SigV4 request signing even though the store ignores it.
            # Default to us-east-1 (the conventional MinIO default) so a MinIO
            # config without an explicit region does not fail signing.
            kwargs["region_name"] = "us-east-1"
        self._client = boto3.client("s3", **kwargs)

    def _object_key(self, key: str) -> str:
        return _join_prefix(self._prefix, key)

    def put(self, key: str, data: Union[bytes, bytearray, str, os.PathLike]) -> None:
        payload = read_source_bytes(data)
        self._client.put_object(
            Bucket=self._bucket, Key=self._object_key(key), Body=payload
        )

    def get(self, key: str) -> bytes:
        try:
            resp = self._client.get_object(
                Bucket=self._bucket, Key=self._object_key(key)
            )
        except self._client.exceptions.NoSuchKey as exc:
            raise FileNotFoundError(f"no such key: {key!r}") from exc
        return resp["Body"].read()

    def get_to(self, key: str, dest_path: Union[str, os.PathLike]) -> None:
        dest = Path(dest_path).expanduser()
        dest.parent.mkdir(parents=True, exist_ok=True)
        self._client.download_file(self._bucket, self._object_key(key), str(dest))

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket, Key=self._object_key(key))
            return True
        except Exception:
            # head_object raises ClientError (404) when absent; treat any
            # lookup failure as "not present" for the boolean contract.
            return False

    def list(self, prefix: str = "") -> List[str]:
        # A caller prefix is matched at slash boundaries (directory form); the
        # store-level prefix, when listing everything, is left as-is.
        obj_prefix = _dir_prefix(self._object_key(prefix)) if prefix else self._prefix
        paginator = self._client.get_paginator("list_objects_v2")
        strip = (self._prefix + "/") if self._prefix else ""
        keys: List[str] = []
        for page in paginator.paginate(Bucket=self._bucket, Prefix=obj_prefix):
            for item in page.get("Contents", []):
                full = item["Key"]
                rel = full[len(strip):] if strip and full.startswith(strip) else full
                keys.append(rel)
        keys.sort()
        return keys

    def delete(self, key: str) -> bool:
        # S3 delete is idempotent and does not signal whether an object
        # existed. Probe first so the boolean contract is honest.
        existed = self.exists(key)
        self._client.delete_object(Bucket=self._bucket, Key=self._object_key(key))
        return existed


class GCSStore(LokiStore):
    """Google Cloud Storage backend (requires google-cloud-storage)."""

    def __init__(
        self,
        bucket: str,
        prefix: Optional[str] = None,
        region: Optional[str] = None,  # accepted for signature parity, unused
    ):
        if not bucket:
            raise ValueError("GCSStore requires a bucket name")
        try:
            from google.cloud import storage  # type: ignore
        except ImportError as exc:
            raise BackendNotAvailableError(
                "The gcs storage backend requires the 'google-cloud-storage' "
                "package. Install it with: pip install google-cloud-storage"
            ) from exc

        self._prefix = _normalize_prefix(prefix)
        # The client uses Application Default Credentials (env, gcloud, or
        # workload identity).
        self._client = storage.Client()
        self._bucket = self._client.bucket(bucket)

    def _object_key(self, key: str) -> str:
        return _join_prefix(self._prefix, key)

    def put(self, key: str, data: Union[bytes, bytearray, str, os.PathLike]) -> None:
        payload = read_source_bytes(data)
        blob = self._bucket.blob(self._object_key(key))
        blob.upload_from_string(payload)

    def get(self, key: str) -> bytes:
        blob = self._bucket.blob(self._object_key(key))
        if not blob.exists():
            raise FileNotFoundError(f"no such key: {key!r}")
        return blob.download_as_bytes()

    def get_to(self, key: str, dest_path: Union[str, os.PathLike]) -> None:
        dest = Path(dest_path).expanduser()
        dest.parent.mkdir(parents=True, exist_ok=True)
        blob = self._bucket.blob(self._object_key(key))
        if not blob.exists():
            raise FileNotFoundError(f"no such key: {key!r}")
        blob.download_to_filename(str(dest))

    def exists(self, key: str) -> bool:
        return self._bucket.blob(self._object_key(key)).exists()

    def list(self, prefix: str = "") -> List[str]:
        obj_prefix = _dir_prefix(self._object_key(prefix)) if prefix else self._prefix
        strip = (self._prefix + "/") if self._prefix else ""
        keys: List[str] = []
        for blob in self._client.list_blobs(self._bucket, prefix=obj_prefix):
            full = blob.name
            rel = full[len(strip):] if strip and full.startswith(strip) else full
            keys.append(rel)
        keys.sort()
        return keys

    def delete(self, key: str) -> bool:
        blob = self._bucket.blob(self._object_key(key))
        if not blob.exists():
            return False
        blob.delete()
        return True


class AzureBlobStore(LokiStore):
    """Azure Blob Storage backend (requires azure-storage-blob)."""

    def __init__(
        self,
        bucket: str,
        prefix: Optional[str] = None,
        region: Optional[str] = None,  # accepted for signature parity, unused
    ):
        # In Azure terms `bucket` is the container name.
        if not bucket:
            raise ValueError("AzureBlobStore requires a container name (bucket)")
        try:
            from azure.storage.blob import ContainerClient  # type: ignore
        except ImportError as exc:
            raise BackendNotAvailableError(
                "The azure-blob storage backend requires the "
                "'azure-storage-blob' package. "
                "Install it with: pip install azure-storage-blob"
            ) from exc

        self._prefix = _normalize_prefix(prefix)

        # Credentials come from the SDK's default chain. We accept either a
        # full connection string (AZURE_STORAGE_CONNECTION_STRING) or an
        # account URL (AZURE_STORAGE_ACCOUNT_URL) + DefaultAzureCredential.
        conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
        account_url = os.environ.get("AZURE_STORAGE_ACCOUNT_URL")
        if conn:
            self._container = ContainerClient.from_connection_string(
                conn, container_name=bucket
            )
        elif account_url:
            try:
                from azure.identity import DefaultAzureCredential  # type: ignore
            except ImportError as exc:
                raise BackendNotAvailableError(
                    "Azure account-URL auth requires the 'azure-identity' "
                    "package. Install it with: pip install azure-identity"
                ) from exc
            self._container = ContainerClient(
                account_url=account_url,
                container_name=bucket,
                credential=DefaultAzureCredential(),
            )
        else:
            raise BackendNotAvailableError(
                "The azure-blob backend needs AZURE_STORAGE_CONNECTION_STRING "
                "or AZURE_STORAGE_ACCOUNT_URL to be set."
            )

    def _object_key(self, key: str) -> str:
        return _join_prefix(self._prefix, key)

    def put(self, key: str, data: Union[bytes, bytearray, str, os.PathLike]) -> None:
        payload = read_source_bytes(data)
        self._container.upload_blob(
            name=self._object_key(key), data=payload, overwrite=True
        )

    def get(self, key: str) -> bytes:
        from azure.core.exceptions import ResourceNotFoundError  # type: ignore

        try:
            downloader = self._container.download_blob(self._object_key(key))
        except ResourceNotFoundError as exc:
            raise FileNotFoundError(f"no such key: {key!r}") from exc
        return downloader.readall()

    def get_to(self, key: str, dest_path: Union[str, os.PathLike]) -> None:
        payload = self.get(key)
        dest = Path(dest_path).expanduser()
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            f.write(payload)

    def exists(self, key: str) -> bool:
        return self._container.get_blob_client(self._object_key(key)).exists()

    def list(self, prefix: str = "") -> List[str]:
        obj_prefix = _dir_prefix(self._object_key(prefix)) if prefix else self._prefix
        strip = (self._prefix + "/") if self._prefix else ""
        keys: List[str] = []
        for blob in self._container.list_blobs(name_starts_with=obj_prefix or None):
            full = blob.name
            rel = full[len(strip):] if strip and full.startswith(strip) else full
            keys.append(rel)
        keys.sort()
        return keys

    def delete(self, key: str) -> bool:
        from azure.core.exceptions import ResourceNotFoundError  # type: ignore

        try:
            self._container.delete_blob(self._object_key(key))
            return True
        except ResourceNotFoundError:
            return False
