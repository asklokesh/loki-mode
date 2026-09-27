# Loki 10 engine (ENGINE.md)

Status: architecture and slice cut for CEO directive D29 (docs/v10/DECISIONS.md:232). Cut at 2026-09-27T21:50Z. It ships only behind `LOKI_ENGINE=v10` and only adds code: with the variable unset, every existing command follows exactly the path it follows today.

## Goal and release gate

The goal is to finish real tasks the way `claude -p` does, then add proof. The gate (D29), published in full with misses:
- At least 25 tasks with hidden tests.
- v10 completion at or above raw `claude -p` at the same model and budget.
- Time to PR: p50 5 minutes or less, p90 10 minutes or less.
- Cost per completed task at or below raw Claude Code.

If the gate is not met by 03:00 UTC, v10.0.0 ships with legacy as the default and v10 opt-in, and the measured gap is stated.

## Measured stage times

Source: docs/v10/ENGINE-MEASURE.md. This is a read-only measurement of four real runs from their own logs. Every duration comes from a logged timestamp; rows marked (inferred) come from gaps between logged events.

| Run | Wall time | Tasks completed |
|---|---|---|
| R1 augmentiq #52 "add a search bar" | 73.7+ min, still running at 21:46:12Z | 0 |
| R2 anonima | 20.5 min | 1 (reached COMPLETED although code review returned fail) |
| R3 lokimode-anthropic, empty PRD | 6.0+ min, log stops mid provider call | 0 |
| R4 fizzbuzz toy | 3.8 min | 1 |

### Where the minutes go (minutes, logged durations only)

| Stage | R1 augmentiq #52 | R2 anonima | R3 lokimode | R4 fizzbuzz |
|---|---|---|---|---|
| Boot, intake, spec interrogation, PRD parsing | 1.3 | 0.5 | 0.6 | 0.3 |
| Agent provider calls | 3.9 (iterations 1-2) + 57.7+ (iteration 3, still running) | 3.9 | 5.4+ (cut off) | 0.6 |
| Of which: agent running the full E2E suite inside iteration 3 | about 41 (17:05-17:46 EDT, inferred from log file times) | not measured | not measured | not measured |
| App runner / docker | 1.8 | 0 | 0 | 0 |
| Gates (static through LSP) plus unlabelled gaps | 2.7 | 0.1 | 0 | 0 |
| Code review | 0.6 | 4.4 | 0 | 0.8 |
| Doc generation | 5.0 (timed out at 300s) | 4.3 | 0 | 0 |
| Checklist, evidence gate, council | 0.6 (council never voted) | 7.2 | 0 | 1.8 |
| Total wall time | 73.7+ | 20.5 | 6.0+ | 3.8 |

The agent's share of wall time, where the run finished: R2 19% (234s of 1231s), R4 15% (35s of 228s). The rest is harness stages around the agent.

### Five proven causes of non-completion (R1)

1. The app runner's docker invocation fails ("docker: unknown command: docker compose", then "unknown shorthand flag: 'd' in -d") while the containers report healthy. So the evidence gate records app_boot_failed (metrics/trust-events.jsonl 20:45:21Z; app-runner/state.json crash_count 5).
2. A secret-leak match in the changed file SETUP.md blocks completion ("Evidence gate BLOCKED: a secret/credential was detected in the changed files").
3. The test gate finds no test runner ("no test runner detected, recording inconclusive"; tests_ok=inconclusive runner=none), while the agent's own runs show pytest 2847 passed and vitest 1552 passed.
4. Code review refuses a 431361-byte context (the committed USAGE.md, TESTING.md and SETUP.md). Completion is then rejected "because code review is BLOCKED (Critical/High findings)" although no review ran.
5. Iteration 3 is one provider call with no time limit and no progress events. The last events.jsonl entry is 20:48:28Z iteration_start 3, and dashboard-state.json still shows iteration 0 and council total_votes 0 at 21:45:53Z. Inside it the agent drifted into the unrelated full E2E suite at 94-100% CPU and killed processes with pkill -f and kill -9.

Also: the feature already existed before the run. Iteration 1 said "The search feature already appears fully built across many prior commits", and the gates rejected both the iteration 1 and iteration 2 completion claims.

### Where each finding is handled in v10

| Finding | Stage | Mechanism |
|---|---|---|
| Feature already existed; correct claims were rejected and the run looped | Intake, Wall, Implement, Verify | Intake checks deterministically whether the issue is closed or a linked PR is merged, and exits with an ALREADY_SATISFIED receipt. From wave 2, Wall tests run on the base tree first: all green means ALREADY_SATISFIED, and Implement is skipped. The implementer can print `LOKI_ALREADY_DONE: <evidence>`: Verify then runs the impacted and Wall tests on the unchanged tree. Green seals ALREADY_SATISFIED with no PR and no second session; red seals FAILED with the reason. |
| Cause 5: 57 silent minutes | Implement | Each session runs in its own process group with a hard kill at `LOKI_E10_IMPLEMENT_KILL_S` (default 480s). A heartbeat event goes out every 60s with `git diff --shortstat`. The 15-minute run cap always wins. |
| Cause 5: the agent ran the full E2E suite and killed processes | Implement | The brief forbids full-suite and e2e runs and process kills, and names the impacted tests it may run. For Claude, `LOKI_HOST_GUARD=1` loads autonomy/hooks/validate-bash.sh, which blocks kill, pkill and killall (validate-bash.sh:91-93). For other providers, "process-kill blocking not enforced (provider has no PreToolUse hook)" goes on the NOT PROVEN list. |
| Cause 3: runner=none while pytest and vitest passed | Intake (test map) | testmap.ts detects pytest, vitest, jest, npm scripts, bun test, go test and cargo test from real files. A fixture test covers a mixed pytest plus vitest repo. |
| Cause 1 and R2: harness stages took 81% of wall time | Fast path | No PRD, spec interrogation, doc generation, app runner or council on the fast path. App boot and council run in async Deep verify. |
| Cause 4: refused review reported as a blocking finding | Deep verify | The review context excludes generated docs. A refused or oversized check is reported as NOT PROVEN, never as a finding. |
| Cause 2: secret match silently blocked completion | Deep verify | The secret scan (autonomy/lib/secret-scan.sh) runs on changed files after the PR. A match turns the `loki/deep-verify` check red and names file:line. The implementer brief forbids writing docs the task did not ask for. |

## Architecture

### Module layout

All engine code lives in `loki-ts/src/engine10/`, capped at 5,000 lines of TypeScript, enforced by `loki-ts/tests/engine10/budget.test.ts`. Tests live in `loki-ts/tests/engine10/`, and each slice owns its own `fixtures/<topic>/` subdirectory. Only one bash file is added (two once the GitLab pusher lands).

| Path | Role | Approx. lines |
|---|---|---|
| engine10/types.ts | Stage interface, RunContext, Verdict, budgets | 120 |
| engine10/events.ts | Event schema, append, read, fold, tail | 250 |
| engine10/machine.ts | The one state machine: stage table, deadlines, resume, optional-module loader | 300 |
| engine10/supervisor.ts | Credentialed parent: pins origin, spawns worker, single log writer, tamper check, PR step, deep spawn | 280 |
| engine10/worker.ts | Worker with tokens withheld; runs Intake through Seal and streams events on stdout | 120 |
| engine10/session.ts | One provider session in its own process group, heartbeat, cost harvest | 220 |
| engine10/cost.ts | Reads result-cost files; unknown means null, never 0 | 80 |
| engine10/fetch_issue.ts | Issue fetch child that wraps autonomy/issue-providers.sh | 80 |
| engine10/repomap.ts | File list plus top-level symbols | 200 |
| engine10/testmap.ts | Runner detection and the impacted-test map | 260 |
| engine10/cache.ts | Per-repo cache keyed by tree hash | 140 |
| engine10/failures.ts | Parses runner output into grouped failure reasons | 160 |
| engine10/stages/intake.ts, plan.ts, wall.ts, implement.ts, verify.ts, fix.ts, seal.ts, pr.ts, deep.ts | One file per stage | 120 to 260 each |
| engine10/output.ts, eta.ts | Live stage lines, heartbeat line, 5-line summary, ETA | 200, 100 |
| engine10/status.ts, verify_cmd.ts | `loki status`, `loki verify` | 120, 140 |
| engine10/pr_body.ts | Honest PR body for DRAFT and final PRs | 120 |
| engine10/escalate.ts | `--deep` and logged auto-escalation | 80 |
| engine10/cli.ts | engine10 subcommand router | 150 |
| engine10/dashboard/server.ts, page.ts | SSE dashboard; HTML inlined as a TS string so dist bundles it | 200, 250 |
| engine10/adapters/types.ts, index.ts, github.ts, gitlab.ts, jira.ts, slack.ts | One adapter interface and its adapters | 60 to 120 each |
| autonomy/lib/engine10-push.sh | Credentialed push, PR, comment and status child | 120 |
| autonomy/lib/engine10-push-gitlab.sh | Credentialed GitLab push and merge request (wave 3) | 120 |

