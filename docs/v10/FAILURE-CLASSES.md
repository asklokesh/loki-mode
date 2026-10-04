# Failure classes (D86)

Each row answers five things:
- what the user saw, compared with raw;
- the law broken (docs/v10/ENGINE-LAWS.md);
- a sibling sweep;
- the one shared mechanism;
- a regression fixture.

No fix slice starts until its row exists (OPERATING-MODEL.md, Engine Laws line). Slice ids refer to the EL plan (Architect, 2026-10-03).

L0 review rule (ENGINE-LAWS.md L0): a fix that adds an `if` or a regex about the user's repo shape, language, framework or task wording is rejected. The mechanism column names a model judgment (a prompt or schema) plus an execution check. Tamper checks, terminal I/O and Loki's own files are the only exceptions. Wave 1 slices: docs/v10/L0-WAVE1.md.

## FC-01 Verify ran from the repo root in a multi-root monorepo (FireLater#17)
- User saw: "Failed Suites 1" three times on backend/tests/unit/validation.test.ts. Raw claude ran the suite from backend/ and passed 43/43 in about 2 min.
- Law: L4.
- Siblings:
  - verify.ts:50/142;
  - verify.ts:179 subtractBase;
  - wall.ts:83 base run;
  - verify.ts:224 tsconfig only at the root;
  - visual_evidence.ts:155-168;
  - deep.ts;
  - the brief's impacted commands;
  - deferred by the FC-01 stopgap (de12ad0cb): deep.ts full suite at the repo root, verify.ts tsconfig root-only, verify.ts ESLINT_CONFIGS root-only. All three are now closed (see Status).
