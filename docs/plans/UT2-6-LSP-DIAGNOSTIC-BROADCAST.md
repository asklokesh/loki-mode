# UT2-6: Multi-agent LSP Diagnostic Broadcast

Status: draft plan, not scheduled for v7.7.x
Author: planning session, 2026-05-24
Supersedes acceptance criterion #3 of the v7.7.0 LSP grounding work
Owner: TBD

## 1. Problem statement

Loki v7.7.0 shipped LSP grounding via `mcp/lsp_proxy.py`. Each MCP server instance lazily spawns per-language LSP processes (`pyright-langserver`, `typescript-language-server`, `gopls`, `rust-analyzer`, `jdtls`) on first tool call. When Loki runs in parallel mode (`skills/parallel-workflows.md`), each worktree gets its own Claude session, which spawns its own MCP server instance, which spawns its own LSP pool. Two failure modes follow:

1. **Cold-start tax**: N worktrees x M languages = N*M LSP spawns. Pyright on a real TS project is 3-6 s cold; multiplied by 5 worktrees that is 15-30 s of wall clock and ~250 MB RSS per process duplicated.
2. **Diagnostic blindness**: when worktree-A discovers via `lsp_get_diagnostics` that `foo.ts` now has a type error after its edit, worktrees B/C/D never see that signal. If B is planning an overlapping edit on `foo.ts`, B will compute against a stale model and may introduce conflicting changes that surface only at merge time.

The v7.7.0 CHANGELOG explicitly defers this:

