<!-- Engine constitution. Source: founder plan 2026-10-03 (autonomi-dev research/2026-10-03-engine-laws/PLAN.md), adopted as D86. -->

# Engine Laws: from one-off fixes to an enterprise-grade engine

Founder directive, 2026-10-03: "Use all intelligence in any session from the model and provider as needed, so our issues in Loki Mode won't impact users. Plan and ultrathink to make it enterprise grade. Not just one-offs: every issue and learning should be thought about at 100k feet."

## 1. The trigger and the diagnosis

On FireLater#17, plain Claude Code fixed the issue and opened a good PR in about 2 minutes. Loki 10.6.14 took 11 minutes and $2.66, ended STALLED and opened a FAILED draft PR (#25). Six defects showed up in that one run. Read from the code, they come from four root classes. None of them is specific to FireLater.

| Symptom on FireLater#17 | Code root | Root class |
|---|---|---|
| Verify "Failed Suites 1" three times; the code passed 43/43 from backend/ | testmap.ts: fixed `npx vitest run <files>` strings, always run from repoDir | A. The harness assumes a repo shape instead of learning it |
| "visual evidence skipped: no package.json" | root-only package.json probe | A |
| Two fix rounds plus STALLED spent on a non-bug | verify does not separate "runner could not load" from "test failed"; fix.ts treats every vitest signature as a test failure | B. Failures are not attributed to an owner (code, env, harness, provider) |
| Route edits the issue required were reverted | e10ext/scope.ts: keyword overlap of plan and task text decides "unrelated", then `git restore` | C. A heuristic holds destructive authority |
| Implement ran below the user's raw intelligence | sizing.ts: cascadeImplementModel = wallModel = sonnet by default; implement brief and limitS 480 replace the agent's own exploration | D. Loki silently gives the user less intelligence than raw |
| PR body: "not recorded" for issue, why, scope and tests | pr_body.ts output not checked against real run data | E. Output contracts are untested on real runs |
| Control Plane stuck "in progress" after completion | no guarantee that every sink reaches a terminal state | F. No run-lifecycle invariant |

Each class has a law. Each law has one mechanism, plus one enforcement check that fails CI if the law is broken anywhere, not only in the stage the bug report named.

## 2. The Engine Laws (constitution for every stage, present and future)

### L0. The model decides, the harness proves (above L1 to L7; founder directive 2026-10-03, permanent)
- The model owns all knowledge and judgment about the user's repo and task: layout and package roots, the runner, command and cwd, whether there is a UI and how to boot it, files in scope, impacted tests, task size, failure ownership, and what the issue asks.
- The harness owns only mechanism: running what the model proposed and recording cwd, exit code, output and counts; sandboxing, budgets and process control; signing, receipts and integrity; terminal I/O; deterministic tamper checks, because the model never grades its own work.
- When execution contradicts the model, the output goes back to the model once. The verdict comes from execution evidence plus a separate reviewer call, never from the author.
- Review rule: reject any change that adds an `if` or a regex about the user's repo shape, language, framework or task wording. The fix is a prompt or schema change plus an execution check. Hardcoded tables are deleted once the model path is green on the Repo Shape Matrix. Slices: docs/v10/L0-WAVE1.md.

### L1. Never below raw
A Loki run never gives the user less intelligence, a worse result or a meaningfully slower one than the same provider run raw.
- The default implement model and effort are the provider's best default for the user's account (what bare `claude` would use), or higher. Cheap models are only for mechanical sub-steps (repo map summaries, PR body prose, docs).
- Any downgrade (model, effort, context, time limit) is printed on the start line and recorded in the receipt. Nothing is silently reduced.
- Escalation goes UP: a repeated code failure escalates to the strongest model and effort the provider offers, with the full failure output and the agent's own diagnosis. This happens before STALLED, for every provider.
- Enforcement: the Parity Gate (section 4) blocks promotion to `latest` when Loki is below raw on the corpus.

### L2. Fail closed on trust, fail open on work
- Trust surfaces fail CLOSED and may block: signing, receipt integrity, secrets, sandbox and permission boundaries, policy the user configured, and tests or CI config being deleted or weakened.
- Work surfaces fail OPEN: scope, the Wall, impacted-test selection, sizing, visual evidence, repo detection. A harness heuristic that is unsure keeps the agent's work, annotates it, and lowers the claim (NOT PROVEN). It never reverts, stalls or drafts.
- Enforcement: a static test lists every code path that calls `git restore`, `git checkout --`, `git reset` or file deletion on user files, or sets outcome STALLED, FAILED or draft. Each one must be classified trust or work, and work paths may not do it. A new destructive call fails CI until it is classified.