**Optional-module rule.** This rule keeps later waves free of edits to wave-1 files. `machine.ts` exports `optional(path)`, a dynamic import that returns null when the file is absent. Plan, Wall, fix rounds, deep verify, cache, ETA, the PR body, escalation and the adapters are all loaded this way. When a stage module is missing, the machine emits `stage.skipped` with `data.reason: "module absent"` and continues.

### Process topology (Rule of Two)

**P0 supervisor.** Started by `loki "<task>"` and running `engine10/supervisor.ts`.
- Holds the operator's environment, including GitHub credentials.
- Never runs an LLM and never parses issue text.
- At start, before any provider runs, it:
  - generates the run id `e10-<yyyymmddThhmmssZ>-<4 hex>` and the branch `loki/<run-id>`;
  - reads the base sha, and the pinned origin with `git config --get remote.origin.url`;
  - adds `.loki/` to `.git/info/exclude`.
- These values stay in supervisor memory. They reach the pusher only through argv and env, never by reading the log back.

**P1 fetch child.** Credentialed and deterministic. Runs `bash -c 'source autonomy/issue-providers.sh; fetch_issue "$1"'` (issue-providers.sh:404) and writes normalized JSON to `.loki/runs/<id>/issue.json`, then exits. No LLM ever runs with credentials.

**P2 worker.** Runs `engine10 worker <run-id>`.
- Its environment is a copy of the supervisor's, passed through `withholdGithubTokens(copy)` (loki-ts/src/runner/github_token.ts:183). The function mutates the object it is given, so calling it on the supervisor's own env would strip the credentials the PR child needs; that is why it gets a copy.
- Runs Intake, Plan and Wall, Implement, Verify, fix rounds, commit, then Seal.
- Writes events as JSON lines on stdout; the supervisor is the only writer of events.jsonl. Worker stderr goes to `.loki/runs/<id>/worker.log`.

**P3 session groups.** Each provider session is a detached child of the worker (its own process group) and calls the unchanged `resolveProvider(name).invoke(...)`. The stage limit or the run cap kills the whole group: SIGTERM, then SIGKILL after 2s. Group kill is needed because util/shell.ts:87 kills only the direct child, and the E-00 orphan shows what that leaves behind.

**P4 push child.** Runs `bash autonomy/lib/engine10-push.sh pr <repo-dir> <branch> <title> <body-file> <draft:0|1>`, with `_LOKI_ORIGIN_PINNED=1` and `_LOKI_PINNED_ORIGIN=<pinned>` passed from supervisor memory.
- It extracts and sources the run.sh region from `^_LOKI_WITHHELD_TOKENS=""$` (autonomy/run.sh:5517) through the closing brace of `_loki_withhold_github_tokens` (run.sh:5951-5992). This uses the same awk anchors as tests/test-trusted-push-agent-config.sh, with `log_warn` and `log_info` stubbed.
- It then calls `_loki_trusted_push _loki_with_github_tokens <dir> <branch>` (run.sh:5901). With `_LOKI_WITHHELD_TOKENS` empty, `_loki_with_github_tokens` just runs the command.
- It uses `create_session_pr`'s check-before-create (`gh pr list --head`, run.sh:11287) through `_loki_run_neutral` (run.sh:5883), then `gh pr create [--draft]`, then sets commit status `loki/deep-verify=pending`.
- The same script offers `comment <run-id> <pr-url> <file>` and `status <sha> <state> <description>`.

**P5 deep supervisor, P6 deep worker, P7 publish child.** After the PR, P0 spawns `engine10 deep-supervise <run-id>` detached and exits.
- The deep supervisor holds credentials and spawns a deep worker with tokens withheld to run the checks. It then publishes through the P4 script (`comment`, `status`).
- Repo code (the full suite, app boot) only ever runs without a token.

**Tamper check.** The supervisor keeps a running sha256 of the bytes it appended to events.jsonl. After every `session.ended` and before the PR step, it rehashes the file. On mismatch it emits `tamper.detected`, adds "event log modified outside the engine" to NOT PROVEN, and does not push.

**Resume.** On resume the supervisor re-reads the origin from git config and compares it with `run.started.data.origin`. A mismatch refuses the push (fail closed).

**Residual.** An agent can write both the git config and the log before a resume. Only `_loki_trusted_push`'s literal github.com check still holds then. This goes in the receipt's NOT PROVEN list when the run was resumed.

**Guards and tests that must stay green (not modified by any slice):**
- tests/test-trusted-push-agent-config.sh
- tests/test-gh-withhold-nested.sh
- tests/moat/p9-rule-of-two.sh
- loki-ts/tests/runner/github_token_withheld.test.ts
- tests/test-issue-to-pr-action.sh
- tests/test-pre-push-hook.sh
- tests/test-branch-lifecycle.sh

### The state machine

```
INTAKE ──> { PLAN || WALL } ──> IMPLEMENT ──> VERIFY ──(fail, rounds<2)──> FIX ──> VERIFY
                                    │            │
                                    │            └─(pass or rounds exhausted)──> COMMIT ──> SEAL ──> PR ──> DEEP (async)
                                    ├─ LOKI_ALREADY_DONE ──> VERIFY(no diff) ──> SEAL (ALREADY_SATISFIED, no PR)
                                    └─ LOKI_SPEC_CONFLICT ──> SEAL (SPEC_CONFLICT; DRAFT PR if a diff exists)
any stage at the cap ──> abort (group kill) ──> COMMIT ──> SEAL (PARTIAL) ──> DRAFT PR
```

Stage budgets. The target feeds the ETA; the limit kills the stage.

| Stage | Target | Limit | Runs in |
|---|---|---|---|
| intake | 15s | 60s | worker (the issue fetch runs earlier, in P1) |
| plan and wall (parallel, Promise.all) | 45s | 90s | worker |
| implement | 180s | 480s (`LOKI_E10_IMPLEMENT_KILL_S`) | session group |
| verify (each pass) | 60s | 120s | worker |
| fix (each of at most 2 rounds) | 90s | 180s | session group |
| seal | 15s | 60s | worker |
| pr | 15s | 60s | supervisor, P4 |
| deep | unbounded target | 30 min | P5 to P7, after exit |

**Run cap.** `LOKI_E10_CAP_S` defaults to 900. The cap fires at cap minus 60s, so Seal and a DRAFT PR finish inside 15 minutes. With `--deep` or a logged auto-escalation (escalate.ts), the implement limit becomes 900s and the cap 2700s. Auto-escalation triggers:
- the plan names more than 12 files;
- the issue carries a `loki:deep` label;
- the repo map has more than 20,000 files.

Each escalation emits an `escalated` event with the reason.

**Verdicts:** VERIFIED, PARTIAL, ALREADY_SATISFIED, SPEC_CONFLICT, FAILED. A verdict never hides a gap: every check that did not run is on the NOT PROVEN list.