> Multi-agent diagnostic broadcast (acceptance #3): we share one LSP client per language per process; two agents in PARALLEL WORKTREES get their own process pool. Cross-worktree broadcast deferred to v7.7.1.

This document is the planning input for that deferred work. **It does not need to ship in v7.7.x.**

## 2. Design pivot: broadcast first, pool later

The task framing puts "shared LSP pool" (1 process for N worktrees) on equal footing with "diagnostic broadcast." This plan splits them and downgrades pooling to a follow-on. Reasoning:

- Worktrees are different working copies. Two worktrees of a TypeScript project diverge in:
  - On-disk source (the whole point of worktrees).
  - `node_modules/` if `npm install` was run per worktree (common; see `spawn-parallel.sh` in `parallel-workflows.md` line 360).
  - Active `tsconfig.json` references (a feature branch can edit tsconfig).
  - Per-worktree generated files (`.next/`, `dist/`, etc.).
- LSP servers maintain per-workspace in-memory module graphs. Multi-root workspaces (`workspaceFolders` in the LSP `initialize` params) exist, but pyright and typescript-language-server treat each root as semi-independent; switching the active root mid-flight or running concurrent edits across roots is not a tested path and surfaces server-specific quirks.
- The win the requirement actually asks for is "agent B is notified to re-plan when A's edit produced a new diagnostic." That is achievable without process consolidation. Broadcasting from N processes to a shared bus solves the correctness problem; pool consolidation is a separate cold-start optimization.

So v1 keeps the N-process model and adds a publish/subscribe channel. v2 (out of scope here) considers process consolidation behind a feature flag, with measured trade-offs.

## 3. Prerequisite: fix the orphan `pending_diagnostics` reference

`lsp_proxy.py` line 867 (in `lsp_get_diagnostics`) reads:

```python
if hasattr(client, 'pending_diagnostics'):
    target_uri = _path_to_uri(abs_file)
    for _ in range(5):
        with getattr(client, '_lock', threading.Lock()):
            buf = getattr(client, 'pending_diagnostics', {})
            ...
```

The class `LSPClient` has no `pending_diagnostics` attribute and no notification-reader thread. `LSPClient.request()` reads messages in a busy loop until it sees the response with the matching `id`, dropping all notifications it sees along the way (including `textDocument/publishDiagnostics`). So `lsp_get_diagnostics` today always returns an empty diagnostics array on every call. **This is a latent bug that any broadcast implementation must fix as a prerequisite**, because the diagnostics the bus will broadcast come from those exact notifications.

Required change to `LSPClient`:
- Spawn a single notification-reader thread per client at end of `start()`.
- The reader owns `proc.stdout`. `request()` no longer reads from stdout directly; instead it parks on a per-request `threading.Event` (or `Queue`) keyed by request id, and the reader thread routes responses by id and routes notifications by method.
- `publishDiagnostics` notifications populate `self.pending_diagnostics: Dict[str, List[Diagnostic]]` keyed by URI, and also fire a registered callback (the broadcast hook, see section 5).
- Locking: notification reads and response routing share a single `threading.Lock`; the request-side `Event.wait(timeout)` handles flow control.

This is mostly a refactor of the existing send/receive code; no new dependencies. ~150 LOC delta in `lsp_proxy.py`.

## 4. Architecture overview

```
+-----------+       +-----------+       +-----------+
| worktree-A|       | worktree-B|       | worktree-C|
|           |       |           |       |           |
| Claude    |       | Claude    |       | Claude    |
| MCP svr   |       | MCP svr   |       | MCP svr   |
| lsp-pxy   |       | lsp-pxy   |       | lsp-pxy   |
|  +pyright |       |  +pyright |       |  +pyright |
+----+------+       +----+------+       +----+------+
     | publish           | publish           | publish
     v                   v                   v
              +--------------------+
              | shared .loki/events/lsp/  |     (or main worktree's .loki/)
              +----------+---------+
                         | subscribe
        +----------------+----------------+
        v                v                v
   worktree-A      worktree-B      worktree-C
   (subscriber)    (subscriber)    (subscriber)
```

Key points:
- Each worktree still runs its own LSP processes (no pooling in v1).
- Publishing target is a shared `.loki/events/lsp/` directory resolved at MCP startup. Resolution rule: walk up from CWD looking for a `.loki/parallel-root` marker file (written by `spawn-parallel.sh`); if found, use that directory's `.loki/events/lsp/`; else use local `.loki/events/lsp/` (single-worktree behavior degrades to a noop bus that still works).
- Reuses `events/bus.py` semantics (file-based, processed-id dedup, lockfile-based atomic writes, cross-language compatible) but with a dedicated subdirectory so LSP events do not pollute the existing pending/archive flow that the dashboard consumes.

## 5. Component design

### 5.1 New module: `mcp/lsp_broadcast.py`

Responsibilities:
1. Resolve the shared bus root.
2. Publish diagnostic events from LSP notifications.
3. Provide a subscriber MCP tool `lsp_subscribe_diagnostics` for agents.
4. Provide a one-shot poll tool `lsp_recent_diagnostics(since=...)` for stateless agents.
5. Maintain a per-process subscriber state file so an agent that disconnects and reconnects resumes from `last_event_id`.

Pseudocode sketch:

```python
# mcp/lsp_broadcast.py

DIAG_EVENT_DIR = ".loki/events/lsp"          # under shared root
DIAG_JSONL     = "diagnostics.jsonl"          # append-only log, primary channel
DIAG_INDEX     = "index.json"                 # {last_event_id, last_offset}
PARALLEL_MARKER = ".loki/parallel-root"

def resolve_shared_root(cwd: str) -> Path:
    # Walk up until we find PARALLEL_MARKER or hit fs root / first .git.
    # Marker file contains the absolute path of the shared root.
    # Fallback: local .loki.
    ...

class DiagnosticPublisher:
    def __init__(self, workspace_id: str, root: Path):
        self.workspace_id = workspace_id      # = worktree basename + git branch hash
        self.path = root / DIAG_EVENT_DIR / DIAG_JSONL
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def publish(self, uri: str, diagnostics: list[dict]) -> None:
        # Called from LSPClient notification thread. Must be lock-free
        # against subscribers; uses POSIX O_APPEND semantics (atomic for
        # writes < PIPE_BUF, 4096 on linux/macos). Each line < 4 KB.
        for d in diagnostics:
            evt = {
                "event_id": uuid4().hex[:12],
                "ts": utcnow_iso(),
                "workspace_id": self.workspace_id,
                "uri": uri,
                "file_relpath": relpath_from_workspace(uri),
                "severity": d.get("severity"),    # LSP: 1=error 2=warn 3=info 4=hint
                "range": d.get("range"),
                "message": d.get("message", "")[:512],
                "source": d.get("source"),
                "msg_hash": sha256(d.get("message",""))[:8],
            }
            line = json.dumps(evt, separators=(",", ":")) + "\n"
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line)
        # Truncation policy: see section 7.2.
```

Subscriber MCP tool:

```python
@mcp.tool()
async def lsp_subscribe_diagnostics(
    file_globs: list[str] | None = None,
    severity_min: int = 2,
    since_event_id: str | None = None,
    timeout_s: float = 5.0,
    max_events: int = 50,
) -> str:
    """Return diagnostic events from peer worktrees since the given id.

    Blocks up to timeout_s if no new events match. Returns ordered by
    event_id (which is monotonic per-file via the JSONL byte offset).
    """
    ...
```

Optional follow-on tool `lsp_recent_diagnostics(seconds=60)` for one-shot polling without the cursor pattern.

### 5.2 Wiring into `LSPClient`

```python
# in mcp/lsp_proxy.py, inside LSPClient
def _on_notification(self, method: str, params: dict) -> None:
    if method == "textDocument/publishDiagnostics":
        uri = params.get("uri")
        diags = params.get("diagnostics") or []
        # Local buffer (fixes the section 3 orphan):
        with self._lock:
            self.pending_diagnostics[uri] = diags
        # Broadcast hook (no-op if disabled):
        if _broadcast_publisher is not None:
            _broadcast_publisher.publish(uri, diags)
```

`_broadcast_publisher` is initialized lazily on first tool call when the env var `LOKI_LSP_BROADCAST=1` is set (see section 8).

### 5.3 Workspace identity

`workspace_id` must be stable across the process lifetime and distinguish worktrees on disk:

```
workspace_id = sha1(abspath(worktree_root))[:10]
worktree_root = first ancestor with .git file (worktree pointer) or .git dir
```

This avoids leaking absolute paths into the event log while letting subscribers map back via a small local cache.

### 5.4 File-relative path normalization

Each event carries `file_relpath` resolved against the **publishing worktree's** root. A subscriber that wants to react to "the same logical file" applies the path against its own worktree root. This is correct for the common case (worktrees of the same repo); it breaks if worktrees rename a file or restructure directories (rare; documented as a known limitation in section 10).

## 6. Dedup and re-plan signal

The brief's requirement: agent A edits `foo.ts` and produces a new diagnostic; agent B was about to do an overlapping edit; B needs to be notified to re-plan.

### 6.1 Dedup key

Diagnostic identity for dedup:

```
key = (workspace_id, file_relpath, range.start.line, range.start.character, severity, msg_hash)
```

This is intentionally stable across LSP republishes of the same diagnostic on every keystroke. The publisher applies it: if the last event for the same key (within the same workspace_id) had identical `range.end` and `message`, the publish is suppressed. Implementation: a small per-publisher LRU keyed by `(file_relpath, key)` of size 256.

Cross-workspace dedup is intentionally *not* applied. If both A and B independently produce the same diagnostic for the same file, both events ship; the subscriber decides whether to coalesce.

### 6.2 Subscriber-side overlap detection

This is what gives B the "re-plan" signal. Pseudocode for a planner-tier agent's inner loop:

```
before each tool_use that edits file F at range R:
    events = lsp_subscribe_diagnostics(
        file_globs=[F],
        since_event_id=my_cursor,
        timeout_s=0.2,   # cheap poll, not block
    )
    for e in events:
        if e.workspace_id == self.workspace_id:
            continue   # my own edit echoing back
        if ranges_overlap(R, e.range) and e.severity == 1:
            yield Replan(reason=f"peer worktree {e.workspace_id} produced error at {e.range}")
    my_cursor = events[-1].event_id if events else my_cursor
```

The MCP tool returns events; whether the agent's prompt instructs it to actually re-plan is a system-prompt change, scoped out of this design doc (it belongs in the v7.7.0 acceptance #5 follow-up).

### 6.3 Cursor persistence

Subscribers persist `my_cursor` to `.loki/state/lsp-cursor-{agent_id}.json` so a session restart resumes correctly. The publisher rotates JSONL files at 5 MB and keeps the last 3; an over-stale cursor that points into a rotated file gets a `{"cursor_reset": true, "events": [...]}` response telling the agent it lost continuity and should re-baseline (call `lsp_get_diagnostics` for its files of interest).

## 7. Failure modes

### 7.1 LSP process crashes

Symptom: `LSPClient.proc.poll() is not None` in `_get_or_spawn_client`. Today the code re-spawns on next call. With broadcast: also publish a synthetic event `{"event_type": "lsp_down", "language": ..., "workspace_id": ...}` so peer worktrees know diagnostics from this workspace are stale until the next `lsp_up` event. Cleanup: on re-spawn success, publish `lsp_up`. Subscribers that filter by severity will not see these events unless they explicitly opt in via a separate event type.

### 7.2 Broadcast channel backs up

The JSONL grows unboundedly if no one consumes. Mitigations:
- **Size-based rotation**: at 5 MB, rename to `diagnostics.jsonl.1`, shift 1 to 2, drop 3. Implemented in the publisher, guarded by a short-held lockfile (`diagnostics.jsonl.rotlock`) to prevent two publishers rotating simultaneously.
- **Time-based GC**: on each publish, with probability 1/1000, scan `.loki/events/lsp/diagnostics.jsonl.*` and delete files older than 24 h.
- **Per-publisher rate cap**: each `DiagnosticPublisher` enforces less than or equal to 50 events/second; excess gets batched with a 100 ms timer and a single coalesced event per (file, severity).
- **Subscriber backpressure**: subscribers reading via `lsp_subscribe_diagnostics` get at most `max_events` per call; if a subscriber is very slow, the rotation may eat its tail. The `cursor_reset` mechanism in section 6.3 handles this gracefully.

### 7.3 Agent times out waiting for events

`lsp_subscribe_diagnostics(timeout_s=5.0)` returns an empty list on timeout. No error. The subscriber polls again next loop iteration. This is the same pattern as `events/bus.py` `subscribe()`.

### 7.4 Disk full / EIO on publish

Publisher catches `OSError` from `open`/`write` and logs to stderr, dropping the event. Diagnostics being best-effort is acceptable; the worst case is "agent B does its overlapping edit and we catch the conflict at merge time," which is the current behavior anyway.

### 7.5 Concurrent writers and reader-during-write

Append-only writes of less than PIPE_BUF (4 KB on Linux/macOS) are atomic per POSIX. Each event line is capped at ~1 KB by the 512-char message truncation. Readers use line-buffered `for line in f:` with a recovery loop: if `json.loads(line)` raises, log and skip the line, advance the cursor past the partial line.

### 7.6 Shared root resolution disagrees across worktrees

If worktree-A finds the parallel marker but worktree-B does not (e.g., spawn script didn't copy `.loki/parallel-root` into B), they publish to different directories and never see each other. Mitigation: `loki doctor` validates `.loki/parallel-root` exists in every worktree in the orchestrator's tracked set; warns on mismatch. Documented in `skills/parallel-workflows.md` change.

### 7.7 Symlink and case-sensitivity quirks across worktrees

macOS case-insensitive default filesystems can produce different `file_relpath` casing for `Foo.ts` vs `foo.ts`. Normalize via `os.path.normcase` at publish time and document the assumption that subscribers run on the same machine (broadcast is single-host in v1).

## 8. Backward compatibility

Default: **opt-in via env var `LOKI_LSP_BROADCAST=1` for v7.7.x, default-on starting v7.8.x**.

Rationale:
- Today's parallel-mode users do not expect cross-worktree diagnostic flow; turning it on by default could change behavior in ways they cannot diagnose (e.g., agent B's "why did you re-plan?" trace points to an event from a different worktree).
- The opt-in flag is set by `spawn-parallel.sh` automatically when it provisions worktrees, so users running parallel mode via the documented entry point get it for free.
- Single-worktree users see no change; the publisher is initialized only when the env var is set, and `lsp_subscribe_diagnostics` returns an empty list with a clean diagnostic message if broadcast is off.

The MCP tool surface is additive: `lsp_subscribe_diagnostics` and `lsp_recent_diagnostics` are new; no existing tool semantics change. The orphan `pending_diagnostics` fix (section 3) is a bug fix and ships as a patch regardless of the broadcast flag.

Migration note for the changelog: any agent prompt that says "use lsp_get_diagnostics to check for errors" continues to work; the new subscribe tool is additive for parallel-mode agents.

## 9. Test plan (no $30 multi-agent runs)

Three layers, all runnable locally and in CI.

### 9.1 Unit tests: `tests/test_lsp_broadcast.py` (pytest)

Coverage:
- `DiagnosticPublisher.publish` dedup LRU: emit same diagnostic twice, assert one event line written.
- Rotation: publish events until file exceeds 5 MB, assert `diagnostics.jsonl.1` exists and primary file is reset.
- Cursor reset: subscriber with a cursor pointing into a rotated file gets `cursor_reset=True`.
- Workspace id stability: same `worktree_root` produces same id; different roots produce different ids.
- Race: 5 threads each calling `publish` 100 times; assert all 500 events present and parseable.

These tests use a **fake LSPClient** that exposes a `inject_notification(method, params)` method. No real LSP binary is spawned.

### 9.2 Subprocess harness: `tests/test-lsp-broadcast.sh` (bash)

Coverage:
- Spawns 5 background `python3 -m mcp.lsp_proxy` processes pointing at the same shared root (a temp dir).
- Each fake-publishes diagnostics on a 100 ms interval for 5 s using a small helper script that imports `DiagnosticPublisher` directly.
- A 6th process subscribes and asserts it sees events from all 5 workspace_ids.
- Kills one publisher mid-stream; asserts a `lsp_down` event arrives.
- Total runtime: less than 15 s. No Claude API calls. No real LSP.

This is the test that would have caught the v7.7.0 acceptance #3 gap, and it costs $0.

### 9.3 Integration test: one worktree, real pyright, two subscriber processes

Smallest realistic end-to-end: a fixture project with a single .py file that has a type error. One publisher process spawns pyright via `LSPClient`, opens the file, waits for diagnostics. Two subscriber processes call `lsp_subscribe_diagnostics(file_globs=["*.py"])` and assert they each see the pyright diagnostic. Validates the section 3 prerequisite (notification reader) end-to-end.

CI cost: ~$0 (no Claude). Wall time: ~10 s (mostly pyright cold start).

### 9.4 What we deliberately do not test in CI

- Five real Claude sessions in five worktrees. Documented as a "release manual test" with a fixture PRD that has a known overlapping-edit hazard between two features. Run before any release that touches the broadcast code, recorded in `tests/manual/lsp-broadcast-real-agents.md`. Cost gate: only run when the broadcast code changed in the release window.

## 10. What won't work / scoped out

Honest list of things this plan deliberately does not solve:

1. **One LSP process serving N worktrees.** The task framed this as item 1; this plan defers it. To do this correctly requires:
   - Investigating per-server `workspaceFolders` behavior in pyright / tsls / gopls / rust-analyzer / jdtls under concurrent edits across roots.
   - A path-rewriting layer that maps tool args from worktree-relative to a canonical root.
   - Solving the divergent-dependency-tree problem (different `node_modules` per worktree). For TypeScript this likely requires running one tsls per `tsconfig.json` root anyway, so the savings are smaller than they look.
   - Recommended only if profiling shows cold-start is a real bottleneck; in practice the LSP processes are long-lived and the cold-start cost amortizes across a session.

2. **Cross-machine broadcast.** Single-host only. Multi-host parallel workflows are not a documented use case; if they become one, replace the file bus with a real pub/sub (NATS, Redis) behind the same `DiagnosticPublisher` interface.

3. **Cross-language diagnostic correlation.** A TS edit that should trigger a Python type check does not happen through LSP; out of scope. If we want this, it lives in a higher-level agent prompt, not the LSP layer.

4. **Worktree file-rename handling.** A diagnostic published as `src/foo.ts` from worktree-A is delivered as `src/foo.ts` to worktree-B even if B has renamed it to `src/bar.ts`. Documented limitation; the subscriber can detect "this file does not exist in my worktree" and discard.

5. **The orphan `pending_diagnostics` code path.** Fixing it is a *prerequisite* (section 3), not a goal of this design. If it ships standalone as a patch before broadcast lands, that is strictly better than today's silent-empty-array behavior.

6. **Replacing `events/bus.py` with a "real" event bus.** Tempting but out of scope. The existing bus is good enough for diagnostic events at the rates we expect (less than or equal to 50/s per publisher x less than or equal to 5 publishers = 250/s, well under what a JSONL append handles).

7. **Notifying about edits that don't yet appear as diagnostics.** "B is about to edit foo.ts" requires a separate pre-flight intent signal (`.loki/signals/EDIT_INTENT_*` per `parallel-workflows.md` section "Inter-Stream Communication"). Out of scope; the subscriber's `ranges_overlap` check covers only the post-edit-diagnostic case.

## 11. File-level work breakdown

New files:
- `mcp/lsp_broadcast.py` -- publisher, subscriber MCP tools, shared-root resolver. ~250 LOC.
- `tests/test_lsp_broadcast.py` -- unit tests with fake LSPClient. ~200 LOC.
- `tests/test-lsp-broadcast.sh` -- 5-publisher subprocess harness. ~80 LOC.
- `tests/manual/lsp-broadcast-real-agents.md` -- manual release test runbook. ~60 LOC.

Modified files:
- `mcp/lsp_proxy.py`:
  - Add notification-reader thread to `LSPClient` (~150 LOC delta).
  - Populate `self.pending_diagnostics` (fixes section 3 orphan).
  - Wire optional `_broadcast_publisher` hook in `_on_notification`.
  - Register the two new MCP tools by importing from `mcp/lsp_broadcast.py`.
- `events/bus.py`:
  - Document that `.loki/events/lsp/` is reserved for LSP diagnostics and is not consumed by the standard `pending/` flow (or move LSP under its own subtype if we later want dashboard surfacing).
- `autonomy/lib/mcp-config.sh`:
  - When `LOKI_LSP_BROADCAST=1` is in env at config-generation time, add the env var to the lsp-proxy server entry so it propagates to the spawned MCP process.
- `skills/parallel-workflows.md`:
  - New section "Cross-worktree LSP diagnostics" describing the contract, the env var, the `.loki/parallel-root` marker, and the subscriber pattern.
- `CHANGELOG.md`:
  - Closes v7.7.0 acceptance criterion #3.

## 12. Open questions for the future planning session

1. Should `workspace_id` include the git branch name? Argument for: easier debugging. Argument against: leaks branch names into events; subscribers should filter by relpath, not branch.
2. Should we surface broadcast events to the dashboard? Probably yes (a small "diagnostics from peer worktrees" panel) but that is a v7.8.x concern.
3. Should `lsp_subscribe_diagnostics` use long-poll or SSE-style streaming? Long-poll is simpler and matches the existing event bus pattern; streaming requires MCP transport changes. Recommend long-poll for v1.
4. Should the publisher emit a heartbeat event every N seconds so subscribers can detect a silent publisher death (vs. "no diagnostics to publish")? Probably yes, 30 s interval, severity=info, file_relpath=null.
5. Are we OK with the silent-skip philosophy if `.loki/parallel-root` is missing? `loki doctor` will warn but the tool itself returns empty. Consistent with the project's "no env var, no flag, no per-language config" philosophy from v7.7.0.

## 13. Acceptance criteria for this work

When this plan is implemented, the following should be true:

1. With `LOKI_LSP_BROADCAST=1` set in two worktrees of the same repo, an edit to `foo.ts` in worktree-A that produces a type error appears as an event in worktree-B's `lsp_subscribe_diagnostics` response within 1 second.
2. The unit test suite in `tests/test_lsp_broadcast.py` runs in less than 5 s and passes 20+ assertions covering publish, dedup, rotation, cursor reset, and concurrent writers.
3. The subprocess harness `tests/test-lsp-broadcast.sh` runs 5 publishers + 1 subscriber and asserts cross-workspace event delivery, in less than 15 s.
4. `lsp_get_diagnostics` returns non-empty diagnostics arrays for a file with real errors (closes the section 3 prerequisite bug).
5. `loki doctor` reports "LSP broadcast: enabled (shared root: ...)" or "LSP broadcast: disabled (set LOKI_LSP_BROADCAST=1)" in the Integrations block.
6. With the flag off, behavior is byte-identical to v7.7.0 (verified by running the existing `tests/test-lsp-proxy.sh` unchanged).
