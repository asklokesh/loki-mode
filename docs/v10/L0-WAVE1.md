# L0 Wave 1: the model decides, the harness proves

Founder directive, relayed by Loki steering at about 18:00Z on 2026-10-03, permanent: "never hardcode in the harness, work from 100k ft, use the intelligence of the model". L0 sits above L1 to L7 (ENGINE-LAWS.md section 2). This file slices it into Wave 1. Every slice touches trust, so each one gets an opus D12 review (unanimous).

## The split

The model owns repo and task knowledge:
- layout and package roots;
- runner, command and cwd;
- whether there is a UI, and how to boot it;
- which files are in scope and which tests are impacted;
- task size;
- who owns a failure;
- what the issue asks.

The harness owns mechanism:
- running the commands the model proposed, and recording cwd, exit code, output and test counts;
- sandboxing, budgets and process control;
- signing, receipts and integrity;
- terminal I/O;
- deterministic tamper checks, such as test or runner config edited or weakened.

When execution contradicts the model, the output goes back to the model once. The verdict comes from execution evidence plus a separate reviewer call, never from the author.

## Inventory (grep on main 11685c822, loki-ts/src)

Manifest probes:
- engine10/testmap.ts
- features/visual_evidence.ts
- runner/repo_profile.ts
- runner/quality_gates.ts
- engine10/modernize/inventory.ts
- util/update_check.ts (this reads Loki's own package.json, so it is not repo knowledge)

Hardcoded runner commands:
- engine10/testmap.ts (COMMANDS)
- engine10/stages/verify.ts
- engine10/stages/wall.ts
- engine10/stages/deep.ts
- engine10/types.ts
- features/wall_manifest.ts
- runner/quality_gates.ts
- runner/repo_profile.ts
- engine10/modernize/inventory.ts
- engine10/modernize/presealed_wall.ts

Task-wording heuristics:
- e10ext/scope.ts (keyword regex)
- engine10/sizing.ts (character counts and the named-file regex)

The peer counted 10 manifest-probe files and 17 runner-command files. The grep above finds fewer, so EL-W1-00 re-measures the inventory before cutting.

## Slices (sonnet builders, opus D12 review)

| ID | Goal | File set | Wall checks |
|----|------|----------|-------------|
| EL-W1-00 | Static guard (L0): a CI test that fails when a new file under loki-ts/src probes a manifest name or embeds a runner command outside an allowlist. The allowlist starts as today's inventory and may only shrink. | new tests/engine10/l0_guard.test.ts | the guard goes red on a planted probe; the allowlist equals the inventory |
| EL-W1-01 | Project Model discovery: one intake session reads loki.yaml, AGENTS.md, CLAUDE.md, CONTRIBUTING, README, CI workflows, manifests and configs. It returns a schema-checked Project Model (packages, roots, runner, cwd and test, lint, build and start commands, UI and boot, workspace kind), each answer citing its source files. Cached in .loki/project.json, keyed by manifest and lockfile hash. | new engine10/project_model.ts, plus its schema and intake wiring | schema rejects an answer with no citation; cache hit when hashes are unchanged; FireLater fixture yields backend/ and frontend/ roots |
| EL-W1-02 | Calibration: the harness runs each proposed test command once (the Wall base run) and records cwd, exit code and counts. On contradiction (a load error or 0 collected), it sends the output back to the model once, then reruns. | project_model.ts calibrate(), wall.ts | a wrong command is corrected in one round; the second contradiction is recorded as harness ERROR |
| EL-W1-03 | Consumers: testmap, verify, wall, deep and visual_evidence read commands and roots only through the Project Model API. COMMANDS and the manifest probes lose their authority and stay only as discovery hints. | testmap.ts, verify.ts, wall.ts, deep.ts, visual_evidence.ts | the L0 guard allowlist shrinks; the Repo Shape Matrix stays green |
| EL-W1-04 | Scope: in-scope judgment is a model call citing the issue and the plan, and the keyword regex is a hint only. Advisory remains (L2). | e10ext/scope.ts, plan stage | FireLater#17 routes edits ruled in scope with a citation |
| EL-W1-05 | Sizing: a model call returns a size plus its reasons, or the size folds into discovery. The character counts become a fallback only when the model call errors. | engine10/sizing.ts | the reasons are recorded in the receipt |
| EL-W1-06 | Failure ownership (supersedes the FC-02 regex classifier, 7ad4a18b6 blocked in round 2): the harness gathers evidence (a hermetic base rerun with PYTHONPATH, VIRTUAL_ENV and the user site scrubbed, and traceback paths checked against the base dir). A separate reviewer call assigns the owner. Checks the task targets are never env-owned. | util/runner_load_error.ts, verify.ts, seal | round-2 repros B1 and B2 both end as code-owned |
| EL-W1-07 | Visual evidence: whether there is a UI, and how to boot it, comes from the Project Model. | features/visual_evidence.ts | FireLater frontend/ is found; a no-UI repo gets an honest "no UI in Project Model" |

Order: 00 and 01 first, then 02 and 03. 04, 05 and 07 can run in parallel with 02 once 01 lands. 06 starts after 01 (it consumes the commands). The hardcoded tables are deleted only after the model path is green on the Repo Shape Matrix.

## In-flight reconciliation

- **FC-01 monorepo, aac46dc26 (a446b394845a709ac):** a minimal stopgap hint only, superseded by EL-W1-01. The builder was told at 17:42Z.
- **FC-02 runner-load, 7ad4a18b6:** blocked in round 2, and folded into EL-W1-06 rather than patched as a regex classifier.
- **FC-09 runner-config registry, f4eccfeac:** a deterministic tamper check (mechanism, which L0 allows). Its re-review continues.
- **FC-10 terminalWidth:** terminal I/O, which L0 allows, so its TL review continues.
- **EL-W0-06 model default, 841065e46:** consistent with L1 and L0, so its re-review continues.

## Review rule (binding for every D12 reviewer)

Reject any change that adds an `if` or a regex about the user's repo shape, language, framework or task wording. The fix is a prompt or schema change plus an execution check. Exceptions are only:
- tamper checks;
- terminal I/O;
- Loki's own files.
