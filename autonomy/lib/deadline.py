#!/usr/bin/env python3
"""Run one command inside a reconciled process session with idle and hard deadlines."""

from __future__ import annotations

import ctypes
import errno
import json
import os
import select
import selectors
import secrets
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import BinaryIO, NamedTuple


TIMEOUT_EXIT = 124
INTERNAL_EXIT = 125
_DARWIN_LIBPROC = None
_DARWIN_LIBC = None
_LINEAGE_POLL_SECONDS = 0.02
_QUIESCENCE_SECONDS = 0.20
_LINEAGE_DISCOVERY_WINDOW_SECONDS = 0.20
_RECONCILE_SCHEDULING_MARGIN_SECONDS = 0.30
_LINEAGE_ENV_NAME = "LOKI_DEADLINE_LINEAGE"
_CONTROL_ENV_NAME = "LOKI_DEADLINE_CONTROL_FILE"
_EXEC_BOOTSTRAP = """
import os
import sys

gate = int(sys.argv[1])
released = os.read(gate, 1)
os.close(gate)
if released != b"1":
    raise SystemExit(125)
try:
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
except FileNotFoundError:
    raise SystemExit(127)
except PermissionError:
    raise SystemExit(126)
except OSError:
    raise SystemExit(125)
"""


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


class _DarwinProcFdInfo(ctypes.Structure):
    _fields_ = [
        ("proc_fd", ctypes.c_int32),
        ("proc_fdtype", ctypes.c_uint32),
    ]


class _DarwinProcFileInfo(ctypes.Structure):
    _fields_ = [
        ("fi_openflags", ctypes.c_uint32),
        ("fi_status", ctypes.c_uint32),
        ("fi_offset", ctypes.c_int64),
        ("fi_type", ctypes.c_int32),
        ("fi_guardflags", ctypes.c_uint32),
    ]


class _DarwinVinfoStat(ctypes.Structure):
    _fields_ = [
        ("vst_dev", ctypes.c_uint32),
        ("vst_mode", ctypes.c_uint16),
        ("vst_nlink", ctypes.c_uint16),
        ("vst_ino", ctypes.c_uint64),
        ("vst_uid", ctypes.c_uint32),
        ("vst_gid", ctypes.c_uint32),
        ("vst_times", ctypes.c_int64 * 10),
        ("vst_blksize", ctypes.c_int32),
        ("vst_flags", ctypes.c_uint32),
        ("vst_gen", ctypes.c_uint32),
        ("vst_rdev", ctypes.c_uint32),
        ("vst_qspare", ctypes.c_int64 * 2),
    ]


class _DarwinPipeInfo(ctypes.Structure):
    _fields_ = [
        ("pipe_stat", _DarwinVinfoStat),
        ("pipe_handle", ctypes.c_uint64),
        ("pipe_peerhandle", ctypes.c_uint64),
        ("pipe_status", ctypes.c_int32),
        ("rfu_1", ctypes.c_int32),
    ]


class _DarwinPipeFdInfo(ctypes.Structure):
    _fields_ = [
        ("pfi", _DarwinProcFileInfo),
        ("pipeinfo", _DarwinPipeInfo),
    ]


def _darwin_libproc():
    global _DARWIN_LIBPROC
    if _DARWIN_LIBPROC is None:
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        library.proc_listallpids.argtypes = [
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_int,
        ]
        library.proc_listallpids.restype = ctypes.c_int
        library.proc_pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        library.proc_pidinfo.restype = ctypes.c_int
        library.proc_pidfdinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        library.proc_pidfdinfo.restype = ctypes.c_int
        _DARWIN_LIBPROC = library
    return _DARWIN_LIBPROC


def _darwin_libc():
    global _DARWIN_LIBC
    if _DARWIN_LIBC is None:
        library = ctypes.CDLL(None, use_errno=True)
        library.sysctl.argtypes = [
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_uint,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.c_void_p,
            ctypes.c_size_t,
        ]
        library.sysctl.restype = ctypes.c_int
        _DARWIN_LIBC = library
    return _DARWIN_LIBC


