#!/usr/bin/env python3
"""Durable supervisor for dashboard-started workspace builds."""

from __future__ import annotations

import argparse
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from autonomy.lib import deadline as process_deadline


SCHEMA_VERSION = 1
_DARWIN_LIBPROC: Any = None
_PROOF_VERIFIER: Any = None

_CHILD_ENV_NAMES = {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DISABLE_AUTOUPDATER",
    "DISABLE_TELEMETRY",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "NO_COLOR",
    "SHELL",
    "TERM",
    "USER",
}
_CHILD_LOKI_ENV_NAMES = {
    "LOKI_ADVISOR_MODEL",
    "LOKI_APP_RUNNER",
    "LOKI_AUTONOMY_OVERRIDE",
    "LOKI_BUILD_PROFILE",
    "LOKI_CLAUDE_EFFORT",
    "LOKI_CLAUDE_MODEL_DEVELOPMENT",
    "LOKI_CLAUDE_MODEL_FAST",
    "LOKI_CLAUDE_MODEL_PLANNING",
    "LOKI_CLAUDE_TASK_BUDGET",
    "LOKI_CODEX_MODEL",
    "LOKI_CODEX_REASONING_EFFORT",
    "LOKI_CODEX_WEB_SEARCH",
    "LOKI_COMPLEXITY",
    "LOKI_COUNCIL_ENABLED",
    "LOKI_COUNCIL_SIZE",
    "LOKI_COUNCIL_TIMEOUT_MS",
    "LOKI_ENTERPRISE_AUTH",
    "LOKI_FIRST_PASS_EXCELLENCE",
    "LOKI_GEMINI_MODEL",
    "LOKI_HOST_GUARD",
    "LOKI_HOST_GUARD_SETTINGS_JSON",
    "LOKI_LEGACY_BASH",
    "LOKI_MAX_ITERATIONS",
    "LOKI_NO_SESSION_PERSIST",
    "LOKI_PARTIAL_MESSAGES",
    "LOKI_PROMPT_INJECTION",
    "LOKI_SDK_LOOP",
    "LOKI_SDK_MODE",
    "LOKI_SESSION_MODEL",
    "LOKI_SETTING_SOURCES",
    "LOKI_SKILL_DIR",
    "LOKI_SPEC_SHA256",
    "LOKI_SPEC_CONTRADICTION_FASTFAIL",
    "LOKI_WORKSPACE_ROOTS",
}
_SYSTEM_RUNTIME_READ_PATHS = (
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/private/etc",
    "/private/var/db/timezone",
    "/private/var/select",
)
_SYSTEM_CHILD_PATHS = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
_PROVIDER_AUTH_COMMANDS = {
    "claude": ("claude", "auth", "status"),
    "codex": ("codex", "login", "status"),
    "cline": ("cline", "auth", "status"),
}
_PROVIDER_READINESS_COMMANDS = {
    "claude": (
        "claude",
        "--dangerously-skip-permissions",
        "--model",
        "haiku",
        "--setting-sources",
        "",
        "--disallowedTools",
        "Task",
        "--tools",
        "Bash",
        "--effort",
        "low",
        "-p",
        "Use the Bash tool to run printf ready. After it succeeds, reply with exactly OK.",
        "--output-format",
        "json",
    ),
}
_PROVIDER_AUTH_ACTIONS = {
    "claude": "Run 'claude login', unlock the macOS login keychain, then retry.",
    "codex": "Run 'codex login', then retry.",
    "cline": "Run 'cline auth', then retry.",
    "aider": "Configure a provider with a non-interactive auth status command.",
}


