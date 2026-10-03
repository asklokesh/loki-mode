# D61: speed for users (design)

Architect design, 2026-10-02, base fbbd31299, v10.6.6. Design only; nothing below is built unless marked "exists". Build flag `LOKI_SPEED=1` while slices land; it flips to default-on (and the flag is deleted) when slice 17's targets pass. Users never set a flag or write config.

## 1. What the user sees (from the terminal outward)
- First run in a repo: `loki "fix the off-by-one in pager.py"`. Loki prints one start line, then streams stage lines, then the PR:
  `loki: small task, lean path, sonnet, 3 impacted tests, cap $0.50, warm in 0.4s (first run here: maps built in 2.1s)`
  Second and later runs say `warm in 0.1s`. No daemon setup, no prompt, no config: the warm engine starts itself in the background after the first run and is used if alive, ignored if not.
- Big work: `loki ./spec.md` or `loki "add CSV export to api, web and cli"`. Loki prints its decision before spending a token on code:
  `loki: 5 units, 3 in parallel (decomposable: disjoint write sets, 1 shared file serialized), est 6-9 min`
  `loki: live at http://127.0.0.1:57375/g/<group>` (or the Control Plane URL when LOKI_CONTROL_URL is set)
  then a compact unit table repainted every 2s on a TTY (one line per state change otherwise): unit, files, stage, elapsed, tokens.
- When the work does not split: `loki: sequential (reason: units share 4 of 6 files)`. It never forces parallel.
- The end: one PR with a unit table (goal, files, tests, tokens, model per unit), one combined receipt, and a final line `done in 7m12s, 412k tokens (5 units, 1 fix unit), PR <url>`.
- `loki backlog` keeps per-issue parallelism (exists) and shares one slot pool with any issue that decomposes.

## 2. What exists (evidence) and the gap
| Piece | Where | Status |
|---|---|---|
| Lean path (skip Plan and Wall for small tasks with relevant tests) | engine10/sizing.ts:44-46, stages/plan.ts:74-77, stages/wall.ts:145 | exists; gap: only fires when the task names a file (sizing.ts:10 namedFiles) |
| Byte-stable prefix | e10ext/lean_prefix.ts (LOKI_E10_PREFIX=lean) | exists, opt-in; no guard that every stage prompt starts with identical bytes |
| Repo map and test map cached by HEAD^{tree} | engine10/cache.ts, repomap.ts, testmap.ts | exists on disk; rebuilt per process, no in-memory warm copy |
| Impacted tests only | testmap.ts:201 impactedRefs, stages/verify.ts:251 | exists |
| Repo context pack (20 files plus impacted tests) | e10ext/context.ts | exists |
| Scope control (out-of-scope edits reverted, listed NOT PROVEN) | e10ext/scope.ts, e10ext/commit_filter.ts | exists; reusable as a unit's write-set fence |
| Sonnet-then-escalate cascade | sizing.ts:54 cascadeEnabled | exists |
| Cheap-model already-done check on the critical path | already_done.ts:167-182 (wallModel) | exists; cost on the small path not yet measured |
| Per-session child process | session.ts:1-2 (self-respawn through cli.ts) | exists; cold bun start per session |
| Parallel worktree runner | autonomy/lib/backlog.py:180-257 (worktree add -B loki/backlog-N, concurrency, daily cap) | exists; issue refs only, no dependency prep, in-memory queue |
| Worktree dependency prep (`worktree_prep`) | none (grep finds nothing); D51-PHASE-B.md notes fresh worktrees lack node_modules/.venv | MISSING |
| Decomposer, integrator, group run | none | MISSING |
| Local dashboard (SSE, folds .loki/runs) | engine10/dashboard/server.ts (port 57375) | exists; one repo, no group view |
| Control Plane v0 and live shipping | loki-ts/src/commands/control.ts, packages/control-plane/, e10ext/ship_hook.ts | exists, preview (LOKI_CONTROL=1); no group_id column |
| Eval tiers and token capture | eval/loki10/harness.py:53 TIERS includes large, :1157 _v10_tokens; stage-profile.py | exists; 0 lg- tasks, no parallel or sequential arm split |

## 3. Design
**A. Small path (seconds).** (1) Warm engine: the engine10 dashboard process (already a long-lived bun server on 127.0.0.1) also serves a Unix socket `~/.loki/run/engine.sock`; it holds repo map and test map in memory keyed by (repoKey, HEAD^{tree}, dirty-file hash) and runs intake and sizing in-process. The CLI tries the socket for 50ms, else runs cold exactly as today and spawns the daemon detached for next time (fail-safe: no daemon never changes a result). (2) Pre-model overhead budget 2s, measured per stage from argv to the first provider byte and printed as `warm in Xs`. (3) Lean prefix becomes the default with a byte-identity guard. (4) Wider lean eligibility: a task that names no file uses context.ts keyword selection over the cached map, still requiring impacted tests (fail-safe keeps Wall). (5) The already-done model check moves off the critical path: it runs only when deterministic hits exist, concurrently with implement, and cancels implement on a confirmed hit.