def _candidate_pids() -> list[int]:
    if sys.platform == "darwin":
        library = _darwin_libproc()
        count = library.proc_listallpids(None, 0)
        if count <= 0:
            raise RuntimeError("attempt process table query failed")
        capacity = count + 64
        while True:
            values = (ctypes.c_int * capacity)()
            read = library.proc_listallpids(values, ctypes.sizeof(values))
            if read <= 0:
                raise RuntimeError("attempt process table query failed")
            if read < capacity:
                return [pid for pid in values[:read] if pid > 0]
            capacity *= 2
    if sys.platform.startswith("linux"):
        try:
            return [int(name) for name in os.listdir("/proc") if name.isdigit()]
        except OSError as exc:
            raise RuntimeError("attempt process table query failed") from exc
    raise RuntimeError("attempt process table query is unsupported")


class _ProcessRecord(NamedTuple):
    pid: int
    ppid: int
    session_id: int
    identity: str


def _process_record(pid: int) -> _ProcessRecord | None:
    if sys.platform == "darwin":
        info = _DarwinProcBsdInfo()
        size = ctypes.sizeof(info)
        read = _darwin_libproc().proc_pidinfo(pid, 3, 0, ctypes.byref(info), size)
        if read != size or info.pbi_pid != pid or info.pbi_status == 5:
            return None
        try:
            session_id = os.getsid(pid)
        except OSError as exc:
            if exc.errno in (errno.ESRCH, errno.EPERM, errno.EACCES):
                return None
            raise RuntimeError("attempt session identity check failed") from exc
        return _ProcessRecord(
            pid,
            int(info.pbi_ppid),
            session_id,
            f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}",
        )
    try:
        with open(
            f"/proc/{pid}/stat", encoding="utf-8", errors="replace"
        ) as handle:
            raw = handle.read()
        fields = raw.rsplit(")", 1)[1].strip().split()
        if fields[0] == "Z":
            return None
        return _ProcessRecord(
            pid,
            int(fields[1]),
            int(fields[3]),
            f"proc:{fields[19]}",
        )
    except (OSError, IndexError, ValueError):
        return None


def _process_identity(pid: int) -> str:
    record = _process_record(pid)
    return record.identity if record is not None else ""


def _process_snapshot() -> dict[int, _ProcessRecord]:
    snapshot: dict[int, _ProcessRecord] = {}
    for pid in _candidate_pids():
        record = _process_record(pid)
        if record is not None:
            snapshot[pid] = record
    return snapshot


class _LineageUnknown(Exception):
    """The lineage marker could not be read because the process is gone.

    Distinct from "the marker is absent". A vanished process is not evidence
    of a lineage violation -- it is the absence of evidence either way.
    """


def _process_has_lineage_token(pid: int, token: str) -> bool:
    needle = f"{_LINEAGE_ENV_NAME}={token}".encode("ascii")
    if sys.platform == "darwin":
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        size = ctypes.c_size_t()
        library = _darwin_libc()
        if library.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
            return False
        if size.value <= 0:
            return False
        buffer = ctypes.create_string_buffer(size.value)
        if library.sysctl(
            mib, 3, buffer, ctypes.byref(size), None, 0
        ) != 0:
            return False
        return needle in bytes(buffer.raw[: size.value]).split(b"\0")
    if sys.platform.startswith("linux"):
        try:
            with open(f"/proc/{pid}/environ", "rb") as handle:
                payload = handle.read()
            if not payload:
                # A zero-length read raises NOTHING. The kernel empties
                # /proc/<pid>/environ as the process is reaped, so a fast
                # runner yields b"" -- which splits to [b""], does not contain
                # the needle, and returns "no marker" for a process that
                # carried one. Indistinguishable from the FileNotFoundError
                # case below and must be answered the same way.
                raise _LineageUnknown(pid)
            return needle in payload.split(b"\0")
        except FileNotFoundError:
            # The process is already gone. /proc/<pid>/environ disappears the
            # moment a child is reaped, so a short-lived runner that exits
            # before this check runs is indistinguishable here from one that
            # never carried the marker -- and answering "no marker" for it
            # fails the lineage guard and returns 127 as a LAUNCH failure, for
            # a process that in fact launched and completed.
            #
            # Signal "unknown", not "absent". The caller decides, because only
            # the caller knows whether the process it spawned is still alive.
            # macOS never hit this: it has the pipe-handle fallback, so the
            # bug was Linux-only and invisible on a developer Mac.
            raise _LineageUnknown(pid) from None
        except ProcessLookupError:
            # ESRCH: the pid was reaped between opening and reading. Same fact
            # as ENOENT above -- the process is gone, so its marker is UNKNOWN,
            # not absent. Listed BEFORE the OSError clause because it is a
            # subclass and would otherwise be swallowed into "no marker",
            # which fails the lineage guard and reports 127 for a process that
            # launched and completed.
            raise _LineageUnknown(pid) from None
        except OSError:
            # Anything else (EACCES on a hardened /proc, EIO) is a genuine
            # read failure rather than evidence of a completed child, so it
            # stays fail-closed: no marker.
            return False
    return False