class _DarwinProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_execution_id(raw: str) -> str:
    """Return the canonical UUID used as the durable execution identity."""
    try:
        return str(uuid.UUID(str(raw)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("request_id must be a valid UUID") from exc


def executions_root() -> Path:
    base = Path(os.environ.get("LOKI_DATA_DIR", "~/.loki")).expanduser()
    return base.resolve() / "dashboard" / "builds"


def execution_dir(execution_id: str) -> Path:
    return executions_root() / validate_execution_id(execution_id)


def state_path(execution_id: str) -> Path:
    return execution_dir(execution_id) / "state.json"


def _ensure_execution_dir(execution_id: str) -> Path:
    path = execution_dir(execution_id)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


@contextmanager
def execution_lock(execution_id: str) -> Iterator[None]:
    """Serialize state transitions and idempotent start decisions."""
    directory = _ensure_execution_dir(execution_id)
    lock_fd = os.open(str(directory / ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def read_state_unlocked(execution_id: str) -> dict[str, Any] | None:
    try:
        value = json.loads(state_path(execution_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def read_state(execution_id: str) -> dict[str, Any] | None:
    """Read one complete state snapshot. Atomic writers prevent torn JSON."""
    return read_state_unlocked(execution_id)


def _fsync_directory(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _atomic_write(path: Path, payload: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def write_state_unlocked(execution_id: str, state: dict[str, Any]) -> None:
    encoded = json.dumps(
        state, sort_keys=True, indent=2, ensure_ascii=True
    ).encode("utf-8") + b"\n"
    _atomic_write(state_path(execution_id), encoded)


def update_state(execution_id: str, **updates: Any) -> dict[str, Any]:
    with execution_lock(execution_id):
        state = read_state_unlocked(execution_id) or {
            "schema_version": SCHEMA_VERSION,
            "execution_id": validate_execution_id(execution_id),
        }
        state.update(updates)
        write_state_unlocked(execution_id, state)
        return state


def write_spec_snapshot_unlocked(execution_id: str, content: bytes) -> Path:
    path = execution_dir(execution_id) / "spec.md"
    _atomic_write(path, content)
    return path


def open_private_log(path: Path) -> Any:
    """Open an append-only execution log with owner-only permissions."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "ab", buffering=0)
    except BaseException:
        os.close(fd)
        raise


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _darwin_process_birth_token(pid: int) -> str:
    """Read Darwin's microsecond process start time through libproc."""
    if sys.platform != "darwin":
        return ""
    global _DARWIN_LIBPROC
    try:
        if _DARWIN_LIBPROC is None:
            libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            libproc.proc_pidinfo.argtypes = [
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_uint64,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            libproc.proc_pidinfo.restype = ctypes.c_int
            _DARWIN_LIBPROC = libproc
        info = _DarwinProcBsdInfo()
        size = ctypes.sizeof(info)
        read = _DARWIN_LIBPROC.proc_pidinfo(
            int(pid), 3, 0, ctypes.byref(info), size
        )
    except (OSError, TypeError, ValueError, AttributeError):
        return ""
    if read != size or info.pbi_pid != int(pid):
        return ""
    return f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}"


def process_birth_token(pid: int) -> str:
    """Return an OS process birth token suitable for PID reuse checks."""
    try:
        numeric_pid = int(pid)
    except (TypeError, ValueError):
        return ""
    if numeric_pid <= 0:
        return ""

    proc_stat = Path(f"/proc/{numeric_pid}/stat")
    try:
        raw = proc_stat.read_text(encoding="utf-8", errors="replace")
        fields = raw.rsplit(")", 1)[1].strip().split()
        start_ticks = fields[19]
        try:
            boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        except OSError:
            boot_id = ""
        return f"proc:{boot_id}:{start_ticks}"
    except (OSError, IndexError):
        pass

    darwin_token = _darwin_process_birth_token(numeric_pid)
    if darwin_token:
        return darwin_token

    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(numeric_pid)],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    started = (result.stdout or "").strip()
    if result.returncode != 0 or not started:
        return ""
    return f"ps:{started}"


def _signal_safe_birth_token(token: Any) -> bool:
    """True only for OS birth tokens precise enough to authorize a signal."""
    if not isinstance(token, str):
        return False
    parts = token.split(":")
    if parts[0] == "proc":
        return len(parts) == 3 and bool(parts[1]) and parts[2].isdigit()
    if parts[0] == "darwin":
        return len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit()
    return False


def process_state(pid: int) -> str:
    """Return the single-letter process state when the OS exposes it."""
    try:
        raw = Path(f"/proc/{int(pid)}/stat").read_text(
            encoding="utf-8", errors="replace"
        )
        return raw.rsplit(")", 1)[1].strip().split()[0]
    except (OSError, ValueError, IndexError):
        pass
    try:
        result = subprocess.run(
            ["ps", "-o", "state=", "-p", str(int(pid))],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""
    return (result.stdout or "").strip()[:1]


def process_identity_matches(pid: Any, birth_token: Any) -> bool:
    """Fail closed unless the live PID has the recorded birth token."""
    if not isinstance(birth_token, str) or not birth_token:
        return False
    try:
        numeric_pid = int(pid)
        os.kill(numeric_pid, 0)
    except (TypeError, ValueError, OSError):
        return False
    if process_state(numeric_pid) == "Z":
        return False
    return process_birth_token(numeric_pid) == birth_token


def _owned_runner_group_matches(
    runner_pid: Any,
    runner_pgid: Any,
    runner_sid: Any,
    runner_birth_token: Any,
) -> bool:
    """Verify the exact session leader before signaling its whole group."""
    try:
        pid = int(runner_pid)
        pgid = int(runner_pgid)
        sid = int(runner_sid)
    except (TypeError, ValueError):
        return False
    if pid <= 1 or pid != pgid or pid != sid:
        return False
    if not _signal_safe_birth_token(runner_birth_token):
        return False
    if not process_identity_matches(pid, runner_birth_token):
        return False
    try:
        return os.getpgid(pid) == pgid and os.getsid(pid) == sid
    except OSError:
        return False


def _signal_owned_runner_group(
    runner_pid: Any,
    runner_pgid: Any,
    runner_sid: Any,
    runner_birth_token: Any,
    signum: int,
) -> str:
    """Signal the runner group or return a fail-closed error string."""
    if not _owned_runner_group_matches(
        runner_pid, runner_pgid, runner_sid, runner_birth_token
    ):
        return "Runner group identity changed or is imprecise; signal refused"
    try:
        os.killpg(int(runner_pgid), signum)
    except ProcessLookupError:
        return ""
    except OSError as exc:
        return f"Runner group signal failed: {type(exc).__name__}"
    return ""


def empty_descendant_outcome() -> dict[str, Any]:
    return {
        "checked": False,
        "detected": False,
        "quiescent": False,
        "term_sent": [],
        "kill_sent": [],
        "remaining_pids": [],
        "error": "",
    }


def _load_tree_digest() -> Any:
    lib_dir = Path(__file__).resolve().parents[1] / "autonomy" / "lib"
    if str(lib_dir) not in sys.path:
        sys.path.insert(0, str(lib_dir))
    from tree_digest import compute_tree_digest

    return compute_tree_digest


def _load_proof_verifier() -> Any:
    """Load the canonical verifier despite its hyphenated filename."""
    global _PROOF_VERIFIER
    if _PROOF_VERIFIER is not None:
        return _PROOF_VERIFIER
    path = (
        Path(__file__).resolve().parents[1]
        / "autonomy"
        / "lib"
        / "proof-verify.py"
    )
    spec = importlib.util.spec_from_file_location("loki_proof_verify", path)
    if spec is None or spec.loader is None:
        raise ImportError("canonical proof verifier could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _PROOF_VERIFIER = module
    return module


def empty_integrity_result(reason: str = "proof integrity not checked") -> dict[str, Any]:
    return {
        "hash_ok": False,
        "gpg_ok": "n/a",
        "generator_trusted": True,
        "headline_consistent": None,
        "degraded": [],
        "reason": reason,
        "ok": False,
    }


def empty_proof_binding(
    execution_id: str, reason: str = "proof not present"
) -> dict[str, Any]:
    return {
        "present": False,
        "run_id": "",
        "headline": "",
        "tree_sha256": "",
        "document_sha256": "",
        "proof_path": "",
        "proof_url": f"/api/control/builds/{execution_id}/proof",
        "snapshotted": False,
        "snapshot_error": "",
        "tree_fields_agree": False,
        "execution": {},
        "failed_quality_gates": [],
        "integrity": empty_integrity_result(reason),
        "bound": False,
    }


def _read_run_id(loki_dir: Path) -> str:
    try:
        value = (loki_dir / "state" / "trust-run-id").read_text(
            encoding="utf-8"
        ).strip()
    except OSError:
        return ""
    if not value.startswith("run-") or "/" in value or "\\" in value:
        return ""
    return value


def _proof_binding(
    execution_id: str, loki_dir: Path, run_id: str, tree_sha256: str
) -> dict[str, Any]:
    """Snapshot and bind the exact final proof outside the tenant workspace."""
    result = empty_proof_binding(execution_id)
    if not run_id:
        return result
    proof_path = loki_dir / "proofs" / run_id / "proof.json"
    try:
        raw = proof_path.read_bytes()
    except OSError:
        return result
    snapshot_path = execution_dir(execution_id) / "proof.json"
    result["document_sha256"] = sha256_bytes(raw)
    try:
        _atomic_write(snapshot_path, raw, mode=0o400)
    except OSError as exc:
        result["snapshot_error"] = f"{type(exc).__name__}: snapshot write failed"
    else:
        result["proof_path"] = str(snapshot_path)
        result["snapshotted"] = True
    try:
        proof = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return result
    if not isinstance(proof, dict):
        return result
    try:
        integrity = _load_proof_verifier().verify_integrity(proof)
    except Exception as exc:
        integrity = empty_integrity_result(
            f"Canonical integrity verifier failed: {type(exc).__name__}"
        )
    if not isinstance(integrity, dict):
        integrity = empty_integrity_result(
            "Canonical integrity verifier returned an invalid result"
        )
    facts = proof.get("facts") if isinstance(proof.get("facts"), dict) else {}
    git = facts.get("git") if isinstance(facts.get("git"), dict) else {}
    honesty = (
        proof.get("honesty") if isinstance(proof.get("honesty"), dict) else {}
    )
    execution = (
        facts.get("execution")
        if isinstance(facts.get("execution"), dict)
        else {}
    )
    quality_gates = (
        facts.get("quality_gates")
        if isinstance(facts.get("quality_gates"), list)
        else []
    )
    failed_quality_gates = [
        str(gate.get("name") or "")
        for gate in quality_gates
        if isinstance(gate, dict) and gate.get("status") == "failed"
    ]
    proof_run_id = str(proof.get("run_id") or "")
    facts_tree = str(git.get("tree_sha256") or "")
    top_tree = str(proof.get("tree_sha256") or "")
    proof_tree = top_tree or facts_tree
    tree_fields_agree = not (top_tree and facts_tree) or top_tree == facts_tree
    headline = str(proof.get("headline") or honesty.get("headline") or "")
    result.update(
        present=True,
        run_id=proof_run_id,
        headline=headline,
        tree_sha256=proof_tree,
        tree_fields_agree=tree_fields_agree,
        execution=execution,
        failed_quality_gates=failed_quality_gates,
        integrity=integrity,
        bound=bool(
            proof_run_id == run_id
            and tree_sha256
            and proof_tree == tree_sha256
            and tree_fields_agree
            and result["snapshotted"]
            and integrity.get("ok") is True
            and integrity.get("headline_consistent") is True
        ),
    )
    return result


def _positive_float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _enabled_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _required_path(name: str, raw: str, *, directory: bool) -> Path:
    value = raw.strip()
    if not value or any(character in value for character in "\n\r\t"):
        raise ValueError(f"{name} contains an invalid path")
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise ValueError(f"{name} paths must be absolute")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f"{name} path does not exist") from exc
    if resolved == Path(resolved.anchor):
        raise ValueError(f"{name} must not include the filesystem root")
    if directory and not resolved.is_dir():
        raise ValueError(f"{name} paths must be directories")
    return resolved


def _required_path_list(name: str, *, directories: bool) -> tuple[Path, ...]:
    raw = os.environ.get(name, "")
    values = raw.split(":")
    if not raw.strip() or any(not value.strip() for value in values):
        raise ValueError(f"{name} must be a non-empty path list")
    paths = tuple(
        _required_path(name, value, directory=directories) for value in values
    )
    # De-duplicate rather than reject. _required_path RESOLVES symlinks, so two
    # genuinely different entries can legitimately collapse to one: on most
    # Linux distributions /bin is a symlink to /usr/bin (and /sbin to /usr/sbin),
    # while on macOS they are distinct directories. A caller listing the
    # conventional four system bin paths is correct on both platforms, and
    # rejecting it on Linux made this a platform-dependent failure that passes
    # on a developer Mac and fails in CI.
    #
    # Order is preserved (dict.fromkeys, not set) because these become sandbox
    # profile entries and a stable order keeps the generated profile
    # byte-reproducible.
    deduped = tuple(dict.fromkeys(paths))
    return deduped


def _reserved_ports() -> tuple[int, ...]:
    raw = os.environ.get("LOKI_HOST_RESERVED_PORTS", "")
    values = raw.split(",")
    if not raw.strip() or any(not value.strip() for value in values):
        raise ValueError("LOKI_HOST_RESERVED_PORTS must be a non-empty port list")
    ports: list[int] = []
    for raw_port in values:
        value = raw_port.strip()
        if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= 65535:
            raise ValueError("LOKI_HOST_RESERVED_PORTS contains an invalid port")
        ports.append(int(value))
    if len(set(ports)) != len(ports):
        raise ValueError("LOKI_HOST_RESERVED_PORTS contains duplicate ports")
    return tuple(ports)


def _host_boundary_config(run_sh: Path) -> dict[str, Any]:
    """Normalize and validate every configured host boundary."""
    run_sh = _required_path("run_sh", str(run_sh), directory=False)
    engine_source = run_sh.parent.parent
    protected_root = _required_path(
        "LOKI_HOST_PROTECTED_ROOT",
        os.environ.get("LOKI_HOST_PROTECTED_ROOT", ""),
        directory=True,
    )
    workspace_roots = _required_path_list(
        "LOKI_WORKSPACE_ROOTS", directories=True
    )
    runtime_read_paths = _required_path_list(
        "LOKI_HOST_RUNTIME_READ_PATHS", directories=False
    )
    runtime_write_paths = _required_path_list(
        "LOKI_HOST_RUNTIME_WRITE_PATHS", directories=True
    )
    child_path = _required_path_list("LOKI_HOST_CHILD_PATH", directories=True)

    required_child_paths = tuple(
        Path(value).resolve(strict=True)
        for value in _SYSTEM_CHILD_PATHS
        if Path(value).is_dir()
    )
    missing_child_paths = tuple(
        path for path in required_child_paths if path not in child_path
    )
    if missing_child_paths:
        missing = ":".join(str(path) for path in missing_child_paths)
        raise ValueError(
            "LOKI_HOST_CHILD_PATH must include the system command paths: "
            f"{missing}"
        )

    for root in workspace_roots:
        if root == protected_root or not _path_is_within(root, protected_root):
            raise ValueError(
                "LOKI_WORKSPACE_ROOTS must be strictly contained under "
                "LOKI_HOST_PROTECTED_ROOT"
            )
    for path in (*runtime_read_paths, *runtime_write_paths):
        if _path_is_within(path, protected_root) or _path_is_within(
            protected_root, path
        ):
            raise ValueError(
                "runtime paths must not overlap LOKI_HOST_PROTECTED_ROOT"
            )

    system_read_paths = tuple(
        Path(value).resolve(strict=True)
        for value in _SYSTEM_RUNTIME_READ_PATHS
        if Path(value).exists()
    )
    executable_roots = (*system_read_paths, *runtime_read_paths)
    for path in child_path:
        if not any(_path_is_within(path, root) for root in executable_roots):
            raise ValueError(
                "LOKI_HOST_CHILD_PATH entries must be under an allowed read path"
            )

    return {
        "workspace_roots": workspace_roots,
        "engine_source": engine_source,
        "protected_root": protected_root,
        "runtime_read_paths": runtime_read_paths,
        "runtime_write_paths": runtime_write_paths,
        "system_read_paths": system_read_paths,
        "child_path": child_path,
        "ports": _reserved_ports(),
    }


def host_confinement_identity(workspace_root: Path, run_sh: Path) -> dict[str, str]:
    """Return the canonical config identity used by the engine manifest."""
    config = _host_boundary_config(run_sh)
    workspace_root = _required_path(
        "workspace_root", str(workspace_root), directory=True
    )
    if workspace_root not in config["workspace_roots"]:
        raise ValueError("workspace_root must exactly match LOKI_WORKSPACE_ROOTS")
    payload = {
        "workspace_roots": [str(path) for path in config["workspace_roots"]],
        "protected_root": str(config["protected_root"]),
        "runtime_read_paths": [str(path) for path in config["runtime_read_paths"]],
        "runtime_write_paths": [str(path) for path in config["runtime_write_paths"]],
        "child_path": [str(path) for path in config["child_path"]],
        "reserved_ports": list(config["ports"]),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return {
        "workspace_root": str(workspace_root),
        "protected_root": payload["protected_root"],
        "runtime_read_paths": ":".join(payload["runtime_read_paths"]),
        "runtime_write_paths": ":".join(payload["runtime_write_paths"]),
        "child_path": ":".join(payload["child_path"]),
        "reserved_ports": ",".join(str(port) for port in config["ports"]),
        "config_sha256": sha256_bytes(encoded),
    }


def _host_confinement_config(
    workspace: Path,
    run_sh: Path,
    spec: Path,
) -> dict[str, Any]:
    config = _host_boundary_config(run_sh)
    workspace = _required_path("workspace", str(workspace), directory=True)
    spec = _required_path("spec", str(spec), directory=False)
    if not any(
        workspace != root and _path_is_within(workspace, root)
        for root in config["workspace_roots"]
    ):
        raise ValueError(
            "LOKI host Seatbelt requires the workspace strictly under "
            "LOKI_WORKSPACE_ROOTS"
        )
    engine_source = config["engine_source"]
    if _path_is_within(workspace, engine_source) or _path_is_within(
        engine_source, workspace
    ):
        raise ValueError("engine source and workspace boundaries must not overlap")
    return {**config, "workspace": workspace, "spec": spec}


def _seatbelt_path_filter(path: Path) -> str:
    kind = "subpath" if path.is_dir() else "literal"
    return f"({kind} {json.dumps(str(path), ensure_ascii=True)})"


def _host_seatbelt_profile(
    workspace: Path,
    run_sh: Path,
    spec: Path,
) -> bytes:
    """Build the macOS local-acceptance sandbox profile for one workspace."""
    config = _host_confinement_config(workspace, run_sh, spec)
    quote = lambda value: json.dumps(str(value), ensure_ascii=True)
    lines = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork process-exec*)",
        "(allow signal (target same-sandbox))",
        "(allow process-info* (target same-sandbox))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow ipc-posix-shm ipc-posix-sem)",
        "(allow network-outbound (remote ip))",
        "(allow network-bind (local ip))",
        "(deny network-outbound (remote unix-socket))",
        '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
        ";; Preexisting cross-boundary hardlinks share one kernel inode.",
        ";; This path policy cannot prove which directory originally created it.",
    ]
    read_paths = {
        *config["system_read_paths"],
        *config["runtime_read_paths"],
        config["engine_source"],
        config["workspace"],
        config["spec"],
    }
    metadata_paths = {Path("/"), Path("/var"), Path("/tmp"), Path("/etc"), Path("/dev")}
    for path in (*read_paths, *config["runtime_write_paths"]):
        metadata_paths.update(path.parents)
    lines.append('(allow file-read-metadata file-read-data (literal "/"))')
    for path in sorted(metadata_paths - {Path("/")}, key=str):
        lines.append(
            f"(allow file-read-metadata (literal {quote(path)}))"
        )
    for path in sorted(read_paths, key=str):
        lines.append(
            f"(allow file-read* file-map-executable {_seatbelt_path_filter(path)})"
        )
    write_paths = {*config["runtime_write_paths"], config["workspace"]}
    for path in sorted(write_paths, key=str):
        lines.append(
            f"(allow file-read* file-write* file-map-executable "
            f"{_seatbelt_path_filter(path)})"
        )
    for device in ("/dev/null", "/dev/random", "/dev/urandom", "/dev/zero"):
        if Path(device).exists():
            lines.append(
                f"(allow file-read* file-write* (literal {quote(device)}))"
            )
    if Path("/dev/fd").exists():
        lines.append('(allow file-read* file-write* (subpath "/dev/fd"))')
    for port in config["ports"]:
        lines.append(
            f'(deny network-outbound (remote tcp "*:{port}"))'
        )
        lines.append(f'(deny network-bind (local tcp "*:{port}"))')
    return ("\n".join(lines) + "\n").encode("utf-8")


def _child_environment(workspace: Path, loki_dir: Path) -> dict[str, str]:
    """Pass only non-secret runtime configuration into the tenant process."""
    child_env = {
        name: os.environ[name]
        for name in (_CHILD_ENV_NAMES | _CHILD_LOKI_ENV_NAMES)
        if name in os.environ
    }
    child_env["PATH"] = os.environ.get(
        "LOKI_HOST_CHILD_PATH", "/usr/bin:/bin:/usr/sbin:/sbin"
    )
    child_env["LOKI_OWN_SESSION"] = "1"
    child_env["LOKI_TARGET_DIR"] = str(workspace)
    child_env["LOKI_DIR"] = str(loki_dir)
    child_env["LOKI_NO_SESSION_PERSIST"] = "1"
    child_env["LOKI_SUPERVISED_BUILD"] = "1"
    # Supervised builds are durable jobs. This activates run.sh's existing
    # terminal exit contract so max-iteration and policy failures return 20
    # instead of looking like successful process exits.
    child_env["LOKI_DURABLE_STATE"] = "1"
    child_env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    child_env["DISABLE_AUTOUPDATER"] = "1"
    child_env["DISABLE_TELEMETRY"] = "1"
    runtime_root = loki_dir / "host-runtime"
    for name in (
        "tmp",
        "cache",
        "config",
        "data",
        "state",
        "npm",
        "bun",
        "claude",
    ):
        (runtime_root / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    child_env["TMPDIR"] = str(runtime_root / "tmp")
    child_env["XDG_CACHE_HOME"] = str(runtime_root / "cache")
    child_env["XDG_CONFIG_HOME"] = str(runtime_root / "config")
    child_env["XDG_DATA_HOME"] = str(runtime_root / "data")
    child_env["XDG_STATE_HOME"] = str(runtime_root / "state")
    child_env["npm_config_cache"] = str(runtime_root / "npm")
    child_env["BUN_INSTALL_CACHE_DIR"] = str(runtime_root / "bun")
    git_config = runtime_root / "gitconfig"
    _atomic_write(git_config, b"[commit]\n\tgpgsign = false\n")
    child_env["GIT_CONFIG_GLOBAL"] = str(git_config)
    child_env["GIT_CONFIG_NOSYSTEM"] = "1"
    return child_env


def _provider_auth_succeeded(
    provider: str,
    result: subprocess.CompletedProcess[str],
) -> tuple[bool, str]:
    """Classify auth status without returning provider output."""
    if provider != "claude":
        available = result.returncode == 0
        return (
            available,
            "available"
            if available
            else "provider_auth_unavailable_in_confinement",
        )
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return False, "provider_auth_status_invalid"
    available = result.returncode == 0 and payload.get("loggedIn") is True
    return (
        available,
        "available" if available else "provider_auth_unavailable_in_confinement",
    )


def _provider_readiness_succeeded(
    provider: str,
    result: subprocess.CompletedProcess[str],
) -> bool:
    """Accept only a real, non-error provider response without returning it."""
    if result.returncode != 0:
        return False
    if provider != "claude":
        return True
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return False
    response = str(payload.get("result", "")).strip().rstrip(".")
    return payload.get("is_error") is False and response == "OK"


def confined_provider_auth_status(
    provider: str,
    workspace: Path,
    run_sh: Path,
    spec: Path,
) -> dict[str, str | bool]:
    """Prove provider auth and live inference at the exact child boundary."""
    action = _PROVIDER_AUTH_ACTIONS.get(
        provider,
        "Authenticate the selected provider, then retry.",
    )
    if not _enabled_env("LOKI_HOST_SEATBELT"):
        return {
            "provider": provider,
            "available": True,
            "classification": "seatbelt_not_enabled",
            "action": action,
        }
    command = _PROVIDER_AUTH_COMMANDS.get(provider)
    if command is None:
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_auth_probe_unsupported",
            "action": action,
        }
    readiness_command = _PROVIDER_READINESS_COMMANDS.get(provider)
    if readiness_command is None:
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_readiness_probe_unsupported",
            "action": action,
        }

    workspace = workspace.resolve(strict=True)
    run_sh = run_sh.resolve(strict=True)
    spec = spec.resolve(strict=True)
    sandbox_exec = Path("/usr/bin/sandbox-exec")
    if sys.platform != "darwin" or not sandbox_exec.is_file():
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_auth_confinement_unavailable",
            "action": action,
        }

    loki_dir = workspace / ".loki"
    child_env = _child_environment(workspace, loki_dir)
    profile = _host_seatbelt_profile(workspace, run_sh, spec)
    profile_path = (
        loki_dir
        / "host-runtime"
        / f"provider-auth-{uuid.uuid4().hex}.sb"
    )
    _atomic_write(profile_path, profile)
    try:
        auth_result = subprocess.run(
            [str(sandbox_exec), "-f", str(profile_path), *command],
            cwd=str(workspace),
            env=child_env,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_auth_probe_timeout",
            "action": action,
        }
    except OSError:
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_cli_unavailable",
            "action": action,
        }
    finally:
        profile_path.unlink(missing_ok=True)

    available, classification = _provider_auth_succeeded(provider, auth_result)
    if not available:
        return {
            "provider": provider,
            "available": False,
            "classification": classification,
            "action": action,
        }

    profile_path = (
        loki_dir
        / "host-runtime"
        / f"provider-ready-{uuid.uuid4().hex}.sb"
    )
    _atomic_write(profile_path, profile)
    try:
        readiness_result = subprocess.run(
            [str(sandbox_exec), "-f", str(profile_path), *readiness_command],
            cwd=str(workspace),
            env=child_env,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_readiness_probe_timeout",
            "action": action,
        }
    except OSError:
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_cli_unavailable",
            "action": action,
        }
    finally:
        profile_path.unlink(missing_ok=True)

    if not _provider_readiness_succeeded(provider, readiness_result):
        return {
            "provider": provider,
            "available": False,
            "classification": "provider_live_inference_unavailable",
            "action": action,
        }
    return {
        "provider": provider,
        "available": True,
        "classification": "available",
        "action": action,
        "live_inference_passed": True,
    }


def smoke_probe_confined_provider_auth(
    workspace_root: Path,
    run_sh: Path,
    provider: str,
) -> dict[str, str | bool]:
    """Probe auth and live inference before advertising engine readiness."""
    workspace_root = _required_path(
        "workspace_root", str(workspace_root), directory=True
    )
    with tempfile.TemporaryDirectory(
        prefix=".provider-auth-probe-", dir=workspace_root
    ) as workspace_raw:
        workspace = Path(workspace_raw).resolve()
        spec = workspace / "spec.md"
        spec.write_text("provider auth capability probe", encoding="utf-8")
        return confined_provider_auth_status(provider, workspace, run_sh, spec)


def smoke_probe_host_seatbelt(workspace_root: Path, run_sh: Path) -> dict[str, str]:
    """Prove the configured kernel profile before advertising confinement."""
    if sys.platform != "darwin":
        raise RuntimeError("LOKI host Seatbelt is available only on macOS")
    sandbox_exec = Path("/usr/bin/sandbox-exec")
    if not sandbox_exec.is_file() or not os.access(sandbox_exec, os.X_OK):
        raise RuntimeError("LOKI host Seatbelt requires /usr/bin/sandbox-exec")

    workspace_root = _required_path(
        "workspace_root", str(workspace_root), directory=True
    )
    with tempfile.TemporaryDirectory(
        prefix=".seatbelt-probe-workspace-", dir=workspace_root
    ) as workspace_raw, tempfile.TemporaryDirectory(
        prefix=".seatbelt-probe-sibling-", dir=workspace_root
    ) as sibling_raw:
        workspace = Path(workspace_raw).resolve()
        sibling = Path(sibling_raw).resolve()
        spec = workspace / "spec.md"
        spec.write_text("seatbelt probe", encoding="utf-8")
        secret = sibling / "secret.txt"
        secret.write_text("must remain unreadable", encoding="utf-8")
        unix_socket_path = workspace / "probe.sock"

        config = _host_confinement_config(workspace, run_sh, spec)
        probe_port = 0
        for port in config["ports"]:
            with socket.socket() as candidate:
                try:
                    candidate.bind(("127.0.0.1", port))
                except OSError:
                    continue
                probe_port = port
                break
        if not probe_port:
            raise RuntimeError("no reserved port was free for the Seatbelt probe")

        profile = _host_seatbelt_profile(workspace, run_sh, spec)
        profile_path = workspace / "probe.sb"
        profile_path.write_bytes(profile)
        output_path = workspace / "probe.txt"
        probe_code = """
import errno
import os
import signal
import socket
import subprocess
import sys

output, sibling, unix_path, port = sys.argv[1:]
open(output, "w", encoding="utf-8").write("confined")
open("/etc/hosts", encoding="utf-8").read(1)
child = subprocess.Popen(
    ["/bin/sh", "-c", "/bin/sleep 5 & wait"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    preexec_fn=os.setpgrp,
)
os.killpg(child.pid, signal.SIGKILL)
child.wait(timeout=2)
try:
    open(sibling, encoding="utf-8").read(1)
except OSError:
    pass
else:
    raise SystemExit(41)
with socket.socket(socket.AF_UNIX) as client:
    try:
        client.connect(unix_path)
    except OSError:
        pass
    else:
        raise SystemExit(42)
with socket.socket() as listener:
    try:
        listener.bind(("127.0.0.1", int(port)))
    except OSError as exc:
        if exc.errno not in (errno.EACCES, errno.EPERM):
            raise
    else:
        raise SystemExit(43)
"""
        with socket.socket(socket.AF_UNIX) as unix_server:
            unix_server.bind(str(unix_socket_path))
            unix_server.listen(1)
            try:
                result = subprocess.run(
                    [
                        str(sandbox_exec),
                        "-f",
                        str(profile_path),
                        "/usr/bin/python3",
                        "-c",
                        probe_code,
                        str(output_path),
                        str(secret),
                        str(unix_socket_path),
                        str(probe_port),
                    ],
                    cwd=str(workspace),
                    env={
                        "HOME": os.environ.get("HOME", "/var/empty"),
                        "LANG": os.environ.get("LANG", "C"),
                        "PATH": os.environ.get(
                            "LOKI_HOST_CHILD_PATH", "/usr/bin:/bin:/usr/sbin:/sbin"
                        ),
                        "TMPDIR": str(workspace),
                    },
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            except subprocess.SubprocessError as exc:
                raise RuntimeError("Seatbelt kernel smoke probe did not finish") from exc
        if result.returncode != 0 or output_path.read_text(encoding="utf-8") != "confined":
            raise RuntimeError(
                f"Seatbelt kernel smoke probe failed with exit {result.returncode}"
            )
        return {
            **host_confinement_identity(workspace_root, run_sh),
            "probe_sha256": sha256_bytes(profile),
        }


def _host_confined_args(
    execution_id: str,
    args: list[str],
    workspace: Path,
    run_sh: Path,
    spec: Path,
) -> tuple[list[str], dict[str, Any] | None]:
    """Wrap a controlled local build in macOS Seatbelt when explicitly armed."""
    if not _enabled_env("LOKI_HOST_SEATBELT"):
        return args, None
    if sys.platform != "darwin":
        raise RuntimeError("LOKI host Seatbelt is available only on macOS")
    sandbox_exec = Path("/usr/bin/sandbox-exec")
    if not sandbox_exec.is_file() or not os.access(sandbox_exec, os.X_OK):
        raise RuntimeError("LOKI host Seatbelt requires /usr/bin/sandbox-exec")

    probe_sha256 = os.environ.get("LOKI_HOST_SEATBELT_PROBE_SHA256", "").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", probe_sha256):
        raise RuntimeError("LOKI host Seatbelt kernel probe is missing or invalid")
    profile = _host_seatbelt_profile(workspace, run_sh, spec)
    profile_path = execution_dir(execution_id) / "host-seatbelt.sb"
    _atomic_write(profile_path, profile)
    confinement = {
        "kind": "macos-seatbelt",
        "profile_sha256": sha256_bytes(profile),
        "kernel_probe_sha256": probe_sha256,
        "known_limitations": [
            "preexisting-cross-boundary-hardlinks",
            "unrestricted-outbound-network",
            "provider-credential-store-visible-to-confined-build",
            "deprecated-macos-sandbox-exec",
        ],
    }
    return [str(sandbox_exec), "-f", str(profile_path), *args], confinement


def run_supervisor(
    execution_id: str,
    run_sh: Path,
    workspace: Path,
    loki_dir: Path,
    spec: Path,
    provider: str,
    parallel: bool = False,
) -> int:
    """Run one foreground engine child and persist its exact terminal result."""
    execution_id = validate_execution_id(execution_id)
    run_sh = run_sh.resolve(strict=True)
    workspace = workspace.resolve(strict=True)
    loki_dir = loki_dir.resolve(strict=True)
    spec = spec.resolve(strict=True)
    supervisor_pid = os.getpid()
    update_state(
        execution_id,
        supervisor_pid=supervisor_pid,
        supervisor_birth_token=process_birth_token(supervisor_pid),
    )

    args = [str(run_sh), "--provider", provider]
    if parallel:
        args.append("--parallel")
    args.append(str(spec))

    child_env = _child_environment(workspace, loki_dir)
    # A reused brownfield workspace may already contain an older run identity.
    # Only a value minted after this execution starts may bind its receipt.
    baseline_run_id = _read_run_id(loki_dir)

    runner_log = execution_dir(execution_id) / "runner.log"
    try:
        args, confinement = _host_confined_args(
            execution_id,
            args,
            workspace,
            run_sh,
            spec,
        )
        if confinement is not None:
            update_state(execution_id, confinement=confinement)
        log_handle = open_private_log(runner_log)
        process, lineage_tracker = process_deadline.spawn_tracked(
            args,
            cwd=str(workspace),
            env=child_env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
        )
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        try:
            log_handle.close()
        except (NameError, OSError):
            pass
        finished_at = utc_now()
        update_state(
            execution_id,
            state="exited",
            exited_at=finished_at,
            finished_at=finished_at,
            returncode=None,
            exit_code=None,
            signal=None,
            termination_reason="launch_failed",
            launch_error=str(exc),
            proof=empty_proof_binding(execution_id, "runner launch failed"),
        )
        return 127

    runner_pid = process.pid
    # start_new_session=True makes the child both session and process-group
    # leader before exec. These IDs remain authoritative after the leader exits.
    runner_pgid = runner_pid
    runner_sid = runner_pid
    runner_birth_token = process_birth_token(runner_pid)
    update_state(
        execution_id,
        state="running",
        started_at=utc_now(),
        runner_pid=runner_pid,
        runner_pgid=runner_pgid,
        runner_sid=runner_sid,
        runner_birth_token=runner_birth_token,
        runner_log=str(runner_log),
    )

    received_signal = 0

    def _request_stop(signum: int, _frame: Any) -> None:
        nonlocal received_signal
        received_signal = signum

    previous_handlers: dict[int, Any] = {}
    for signum in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[signum] = signal.signal(signum, _request_stop)

    stop_sent_at: float | None = None
    stop_refused = False
    kill_sent = False
    stop_grace = _positive_float_env("LOKI_BUILD_STOP_GRACE_SECONDS", 10.0)
    poll_interval = _positive_float_env("LOKI_BUILD_SUPERVISOR_POLL_SECONDS", 0.2)
    cached_run_id = ""
    lineage_error = ""
    try:
        while process.poll() is None:
            if not lineage_error:
                try:
                    lineage_tracker.refresh()
                except (OSError, PermissionError, RuntimeError) as exc:
                    lineage_error = (
                        "Runner lineage tracking failed: " + type(exc).__name__
                    )
                    update_state(execution_id, stop_error=lineage_error)
            state = read_state(execution_id) or {}
            if not cached_run_id:
                candidate_run_id = _read_run_id(loki_dir)
                if candidate_run_id and candidate_run_id != baseline_run_id:
                    cached_run_id = candidate_run_id
                    update_state(execution_id, run_id=cached_run_id)
            stop_requested = bool(
                state.get("stop_requested_at") or received_signal or lineage_error
            )
            if stop_requested and stop_sent_at is None and not stop_refused:
                signal_error = _signal_owned_runner_group(
                    runner_pid,
                    runner_pgid,
                    runner_sid,
                    runner_birth_token,
                    signal.SIGTERM,
                )
                if signal_error:
                    update_state(
                        execution_id,
                        stop_error=signal_error,
                    )
                    stop_refused = True
                else:
                    stop_sent_at = time.monotonic()
                    update_state(execution_id, stop_signal_sent_at=utc_now())
            elif (
                stop_sent_at is not None
                and time.monotonic() - stop_sent_at >= stop_grace
                and not kill_sent
            ):
                signal_error = _signal_owned_runner_group(
                    runner_pid,
                    runner_pgid,
                    runner_sid,
                    runner_birth_token,
                    signal.SIGKILL,
                )
                if signal_error:
                    update_state(
                        execution_id,
                        stop_error=signal_error,
                    )
                kill_sent = True
            time.sleep(poll_interval)
        returncode = process.wait()
    finally:
        log_handle.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)

    descendant_grace = _positive_float_env(
        "LOKI_BUILD_DESCENDANT_GRACE_SECONDS", 2.0
    )
    if lineage_error:
        descendants = empty_descendant_outcome()
        descendants["error"] = lineage_error
    else:
        try:
            descendants = process_deadline.reconcile_lineage(
                process, lineage_tracker, descendant_grace
            )
        except (OSError, PermissionError, RuntimeError) as exc:
            descendants = empty_descendant_outcome()
            descendants["error"] = (
                "Runner lineage reconciliation failed: " + type(exc).__name__
            )
    lineage_tracker.close()
    abnormal_descendants = bool(descendants.get("detected") or descendants.get("error"))
    if abnormal_descendants:
        run_id = ""
        tree_sha256 = ""
        proof = empty_proof_binding(
            execution_id,
            "proof not captured because runner descendants survived direct exit",
        )
    else:
        final_candidate_run_id = _read_run_id(loki_dir)
        run_id = cached_run_id or (
            final_candidate_run_id
            if final_candidate_run_id and final_candidate_run_id != baseline_run_id
            else ""
        )
        # Snapshot the exact proof first, then derive the returned source tree.
        proof = _proof_binding(execution_id, loki_dir, run_id, "")
        tree_sha256 = _load_tree_digest()(workspace)
        integrity = (
            proof.get("integrity")
            if isinstance(proof.get("integrity"), dict)
            else {}
        )
        proof["bound"] = bool(
            proof.get("present")
            and proof.get("snapshotted")
            and proof.get("run_id") == run_id
            and tree_sha256
            and proof.get("tree_sha256") == tree_sha256
            and proof.get("tree_fields_agree")
            and integrity.get("ok") is True
            and integrity.get("headline_consistent") is True
        )
    stopped = bool(stop_sent_at is not None)
    if descendants.get("detected"):
        reason = (
            "descendants_terminated"
            if descendants.get("quiescent")
            else "descendants_uncontained"
        )
    elif descendants.get("error"):
        reason = "descendant_check_failed"
    elif stopped:
        reason = "stopped"
    elif (
        returncode == 0
        and proof.get("bound") is True
        and proof.get("headline") == "VERIFIED"
        and (proof.get("execution") or {}).get("exit_code") == 0
        and (proof.get("execution") or {}).get("run_status") in {
            "deterministic_gates_passed",
            "council_approved",
            "council_force_approved",
            "completion_promise_fulfilled",
            "reuse_already_satisfied",
        }
        and not proof.get("failed_quality_gates")
    ):
        reason = "completed"
    elif returncode in (0, 20):
        reason = "verification_failed"
    else:
        reason = "crashed"
    exit_code = returncode if returncode >= 0 else None
    exit_signal = -returncode if returncode < 0 else None
    finished_at = utc_now()
    update_state(
        execution_id,
        state="exited",
        exited_at=finished_at,
        finished_at=finished_at,
        returncode=returncode,
        exit_code=exit_code,
        signal=exit_signal,
        termination_reason=reason,
        run_id=run_id,
        final_tree_sha256=tree_sha256,
        descendants=descendants,
        proof=proof,
    )
    return returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execution-id", required=True)
    parser.add_argument("--run-sh", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--loki-dir", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--parallel", action="store_true")
    args = parser.parse_args(argv)
    result = run_supervisor(
        execution_id=args.execution_id,
        run_sh=Path(args.run_sh),
        workspace=Path(args.workspace),
        loki_dir=Path(args.loki_dir),
        spec=Path(args.spec),
        provider=args.provider,
        parallel=args.parallel,
    )
    if result < 0:
        return 128 + (-result)
    return min(result, 255)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "SCHEMA_VERSION",
    "confined_provider_auth_status",
    "empty_descendant_outcome",
    "empty_integrity_result",
    "empty_proof_binding",
    "execution_dir",
    "execution_lock",
    "executions_root",
    "host_confinement_identity",
    "open_private_log",
    "process_birth_token",
    "process_identity_matches",
    "process_state",
    "read_state",
    "read_state_unlocked",
    "run_supervisor",
    "sha256_bytes",
    "smoke_probe_confined_provider_auth",
    "smoke_probe_host_seatbelt",
    "state_path",
    "update_state",
    "utc_now",
    "validate_execution_id",
    "write_spec_snapshot_unlocked",
    "write_state_unlocked",
]
