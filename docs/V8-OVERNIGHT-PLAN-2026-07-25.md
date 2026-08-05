# v8 overnight execution plan (2026-07-25)

Autonomous session. Founder asleep ~8h. Standing authorization: make the
architectural calls, validate everything, commit and push verified increments.

## Governing principles

1. **Already-exists check FIRST on every item.** It has been right 5 times out
   of 5 this session (evidence-in-PR, offline verifier, stuck signals, signing,
   fail-closed SDK). The research corpus is consistently more confident than
   correct.
2. **"Don't overwhelm users" is an architectural constraint, not a preference.**
   Every new env var is user-facing complexity. Prefer: safe default, honest
   degradation, structured event for operators, NO new knob. If the safe
   behavior can be the default, make it the default.
3. **Never mark done what is not verified.** A test that passes against the
   pre-change code proves nothing; every behavioral change gets the
   revert-and-confirm-it-fails treatment.
4. **Gate on the CI verdict line, never the exit code.**
5. **`bun run build` after every `loki-ts/src` edit** - the shipped package runs
   `dist`, not `src`.

## Order (by reversibility, not task number)

| # | Item | Shape | Status |
|---|---|---|---|
| 11 | SDK capability-degradation event | small increment | premise mostly satisfied |
| 10 | Phase-0 runtime-truth audit | docs from source | gates 12 |
| 12 | Flip SDK default | TESTS first, flip only if green | conditional |
| 18 | Typed run journal | MEASURE first | may collapse |
| 20 | First-4-min preview | MEASURE first | may collapse |
| 17 | Workspace isolation | interface + Local adapter | Docker = design only |
| 23 | Helm/RBAC/SSO | real, testable offline | helm lint / kubeval |
| 15 | npm SDK | build fully, DO NOT PUBLISH | founder gate |
| 22 | Managed cloud | design doc only | blocked on P0 results |
| 24 | SWE-bench RESOLUTION | DO NOT RUN | ~$950 spend, deferred |

## Hard stops (will NOT do autonomously)

- **#15 npm publish.** Building the package is in scope; `npm publish` is
  outward-facing and irreversible. "Commit and push" authorized the feature
  branch, not the public registry. The publish command is left for the founder.
- **#24 SWE-bench RESOLUTION run.** 119 pinned instances at
  `LOKI_BUDGET_LIMIT=8` is up to ~$950 of real spend, on a benchmark the
  approved plan already marks DEFERRED by founder decision.
- **Merge to main / publish 8.0.0.** Standing hard founder gate.

## #12 authorization, stated precisely

The approved plan says: do not flip until parity AND recovery tests pass. That
is a CONDITIONAL authorization, so #12's real content is writing those tests
(acceptance #1 SDK-full with the claude binary absent, #7 SIGKILL recovery, #8
resume does not repeat irreversible actions, plus both-route parity). If they
pass, flipping executes the founder's decision. If any fail, do not flip and
name the blocker.

## Findings that reshaped the queue

**#11 is nearly done already.** `autonomous.ts:356 requireModule()` is fail-fast
(a load-bearing module that cannot load is a fatal contract violation, not a
silent stub). `providers.ts:559-640` is fail-closed: no CLI fallback,
`exitCode=1` on throw, and `sawResult ? res.exitCode : 1` so a stream that never
produced a terminal result cannot be counted as success. The SDK path's MAIN
LOOP has no `claude`-binary dependency.

**Scope stated exactly, 2026-07-26.** `providers.ts:570` delegates every
non-mainLoop call back to `claudeProvider()`, which reaches the binary via
`ensureClaudeHelpCache()`. But that is the `LOKI_SDK_MODE=off` path, and
reading it alone to mean "the judge path shells out to claude" is wrong:
under `judges`/`full`, `sdkModeDefaults()` enables all seven `JUDGE_VARS` and
those sites have their own raw-SDK bridges. `completion-council.sh:2910` says
so directly -- the raw-SDK vote path "needs no claude binary" (its precondition
is bun plus the bridge), falling closed to `claude` only on an SDK miss.

So under `LOKI_SDK_MODE=full` BOTH the loop and the judges have binary-free
paths; the residual CLI dependency is off-mode delegation plus the fail-closed
fallback. Pinned by
`loki-ts/tests/runner/acceptance_sdk_binary_absent.test.ts`.

The genuine remaining gap is OBSERVABILITY: an SDK load/stream failure is
written into captured text, not emitted as a structured capability-degradation
event an operator can alert on. That is the increment.