### L3. Evidence outranks heuristics (authority ladder)
1. Executed evidence: a command Loki ran, with its output, cwd and exit code.
2. The agent's executed evidence: commands the agent ran in its session, taken from the transcript or tool log.
3. Model judgment: the agent or a reviewer.
4. Deterministic heuristics: keyword scope, sizing, repo-map overlap.

A lower rung may never override a higher one. A keyword heuristic cannot revert what a passing test run supports. A Loki check that ERRORED (not failed) yields to the agent's successful run of the same suite.

### L4. Know the repo before judging it (Project Model)
At intake, one model discovery session reads the repo like a senior engineer and returns a schema-checked Project Model that cites the files behind each answer (L0). Every stage consumes it. No stage may re-derive repo shape on its own, and no harness table or probe is authoritative; the items below are what the model reads, not code the harness runs.
- Packages: every package root (package.json, pyproject, go.mod, Cargo.toml, pom or gradle, composer, Gemfile), its runner, and its exact test, lint, build and start commands.
- Workspace kind: single, npm/pnpm/yarn workspaces, turbo, nx, multi-root with no root manifest (FireLater), polyglot.
- Sources of truth, in order:
  1. loki.yaml overrides;
  2. AGENTS.md, CLAUDE.md, CONTRIBUTING and README test instructions;
  3. CI workflow files (.github/workflows: how the project's own CI actually runs tests);
  4. manifests and config files;
  5. conventions.
- Self-calibration: run each package's test command once as a baseline (this is also the Wall base run). If the runner fails to LOAD (0 tests collected, config not found, module resolution error), ask the agent once, cheaply: "how are tests run in this package?". Store the answer, rerun, and cache it per repo in .loki/project.json, keyed by manifest hashes. Users can edit it.
- Every command records its cwd. A test path is resolved to its nearest package root and made relative to it.
- Enforcement: no stage may spawn a test, lint or build command except through the Project Model API (a grep check in CI).

### L5. Every failure has an owner
Every check result is one of PASS, FAIL, ERROR or SKIP, with an owner: code, env, harness or provider.
- Only FAIL owned by code drives fix rounds and counts toward STALLED.
- ERROR owned by harness or env triggers one self-repair (recalibrate the Project Model). If that does not fix it, the check is NOT PROVEN with a plain reason ("test runner could not load in backend/: <first error line>"). No paid fix rounds.
- ERROR owned by provider (billing, quota, auth, overload) goes to the existing fatal classifier.
- The receipt and PR list every NOT PROVEN item with its owner, so a user can tell "your code is broken" from "Loki could not check".
- Enforcement: a fixture set of runner outputs (load error, 0 collected, missing config, real assertion failure, timeout, OOM) for vitest, jest, node:test, pytest, go and cargo. The classifier must label each correctly.

### L6. Every run terminates everywhere
Every sink reaches the same terminal state: events, receipt, PR, Control Plane, Slack and the CLI summary.
- The supervisor writes run.completed on every exit path, including crash and kill (signal handlers, plus a sweeper for dead PIDs).
- Control Plane ingest is idempotent and reconciles: a run with no live worker PID and no terminal event becomes ABORTED (with a reason) after a grace period.
- Enforcement: an e2e test kills a run at each stage and asserts terminal state in every sink.

### L7. Outputs are contracts
The PR body, receipt, `--json` envelope and CLI summary have schemas. "not recorded" when the data exists is a test failure.
- Golden tests are built from real recorded runs (FireLater#17 included), not hand-made stubs.

## 3. The learning system (how every future issue is handled at 100k feet)

No bug becomes a fix slice until the CoS has written its row in docs/v10/FAILURE-CLASSES.md, answering five questions:

1. What did the user see, and how does it compare with raw provider output on the same task?
2. Which law did it break (L1 to L7)? If none fits, propose a new law. That is a founder-level decision; record it in DECISIONS.
3. Sibling sweep: which other stages, commands or providers share the same assumption? Grep and list them. The fix covers all of them, at the shared layer.
4. Mechanism: the one shared place the fix lives (Project Model, the result classifier, the authority ladder, the lifecycle reconciler, the output schema).
5. Regression: the corpus fixture or real-run golden that would have caught it, added in the same PR.

A one-off patch that answers question 4 with "this stage only" when siblings exist is rejected in review.

## 4. Proof: the Parity Gate and the Repo Shape Matrix

- Repo Shape Matrix (the corpus). At least one real public repo or faithful fixture per shape:
  - single npm;
  - npm, pnpm and yarn workspaces;
  - turbo;
  - nx;
  - multi-root with no root manifest (FireLater);
  - python with uv, poetry and plain pip;
  - go multi-module;
  - rust workspace;
  - java gradle and maven;
  - polyglot (TS frontend plus Python backend).

  Each shape has one small, one medium and one cross-cutting issue (FireLater#17 is the cross-cutting monorepo case).
- Parity Gate (extends the D49 first-run gate for `latest` promotion). Loki is compared with raw `claude -p` on the same issues, with hidden tests judging correctness.
  - Correctness: Loki is at least raw on every shape.
  - Time: small tasks within raw + 30s; medium and large tasks within raw x 1.3.
  - Cost: at most raw x 1.2, unless the user turned on deeper checks.
  - Zero harness-owned FAILED or STALLED outcomes.
  - Results go to METRICS.md. A regression blocks `latest`; `next` keeps shipping.
- Field signal, which stays free and private: `loki report <run-id>` builds a redacted bundle the user can attach to an issue. Nothing is sent automatically.

## 5. Enterprise posture (what a platform team needs before adopting)

- Predictability: published SLOs, the Parity Gate numbers per release, and the same result on the same input (models are pinned and recorded in the receipt).
- Explainability: every outcome has one plain sentence of cause and an owner. Nothing is "not recorded".
- Policy without friction: loki.yaml `scope: advisory|enforce`, where advisory is the default and enforce is opt-in for regulated repos. Enforce runs on the Project Model and the contract, never on keywords alone, and its reverts are listed with a one-command restore.
- Audit: the receipt carries the Project Model hash, the commands with their cwd, the owner attribution and any model or effort changes.
- No silent degradation, anywhere.

## 6. Implementation order (delete first, then build the shared layer)

Wave 0, same day. Flips and deletions, each small:
1. The scope default becomes advisory: annotate, never revert (L2). Keep enforce behind loki.yaml.
2. Cascade default off: implement runs on the provider's best default model and effort (L1). Fix-round escalation goes up to the strongest model.
3. A load-error or 0-collected verify result is ERROR with owner harness. It never feeds fix rounds or STALLED (L5, minimal form).
4. PR body fields come from intake, plan, diff and evidence, with a golden test from the FireLater#17 recording (L7).
5. Control Plane: ingest run.completed, plus a dead-PID reconciler (L6, minimal form).

Wave 1. Shared layers, built in parallel by sonnet builders with opus review for anything touching trust:
6. Project Model module (L4) with AGENTS.md, CLAUDE.md and CI-workflow parsing, a baseline calibration run and the .loki/project.json cache. Testmap, verify, the Wall, visual evidence, the first-run gate and deep all consume it.
7. Result classifier with owner attribution, plus the runner fixture set (L5).
8. Authority ladder in seal: the agent's own passing test commands count as evidence when Loki's check errored (L3).
9. Lifecycle invariant across all sinks, plus the kill-at-each-stage e2e (L6).
10. The static checks from L2 and L4.

Wave 2. Proof:
11. The Repo Shape Matrix corpus and the Parity Gate wired into promotion to `latest`.
12. FAILURE-CLASSES.md seeded with the FireLater#17 rows and every past class from MEDIUM-ANALYSIS.md.

## 7. Acceptance

- FireLater#17 rerun on the new build:
  - VERIFIED, with a ready (not draft) PR;
  - the route edits kept;
  - visual evidence found in backend/ or frontend/;
  - time within raw + 30s and cost at most raw x 1.2.
- The Parity Gate is green on the matrix, and the table is published in METRICS.md.
- Every law has its enforcement check in CI.
- The CoS steering rule (section 3) is written into OPERATING-MODEL.md, and new bug reports follow it.