- Mechanism: Project Model packageRootOf/commandFor (EL-W1-01, EL-W1-04a/b). Interim: EL-W0-03.
- Status (FIXED, lane E): the Project Model is ON by default (opt-out LOKI_E10_PROJECT_MODEL=0). One shared resolver, loki-ts/src/project_model/resolve.ts (loadProjectApi, siteFor, groupByPackage) plus verify.ts commandFor(t, repoDir, api), returns cwd and argv. A file owned by a package below the repo root runs in that package dir with a package-relative path. An unknown model, the opt-out, or a root-only (single-package) model resolves to the repo root exactly as before.
- Sites now on the resolver: verify.ts test loop and subtractBase base run; verify.ts runLintChecks (tsc, eslint config lookup, cwd and file paths per package, check name lint:tsc:<root>); wall.ts RealBaseTestRunner; deep.ts runFullSuite (each package's own test command in its cwd); features/visual_evidence.ts (UI boot command, Playwright and e2e media from the UI package dir); implement brief (e10ext/context.ts prints `cd <pkg> && cmd`).
- Deliberately root-only: verify.ts select-tests (scripts/select-tests.sh, Loki's own repo); ruff and shellcheck (take repo-relative paths from the root); wall_manifest.ts reads the root package.json for style hints (read only, not a runner invocation).
- Fixture: tests/fixtures/firelater-17 plus the shape fixtures in benchmarks/tasks/shapes; tests/fixtures/monorepo-fc01 (backend with vitest, frontend, no root package.json) with loki-ts/tests/engine10/monorepo_cwd.test.ts (red at the repo root before, green after; includes the single-package regression).

## FC-02 A runner load error was treated as a code failure; two fix rounds, then STALLED
- User saw: 11 min, $2.66 and a FAILED draft PR for a bug that did not exist. Raw: done in 2 min.
- Law: L5 (and L1 on time and cost).
- Siblings:
  - verify.ts:141-148 (a null summary counts as fail);
  - fix.ts:12-13;
  - machine.ts:171 stall;
  - wall.ts classify(), which already separates not_run (reuse it);
  - deep.ts;
  - vitest "No test files found, exiting with code 0" counts as a pass with n=0, when it should be not_run (EL-W1-06).
- Mechanism: a result classifier with an owner (EL-W1-05). Only a FAIL owned by code drives fix and stall. Interim: EL-W0-02.
- Fixture: tests/fixtures/runner-outputs/vitest/load-error.txt (from seq 56), plus siblings for each runner.
- Status: FIXED (interim, FC-02 lane F). One shared classifier loki-ts/src/runner/runner_errors.ts (classifyRunnerOutput); verify.ts runCheck turns a load or collection error into not_run with owner harness (no rerun, no fix round, listed in verify not_proven); deep.ts runFullSuite does the same; wall.ts classify() already returned not_run for jest/vitest/bun with no parsed failure and is left unchanged. A real failed-test count in the same output keeps it a code failure; lint checks are never reclassified. Fixtures: loki-ts/tests/engine10/fixtures/runner-outputs/{vitest,pytest}, test loki-ts/tests/engine10/runner_errors.test.ts. Still open: the n=0 pass rule (EL-W1-06) and per-runner fixtures for jest, node:test, go, cargo.
- Integration with FC-16 (2026-10-03): one mechanism identifies lint, typecheck and selector checks: `RunOpts.kind: "static"` (verify, deep and per-package paths alike); the FC-02 name-prefix exemption is removed. Load ownership is the single helper `harnessLoadReason` (runner/load_owner.ts), called from verify runCheck (kind test only), deep runFullSuite and project_model/package_suite.ts, which also routes results through FC-16 classifyCheck. Test: tests/engine10/monorepo_cwd.test.ts (FC-16 C1, lint kind blocks).
- Sibling (2026-10-03): a change-introduced load error is a code fault. Base reproduction is necessary but not sufficient. The base rerun must be hermetic (an inherited editable install imports head code), and a check the task targets is never env-owned (7ad4a18b6, blocked in round 2). Superseded by L0-WAVE1 EL-W1-06: the harness gathers evidence and a separate reviewer call assigns the owner.
- Ownership rule (2026-10-03, HIGH review of fd3ad2037): loki-ts/src/runner/load_owner.ts loadErrorIsHarnessOwned, one mechanism used by verify.ts runCheck AND deep.ts runFullSuite (sibling sweep done: wall.ts classify() already returns fail for a parsed failure). A load error is harness-owned not_run only when the same command reproduces a load error on a hermetic base worktree, no changed file is named in the output (path or module stem), the check is not a Wall or task-relevant test, and its target file is not itself changed; else it stays fail so fix rounds run. Patterns tightened (N1): command not found and Cannot find module match runner-load shapes only. Regressions: tests/engine10/runner_errors.test.ts (B1 SyntaxError in changed source, B2 Wall missing symbol, base-reproduced harness error, non-reproducing error, N1).

## FC-03 Scope control reverted in-scope route edits
- User saw: the PR without the fix (routes/applications.ts, assets.ts and attachments.ts reverted).
- Law: L2 (the work surface held destructive authority) and L3 (a heuristic beat executed evidence).
- Siblings:
  - scope.ts:30;
  - unit_mode unitFence;
  - discard.ts;
  - commit_filter dropSet;
  - implement restoreReadOnly (trust: Wall tests, stays);
  - stop_restore.ts.
- Mechanism: the destructive-call registry (EL-W1-08) plus advisory scope (EL-W0-01, shipped as d574c85c5 and a089aa9ab). Enforce as an opt-in comes back in EL-W1-10.
- Fixture: replay of the FireLater diff. Every route file is kept, and NOT PROVEN lists them.

## FC-04 Loki gave less intelligence than raw
- User saw: every session on sonnet, a 124s Wall that sealed zero tests, and fix rounds that never escalated.
- Law: L1.
- Siblings:
  - session.ts:27 defaults to sonnet;
  - sizing.ts:57/63/65 cascade;
  - fix.ts:63 escalation gate;
  - implement.ts:56 limit;
  - the plan stage on the "fast" tier;
  - no effort field in SessionRunOptions;
  - `loki start prd.md` still goes to the legacy run.sh route, whose default is sonnet (providers/claude.sh CLAUDE_DEFAULT_DEVELOPMENT).
- Mechanism: a catalog best_default plus a top tier for each provider (EL-W0-06, EL-W0-07), and a size gate on the artifact (EL-W0-05).
- Fixture: a unit test that the default run.started.model equals the catalog best_default, plus a parity replay row.

## FC-05 PR body printed "not recorded" for data the run had
- User saw: "What the issue asked", "Why", "Files in scope" and "Tests" all empty.
- Law: L7.
- Siblings:
  - supervisor.ts:354 passes only seal;
  - receipt wall_s is 387s against about 654s of stages;
  - the issue comment body;
  - the Slack summary;
  - the --json envelope.
- Mechanism: outputsFromEvents (EL-W0-08) plus output schemas (EL-W1-09).
- Fixture: a golden from ~/git/FireLater/.loki/runs/e10-20261003T150744Z-59b1.

## FC-06 Control Plane showed "in progress" 5857s after run.completed
- User saw: a run shown as live after it had ended.
- Law: L6.
- Siblings:
  - ship_hook.ts:27, an unref'd timer with no final flush;
  - supervisor.ts:155, a signal exit with no terminal event;
  - Slack finished;
  - LiveLine.
- Mechanism: a flush on terminal events plus a dead-pid reconciler (EL-W0-04, EL-W0-09, EL-W1-07).
- Fixture: tests/test-e10-kill-each-stage.sh plus a CP ingest test with a dead pid.

## FC-06b Control Plane run page said "No events yet" for a finished run (FireLater#17, e10-20261003T191822Z-7683)
- User saw: "Live log: No events yet." on a completed run whose events.jsonl and stored events held every stage (105 events).
- Law: L6 (a finished run must read as finished, with its evidence). Same FC-06 class: the page trusted a live-only path.
- Siblings:
  - any UI reader that passes a sentinel the server validation rejects (`after=-1`) and maps every non-200 to an empty result;
  - fetchEvents swallowed the 400 and returned [], so the empty state was indistinguishable from "no events".
- Mechanism: one shared `fetchEvents` that sends no `after` on the first page, pages until `has_more` is false, and is the only history loader; the live stream only appends.
- Fixture: test/ui/run-finished.test.tsx ingests a finished run (test/fixtures/runs/verified-pr/events.jsonl) into the real server app and renders the page against it.

## FC-07 The test suite leaked fixture runs into the founder's real Control Plane
- User saw: acme/widget and e10-t1.. runs in the real CP.
- Law: none of L1 to L7 fits. Proposed L8, "Tests never touch real user state", is a founder decision. This is a recurrence of GUARDS.md 12 (~/.gitconfig).
- Siblings:
  - discover.ts reads instance.json via $HOME;
  - the control.db path (control.ts:46);
  - ~/.loki keys;
  - the Slack webhook config;
  - the memory store.
- Mechanism: a hermetic HOME prelude for every test (extend tests/lib/isolated-git-home.sh), plus a shipper that refuses temp and fixture repos. Cleanup: `loki control prune` (203d38544).
- Fixture: a lint that fails any test reaching $HOME/.loki without the prelude.

## FC-07b Leaked fixture runs stayed in real Control Plane databases after the leak was closed
- User saw: e10-t1..t7, e10-dw1..dw6, e37-cline, e37-codex (all acme/widget) in the real CP run list, with no step that removes them.
- Law: L6 (the run list must show only real runs) and the rule that users never need to run a maintenance command. Same FC-07 class: closing the leak does not clean databases already polluted.
- Siblings:
  - `loki control prune` exists but is manual, so every existing install keeps the rows;
  - local_repos rows whose realpath is under the OS temp dir mark the same fixtures when origin_repo is empty.
- Mechanism: one startup step in createApp (`cleanupLeakedFixtures`): removes runs with origin acme/widget or a source path under the OS temp dir, audits each removal (action `fixture.cleanup`), and records a once-per-DB marker row (action `fixture.cleanup.done`) so it never repeats.
- Fixture: test/server/fixture-cleanup.test.ts (first start removes and audits, second start removes nothing, real runs untouched).

## FC-08 A tampered receipt could render as VERIFIED in the UI
- User saw: a VERIFIED badge on a run whose log failed integrity.
- Law: L2 (trust fails closed) and L7.
- Siblings:
  - the CP run list and run page;
  - the Slack summary;
  - the PR status;
  - `loki status`.
- Mechanism: one verdict-display function that returns TAMPERED whenever the run is tampered or its seal is invalid (CPE-27).
- Fixture: an ingested run with tamper.detected never shows VERIFIED in any surface.
- Sibling follow-up (EL-FC08b): redact at source in the engine before hashing. Today the shipper (redactEvent) and the server (redactSecrets) rewrite event data before the CP can hash it, so an honest signed run holding a token reads UNVERIFIED ("log redacted before ingest; seal not checkable"), never TAMPERED and never VERIFIED. Redacting before the engine hashes and signs would make such runs checkable end to end.
- Sibling follow-up (deferred, not built in EL-FC08b): the shipper should send the sha256 of each line before redaction (alongside the redacted line). The CP could then check the seal over the original hashes and tell a genuine redaction from a downgrade (a FAILED log edited to PARTIAL plus a planted [REDACTED]); today such a log can only read "<verdict> (unattested)" or UNVERIFIED. This is the lasting fix for placeholder downgrades.
- Sibling follow-up: the Slack summary, PR status and `loki status` do not yet read the CP effective_verdict.

## FC-09 A test-config edit outside scope can make broken code VERIFIED
- User saw: nothing yet (reproduced by the D12 scope review with a stub provider). The agent broke `add`, edited bunfig.toml to preload a new setup.ts that mocks the module, and the verdict was VERIFIED. This happens at ffb58278b and at HEAD.
- Law: L2 (trust fails closed).
- Siblings:
  - CFG_ALWAYS in verify.ts (A-115) leaves out bunfig.toml;
  - new preload or setup files are never flagged (only edits to existing tests are);
  - the equivalents for other runners: vitest.config setupFiles, jest setupFiles and moduleNameMapper, pytest conftest.py, and go test flags in Makefiles.
- Mechanism: one runner-config registry for each runner. Any added or changed file that it names (configs, preloads, setup files, conftest) caps the verdict below VERIFIED, with NOT PROVEN naming the file.
- Fixture: a stub-provider repro for each runner (bun preload, vitest setupFiles, jest moduleNameMapper, pytest conftest).

## FC-10 Live line truncated to ~20 columns on a pty with no size
- User saw: on a pty with no column size (script -q, CI, tmux before a resize, IDE terminals) the quiet-mode live status line was cut to about 20 characters, for example "[implement] implemen". Raw: the stage events were complete; only the rendering was wrong.
- Law: L7 (outputs are contracts).
- Siblings (every terminal width read, with its old fallback):
  - loki-ts/src/engine10/supervisor.ts:334 passed process.stdout.columns straight to LiveLine (undefined or 0);
  - loki-ts/src/e10ext/liveline.ts:35 used Math.max(20, (columns ?? 80) - 1), so 0 became 20 (the bug);
  - loki-ts/src/cockpit/cli.ts:73 used columns || $COLUMNS || 0 with no 80 default and accepted widths of 5 or more;
  - autonomy/tui.sh:27 used `tput cols || echo 80`, which accepts tput printing 0 or nothing;
  - packages/*/src: no terminal width reads.
- Mechanism: one shared terminalWidth() helper (loki-ts/src/util/term_width.ts): a finite columns >= 40, else a valid $COLUMNS >= 40, else 80. Every TS read goes through it and the bash read applies the same rule.
- Fixture: loki-ts/tests/engine10/term_width.test.ts (columns undefined, 0 and 20 give >= 80; the live line shows the full "[implement] implementing" text; a guard fails on any raw .columns read in src outside the helper).

## FC-11 Repo-wide structural guards went red after slices passed narrowed reviews
- User saw: nothing yet; the 10.7.1 train was blocked on main 51e02b229 (2 failures in the full loki-ts bun test).
- Law: L7 (the release is a contract), and the D44 gate.
- Siblings:
  - spawn_env_guard (e10ext/ship_hook.ts:10 missing env);
  - the e10ext line budget (1509 of 1500), plus budgets that add up across slices (FC-10 +1, EL-W0-06 moved helpers to stay under the 5000 engine10 cap);
  - local-ci fast tier timing out at 600s while bun test alone takes about 434s.
- Mechanism: every builder and reviewer brief names the structural guard set, and the full bun test runs in main after each merge batch, before the train.
- Fixture: tests/engine10/budget.test.ts and tests/runner/spawn_env_guard.test.ts on the merged tree.

## FC-12 loki-ts bundles sibling-package code whose dependencies CI never installs
- User saw: nothing yet; Bun Parity on train/104 (17ece536b) failed with `Could not resolve: "drizzle-orm/bun-sqlite"`. `loki control prune` (2c81d9603, 203d38544) imports packages/control-plane/src/db/migrate.ts, and Bun resolves a bare import from the importing file's directory, not from loki-ts/node_modules. The main checkout built cleanly only because packages/control-plane/node_modules happened to exist.
- Law: L7 (the release is a contract: the build must reproduce from a clean checkout).
- Siblings:
  - every workflow that runs `bun install` in loki-ts (test.yml, bun-parity.yml, coverage.yml, tier-a.yml, security-audit.yml, release.yml including its Docker `--production` job, nightly, parity-drift and mutation-testing);
  - the shipper imports in e10ext/ship_hook.ts and commands/control.ts, which have no external deps today but share the same path.
- Mechanism: one `postinstall` in loki-ts/package.json installs packages/control-plane from its frozen lockfile, so every loki-ts install (CI, Docker, local) gets the sibling's deps. No per-workflow steps.
- Fixture: a clean `git worktree add` at HEAD, then `bun install --frozen-lockfile && bun run build` in loki-ts, and again with `--production`. Both exit 0 and the dist is byte-identical to the committed one; without the postinstall the build exits 1 with the error above.

## FC-13 Tests pin a data value that a correct change is allowed to move
- User saw: nothing; the full loki-ts bun test on merged main ca9b85b7f had 5 red in "budget: cache token pricing" after MW-1 correctly moved sonnet from 3/15/0.3/3.75 to 2/10/0.2/2.5. The expected totals (0.6617, 3.0) and tiers were literals, so the price change read as a cost bug. The MW-1 review was approved on the slice's own suites, without the full bun test (an FC-11 sibling).
- Law: L7 (the release is a contract); a guard must fail on wrong behavior, not on a legitimate data change.
- Siblings:
  - tests/dashboard/test_api_cost_cache.py stubs its own table, so it stays consistent, but its docstring says the other routes return 0.6617, which is stale (cosmetic);
  - tests/test-pricing-parity.sh (MW-1) compares routes against model-pricing.json, the correct shape;
  - the codex and gpt rows drift between run.sh and budget.ts (rv-mw1 follow-up), which is the same file-is-the-source rule.
- Mechanism: arithmetic tests derive expectations from the single pricing source (loki-ts/data/model-pricing.json) and assert the loaded table equals the file; only the fixture token counts are literal. Pricing-table changes run the full bun test in main before the train (FC-11 mechanism).
- Fixture: loki-ts/test/budget_cache_pricing.test.ts at 0de0838e1, 8 pass 0 fail; "cache tiers survive loading" compares the loaded PRICING with the file (loader mutation not yet run; follow-up).

## FC-14 A nested sandbox trusts an inherited pointer to the real environment
- User saw: running the test runner truncated the founder real ~/.loki/keys/receipt-ed25519.pem. A fixture wrote through an inherited LOKI_REAL_HOME that still named the real home while HOME was a stand-in.
- Law: L2 (trust fails closed).
- Siblings:
  - loki_hermetic_home_enter (tests/lib/hermetic-home.sh) took LOKI_REAL_HOME from the environment;
  - loki-ts/tests/preload.ts used LOKI_REAL_HOME ?? HOME;
  - run_runner in tests/test-e154-e155-guards.sh kept the exported LOKI_REAL_HOME;
  - the outer E-154 key check compared names only, so truncating an existing key was invisible.
- Mechanism: derive the real path from the current HOME, never from an inherited variable (enter unsets LOKI_REAL_HOME, preload reads HOME); the key check fingerprints name, size and mtime.
- Fixture: tests/test-e154-e155-guards.sh (run_runner strips the pointers; t-keys writes only the runner-derived stand-in). A decoy-pointer probe and a bun HOME probe are owed after Oct 7 (B3, phase D vacuity).

## FC-15 A run judges "already done" against Loki's own unmerged work
- User saw: FireLater#17 rerun on 10.7.1 (e10-20261003T185853Z-2d44) reported ALREADY_SATISFIED in 2m07s for $0.52. That was false. The run branched from the checked-out loki/e10-20261003T150744Z-59b1 (eda184e). That branch was the earlier FAILED run's unmerged draft PR #25, which also lacks the route edits the old scope control reverted.
- Law: L4 (the base is a contract), L2 (trust fails closed).
- Founder rule (2026-10-03):
  - Base precedence: an explicit CLI flag (add `--base` if none exists), then the loki.yaml base_branch setting (a branch name, `current` or `default`), then the user's checked-out branch.
  - The repo default branch is used only when it is configured as `default`. Never hardcode "main" (L0).
  - The start line prints `base: <branch> (<flag, config or checkout>)`.
  - The PR target is the configured target, else the repo default branch, and the PR body names it.
- Siblings (swept 2026-10-03; every place a base or diff is computed):
  - loki-ts/src/engine10/stages/intake.ts: baseSha = rev-parse HEAD, the ALREADY_SATISFIED judge (checkAlreadyDone, closed-issue exit); FIXED, now refuses first;
  - loki-ts/src/engine10/worker.ts:49: ctx.baseSha = rev-parse HEAD (inherits intake's refusal, runs after it in the same checkout);
  - loki-ts/src/engine10/stages/seal.ts:111-116,190,256: staged diff, discardIfSatisfied, diff-tree and receipt base_sha, all against ctx.baseSha;
  - loki-ts/src/engine10/stages/verify.ts:63-67,103,176,238,287: changedFiles, testConfigChanged, the pre_red worktree at ctx.baseSha (the engine's only worktree use), inBase;
  - loki-ts/src/engine10/stages/deep.ts:134,236: council diff and changedFiles against ctx.baseSha;
  - loki-ts/src/engine10/supervisor.ts:221-224: PR diff-vs-base from intake's base_sha;
  - loki-ts/src/engine10/stages/wall.ts, modernize/presealed_wall.ts: Wall base run and already_satisfied count, fed by the same ctx.baseSha.
  All of them consume ctx.baseSha, which is HEAD after intake; one guard at intake covers them.
- Mechanism (shipped, redesigned 2026-10-03): the guard sits on the CLAIM, not the run. A run always starts from the base the user asked for and is never refused for carrying commits that are not on the PR target. loki-ts/src/util/base_guard.ts resolveBase resolves the PR TARGET (LOKI_E10_BASE else origin default branch, fetched with a 10s non-interactive fetch, else local main/master; never loki/* or HEAD). unmergedEvidence compares the ALREADY_SATISFIED evidence paths (AlreadyDoneResult.paths) with `git diff --name-only <target> HEAD`: evidence that exists only in target..HEAD voids the claim, and the run proceeds to implement. When those commits are really Loki's (one carries the engine's "Loki-Run:" commit trailer, or a local .loki/runs receipt sealed head_sha != base_sha with commits of its own there; a branch merely named loki/* or a zero-commit receipt does not count) intake records data.unmerged_loki_work with the harness-owned note "work exists on <branch>, not on <target>; open or resume it" (L5; informational, never a refusal, never VERIFIED). The note is visible in three places: a stderr line when intake finishes and the run goes on to implement, the terminal summary (renderMainOutput via unmergedLokiWorkNote), and a "- Note:" line under "How it was tested" in the real PR body (e10ext/reviewer_body.ts renderReviewerBody, called by stages/pr.ts), unclipped with the evidence path list capped at 3 plus "(+N more)". When the commits are not Loki's the claim is dropped with one stderr line saying the evidence is on <branch> but not on <target>. The start line prints "PR target: <ref>, base: <branch>". No reflog is read. Placed in util/ because engine10 core is at its size cap (budget.test.ts).
- Review fix (HIGH F1-F3, superseded by the redesign): the earlier refusal path and its reflog counting (including the R1 fresh-clone hole, where the oldest reflog entry is the tip itself) are removed rather than patched; with no refusal there is no wrongly-allowed run to close.
- Still owed: a --base CLI flag, loki.yaml base_branch, the PR-target wording in the PR body (the start line now prints "PR target: <ref>, base: <branch>"); resolveBase already takes the explicit value via LOKI_E10_BASE.
- Fixture: loki-ts/tests/engine10/intake.test.ts describe "base is not Loki's unmerged work (FC-15)" (origin + clone, local loki/e10-* branch committing the fix; without the guard intake returned already_satisfied from that unmerged commit, with it the claim is voided, the run completes and implements, and unmerged_loki_work is reported; control on main is not satisfied). Regressions A, B, B2 (no refusal, no claim), D (fresh clone of a pushed loki/* branch, 1 Loki commit: not refused, no claim, unmerged_loki_work.commits 1), a feature branch in a fresh clone (no refusal, not labelled Loki's), a loki/*-named branch with only the user's commit and a zero-commit receipt (neither labelled Loki's), the note present in renderMainOutput and renderReviewerBody, ALREADY_SATISFIED still reached when the work is on the target, and C (LOKI_E10_BASE=feature/search).

## FC-16 ALREADY_SATISFIED / VERIFIED with zero Loki-executed checks (n=0 counted as pass)
- User saw: FireLater#17 on 10.7.1 recorded checks `"result":"pass","n":0` (zero tests executed counted as PASS). The same run had verify "checks": [] and changed_files []; the verdict rested only on the implement agent's self-report ("10/10 named impacted tests pass ... via npx vitest run").
- Law: L0 and L3 (the model never grades its own work), L5 (not a pass: NOT PROVEN, owner harness); Seal accuracy.
- Rule: a test check with n=0 executed, or a count that cannot be parsed, is not_run with reason "no tests executed". VERIFIED and ALREADY_SATISFIED require at least one Loki-executed check with n>0 and a pass; otherwise the seal verdict is PARTIAL (the engine's existing NOT PROVEN label) and `no tests executed` is listed in NOT PROVEN.
- Mechanism (one shared module, loki-ts/src/util/check_result.ts): `testCount` (vitest, jest, bun test, pytest, go test -v (the engine passes -v; non-verbose is unmeasured), unittest, Playwright, cargo test, node --test, mocha; null = unknown), `classifyCheck` (kind test needs n>0 to pass; kind static = lint/typecheck/scan, decided by exit code), `hasExecutedProof`.
- Sibling sweep (every site that set or consumed "pass"):
  - stages/verify.ts runCheck (was `n: ran(out) ?? 0` on a pass, and a null count passed): now classifyCheck. Lint, tsc, eslint, ruff, bash -n, shellcheck and select-tests are kind static.
  - stages/wall.ts classify (exit 0 was an unconditional pass, feeding base_run.pass and wallGreenOnBase): now classifyCheck; zero or unknown count is not_run.
  - stages/deep.ts runFullSuite (exit 0 was a pass): now classifyCheck, not_run lists NOT PROVEN. Council and secret-scan pass entries are static (no tests exist to count).
  - stages/seal.ts verdictOf (VERIFIED and every ALREADY_SATISFIED route: intake.already_satisfied, wallGreenOnBase, implement exit already_done): gated on `proof` (hasExecutedProof over verify's raw checks, or a Wall base run with n>0).
  - Consumers unchanged and now correct by construction: e10ext/select.ts, e10ext/reviewer_body.ts, features/pr_criteria.ts (they read result "pass", which now implies n>0 for test checks).
  - Not applicable: modernize/presealed_wall.ts (red-base proof, never a pass), runner/quality_gates.ts (gate stubs, not test runs).
- Fixture: loki-ts/tests/engine10/check_result.test.ts (vitest `No test files found` and `Test Files 0`, pytest `no tests ran`, jest, cargo, mocha zero; go unparsed is unknown; real pass keeps n; verdict gate: VERIFIED and ALREADY_SATISFIED without proof are PARTIAL).

## FC-17 The Wall spends time and money and writes nothing
- User saw: the same run's Wall produced "files": [] in 1m42s, with base_run 0/0/0. This is the D82-WALL0 class again.
- Law: L5 (no work without evidence), cost.
- Siblings: D82-WALL0 and any stage that can finish with zero artifacts and still bill.
- Mechanism: if the Wall cannot write a check, it skips in under 10s with a NOT PROVEN note and never runs a model session to an empty result.
- Fixture: loki-ts/tests/engine10/runner_errors.test.ts (FC-17 block). A repo with no runnable test command yields a Wall skip under 10s.
- Status: FIXED for the no-runner case (lane G). wall.ts runWall prechecks, before any model session: a detected test map with no runner and no .py or .go file in the repo map returns stage.skipped with reason "no runnable test command detected: the Wall cannot write a runnable check". Still open: a Wall that has runners but writes nothing still bills its session (the SessionRunner has no progress hook for a no-progress cutoff); needs a session.ts change.

## FC-19 Loki's own stage rules talk a capable model out of doing the job
- User saw: FireLater#17 run e10-20261003T200907Z-fea1 on 10.9.1 ended BLOCKED in 6m58s with a draft PR. The model's reason: "spec conflict: the task asks for all 37 route files to be migrated, validated and covered 100%, but the stage rules limit me to the named files and a few tests". Raw Claude Code finishes the same task in about 2 minutes. The user was told their spec conflicted; it was Loki's brief.
- Law: L1 (never below raw), L0 (the harness may not shrink the model's job), L5 (a harness failure is reported as one, never as the user's spec conflict).
- Siblings (limiting language swept, kept only where the stage is a read-only role or a trust rule):
  - Fixed: loki-ts/src/features/lean_prefix.ts STAGE_PREFIX and LEAN_PREFIX, now role-neutral (they also prefix the read-only plan brief and the Wall author brief, so no full-job text lives there).
  - Fixed: loki-ts/src/e10ext/context.ts FIXED_RULES, the implement brief only ("Run only the impacted tests named below", "Never run the full test suite, an E2E suite, or a long-lived server" removed; the full job is stated here).
  - Fixed: loki-ts/src/engine10/stages/implement.ts brief ("Impacted tests: none known" wording) and its fixed 480s implement limit (now derived from the run budget in machine.ts; deep mode now also gets its 1800s session limit, where session.ts used to kill it at 480s).
  - Kept, role-defining read-only stages: stages/plan.ts and engine10/already_done.ts ("do not edit any file", "do not run tests"); they never implement.
  - Kept, deliberate parallel fence: features/speed/unit_mode.ts (a decomposer-set write set, off unless LOKI_UNIT_SPEC).
  - Fix briefs reuse buildImplementBrief, so they inherit the same fix.
- Mechanism: one shared constant brief (full job, trust rules only) plus one resume. No code inspects the model's wording (L0): on any LOKI_SPEC_CONFLICT from implement, util/conflict_resume.ts resumes the session exactly once with a correction ("Loki imposes no file or test limits; if your conflict is only about Loki's own rules, finish the task. If the task itself conflicts, restate the conflict."). If the model still declares a conflict the outcome is the normal BLOCKED with its one question (A-110). User work always keeps its PR or draft PR (E-67, L6).
- Fixture: tests/engine10/conflict_resume.test.ts (a conflict that clears continues; one that persists stays BLOCKED with its question), tests/e10ext/full_job_brief.test.ts (limiting phrases gone, trust rules present, plan and Wall briefs carry no full-job wording), tests/engine10/machine.test.ts (deep implement session gets 1800s), tests/engine10/supervisor_backstop.test.ts (a PARTIAL seal after a failed implement stage still opens its PR).

## FC-20 The Control Plane home cannot start a new app and shows a bare "HTTP 404"
- User saw: on the redesigned CP home the founder typed "create an async timezone page that gets time from a free source for the given location and displays sun movement for it in natural graphic generated as code", with the chips repo "server directory", provider claude and model haiku, and pressed Start. A red "HTTP 404" appeared under the composer, and no run started.
- Law: L5 (an honest, harness-owned reason with a next step, never a raw status), L6 (a start request never fails silently), L1 (raw Claude Code starts a greenfield app from one sentence; Loki must too).
- Siblings: every CP action that surfaces a raw HTTP status (start, stop, resume, retry, receipt fetch); a UI bundle served by an older CP process after an upgrade (version skew); the loopback guard rejecting a local request; any entry point that assumes a repo exists (CP composer, `loki start` with only a brief).
- Mechanism: one shared CP request helper turns every non-2xx into a plain sentence (what failed, why, next step). The UI and server carry one version, and a stale CP process restarts, or refuses a newer UI with that sentence. Rescoped by the founder at 22:03Z: Loki is not a vibe coding tool, so the home box is not a build prompt; it becomes Ask Loki (BOARD CP-ASK), and greenfield-from-composer is dropped.
- Fixture: owed. A forced 404 renders a sentence, not "HTTP 404"; a version-skewed UI gets the restart sentence.

## FC-21 A large task hits the implement time limit and the run skips verify, then reports two different outcomes
- User saw: FireLater#17 on 10.10.3 (run e10-20261003T220847Z-78fa, steering 22:08Z). The model did the whole migration (83 files, +3999/-2476) and the backend suite then had 5855 pass, 3 fail. But implement stopped at "limit" after 639s under a fixed 900s run cap on a subscription run with no dollar cap. The run skipped verify and fix and went straight to commit and seal. The CLI printed "Outcome: FAILED, Reason: limit" while the receipt and run.completed said PARTIAL.
- Law: L1 (raw Claude Code would have kept going and fixed the 3 failures), L2 (fail open on work: the work that exists is verified, never abandoned), L5 (the limit is a harness-owned reason), L7 (one source of truth for the outcome).
- Siblings: every stage that can end at "limit" (plan, wall, implement, fix, deep); every caller that jumps from a stage failure straight to seal; every outcome printer (CLI summary, CP run page, PR body, Slack) that derives the verdict itself instead of reading receipt.verdict; FC-19 (a fixed time handicap on implement).
- Mechanism: (a) a limit in implement still runs verify on the work that exists, plus the fix rounds the remaining budget allows, and never jumps to seal; (b) the run time budget scales with task size (sizing and the Project Model: files, packages), and subscription runs default to a generous wall cap that can be set in loki.yaml; (c) the implement session is told its remaining time so it can checkpoint with tests passing; (d) every outcome printer reads receipt.verdict.
- Fixture: owed. A fake implement that hits the limit is followed by a verify stage event; the CLI summary equals receipt.verdict for VERIFIED, PARTIAL, FAILED and BLOCKED; a large sized task gets a larger cap than a small one.
- Status: shipped in v10.10.5 (implement limit runs verify, cap scales, time note, PARTIAL outcome). Fixtures: loki-ts/tests/engine10/fc21_limit.test.ts and fc21_cap.test.ts. Follow-ups in BOARD FC-21b (earned VERIFIED after a limit, Project Model cap sizing, L7 outcome on a cap stop). Gate on 10.10.5: implement finished in 6m36s under cap 2700s and verify ran.

## FC-22 Impacted-test selection crosses package boundaries, and a selected package with no installed deps can never be proven
- User saw: FireLater#17 on 10.10.5 (run e10-20261003T233414Z-30ca) ended PARTIAL although the backend-only change was correct (backend suite 5914 pass, 0 fail; tsc 0 errors). Verify had selected 4 frontend tests (page.test.tsx, Header, Sidebar, auth store) that do not import the backend; the clone had no frontend deps, so they could not load ("Cannot find module 'vitest/config'") and were NOT PROVEN.
- Law: L0 and L4 (selection follows the repo's real structure, never a name or text guess), L1 (raw Claude Code would have run the backend suite and stopped), L5 (the NOT PROVEN reason was honest; FC-02 classified it correctly).
- Siblings: every selector that maps changed files to tests (e10ext/select.ts, the Wall test map, deep full suite, package_suite per-package runs); every stage that runs a package's command without checking its deps are installed.
- Mechanism: (a) impacted selection is scoped by the Project Model: the touched packages plus the packages that really depend on them (manifest or import edges), never every package in the repo. (b) when a selected package has no installed deps, run the Project Model's own install command for that package once, before verify, recorded as a check with its cwd; opt-out by config; never a guessed command.
- Fixture: owed. The monorepo-fc01 fixture with a backend-only change selects no frontend test; a selected package without node_modules gets one recorded install check before its test runs.

## FC-23 The Wall writes a test that fails the package's own type check, and a fix round is spent on Loki's read-only file
- User saw: the same run's Wall wrote a test that failed the package tsc (TS1470: import.meta is not allowed in CommonJS output). Fix round 1 was spent on it; the model correctly refused to edit Loki's read-only Wall file, so the round bought nothing and the check stayed red.
- Law: L5 (a harness-authored failure is harness-owned, never charged to the user's work), L1 (no wasted model time), cost.
- Siblings: every harness-authored file that later runs under the user's tooling (Wall tests, presealed Wall in modernize, generated fixtures); every place a fix round can target a file the model is forbidden to edit.
- Mechanism: the Wall reads the package's module system and test conventions from the Project Model (type, module, test runner, import style) and writes to match; a lint or type error located inside a Wall file is harness-owned: the Wall file is regenerated once or discarded with a NOT PROVEN note, and no fix round is ever spent on it.
- Fixture: loki-ts/tests/engine10/fc23_wall_conventions.test.ts (a CommonJS package: the Wall brief carries the convention and an import.meta Wall file is discarded with a NOT PROVEN note; a Wall-only tsc error yields not_run, owner harness, zero grouped failures; control: a user-code type error still fails and gets a fix round). Readers: loki-ts/src/project_model/conventions.ts, loki-ts/src/util/wall_owned.ts.
