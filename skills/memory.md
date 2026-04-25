# Memory Integration (v7.1.0+)

Loki Mode ships two memory layers:

1. **Local memory** (`.loki/memory/`) -- project-scoped, authoritative, versioned
   by git. Always on.
2. **Managed Agents memory** (Anthropic cloud store) -- optional mirror +
   cross-project read. Opt-in behind flags. Filesystem-mounted at
   `/mnt/memory/` inside a Managed Agents session.

Local is the source of truth. Managed is a scoped projection with audit
history and cross-project visibility.

## Flag hierarchy

```
LOKI_MANAGED_AGENTS=false              <- parent (required for any managed path)
  |
  +-- LOKI_MANAGED_MEMORY=false        <- memory shadow-write + REASON augment
  |     |
  |     +-- LOKI_MANAGED_MEMORY_HYDRATE=false  <- session-boot pull from store
  |
  +-- LOKI_EXPERIMENTAL_MANAGED_AGENTS=false   <- umbrella for multiagent (research preview)
        |
        +-- LOKI_EXPERIMENTAL_MANAGED_REVIEW=false    <- code-review council via callable_agents
        +-- LOKI_EXPERIMENTAL_MANAGED_COUNCIL=false   <- completion council via callable_agents
```

**Every child on + parent off is fail-fast (exit 2).** Do not silent-downgrade.

## Schema mapping

Loki's local schemas map 1:1 to paths inside a Managed Agents memory store:

| Local schema (memory/schemas.py) | Store path | Default scope |
|----------------------------------|------------|---------------|
| `EpisodeTrace` | `/episodic/{date}/{task_id}.json` | user read_write |
| `SemanticPattern` | `/patterns/{pattern_id}.json` | org read_only |
| `ProceduralSkill` | `/skills/{skill_id}.json` | org read_only |
| `FrictionPoint` | `/anti_patterns/{id}.json` | org read_only |
| `FailureMode` | `/anti_patterns/{id}.json` | org read_only |

**Never ship a read_write `semantic` store.** Prompt injection into a
read_write shared store poisons every future session.

## How RARV-C uses managed memory

### REASON phase (read augment)

`autonomy/run.sh::retrieve_memory_context` (around line 7865) always runs
local retrieval first. When `LOKI_MANAGED_AGENTS=true` and
`LOKI_MANAGED_MEMORY=true`, it then runs a 5-second subprocess that calls
`python3 -m memory.managed_memory.retrieve --query "$goal"` and appends
any related prior learnings AFTER the local results (local wins on
duplicate paths).

Failures emit a `managed_agents_fallback` event and the harness continues
with local-only augment. Timeouts emit a distinct event and never block
the iteration.

### REFLECT/VERIFY phase (shadow-write)

`autonomy/run.sh::auto_capture_episode` (around line 8110) writes the
episode to `.loki/memory/` first, then reads the `importance` score from
the EpisodeTrace. If `importance >= 0.6` AND both flags on, a background
subprocess runs

```
timeout 15 python3 -m memory.managed_memory.shadow_write --path $episode
```

Non-blocking (`& disown`). On 409 (`content_sha256` precondition
mismatch), the shadow-writer re-reads, merges, retries once, and on final
failure emits a `managed_agents_fallback` event.

### Completion council (augment + verdict)

`autonomy/completion-council.sh::council_should_stop` (line 1359)
optionally augments its prompt with related prior verdicts from the
managed store, and shadow-writes the approved verdict at the write site.
Same flag gates as memory.

### Session-boot hydrate

`autonomy/run.sh::init_loki_dir` (around line 3049) pulls semantic
patterns + skills from the managed store ONCE at session startup when
`LOKI_MANAGED_MEMORY_HYDRATE=true`. Idempotent via
`.loki/managed/hydrate.lock` sentinel. Local wins on conflict.

## Multiagent council (research preview)

When `LOKI_EXPERIMENTAL_MANAGED_REVIEW=true`, `run_code_review()` routes
through `providers/managed.py::run_council(pool, context, timeout_s)`.
Each reviewer runs in its own Managed Agents session thread with isolated
context; tool-confirmation payloads replace the file-polling aggregation
from v6.83.1. Verdicts are still written to the legacy
`.loki/quality/reviews/$id/*.txt` layout so the dashboard reviews panel
keeps working (single-writer invariant).

