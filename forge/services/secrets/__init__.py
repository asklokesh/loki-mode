"""Forge secrets vault.

Local KMS-style file at <forge_dir>/secrets.vault. Encryption: AES-GCM
when the `cryptography` package is installed; otherwise the file is
written 0600 with HMAC integrity and a printed warning. We never raise
on missing crypto so a developer machine without `cryptography` still
sees the rest of forge work.

The master key derives from one of, in order:
    1. LOKI_FORGE_MASTER_KEY env var (base64url, 32+ bytes)
    2. <forge_dir>/.master.key (0600, auto-generated on first use)

Rotation policy lives in `rotation.py` and is invoked by the schedules
runner.
"""

from __future__ import annotations

from .vault import (  # noqa: F401
    SecretError,
    delete_secret,
    get_secret,
    list_secrets,
    set_secret,
)
from .rotation import (  # noqa: F401
    apply_rotation_policy,
    get_rotation_policy,
    set_rotation_policy,
)
