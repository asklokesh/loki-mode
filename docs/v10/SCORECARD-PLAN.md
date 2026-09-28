# D41 scorecard plan: slices for items 1 and 2

Architect plan (opus) for D41. Base: local main 9869f217, after E-98f. Cards S41-01 to S41-16. Items 3 to 5 are sketched at the end.

## 0. Starting facts (each one cites a file or a command)

- **E-98f (MEDIUM-ANALYSIS.md "After"), 7 medium tasks, n=3, 21 runs per arm.**
  - default 15/21, p50 209s; `LOKI_E10_WALL=0` 16/21, p50 214s; `LOKI_E10_CASCADE=0` 15/21, p50 138s. Raw: 10/14 (EV-15) and 12/14 (EV-14), p50 56s to 70s.
  - Null-cost rows are 10, 2 and 11 of 21, so no arm has a cost figure. Every miss is werkzeug-3105 or werkzeug-3271. Speed is the largest gap: v10 p50 is 2.5 to 4x raw.
- **Three harness defects block the scorecard.**
  - (a) `provider_cost()` (harness.py ~698) accepts only `cost_source == "provider"`. E-98e writes `"partial-stream"` for killed sessions (runner/budget.ts:502), so any stage kill nulls the whole row.
  - (b) `V10_ENGINE_ENV_ALLOWLIST` (harness.py:95-98) lacks `LOKI_E10_CASCADE`, and `arm_env` drops every other `LOKI_*`. E-98f needed a bin shim.
  - (c) `arm_auth(cap + 120)` refuses a row once the keychain token has under 1020s left. Claude Code refreshes only near expiry, so every r2 row was lost once.
- **D33 core:** 4,964 lines at 9869f217, counted as `budget.test.ts` counts (`split("\n").length` over engine10 minus modernize/). Headroom is 35 lines.
- **Prefix today:** E-65 measured 7,136 tokens on sonnet for the engine10 session shape (6 tools, `claude_code` preset, no append; runner/providers.ts:488-492). There is no per-stage first-turn figure yet (S41-04).
- **Where the cost goes (MEDIUM-ANALYSIS section 4):** implement cache reads are 9.23M against raw's 4.79M. Plan, Wall and intake are 31% of spend. Plan runs on opus in the eval: `tier: "fast"` has no pin, and the override sets FAST to opus (session.ts:44-49).
- **Agent SDK 0.3.283** has a PostToolUse `updatedToolOutput` that "replaces the tool output before it is sent to the model" and "works for all tools" (sdk.d.ts:2674-2681). Trimming has a real mechanism.

## 1. Prerequisite ruling (CTO, before S41-05 merges)

Core cannot absorb items 1 and 2: the new logic is about 600 lines against 35 lines of headroom. Proposal:
- New modules go in `loki-ts/src/e10ext/`, outside engine10/, with a 1,500-line cap added to `budget.test.ts` next to modernize/.
- Core may import e10ext/. e10ext/ may not import stages/.
- Nothing that decides a verdict leaves core: Seal, the authoritative verify and the Wall seal stay in engine10/. e10ext/ only picks which diff reaches them and which model runs.
- Because verify and Seal re-check whatever is chosen, a wrong pick costs accuracy but can never produce a false seal.
- A D-entry records the ruling. If the CTO refuses, S41-05, 08, 10, 12 and 13 put their modules under engine10/ and offset every added line.

## 2. Fixed metric definitions (identical before and after)

- **Rows:** harness `dedupe` applied per rep file (it keys on model, harness_sha, task and arm, so run over concatenated reps it would merge r1 to r3), then E-98f's rule: one row per (arm label, rep file, task), the latest `status: ok` row, else the latest row. Arm label = `<arm>@<model>`. A task that is `task_invalid` anywhere is dropped from every arm.
- **Completion** = completed / evaluated, using the harness's own `completed` and `is_evaluated`.
- **Cost per completed** = sum of `cost_usd` over evaluated rows / completed rows.
  - Provider and partial-stream dollars both count; the table shows the partial-stream share of spend.
  - Any evaluated row still null makes the figure n/a, and n/a is always red.
- **p50** = nearest-rank p50 of `time_to_pr_s` over completed rows (harness `nearest_rank`).
- **Tokens per completed, by type:** input, cache read, cache write and output, each summed over evaluated rows / completed. Reported, not graded.
- **Comparability.** The tool refuses to mark a pair unless all of these hold:
  - the same task set with the same n per task;
  - the same `--parallel` and cap;
  - arms ran back to back, never concurrently;
  - reused raw rows have an equal `git hash-object eval/loki10/harness.py`. Both hashes are printed.
