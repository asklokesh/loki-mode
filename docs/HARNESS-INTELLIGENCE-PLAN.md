# Harness Intelligence Plan (features 5-8)

Lane: LOKI-HARNESS-INTELLIGENCE-69. Status: plan + MVP implemented, unreleased.

## Preconditions, stated honestly

**AGENTS.md is not present in this repository.** Verified with
`find . -name AGENTS.md -not -path "*/node_modules/*"` -> no results. The binding
instruction set used for this work is `CLAUDE.md` (repo root) plus the global
`~/.claude/CLAUDE.md`. If an AGENTS.md is expected to exist, this plan needs
re-review against it.

**Feature numbering is taken from the directive, not from an in-repo backlog.**
No numbered backlog entry for features 5-8 was found; `docs/V8-MAJOR-RELEASE-PLAN.md`
numbers its harness-intelligence items `3a`-`3d` (all shipped in v8.0.0). The
mapping used here comes from the approved decomposition in the directive:

| # | Feature | Module |
|---|---------|--------|
| 5 | Deterministic task-class -> capability-tier router | `loki-ts/src/runner/capability_router.ts` |
| 6 | Local evidence-backed repository profile | `loki-ts/src/runner/repo_profile.ts` |
| 7 | Parallel execution manifest | `loki-ts/src/runner/exec_manifest.ts` |
| 8 | Deterministic recovery policy | `loki-ts/src/runner/recovery_policy.ts` |

## The binding architectural constraint: parity is fixture-locked

`loki-ts/tests/parity/build_prompt.test.ts` asserts **60 SHA-256 byte-exact
fixtures** over `buildPrompt()`. Each fixture supplies its own env object
(`const env = { ...fx.env }`), so any new env var is *absent* during parity runs.

This makes default-off gating an architectural requirement, not a preference:

> **Every one of the four modules reads its flag first and returns the
> identity/passthrough value when the flag is unset.**

This is the existing codebase idiom, already used by `tierRouteModel`
(`loki-ts/src/providers/claude_flags.ts:84`):

```ts
if (process.env["LOKI_TIER_ROUTING"] !== "1") return model;
```

Consequence: with all four flags unset, `buildPrompt()` output is byte-identical,
model resolution is byte-identical, and the bash route is untouched. No bash
mirror obligation is incurred, because no default-path behavior changes.

## Ownership boundaries (exact)

Deliberately narrow, to keep `autonomy/run.sh` collision-free. Each module is a
new file with a small pure-function interface; none of them edit `run.sh`.

### Feature 5 - capability router owns model identity

`capability_router.ts` is **the only module that may emit a provider/model ID.**

- Consumes `getRarvTier()` (`rarv.ts:81`) for the session/RARV tier.
- Reuses `envPinned()` semantics from `claude_flags.ts` for explicit overrides.
- Precedence, highest first: **explicit model override** (`LOKI_CLAUDE_MODEL_*` /
  `LOKI_MODEL_*`) > **session ceiling** (`LOKI_SESSION_MODEL` pin) > task-class
  routing > passthrough.
- The session ceiling is a *ceiling*: routing may move down from it, never up.
- Recovery (feature 8) may request only a **tier**; it never names a model.

### Feature 6 - repository profile owns learned/profile state

- Writes `.loki/profile/repo-profile.json` via `lokiDir()` (`util/paths.ts:47`)
  and `atomicWriteFileSync` (`state.ts:208`).
- Record carries a **content hash** (over the evidence inputs) and a
  **freshness** timestamp. A profile whose hash no longer matches, or that is
  older than the TTL, is stale and is not injected.
- **Namespace/privacy:** the profile is namespaced per repository, and only
  evidence-backed *facts derived from files in the repo* are recorded. No
  absolute host paths, no environment values, no secrets.
- **Bounded injection:** the prompt fragment is hard-capped in characters. An
  over-cap profile is truncated, never injected whole.

### Feature 7 - execution manifest owns worktree/result validation

- Declares streams with **acceptance criteria**, **non-overlapping path scopes**,
  a **base SHA**, and exactly **one integration owner**.
- Overlapping path scopes are **serialized**, not run in parallel.
- A stream result whose base SHA no longer matches HEAD is **rejected as stale**.
- **Reads** the repo-profile snapshot; **never writes** learned memory. This
  matters because `create_worktree` (`autonomy/run.sh:5205`) does `cp -r .loki`
  into each worktree, so a worktree-local write would fork the profile per
  stream. The profile is read-only from the parent.
- Recovery does **not** own merges; the manifest's integration owner does.

### Feature 8 - recovery policy owns failure -> action mapping

Builds on the seams that already exist:
- `classifyFailure()` (`retry_class.ts:80`) for provider-wire failure classes.
- `LAST_ERROR.json` (schema at `autonomy/run.sh:1800`) for the current failure.
- The append-only bounded archive written by `_loki_archive_last_error`
  (`autonomy/run.sh:1845`, capped at 50 entries) is **the repeated-signature
  circuit-breaker input.** It already exists; recovery reads it.

Mapping (deterministic, table-driven):

