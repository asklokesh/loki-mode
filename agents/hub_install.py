"""
Loki Mode hub-install: install agents and PRD templates from a source.

R10 (agent + template marketplace) install MECHANISM. This module is the
single source of truth for manifest validation and installation. It is
called from the bash CLI (autonomy/loki, cmd_agent / cmd_template) via
heredoc and is directly importable for tests.

HONEST SCOPE
    There is no hosted central marketplace server. A "source" is one of:
      - a local path to a manifest file or a directory containing one
      - a git repository URL (cloned to a temp dir, manifest read, then
        the temp tree is discarded)
      - an http(s) URL to a raw manifest file
    A real hosted hub registry is future work. Everything here is
    install-from-source.

SECURITY MODEL
    Installing a community manifest must NEVER execute arbitrary code.
    This module only ever reads JSON / markdown DATA. It does not eval,
    import, or run anything from the fetched source. For git/url sources
    it copies validated DATA only -- it never runs build hooks, npm
    install, make, or any script that may be present in the tree.

    Validation rejects, before any write:
      - path traversal in the agent type / template name (.. / absolute /
        path separators / null bytes)
      - shadowing of a built-in agent type or built-in template name
      - wrong field types, oversized fields, unexpected executable-looking
        fields (postinstall / scripts / exec / command / hooks are
        ignored, never run, and their presence is reported)
      - manifests that are not the declared kind

STORE LAYOUT (project-local, under .loki/)
    .loki/agents/installed.json      list of installed agent manifests
    .loki/templates/<name>.md        installed template body
    .loki/templates/installed.json   index of installed templates

    Project-local keeps installs scoped to the project and never writes
    into the read-only package agents/ or templates/ dirs (those are
    wiped on npm/Docker upgrade). A user-global ~/.loki store is a
    natural future extension; not implemented here.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

SCHEMA_VERSION = 1

# Manifest field caps (defensive; reject obviously abusive payloads).
_MAX_PERSONA_LEN = 20000
_MAX_NAME_LEN = 80
_MAX_FOCUS_ITEMS = 64
_MAX_FOCUS_ITEM_LEN = 200
_MAX_TEMPLATE_BODY_LEN = 500000
_MAX_MANIFEST_BYTES = 2_000_000

# Fields that would imply code execution. We never run them; presence is
# reported so the operator knows they were ignored.
_EXECUTABLE_FIELDS = (
    "postinstall",
    "preinstall",
    "scripts",
    "exec",
    "command",
    "cmd",
    "hooks",
    "run",
    "shell",
    "eval",
)

# A safe identifier: lowercase letters, digits, hyphen. No path chars.
_SAFE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ManifestError(ValueError):
    """Raised when a manifest is malformed, unsafe, or rejected."""


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _target_dir() -> Path:
    base = os.environ.get("LOKI_TARGET_DIR") or os.getcwd()
    return Path(base)


def _loki_dir() -> Path:
    rel = os.environ.get("LOKI_DIR", ".loki")
    p = Path(rel)
    if not p.is_absolute():
        p = _target_dir() / rel
    return p


def installed_agents_path() -> Path:
    return _loki_dir() / "agents" / "installed.json"


def installed_templates_dir() -> Path:
    return _loki_dir() / "templates"


def installed_templates_index() -> Path:
    return installed_templates_dir() / "installed.json"


def _builtin_types_path() -> Path:
    here = Path(__file__).resolve().parent
    return here / "types.json"


def _builtin_templates_dir() -> Path:
    here = Path(__file__).resolve().parent
    return here.parent / "templates"


# ---------------------------------------------------------------------------
# Built-in inventory (for shadow checks)
# ---------------------------------------------------------------------------


def builtin_agent_types() -> List[str]:
    p = _builtin_types_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out: List[str] = []
    for d in data:
        if isinstance(d, dict) and isinstance(d.get("type"), str):
            out.append(d["type"])
    return out


def builtin_template_names() -> List[str]:
    d = _builtin_templates_dir()
    if not d.is_dir():
        return []
    names: List[str] = []
    for entry in sorted(d.iterdir()):
        if entry.suffix == ".md" and entry.name.lower() != "readme.md":
            names.append(entry.stem)
    return names


# ---------------------------------------------------------------------------
# Safe id check
# ---------------------------------------------------------------------------


def _assert_safe_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{label} must be a non-empty string")
    if "\x00" in value:
        raise ManifestError(f"{label} contains a null byte")
    if "/" in value or "\\" in value or ".." in value or os.path.isabs(value):
        raise ManifestError(f"{label} must not contain path separators or '..': {value!r}")
    if not _SAFE_ID_RE.match(value):
        raise ManifestError(
            f"{label} must match ^[a-z0-9][a-z0-9-]{{0,79}}$ (got {value!r})"
        )
    return value


def _report_executable_fields(manifest: Dict[str, Any]) -> List[str]:
    """Return names of executable-looking fields. They are never run."""
    return [k for k in manifest.keys() if k.lower() in _EXECUTABLE_FIELDS]


# ---------------------------------------------------------------------------
# Manifest validation: agent
# ---------------------------------------------------------------------------


def validate_agent_manifest(manifest: Any) -> Dict[str, Any]:
    """
    Validate a community AGENT manifest. Returns a sanitized dict holding
    only the known data fields. Raises ManifestError on anything unsafe.

    Expected shape (JSON):
      {
        "schema_version": 1,
        "kind": "agent",
        "type": "community-rust-pro",   # safe id, not a built-in
        "name": "Rust Pro",
        "swarm": "engineering",
        "persona": "...",
        "focus": ["rust", "tokio"],     # optional list of strings
        "capabilities": "..."           # optional string
      }
    """
    if not isinstance(manifest, dict):
        raise ManifestError("agent manifest must be a JSON object")

    kind = manifest.get("kind")
    if kind not in (None, "agent"):
        raise ManifestError(f"expected kind 'agent', got {kind!r}")

    sv = manifest.get("schema_version", SCHEMA_VERSION)
    if not isinstance(sv, int) or sv < 1 or sv > SCHEMA_VERSION:
        raise ManifestError(f"unsupported schema_version: {sv!r}")

    agent_type = _assert_safe_id(manifest.get("type"), "agent type")

    if agent_type in builtin_agent_types():
        raise ManifestError(
            f"agent type {agent_type!r} shadows a built-in type; choose another"
        )

    name = manifest.get("name", agent_type)
    if not isinstance(name, str) or not name or len(name) > _MAX_NAME_LEN:
        raise ManifestError("agent name must be a non-empty string <= 80 chars")

    swarm = manifest.get("swarm", "community")
    if not isinstance(swarm, str) or not swarm or len(swarm) > _MAX_NAME_LEN:
        raise ManifestError("agent swarm must be a non-empty string <= 80 chars")

    persona = manifest.get("persona")
    if not isinstance(persona, str) or not persona:
        raise ManifestError("agent persona must be a non-empty string")
    if len(persona) > _MAX_PERSONA_LEN:
        raise ManifestError(f"agent persona exceeds {_MAX_PERSONA_LEN} chars")

    focus = manifest.get("focus", [])
    if focus is None:
        focus = []
    if not isinstance(focus, list):
        raise ManifestError("agent focus must be a list of strings")
    if len(focus) > _MAX_FOCUS_ITEMS:
        raise ManifestError(f"agent focus has too many items (> {_MAX_FOCUS_ITEMS})")
    clean_focus: List[str] = []
    for item in focus:
        if not isinstance(item, str) or len(item) > _MAX_FOCUS_ITEM_LEN:
            raise ManifestError("agent focus items must be strings <= 200 chars")
        clean_focus.append(item)

    capabilities = manifest.get("capabilities", "")
    if capabilities is None:
        capabilities = ""
    if not isinstance(capabilities, str) or len(capabilities) > _MAX_PERSONA_LEN:
        raise ManifestError("agent capabilities must be a string")

    sanitized = {
        "type": agent_type,
        "name": name,
        "swarm": swarm,
        "persona": persona,
        "focus": clean_focus,
        "capabilities": capabilities,
        "source": "hub-installed",
    }
    return sanitized


# ---------------------------------------------------------------------------
# Manifest validation: template
# ---------------------------------------------------------------------------


def validate_template_manifest(manifest: Any) -> Tuple[Dict[str, Any], str]:
    """
    Validate a community TEMPLATE manifest. Returns (metadata, body) where
    metadata holds the index entry and body is the PRD markdown to write.

    Expected shape (JSON):
      {
        "schema_version": 1,
        "kind": "template",
        "name": "rust-cli",            # safe id, not a built-in
        "label": "Rust CLI Tool",
        "description": "...",
        "body": "# PRD ...markdown..."  # the template content
      }

    Alternatively `body_file` may name a sibling markdown file relative to
    the manifest directory (handled by the caller, not here).
    """
    if not isinstance(manifest, dict):
        raise ManifestError("template manifest must be a JSON object")

    kind = manifest.get("kind")
    if kind not in (None, "template"):
        raise ManifestError(f"expected kind 'template', got {kind!r}")

    sv = manifest.get("schema_version", SCHEMA_VERSION)
    if not isinstance(sv, int) or sv < 1 or sv > SCHEMA_VERSION:
        raise ManifestError(f"unsupported schema_version: {sv!r}")

    name = _assert_safe_id(manifest.get("name"), "template name")

    if name in builtin_template_names():
        raise ManifestError(
            f"template name {name!r} shadows a built-in template; choose another"
        )

    label = manifest.get("label", name)
    if not isinstance(label, str) or not label or len(label) > _MAX_NAME_LEN:
        raise ManifestError("template label must be a non-empty string <= 80 chars")

    description = manifest.get("description", "")
    if description is None:
        description = ""
    if not isinstance(description, str) or len(description) > 500:
        raise ManifestError("template description must be a string <= 500 chars")

    body = manifest.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ManifestError("template body must be a non-empty string")
    if len(body) > _MAX_TEMPLATE_BODY_LEN:
        raise ManifestError(f"template body exceeds {_MAX_TEMPLATE_BODY_LEN} chars")

    metadata = {
        "name": name,
        "label": label,
        "description": description,
        "source": "hub-installed",
    }
    return metadata, body


# ---------------------------------------------------------------------------
# Source resolution (local path / git / url) -- DATA ONLY, never execute
# ---------------------------------------------------------------------------


def _read_manifest_file(path: Path) -> Any:
    if path.is_dir():
        candidate = path / "manifest.json"
        if not candidate.exists():
            raise ManifestError(f"no manifest.json in directory {path}")
        path = candidate
    if not path.exists():
        raise ManifestError(f"source not found: {path}")
    size = path.stat().st_size
    if size > _MAX_MANIFEST_BYTES:
        raise ManifestError(f"manifest too large ({size} bytes)")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ManifestError(f"manifest is not valid JSON: {e}")
    except OSError as e:
        raise ManifestError(f"cannot read manifest: {e}")


def _looks_like_git(source: str) -> bool:
    if source.endswith(".git"):
        return True
    if source.startswith(("git@", "git://", "ssh://")):
        return True
    if source.startswith(("http://", "https://")) and "github.com" in source:
        # A github repo URL without an explicit file -> treat as git.
        return not source.rstrip("/").endswith((".json", ".md"))
    return False


def _looks_like_url(source: str) -> bool:
    return source.startswith(("http://", "https://"))


def resolve_source(source: str) -> Tuple[Any, Optional[str]]:
    """
    Fetch the manifest from `source` and return (manifest_obj, base_dir).

    base_dir is the directory the manifest lives in (so a body_file can be
    resolved by the caller); it is a temp dir for git/url sources and is
    the caller's responsibility to ignore for code -- only data is read.

    Never executes anything from the source tree.
    """
    if not isinstance(source, str) or not source:
        raise ManifestError("source must be a non-empty string")

    # Local path takes priority if it exists on disk.
    local = Path(os.path.expanduser(source))
    if local.exists():
        base = local if local.is_dir() else local.parent
        return _read_manifest_file(local), str(base)

    if _looks_like_git(source):
        tmp = tempfile.mkdtemp(prefix="loki-hub-git-")
        try:
            # Shallow clone, no hooks, no submodule recursion. We only read
            # files; we never run anything in the clone.
            env = dict(os.environ)
            env["GIT_TERMINAL_PROMPT"] = "0"
            subprocess.run(
                ["git", "clone", "--depth", "1", "--no-tags", source, tmp],
                check=True,
                capture_output=True,
                timeout=120,
                env=env,
            )
        except FileNotFoundError:
            shutil.rmtree(tmp, ignore_errors=True)
            raise ManifestError("git is not installed; cannot clone source")
        except subprocess.CalledProcessError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            detail = (e.stderr or b"").decode("utf-8", "replace")[:300]
            raise ManifestError(f"git clone failed: {detail}")
        except subprocess.TimeoutExpired:
            shutil.rmtree(tmp, ignore_errors=True)
            raise ManifestError("git clone timed out")
        manifest = _read_manifest_file(Path(tmp))
        return manifest, tmp

    if _looks_like_url(source):
        # Raw file URL. Use urllib so there is no shell involvement.
        import urllib.request

        parsed = urlparse(source)
        if parsed.scheme not in ("http", "https"):
            raise ManifestError(f"unsupported URL scheme: {parsed.scheme!r}")
        try:
            req = urllib.request.Request(source, headers={"User-Agent": "loki-hub"})
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
                raw = resp.read(_MAX_MANIFEST_BYTES + 1)
        except Exception as e:
            raise ManifestError(f"failed to fetch URL: {e}")
        if len(raw) > _MAX_MANIFEST_BYTES:
            raise ManifestError("remote manifest too large")
        try:
            return json.loads(raw.decode("utf-8")), None
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ManifestError(f"remote manifest is not valid JSON: {e}")

    raise ManifestError(f"unrecognized source (not a path, git, or url): {source!r}")


def _resolve_template_body(manifest: Dict[str, Any], base_dir: Optional[str]) -> Dict[str, Any]:
    """If the manifest uses body_file, inline it from base_dir (data read only)."""
    if "body" in manifest:
        return manifest
    body_file = manifest.get("body_file")
    if not isinstance(body_file, str) or not body_file:
        return manifest
    # body_file must stay inside base_dir (no traversal).
    if base_dir is None:
        raise ManifestError("body_file requires a local or git source")
    safe_name = _assert_safe_id(Path(body_file).stem, "body_file name")
    candidate = Path(base_dir) / f"{safe_name}.md"
    if not candidate.exists():
        raise ManifestError(f"body_file not found: {body_file}")
    if candidate.stat().st_size > _MAX_TEMPLATE_BODY_LEN:
        raise ManifestError("body_file too large")
    out = dict(manifest)
    out["body"] = candidate.read_text(encoding="utf-8")
    return out


# ---------------------------------------------------------------------------
# Install: agent
# ---------------------------------------------------------------------------


def _load_installed_agents() -> List[Dict[str, Any]]:
    p = installed_agents_path()
    if not p.exists():
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _save_installed_agents(agents: List[Dict[str, Any]]) -> None:
    p = installed_agents_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(agents, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def install_agent(source: str) -> Dict[str, Any]:
    """Validate and install an agent manifest from source. Returns the entry."""
    manifest, _base = resolve_source(source)
    exec_fields = _report_executable_fields(manifest) if isinstance(manifest, dict) else []
    entry = validate_agent_manifest(manifest)

    installed = _load_installed_agents()
    installed = [a for a in installed if a.get("type") != entry["type"]]
    installed.append(entry)
    _save_installed_agents(installed)

    entry = dict(entry)
    entry["_ignored_executable_fields"] = exec_fields
    return entry


# ---------------------------------------------------------------------------
# Install: template
# ---------------------------------------------------------------------------


def _load_installed_templates() -> List[Dict[str, Any]]:
    p = installed_templates_index()
    if not p.exists():
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _save_installed_templates(items: List[Dict[str, Any]]) -> None:
    p = installed_templates_index()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def install_template(source: str) -> Dict[str, Any]:
    """Validate and install a template manifest from source. Returns metadata."""
    manifest, base = resolve_source(source)
    exec_fields = _report_executable_fields(manifest) if isinstance(manifest, dict) else []
    if isinstance(manifest, dict):
        manifest = _resolve_template_body(manifest, base)
    metadata, body = validate_template_manifest(manifest)

    tdir = installed_templates_dir()
    tdir.mkdir(parents=True, exist_ok=True)
    # name already validated as a safe id, so this path cannot escape tdir.
    body_path = tdir / f"{metadata['name']}.md"
    tmp = body_path.with_suffix(".md.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(tmp, body_path)

    items = _load_installed_templates()
    items = [t for t in items if t.get("name") != metadata["name"]]
    items.append(metadata)
    _save_installed_templates(items)

    metadata = dict(metadata)
    metadata["_ignored_executable_fields"] = exec_fields
    metadata["path"] = str(body_path)
    return metadata


# ---------------------------------------------------------------------------
# Read helpers used by cmd_agent / cmd_init to union built-in + installed
# ---------------------------------------------------------------------------


def merged_agent_types() -> List[Dict[str, Any]]:
    """Built-in agents (from types.json) plus installed agents."""
    builtins: List[Dict[str, Any]] = []
    try:
        with open(_builtin_types_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            builtins = [d for d in data if isinstance(d, dict)]
    except (OSError, json.JSONDecodeError):
        builtins = []
    seen = {b.get("type") for b in builtins}
    for inst in _load_installed_agents():
        if inst.get("type") not in seen:
            builtins.append(inst)
    return builtins


def installed_agent_list() -> List[Dict[str, Any]]:
    return _load_installed_agents()


def installed_template_list() -> List[Dict[str, Any]]:
    return _load_installed_templates()


def installed_template_path(name: str) -> Optional[str]:
    """Resolve an installed template body path by name, or None."""
    try:
        safe = _assert_safe_id(name, "template name")
    except ManifestError:
        return None
    p = installed_templates_dir() / f"{safe}.md"
    return str(p) if p.exists() else None


# ---------------------------------------------------------------------------
# CLI entry (invoked by bash via: python3 hub_install.py <cmd> [args])
# ---------------------------------------------------------------------------


def _main(argv: List[str]) -> int:
    import sys

    if not argv:
        print("usage: hub_install.py <install-agent|install-template|"
              "list-agents|list-templates|merged-agents> [source]", file=sys.stderr)
        return 2
    cmd = argv[0]
    try:
        if cmd == "install-agent":
            entry = install_agent(argv[1])
            print(json.dumps(entry))
            return 0
        if cmd == "install-template":
            meta = install_template(argv[1])
            print(json.dumps(meta))
            return 0
        if cmd == "list-agents":
            print(json.dumps(installed_agent_list()))
            return 0
        if cmd == "list-templates":
            print(json.dumps(installed_template_list()))
            return 0
        if cmd == "merged-agents":
            print(json.dumps(merged_agent_types()))
            return 0
    except ManifestError as e:
        print(f"MANIFEST_ERROR: {e}", file=sys.stderr)
        return 1
    except IndexError:
        print("missing source argument", file=sys.stderr)
        return 2
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    import sys

    raise SystemExit(_main(sys.argv[1:]))