- **Marks.** Completion green if Loki >= raw; cost green if Loki <= raw; p50 green if Loki <= raw. The tier verdict is green only if all three are green. The headline pair, loki-sonnet against raw-opus, is green on cost only at Loki <= 0.5x raw.
- **METRICS.md columns:** tier, pair, n, the three Loki/raw pairs with marks, verdict, tokens by type, partial share, date, harness hash, command.

## 3. How the harness picks the model per arm today (item B)

- **Knob: `LOKI_EVAL_MODEL`** (harness.py:1264).
  - Unset, it takes the first `tier: "planning"` entry in providers/model_catalog.json. Today that is `claude-opus-5-5`, but `claude-opus-5` is also planning-tier, so the default depends on catalog order.
  - The value must have a `cli_aliases` entry (harness.py:1267).
- **raw-claude arm:** `--model <id>` (harness.py:1137).
- **v10 arm:** `LOKI_MODEL_OVERRIDE=<id>` plus `LOKI_SESSION_MODEL=<alias>` (harness.py:523-525).
  - session.ts:44-49 copies the override into PLANNING, DEVELOPMENT and FAST. The E-64 cascade then pins implement to `wallModel()`, sonnet by default (sizing.ts).
  - Fix escalation targets `ctx.model` (fix.ts), so on loki-sonnet nothing can escalate today. S41-08 adds `LOKI_E10_TOP_MODEL`.
- **Arms, all with pinned ids:** raw-sonnet = `LOKI_EVAL_MODEL=claude-sonnet-5 --arm raw-claude`; raw-opus = `LOKI_EVAL_MODEL=claude-opus-5-5 --arm raw-claude`; loki-sonnet = `LOKI_EVAL_MODEL=claude-sonnet-5 --arm v10` (plus `LOKI_E10_TOP_MODEL=opus` after S41-08); loki-opus = `LOKI_EVAL_MODEL=claude-opus-5-5 --arm v10` (the pair for raw-opus).

## 4. Definitions for item 1

**Deterministic failure.** A verify output has one when some check `c` meets all six conditions:
1. `c.result == "fail"`: in verify.ts `runCheck`, it failed and then failed its immediate rerun. `flaky` (fail then pass) and `not_run` (missing tool, timeout, abort) never count.
2. `c.name` is a test check, not `lint:*` and not `select-tests` (the same test as fix.ts `isTestFailure`).
3. `c.interpreter != "system"`.
4. The test file of `c` existed at baseSha or is a sealed Wall file. A test the attempt wrote itself never counts.
5. `c.exit_code` is not a pytest non-test exit (2, 3, 4, or 5 = no tests collected). S41-08 records `exit_code` (+2 core lines). Without it, collection errors would buy top-model rounds.
6. It reproduced: the same `c.name` failed in the previous verify after one cheap fix round, or it failed in both parallel attempts.

Only then does a fix round run on the top model. With `MAX_FIX_ROUNDS = 2` (types.ts:25), a single attempt escalates in round 2 at the earliest. When both attempts failed the same check, escalation comes in round 1.

**Attempt selection (two attempts).**
- **Shared set S** = sealed Wall tests plus `impacted(testmap, changed_A plus changed_B)`, keeping only tests that exist at baseSha.
  - Each attempt is scored in the primary tree, in turn: apply its diff, run S, reset (S41-12).
  - An attempt is never scored in its own worktree: that worktree has no untracked task `.venv`, and a shared editable venv would test attempt A's `src/`.
- **Disqualify an attempt when:** its session was killed or ended in error; its diff is empty (without already_done evidence); or its diff edits or deletes an existing test function or a Wall file (seal.ts weakened-test rule).
- **Rank lexicographically:**
  1. Wall passes, descending.
  2. Deterministic-fail count in S (conditions 1 to 3 and 5), ascending.
  3. Pass count in S on the project interpreter, descending.
  4. Flaky count, ascending.
  5. Lint fails, ascending.
  6. Diff size (added plus deleted non-blank lines), ascending.
  7. Attempt index, ascending.
- **Early accept:** the first finished attempt with S non-empty and every S and Wall check `pass` is accepted, and the other session is killed. The killed session is still priced (partial-stream).
- **Gate:** two attempts only for size `normal` when the predicted S (Wall enabled, or impacted tests from named or relevant files) is non-empty. With no selector there is no second attempt.
- **Fallback:** if both attempts are disqualified, keep A. Verify and Seal decide as usual.

