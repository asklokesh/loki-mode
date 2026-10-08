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

## FC-24 Agent-written code in the runner's process can forge a pass (summary and exit code)
- User saw: nothing yet (found in the FC-16b round 2 review, 2026-10-04). Reproduced at f28b15d78 with pytest on python 3.14.6: a conftest.py `pytest_sessionfinish` hook writes "===== 5 passed in 0.01s =====" and calls `os._exit(0)`; the only test is `assert False`; classifyCheck returns {"result":"pass","n":5}. The Go form (init or TestMain prints RUN and PASS for a failing test, then os.Exit(0)) defeated every name check in FC-16b.
- Law: L2 (fail closed on trust), L3 (what ran is the evidence); Seal accuracy.
- Siblings (code-path reasoning, only pytest and go reproduced): unittest (atexit or os._exit before the real trailer), jest and vitest (config, globalSetup, setupFiles patch stdout or call process.exit(0)), bun test (preload), node --test (--import or --require hooks), cargo (the test binary is the code), npm test (an arbitrary script). A harness-owned reporter or result file (pytest plugin, jest reporter, JUnit XML) is written inside the same process, so it is forgeable too.
- Mechanism: none closes it per runner. The runner's summary and exit code come from a process that runs agent-written code. Decision: a test pass is recorded as runner-reported, not tamper-proof (a known L2 limit). Go exit 0 is never a pass (FC-16b, not_run, owner harness, honest L5 reason) because Go has no parseable summary that survives the forgery at lower cost. Candidate later mechanisms: harness re-runs each named Wall test in a fresh process with harness-controlled entry and flags (setup code still runs), and the receipt states the limit in its evidence text.
- Fixture: the FC-16b forgery fixtures (go init/TestMain early exit asserts not_run); a pytest conftest forgery fixture that documents the limit is a follow-up slice, not a fix.

## FC-25 A git call from the token-holding supervisor runs a plant in the agent's repo config (moat P9 red since v10.10.4)
- User saw: nothing visible; the moat job of Tests has failed on main since 4fa4e8015 (runs 37160286598 through 37165257952, all "REGRESSION P9.injection-cannot-reach-token": "a plant in the agent's repo config ran holding the real GitHub token: fsmonitor"). 65ce2060b was the last green. The range touched no bash, only loki-ts.
- Law: L2 (fail closed on trust); moat P9 Rule of Two.
- Suspect: FC-21 (881f1275f) added util/run_cap.ts resolveRunCapS, called at engine10/supervisor.ts:330 before the worker spawns. It runs `git ls-files` in repoDir with env process.env, which still holds the token. Local probe (git, 2026-10-04): a repo with core.fsmonitor set to a recorder script fires it on plain `git ls-files` with GH_TOKEN in env; `git diff --name-only` and `git status --porcelain` did not fire in that probe.
- Siblings: every git call made by a process that holds the token (supervisor, CLI before withholding) with cwd in the agent's repo: run_cap.ts, runner/load_owner.ts changedSince and worktree add (when called outside the worker), and any later addition. supervisor.ts:206 and e10ext/commit_filter.ts already pass core.fsmonitor=false and core.hooksPath=/dev/null.
- Mechanism: one shared helper for git in the agent's repo from a trusted process: hardened config (core.fsmonitor=false, core.hooksPath=/dev/null, and no credential helper) plus a token-free env; plus a static guard that fails on a git spawn in loki-ts/src that does not use it, or is not listed with a reason.
- Fixture: a bun test that plants core.fsmonitor and a canary GH_TOKEN, then calls resolveRunCapS and asserts the plant never ran; and the moat case P9.injection-cannot-reach-token passes locally (`bash tests/moat/run.sh`, P9 line).
- FC-25b (sibling, found in the opus review, 2026-10-04T01:02Z): the hooks, fsmonitor and sshCommand flag set alone still lets three plant classes run holding the canary token (git 2.55.0). (1) filter.<drv>.clean or process, declared in .gitattributes or .git/info/attributes, fires on status --porcelain, diff --name-only HEAD, add and commit. (2) diff.<drv>.textconv fires on log -p and on a diff with patch output. (3) gpg.program with commit.gpgSign=true fires on commit. A scrubbed env does not close the hole, because a running plant can still read the gh hosts file or the keyring. Execution itself has to be stopped. Mechanism: the same safeGit helper blanks each configured filter and textconv key, and sets diff.external=, commit.gpgSign=false, core.attributesFile=/dev/null and GIT_ATTR_SOURCE=<empty tree>. Fixture: fc25_safe_git.test.ts adds one plant per class.
- FC-25c (follow-ups from the opus review of d82aec15a, 2026-10-04T01:15Z; not reachable with a real token today). (a) The allowToken path still honors repo-local core.sshCommand, remote.*.uploadpack and receivepack, and a repo-scope credential.helper; the canary fired on an ssh origin and on a local-path uploadpack. Its only caller is the base_guard fetch, reached from intake in the worker with the sentinel env, and supervisor.ts baseLine passes fetchRemote=false. Fix: harden allowToken itself, or add a guard that pins it to that single worker-side caller. (b) The raw-spawn guard misses an indirect argv (`const GIT = "git"`) and does not scan packages/control-plane. ship_hook.ts reaches control-plane shipper/discover.ts gitOrigin (`git config --get`, real-token env) from the supervisor. Fix: convert it to safeGit and widen the guard. (c) preflight's safeGitArgv path does not set GIT_CONFIG_NOSYSTEM. Low risk, because system config is root-owned.