Same pattern for `LOKI_EXPERIMENTAL_MANAGED_COUNCIL` on completion
council (`council_managed_should_stop` in completion-council.sh).

Both are **research preview**. Expect beta-header churn. Never default on.

## Cross-session learning

With managed memory on, a new project gets access to:
- `.loki/memory/semantic/patterns.json` from prior projects (org store, RO)
- `.loki/memory/skills/*.json` (org store, RO)
- `.loki/memory/anti_patterns/*.json` (org store, RO)

Promotions from user-RW to org-RO are MANUAL only at v7.0.x. Use the
Managed Agents API directly (`memory_stores.memories.create` against the
org store) with human review. An MCP `loki_memory_promote` tool is on
the roadmap but NOT shipped in v7.0.x; do not depend on it. Never
auto-promote.

## PII redaction

MCP tool `loki_memory_redact(pattern, scope="all")` matches a regex
across memory versions and calls `memory_versions.redact(...)` on
matches. Produces a structured audit event. Requires
`LOKI_MANAGED_MEMORY=true`.

## Observability

Single event stream: `.loki/managed/events.ndjson` (append-only,
rotated at 10 MB). Single writer:
`memory/managed_memory/events.py::emit_managed_event`.

Events:
- `managed_memory_retrieve`, `managed_memory_retrieve_empty`
- `managed_memory_shadow_write`, `managed_memory_shadow_write_409`
- `managed_memory_hydrate`, `managed_memory_hydrate_timeout`
- `managed_memory_redact`
- `managed_agents_fallback` (with op + reason + detail)
- `managed_session_created`, `managed_session_thread_created`,
  `managed_session_thread_idle`
- `managed_agent_materialized`

Dashboard endpoints (read-only, view-layer merge):
- `GET /api/managed/events?limit&since&type`
- `GET /api/managed/status`
- `GET /api/managed/memory_versions/:memory_id`

## Honest disclosure: what is NOT tested

- **Live Anthropic Managed Agents API.** Automated CI uses
  `memory/managed_memory/fakes.py` + `FakeMultiagentSession`. A staging
  smoke test with real `ANTHROPIC_API_KEY` + beta access is required
  before any feature leaves the `LOKI_EXPERIMENTAL_*` gate.
- **Multiagent `callable_agents` happy path.** Research preview; beta
  shape may differ.
- **409 precondition merge against a real server.** Covered by fake tests.
- **Cross-project org-store distribution.** Manually seeded stores work;
  auto-promotion heuristic is future work.
- **Long-horizon (multi-hour) citation quality.** Requires real API usage.
- **Beta header rotation behavior.** Header is centralized in
  `memory/managed_memory/_beta.py`; when Anthropic rotates, update once.

## Rollback

- `LOKI_MANAGED_AGENTS=false` (default): every managed path is a no-op.
  Identical to v6.83.1 behavior.
- Per-feature: set the child flag to `false`.
- API unreachable: automatic fallback to local path with a loud event.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ERROR: ... requires LOKI_MANAGED_AGENTS=true` | Set parent flag to true. |
| No managed events in `.loki/managed/events.ndjson` | Check all flags on; check `ANTHROPIC_API_KEY` set; check SDK installed (`pip show anthropic`). |
| 400 on startup beta-header probe | Beta header rotated by Anthropic. Update `memory/managed_memory/_beta.py::BETA_HEADER`. |
| Hydrate runs every iteration instead of once | Sentinel file `.loki/managed/hydrate.lock` missing write permission. |

## References

- `memory/managed_memory/` -- package (sole SDK import site, with `providers/managed.py`)
- `providers/managed.py` -- multiagent session orchestration
- `agents/managed_registry.py` -- lazy agent materialization
- `mcp/managed_tools.py` -- MCP tools (`loki_memory_redact`)
- `CHANGELOG.md` -- per-release honest disclosure

---

**v7.1.0** | Opt-in, additive, rollback-safe. Default behavior unchanged.