## 5. Slice cards

Each card lists: goal; files; Wall check (red first, then the eval measurement); tier and budget; dependencies; net core lines.

### Wave 1 (start now: measurement, harness fixes, moat P0; 7 cards, disjoint files)

**S41-01 Harness: cost, knobs, row fields.**
- Goal:
  - (a) `provider_cost` accepts `cost_source` of `provider` or `partial-stream` and records `cost_partial_usd`.
  - (b) The allowlist gains `LOKI_E10_CASCADE`, `_TOP_MODEL`, `_ATTEMPTS`, `_TRIM`, `_PREFIX`, `_CONTEXT` and `_WALL_PARALLEL` now, so no later card touches harness.py.
  - Rows gain: `tier` (from `_task_tier`); `tokens{input, cache_read, cache_write, output}` (raw from `arm_stdout` usage, v10 from `cost` events with a `by_stage` split); `first_turn_prompt_tokens` from result-cost files when present; and `escalations` and `attempts` from events.
- Files: eval/loki10/harness.py, eval/loki10/test-harness.sh.
- Wall check:
  - Red first: a fixture efficiency dir with one partial-stream record gives `cost_usd` None before the change and a number after. `LOKI_E10_CASCADE=0` reaches `arm_env` output.
  - Positive controls: pricing the preserved E-98f null row (e98f-engine/default-r1/pub-werkzeug-3121, `iteration-2.json` usd 0.0628) gives non-null, and re-pricing all three preserved E-98f arms from e98f-engine gives the first full cost table (deliverable; no eval spend). It decides whether "cheapest capable model" survives: nocascade's unreliable lower bound ($0.32) sits below default's ($0.70). The token harvest over ev15-raw-claude-r1/r2 and ev15-engine reproduces 4.79M raw and 9.23M v10-implement cache reads (MEDIUM-ANALYSIS section 4) to within 1%.
- HIGH (measuring instrument); 30 min. Dependencies: none. Core: 0.

**S41-02 Scorecard tool.**
- Goal: `eval/loki10/scorecard <label=results.jsonl>... [--append docs/v10/METRICS.md]` prints one table per tier, per section 2.
- Files: eval/loki10/scorecard (python; imports harness `dedupe` and `nearest_rank`), eval/loki10/test-scorecard.sh.
- Wall check:
  - Red first: synthetic rows cover every mark colour, n/a-is-red, and refusal on unequal task sets or harness hashes.
  - Positive control: replaying the preserved E-98f files reproduces 15/21 at 209s, 16/21 at 214s and 15/21 at 138s. Replaying EV-15 reproduces raw 10/14 and v10 9/14.
- MEDIUM; 30 min. Dependencies: none (reads the S41-01 fields when present). Core: 0.

**S41-03 Arm runner plus auth guard (fixes c).**
- Goal: `eval/loki10/scorecard-run.sh --tier T --n N --arms raw-sonnet,raw-opus,loki-sonnet,loki-opus --out DIR`.
  - Runs arms back to back with pinned ids (section 3), the same `--parallel` for all, and one `--out` per rep.
  - Before each arm and rep it reads only the keychain `expiresAt`, never the token. If fewer than cap x ceil(tasks/parallel) + 600 s remain, it waits until expiry is under 300s, runs one operator `claude -p ok --model claude-haiku-4-5` to force a refresh, and re-reads.
  - Documents the arms in README.md.
- Files: eval/loki10/scorecard-run.sh, eval/loki10/test-scorecard-run.sh, eval/loki10/README.md.
- Prefers `ANTHROPIC_API_KEY` when set (`arm_auth` already takes it first). The under-300s refresh threshold is unverified (E-98f saw no refresh at about 415s), so the card starts with one live check of `expiresAt` before and after the operator call.
- Wall check: red first, a stub `security` and `claude` with expiry 900s shows the wrapper waits, refreshes and never starts run.sh early. A dry run prints the 4 pinned commands.
- HIGH (auth); 30 min. Dependencies: none. Core: 0.

**S41-04 First-turn prefix measurement.**
- Goal: the SDK stream parser records the first assistant message's `input + cache_creation + cache_read` as `first_turn_prompt_tokens` in the result-cost file.
- Files: loki-ts/src/runner/sdk_stream_parser.ts and its test under loki-ts/tests/runner/.
- Wall check: red first, a 3-message fixture stream gives the first message's sum, not the total. Then one loki-sonnet run of 1 small and 1 medium task records the per-stage prefix in METRICS.md.
- LOW; 15 min. Dependencies: none. Core: 0.