### Stage contracts

**Intake (15s).** Does not write a PRD.
- Refuses if tracked files are modified; untracked files are allowed.
- Creates branch `loki/<run-id>` in place.
- Task text comes from argv or from issue.json. It is quoted as untrusted data in every brief.
- Checks whether the issue is already done: closed, or a linked PR merged (from fetched fields). Already done emits `already.satisfied` and goes straight to Seal.
- Builds the repo map and the test map for `git rev-parse HEAD^{tree}`, through cache.ts when present.

**Plan (45s).** One fast-tier session.
- Input: the task, the repo map, and the top 8 files ranked by keyword overlap with the task.
- Output is truncated to 10 lines, emitted in `stage.completed.data.plan`, and passed to Implement.

**Wall (45s).** One session whose cwd is a temp dir containing only `task.md` and `repomap.txt`, so it cannot see the code.
- It writes behavioral acceptance tests, named `loki_wall_*`, for the detected runner.
- The engine copies them into the repo's test directory, keeps a sealed copy in `.loki/runs/<id>/wall/`, and emits `wall.sealed` with `[{path, sha256}]` before Implement starts.
- The Wall tests then run on the base tree. All green means ALREADY_SATISFIED.

**Implement (3 min).** Exactly one session through `resolveProvider`, at development tier, with `mainLoop: true` and a unique `LOKI_ITERATION=e10-<run-id>-impl`.
- For Claude the worker sets `LOKI_SDK_LOOP=1`, so `selectClaudeInvokerKind` (providers.ts:148) picks `sdkQueryProvider` (providers.ts:584). That is the invoker that captures cost. It also sets `LOKI_HOST_GUARD=1` (Claude only; providers.ts:63 throws for others).
- `LOKI_E10_INVOKER=cli` selects `claudeProvider` instead; cost is then "not measured".
- The brief contains: the task (quoted), the plan, the Wall paths (read-only), the impacted tests it may run, and past failure causes (top 3, from the cache). It also contains these rules:
  - never run the full suite, e2e or long-running servers;
  - never kill processes;
  - no docs unless asked;
  - no commit or push;
  - end with `LOKI_DONE`, `LOKI_ALREADY_DONE: <evidence>` or `LOKI_SPEC_CONFLICT: <reason>`.
- After the session the engine checks the changed files:
  - any Wall file whose hash differs is restored from the sealed copy, and `tests.restored` is emitted;
  - pre-existing test files matched by the test map are restored from base;
  - new test files are kept.

**Fast verify (60s).**
- Changed files come from `git diff --name-only <base>`, excluding `.loki/`.
- Selected tests:
  - when the target is this repo (scripts/select-tests.sh exists at its root), `scripts/select-tests.sh --files-from <list> --run`, because the script cds into its own repo root (scripts/select-tests.sh:36-38) and its rules name loki-mode paths;
  - otherwise the test-map impacted tests;
  - plus changed test files and the Wall tests.
- Also runs lint and typecheck on changed files only: eslint, tsc (project scoped, within budget), ruff, `bash -n`, shellcheck. A missing tool is reported as NOT PROVEN "lint: ruff not installed", never as a failure.
- A failing test is re-run once. Pass on re-run means flaky: it goes on NOT PROVEN and into the cache flaky list, and does not block.
- Failures are grouped by failures.ts and passed to fix.ts, at most 2 rounds.

**Commit.** One commit `loki: <title>` with trailer `Loki-Run: <run-id>`, including the Wall tests.

**Seal (15s).**
- Writes `.loki/runs/<id>/receipt.json` and `receipt.md`.
- `receipt_sha256` is the sha256 of the canonical JSON with `verification` removed.
- Signing runs `findIsolatedPython3()` (loki-ts/src/util/python.ts:82) with `-I` but not `-S`: `-S` would drop site-packages, so `cryptography` would never import and every receipt would be unsigned. It inserts autonomy/ into sys.path as proof-generator.py:2189-2191 does, then calls `load_signing_key()` (receipt_jwt.py:117) and `sign_attestation(key, kid, job_id=run_id, run_id=run_id, receipt_hash=receipt_sha256)` (receipt_jwt.py:220).
- An empty token means UNSIGNED, printed as such.

Receipt fields:
- schema `loki.v10.receipt/1`
- run_id, task {source, sha256}, repo, base_sha, head_sha, tree, diff_sha256
- wall {files, passed}
- checks [{name, cmd, result: pass, fail or not_run, duration_s}]
- not_proven [string], verdict
- cost {usd or null, input_tokens, output_tokens}
- time {wall_s, stages}
- provider, model, resumed, events_sha256, receipt_sha256
- verification {jwt or null, kid}

**PR (15s).** Handled by the supervisor through P4.
- The body comes from pr_body.ts when present, otherwise from receipt.md.
- It is a DRAFT unless the verdict is VERIFIED.
- The body always lists NOT PROVEN, and states "Deep verify running; this PR's loki/deep-verify check turns red on failure."
- `--no-pr` stops after Seal, for the eval and fixtures.

**Deep verify (async).** Checks run in the tokenless deep worker:
- **Full suite:** the detected runner, no file filter.
- **App boot:** `discoverProjectGraph` (loki-ts/src/project_graph.ts:219) finds the start command; the check passes on a health probe within 90s; no docker compose on this path.
- **Council:** `dispatchClaudeAgents` (loki-ts/src/council/voter_agents.ts:297). The context excludes generated docs, meaning markdown the task did not name, docs/, and files over 64 KB. A refused or oversized context is NOT PROVEN, not a finding. Other providers get "council: no voter agents for <provider>" on NOT PROVEN.
- **Security scan:** autonomy/lib/secret-scan.sh functions on changed files, plus autonomy/lib/secure-scan.py.

Results go into `receipt-addendum-1.json` (references `receipt_sha256`, signed the same way). The publish child posts the PR comment and sets `loki/deep-verify` to success or failure.

### Event log: the single source of truth

Path: `<repo>/.loki/runs/<run-id>/events.jsonl`. Append-only, one JSON object per line, written only by the supervisor. The CLI, `loki status`, the dashboard, the receipt and resume all read it. There are no other state files. Artifacts in the run dir (issue.json, wall/, session logs, receipt*.json) are outputs referenced by events, never read as state. Side files written by reused invokers (for example `.loki/metrics/result-cost-<iter>.json`) are harvested once into a `cost` event.

Envelope (all keys required; `stage` is null for run-level events):

```json
{"v":1,"seq":17,"ts":"2026-09-27T22:04:11.482Z","run":"e10-20260927T220103Z-ab12","type":"stage.completed","stage":"implement","data":{}}
```

| type | stage | data |
|---|---|---|
| run.started | null | {task_source: text or issue, task_sha256, issue_ref?, repo, origin, base_sha, branch, provider, model, deep, cap_s} |
| stage.started | name | {target_s, limit_s} |
| stage.completed | name | stage outputs: intake {tree, changed_allowed, runner, test_count}; plan {plan}; implement {exit: done, already_done, spec_conflict or killed, evidence?}; verify {passed, failed, groups}; seal {receipt_sha256, signed} |
| stage.failed | name | {reason, killed: bool} |
| stage.skipped | name | {reason} |
| heartbeat | name | {waiting_on, elapsed_s, eta_s or null, shortstat or null} |
| session.started / session.ended | name | {provider, model, tier, pgid} / {exit_code, duration_s, killed} |
| cost | name | {usd or null, input_tokens, output_tokens, cache_read_tokens, source} |
| wall.sealed | wall | {files: [{path, sha256}]} |
| tests.restored | implement | {paths} |
| test.result | verify or deep | {cmd, runner, passed, failed, skipped, flaky: [..], duration_s} |
| fix.round | fix | {round, groups: [{signature, count, example}]} |
| already.satisfied | name | {evidence} |
| spec.conflict | implement | {reason} |
| escalated | null | {reason, cap_s, implement_limit_s} |
| cap.hit | name | {cap_s, elapsed_s} |
| tamper.detected | null | {expected_sha256, actual_sha256} |
| receipt.sealed | seal | {path, receipt_sha256, verdict, not_proven, signed} |
| pr.opened | pr | {url, draft, existing: bool} |
| deep.started / deep.completed | deep | {} / {checks, verdict} |
| receipt.addendum | deep | {path, sha256, signed} |
| run.completed | null | {verdict, not_proven, pr_url or null, cost_usd or null, wall_s} |