def _darwin_pipe_handles(pid: int, fd: int) -> frozenset[int]:
    info = _DarwinPipeFdInfo()
    size = ctypes.sizeof(info)
    read = _darwin_libproc().proc_pidfdinfo(
        pid, fd, 6, ctypes.byref(info), size  # PROC_PIDFDPIPEINFO
    )
    if read != size:
        return frozenset()
    return frozenset(
        value
        for value in (
            int(info.pipeinfo.pipe_handle),
            int(info.pipeinfo.pipe_peerhandle),
        )
        if value != 0
    )


def _process_has_lineage_pipe(pid: int, handles: frozenset[int]) -> bool:
    if sys.platform != "darwin" or not handles:
        return False
    library = _darwin_libproc()
    entry_size = ctypes.sizeof(_DarwinProcFdInfo)
    required = library.proc_pidinfo(pid, 1, 0, None, 0)  # PROC_PIDLISTFDS
    if required <= 0:
        return False
    capacity = max(16, (required // entry_size) + 8)
    entries = (_DarwinProcFdInfo * capacity)()
    read = library.proc_pidinfo(
        pid, 1, 0, ctypes.byref(entries), ctypes.sizeof(entries)
    )
    if read <= 0:
        return False
    for entry in entries[: read // entry_size]:
        if entry.proc_fdtype != 6:  # PROX_FDTYPE_PIPE
            continue
        if _darwin_pipe_handles(pid, int(entry.proc_fd)) & handles:
            return True
    return False


def _configure_child_subreaper() -> bool:
    """Make Linux orphans observable without adding a runtime dependency."""
    if not sys.platform.startswith("linux"):
        return False
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = getattr(libc, "prctl", None)
    if prctl is None:
        raise RuntimeError("attempt child subreaper is unavailable")
    prctl.argtypes = [
        ctypes.c_int,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    prctl.restype = ctypes.c_int
    if prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise RuntimeError("attempt child subreaper setup failed")
    return True


class _LineageTracker:
    """Retain birth-token-bound descendants across reparenting and setsid."""

    def __init__(
        self,
        process: subprocess.Popen[bytes],
        subreaper: bool,
        token: str,
        lineage_pipe_handles: frozenset[int],
    ):
        root = _process_record(process.pid)
        if root is None:
            raise RuntimeError("provider attempt identity is unavailable")
        try:
            has_marker = (
                _process_has_lineage_token(root.pid, token)
                or _process_has_lineage_pipe(root.pid, lineage_pipe_handles)
            )
        except _LineageUnknown:
            # The child exited before we could read its marker. That is a
            # completed run, not a lineage violation -- and it is the common
            # case for any runner that finishes fast. Confirm it really is our
            # child (Popen.poll() is authoritative: it reaps only the process
            # this object spawned) before accepting.
            #
            # This stays fail-closed for the case the guard exists to catch: a
            # LIVE process whose marker is genuinely missing still raises,
            # because poll() returns None for it and we fall through.
            has_marker = process.poll() is not None
        if not has_marker:
            raise RuntimeError("provider attempt lineage marker is unavailable")
        self.root_pid = root.pid
        self.session_id = root.session_id
        self.subreaper = subreaper
        self.token = token
        self.lineage_pipe_handles = lineage_pipe_handles
        self._marker_scan_until = 0.0
        self._depths: dict[tuple[int, str], int] = {
            (root.pid, root.identity): 0
        }
        self._proc_events = None
        self._lineage_read_fd = -1
        self._kernel_tracks_children = False
        if sys.platform == "darwin":
            try:
                self._proc_events = select.kqueue()
                self._kernel_tracks_children = self._watch_process(
                    root.pid, track_children=True
                )
                if not self._kernel_tracks_children:
                    self._marker_scan_until = (
                        time.monotonic() + _LINEAGE_DISCOVERY_WINDOW_SECONDS
                    )
            except (AttributeError, OSError) as exc:
                raise RuntimeError("attempt process lineage tracking failed") from exc

    def _watch_process(self, pid: int, track_children: bool = False) -> bool:
        if self._proc_events is None:
            return False
        fflags = select.KQ_NOTE_FORK | select.KQ_NOTE_EXIT
        if track_children:
            fflags |= select.KQ_NOTE_TRACK
        change = select.kevent(
            pid,
            filter=select.KQ_FILTER_PROC,
            flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
            fflags=fflags,
        )
        try:
            self._proc_events.control([change], 0, 0)
        except OSError as exc:
            if track_children and exc.errno == errno.ENOTSUP:
                self._watch_process(pid, track_children=False)
                return False
            if exc.errno == errno.ESRCH:
                return False
            raise
        return track_children

    def _depth_for_pid(self, pid: int) -> int:
        depths = [
            depth
            for (tracked_pid, _identity), depth in self._depths.items()
            if tracked_pid == pid
        ]
        return max(depths, default=0)

    def _capture_proc_events(self) -> None:
        if self._proc_events is None:
            return
        while True:
            try:
                events = self._proc_events.control(None, 256, 0)
            except OSError as exc:
                raise RuntimeError("attempt process lineage event read failed") from exc
            for event in events:
                if event.fflags & select.KQ_NOTE_TRACKERR:
                    raise RuntimeError("attempt process lineage event overflow")
                if (
                    not self._kernel_tracks_children
                    and event.fflags
                    & (select.KQ_NOTE_FORK | select.KQ_NOTE_CHILD)
                ):
                    self._marker_scan_until = max(
                        self._marker_scan_until,
                        time.monotonic() + _LINEAGE_DISCOVERY_WINDOW_SECONDS,
                    )
                record = _process_record(int(event.ident))
                if record is None:
                    continue
                parent_pid = (
                    int(event.data)
                    if event.fflags & select.KQ_NOTE_CHILD
                    else record.ppid
                )
                self._depths.setdefault(
                    (record.pid, record.identity),
                    self._depth_for_pid(parent_pid) + 1,
                )
            if len(events) < 256:
                return

    def _snapshot(self) -> dict[int, _ProcessRecord]:
        if not self._kernel_tracks_children:
            return _process_snapshot()
        snapshot: dict[int, _ProcessRecord] = {}
        for pid, identity in tuple(self._depths):
            record = _process_record(pid)
            if record is not None and record.identity == identity:
                snapshot[pid] = record
        return snapshot

    def refresh(self) -> list[tuple[int, str]]:
        self._capture_proc_events()
        snapshot = self._snapshot()
        if time.monotonic() <= self._marker_scan_until:
            for record in snapshot.values():
                ref = (record.pid, record.identity)
                if record.pid == os.getpid() or ref in self._depths:
                    continue
                if _process_has_lineage_token(
                    record.pid, self.token
                ) or _process_has_lineage_pipe(
                    record.pid, self.lineage_pipe_handles
                ):
                    self._depths[ref] = self._depth_for_pid(record.ppid) + 1
                    self._watch_process(record.pid)
        while True:
            active_depths = {
                pid: depth
                for (pid, identity), depth in self._depths.items()
                if pid in snapshot and snapshot[pid].identity == identity
            }
            additions: list[tuple[tuple[int, str], int]] = []
            for record in snapshot.values():
                ref = (record.pid, record.identity)
                if ref in self._depths:
                    continue
                parent_depth = active_depths.get(record.ppid)
                if parent_depth is not None:
                    additions.append((ref, parent_depth + 1))
                elif record.session_id == self.session_id:
                    additions.append((ref, 1))
                elif self.subreaper and record.ppid == os.getpid():
                    # Linux reparents escaped double-fork descendants to this
                    # helper after PR_SET_CHILD_SUBREAPER. This process creates
                    # no other children after the provider leader.
                    additions.append((ref, 1))
            if not additions:
                break
            for ref, depth in additions:
                self._depths.setdefault(ref, depth)
                self._watch_process(ref[0])

        return sorted(
            (
                ref
                for ref in self._depths
                if ref[0] in snapshot and snapshot[ref[0]].identity == ref[1]
            ),
            key=lambda ref: self._depths[ref],
            reverse=True,
        )

    def close(self) -> None:
        if self._proc_events is not None:
            self._proc_events.close()
            self._proc_events = None
        if self._lineage_read_fd >= 0:
            os.close(self._lineage_read_fd)
            self._lineage_read_fd = -1


def spawn_tracked(
    command: list[str], **popen_kwargs: object
) -> tuple[subprocess.Popen[bytes], _LineageTracker]:
    """Spawn a gated session leader and arm identity-bound lineage tracking."""
    if not command or "start_new_session" in popen_kwargs:
        raise ValueError("tracked spawn requires a command and owns its session")

    process: subprocess.Popen[bytes] | None = None
    gate_read = gate_write = -1
    lineage_read = lineage_write = -1
    try:
        subreaper = _configure_child_subreaper()
        token = secrets.token_hex(16)
        child_env = dict(popen_kwargs.pop("env", os.environ))
        child_env[_LINEAGE_ENV_NAME] = token
        child_env.pop(_CONTROL_ENV_NAME, None)
        inherited = tuple(popen_kwargs.pop("pass_fds", ()))
        gate_read, gate_write = os.pipe()
        lineage_read, lineage_write = os.pipe()
        handles = (
            _darwin_pipe_handles(os.getpid(), lineage_read)
            if sys.platform == "darwin"
            else frozenset()
        )
        if sys.platform == "darwin" and not handles:
            raise RuntimeError("attempt lineage pipe identity is unavailable")
        process = subprocess.Popen(
            [sys.executable, "-c", _EXEC_BOOTSTRAP, str(gate_read), *command],
            start_new_session=True,
            env=child_env,
            pass_fds=(*inherited, gate_read, lineage_write),
            **popen_kwargs,
        )
        os.close(gate_read)
        gate_read = -1
        tracker = _LineageTracker(process, subreaper, token, handles)
        tracker._lineage_read_fd = lineage_read
        lineage_read = -1
        os.write(gate_write, b"1")
        os.close(gate_write)
        gate_write = -1
        os.close(lineage_write)
        lineage_write = -1
        return process, tracker
    except BaseException:
        for descriptor in (gate_read, gate_write, lineage_read, lineage_write):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)
        raise


def _signal_process(member: tuple[int, str], sig: int) -> None:
    pid, identity = member
    try:
        if _process_identity(pid) != identity:
            return
        os.kill(pid, sig)
    except ProcessLookupError:
        return
    except OSError as exc:
        if exc.errno != errno.ESRCH:
            raise


def reconcile_lineage(
    process: subprocess.Popen[bytes], tracker: _LineageTracker, grace: float
) -> dict[str, object]:
    """Stop the exact tracked lineage and prove a bounded quiet interval."""
    outcome: dict[str, object] = {
        "checked": True,
        "detected": False,
        "quiescent": False,
        "term_sent": [],
        "kill_sent": [],
        "remaining_pids": [],
        "error": "",
    }
    sent: dict[int, set[tuple[int, str]]] = {
        signal.SIGTERM: set(),
        signal.SIGKILL: set(),
    }

    def refresh() -> list[tuple[int, str]]:
        members = tracker.refresh()
        if any(pid != process.pid for pid, _identity in members):
            outcome["detected"] = True
        return members

    def signal_members(
        members: list[tuple[int, str]], signum: int, field: str
    ) -> None:
        recorded = outcome[field]
        assert isinstance(recorded, list)
        for member in members:
            _signal_process(member, signum)
            if member not in sent[signum]:
                sent[signum].add(member)
                if member[0] != process.pid:
                    recorded.append(member[0])

    started = time.monotonic()
    total_grace = max(
        float(grace) + _QUIESCENCE_SECONDS,
        _QUIESCENCE_SECONDS + _RECONCILE_SCHEDULING_MARGIN_SECONDS,
    )
    final_deadline = started + total_grace
    term_deadline = final_deadline - (
        _QUIESCENCE_SECONDS + _RECONCILE_SCHEDULING_MARGIN_SECONDS
    )
    members = refresh()
    signal_members(members, signal.SIGTERM, "term_sent")
    while members and time.monotonic() < term_deadline:
        time.sleep(_LINEAGE_POLL_SECONDS)
        members = refresh()
        signal_members(members, signal.SIGTERM, "term_sent")

    quiet_since: float | None = None
    while time.monotonic() < final_deadline:
        members = refresh()
        if members:
            quiet_since = None
            signal_members(members, signal.SIGKILL, "kill_sent")
        elif quiet_since is None:
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= _QUIESCENCE_SECONDS:
            break
        time.sleep(_LINEAGE_POLL_SECONDS)
    members = refresh()
    outcome["remaining_pids"] = [pid for pid, _identity in members]
    outcome["quiescent"] = bool(
        not members
        and quiet_since is not None
        and time.monotonic() - quiet_since >= _QUIESCENCE_SECONDS
    )
    return outcome


def _stop_lineage(
    process: subprocess.Popen[bytes], tracker: _LineageTracker, grace: float
) -> bool:
    outcome = reconcile_lineage(process, tracker, grace)
    members = outcome["remaining_pids"]
    if not outcome["quiescent"]:
        raise RuntimeError(
            "provider attempt lineage is still active: "
            + ",".join(str(pid) for pid in members)
        )

    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        raise RuntimeError("provider attempt leader did not stop")
    return bool(outcome["detected"])


def _exit_code(returncode: int) -> int:
    return 128 + abs(returncode) if returncode < 0 else returncode


def _write_output(chunk: bytes, stream: BinaryIO) -> bool:
    try:
        stream.write(chunk)
        stream.flush()
        return True
    except BrokenPipeError:
        return False


def _emit_timeout(reason: str, hard_seconds: int, idle_seconds: int) -> None:
    record = {
        "type": "loki_provider_deadline",
        "reason": reason,
        "hard_seconds": hard_seconds,
        "idle_seconds": idle_seconds,
    }
    print(json.dumps(record, separators=(",", ":")), file=sys.stderr, flush=True)


def _write_control(path: Path) -> bytes:
    record = json.dumps(
        {
            "schema": "loki-deadline-control/v1",
            "pid": os.getpid(),
            "identity": _process_identity(os.getpid()),
        },
        sort_keys=True,
    ).encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        os.write(descriptor, record)
    finally:
        os.close(descriptor)
    return record


def _clear_control(path: Path, expected: bytes) -> None:
    try:
        if path.read_bytes() == expected:
            path.unlink()
    except OSError:
        pass


def cancel_control(path: Path) -> int:
    try:
        info = os.lstat(path)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > 1024
        ):
            return INTERNAL_EXIT
        record = json.loads(path.read_text(encoding="utf-8"))
        if set(record) != {"schema", "pid", "identity"}:
            return INTERNAL_EXIT
        pid = record["pid"]
        identity = record["identity"]
        if (
            record["schema"] != "loki-deadline-control/v1"
            or not isinstance(pid, int)
            or pid <= 1
            or not isinstance(identity, str)
            or not identity
            or _process_identity(pid) != identity
        ):
            return INTERNAL_EXIT
        os.kill(pid, signal.SIGTERM)
        return 0
    except (OSError, ValueError, json.JSONDecodeError):
        return INTERNAL_EXIT


def _drain_output(process: subprocess.Popen[bytes]) -> None:
    for pipe, stream in (
        (process.stdout, sys.stdout.buffer),
        (process.stderr, sys.stderr.buffer),
    ):
        if pipe is None:
            continue
        while True:
            try:
                chunk = os.read(pipe.fileno(), 65536)
            except BlockingIOError:
                break
            if not chunk:
                break
            if not _write_output(chunk, stream):
                break


def _wait_for_output(
    process: subprocess.Popen[bytes],
    tracker: _LineageTracker,
    hard_seconds: int,
    idle_seconds: int,
) -> tuple[int | None, str | None]:
    if process.stdout is None or process.stderr is None:
        return INTERNAL_EXIT, None

    selector = selectors.DefaultSelector()
    streams = {
        process.stdout.fileno(): sys.stdout.buffer,
        process.stderr.fileno(): sys.stderr.buffer,
    }
    for output_fd, stream in streams.items():
        os.set_blocking(output_fd, False)
        selector.register(output_fd, selectors.EVENT_READ, stream)
    started = last_activity = time.monotonic()
    open_fds = set(streams)

    try:
        while True:
            tracker.refresh()
            now = time.monotonic()
            hard_remaining = hard_seconds - (now - started)
            idle_remaining = (
                idle_seconds - (now - last_activity) if idle_seconds > 0 else hard_remaining
            )
            wait_seconds = max(
                0.0,
                min(hard_remaining, idle_remaining, _LINEAGE_POLL_SECONDS),
            )

            if open_fds:
                for key, _events in selector.select(wait_seconds):
                    try:
                        chunk = os.read(key.fd, 65536)
                    except BlockingIOError:
                        continue
                    if chunk:
                        if not _write_output(chunk, key.data):
                            return 141, None
                        last_activity = time.monotonic()
                    else:
                        selector.unregister(key.fd)
                        open_fds.discard(key.fd)
            elif wait_seconds > 0:
                time.sleep(wait_seconds)

            tracker.refresh()

            returncode = process.poll()
            if returncode is not None:
                for output_fd in tuple(open_fds):
                    while True:
                        try:
                            chunk = os.read(output_fd, 65536)
                        except BlockingIOError:
                            break
                        if not chunk:
                            break
                        if not _write_output(chunk, streams[output_fd]):
                            return 141, None
                return _exit_code(returncode), None

            now = time.monotonic()
            if now - started >= hard_seconds:
                return None, "hard_timeout"
            if idle_seconds > 0 and now - last_activity >= idle_seconds:
                return None, "idle_timeout"
    finally:
        selector.close()


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "cancel":
        return cancel_control(Path(sys.argv[2]))
    if len(sys.argv) < 5:
        return INTERNAL_EXIT
    try:
        hard_seconds = int(sys.argv[1])
        kill_grace = int(sys.argv[2])
        if sys.argv[3] == "--":
            idle_seconds = 0
            command = sys.argv[4:]
        elif len(sys.argv) >= 6 and sys.argv[4] == "--":
            idle_seconds = int(sys.argv[3])
            command = sys.argv[5:]
        else:
            return INTERNAL_EXIT
    except ValueError:
        return INTERNAL_EXIT
    if hard_seconds <= 0 or kill_grace <= 0 or idle_seconds < 0 or not command:
        return INTERNAL_EXIT
    if idle_seconds >= hard_seconds and idle_seconds != 0:
        return INTERNAL_EXIT

    process: subprocess.Popen[bytes] | None = None
    tracker: _LineageTracker | None = None
    try:
        process, tracker = spawn_tracked(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
    except (OSError, RuntimeError):
        return INTERNAL_EXIT

    def forward_and_exit(signum: int, _frame: object) -> None:
        try:
            _stop_lineage(process, tracker, min(float(kill_grace), 0.5))
        except (PermissionError, RuntimeError):
            raise SystemExit(INTERNAL_EXIT)
        raise SystemExit(128 + signum)

    for forwarded in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(forwarded, forward_and_exit)

    control_path: Path | None = None
    control_record = b""
    try:
        try:
            raw_control_path = os.environ.get(_CONTROL_ENV_NAME, "")
            if raw_control_path:
                control_path = Path(raw_control_path)
                control_record = _write_control(control_path)
            returncode, timeout_reason = _wait_for_output(
                process, tracker, hard_seconds, idle_seconds
            )
        except (OSError, PermissionError, RuntimeError):
            try:
                _stop_lineage(process, tracker, float(kill_grace))
            except (PermissionError, RuntimeError):
                pass
            return INTERNAL_EXIT
        if timeout_reason is not None:
            _emit_timeout(timeout_reason, hard_seconds, idle_seconds)
            try:
                _stop_lineage(process, tracker, float(kill_grace))
            except (PermissionError, RuntimeError):
                return INTERNAL_EXIT
            _drain_output(process)
            return TIMEOUT_EXIT

        if returncode == 141:
            try:
                _stop_lineage(process, tracker, float(kill_grace))
            except (PermissionError, RuntimeError):
                return INTERNAL_EXIT
            return 141

        # A provider must not leave tool processes alive after its own exit.
        try:
            had_descendants = _stop_lineage(process, tracker, 0.1)
        except (PermissionError, RuntimeError):
            return INTERNAL_EXIT
        if had_descendants:
            return INTERNAL_EXIT
        return returncode if returncode is not None else INTERNAL_EXIT
    finally:
        if control_path is not None and control_record:
            _clear_control(control_path, control_record)
        tracker.close()


if __name__ == "__main__":
    raise SystemExit(main())
