"""Forge backup + restore.

Dumps the entire .loki/forge/ tree into a single tarball, optionally
gzip-compressed. Excludes the master key file (.master.key) by
default - restores ONTO a fresh project regenerate their own master
key from LOKI_FORGE_MASTER_KEY env so secrets do not silently round-
trip across machines.

restore() is the inverse; it refuses to overwrite an existing forge
state unless force=True (you almost never want that - the safe move
is restore into a sibling dir, then swap manually).
"""

from __future__ import annotations

import io
import os
import tarfile
import time
from typing import Any, Dict, List, Optional


_EXCLUDE_DEFAULT = (".master.key",)


def backup(forge_dir: str, out_path: str, *,
           gzip: bool = True,
           include_master_key: bool = False) -> Dict[str, Any]:
    """Tar the forge_dir into out_path. Returns the manifest."""
    if not os.path.isdir(forge_dir):
        raise ValueError(f"forge_dir not found: {forge_dir}")
    excluded = list(_EXCLUDE_DEFAULT) if not include_master_key else []
    mode = "w:gz" if gzip else "w"
    files: List[str] = []
    with tarfile.open(out_path, mode) as tf:
        for root, _dirs, fnames in os.walk(forge_dir):
            for fn in fnames:
                if fn in excluded:
                    continue
                full = os.path.join(root, fn)
                arc = os.path.relpath(full, forge_dir)
                tf.add(full, arcname=arc)
                files.append(arc)
    return {
        "schema": "loki.forge.backup/v1",
        "out_path": os.path.abspath(out_path),
        "files": files,
        "gzip": gzip,
        "include_master_key": include_master_key,
        "created_at": int(time.time()),
    }


def restore(backup_path: str, forge_dir: str, *,
            force: bool = False) -> Dict[str, Any]:
    """Extract a backup tarball into forge_dir. Refuses to overwrite an
    existing non-empty forge_dir unless force=True."""
    if not os.path.isfile(backup_path):
        raise ValueError(f"backup not found: {backup_path}")
    if os.path.isdir(forge_dir) and os.listdir(forge_dir) and not force:
        raise RuntimeError(
            f"{forge_dir} not empty; pass force=True to overwrite"
        )
    os.makedirs(forge_dir, exist_ok=True)
    restored: List[str] = []
    with tarfile.open(backup_path, "r:*") as tf:
        for member in tf.getmembers():
            # Refuse any member that tries to escape forge_dir.
            target = os.path.normpath(os.path.join(forge_dir, member.name))
            if not target.startswith(os.path.abspath(forge_dir) + os.sep) \
               and target != os.path.abspath(forge_dir):
                raise RuntimeError(
                    f"refusing tar member with absolute/parent path: {member.name}"
                )
            if member.issym() or member.islnk():
                continue  # never restore symlinks/hardlinks
            tf.extract(member, path=forge_dir)
            restored.append(member.name)
    return {
        "schema": "loki.forge.backup.restore/v1",
        "forge_dir": os.path.abspath(forge_dir),
        "restored": restored,
        "restored_at": int(time.time()),
    }