**S41-05 Attempt-selection rule (pure function).**
- Goal: `selectAttempt(attempts, S, wall)` in e10ext/select.ts, implementing section 4 exactly. Adds the e10ext cap to budget.test.ts.
- Files: loki-ts/src/e10ext/select.ts, loki-ts/tests/e10ext/select.test.ts, loki-ts/tests/engine10/budget.test.ts.
- Wall check: red first, one test per rank key, per disqualifier, for early accept and for "attempt-authored test ignored". Mutating any key order turns a test red.
- MEDIUM; 30 min. Dependencies: the section 1 ruling. Core: 0.

**S41-12 Tree swap helper.**
- Goal: `snapshotDiff`, `resetToBase` and `applyDiff` in e10ext/treeswap.ts, for the primary tree.
  - Covers tracked and untracked files; excludes `.loki/`, `.venv/`, `venv/` and the attempts dir.
  - Snapshots are in memory or under runDir, never `git stash` (the stash stack is shared across worktrees).
  - Attempt worktrees live under `<runDir>/attempts/` and are removed by exact path.
- Files: loki-ts/src/e10ext/treeswap.ts and its test.
- Wall check: red first, a round trip over a fixture with a modified, a new and a deleted file plus a venv restores the tree byte for byte, and `git status` is clean after reset. A mutation that skips untracked files goes red.
- HIGH (it feeds what Seal sees); 45 min. Dependencies: none. Core: 0.

