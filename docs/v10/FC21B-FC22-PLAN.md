# FC-21b and FC-22 slice plan (Architect, 2026-10-03T23:58Z)

The order is S1, then S2, S3 and S5 in parallel, then S4 last. No two slices touch the same file. Every slice must pass the full `bun test` plus `bunx tsc --noEmit` before APPROVE.

## Findings (file:line, loki-ts/src)
- Impacted-test selection lives in engine10/testmap.ts:201 impactedRefs, not in e10ext/select.ts (which is attempt ranking).
  - It matches basename stems across the whole repo (sourceRefs :186-193), so a backend validation.ts pulls in frontend validation.test.ts.
  - Callers: verify.ts:250 and :260, implement.ts:25, sizing.ts:43, plan.ts:58.
- The Project Model has no package graph (schema.ts:21 ModelPackage) and no install command (COMMAND_KINDS, schema.ts:8).
- seal.ts:140: an implement exit of killed is always PARTIAL. machine.ts:128 overwrites outputs.implement on a kill, and restoreReadOnly (implement.ts:43) never runs on a kill. A killed session can therefore leave an edited Wall file behind, and verify runs it. This blocks shipping VERIFIED-after-limit.
- The cap is fixed before the worker spawns (supervisor.ts:330), and the backstop comes from it (:181).
  - plan.ts:91 relevant_files is keyword overlap, so it is not a size signal.
  - run_cap.ts:28 matches run_cap_s at any depth under budgets; CRLF fails silently at :27; :35 has an off-by-one line count. budget_cap.ts:20 yamlPerRun has the same bugs.
- output.ts:70 outcomeOf returns BUDGET_STOP over a sealed PARTIAL or FAILED receipt, which is an L7 violation.
- A1: machine.ts:145.
- A2: conflict_resume.ts:14 spreads the first session's options, and machine.ts:66 raises limitS back to the full budget, then appends the note after FINISH_LINE.
- Measured line counts: core 4705, e10ext 1481, features 2971. New modules go in project_model/ and util/ (uncapped). e10ext changes must be net <= 0.

## Decisions
- FC-22a: ModelPackage gets `dependsOn?: string[]` (package roots), declared and cited by the discovery model (L0, no import parsing).
  - Absent means edges are unknown: keep today's cross-package selection (fail safe).
  - [] is an explicit "no dependents".
- FC-22b: ModelPackage gets `install?: ModelCommand|null`. Install is triggered by evidence only: a selected check in that package came back as a harness-owned load error (FC-02).
  - It runs once per package per run, between verify and the fix loop, with timeout min(300s, cap left).
  - It is recorded as check `install:<root>`, and verify is rerun once (not a fix round).
  - No install command means NOT PROVEN naming the package; never guess.
  - Opt-out: LOKI_E10_INSTALL=0 or loki.yaml `verify.install_deps: false`.
- FC-21b(1): add before the fail->FAILED line in verdictOf:
  `if (exit === "killed") return typeof o.implement?.limit_s === "number" && targetProof && proof && !verifyNotProven && checks.length > 0 && checks.every((c) => c.result === "pass") ? "VERIFIED" : "PARTIAL";`
  - targetProof means a verify `target_checks` entry (Wall or a task-named relevant test) passed with n>0.
  - The receipt gets an optional `implement_limit: {limit_s, elapsed_s}`, omitted when unset so other receipts stay byte-stable.
- FC-21b(2): the plan session writes <runDir>/plan-scope.json {"files":[...]}.
  - P = packages owning those files plus their dependentsOf; F = the file count.
  - cap = clamp(900 + 450*(P-1) + 20*max(0, F-3), 900, ceiling). The ceiling is 3600 on subscription and 2400 with a dollar cap.
  - The worker resizes once after plan||wall. An explicit env or yaml cap is fixed.
  - Task-text length and the repo file count are removed from the formula.
- FC-21b(3): the receipt is the one source of truth. Outcome = receipt.verdict, and the exit code is EXIT[verdict].
  - A cap stop is shown on the Reason line and as `stop:"cap"` in --json.
  - BUDGET_STOP remains only when no receipt was sealed.

## Questions the Architect raised (decided by the CoS under the standing mandate; recorded in FOUNDER-QUEUE.md for veto)
- (a) After a limit, VERIFIED requires a Wall or task-named test to pass with n>0. ACCEPTED: Seal accuracy outranks delivered accuracy.
- (b) Install defaults ON (L1 parity with raw Claude Code, which would install deps), with the opt-out above. ACCEPTED, on two conditions: install runs only on evidence of a load error, and the tree guard is L2-classified.
- (c) Exit code 3 is dropped when a receipt is sealed. ACCEPTED (L7). It ships as a CHANGELOG "Changed" entry that names the exit-code change.

