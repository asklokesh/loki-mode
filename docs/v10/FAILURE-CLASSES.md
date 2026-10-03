# Failure classes (D86)

Each row answers five things:
- what the user saw, compared with raw;
- the law broken (docs/v10/ENGINE-LAWS.md);
- a sibling sweep;
- the one shared mechanism;
- a regression fixture.

No fix slice starts until its row exists (OPERATING-MODEL.md, Engine Laws line). Slice ids refer to the EL plan (Architect, 2026-10-03).

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
  - the brief's impacted commands.
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
  - deep.ts.
- Mechanism: a result classifier with an owner (EL-W1-05). Only a FAIL owned by code drives fix and stall. Interim: EL-W0-02.
- Fixture: tests/fixtures/runner-outputs/vitest/load-error.txt (from seq 56), plus siblings for each runner.

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

## FC-09 A test-config edit outside scope can make broken code VERIFIED
- User saw: nothing yet (reproduced by the D12 scope review with a stub provider). The agent broke `add`, edited bunfig.toml to preload a new setup.ts that mocks the module, and the verdict was VERIFIED. This happens at ffb58278b and at HEAD.
- Law: L2 (trust fails closed).
- Siblings:
  - CFG_ALWAYS in verify.ts (A-115) leaves out bunfig.toml;
  - new preload or setup files are never flagged (only edits to existing tests are);
  - the equivalents for other runners: vitest.config setupFiles, jest setupFiles and moduleNameMapper, pytest conftest.py, and go test flags in Makefiles.
- Mechanism: one runner-config registry for each runner. Any added or changed file that it names (configs, preloads, setup files, conftest) caps the verdict below VERIFIED, with NOT PROVEN naming the file.
- Fixture: a stub-provider repro for each runner (bun preload, vitest setupFiles, jest moduleNameMapper, pytest conftest).
