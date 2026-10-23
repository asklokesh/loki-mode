#!/usr/bin/env python3
"""One OS confinement module: macOS Seatbelt and Linux bubblewrap.

Owns the Seatbelt profile builder and kernel smoke probe (moved out of
dashboard/build_supervisor.py) plus a provider-agnostic argv wrapper.
Secret paths come from autonomy/lib/secret-paths.json, the same list
src/policies/claude_permissions.js compiles into Claude read-deny rules.

CLI:
  python3 -m autonomy.lib.os_sandbox argv --workspace W --run-dir R --provider P
prints {kind, argv_prefix, profile_sha256, kernel_probe_sha256, known_limitations}.
LOKI_OS_SANDBOX=off|auto|on (default off). Under on, an unavailable sandbox or a
failed kernel probe exits 2. auto falls back to kind none with a reason.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
SECRET_PATHS_FILE = Path(__file__).resolve().parent / "secret-paths.json"
PROBE_TIMEOUT_SECONDS = 15
# Scratch space every provider CLI needs. A workspace inside one of these roots
# cannot prove "write outside the workspace is denied" by sibling probe.
TMP_ROOTS = {
    "darwin": (Path("/private/tmp"), Path("/private/var/folders")),
    "linux": (Path("/tmp"),),
}
WALK_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "__pycache__"})
WALK_MAX_ENTRIES = 200000

# Provider CLI state the confined process must be able to write. Each entry was
# checked against a machine with the CLI installed (~/.claude, ~/.claude.json,
# ~/.codex, ~/.config/opencode, ~/.local/share/opencode, ~/.cache/opencode,
# ~/.cline, ~/.aider*). A trailing * is a prefix glob inside HOME.
PROVIDER_WRITE_PATHS: dict[str, tuple[str, ...]] = {
    "claude": ("~/.claude", "~/.claude.json"),
    "codex": ("~/.codex",),
    "opencode": (
        "~/.config/opencode",
        "~/.local/share/opencode",
        "~/.cache/opencode",
    ),
    "cline": ("~/.cline",),
    "aider": ("~/.aider*",),
}

INSTALL_HINT = {
    "darwin": "sandbox-exec ships with macOS at /usr/bin/sandbox-exec",
    "linux": "install bubblewrap (apt install bubblewrap, dnf install bubblewrap)",
}


class SandboxUnavailable(RuntimeError):
    """Confinement was requested but cannot be provided."""


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


# ---------------------------------------------------------------- secret list

def load_secret_rules(path: Path = SECRET_PATHS_FILE) -> list[dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rules = data["rules"]
    for rule in rules:
        if rule["kind"] == "file" and rule.get("glob"):
            continue
        if rule["kind"] == "dir" and rule.get("name"):
            continue
        raise ValueError(f"invalid secret-paths rule: {rule!r}")
    return rules


def _glob_to_regex(glob: str) -> str:
    return "".join("[^/]*" if ch == "*" else re.escape(ch) for ch in glob)


def secret_path_regexes(rules: Iterable[dict[str, str]]) -> list[str]:
    """Regexes (POSIX ERE subset) matching a secret path anywhere on disk."""
    out = []
    for rule in rules:
        if rule["kind"] == "file":
            out.append(f"(^|/){_glob_to_regex(rule['glob'])}$")
        else:
            out.append(f"(^|/){_glob_to_regex(rule['name'])}(/|$)")
    return out


def _seatbelt_regex(regex: str) -> str:
    # Seatbelt regex literal #"..." passes backslashes through to the regex
    # engine; a double quote cannot occur in the rule alphabet.
    return '(regex #"' + regex.replace('"', '\\"') + '")'


# ------------------------------------------------------------------- Seatbelt

def seatbelt_path_filter(path: Path) -> str:
    kind = "subpath" if path.is_dir() else "literal"
    return f"({kind} {json.dumps(str(path), ensure_ascii=True)})"


def seatbelt_profile(
    config: dict[str, Any],
    secret_regexes: Iterable[str] = (),
) -> bytes:
    """Build the macOS local-acceptance sandbox profile for one workspace.

    config keys: system_read_paths, runtime_read_paths, runtime_write_paths,
    engine_source, workspace, spec, ports. secret_regexes appends kernel read
    denies; the default (none) keeps the dashboard profile bytes unchanged.
    """
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
            f"(allow file-read* file-map-executable {seatbelt_path_filter(path)})"
        )
    write_paths = {*config["runtime_write_paths"], config["workspace"]}
    for path in sorted(write_paths, key=str):
        lines.append(
            f"(allow file-read* file-write* file-map-executable "
            f"{seatbelt_path_filter(path)})"
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
        # network-bind uses "tcp4", not "tcp": confirmed on macOS 27.0 (26A428)
        # that sandbox-exec's (local tcp "*:PORT") filter on network-bind never
        # matches an actual bind (a bind to 127.0.0.1 or 0.0.0.0 on the denied
        # port succeeds), while (local tcp4 "*:PORT") correctly denies it with
        # a clean PermissionError. network-outbound's "tcp" filter above is
        # unaffected (verified separately: an outbound connect to a denied
        # port is still refused), so only this line changes.
        #
        # Known residual gap, same platform bug family, found while fixing
        # the above (not introduced by it -- reproduced identically against
        # the un-patched "tcp" rule too): on this same macOS 27.0 build, EVERY
        # port-qualified network-bind filter for IPv6 ("tcp6 \"*:PORT\"" and
        # "ip6 \"*:PORT\"") also fails to match, so an IPv6 bind to the
        # reserved port (e.g. "::1"/"::") still succeeds even with a "tcp6"
        # deny added. Only a port-unqualified "(deny network-bind (local
        # ip6))" was confirmed to actually block IPv6 binds, which would deny
        # ALL IPv6 binding (not just the reserved ports) -- a materially wider
        # behavior change than this port-scoping fix, and nothing in this
        # codebase binds IPv6 today (grepped: no AF_INET6/IPv6 usage). Left
        # unfixed here to keep this change scoped to the failing test; the
        # reserved ports remain enforced for IPv4 (the only family in active
        # use), and a confined build could still self-expose a reserved port
        # over IPv6 loopback/wildcard. Tracked as a follow-up, not silently
        # closed.
        lines.append(f'(deny network-bind (local tcp4 "*:{port}"))')
    for regex in secret_regexes:
        # Deny write as well: a rename or hardlink of a secret would otherwise
        # move it to a name the read-deny regex does not match.
        lines.append(f"(deny file-read-data {_seatbelt_regex(regex)})")
        lines.append(f"(deny file-write* {_seatbelt_regex(regex)})")
    return ("\n".join(lines) + "\n").encode("utf-8")


def provider_write_paths(provider: str, home: Path | None = None) -> list[Path]:
    """Existing provider config and credential paths the CLI must write."""
    home = home or Path(os.path.expanduser("~"))
    found: list[Path] = []
    for entry in PROVIDER_WRITE_PATHS.get(provider, ()):
        rel = entry[2:] if entry.startswith("~/") else entry
        if rel.endswith("*"):
            found.extend(sorted(home.glob(rel)))
        elif (home / rel).exists():
            found.append(home / rel)
    return [p.resolve() for p in found]


def seatbelt_provider_profile(
    workspace: Path,
    run_dir: Path,
    provider: str,
    secret_regexes: Iterable[str],
    home: Path | None = None,
) -> bytes:
    """Provider-CLI profile: reads open, writes confined, secrets denied."""
    quote = lambda value: json.dumps(str(value), ensure_ascii=True)
    writable = [workspace, run_dir, *provider_write_paths(provider, home)]
    lines = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork process-exec*)",
        "(allow signal (target same-sandbox))",
        "(allow process-info* (target same-sandbox))",
        "(allow sysctl-read sysctl-write)",
        "(allow mach-lookup)",
        "(allow ipc-posix-shm ipc-posix-sem)",
        "(allow network*)",
        "(allow user-preference-read)",
        "(allow file-read*)",
        "(allow file-map-executable)",
    ]
    for path in sorted({*writable}, key=str):
        lines.append(f"(allow file-write* {seatbelt_path_filter(path)})")
    for tmp in TMP_ROOTS["darwin"]:
        if tmp.exists():
            lines.append(f"(allow file-write* (subpath {quote(tmp)}))")
    lines.append(
        '(allow file-write* (literal "/dev/null") (literal "/dev/tty") '
        '(regex #"^/dev/ttys[0-9]+$"))'
    )
    for regex in secret_regexes:
        # Deny write as well: a rename or hardlink of a secret would otherwise
        # move it to a name the read-deny regex does not match.
        lines.append(f"(deny file-read-data {_seatbelt_regex(regex)})")
        lines.append(f"(deny file-write* {_seatbelt_regex(regex)})")
    return ("\n".join(lines) + "\n").encode("utf-8")


def seatbelt_smoke_probe(
    workspace_root: Path,
    profile_for: Any,
    ports: Iterable[int],
    child_path: str,
) -> str:
    """Prove the kernel profile before advertising confinement.

    profile_for(workspace, spec) returns the profile bytes for a scratch
    workspace created under workspace_root. Returns the profile sha256.
    """
    if sys.platform != "darwin":
        raise RuntimeError("LOKI host Seatbelt is available only on macOS")
    if not SANDBOX_EXEC.is_file() or not os.access(SANDBOX_EXEC, os.X_OK):
        raise RuntimeError("LOKI host Seatbelt requires /usr/bin/sandbox-exec")

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

        probe_port = 0
        for port in ports:
            with socket.socket() as candidate:
                try:
                    candidate.bind(("127.0.0.1", port))
                except OSError:
                    continue
                probe_port = port
                break
        if not probe_port:
            raise RuntimeError("no reserved port was free for the Seatbelt probe")

        profile = profile_for(workspace, spec)
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
                        str(SANDBOX_EXEC),
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
                        "PATH": child_path,
                        "TMPDIR": str(workspace),
                    },
                    capture_output=True,
                    text=True,
                    timeout=PROBE_TIMEOUT_SECONDS,
                )
            except subprocess.SubprocessError as exc:
                raise RuntimeError("Seatbelt kernel smoke probe did not finish") from exc
        if result.returncode != 0 or output_path.read_text(encoding="utf-8") != "confined":
            raise RuntimeError(
                f"Seatbelt kernel smoke probe failed with exit {result.returncode}"
            )
        return sha256_bytes(profile)


# --------------------------------------------------------------------- bwrap

def _find_secret_files(roots: Iterable[Path], rules: list[dict[str, str]]) -> list[Path]:
    """Existing secret files and dirs under roots, bounded, skipping vendored trees."""
    regexes = [re.compile(r) for r in secret_path_regexes(rules)]
    hits: list[Path] = []
    seen = 0
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in WALK_SKIP_DIRS]
            for name in [*dirnames, *filenames]:
                seen += 1
                full = os.path.join(dirpath, name)
                if any(r.search(full) for r in regexes):
                    hits.append(Path(full))
                    if name in dirnames:
                        dirnames.remove(name)
            if seen > WALK_MAX_ENTRIES:
                break
    return hits


def bwrap_argv_prefix(
    workspace: Path,
    run_dir: Path,
    provider: str,
    rules: list[dict[str, str]],
    home: Path | None = None,
    bwrap: str = "bwrap",
) -> list[str]:
    home = home or Path(os.path.expanduser("~"))
    argv = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--tmpfs", "/tmp"]
    writable = [workspace, run_dir, *provider_write_paths(provider, home)]
    seen: set[str] = set()
    for path in writable:
        if str(path) not in seen:
            seen.add(str(path))
            argv += ["--bind", str(path), str(path)]
    masked: set[str] = set()
    candidates = [
        *(home / r["name"] for r in rules if r["kind"] == "dir"),
        *_find_secret_files([workspace, run_dir], rules),
    ]
    for path in candidates:
        if str(path) in masked or not path.exists():
            continue
        masked.add(str(path))
        if path.is_dir():
            argv += ["--tmpfs", str(path)]
        else:
            argv += ["--ro-bind", "/dev/null", str(path)]
    argv += ["--die-with-parent", "--"]
    return argv


# ------------------------------------------------------------- kernel probes

_PROBE_SCRIPT = (
    'cat "$1/.env" >/dev/null 2>&1 && exit 41; '
    'cat "$1/plain.txt" >/dev/null 2>&1 || exit 42; '
    ': > "$1/w.txt" 2>/dev/null || exit 43; '
    '[ -z "$2" ] || { : > "$2" 2>/dev/null && exit 44; }; '
    'exit 0'
)


def _outside_probe_dir(workspace: Path, platform: str) -> Path | None:
    """A writable-by-user dir outside the workspace that the sandbox must refuse."""
    roots = TMP_ROOTS.get(platform, ())
    for candidate in (workspace.parent, Path(os.path.expanduser("~"))):
        if candidate.is_dir() and os.access(candidate, os.W_OK) and not any(
            candidate == r or r in candidate.parents for r in roots
        ):
            return candidate
    return None


def kernel_probe(argv_builder: Any, workspace: Path, run_dir: Path,
                 platform: str | None = None) -> tuple[bool, str]:
    """Run the four probes (secret read denied, normal read, write in, write out)."""
    probe_dir = Path(tempfile.mkdtemp(prefix=".os-sandbox-probe-", dir=run_dir))
    outside_parent = _outside_probe_dir(workspace, platform or sys.platform)
    outside = (
        Path(tempfile.mkdtemp(prefix=".os-sandbox-probe-out-", dir=outside_parent)) / "escape.txt"
        if outside_parent else None
    )
    try:
        (probe_dir / ".env").write_text("SECRET=1\n", encoding="utf-8")
        (probe_dir / "plain.txt").write_text("ok\n", encoding="utf-8")
        prefix = argv_builder()
        result = subprocess.run(
            [*prefix, "/bin/sh", "-c", _PROBE_SCRIPT, "probe", str(probe_dir), str(outside or "")],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS,
        )
        detail = {
            0: "ok",
            41: "secret .env was readable",
            42: "a normal file was not readable",
            43: "a write inside the run dir failed",
            44: "a write outside the workspace succeeded",
        }.get(result.returncode, f"probe exited {result.returncode}: {result.stderr.strip()[:200]}")
        return result.returncode == 0, detail
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"probe did not run: {exc}"
    finally:
        shutil.rmtree(probe_dir, ignore_errors=True)
        if outside:
            shutil.rmtree(outside.parent, ignore_errors=True)


# ----------------------------------------------------------------- front door

def resolve_mode(raw: str | None = None) -> str:
    mode = (raw if raw is not None else os.environ.get("LOKI_OS_SANDBOX", "off")).strip().lower()
    if mode not in {"off", "auto", "on"}:
        raise ValueError(f"LOKI_OS_SANDBOX must be off, auto or on (got {mode!r})")
    return mode


def build_confinement(
    workspace: Path,
    run_dir: Path,
    provider: str,
    mode: str | None = None,
    home: Path | None = None,
    platform: str | None = None,
) -> dict[str, Any]:
    """Return the typed confinement status for wrapping a provider CLI argv.

    Raises SandboxUnavailable only under mode on (fail closed).
    """
    mode = resolve_mode(mode)
    platform = platform or sys.platform
    none = lambda reason: {
        "kind": "none", "reason": reason, "argv_prefix": [],
        "profile_sha256": None, "kernel_probe_sha256": None,
        "known_limitations": ["unconfined"],
    }
    if mode == "off":
        return none("LOKI_OS_SANDBOX=off")
    workspace = workspace.resolve(strict=True)
    run_dir = run_dir.resolve(strict=True)
    rules = load_secret_rules()
    regexes = secret_path_regexes(rules)
    limitations = ["unrestricted-outbound-network",
                   "reads-outside-workspace-allowed-except-secret-paths"]

    def unavailable(reason: str) -> dict[str, Any]:
        if mode == "on":
            raise SandboxUnavailable(reason)
        return none(reason)

    if platform == "darwin":
        if not SANDBOX_EXEC.is_file() or not os.access(SANDBOX_EXEC, os.X_OK):
            return unavailable(f"/usr/bin/sandbox-exec missing; {INSTALL_HINT['darwin']}")
        profile = seatbelt_provider_profile(workspace, run_dir, provider, regexes, home)
        profile_path = run_dir / "os-sandbox.sb"
        profile_path.write_bytes(profile)
        prefix = [str(SANDBOX_EXEC), "-f", str(profile_path)]
        kind = "macos-seatbelt"
        limitations.append("deprecated-macos-sandbox-exec")
        builder = lambda: prefix
    elif platform.startswith("linux"):
        bwrap = shutil.which("bwrap")
        if not bwrap:
            return unavailable(f"bwrap not found; {INSTALL_HINT['linux']}")
        kind = "linux-bwrap"
        limitations.append("secret-files-created-after-launch-not-masked")
        builder = lambda: bwrap_argv_prefix(workspace, run_dir, provider, rules, home, bwrap)
        profile = " ".join(builder()).encode("utf-8")
        prefix = None
    else:
        return unavailable(f"no OS sandbox for platform {platform}")

    ok, detail = kernel_probe(builder, workspace, run_dir)
    if not ok:
        return unavailable(f"kernel probe failed: {detail}")
    if prefix is None:
        prefix = builder()
        profile = " ".join(prefix).encode("utf-8")
    sha = sha256_bytes(profile)
    return {
        "kind": kind, "argv_prefix": prefix, "profile_sha256": sha,
        "kernel_probe_sha256": sha, "known_limitations": limitations,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m autonomy.lib.os_sandbox")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("argv")
    p.add_argument("--workspace", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--provider", required=True)
    args = parser.parse_args(argv)
    try:
        status = build_confinement(Path(args.workspace), Path(args.run_dir), args.provider)
    except SandboxUnavailable as exc:
        print(f"os_sandbox: LOKI_OS_SANDBOX=on but confinement is unavailable: {exc}",
              file=sys.stderr)
        return 2
    except (ValueError, OSError) as exc:
        print(f"os_sandbox: {exc}", file=sys.stderr)
        return 2
    if status["kind"] == "none" and status.get("reason") != "LOKI_OS_SANDBOX=off":
        print(f"os_sandbox: running unconfined: {status['reason']}", file=sys.stderr)
    print(json.dumps(status, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
