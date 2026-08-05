# V8 Runtime Truth Audit (Phase 0)

Date: 2026-07-25. Source-verified. Gates the SDK-default flip (task #12).

Method: read the actual code paths, not the comments describing them. Where a
claim concerns the Agent SDK's own capabilities, it is checked against the
primary docs (code.claude.com), not inferred.

## Executive summary

The v8 SDK route is **better engineered than the competitive research assumed**
on the two properties that matter most for trust. After the section-4 correction
(2026-07-25) **no known capability regression blocks the flip** - what remains
is three untested acceptance items. The gating work is TESTS, not a port.

| Property | Status |
|---|---|
| Fail-closed on error | **SOUND** |
| No silent CLI fallback | **SOUND** |
| Module-resolution fail-fast | **SOUND** |
| Rollback escape hatch | **SOUND** |
| Structured degradation event | **ADDED 2026-07-25** |
| Stagnation / done-signal valves | **PORTED 2026-07-24** |
| Session continuity across iterations | **NOT A GAP** (corrected 2026-07-25; opt-in recovery parity only) |
| Acceptance #1 / #7 / #8 | **TESTED 2026-07-26** (28 assertions, each with a verified negative control) |

## 1. Route resolution (verified)

`selectClaudeInvokerKind()` (`loki-ts/src/runner/providers.ts`) is pure over env,
so the rollback path is unit-testable without spawning a process:

1. `LOKI_LEGACY_BASH` truthy -> `legacy`. **The rollback always wins**, even if
   the loop is opted-on or later becomes default-on.
2. else `LOKI_SDK_LOOP` truthy -> `sdk`.
3. else -> `legacy` (default-off; byte-identical to v8 as shipped).

`LOKI_SDK_MODE` normalizes to `off|judges|full` on both routes with a fail-safe:
an unknown value falls back to `off`, so the SDK can never be switched on by a
typo. Mirrored byte-for-byte in `autonomy/lib/sdk-mode.sh` and
`loki-ts/src/runner/sdk_mode.ts`.

## 2. Fail-closed behavior (verified, and stronger than claimed)

The research asserted the SDK path might "silently fall back to the CLI". It
does not. In `providers.ts`:

- The SDK is loaded by a **lazy dynamic import**, so the default-off path never
  pays to load it.
- A load failure (SDK missing, platform binary absent) sets `exitCode = 1`.
  There is no CLI fallback branch to take.
- A thrown `query()` is caught, appends the error to captured text, and leaves
  `exitCode = 1`.
- **`exitCode = res.sawResult ? res.exitCode : 1`** - a stream that never
  produced a terminal result is a FAILED iteration, never counted as success.
  This is the property that stops a broken SDK run from being read as a green
  build.

Module resolution is equally strict. `requireModule()`
(`loki-ts/src/runner/autonomous.ts:356`) throws on an unloadable helper rather
than substituting a stub, and the surrounding comment documents why the previous
stubs were removed: they "degraded SILENTLY to WRONG results rather than safe
no-ops".

**Conclusion: acceptance item #3 (no silent SDK-full fallback to legacy) is
SATISFIED in behavior.** What was missing was observability, addressed below.

## 3. Capability degradation is now observable (added this session)

Before: an SDK load or stream failure existed only as prose inside the captured
output. An operator running unattended had nothing to alert on, and no way to
distinguish "the SDK could not load" from "the model did poor work".

Now: `emitSdkDegradationEvent()` appends a structured record to the SAME
append-only `.loki/events.jsonl` stream the hook events use, with the same
`{type, source, timestamp, payload}` envelope, so every existing consumer picks
it up for free:

```json
{"type":"capability_degraded","source":"sdk_loop","timestamp":"...",
 "payload":{"capability":"sdk_query","fail_closed":true,"reason":"...",
            "tier":"...","model":"...","iteration":"..."}}
```

`fail_closed: true` is stated in the record rather than left for a reader to
assume. Deliberately **no new env var**: this is signal an operator always
wants, and a knob to enable your own error reporting is a knob nobody finds.
Guarded by `loki-ts/tests/runner/sdk_degradation_event.test.ts` (5 tests),
including the load-bearing property that it NEVER throws - a diagnostic that
breaks the run it describes is worse than no diagnostic.

## 4. Session continuity: an OPT-IN recovery gap, NOT a default regression

**CORRECTED 2026-07-25.** The first version of this section called this "THE GAP
that blocks the flip" and claimed the default route "would silently lose
cross-iteration context that the legacy route preserves." **That claim was
false**, and it is recorded here rather than quietly deleted because the way it
was wrong is the same trap this audit exists to catch: it asserted a parity gap
without first checking whether the legacy side was even turned on.

What the source actually says:

- `sessionStampEnabled()` returns false unless `LOKI_SESSION_STAMP=1`
  (`claude_flags.ts:378`). **Default OFF.**
- `resumeSessionEnabled()` returns false unless `LOKI_RESUME_SESSION=1`
  (`claude_flags.ts:452`). **Default OFF.**
- No shipped default sets either to `1` (grep across `*.sh`, `*.ts`, `*.json`,
  `Dockerfile*`, excluding tests: only definitions and comments).
- Decisively: `sessionStampArgv()` emits
  `claudeIterationSessionUuid()` = `uuidv5("${runId}:${iteration}")`
  (`claude_flags.ts:363-372`) - **derived from the iteration number, so a
  DISTINCT id every iteration.** `tests/test-cli-session-v734.sh:11` states the
  same in its own words: "a PER-ITERATION DISTINCT" session id.

A per-iteration distinct `--session-id` is **correlation/tracing metadata, not
conversation continuity.** It gives each iteration its own session rather than
threading one. And `sessionResumeArgv()` is documented at `claude_flags.ts:445`
as "Recovery only, never a per-iteration chain" - one resume on the first call
of a restarted run.

**Therefore: on the default path the legacy `claude -p` route is ALSO stateless
per iteration. The SDK route loses nothing by default, and flipping it does not
regress cross-iteration context.**

The real, much smaller gap: **under opt-in `LOKI_RESUME_SESSION=1`, legacy
performs one recovery resume after a restart and the SDK path does nothing.**
That is opt-in recovery parity, not a default-path capability regression. It
does not block the flip; it is a follow-up for anyone using that knob.

The platform supports it whenever that port is done. Per the primary Agent SDK
docs (code.claude.com/docs/en/agent-sdk/sessions), `query()` accepts
`resume: <session_id>`, `forkSession: true`, and `continue: true`; session ids
are readable from `SDKResultMessage.session_id`.

Two traps for that future port, both load-bearing:

1. **Do not reuse `resumeSessionEnabled()` on the SDK path.** It ends in
   `claudeFlagSupported("--resume")`, which probes the `claude` **binary**.
   Acceptance #1 is "SDK-full works with the binary absent" - reusing that
   predicate makes resume silently unavailable in precisely the scenario the SDK
   exists for. The SDK path needs the env check WITHOUT the CLI probe.
2. **Do not write an SDK `session_id` into `.loki/state/claude-session.json`.**
   `resumeTargetUuid()` reads `claude_session_uuid` and regex-validates it as a
   CLI-stamped uuid; an SDK session id is a different id space from a different
   mechanism. Sharing the field lets a restart hand one route the other's id.

**And the cwd caveat** (docs, verbatim): a `resume` call from a different
directory looks in the wrong place and silently returns a FRESH session rather
than erroring. Any port must pin cwd and assert the resumed id EQUALS the stored
one - a test that only checks "the call did not throw" passes against a port
that starts fresh every time.

## 5. Flip prerequisites (task #12)

The approved plan authorizes the flip conditionally: only once parity AND
recovery tests pass. Current state:

| Prerequisite | Status |
|---|---|
| Stagnation + done-signal valves on TS route | **DONE** (2026-07-24, 10 tests, 9 fail against the pre-port stub) |
| No silent fallback | **DONE** (verified sound; degradation event added) |
| Session continuity parity | **NOT A BLOCKER** (corrected - see section 4; both legacy knobs default OFF and the stamp is per-iteration distinct, so there is no default-path continuity to regress) |
| Acceptance #1 (SDK-full works with `claude` binary absent) | **DONE 2026-07-26** - `loki-ts/tests/runner/acceptance_sdk_binary_absent.test.ts` (9). Scope corrected below. |
| Acceptance #7 (SIGKILL recoverable without corruption) | **DONE 2026-07-26** - `loki-ts/tests/runner/acceptance_sigkill_recovery.test.ts` (10). |
| Acceptance #8 (resume does not repeat irreversible actions) | **DONE 2026-07-26** - `tests/test-acceptance-resume-idempotence.sh` (9, incl. a mutation check). **Naming collision** flagged at `claude_flags.ts:438`: Loki's own checkpoint `--resume` is a different layer from the claude-CLI session resume. #8 is the CHECKPOINT layer, so it was testable now and was never downstream of session continuity. |

### What the three test files established (2026-07-26)

Each has a **verified negative control** - the implementation was temporarily
broken and the test confirmed RED before being committed - because all three
premises already looked satisfied in source, which is precisely the condition
under which a new test passes vacuously and proves nothing.

- **#1, with the scope stated exactly.** The main agentic loop is genuinely
  binary-free: route resolution is pure over env, the SDK loads by lazy dynamic
  import, and no spawn/shell/flag-probe appears anywhere in
  `sdkQueryProvider`'s own body.

  **Two corrections, in opposite directions, both recorded rather than
  quietly fixed.** The `providers.ts:570` delegation IS real: every non-mainLoop
  call goes back to `claudeProvider()`, which reaches the binary via
  `ensureClaudeHelpCache()`. But reading that line alone and concluding "the
  judge path shells out to claude" was ALSO wrong, in the same way section 4's
  original error was wrong: it described one route while a second, enabled by a
  different switch, was sitting next to it.

  `:570` is the **`LOKI_SDK_MODE=off` path**. Under `judges` or `full`,
  `sdkModeDefaults()` turns on all seven `JUDGE_VARS`
  (`LOKI_SDK_COUNCIL_VOTE`, `LOKI_SDK_CODE_REVIEW`, `LOKI_SDK_DONE_RECOG`,
  `LOKI_SDK_COUNCIL_V2`, `LOKI_SDK_VOTER_AGENTS`, `LOKI_SDK_GRILL`,
  `LOKI_SDK_PRD_ENRICH`), and those sites have their own raw-SDK bridges.
  `completion-council.sh:2910` states it directly: the raw-SDK vote path
  "needs no claude binary", and the precondition check is satisfied by
  bun plus the bridge instead. It falls closed to `claude` only on an SDK miss.

  **So: under `LOKI_SDK_MODE=full` both the loop and the judges have
  binary-free paths.** The residual CLI dependency is the `off`-mode
  delegation and the fail-closed fallback, not a hole in SDK-full. The
  delegation boundary is pinned by a test so a future edit cannot silently
  redefine what "SDK-full" means in either direction.
- **#7.** Truncated state is reported `corrupted: true`, never as a clean
  start, and the bad file is preserved for forensics - the same
  empty-vs-invalid trap as the v7.129.5 receipt bug. A state left at `running`
  is correctly treated as a crash and reset rather than resumed, while the
  genuinely resumable statuses (`paused`, `interrupted`, `budget_exceeded`,
  `stopped`) keep their counters. Orphaned `*.tmp.*` files are swept, and a
  RECENT tmp file is deliberately left alone so the sweep cannot race a live
  writer. No test kills a real process: the states a SIGKILL produces are
  constructed directly, so nothing depends on winning a race.
- **#8.** The PR guard keys on REMOTE state (`gh pr list --head --state open`),
  not a local marker - so it survives the case that matters, a resume on a
  fresh container where local `.loki/` is gone. The test simulates exactly that
  wipe and asserts exactly one `gh pr create` across two completion passes;
  the mutation check removes the guard and confirms a duplicate PR appears.

**Recommendation: the test prerequisites for the flip are now MET.** All three
acceptance items are covered with non-vacuous tests, the valves are ported, and
no known capability regression remains. The one scope correction above (judges
still take the CLI route) does not block the flip, because the flip changes the
main loop only - but it does mean "SDK-full runs with no `claude` binary
installed" is not yet true end-to-end, and should not be claimed in user-facing
docs until the judge path is ported too.

The flip itself remains a one-line change whose safety is entirely supplied by
the tests around it, and is left as a deliberate, separately-reviewable commit.

## 6. What this audit deliberately does not claim

This covers the claude-provider SDK path, route resolution, fail-closed
semantics, and session continuity. It does NOT cover: the judge/subcall path in
detail, MCP tool loading under SDK-full, budget/effort propagation, or the
Codex/Cline/Aider adapters. Those remain untriaged and are the natural next
slice.