**B. Big work (minutes, in parallel).** Decomposer (engine10/decompose.ts, deterministic first): split the task or spec into requirement items (numbered or bulleted lines, headings, issue checklists); map each to a write set via context.ts selection plus module boundaries (top-level dirs, package workspaces, test map ownership); union units whose write sets overlap; mark shared files (lockfiles, package manifests, barrels, CHANGELOG) as serialized. A cheap model (wallModel) may only confirm or merge proposed units against a strict JSON schema; invalid output means the deterministic DAG stands. Decomposability check: parallel only if at least 2 units, write-set overlap ratio below 0.2, no unit reads a symbol another unit creates, and each unit sizes small or normal. Otherwise one sequential run, reason printed. Runner: backlog.py's launch loop generalised to units (same worktree layout, branches loki/unit-<group>-<n>), each unit a full v10 run with `--no-pr`, its write set enforced by scope.ts, its own context pack, cheapest capable model via the cascade (escalation only on a failed check, research section 3). Integrator (engine10/integrate.ts): merge unit branches in DAG order onto loki/group-<id>; conflicts become targeted fix units (conflict hunks only); run the full suite once; failures map back to units through the test map and become fix units (at most 2 rounds); Seal once on the combined diff; one PR. Stacked PRs are a later option, not v1.

**C. Tokens at or below one sequential session.** No transcript sharing between units; each unit gets only its context pack and the shared lean prefix (cache hits across units); per-unit token budget = sequential estimate / units x 1.1, enforced by the existing budget path; deterministic search and test selection, no model-driven exploration in the decomposer. Every run prints tokens; the eval compares against sequential and raw.

**D. Live view.** run.started gains `group_id`, `unit_id`, `deps`; a group event file records the DAG and integrator stages. The dashboard adds /g/<group> (unit grid); the Control Plane runs table gains group_id so the same grid works there.

## 4. Slices (numbered; each ships with its METRICS row)
| # | Goal | File set | Wall check | Budget | Tier |
|---|---|---|---|---|---|
| 1 | Pre-model stage timer: argv to first provider byte, per stage, in run.completed data and the start line | engine10/supervisor.ts, engine10/output.ts, tests engine10/premodel_timing.test.ts | test asserts the timing fields exist and sum within 50ms of the span; stage-profile.py prints a pre_model column | 30m | MEDIUM |
| 2 | Lean prefix default plus byte-identity guard across implement, fix, wall, plan prompts | e10ext/lean_prefix.ts, engine10/stages/implement.ts, stages/fix.ts, tests e10ext/prefix_identity.test.ts | guard fails when any stage prompt's first 200 bytes differ; second run shows cache_read tokens over 0 in the cost event | 30m | MEDIUM |
| 3 | Lean eligibility without a named file (context.ts selection), fail-safe to Wall | engine10/sizing.ts, tests engine10/sizing_lean.test.ts | fixtures: unnamed-file small task goes lean only when impacted tests exist; no-runner repo stays wall | 30m | MEDIUM |
| 4 | Already-done check off the critical path (deterministic hits gate it, runs concurrent with implement) | engine10/already_done.ts, engine10/stages/intake.ts, tests already_done.test.ts | no-hit task makes zero cheap-model calls; augmentiq #52 fixture still ALREADY_SATISFIED | 30m | HIGH |
| 5 | Warm engine socket in the dashboard daemon: in-memory maps keyed by tree plus dirty hash | engine10/dashboard/server.ts, new engine10/warm.ts, tests engine10/warm.test.ts | warm intake under 300ms on the fixture repo; dirty edit invalidates; daemon killed mid-run gives the same verdict cold | 30m | MEDIUM |
| 6 | CLI client: 50ms socket try, cold fallback, detached daemon start after first run, `warm in Xs` text | engine10/cli.ts, new engine10/warm_client.ts, tests warm_client.test.ts | no daemon: identical events to today; LOKI_NO_BROWSER honoured; no test binds 57374-57399 | 30m | MEDIUM |
| 7 | Worktree dependency prep: APFS/reflink clone of node_modules, .venv reuse, else install | new autonomy/lib/worktree_prep.py, tests/test-worktree-prep.sh | fresh worktree runs the fixture's tests with no network; copy-on-write used on darwin | 30m | MEDIUM |
| 8 | Decomposer, deterministic DAG (items, write sets, union on overlap, shared files serialized) | new engine10/decompose.ts, tests engine10/decompose.test.ts | 6 fixture specs: expected unit count and write sets; same input gives byte-identical DAG | 30m | MEDIUM |
| 9 | Decomposability check plus optional cheap-model confirm under a strict schema | engine10/decompose.ts (check fn only after 8 merges), tests decompose_check.test.ts | sequential fixtures return sequential with reason; malformed model JSON keeps the deterministic DAG | 30m | MEDIUM |
| 10 | Unit runner: backlog.py launch loop accepts a DAG, branches loki/unit-<g>-<n>, deps respected, one slot pool shared with issues | autonomy/lib/backlog.py, tests/test-backlog-units.sh | LOKI_BACKLOG_LAUNCHER stub: max concurrency never exceeded, dependent unit starts only after its parent passes | 30m | MEDIUM |
| 11 | Unit run mode: write set as scope fence, per-unit context pack and token budget, no transcript in | e10ext/scope.ts, e10ext/context.ts, tests e10ext/unit_mode.test.ts | an edit outside the write set is reverted and listed NOT PROVEN; brief contains only pack files | 30m | HIGH |
| 12 | Integrator merge and fix units (conflict hunks, failing tests mapped to units, 2 rounds max) | new engine10/integrate.ts, tests engine10/integrate.test.ts | fixture with one planted conflict and one cross-unit failure ends VERIFIED with exactly 2 fix units | 30m | HIGH |
| 13 | One Seal and combined receipt (per-unit sub-receipts) plus PR body unit table | engine10/stages/seal.ts, engine10/types.ts, engine10/pr_body.ts, tests seal_group.test.ts | `loki verify` passes on the combined receipt; tampering one unit's events fails it | 30m (60m review) | HIGH |
| 14 | Group events and terminal unit table (TTY repaint 2s, plain lines otherwise) | engine10/events.ts, engine10/output.ts, tests output_group.test.ts | snapshot tests for TTY and non-TTY; validateEnvelope accepts group fields | 30m | MEDIUM |
| 15 | Live grid: dashboard /g/<group> and Control Plane group_id column | engine10/dashboard/page.ts, packages/control-plane/src/server/runs.ts, packages/control-plane/src/db/, tests | ingesting a 3-unit fixture shows 3 rows with stage and elapsed; missing data says "no data ingested" | 30m | MEDIUM |
| 16 | Route `loki "<task>"` and `loki <file>` through decomposer behind LOKI_SPEED | engine10/cli.ts (route only), engine10/supervisor.ts (group entry), tests route_group.test.ts | flag off: byte-identical behaviour; flag on: small task never decomposes | 30m | HIGH |
| 17 | Speed eval tier: 8 spd- tasks (4 decomposable, 4 sequential by design), arms v10-parallel, v10-seq, raw-claude, tokens per completed for every arm | eval/loki10/tasks/spd-*, eval/loki10/harness.py, eval/loki10/summarize, eval/loki10/test-harness.sh | D38 provenance check passes; summarize prints wall, completion, tokens per arm; a capped arm is never completed | 30m x2 (tasks, harness) | MEDIUM |
| 18 | METRICS D61 section and the flag flip decision | docs/v10/METRICS.md | rows cite results.jsonl paths; losses shown; flip only if section 5 targets hold | 15m | LOW |

