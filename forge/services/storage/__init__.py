"""Forge storage service - buckets, signed URLs, image transforms.

F-2 ships:
    - Local FS-backed buckets under <forge_dir>/storage/<bucket>/
    - sha256 content addressing (free dedupe)
    - HMAC-signed URL minter with expiry + optional range
    - Image-transform recipe stub (the actual sharp/Bun pipeline lands
      with F-2.14 when the functions runtime is online)

Production promotion (F-2 hand-off): swap the FS backend for an
S3-compatible gateway (R2/B2/MinIO) without changing the bucket API.
"""

from __future__ import annotations

from .buckets import (  # noqa: F401
    BucketError,
    create_bucket,
    delete_bucket,
    list_buckets,
    list_objects,
    upload,
    upload_stream,
    download,
)
from .cdn import sign_url, verify_url  # noqa: F401
from .transform import register_transform_preset, list_transform_presets  # noqa: F401
from .gateway import (  # noqa: F401
    SUPPORTED_PROVIDERS as STORAGE_GATEWAY_PROVIDERS,
    configure as configure_gateway,
    get_config as get_gateway_config,
    s3_presigned_url,
)