**Fold and resume.** `fold(events)` returns the last event per stage and the run-level summary. `loki --resume <run-id>` restarts from the first stage without `stage.completed`. A killed Implement re-runs against the current tree, keeping its partial diff. A run with `run.completed` does not resume.

### Per-repo cache

- Location: `~/.loki/cache/v10/<repo-key>/`, where repo-key is sha256 of the pinned origin, or of the absolute path when there is no origin.
- `repomap-<tree>.json` and `testmap-<tree>.json` are keyed by tree hash.
- `flaky.json` and `failures.jsonl` are keyed per repo, capped at 200 entries each.
- Reads are optional lookups; a miss builds inline exactly as with no cache.
- Writes happen after the PR step, so the first run is never slower.
- No warmup, TTL daemon or index build.

### CLI surface (only with LOKI_ENGINE=v10)

| Command | Meaning |
|---|---|
| `loki "<task>"` | Run on a free-text task in the current repo |
| `loki <issue-url>` or `loki owner/repo#N` | Run on an issue (GitHub; GitLab and Jira via adapters) |
| `loki status [run-id]` | Folded view of the latest run or a named run |
| `loki verify [run-id]` | Recompute receipt and addendum hashes, verify the JWT (`verify_attestation`, receipt_jwt.py:266), print NOT PROVEN |
| `loki dashboard` | Start the v10 dashboard |

Flags: `--deep`, `--provider <name>`, `--no-pr`, `--resume <run-id>`.

Hidden subcommands (router only): `engine10 worker`, `engine10 deep-supervise`, `engine10 deep-worker`.

Live output, one line per stage transition:

```
[00:12] intake     done   12s   runner=pytest+vitest  (repo map cached)
[00:50] plan+wall  done   38s   plan 6 lines, 4 wall tests sealed
[02:10] implement  ...    waiting on claude session  1m20s  ETA 1m40s  (3 files changed, +41 -2)
```