Order: 1, 2, 7, 8 start now (disjoint files); 3-6 and 9-11 next; 12-16 after 8-11; 17 in parallel from the start; 18 last. HIGH slices get opus reviewers (D12).

## 5. Targets (measured on the eval, never claimed)
- A. Small tier (29 tasks): Loki p50 time to PR at or below raw `claude -p` (39s baseline, METRICS gate report) on the same model; tokens per completed at or below raw; pre-model overhead p50 under 2s warm. Losses published, including the D50 sonnet loss.
- B. Speed tier (authored spd- tasks, D67): on decomposable tasks, parallel wall time at most 0.5x sequential with completion not lower; on sequential-by-design tasks the check must choose sequential (a parallel run there counts as a loss).
- C. Parallel total tokens at or below v10-seq on the same task; report tokens per completed task for all three arms.
- D. Every slice adds its METRICS row (what changed, command, result file, exit code). Nothing flips to default on a fixture result alone (feedback: fixture-green is not verification).
- E. The `LOKI_SPEED` default flips only if 5 B and 5 C hold on the speed tier AND, on the real medium pub- tasks (plus any D34 large tasks on main), `LOKI_SPEED=1` shows completion not lower and p50 wall and tokens per completed not worse than `LOKI_SPEED=0`, at 2 runs per arm.

## 6. Risks and non-goals
- Research section 4: parallel lost 39-70% on sequential work and multi-agent runs cost about 15x tokens. Defence: conservative check, no transcript sharing, single writer per file, one central integrator.
- Warm daemon must never be load-bearing: cold path stays the reference; slice 6 asserts identical events.
- Not in v1: stacked PRs, cross-repo groups (D51 Phase B), remote runners.

## Slice 2 status: stage prefix (LOKI_SPEED=1)

With `LOKI_SPEED=1` (default off), the implement, fix, wall and plan stage prompts all begin with the same fixed block (`STAGE_PREFIX` in `loki-ts/src/e10ext/lean_prefix.ts`), so the provider prompt cache can reuse it across stages. With the flag off, prompts are unchanged byte for byte. `loki-ts/tests/e10ext/prefix_identity.test.ts` asserts the first 200 bytes match across stages and that flag-off output is unprefixed.
