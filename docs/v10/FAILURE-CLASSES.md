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
  - deferred by the FC-01 stopgap (de12ad0cb): deep.ts:84 full suite at the repo root, verify.ts:228 tsconfig root-only, verify.ts:231 ESLINT_CONFIGS root-only.
- Mechanism: Project Model packageRootOf/commandFor (EL-W1-01, EL-W1-04a/b). Interim: EL-W0-03.
- Fixture: tests/fixtures/firelater-17 plus the shape fixtures in benchmarks/tasks/shapes.

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
- Sibling (2026-10-03): a change-introduced load error is a code fault. Base reproduction is necessary but not sufficient. The base rerun must be hermetic (an inherited editable install imports head code), and a check the task targets is never env-owned (7ad4a18b6, blocked in round 2). Superseded by L0-WAVE1 EL-W1-06: the harness gathers evidence and a separate reviewer call assigns the owner.

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
  - no effort field in SessionRunOptions.
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