## FC-26 Free text in the Control Plane starts a run in HOME that dies in 0.13s, and the run page says "did not pass verification"
- User saw: runs cc22 and e606 on the founder's CP, both FAILED in about 0.13s, with a summary that blamed verification. The founder had typed "whats going on so far" in the home box. Raw `loki start` refuses a non-repo dir with a clear message.
- Root cause (b-a3, 2026-10-04): the home box POSTed free text to /v1/start as `--brief`, with repo "lokesh" (HOME). planStart (packages/control-plane/src/server/spawn.ts:47) accepted any known repo path, HOME included, and `loki start --brief` exited before any stage ran. The run page summary had no branch for "stopped before verify".
- Law: L2 (refuse unsafe targets before acting), L7 (the summary states the real stop reason).
- Siblings: every CP entry that spawns `loki` (POST /v1/start, /v1/runs, retry); every summary line that is derived without a verify event; the stale-CP restart (a CP from an old install keeps the old behavior after upgrade).
- Mechanism: one repoRefusal check in spawn.ts (refuse `/`, HOME and non-git dirs with a human reason) that every spawn path calls; one summaryLine that reads the terminal stop event; free text goes to Ask (read-only) and never to /v1/start.
- Fixture: packages/control-plane test for repoRefusal (HOME, `/`, non-git, real repo); the A4b summaryLine test ("The run failed before verification ran." for a FAILED run with no verify event); the A3f cleanup test with cc22 and e606 look-alikes.

## FC-27 A short product brief skips the Wall because a tree-wide token looks like a named file
- User saw: `loki start` with a one-line UI brief on a local repo (run e10-20261004T143536Z-2582) sized the task small, skipped Plan, and skipped the Wall ("small task with a relevant test"). The implementer edited test configuration, broke an existing test, and the run ended FAILED with no PR. Raw Claude Code would have kept planning against the repo instead of treating the brief as a covered one-file fix. The receipt also listed deferred deep checks, "repo not recorded" (no GitHub remote), and "playwright not resolvable"; those are separate output gaps, not this mechanism.
- Law: L0 (the harness must not decide that an unnamed brief already names its files), L2 (sizing and the Wall are work surfaces: when the signal is not specific, keep the Wall).
- Siblings: `selectRelevantFiles` (plan hints, decompose, implement brief context) still counts every overlapping token, on purpose. The only caller that turns that list into a skipped Wall is `speedLikelyFiles` via `hasRelevantTests` (plan.ts and wall.ts). `namedFiles` (basename in the task text) is unchanged and still lean-eligible.
- Mechanism: one selector, `selectSpecificFiles`, drops tokens that occur in more than half the repo-map entries before scoring. `speedLikelyFiles` uses it. A distinctive symbol still selects its file. Plan hints stay on `selectRelevantFiles`.
- Fixture: loki-ts/tests/engine10/sizing_lean.test.ts, "FC-27: a token on most paths is not a relevant test, so the Wall stays".