| Classified failure | Action |
|---|---|
| auth / unknown model / bad request / quota | `stop` (no retry) |
| transient (rate limit, network, 5xx) | `retry` under caps |
| compile / test failure | `revise` |
| corrupted working tree | `checkpoint_rollback` |
| provider unavailable | `failover` (tier request only) |
| caps exhausted / repeated signature | `escalate` then `stop` |

Caps: max attempts, max wall-clock seconds, max cost. Any cap exceeded -> escalate.

**Hazard, load-bearing.** `retry_class.ts` carries a long comment explaining that
the text it classifies is *the agent's entire 64KB captured output*, not a provider
error envelope; patterns matching ordinary application vocabulary previously fired
on benign output and killed healthy builds. Compile failures are exactly that
category (an agent that builds a compiler test emits the trigger text). Therefore:

> **Compile classification is driven by a build exit code / build-command capture,
> never by a regex over agent prose.**

## Rollout flags (all default OFF)

| Flag | Feature | Unset behavior |
|---|---|---|
| `LOKI_CAPABILITY_ROUTER=1` | 5 | passthrough: returned model unchanged |
| `LOKI_REPO_PROFILE=1` | 6 | no profile read, no prompt injection |
| `LOKI_EXEC_MANIFEST=1` | 7 | no manifest planned or validated |
| `LOKI_RECOVERY_POLICY=1` | 8 | existing `shouldStopRetrying` behavior verbatim |

Cap overrides (only meaningful when feature 8 is on):
`LOKI_RECOVERY_MAX_ATTEMPTS` (3), `LOKI_RECOVERY_MAX_SECONDS` (1800),
`LOKI_RECOVERY_MAX_COST` (unset = uncapped), `LOKI_RECOVERY_SIGNATURE_THRESHOLD` (3).

Profile knobs: `LOKI_REPO_PROFILE_TTL_SECONDS` (86400),
`LOKI_REPO_PROFILE_MAX_CHARS` (2000).

## Acceptance

1. With all flags unset, `bun test tests/parity/` stays 60/60 byte-exact.
2. Override precedence: an explicit `LOKI_CLAUDE_MODEL_PLANNING` survives routing.
3. Session ceiling is never exceeded upward by task-class routing.
4. A profile with a mismatched content hash or expired TTL is not injected.
5. Profile injection is bounded to `LOKI_REPO_PROFILE_MAX_CHARS`.
6. Overlapping path scopes serialize; a stale base SHA is rejected.
7. An auth failure produces `stop` with zero retries.
8. A transient failure produces `retry` while under caps.
9. A compile failure produces `revise`.
10. A repeated failure signature at threshold produces `stop`.
11. State artifacts are truthful: no artifact claims an action that did not run.

## Migration and recovery

- **Migration: none required.** All four features are additive and default-off.
  An existing `.loki/` directory needs no change; a missing `.loki/profile/`
  is created on first write when feature 6 is enabled.
- **Forward compatibility:** every persisted record carries a `schema_version`.
  A record with an unrecognized `schema_version` is treated as absent, never as
  an error, so an older binary reading a newer artifact degrades to default-off
  behavior rather than crashing.
- **Recovery from corrupt state:** an unparseable profile / manifest / recovery
  artifact is treated as absent. Delete `.loki/profile/` or `.loki/manifest/` to
  reset; nothing else depends on them.
- **Rollback:** unset the flag. No persisted state needs cleanup, because no
  default path reads these artifacts.

## What is WIRED vs what ships as a SEAM

Stated explicitly, because an unstated seam reported as a feature is not honest.

| # | Module | Status |
|---|---|---|
| 8 | recovery policy | **WIRED.** `autonomy`'s retry branch calls `decideRecovery` (`loki-ts/src/runner/autonomous.ts:878`), replacing the direct `shouldStopRetrying` call. Default-off delegates to it verbatim. |
| 5 | capability router | **SEAM.** Exercised by feature 8's `failover` tier request; no call site yet resolves a dispatch model through it. |
| 6 | repository profile | **SEAM.** `buildProfile()` never self-triggers, so nothing builds a profile in a live run yet. Trigger belongs at run start, next to the existing memory-context assembly in `build_prompt`. |
| 7 | execution manifest | **SEAM.** Planning/validation are pure functions; the parallel path (`create_worktree`, `autonomy/run.sh:5205`) does not consult them yet. |

The vertical slice is coherent rather than four demos: feature 8 is live on the
real retry path, and its `failover` action requests a tier that feature 5 owns
resolving. The remaining call sites are deliberately deferred, not forgotten.

## Integration order

1. Feature 5 (router) - no dependencies.
2. Feature 6 (profile) - independent; only feature 7 reads its snapshot.
3. Feature 8 (recovery) - depends on 5 for tier-request resolution.
4. Feature 7 (manifest) - reads 6's snapshot, and uses 8's classification for
   stream-level failures.

## Non-goals for this MVP

- No provider network calls anywhere in these modules.
- No version bump, no release, no commit, no push.
- No edits to `autonomy/run.sh` (collision avoidance is the point).
- No automatic merge behavior; the manifest records an integration owner and
  validates results, and a human or the existing merge path performs merges.