**S41-16 P0: Wall red-on-base is vacuous without `python` (confirmed).**
- Found: wall.ts `RealBaseTestRunner` runs `RUNNER_CMD.pytest = "python -m pytest -q <files>"` through `/bin/sh`; any throw counts as `fail`. On this host `command -v python` finds nothing and `/bin/sh -c 'python -m pytest ...'` exits 127, so every pytest Wall test "fails on base" by launch error: red-first is vacuous and the clean-base `already_satisfied` path can never fire. It also skips the task venv (E-98a's verify defect, still live in Wall).
- Goal: the base runner uses verify `runnerCmd` (project interpreter first); a missing tool or exit 127 is `not_run`, which refuses the seal (NOT PROVEN), never counts as red. Delete the `RUNNER_CMD` table.
- Files: loki-ts/src/engine10/stages/wall.ts and its test.
- Wall check: red first, with no `python` on PATH and a `.venv` shim, a Wall test that passes on base is sealed today and refused after; with no interpreter at all the result is not_run. Eval: medium n=2, report Wall seal count against E-98f.
- HIGH (moat); 30 min. Dependencies: none. Core: -3.

### Wave 2 (after S41-01 to S41-04 merge; 5 cards)

**S41-06 Baseline scorecard (eval only).**
- Goal: run small and medium, n=2, all 4 arms through S41-03, and append the "before" tables through S41-02. This is the reference for every later card.
- Files: docs/v10/METRICS.md.
- Wall check: every row has a non-null cost, or the table says n/a with the row ids. Raw rows are reused later only while the harness hash matches.
- MEDIUM; 90 min of eval. Dependencies: S41-01 to S41-04. Core: 0.

**S41-07 Plan on the cheap model.**
- Goal: with the cascade on, plan pins `model: cascadeImplementModel()`, the same pin Wall and intake already use (wall.ts:139, already_done.ts:177).
- Files: loki-ts/src/engine10/stages/plan.ts and its test.
- Wall check: red first, a session-options test shows the plan model is sonnet under `LOKI_MODEL_OVERRIDE=claude-opus-5-5`. Eval: loki-opus on medium, n=2; plan cost per run down at least 60% against S41-06, completion not lower.
- MEDIUM; 15 min. Dependencies: S41-06 for the eval. Core: +1.

**S41-08 Top model and deterministic-failure escalation.**
- Goal: `LOKI_E10_TOP_MODEL` (an alias, default `opus`, through `resolveModelAlias`) replaces `ctx.model` as the escalation target. `isDeterministicFailure(prevVerify, verify, baseTests, wallPaths)` in e10ext/escalate.ts implements section 4. verify.ts records `exit_code` per check.
- Files: loki-ts/src/e10ext/escalate.ts, loki-ts/src/engine10/stages/fix.ts, loki-ts/src/engine10/stages/verify.ts, and their tests.
- Wall check:
  - Red first: flaky, not_run, lint, system-interpreter, exit 5 and attempt-authored failures never escalate. A reproduced project-interpreter fail escalates in round 2, and loki-sonnet reaches opus where today it cannot.
  - Eval: loki-sonnet on medium, n=2; report the escalation rate and the cost share of escalated rounds.
- HIGH (verify); 45 min. Dependencies: S41-06. Core: +4.

**S41-09 Lean stable prefix (flag).**
- Goal: `LOKI_E10_PREFIX=lean` gives engine10 sessions a short fixed string system prompt instead of the `claude_code` preset. The tool list is unchanged.
- Files: loki-ts/src/runner/providers.ts and its test.
- Wall check:
  - Red first: the options test shows `systemPrompt` is a string under the flag and the preset without it.
  - Eval: `first_turn_prompt_tokens` down at least 40% on every stage; completion on medium, n=2, not below S41-06.
  - Kill criterion: if S41-04 shows the prefix is under 10% of implement cache reads, close with the measurement and build nothing.
- MEDIUM; 30 min. Dependencies: S41-04. Core: 0.

**S41-14 Wall in parallel with implement (item 4, promoted for speed).**
- Goal:
  - FLOW becomes `intake, plan, [wall, implement], verify`.
  - Wall still writes only in its temp dir. Its copy-in and its red-on-base check run after implement completes: snapshot, reset to base, run the Wall tests (they must fail), restore.
  - The `already_satisfied` short-circuit moves to that post-implement check.
- Files: loki-ts/src/engine10/machine.ts, loki-ts/src/engine10/stages/wall.ts, and their tests.
- Wall check: red first, implement's `stage.started` precedes Wall's `stage.completed`, sealed sha256 values are unchanged, and a Wall test passing on base is still refused after the move. Eval: medium p50 not worse than S41-06, completion not lower, and report Wall's share of wall-clock. E-98f argues against a big win: nowall p50 214s against default 209s, nocascade (opus implement) 138s, so the time is in implement, not Wall.
- HIGH (moat: the red-first Wall); 45 min. Dependencies: S41-12, S41-16. Core: +6.

### Wave 3 (2 cards)

**S41-10 Relevant context and a static-first brief.**
- Goal: the implement and fix briefs:
  - put the fixed rules first, as a block that is byte-identical across stages and runs;
  - replace the first 200 repo paths (`repoMapText`) with up to 20 relevant files: plan `relevant_files`, else `selectRelevantFiles` over the tree-keyed cached map (cache.ts `repomap-<tree>.json`);
  - add their impacted tests, with one exact command per test from verify `runnerCmd` (project interpreter included).
- Files: loki-ts/src/e10ext/context.ts, loki-ts/src/engine10/stages/implement.ts, loki-ts/src/engine10/stages/fix.ts, and their tests.
- Wall check: red first, the brief for a 2,000-file fixture is under 3 KB and names `.venv/bin/python -m pytest -q <test>`. Eval: loki-sonnet on medium, n=2; implement cache reads per completed down at least 30% against S41-06, completion not lower.
- MEDIUM; 30 min. Dependencies: S41-08 (fix.ts). Core: +1.

**S41-11 Rule-based trajectory trimming (flag).**
- Goal: `LOKI_E10_TRIM=1` adds a PostToolUse hook that returns `updatedToolOutput`. It only shortens new results; rewriting history would break the cache prefix and is out of scope.
- Rules:
  - A Bash result over 200 lines keeps the first 40 and the last 120, plus a `[loki trimmed N lines]` marker.
  - A Read over 400 lines keeps the first 400.
  - A Grep over 100 matches keeps the first 100.
  - From tool call 25 on, the limits halve.
  - A Bash command that exits nonzero always keeps its last 120 lines.
- Files: loki-ts/src/runner/trim.ts, loki-ts/src/runner/providers.ts, and their tests.
- Wall check: red first, each rule, the nonzero-exit tail guarantee, and unchanged pass-through when the flag is off. Eval: implement cache reads per completed down at least 25% on medium, n=2, completion not lower.
- MEDIUM; 30 min. Dependencies: S41-09 (providers.ts). Core: 0.

### Wave 4 (1 card)

**S41-13 Two parallel attempts (flag).**
- Goal: with `LOKI_E10_ATTEMPTS=2`, implement runs 2 cheap-model sessions concurrently when the section 4 gate allows.
  - A runs in repoDir; B runs in a detached worktree at baseSha under runDir.
  - Each is scored in the primary tree through S41-12. S41-05 picks the winner, which is applied to repoDir. Verify and Seal then run as today.
  - A check that failed in both attempts feeds S41-08 condition 6.
- Files: loki-ts/src/e10ext/attempts.ts, loki-ts/src/engine10/stages/implement.ts (hook), and their tests.
- Wall check:
  - Red first: fake sessions cover early accept, full ranking, the both-disqualified fallback, and gate-off with no selector. For a run with a killed attempt, the sum of `cost` events equals the harness `cost_usd`.
  - Eval: loki-sonnet on medium, n=3 (E-98f's n); completion at least 18/21 (raw's best rate, EV-14), and the tier verdict not red on cost.
- HIGH; 45 min. Dependencies: S41-05, S41-08, S41-10, S41-12. Core: +6.

### Wave 5 (1 card)

**S41-15 After scorecard and defaults.**
- Goal: rerun S41-06 with every flag. Flip a flag's default in `sizing.ts` only when the tier verdict with it is at least as green as without it, on both small and medium.
- Files: loki-ts/src/engine10/sizing.ts, docs/v10/METRICS.md.
- Wall check: the before and after tables sit side by side in METRICS.md. The D41 flip happens only on green for small and medium. The headline row (loki-sonnet against raw-opus) is reported either way.
- HIGH (default flow); 90 min of eval plus 15 min of code. Dependencies: all of the above. Core: +3.

**Core total:** -3 +1 +4 +6 +1 +6 +3 = +18 of 35 headroom. A card over its estimate offsets the excess in the same slice (D33). **Wave counts:** W1 7, W2 5, W3 2, W4 1, W5 1 (16 cards). Only S41-06 and S41-15 are eval-only.

## 6. Risks

- **Seal accuracy (top risk).** S41-12, S41-13 and S41-14 change which tree Seal sees and when the Wall is proven red, so a treeswap bug could seal an unverified tree. Guards: verify and Seal always re-run on the final primary tree; Seal's sha256 check on Wall files is unchanged; red-on-base stays mandatory, only later; each card carries a mutation test that must go red.
- **Wall red-on-base is vacuous today (S41-16).** Until it merges, Wall seals on this host prove nothing about red-first; S41-14 must not move the check before S41-16 lands.
- **Cost measurement.** Partial-stream dollars are estimates: the share is shown, and over 20% is flagged. Attempts and killed sessions write cost from two cwds; S41-13's event-sum check guards this. Without S41-01, every null row keeps cost red forever.
- **Attempts can raise cost.** Implement is already 69% of v10 spend. Two attempts pay off only if S41-10 and S41-11 cut per-attempt reads first and early accept often kills B. S41-15 keeps the flag off unless the verdict says otherwise.
- **p50 comparability.** E-98f ran up to 12 concurrent sessions against EV-15's 3. The scorecard refuses unequal `--parallel`, arms run back to back, and keychain waits fall outside the timed rows.
- **Noise.** At n=21 one run flips a mark; the table prints n. **Escalation starvation:** condition 6 delays opus to round 2; the eval reports the share of round-2 wins that escalation bought.
- **Accuracy regressions from trimming and a lean prefix.** Both are flags with completion floors in their Wall checks. Trimming never cuts a failing command's tail.

## 7. Later waves (items 3 to 5, sketches only)

**Item 3, repo memory.** Extend cache.ts's per-repo dir (maps already keyed by tree) with the verified build and test command per runner (the one that ran on the project interpreter), the flaky list (`recordFlaky` exists), the top failure causes (`topFailures` exists, but only the brief reads it) and conventions mined from accepted diffs. Inject one fixed-size block into S41-10's static-first brief. Measure cold against warm: the same task twice, cache wiped then kept; warm must be cheaper and faster on the scorecard.

**Item 4, speed.** Wall in parallel is S41-14. Still to do: cache dependency install by lockfile hash (venv or node_modules restored by `sha256(lockfile)`), keep fast verify to impacted tests only with a cap on the changed-test-files list, and pipeline plan into implement on the lean path. Target: p50 at or below raw on every tier.

**Item 5, backlog throughput.** `loki <label|milestone>` fetches N issues (fetch_issue.ts) and runs one supervisor per issue, each in its own worktree with a single writer, opening one PR per issue. Total spend and concurrency are bounded by the D39 usage governor. Measure issues per hour and cost per merged PR against raw run serially.