A heartbeat line prints every 60s while a stage waits. The ETA comes from eta.ts (median of this repo's past stage times from the cache, else the targets). With no data it prints "ETA unknown", never 0.

Final 5-line summary:

```
PR:         https://github.com/o/r/pull/12 (draft)
Verdict:    VERIFIED
NOT PROVEN: full suite, app boot, council, security scan (deep verify running)
Cost:       $0.84 (claude-sonnet, 212k tokens)   [or: not measured (codex reports tokens only)]
Time:       4m12s (intake 12s, plan+wall 38s, implement 2m41s, verify 29s, seal+pr 12s)
```

### Dispatch hooks (legacy untouched when LOKI_ENGINE is unset)

**bin/loki.** Insert one block between the LOKI_LEGACY_BASH exec (bin/loki:242-244) and the bun-presence check (bin/loki:246-250):
- `LOKI_LEGACY_BASH=1` still wins because it comes first.
- With `LOKI_ENGINE` unset the block is a single failed test.
- The later routing, including the LOKI_SDK_LOOP `start` fork at line 325 and the main case at line 412, is unchanged.

```bash
# Loki 10 engine (D29). Additive: skipped entirely unless LOKI_ENGINE=v10.
if [ "${LOKI_ENGINE:-}" = "v10" ]; then
    _e10=0
    case "${1:-}" in
        status|verify|dashboard) _e10=1 ;;
        ""|-*) ;;
        *\ *|http*://*/issues/*|*/*\#[0-9]*) _e10=1 ;;
        *) if declare -F _loki_known_command >/dev/null 2>&1 \
              && [ "$(_loki_known_command "$1")" = "other" ] && [ ! -e "$1" ]; then _e10=1; fi ;;
    esac
    if [ "$_e10" = "1" ]; then
        command -v bun >/dev/null 2>&1 || { echo "Error: LOKI_ENGINE=v10 needs bun; unset LOKI_ENGINE to use the current engine." >&2; exit 1; }
        exec bun "$BUN_CLI" engine10 "$@"
    fi
fi
```

`_loki_known_command` is defined in autonomy/telemetry.sh:167, which bin/loki sources near line 129. If it is undefined, the block routes only multi-word tasks, issue refs and the three named commands, and everything else stays legacy.

**loki-ts/src/cli.ts.** Add one arm before `default:` (cli.ts:303). The import is lazy, so legacy commands never load engine code:

```ts
    case "engine10": {
      const { runEngine10 } = await import("./engine10/cli.ts");
      return runEngine10(rest);
    }
```

This arm is the only place the string `engine10` appears outside `src/engine10/`, pinned by `loki-ts/tests/engine10/cli.test.ts`.

**Build constraints.**
- bin/loki runs `loki-ts/dist/loki.js` by default (bin/loki:94-112), so new src code does not reach users until a train rebuilds dist. dist is rebuilt once per train by the Release Captain and is in no slice's file set.
- Every Wall check and the first real run use `LOKI_TS_ENTRY=<abs>/loki-ts/src/cli.ts`. The 01:00 UTC eval run goes from source unless dist has been rebuilt.
- The build_prompt parity fixtures (loki-ts/tests/fixtures/build_prompt/, loki-ts/tests/parity/build_prompt.test.ts) are not touched.
- providers.ts, sdk_stream_parser.ts, github_token.ts and run.sh are imported or sourced, never edited.
- The dashboard HTML is a TS string (dashboard/page.ts) so Bun.build bundles it.

### Dashboard

Served by `loki dashboard` (v10) from `engine10/dashboard/server.ts` via `Bun.serve` on 127.0.0.1, port `LOKI_E10_DASHBOARD_PORT` (default 57375). The old FastAPI dashboard (dashboard/, port 57374) is not touched.

Routes:
- `GET /` serves the page.
- `GET /api/runs` folds every `.loki/runs/*/events.jsonl`.
- `GET /api/runs/:id/events` is SSE: it replays the file, then tails it with fs.watch plus a 1s poll fallback.

One screen shows:
- the runs list;
- the per-run live stage timeline (target versus actual);
- PR link, verdict, NOT PROVEN, cost, time.

A panel renders only when its event exists. Unknown values show "not measured", never 0.

### Integrations

One interface in `engine10/adapters/types.ts`:

```ts
export interface Adapter {
  name: "github" | "gitlab" | "jira" | "slack";
  matches(ref: string): boolean;                       // issue-in adapters
  fetchIssue?(ref: string): Promise<Issue>;            // runs in the credentialed fetch child only
  openChange?(p: ChangeRequest): Promise<{ url: string; existing: boolean }>; // runs in the credentialed push child only
  notify?(s: RunSummary): Promise<void>;               // supervisor, after run.completed
}
```

| Adapter | Direction | Implementation |
|---|---|---|
| GitHub | Issue in, PR out | Wraps `fetch_github_issue` (issue-providers.sh:170) and engine10-push.sh |
| GitLab | Issue in, MR out | `fetch_gitlab_issue` (issue-providers.sh:283) plus engine10-push-gitlab.sh (see below) |
| Jira | Read | `fetch_jira_issue` (issue-providers.sh:321) |
| Slack | Notify | POSTs the 5-line summary to `LOKI_SLACK_WEBHOOK_URL`; a missing URL skips silently |

`_loki_trusted_push` accepts only literal github.com origins (run.sh:5826-5845). So GitLab MR out needs its own credentialed pusher using the same fetch-into-a-fresh-repo technique, with a literal gitlab.com check. That is HIGH tier (E-26). Until it lands, GitLab `openChange` refuses with a clear message, and the refusal is recorded on NOT PROVEN.

Each adapter has a fixture test with no network: canned JSON, stub gh/glab/curl on PATH, and a local HTTP server for Slack.

### Legacy alias contract

`loki legacy <args>` lands only when the default flips. Its contract: exactly the bin/loki routing that `<args>` gets today with `LOKI_ENGINE` unset. A golden route table (tests/fixtures/engine10-legacy-routes.txt) records today's routing, and tests/test-engine10-legacy-contract.sh proves the table matches current behavior. The flip slice must keep the test green with `legacy` prepended. No existing command moves before the flip.

## Reuse inventory

| Asset | Location | How v10 uses it |
|---|---|---|
| receipt_jwt | autonomy/receipt_jwt.py:117 load_signing_key, :199 build_jwks, :220 sign_attestation, :266 verify_attestation; caller pattern autonomy/lib/proof-generator.py:2185-2197 | Seal signs the receipt and addendum; `loki verify` verifies |
| scripts/select-tests.sh | usage :9-31, `--files-from` :19, cd into its own root :36-38, rules R0-R7 :102-419 | Fast verify, only when the target is this repo |
| _loki_trusted_push | autonomy/run.sh:5896-5947; helpers :5777, :5826, :5847, :5868, :5883; region :5517-5992; callers :6102, :11269; check-before-create :11287 | Sourced by engine10-push.sh in P4 |
| providers/*.sh contracts | claude.sh:31-32 flags, :380 provider_invoke, :413 provider_invoke_argv, :649 provider_invoke_with_tier; codex.sh:218, :308, :368; cline.sh:120, :155, :168; aider.sh:122, :157, :179; loader.sh:25 | Mirrored by the TS invokers below; not re-implemented |
| loki-ts provider invokers | loki-ts/src/runner/providers.ts:59 resolveProvider, :148 selectClaudeInvokerKind, :323 claudeProvider, :584 sdkQueryProvider, :837 codexProvider, :908 clineProvider, :958 aiderProvider; types.ts:95, :122, :126 | session.ts calls `resolveProvider(...).invoke` unchanged |
| Host command guard | providers.ts:267 hostGuardRequired, :284 hostGuardSettingsJson, :63 non-claude refusal; autonomy/hooks/validate-bash.sh:91-93 | Blocks kill, pkill and killall in Implement (Claude) |
| _loki_snapshot_py_tool | autonomy/run.sh:10000; TS mirror loki-ts/src/util/python.ts:74-96 findIsolatedPython3 | Interpreter for signing (run with `-I`, not `-S`) |
| Cost capture from provider JSON | autonomy/run.sh:25737-25800 (result `total_cost_usd` to `.loki/metrics/result-cost-<iter>.json`); TS mirror loki-ts/src/runner/sdk_stream_parser.ts:314-316 and writeResultCost :425-445; LOKI_ITERATION passed at providers.ts:677-679 | cost.ts reads `result-cost-e10-<run-id>-<stage>.json` into a `cost` event |
| Token withholding | loki-ts/src/runner/github_token.ts:183 withholdGithubTokens | Worker env (applied to a copy) |
| Issue fetch | autonomy/issue-providers.sh:110 parse_issue_reference, :170, :283, :321, :404 fetch_issue | P1 fetch child and the adapters |
| Repo profile | loki-ts/src/runner/repo_profile.ts:117-131 (reads package.json scripts only) | testmap.ts reuses it for npm scripts and adds pytest, vitest, jest, bun, go and cargo |
| Secret scan | autonomy/lib/secret-scan.sh, autonomy/lib/secure-scan.py | Deep verify |
| Council voters | loki-ts/src/council/voter_agents.ts:297 dispatchClaudeAgents | Deep verify |
| Project graph | loki-ts/src/project_graph.ts:219 discoverProjectGraph | Deep verify app boot |

## Slices

Every check runs from source. Red means the check fails before the slice lands; green means it passes after. Test paths are relative to `loki-ts/` unless they start with `tests/test-`. No file appears in two slices.

### Wave 1: thin vertical path (target: one real task end to end by about 01:00 UTC)

- **E-01 Event log and schema.**
  - Files: loki-ts/src/engine10/events.ts; loki-ts/tests/engine10/events.test.ts.
  - Tier: MEDIUM. Depends on: none.
  - Scope: envelope validation, append (O_APPEND, single writer), `readEvents`, `fold`, `tail(onEvent)`, unknown-type tolerance, a truncated last line ignored.
  - Wall check: `cd loki-ts && bun test tests/engine10/events.test.ts`. Red: module missing. Green: all pass, including a torn-line case.
- **E-02 State machine skeleton.**
  - Files: loki-ts/src/engine10/machine.ts, loki-ts/src/engine10/types.ts; loki-ts/tests/engine10/machine.test.ts, loki-ts/tests/engine10/budget.test.ts.
  - Tier: HIGH. Depends on: E-01.
  - Scope: stage table with the plan and wall parallel group, per-stage AbortSignal and limits, cap at `LOKI_E10_CAP_S` minus 60s jumping to commit, seal and pr, the verify and fix loop (at most 2), the `optional()` loader emitting `stage.skipped`, resume from fold, and the 5,000-line budget test over src/engine10.
  - Wall check: `cd loki-ts && bun test tests/engine10/machine.test.ts tests/engine10/budget.test.ts`. Red: missing. Green: stub stages run in order; the cap test aborts the stub implement and reaches seal; resume skips completed stages; budget under 5,000.
- **E-03 Supervisor, worker and Rule of Two.**
  - Files: loki-ts/src/engine10/supervisor.ts, loki-ts/src/engine10/worker.ts; loki-ts/tests/engine10/rule_of_two.test.ts.
  - Tier: HIGH. Depends on: E-01, E-02.
  - Scope: origin pinned before any session, run id and branch in memory, `.git/info/exclude` updated, worker env = `withholdGithubTokens(copy)`, supervisor as the only log writer, tamper hash, the P1 fetch child spawn, push inputs from memory only, origin re-check on resume.
  - Wall check: `cd loki-ts && bun test tests/engine10/rule_of_two.test.ts`. Red: missing. Green: canary GH_TOKEN absent from a stub worker's env and present in a stub push child's env; a planted log edit gives `tamper.detected` and no push; a changed origin on resume refuses the push.
- **E-04 Intake.**
  - Files: loki-ts/src/engine10/stages/intake.ts, loki-ts/src/engine10/fetch_issue.ts, loki-ts/src/engine10/repomap.ts; loki-ts/tests/engine10/intake.test.ts, loki-ts/tests/engine10/fixtures/intake/.
  - Tier: MEDIUM. Depends on: E-02.
  - Scope: dirty-tree refusal, branch creation, issue.json read, already-closed and linked-merged-PR detection, repo map, optional cache use.
  - Wall check: `cd loki-ts && bun test tests/engine10/intake.test.ts`. Red: missing. Green: a closed-issue fixture gives `already.satisfied`; a dirty tree refuses; the repo map lists symbols in under 15s on the fixture.
- **E-05 Test map and runner detection.**
  - Files: loki-ts/src/engine10/testmap.ts; loki-ts/tests/engine10/testmap.test.ts, loki-ts/tests/engine10/fixtures/mixed-repo/.
  - Tier: MEDIUM. Depends on: none.
  - Scope: detects pytest (pyproject, pytest.ini, conftest, tests/test_*.py), vitest and jest (package.json deps and scripts), npm scripts via repo_profile, bun, go and cargo; impacted tests per changed file.
  - Wall check: `cd loki-ts && bun test tests/engine10/testmap.test.ts`. Red: missing. Green: the mixed fixture reports runners pytest and vitest (never none), and a changed `src/search.ts` maps to `src/search.test.ts`.
- **E-06 Cost capture.**
  - Files: loki-ts/src/engine10/cost.ts; loki-ts/tests/engine10/cost.test.ts, loki-ts/tests/engine10/fixtures/cost/.
  - Tier: MEDIUM. Depends on: none.
  - Scope: read `result-cost-<iter>.json`, sum across sessions, return null usd when absent.
  - Wall check: `cd loki-ts && bun test tests/engine10/cost.test.ts`. Red: missing. Green: two files sum correctly; a missing file gives usd null and never 0.
- **E-07 Provider session wrapper.**
  - Files: loki-ts/src/engine10/session.ts; loki-ts/tests/engine10/session.test.ts, loki-ts/tests/engine10/fixtures/session/.
  - Tier: MEDIUM. Depends on: E-01, E-06.
  - Scope: detached process group, `resolveProvider().invoke` with a unique LOKI_ITERATION, `LOKI_SDK_LOOP=1` and `LOKI_HOST_GUARD=1` for Claude, `LOKI_E10_INVOKER=cli` escape, 60s heartbeat with shortstat, group kill on limit, cost harvest.
  - Wall check: `cd loki-ts && bun test tests/engine10/session.test.ts`. Red: missing. Green: a stub provider that forks a sleeping grandchild is killed as a group (grandchild pid gone); a heartbeat fires; a cost event is emitted.
- **E-08 Implement stage.**
  - Files: loki-ts/src/engine10/stages/implement.ts; loki-ts/tests/engine10/implement.test.ts.
  - Tier: MEDIUM. Depends on: E-02, E-05, E-07.
  - Scope: brief text (no full suite, no kills, no docs, exit markers), post-session changed-file check restoring Wall and pre-existing tests, ALREADY_DONE and SPEC_CONFLICT parsing.
  - Wall check: `cd loki-ts && bun test tests/engine10/implement.test.ts`. Red: missing. Green: a stub that edits a pre-existing test gets it restored with `tests.restored`; the markers parse; the brief contains the forbid lines.
- **E-09 Fast verify.**
  - Files: loki-ts/src/engine10/stages/verify.ts; loki-ts/tests/engine10/verify.test.ts.
  - Tier: MEDIUM. Depends on: E-05.
  - Scope: impacted plus changed plus Wall tests, select-tests.sh when the target is this repo, lint and typecheck of changed files, missing tool as NOT PROVEN, one re-run means flaky, 60s budget.
  - Wall check: `cd loki-ts && bun test tests/engine10/verify.test.ts`. Red: missing. Green: on the mixed fixture only impacted tests run; a missing linter shows as NOT PROVEN, not failed.
- **E-10 Seal.**
  - Files: loki-ts/src/engine10/stages/seal.ts; loki-ts/tests/engine10/seal.test.ts.
  - Tier: HIGH. Depends on: E-01.
  - Scope: receipt schema, canonical hash, `-I` isolated signing via receipt_jwt, UNSIGNED when there is no key, NOT PROVEN list, receipt.md.
  - Wall check: `cd loki-ts && bun test tests/engine10/seal.test.ts`. Red: missing. Green: with a test Ed25519 key the JWT verifies through `verify_attestation` and its `receipt_sha256` matches; with no key, `signed:false`; mutating the receipt fails verification.
- **E-11 Trusted push and PR.**
  - Files: autonomy/lib/engine10-push.sh, loki-ts/src/engine10/stages/pr.ts; tests/test-engine10-push.sh, loki-ts/tests/engine10/pr.test.ts.
  - Tier: HIGH. Depends on: E-03, E-10.
  - Scope: region-extract and source of run.sh:5517-5992, pinned origin from env, `_loki_trusted_push`, check-before-create, `gh pr create [--draft]` via `_loki_run_neutral`, pending `loki/deep-verify` status, `comment` and `status` subcommands.
  - Wall check: `bash tests/test-engine10-push.sh`. Red: missing. Green: the push reaches a local bare remote; a planted pre-push hook records nothing; a repointed origin is refused; a default branch is refused; a second call reuses the existing PR.
- **E-12 CLI entry behind LOKI_ENGINE=v10.**
  - Files: loki-ts/src/engine10/cli.ts, loki-ts/src/cli.ts (one `case "engine10"` arm before `default:` at line 303), bin/loki (one block between lines 244 and 246); tests/test-engine10-dispatch.sh, loki-ts/tests/engine10/cli.test.ts.
  - Tier: MEDIUM. Depends on: E-03.
  - Scope: the router for run, status, verify, dashboard and hidden subcommands with optional modules; flags `--deep`, `--provider`, `--no-pr`, `--resume`.
  - Wall check: `bash tests/test-engine10-dispatch.sh`. Red: missing. Green: with LOKI_ENGINE unset, `loki "fix the bug"` reaches the bash CLI and `loki status` reaches the Bun status; with v10, both reach `engine10` (via a stub LOKI_TS_ENTRY); LOKI_LEGACY_BASH=1 beats v10; `engine10` appears once in src/cli.ts.
- **E-13 Live output.**
  - Files: loki-ts/src/engine10/output.ts; loki-ts/tests/engine10/output.test.ts.
  - Tier: MEDIUM. Depends on: E-01.
  - Scope: one line per stage transition, the heartbeat line, the 5-line summary, "not measured" for null cost, optional ETA module.
  - Wall check: `cd loki-ts && bun test tests/engine10/output.test.ts`. Red: missing. Green: a folded fixture log renders exactly 5 summary lines; null cost prints "not measured".
- **E-14 Thin-path end to end.**
  - Files: loki-ts/tests/engine10/e2e.test.ts, loki-ts/tests/engine10/fixtures/e2e/ (stub-claude.sh, tiny-repo template).
  - Tier: MEDIUM. Depends on: E-01 to E-13.
  - Scope: a full run with `LOKI_E10_INVOKER=cli`, `LOKI_CLAUDE_CLI=stub`, `--no-pr`, then an ALREADY_DONE run.
  - Wall check: `cd loki-ts && bun test tests/engine10/e2e.test.ts`. Red: fails. Green: stages in order in events.jsonl; verdict VERIFIED; receipt present; ALREADY_DONE seals ALREADY_SATISFIED with no second session; wall time under 30s.

### Wave 2

- **E-15 Wall author.**
  - Files: loki-ts/src/engine10/stages/wall.ts; loki-ts/tests/engine10/wall.test.ts.
  - Tier: MEDIUM. Depends on: E-07, E-05.
  - Scope: temp-dir cwd holding only task.md and repomap.txt, copy-in, sealed copies, `wall.sealed` hashes, base-tree run meaning ALREADY_SATISFIED.
  - Wall check: `cd loki-ts && bun test tests/engine10/wall.test.ts`. Red: missing. Green: the stub session's cwd contains no repo source files; hashes are emitted before `stage.started` implement.
- **E-16 Planner.**
  - Files: loki-ts/src/engine10/stages/plan.ts; loki-ts/tests/engine10/plan.test.ts.
  - Tier: MEDIUM. Depends on: E-07.
  - Scope: keyword-ranked top 8 files, output capped at 10 lines.
  - Wall check: `cd loki-ts && bun test tests/engine10/plan.test.ts`. Red: missing. Green: 25 stub lines are truncated to 10; only ranked files appear in the prompt.
- **E-17 Fix rounds and grouped failures.**
  - Files: loki-ts/src/engine10/stages/fix.ts, loki-ts/src/engine10/failures.ts; loki-ts/tests/engine10/fix.test.ts, loki-ts/tests/engine10/fixtures/failures/.
  - Tier: MEDIUM. Depends on: E-07, E-09.
  - Scope: parse pytest, vitest, jest, bun, go and cargo output; normalize signatures; top 5 groups; at most 2 rounds.
  - Wall check: `cd loki-ts && bun test tests/engine10/fix.test.ts`. Red: missing. Green: 40 failures sharing one assertion collapse to 1 group; a third round never starts.
- **E-18 Per-repo cache.**
  - Files: loki-ts/src/engine10/cache.ts; loki-ts/tests/engine10/cache.test.ts.
  - Tier: MEDIUM. Depends on: E-04, E-05.
  - Scope: repo key, tree-keyed maps, flaky list, failure causes, writes only after PR, bounded files.
  - Wall check: `cd loki-ts && bun test tests/engine10/cache.test.ts`. Red: missing. Green: a second intake on the same tree skips the build; a cold run does no extra work (timing assert).
- **E-19 Hard cap and DRAFT PR body.**
  - Files: loki-ts/src/engine10/pr_body.ts; loki-ts/tests/engine10/cap.test.ts.
  - Tier: MEDIUM. Depends on: E-02, E-07, E-11.
  - Scope: honest body for PARTIAL, SPEC_CONFLICT and ALREADY_SATISFIED; a cap test with `LOKI_E10_CAP_S=20` and a sleeping stub.
  - Wall check: `cd loki-ts && bun test tests/engine10/cap.test.ts`. Red: missing. Green: the run ends in under 25s with `cap.hit`, verdict PARTIAL, draft true, and a body listing what did not run.
- **E-20 ETA.**
  - Files: loki-ts/src/engine10/eta.ts; loki-ts/tests/engine10/eta.test.ts.
  - Tier: MEDIUM. Depends on: E-13, E-18.
  - Scope: median past stage times from the cache, else targets, else unknown.
  - Wall check: `cd loki-ts && bun test tests/engine10/eta.test.ts`. Red: missing. Green: no history uses the targets; no targets gives "unknown", never 0.
- **E-21 `loki status`.**
  - Files: loki-ts/src/engine10/status.ts; loki-ts/tests/engine10/status.test.ts.
  - Tier: MEDIUM. Depends on: E-01, E-13.
  - Wall check: `cd loki-ts && bun test tests/engine10/status.test.ts`. Red: missing. Green: prints the latest run's stage lines and summary from a fixture log; `--json` emits the fold.
- **E-22 `loki verify`.**
  - Files: loki-ts/src/engine10/verify_cmd.ts; loki-ts/tests/engine10/verify_cmd.test.ts.
  - Tier: MEDIUM. Depends on: E-10.
  - Wall check: `cd loki-ts && bun test tests/engine10/verify_cmd.test.ts`. Red: missing. Green: a valid receipt exits 0; a tampered receipt exits 1; UNSIGNED is printed as such.
- **E-23 Deep verify.**
  - Files: loki-ts/src/engine10/stages/deep.ts; loki-ts/tests/engine10/deep.test.ts.
  - Tier: MEDIUM. Depends on: E-03, E-10, E-11.
  - Scope: credentialed deep supervisor and tokenless worker, full suite, app boot, council with generated docs excluded, secret and security scan, signed addendum, comment, status red on failure, refused check shown as NOT PROVEN.
  - Wall check: `cd loki-ts && bun test tests/engine10/deep.test.ts`. Red: missing. Green: a planted secret gives status failure naming file:line; an oversized council context gives NOT PROVEN, not failure; the canary token is absent from the deep worker's env.

### Wave 3

- **E-24 Dashboard over SSE.**
  - Files: loki-ts/src/engine10/dashboard/server.ts, loki-ts/src/engine10/dashboard/page.ts; loki-ts/tests/engine10/dashboard.test.ts.
  - Tier: MEDIUM. Depends on: E-01, E-12.
  - Wall check: `cd loki-ts && bun test tests/engine10/dashboard.test.ts`. Red: missing. Green: `/api/runs` lists fixture runs; SSE replays and then streams an appended event within 2s; the server binds 127.0.0.1 only; null cost shows "not measured".
- **E-25 Adapter interface and GitHub adapter.**
  - Files: loki-ts/src/engine10/adapters/types.ts, loki-ts/src/engine10/adapters/index.ts, loki-ts/src/engine10/adapters/github.ts; loki-ts/tests/engine10/adapters_github.test.ts, loki-ts/tests/engine10/fixtures/adapters-github/.
  - Tier: MEDIUM. Depends on: E-04, E-11.
  - Wall check: `cd loki-ts && bun test tests/engine10/adapters_github.test.ts`. Red: missing. Green: a stub gh returns fixture JSON, normalized; openChange calls engine10-push.sh with the expected argv.
- **E-26 GitLab adapter and GitLab trusted push.**
  - Files: loki-ts/src/engine10/adapters/gitlab.ts, autonomy/lib/engine10-push-gitlab.sh; loki-ts/tests/engine10/adapters_gitlab.test.ts, tests/test-engine10-push-gitlab.sh, loki-ts/tests/engine10/fixtures/adapters-gitlab/.
  - Tier: HIGH (Rule of Two). Depends on: E-25.
  - Wall check: `bash tests/test-engine10-push-gitlab.sh`. Red: missing. Green: a literal gitlab.com origin is pushed from a fresh repo; a planted hook records nothing; a non-gitlab origin is refused.
- **E-27 Jira read adapter.**
  - Files: loki-ts/src/engine10/adapters/jira.ts; loki-ts/tests/engine10/adapters_jira.test.ts, loki-ts/tests/engine10/fixtures/adapters-jira/.
  - Tier: MEDIUM. Depends on: E-25.
  - Wall check: `cd loki-ts && bun test tests/engine10/adapters_jira.test.ts`. Red: missing. Green: the fixture issue normalizes; no openChange is exposed.
- **E-28 Slack notify adapter.**
  - Files: loki-ts/src/engine10/adapters/slack.ts; loki-ts/tests/engine10/adapters_slack.test.ts.
  - Tier: MEDIUM. Depends on: E-25, E-13.
  - Wall check: `cd loki-ts && bun test tests/engine10/adapters_slack.test.ts`. Red: missing. Green: a local HTTP server receives the 5-line summary; an unset URL skips with no request.
- **E-29 Escalation.**
  - Files: loki-ts/src/engine10/escalate.ts; loki-ts/tests/engine10/escalate.test.ts.
  - Tier: MEDIUM. Depends on: E-02, E-16.
  - Scope: `--deep`, a plan naming more than 12 files, the `loki:deep` label, more than 20,000 repo files; logged `escalated`; limits 900s and 2700s.
  - Wall check: `cd loki-ts && bun test tests/engine10/escalate.test.ts`. Red: missing. Green: each trigger emits `escalated` with a reason; no trigger leaves the cap at 900.
- **E-30 Legacy alias contract.**
  - Files: tests/test-engine10-legacy-contract.sh, tests/fixtures/engine10-legacy-routes.txt.
  - Tier: MEDIUM. Depends on: E-12.
  - Wall check: `bash tests/test-engine10-legacy-contract.sh`. Red: missing. Green: with LOKI_ENGINE unset, every golden route matches (bash or bun per row), and the test documents the `legacy` prefix rule for the flip.

## BOARD

| id | title | files | tier | wall check | status | notes |
|---|---|---|---|---|---|---|
| E-01 | Event log, schema and shared types | loki-ts/src/engine10/events.ts, loki-ts/src/engine10/types.ts, loki-ts/tests/engine10/events.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/events.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on none |
| E-02 | State machine skeleton | loki-ts/src/engine10/machine.ts, loki-ts/tests/engine10/machine.test.ts, loki-ts/tests/engine10/budget.test.ts | HIGH | cd loki-ts && bun test tests/engine10/machine.test.ts tests/engine10/budget.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-01 |
| E-03 | Supervisor, worker, Rule of Two | loki-ts/src/engine10/supervisor.ts, loki-ts/src/engine10/worker.ts, loki-ts/tests/engine10/rule_of_two.test.ts | HIGH | cd loki-ts && bun test tests/engine10/rule_of_two.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-01, E-02 |
| E-04 | Intake | loki-ts/src/engine10/stages/intake.ts, loki-ts/src/engine10/fetch_issue.ts, loki-ts/src/engine10/repomap.ts, loki-ts/tests/engine10/intake.test.ts, loki-ts/tests/engine10/fixtures/intake/ | MEDIUM | cd loki-ts && bun test tests/engine10/intake.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-02 |
| E-05 | Test map and runner detection | loki-ts/src/engine10/testmap.ts, loki-ts/tests/engine10/testmap.test.ts, loki-ts/tests/engine10/fixtures/mixed-repo/ | MEDIUM | cd loki-ts && bun test tests/engine10/testmap.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on none |
| E-06 | Cost capture | loki-ts/src/engine10/cost.ts, loki-ts/tests/engine10/cost.test.ts, loki-ts/tests/engine10/fixtures/cost/ | MEDIUM | cd loki-ts && bun test tests/engine10/cost.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on none |
| E-07 | Provider session wrapper | loki-ts/src/engine10/session.ts, loki-ts/tests/engine10/session.test.ts, loki-ts/tests/engine10/fixtures/session/ | MEDIUM | cd loki-ts && bun test tests/engine10/session.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-01, E-06 |
| E-08 | Implement stage | loki-ts/src/engine10/stages/implement.ts, loki-ts/tests/engine10/implement.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/implement.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-02, E-05, E-07 |
| E-09 | Fast verify | loki-ts/src/engine10/stages/verify.ts, loki-ts/tests/engine10/verify.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/verify.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-05 |
| E-10 | Seal | loki-ts/src/engine10/stages/seal.ts, loki-ts/tests/engine10/seal.test.ts | HIGH | cd loki-ts && bun test tests/engine10/seal.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-01 |
| E-11 | Trusted push and PR | autonomy/lib/engine10-push.sh, loki-ts/src/engine10/stages/pr.ts, tests/test-engine10-push.sh, loki-ts/tests/engine10/pr.test.ts | HIGH | bash tests/test-engine10-push.sh | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-03, E-10 |
| E-12 | CLI entry behind LOKI_ENGINE=v10 | loki-ts/src/engine10/cli.ts, loki-ts/src/cli.ts (engine10 arm before default:303), bin/loki (block between 244 and 246), tests/test-engine10-dispatch.sh, loki-ts/tests/engine10/cli.test.ts | MEDIUM | bash tests/test-engine10-dispatch.sh | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-03 |
| E-13 | Live output | loki-ts/src/engine10/output.ts, loki-ts/tests/engine10/output.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/output.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-01 |
| E-14 | Thin-path end to end | loki-ts/tests/engine10/e2e.test.ts, loki-ts/tests/engine10/fixtures/e2e/ | MEDIUM | cd loki-ts && bun test tests/engine10/e2e.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 1; depends on E-01 through E-13 |
| E-15 | Wall author | loki-ts/src/engine10/stages/wall.ts, loki-ts/tests/engine10/wall.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/wall.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-05, E-07 |
| E-16 | Planner | loki-ts/src/engine10/stages/plan.ts, loki-ts/tests/engine10/plan.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/plan.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-07 |
| E-17 | Fix rounds and grouped failures | loki-ts/src/engine10/stages/fix.ts, loki-ts/src/engine10/failures.ts, loki-ts/tests/engine10/fix.test.ts, loki-ts/tests/engine10/fixtures/failures/ | MEDIUM | cd loki-ts && bun test tests/engine10/fix.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-07, E-09 |
| E-18 | Per-repo cache | loki-ts/src/engine10/cache.ts, loki-ts/tests/engine10/cache.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/cache.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-04, E-05 |
| E-19 | Hard cap and DRAFT PR body | loki-ts/src/engine10/pr_body.ts, loki-ts/tests/engine10/cap.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/cap.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-02, E-07, E-11 |
| E-20 | ETA | loki-ts/src/engine10/eta.ts, loki-ts/tests/engine10/eta.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/eta.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-13, E-18 |
| E-21 | loki status | loki-ts/src/engine10/status.ts, loki-ts/tests/engine10/status.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/status.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-01, E-13 |
| E-22 | loki verify | loki-ts/src/engine10/verify_cmd.ts, loki-ts/tests/engine10/verify_cmd.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/verify_cmd.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-10 |
| E-23 | Deep verify | loki-ts/src/engine10/stages/deep.ts, loki-ts/tests/engine10/deep.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/deep.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 2; depends on E-03, E-10, E-11 |
| E-24 | Dashboard over SSE | loki-ts/src/engine10/dashboard/server.ts, loki-ts/src/engine10/dashboard/page.ts, loki-ts/tests/engine10/dashboard.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/dashboard.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-01, E-12 |
| E-25 | Adapter interface and GitHub adapter | loki-ts/src/engine10/adapters/types.ts, loki-ts/src/engine10/adapters/index.ts, loki-ts/src/engine10/adapters/github.ts, loki-ts/tests/engine10/adapters_github.test.ts, loki-ts/tests/engine10/fixtures/adapters-github/ | MEDIUM | cd loki-ts && bun test tests/engine10/adapters_github.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-04, E-11 |
| E-26 | GitLab adapter and GitLab trusted push | loki-ts/src/engine10/adapters/gitlab.ts, autonomy/lib/engine10-push-gitlab.sh, loki-ts/tests/engine10/adapters_gitlab.test.ts, tests/test-engine10-push-gitlab.sh, loki-ts/tests/engine10/fixtures/adapters-gitlab/ | HIGH | bash tests/test-engine10-push-gitlab.sh | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-25 |
| E-27 | Jira read adapter | loki-ts/src/engine10/adapters/jira.ts, loki-ts/tests/engine10/adapters_jira.test.ts, loki-ts/tests/engine10/fixtures/adapters-jira/ | MEDIUM | cd loki-ts && bun test tests/engine10/adapters_jira.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-25 |
| E-28 | Slack notify adapter | loki-ts/src/engine10/adapters/slack.ts, loki-ts/tests/engine10/adapters_slack.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/adapters_slack.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-25, E-13 |
| E-29 | Escalation | loki-ts/src/engine10/escalate.ts, loki-ts/tests/engine10/escalate.test.ts | MEDIUM | cd loki-ts && bun test tests/engine10/escalate.test.ts | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-02, E-16 |
| E-30 | Legacy alias contract | tests/test-engine10-legacy-contract.sh, tests/fixtures/engine10-legacy-routes.txt | MEDIUM | bash tests/test-engine10-legacy-contract.sh | ready@2026-09-27T21:50Z | Source: ENGINE.md 21:50Z cut; wave 3; depends on E-12 |

## Risks and open items

- **The Claude cost path uses the Agent SDK invoker, not the plain CLI.** The SDK invoker has no call timeout of its own; the process-group limit in session.ts is the bound. If the SDK path misbehaves on the 01:00 run, `LOKI_E10_INVOKER=cli` falls back and cost shows as "not measured". The eval then records the gap rather than a fake number.
- **Resume trusts the git config on disk.** It re-pins the origin from git config; an agent that rewrote both the git config and the log before a resume is caught only by the literal github.com check. This is disclosed on NOT PROVEN for resumed runs.
- **GitLab MR out** is refused until E-26 lands, and the refusal is recorded on NOT PROVEN.
- **Worktrees are not used.** The engine works in place on a new branch and refuses a dirty tree, which matches what raw `claude -p` sees (installed deps, venvs). Parallel eval runs need separate clones.

## Chief of Staff amendment (2026-09-27T22:02Z): parallel build order

To let wave 1 build in parallel, `loki-ts/src/engine10/types.ts` moves from E-02 into E-01. E-01 owns events.ts AND types.ts, and types.ts declares every cross-module interface up front: the event envelope and event types, Stage, RunContext, Verdict, stage budgets, the Receipt shape, a SessionRunner interface (what session.ts implements), a TestMap interface (what testmap.ts returns), a CostReader interface, and the push-child argv contract. Every other wave 1 module depends on its siblings only through those interfaces, injected via RunContext, so each can be unit-tested with fakes before its siblings exist. Build order: phase A = E-01, E-05, E-06; phase B (after E-01 merges) = E-02, E-03, E-04, E-07 to E-13 in parallel; phase C = E-14 and wave 2.