## FC-28 A short brief skips the Wall because a common word sits inside a longer symbol
- User saw: the same one-line brief, rerun e10-20261004T210509Z-9f4f after 11.0.2, still skipped the Wall ("small task with a relevant test") and ended FAILED with no PR. The jest failure was a different test in the same file. FC-27 only dropped tokens that hit most of the tree. A shorter word still matched as a substring of one symbol, and that one file with a test was enough to skip the Wall. Raw Claude Code does not treat a common word inside a longer name as proof the change is already covered.
- Law: L0 (the harness must not decide that an unnamed brief already names its files), L2 (when the signal is not an exact name, keep the Wall).
- Siblings: `selectRelevantFiles` still uses substring overlap for plan hints. `namedFiles` still matches a basename written out in the task. FC-27's half-repo drop stays on the same selector.
- Mechanism: `selectSpecificFiles` counts a task word only when it equals a path segment or a symbol. A word inside a longer name does not. `speedLikelyFiles` is still the only caller that can skip the Wall.
- Fixture: loki-ts/tests/engine10/sizing_lean.test.ts, "FC-28: a word inside a longer symbol is not a relevant test, so the Wall stays".

## FC-29 A test silently depends on the caller's cwd
- User saw: tests/test-proof-verify-jwks.sh passed 108/0 in 33s in a fresh worktree and hung until killed when run from the main checkout. The CI-style run was green and the founder's own run was red, so the suite read as flaky.
- Mechanism (measured): `loki proof verify` and `loki_remote_verify_receipt` run `proof-verify.py "$pj" "${TARGET_DIR:-.}"`. With TARGET_DIR unset the verifier runs `compute_tree_digest` on the caller's cwd, whose filesystem walk visited 1,054,266 paths (13.3s just to enumerate, then it hashes them) because `.claude/worktrees` (190 worktrees, 32G) sits inside the checkout. A fresh worktree has a few thousand files.
- Law: L2 (a verdict is about the tree it names, never an ambient one), and the test hermeticity rule: a test owns its fixture tree.
- Siblings: swept every tests/*.sh spawn of `proof verify` and `loki_remote_verify_receipt`; only the jwks test lacked TARGET_DIR. Direct `proof-verify.py` runs pass the repo as an argument. Sibling sweep (11.2.0 lane 10): of every `${TARGET_DIR:-.}` reader in autonomy/, five spawn sites were unsafe: the Bun `loki proof verify` (loki-ts/src/commands/proof.ts, the default route for a plain `verify <id>`), the bash `loki proof verify` (human and JSON, reached by flags or LOKI_LEGACY_BASH), `loki_remote_verify_receipt` and `_deploy_receipt_verdict` all handed the verifier the caller's cwd (it digests the tree when cwd is a repo). Safe, each reads or writes fixed paths and walks nothing: cmd_deploy detectors (test -f on named files), cmd_failover (one failover.json), `loki handoff --md` (writes one HANDOFF.md), crash.sh (writes .loki/crash), spec-interrogation.sh (five named manifests). app-runner.sh and completion-council.sh run only inside a `loki start` run, where run.sh sets TARGET_DIR to the project.
- Mechanism of the fix: every verifier spawn in the jwks test sets TARGET_DIR to its fixture; tests/test-verifier-spawn-sets-target-dir.sh fails any test that spawns the verifier without TARGET_DIR or a cd into an owned directory.
- Shared mechanism for the sweep: `loki_verify_root` in autonomy/loki and its port `resolveVerifyRoot` in loki-ts/src/commands/proof.ts are the one resolver (TARGET_DIR, parent of an absolute LOKI_DIR, cwd or repo top-level holding .loki, else a plain refusal and exit 2 NOT CHECKED; HOME and / are never roots, a trailing slash is normalized first). The first sweep fixed only the bash copy; the HIGH review found the Bun route still defaulting to ".".
- Sweep fixture: tests/test-verifier-root-not-ambient-cwd.sh (runs `proof verify` through bin/loki on both the default and legacy routes; source guards cover autonomy/loki and loki-ts/src) and loki-ts/tests/commands/proof_verify_root.test.ts (the TS resolver, red before the port). The bash source guard goes red when a spawn passes `${TARGET_DIR:-.}` again.
- Fixture: tests/test-verifier-spawn-sets-target-dir.sh, mutated against the pre-fix jwks test (7 hits). tests/test-proof-verify-jwks.sh run with cwd = the main checkout.

## FC-30 An install artifact outlives the install that made it
- User saw: after upgrading to 11.1.0, ~/.claude/skills/loki-mode was a symlink to ~/.bun/install/global/node_modules/loki-mode, which no longer existed. `loki doctor` FAILed and told the user to run `loki setup-skill`, an extra command the product should never ask for.
- Mechanism (measured): `cmd_setup_skill` creates the provider skill links once and only on request. Nothing re-checked them on install, upgrade or first run, so a package-manager move or reinstall left a dangling link (or one to the previous install). Raw cause is a one-shot writer with no owner for the link's lifetime.
- Law: L0 (the harness repairs what it can verify is its own instead of delegating to the user), L2 (the doctor verdict is about the host as it is, and the fix must make that true without a command).
- Siblings: swept every place Loki writes an install-time path. Provider skill links ~/.claude, ~/.codex, ~/.cline, ~/.aider skills/loki-mode (all four covered by the shared mechanism); `cmd_remote` ln -sf of the Claude skill link in autonomy/loki (only creates when SKILL.md is absent, covered by the same repair on the next run); shell completions via `completion --postinstall` and the shim (already self-healing, stamped by VERSION in ~/.loki/completions-version); no PATH shims or bin links are written by Loki (the package manager owns bin/loki). Real directories and foreign links are deliberately left to doctor.
- Mechanism of the fix: autonomy/lib/skill-link-heal.sh `loki_skill_link_heal` repoints a symlink only when its target is a Loki install path (node_modules/loki-mode or a Homebrew loki-mode dir) that is missing or is a different install than the running one, and only when the running root is itself an install path. Atomic temp link plus rename, one stderr line, silent no-op when correct, LOKI_NO_SKILL_LINK_HEAL=1 opts out. Called from bin/loki-postinstall.js (install and upgrade) and the bin/loki shim (first run).
- Fixture: tests/test-skill-link-heal.sh (dangling, other install, real dir, foreign link, correct link, opt-out, dev checkout), red before autonomy/lib/skill-link-heal.sh existed.
- Amendment (FC30-DURABLE): the repair repointed to WHATEVER install was running, so a one-off `npx loki-mode@x` or a scratch-prefix install would hijack the user's link to a path that later disappears and dangles again. Rule: repoint only when the running install is durable (under `npm root -g`, the bun global dir, or a Homebrew prefix). An npx cache (_npx), a temp dir or any other prefix is refused with one stderr line and the link is left untouched. The rule lives only in autonomy/lib/skill-link-heal.sh (`_loki_skill_root_durable`); there is no TS copy, and bin/loki-postinstall.js and the bin/loki shim both call it. The check runs only on the repair path, so the steady state stays subprocess-free.
- Amendment siblings swept: other Loki writers that derive a user-owned path from the running install location: `cmd_remote` ln -sf of the Claude skill link (creates only when SKILL.md is absent; shares the same later repair, no repoint from the running root); shell completions (stamped by VERSION, content not install-path dependent); no PATH shim or bin link is written by Loki. No other self-repair writes from the running root.
- Amendment fixture: tests/test-skill-link-heal.sh cases 8-12 (npx cache refused, temp or arbitrary prefix refused, brew prefix healed, bun global healed, foreign link untouched), red on the npx and temp cases before the fix (11 passed, 2 failed), with npm stubbed and HOME and HOMEBREW_PREFIX faked.

## FC-31 A slice gate skips the suites that guard its own files, and main goes red in Tier B
- User saw: main 27447cf46 failed Tier B on tests/test-doctor-blocker-parity.sh (run 37697291383). The slice R1-20 (8ff988516) changed loki-ts/src/commands/doctor.ts and gated only on tsc and bun test. The local-ci fast tier had timed out (rc=124) on a loaded host, so no shell suite ran.
- Law: L2 (a verdict is about the tree it names; a gate that did not run the guarding suites says nothing about them) and the evidence rule (a timeout is not a pass).
- Cause (measured): scripts/select-tests.sh rule R4 handled loki-ts/src files with `continue` after selecting bun tests, so rule R3 (shell suites that reference the file) never ran for them. test-doctor-blocker-parity.sh runs `bin/loki doctor`, never the string doctor.ts, so no path or basename match could have found it anyway.
- Mechanism: one shared mapping, scripts/select-tests.sh. R4 now also selects shell suites that name the full path, and for loki-ts/src/commands/X.ts those that run `loki X`. One gate command, `bash scripts/local-ci.sh --impacted <base>` (scripts/impacted-gate.sh), runs only the selected shell and moat suites, each under `timeout -k`, prints per-suite rc, and exits non-zero on any failure or timeout.
- Siblings swept (file-to-suite mapping by source tree): loki-ts/src was the only tree whose rule skipped the shell grep (fixed). mcp/, providers/, autonomy/ (other than run.sh and loki), scripts/ get R3 path and basename grep. dashboard/ gets R3 plus the R5 pytest area. web-app/ gets R3 plus R5. Still thin: a loki-ts/src file that is not a command module (runner/, util/) maps to shell suites by full path only, not by the subcommand a suite drives; dashboard and web-app shell suites that drive an API route by URL are not mapped to the handler file; mcp/server.py tools are not mapped to suites that call the tool by name. Follow-up: a per-tree needle table once a second miss appears.
- Fixture: tests/test-select-tests.sh, "FC-31: doctor.ts selects doctor parity shell suite" (red before the fix: 39 passed, 1 failed).

## FC-32 Hand-maintained file lists drift from the import graph
- User saw: Tier B run 37706008817 on main 6a01413bd failed two suites: "no hardcoded home-directory paths in tests" (and its cascade, "Structural checks catch planted defects (D44-C)") and "Loki control plane wiring (CP-04)". Both slices had passed tsc and the full bun test.
- Law: L2 (a verdict is about the tree it names; a gate that did not run the guarding suites says nothing about them).
- Cause (measured): faf1d0ace added tests/test-parity-goal-score.sh with hardcoded /opt/homebrew/bin and /usr/local/bin grep paths (flagged by tests/test-no-hardcoded-paths.sh). The R1 router slices (0f3e3d55a, c15b8157b, 1b9e479c1) added loki-ts/src/engine10/cost.ts, runner/router/flag.ts and runner/router/route_block.ts to the control-plane value-import closure, but Dockerfile.control-plane lists its COPY files by hand. RC-SLICE-SHELL-GATE: the FC-31 impacted gate selected neither shell structural guard, including for a touched tests/*.sh.
- Mechanism (P0 slice, interim): the parity test discovers greps with `type -ap grep ggrep` (no absolute paths); the three missing files were added to Dockerfile.control-plane.
- Mechanism (root fix, 11.2.2 FC-32-ROOT): Dockerfile.control-plane now COPYs the whole loki-ts/src tree (2.4MB; the root Dockerfile already did). CP-04 (tests/test-control-plane.sh) no longer compares a list to the import graph: it stages exactly what the Dockerfile build stage COPYs (WORKDIR and relative or absolute destinations honored) and runs the real `bun build` of the server and ask-tools bundles there. Docker is not needed.
- Why not the import-graph generator: a whole-tree COPY is viable (size 2.4MB, evidence: `du -sh loki-ts/src`), so the CTO's option 1 applies.
- Regression fixtures (CP-04): the legacy per-file list (tests/fixtures/cp04-legacy-copy-list.txt) bundles the unmodified tree, goes RED when a brand-new loki-ts file is imported (needs a list edit), while the tree COPY passes with no edit; a really missing import target and a deleted loki-ts COPY both go red.
- Gate selection (RC-SLICE-SHELL-GATE): scripts/select-tests.sh now selects tests/test-no-hardcoded-paths.sh and tests/test-structural-checks.sh for any changed tests/*.sh, and tests/test-control-plane.sh for any loki-ts/src file in the control-plane import closure (computed at selection time; python3 missing selects it for all loki-ts/src). Fixtures in tests/test-impacted-gate.sh (red before the fix: 2 failed on tests/*.sh; CP-04 red once the test stopped naming the files by accident).
- Siblings swept: tests/test-no-hardcoded-paths.sh scans every tests/ file (3 passed, 0 failed after the fix); the CP-04 closure guard covers every loki-ts/src value import (25 passed, 0 failed); no other hits.
- Sweep of hand-kept lists (root slice): package.json files[] has hand-listed web-app/{server,auth,models,crypto}.py and Dockerfile:146 the same four (a new web-app module would not ship; follow-up, change both to a glob together). tests/test-runtime-libs-are-packaged.sh hand-lists tools/*.py and autonomy/lib/*.py to assert (drift means a new tool is unasserted, not unshipped; follow-up: derive from the directory). tests/test-detectors-are-packaged.sh derives its list from run.sh (already the right shape). action.yml and .github/actions/*: no file lists. tests/test-release-dist-guard.sh: checks map content, no list.
- Fixture: the two existing guards, red on 6a01413bd and green here.

## FC-33 Duplicate implementations kept in sync by tests (FC-DUP)
- User saw: `loki doctor` printed different checks, counts and verdicts depending on the route (bash vs bun), which `bin/loki` picks from bun on PATH, LOKI_LEGACY_BASH, a missing dist, LOKI_TS_ENTRY or `--airgap`. Two parity tests (test-doctor-blocker-parity.sh, test-doctor-install-integrity-parity.sh) existed only to keep the two copies equal, and each new doctor check had to be written twice. Raw Claude Code has one doctor.
- Law: L2 (one verdict has one author), L0 (the harness must not hold two answers to one question).
- Siblings (twin sweep):
  - Command twins and their guards: version, provider, memory (loki-ts/tests/all-ported.test.ts); stats (tests/test-bash-bun-parity.sh check 6); proof verify (loki-ts/tests/proof_verify_parity.test.ts); crash (crash.test.ts:308); status (status.test.ts:398); rollback, trust, wiki (unguarded).
  - Runner twins: run.sh vs loki-ts/src/runner, guarded by test-bash-bun-parity.sh, test-parity-*.sh, the gate-failures-cap parity test and test-pricing-parity. goal_score.ts vs run.sh has NO guard. These collapse when the D57 default-loop flip lands.
- Mechanism: `_loki_bun_delegate <cmd> "$@"` in autonomy/loki (bun resolved PATH then @oven/bun-*, dist then src, `version` preflight under 5s, then exec). Doctor is the first command moved onto it; bash keeps only a minimal "bun route unavailable" diagnostic. `cmd_control` is the precedent. Remaining twins move onto the same helper as their slices land.
- Known gap: the delegate preflight only runs `<cli> version`. A throw inside doctor.ts AFTER the CLI loads (during the doctor run itself) is not covered by the preflight and surfaces as that crash, not the minimal fallback.
- Fixture: tests/test-doctor-single-impl.sh.

## FC-35 The router start line, receipt and plan disagree about the route
- User saw: CTO smoke with LOKI_ROUTER=1 on a node off-by-one fixture. The start line said "route: executor haiku-5.5, advisor opus: Opus routes at plan time", the receipt said routed:false, units:[], executor:null, "no route recorded by implement", every session ran claude-sonnet-5-5, no plan-scope.json was written (plan logged "plan sonnet (fast tier)"), and shape_key was null.
- Law: L7 (what is advertised is what is recorded); also L2 (a null shape key feeds no history, R1-16) and founder design (Opus routes; Sonnet is the default executor; Haiku only when Opus assigns it).
- Cause (measured): routeStartLine ignored all run data and defaulted the executor to haiku; the plan stage skipped small tasks even with the router on and ran the router-on plan on the fast tier (Sonnet) unless the advisor was unavailable; nothing recorded a route when the plan returned none, and the receipt read only implement.route, which no stage writes; shapeKeyForRepo was never called and ignores the run's project-model.answer.json.
- Mechanism (one shared): runner/router/route_record.ts. The plan stage always writes <runDir>/route.json (a route, or routed:false with the reason) while the router is on. The receipt route block (buildRouteBlock, via plan output or route.json) and the PR line derive from that one record; the start line is printed before any stage, so it states the pre-plan state only ("decided at plan time, per-unit executors not applied") and never names an executor. The plan session runs on Opus (Sonnet only after an Opus failure, recorded as NOT PROVEN) and no longer skips small tasks. shape_key comes from shapeKeyForRun (the run's project-model.answer.json, then the repo model). The "plan sonnet (fast tier)" downgrade is not printed while the router pins the plan to Opus.
- Siblings swept: routeStartLine (supervisor.ts), buildRouteBlock (seal.ts), routePrLine/withSealRoute (pr.ts, via the sealed route_line), modelDowngrades (start line and run.started), doctor.ts router check (reads no executor); all other prints of an executor name go through modelLabel in route_block.ts. Router-off output is byte-identical (router_optout_golden plus the new off assertions).
- Parked: implement does not yet apply per-unit executors (R1-11 wiring). The record carries applied:false (PER_UNIT_EXECUTORS_APPLIED), so the receipt and PR line say "<run model> (per-unit assignment not applied)", list units as "assigned haiku-5.5 (not applied)" and add a route.executor NOT PROVEN line; none claims haiku ran. plan_model records the model the fast tier really resolves to (fastTierModel), and the plan downgrade is suppressed only when the plan is really pinned to Opus.
- Fixture: loki-ts/tests/engine10/route_record_agreement.test.ts (red before the fix).

## FC-39 A hand-kept file list drifts from the import graph (second instance, in a fixture)
- User saw: train-11.3.1 red at 1613125eb: tests/test-control-plane.sh "legacy fixture sanity failed" (24 passed, 1 failed). The RABC and T1 slices added loki-ts imports (route_record.ts, cost_preview.ts, pr_lessons.ts and their closure) that tests/fixtures/cp04-legacy-copy-list.txt did not list.
- Law: L2 (a verdict is about the tree it names). FC-32-ROOT removed the hand-kept list from the product Dockerfile but left the same class alive in the test fixture.
- Cause (measured): the fixture was a hand-kept per-file COPY list; a sweep of the import closure of its entry points found 11 unlisted files (cache, repomap, provider_failover, runner/types, cost_preview, history, history_store, atomic, engine_origin, pr_lessons plus route_record).
- Mechanism (one shared): the legacy list is derived at fixture time from the import closure of serve.ts and tools_server.ts (legacy_copy_list in tests/test-control-plane.sh); the checked-in list file is deleted. The red-first case still holds because plant_import runs after derivation.
- Siblings swept (tests/ and scripts/): the derived walk itself must not drop files: it maps .js/.mjs specifiers to .ts (latent class: no file in the serve.ts/tools_server.ts closure imports a .js or .mjs specifier today, so this guards future imports; the real tree list is unchanged), skips comment-only lines, and fails loudly naming any relative specifier it cannot resolve (fixtures in tests/test-control-plane.sh, red when the .js mapping is removed). No other hand-kept loki-ts/src file list. Remaining lists are not source-closure lists: tests/detect-test-mutations.sh HARNESS_FILES, tests/test-registration-nonstandard.sh CORPUS_FILES, scripts/license-audit.sh PACKAGE_FILES, tests/managed_memory/test_sdk_isolation.sh ALLOWLIST. Open (from FC-32, unchanged): Dockerfile:146 and package.json files[] hand-list web-app/{server,auth,models,crypto}.py.
- Fixture: tests/test-control-plane.sh (25 passed, 0 failed; the sanity case is green by construction and cannot drift).

## FC-DOCTOR-COUNT Doctor's failure count changed between identical runs (provisional id; Release Manager renumbers)
- User saw: `loki doctor` printed "2 failed" on one run and "1 failed" on the next, same environment. Raw cause: the Claude login row depended on a live `claude auth status` subprocess (5s timeout, no retry). When it returned nothing, doctor fell back to a clock-dependent check of the cached OAuth access token's expiry and printed FAIL "login has EXPIRED" (an expired access token is normal; a refresh renews it). Reproduced on 11.2.2 with a claude shim whose probe prints nothing plus an expired credentials file: "19 passed, 2 failed"; probe answering: "1 failed".
- Law: L5 (an inconclusive probe was reported as a user fault) and L3 (a heuristic on the clock beat executed evidence).
- Siblings swept: text Summary vs `--json` summary (two separate hand-kept counters), 39 hand-written `tally.X++` sites, and the Blocking (N) trailer (read the same counters). Other probes checked: tool version probes (a timeout leaves version null, which passes, so no count change), readEffectiveProvider (deterministic; failure degrades to warn), disk, skills, detectors, PATH installs (all local and deterministic). Under 16 concurrent doctor runs the counts were identical, so the flip needs an inconclusive login probe. Not touched: run.sh claude_login_state, which has its own fixture (tests/test-claude-login-state.sh).
- Mechanism: one counting function, `summarizeStatuses(list)` in loki-ts/src/commands/doctor.ts. The text tally is now a list of recorded statuses (`makeTally`, `bump`) with pass/fail/warn derived from it, and `--json` builds its summary from the same function. The login row goes through the pure `evaluateClaudeLogin`: one retry on an empty probe, then an explicit UNKNOWN that is always a counted warning and never a fail, independent of the clock.
- Fixture: loki-ts/tests/commands/doctor_count.test.ts (claude shim: yes / empty / flaky-first-call, with an expired credentials file; asserts failed equals the number of FAIL lines, is equal across probe modes, and that `--json` summary.failed equals the text count).
