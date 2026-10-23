#!/usr/bin/env python3
"""One OS confinement module: macOS Seatbelt and Linux bubblewrap.

Owns the Seatbelt profile builder and kernel smoke probe (moved out of
dashboard/build_supervisor.py) plus a provider-agnostic argv wrapper.
Secret paths come from autonomy/lib/secret-paths.json, the same list
src/policies/claude_permissions.js compiles into Claude read-deny rules.

CLI:
  python3 -m autonomy.lib.os_sandbox argv --workspace W --run-dir R --provider P
      [--extra-read PATH ...] [--status-file F]
prints {kind, argv_prefix, profile_sha256, kernel_probe_sha256, known_limitations}.
--status-file also writes the same object without argv_prefix, for `loki status --json`.
LOKI_OS_SANDBOX=off|auto|on (default off; auto is opt-in). Under on, an unavailable sandbox or a
failed kernel probe exits 2. auto falls back to kind none with a reason and says so.
off opts out. The launch paths of `loki start` (run.sh and the engine10 session host)
call this module; there is no second profile builder.
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


# Read allow-list for confine_reads (macOS). Measured with sandbox-exec: the
# dyld/system roots below plus blanket file-read-metadata and read-data on the
# "/" literal are the minimum for /bin/sh, python3, node, bun and claude to start.
SYSTEM_READ_ROOTS = (
    "/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc",
    "/private/var/db", "/private/var/select", "/dev", "/Applications",
    "/opt/homebrew", "/private/tmp", "/private/var/folders",
)
# Linux counterpart of SYSTEM_READ_ROOTS for confine_reads under bwrap: the only
# system paths bound into the empty root. Anything not listed (the user's home,
# /root, /srv, /mnt, /var) does not exist inside, so a symlink out of the
# workspace to it cannot be read or written through.
LINUX_READ_ROOTS = (
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt",
    "/run/systemd/resolve",
)
HOME_TOOLCHAIN = (
    ".local", ".nvm", ".bun", ".cargo", ".npm", ".npmrc", ".config/git",
    ".cache", "Library/Caches",
    # Measured: claude login (macOS Keychain) reports "Not logged in" without it.
    # The db is encrypted at rest; securityd access already rides on mach-lookup.
    "Library/Keychains",
)


def git_read_paths(workspace: Path) -> list[Path]:
    """Common git dir (linked worktrees) and object alternates for the workspace."""
    found: list[Path] = []
    try:
        res = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return found
    if res.returncode != 0 or not res.stdout.strip():
        return found
    common = Path(res.stdout.strip())
    common = (common if common.is_absolute() else workspace / common).resolve()
    if common.is_dir():
        found.append(common)
        alternates = common / "objects" / "info" / "alternates"
        if alternates.is_file():
            for line in alternates.read_text(errors="replace").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    alt = Path(line)
                    alt = (alt if alt.is_absolute() else common / "objects" / alt).resolve()
                    if alt.exists():
                        found.append(alt)
    return found


def _git_out(workspace: Path, *args: str) -> str | None:
    try:
        res = subprocess.run(["git", "-C", str(workspace), "-c", "core.fsmonitor=",
                              "-c", "core.hooksPath=/dev/null", *args],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0 or not res.stdout.strip():
        return None
    return res.stdout.strip()


def _git_path(workspace: Path, flag: str) -> Path | None:
    out = _git_out(workspace, "rev-parse", flag)
    if out is None:
        return None
    return (Path(out) if Path(out).is_absolute() else workspace / out).resolve()


def git_write_paths(workspace: Path) -> list[Path]:
    """Writable git state of a LINKED worktree: its own gitdir, the shared
    objects, and ONLY the ref and reflog of the branch checked out here
    (refs/heads/<branch>, its .lock, logs/refs/heads/<branch>). The rest of
    refs, logs and packed-refs, the hooks and the config stay read-only, so a
    confined process can neither move another branch (main) nor create a tag
    or plant a hook that runs outside the sandbox. The gitdir is writable as a
    whole (HEAD, index, logs/HEAD, ORIG_HEAD), so the pointers inside it that
    redirect git to an attacker-chosen directory are denied separately by
    git_deny_paths; a caller must apply both."""
    gitdir, common = _git_path(workspace, "--git-dir"), _git_path(workspace, "--git-common-dir")
    if not gitdir or not common or gitdir == common:
        return []
    paths = [gitdir]
    if (common / "objects").is_dir():
        paths.append(common / "objects")
    branch = _git_out(workspace, "symbolic-ref", "-q", "--short", "HEAD")
    if branch and ".." not in branch.split("/") and not branch.startswith("/"):
        ref = common / "refs" / "heads" / branch
        log = common / "logs" / "refs" / "heads" / branch
        paths += [ref, Path(f"{ref}.lock"), log]
    return paths


def git_deny_paths(workspace: Path) -> list[tuple[str, Path]]:
    """(kind, path) write denies that keep confined code from repointing the
    git metadata the harness's next unconfined git reads (FC-SANDBOX-GIT-REDIRECT).
    kind is "literal" or "subpath". Linked worktree: ws/.git (the pointer file) and
    gitdir/{commondir,gitdir,config.worktree}. Primary checkout: ws/.git itself,
    ws/.git/hooks, ws/.git/config{,.worktree} and ws/.git/{commondir,gitdir}. HEAD, index, logs/HEAD and
    ORIG_HEAD stay writable so a commit still works. Empty outside a git repo."""
    gitdir, common = _git_path(workspace, "--git-dir"), _git_path(workspace, "--git-common-dir")
    if not gitdir or not common:
        return []
    dotgit = workspace / ".git"
    denies: list[tuple[str, Path]] = [("literal", dotgit)]
    if gitdir == common:
        if gitdir != dotgit.resolve():
            return denies
        # commondir and gitdir normally do not exist in a primary .git; a literal deny on the
        # missing path still stops confined code creating one to repoint the next git
        # (Seatbelt matches by path; bwrap cannot mount over a missing path, so the Linux
        # guard for it is the GIT_DIR/GIT_COMMON_DIR pin the harness applies).
        denies += [("subpath", gitdir / "hooks"), ("literal", gitdir / "config"),
                   ("literal", gitdir / "config.worktree"),
                   ("literal", gitdir / "commondir"), ("literal", gitdir / "gitdir")]
    else:
        denies += [("literal", gitdir / name) for name in ("commondir", "gitdir", "config.worktree")]
    return denies


def git_pin(workspace: Path) -> dict[str, str] | None:
    """The git dir and common dir as they are NOW, before the confined process
    runs. The harness passes these to safeGit (gitDir) so a repointed .git or
    commondir is never followed. None when the workspace is not a git repo."""
    gitdir, common = _git_path(workspace, "--git-dir"), _git_path(workspace, "--git-common-dir")
    if not gitdir or not common:
        return None
    return {"git_dir": str(gitdir), "git_common_dir": str(common)}


def read_allow_paths(
    workspace: Path, run_dir: Path, provider: str, home: Path,
    extra_read: Iterable[Path] = (),
) -> list[Path]:
    paths = [Path(p) for p in SYSTEM_READ_ROOTS if Path(p).exists()]
    paths += [workspace, run_dir, *provider_write_paths(provider, home)]
    paths += [Path(p) for p in extra_read if Path(p).exists()]
    paths += [(home / rel) for rel in HOME_TOOLCHAIN if (home / rel).exists()]
    paths += git_read_paths(workspace)
    return paths


def seatbelt_provider_profile(
    workspace: Path,
    run_dir: Path,
    provider: str,
    secret_regexes: Iterable[str],
    home: Path | None = None,
    confine_reads: bool = False,
    secret_targets: Iterable[Path] = (),
    extra_read: Iterable[Path] = (),
) -> bytes:
    """Provider-CLI profile: writes confined, secrets denied.

    Reads are open unless confine_reads, which replaces the blanket read allow
    with an allow-list (system roots, workspace, run dir, provider and toolchain
    paths, git common dir, gitconfig) so a symlink out of the workspace to a
    non-secret file cannot be read.

    secret_targets are the resolved targets of symlinked secret paths:
    Seatbelt matches the resolved path, so a regex on the link name misses them.
    """
    home = (home or Path(os.path.expanduser("~"))).resolve()
    quote = lambda value: json.dumps(str(value), ensure_ascii=True)
    writable = [workspace, run_dir, *provider_write_paths(provider, home), *git_write_paths(workspace)]
    lines = [
        "(version 1)",
        "(deny default)",
        "(allow process-fork process-exec*)",
        "(allow signal (target same-sandbox))",
        "(allow process-info* (target same-sandbox))",
        "(allow sysctl-read)",
        "(allow mach-lookup)",
        "(allow ipc-posix-shm ipc-posix-sem)",
        "(allow network*)",
        "(allow user-preference-read)",
        "(allow file-map-executable)",
    ]
    if confine_reads:
        lines.append("(allow file-read-metadata)")
        lines.append('(allow file-read-data (literal "/"))')
        for path in sorted({*read_allow_paths(workspace, run_dir, provider, home, extra_read)}, key=str):
            lines.append(f"(allow file-read* {seatbelt_path_filter(path)})")
        lines.append(
            "(allow file-read* (regex #\"^" + re.escape(str(home)) + "/\\.gitconfig[^/]*$\"))"
        )
    else:
        lines.append("(allow file-read*)")
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
    for target in sorted({*secret_targets}, key=str):
        lines.append(f"(deny file-read-data {seatbelt_path_filter(target)})")
        lines.append(f"(deny file-write* {seatbelt_path_filter(target)})")
    for kind, path in git_deny_paths(workspace):
        lines.append(f"(deny file-write* ({kind} {quote(path)}))")
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


def secret_symlink_targets(
    roots: Iterable[Path],
    rules: list[dict[str, str]],
    home: Path,
) -> list[Path]:
    """Resolved targets of secret paths that are reached through a symlink."""
    candidates = [
        *(home / r["name"] for r in rules if r["kind"] == "dir"),
        *(p for r in rules if r["kind"] == "file" for p in home.glob(r["glob"])),
        *_find_secret_files(roots, rules),
    ]
    targets: set[Path] = set()
    for path in candidates:
        if not path.is_symlink():
            continue
        try:
            targets.add(path.resolve(strict=True))
        except OSError:
            continue
    return sorted(targets, key=str)


def _bwrap_root_binds(
    workspace: Path, run_dir: Path, provider: str, home: Path, extra_read: Iterable[Path],
) -> list[str]:
    """Read-only binds for confine_reads: system roots, toolchain, provider paths,
    git common dir and extra_read. A root that is itself a symlink (merged /usr:
    /bin -> usr/bin) is recreated as a symlink, never followed."""
    argv: list[str] = []
    bound: list[Path] = []

    def covered(path: Path) -> bool:
        return any(path == b or b in path.parents for b in bound)

    for raw in LINUX_READ_ROOTS:
        root = Path(raw)
        if root.is_symlink():
            argv += ["--symlink", os.readlink(root), str(root)]
        elif root.exists() and not covered(root):
            argv += ["--ro-bind", str(root), str(root)]
            bound.append(root)
    extra = [Path(p).resolve() for p in extra_read if Path(p).exists()]
    others = [*extra, *(home / rel for rel in HOME_TOOLCHAIN if (home / rel).exists()),
              *git_read_paths(workspace)]
    for path in others:
        path = path.resolve()
        if not covered(path):
            argv += ["--ro-bind", str(path), str(path)]
            bound.append(path)
    return argv


def bwrap_argv_prefix(
    workspace: Path,
    run_dir: Path,
    provider: str,
    rules: list[dict[str, str]],
    home: Path | None = None,
    bwrap: str = "bwrap",
    confine_reads: bool = False,
    extra_read: Iterable[Path] = (),
) -> list[str]:
    home = (home or Path(os.path.expanduser("~"))).resolve()
    if confine_reads:
        # Empty root: only the listed paths exist inside, so reads outside them fail.
        argv = [bwrap, *_bwrap_root_binds(workspace, run_dir, provider, home, extra_read),
                "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
    else:
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
    # Mask the resolved target of a symlinked secret, never the link itself.
    candidates = [p.resolve() if p.is_symlink() and p.exists() else p for p in candidates]
    for path in candidates:
        if str(path) in masked or not path.exists():
            continue
        masked.add(str(path))
        if path.is_dir():
            argv += ["--tmpfs", str(path)]
        else:
            argv += ["--ro-bind", "/dev/null", str(path)]
    # FC-SANDBOX-GIT-REDIRECT: the git pointers inside the writable bind stay read-only.
    for _kind, path in git_deny_paths(workspace):
        # A whole primary .git dir stays writable (commits); a mount on its hooks and config entries
        # already makes them, and so .git, impossible to rename away.
        if path.exists() and not (path.name == ".git" and path.is_dir()):
            argv += ["--ro-bind", str(path), str(path)]
    if confine_reads:
        # The synthetic root is a writable tmpfs; make it read-only so a write to an
        # unbound path fails instead of landing in a throwaway directory.
        argv += ["--remount-ro", "/"]
    argv += ["--die-with-parent", "--"]
    return argv


# ------------------------------------------------------------- kernel probes

_PROBE_SCRIPT = (
    'cat "$1/.env" >/dev/null 2>&1 && exit 41; '
    'cat "$1/plain.txt" >/dev/null 2>&1 || exit 42; '
    ': > "$1/w.txt" 2>/dev/null || exit 43; '
    '[ -z "$2" ] || { ( : > "$2" ) 2>/dev/null && exit 44; }; '
    'exit 0'
)


def _outside_probe_dir(workspace: Path, platform: str) -> Path | None:
    """A writable-by-user dir outside the workspace that the sandbox must refuse."""
    roots = tuple(r.resolve() for r in TMP_ROOTS.get(platform, ()))
    for candidate in (workspace.resolve().parent, Path(os.path.expanduser("~")).resolve()):
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
    mode = mode or "off"
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
    confine_reads: bool | None = None,
    extra_read: Iterable[Path] = (),
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
    if provider == "codex":
        # codex exec --sandbox workspace-write applies its own Seatbelt/Landlock; a second
        # sandbox_apply inside ours is refused by the kernel, so codex is not wrapped.
        # Under =on that is a fail-open, so refuse instead of returning kind none.
        if mode == "on":
            raise SandboxUnavailable(
                "LOKI_OS_SANDBOX=on cannot confine codex: it runs its own OS sandbox and nesting is refused by the kernel"
            )
        return none("codex runs its own OS sandbox (--sandbox workspace-write); nesting is refused by the kernel")
    workspace = workspace.resolve(strict=True)
    run_dir = run_dir.resolve(strict=True)
    rules = load_secret_rules()
    regexes = secret_path_regexes(rules)
    if confine_reads is None:
        # Default on (macOS): AC6 needs a symlink out of the workspace to be unreadable
        # without a flag. LOKI_OS_SANDBOX_CONFINE_READS=0 opts out for a provider whose
        # login needs a wider read set.
        confine_reads = os.environ.get("LOKI_OS_SANDBOX_CONFINE_READS", "1") != "0"
    confine_reads = bool(confine_reads) and (platform == "darwin" or platform.startswith("linux"))
    limitations = ["unrestricted-outbound-network",
                   "preexisting-cross-boundary-hardlinks"]
    if not confine_reads:
        limitations.append("reads-outside-workspace-allowed-except-secret-paths")
    elif platform == "darwin":
        limitations.append("keychain-db-readable-for-provider-login")

    def unavailable(reason: str) -> dict[str, Any]:
        if mode == "on":
            raise SandboxUnavailable(reason)
        return none(reason)

    if platform == "darwin":
        if not SANDBOX_EXEC.is_file() or not os.access(SANDBOX_EXEC, os.X_OK):
            return unavailable(f"/usr/bin/sandbox-exec missing; {INSTALL_HINT['darwin']}")
        targets = secret_symlink_targets(
            [workspace, run_dir], rules, home or Path(os.path.expanduser("~")))
        profile = seatbelt_provider_profile(workspace, run_dir, provider, regexes, home,
                                          confine_reads, targets, extra_read)
        # Inline -p: a profile file under a writable path could be rewritten by
        # the confined process and read by the next launch.
        prefix = [str(SANDBOX_EXEC), "-p", profile.decode("utf-8")]
        kind = "macos-seatbelt"
        limitations.append("deprecated-macos-sandbox-exec")
        limitations.append("git-objects-writable-not-create-only-in-linked-worktree")
        builder = lambda: prefix
    elif platform.startswith("linux"):
        bwrap = shutil.which("bwrap")
        if not bwrap:
            return unavailable(f"bwrap not found; {INSTALL_HINT['linux']}")
        kind = "linux-bwrap"
        limitations += [
            "secret-files-created-after-launch-not-masked",
            "bwrap-masks-only-aws-ssh-and-secrets-under-workspace-and-run-dir",
            "bwrap-walk-skips-node_modules-venv-git-and-caps-at-200000-entries",
        ]
        builder = lambda: bwrap_argv_prefix(workspace, run_dir, provider, rules, home, bwrap,
                                            confine_reads, extra_read)
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
    probe_sha = sha256_bytes(f"{sha}\n{_PROBE_SCRIPT}\nprobe-ok".encode("utf-8"))
    return {
        "kind": kind, "argv_prefix": prefix, "profile_sha256": sha,
        "kernel_probe_sha256": probe_sha, "known_limitations": limitations,
        "git_pin": git_pin(workspace),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m autonomy.lib.os_sandbox")
    sub = parser.add_subparsers(dest="command", required=True)
    pn = sub.add_parser("pin")
    pn.add_argument("--workspace", required=True)
    p = sub.add_parser("argv")
    p.add_argument("--workspace", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--provider", required=True)
    p.add_argument("--extra-read", action="append", default=[])
    p.add_argument("--status-file")
    p.add_argument("--format", choices=("json", "b64"), default="json")
    args = parser.parse_args(argv)
    if args.command == "pin":
        # b64 lines: git dir, then common dir. Empty output outside a git repo.
        import base64
        pin = git_pin(Path(args.workspace).resolve())
        for key in ("git_dir", "git_common_dir") if pin else ():
            print(base64.b64encode(pin[key].encode("utf-8")).decode("ascii"))
        return 0
    try:
        status = build_confinement(Path(args.workspace), Path(args.run_dir), args.provider,
                                   extra_read=[Path(x) for x in args.extra_read])
    except SandboxUnavailable as exc:
        print(f"os_sandbox: LOKI_OS_SANDBOX=on but confinement is unavailable: {exc}",
              file=sys.stderr)
        return 2
    except (ValueError, OSError) as exc:
        print(f"os_sandbox: {exc}", file=sys.stderr)
        return 2
    if status["kind"] == "none" and status.get("reason") != "LOKI_OS_SANDBOX=off":
        print(f"os_sandbox: running unconfined: {status['reason']}", file=sys.stderr)
    if args.status_file:
        # Informational only: a workspace-writable file the agent can forge. Never read it as evidence (Seal, verify, gates).
        record = {k: v for k, v in status.items() if k != "argv_prefix"}
        record["provider"] = args.provider
        record["mode"] = resolve_mode()
        target = Path(args.status_file)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(record, sort_keys=True) + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"os_sandbox: cannot write status file: {exc}", file=sys.stderr)
    if args.format == "b64":
        # One base64 line per argv element: lets a bash 3.2 caller rebuild the array without NUL handling.
        import base64
        for item in status["argv_prefix"]:
            print(base64.b64encode(item.encode("utf-8")).decode("ascii"))
        return 0
    print(json.dumps(status, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