## Slices
S1 (MEDIUM, no deps): Project Model graph and install schema.
- Files: project_model/schema.ts, api.ts, discover.ts, gather.ts (computeKey salt "model-rev:2"), new project_model/graph.ts, new util/yaml_key.ts, tests/project_model/graph.test.ts, tests/util/yaml_key.test.ts, fixtures/project-model/firelater-17/response.json.
- Wall checks:
  - dependsOn naming an unknown root is rejected;
  - an absent dependsOn validates;
  - dependentsOf is transitive and ignores cycles;
  - a rev-1 cached model is rediscovered;
  - yamlKey ignores nested per_stage run_cap_s;
  - yamlKey reads CRLF.
- If FC-23 merged module-system fields into schema.ts, rebase on them.

S2 (HIGH, needs S1): package-scoped selection (FC-22a).
- Files: engine10/testmap.ts, new project_model/scope.ts, tests/engine10/fc22_select.test.ts, fixtures/monorepo-fc22/**.
- Wall checks:
  - a backend-only change selects no frontend test;
  - with frontend dependsOn backend, the frontend test is kept;
  - an absent dependsOn keeps today's selection;
  - single-package output is byte-identical;
  - an unowned test is kept;
  - implement impactedTests and hasRelevantTests are scoped the same way;
  - scoped-out tests are emitted as a verify event.

S3 (HIGH, needs S1): install pre-step library (FC-22b).
- Files: new project_model/install.ts (prepareDeps, once-per-run memo, git status snapshot before and after), the L2 destructive-path classification entry, tests/engine10/fc22_install.test.ts, fixtures/install-fc22/**.
- Wall checks:
  - one install check per load-failed package, with its cwd;
  - no command means no run and a NOT PROVEN naming the package;
  - both opt-outs skip the install;
  - it runs once across fix rounds;
  - a failed install is not_run with owner harness, never fail;
  - an install that writes a lockfile is restored and listed.

S5 (HIGH, needs S1): cap sizing and A3 (FC-21b(2)).
- Files: util/run_cap.ts, e10ext/budget_cap.ts (net <= 0 lines), stages/plan.ts (plan-scope.json), supervisor.ts (backstop at the ceiling, started.cap_ceiling_s), tests/engine10/fc21_cap.test.ts.
- Wall checks:
  - a 4-package, 4-file scope gets a larger cap than a 1-file scope;
  - a 1-file scope gets 900;
  - a long task text with a 1-file scope gets 900;
  - explicit env and yaml caps are fixed and win;
  - a nested run_cap_s is ignored;
  - CRLF yaml is read;
  - the clamp holds;
  - the e10ext cap passes.

S4 (HIGH, needs S3 and S5 merged): earned VERIFIED, A1, A2, L7 and wiring (FC-21b(1)(3)).
- Files: stages/seal.ts, stages/verify.ts, stages/implement.ts (export restoreReadOnly), machine.ts, types.ts, output.ts, worker.ts, tests/engine10/fc21_limit.test.ts, new tests/engine10/fc21b_verdict.test.ts.
- Wall checks:
  - limit plus green fix rounds with n>0 and a Wall pass is VERIFIED, with implement_limit set;
  - limit plus a red check, an unrun check, or no target check is PARTIAL;
  - a limit throw with killed false never seals VERIFIED (A1);
  - a killed session's Wall edit is restored before verify;
  - a resumed implement gets limitS <= budget - elapsed, and both briefs end with FINISH_LINE (A2);
  - CLI outcome equals receipt.verdict and the exit code is EXIT[verdict] for a cap stop;
  - core stays under 5000.

## Risks
1. With the backstop at the ceiling, a hung small task can live up to 3600s. Follow-up: re-arm the backstop on cap.sized.
2. The salt forces one rediscovery per repo. If discovery fails, selection runs unscoped and the cap is sized by file count only.
3. A wrong "no edge" from the model under-selects tests. Mitigation: dependsOn must cite a manifest, and scoped-out tests are audited.
4. Install runs repo scripts and spends the cap. Mitigation: it is evidence-triggered, guarded, and opt-out.
5. Scripts keyed on exit code 3 change behavior. Mitigation: a CHANGELOG Changed entry.
