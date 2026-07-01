# Loki + Autonomi: Competitive Gap-Analysis Backlog (2026-07-01)

From studying ToolHive, brood-box, FrontierCode, SWE-1.6/Model-UX, Devin verification/async/productivity, and Anthropic's Code Modernization Playbook, gap-analyzed against loki/autonomi's real current source. Accuracy is the moat; zero adoption friction is the top need. Research-first: each item has acceptance criteria + a validation plan. Full data: gap-analysis-backlog.json.

## Themes
- Accuracy is the moat: the highest-leverage items make loki's core 'tests green' and 'checklist passed' signals actually mean something (test-provenance, source-grounded checklists, annotate-before-act, golden-master equivalence, runtime-boot proof). These are what verified-completion / trust-as-product cashes out to.
- Adoption friction: an honest, calibrated engineering-hours/ROI estimate on the trust rail (proof.json) is the enterprise-sales lever; deterministic per-repo setup recipes reduce the top user need (reliably reaching a runnable state).
- Anti-overthinking is a prompt-orchestration problem, not a training problem: loki can stop telling the model 'never finished' and can lower the no-claim council floor; these complement the in-flight completion-claim convergence fix.
- Hosting (server-side sandbox backend, durable session, multi-tenant isolation, egress firewall) is real but scoped to autonomi-saas and already founder-gated; it does not outrank the accuracy moat despite source 'critical' labels.
- Measurement instruments (FrontierCode-style mergeability benchmark, estimator calibration set) are prerequisites, not vanity: they are the validation_plan for the accuracy and ROI items and must exist before any headline number is claimed.
- Honesty over count: five source candidates are adjacent product categories or unconsumable model-lab techniques and are dropped, not padded; the ROI chain and golden-master chain are merged to their load-bearing primitives.

## Ranked backlog

| # | value | eff | product | axis | item |
|---|---|---|---|---|---|
| 1 | critical | L | loki-mode | verification | Reverse-classical test-provenance gate (change-mode: issue/verify/healing) |
| 2 | critical | L | loki-mode | accuracy | Ground the acceptance checklist in source reality, not spec prose alone |
| 3 | high | L | loki-mode | accuracy | Annotate-before-act: pre-committed expected-outcome ledger, diffed against reality at verify time |
| 4 | critical | L | loki-mode | accuracy | Golden-master parallel-run equivalence harness + per-boundary characterization (heal/migrate) |
| 5 | high | L | loki-mode | verification | Runtime/boot smoke gate in loki verify (shipped evidence includes 'it actually runs') |
| 6 | high | L | loki-mode | adoption-friction | LLM-calibrated engineering-hours estimator emitted into proof.json per build (+ calibration gate) |
| 7 | high | M | loki-mode | adoption-friction | Persist a deterministic per-repo setup/run recipe (reusable setup skill) consumed by verify |
| 8 | high | M | loki-mode | speed | Make rarv_instruction mode-aware + add 'stop-when-verified, gates are authority' directive |
| 9 | high | M | loki-mode | accuracy | Add a mergeability rubric dimension to run_code_review (weighted, tech-lead framing) |
| 10 | medium | M | loki-mode | accuracy | Code-scope / locality gate in autonomy/verify.sh (advisory-first) |
| 11 | medium | M | loki-mode | accuracy | Wire grill findings into the verification/completion gate |
| 12 | high | L | loki-mode | accuracy | FrontierCode-style scored mergeability benchmark harness for loki change-mode output |
| 13 | medium | M | loki-mode | adoption-friction | Modernization readiness + target-selection triage (loki heal --assess, pre-flight) |
| 14 | medium | L | loki-mode | verification | Route loki heal modernize/validate through the RARV-C loop + completion council |
| 15 | medium | M | loki-mode | speed | Lower the no-claim council convergence floor so genuinely-finished no-promise runs stop sooner |
| 16 | low | S | loki-mode | speed | Instruct the inner dev agent to batch independent tool calls in a single message |
| 17 | medium | L | autonomi-saas | adoption-friction | autonomi-saas: hours-saved / ROI receipt overlay consuming loki-mode proof.json effort_estimate |
| 18 | low | S | loki-mode | hosting | Add optional bearer-token auth + explicit loopback bind to loki mcp --transport http |
| 19 | medium | XL | autonomi-saas | hosting | autonomi-saas: hosted sandbox backend abstraction (gVisor-first) behind a SandboxBackend interface |
| 20 | medium | L | autonomi-saas | hosting | autonomi-saas: externalize the session as a durable append-only log decoupled from the sandbox |

## Assessed NOT applicable (CTO triage - declined with reason)

- **ToolHive-style per-MCP-server container isolation / curated registry / secrets vault (source: ToolHive)**: Presupposes running UNTRUSTED third-party MCP servers. Loki ships only first-party servers and uses --strict-mcp-config (providers/claude.sh:209) to actively EXCLUDE arbitrary third-party servers. Building a registry/containment layer adds adoption friction and code loki does not need for its threat model (it runs code it wrote). Adjacent product category. Source itself marked applicable=false (effort XL).
- **ToolHive as inspiration for autonomi hosting IF/when it hosts third-party MCP servers (source: ToolHive)**: Cannot be verified from this tree (autonomi is a separate private repo) and is gated on autonomi actually hosting untrusted third-party MCP servers, which is not a current requirement. Recorded as autonomi-hosting inspiration only, not a loki-mode backlog item. Source marked applicable=false. (Note: the gateway-auth primitive that IS directly consumable is captured as rank 18 for loki's own mcp http command.)
- **Integrate brood-box or Anthropic Managed Agents as a runtime dependency (source: brood-box / Managed Agents)**: brood-box is a local-developer agent sandbox CLI (adjacent product category loki's own three-tier sandbox already covers for local use); Managed Agents is a hosted Anthropic PLATFORM loki competes with, not an API loki consumes. The repo already made this triage (docs/ECOSYSTEM-CURRENCY-PLAN.json:77). The correct move is borrowing the architectural PATTERNS (decoupling, disposable untrusted sandbox, diff-then-flush) into autonomi's own founder-gated backend (ranks 19-20), not bolting on either tool. Source marked applicable=false.
- **mutagent-style adaptive test grading (source: FrontierCode)**: An internal benchmark-authoring tool for a third-party eval grader: LLMs surgically adapt a hidden-canonical-answer test env so open-ended solutions grade deterministically. Loki does not grade external agents' solutions against hidden canonical answers, so there is no consumer inside loki/autonomi. Adjacent product category. Source marked applicable=false (effort XL).
- **Training-time length penalty (source: SWE-1.6 Model UX)**: Cognition's headline fix was a length penalty during model POST-TRAINING. Loki is an orchestration layer over a hosted model (claude -p) and cannot retrain or add a training-time penalty. Adjacent (model-lab technique). The consumable analogs are delivered structurally via ranks 8, 15, 16 (stop telling the model never to stop; lower the no-claim floor; batch tool calls). Source marked applicable=false (effort XL).

## Detail (acceptance criteria + validation plan per item)

### #1 Reverse-classical test-provenance gate (change-mode: issue/verify/healing) (loki-mode, critical/L)
Before counting an agent's NEW tests as affirmative 'green' evidence in council_evidence_gate, run them against the pre-change base (VERIFY_MERGE_BASE / _LOKI_RUN_START_SHA) and require they FAIL on base and PASS on HEAD. Tests that pass on both base and HEAD are tautological and marked inconclusive, not affirmative. No-op on greenfield (no base) and when LOKI_TEST_PROVENANCE=0. This is the single highest-value accuracy-moat item: it makes loki's strongest verification signal (tests-green) actually mean something and directly attacks the 'test written to pass, proving nothing' failure mode.
Acceptance criteria:
- Given a change-mode run with a resolvable base, test files added/modified in the diff are identified
- New/changed tests are run against base (checkout or reverse-patch); which FAIL on base is recorded
- In council_evidence_gate (completion-council.sh:1621-1688) a completion claim whose only test evidence is provenance-UNconfirmed (passes on base) is marked inconclusive, never affirmative VERIFIED
- A trust event + .loki record lists each new test with base-fail/head-pass status
- Byte-identical no-op on greenfield and when LOKI_TEST_PROVENANCE=0
Validation: Fixture harness with two change-mode tasks: (A) a genuine fix with a test that fails on base + passes on HEAD, (B) a tautological test that passes on both. Assert: A is counted affirmative, B is downgraded to inconclusive and surfaced as a finding. Prove no-op via byte-diff of build_prompt/gate output on a greenfield run before/after. Cross-validate against the FrontierCode-style mergeability benchmark (rank 12): provenance-confirmed tasks should score higher on the reverse-classical dimension.

### #2 Ground the acceptance checklist in source reality, not spec prose alone (loki-mode, critical/L)
Extend checklist_oracle_triangulate beyond datastore to triangulate the checklist against the actual codebase: discovered HTTP routes/handlers (does each spec'd endpoint map to a real handler?), CLI commands, exported public API symbols (via the LSP proxy lsp_workspace_symbols / lsp_check_exists), and >=1 high-value domain invariant (passwords hashed not plaintext; money not float). Auto-generate deterministic checks (http_check, lsp_check_exists) instead of relying on the same LLM that wrote the code to author acceptance checks from the same prose. Attacks the single-oracle weakness the code itself flags as deferred (prd-checklist.sh).
Acceptance criteria:
- For a web project, every endpoint named in the spec maps to a real route/handler in source; unmatched -> High finding (mirrors existing oracle-datastore-conflict shape)
- Spec'd public API symbols verified to exist via the LSP proxy, not LLM-authored grep_codebase checks
- At least one domain-invariant check implemented as a deterministic gate (e.g. password fields hashed)
- Greenfield/absent (nothing wired yet) does NOT fire a finding, matching existing non-conflict guards
Validation: Fixture repos: (A) spec names endpoint /orders that exists -> no finding; (B) spec names /orders but no handler -> High finding; (C) plaintext password store -> invariant finding. Measure false-positive rate on 3 clean real repos (must be zero). Prove accuracy lift on the FrontierCode-style benchmark (rank 12): source-grounded checklists should catch wrong-but-internally-consistent implementations that prose-only checklists pass.

### #3 Annotate-before-act: pre-committed expected-outcome ledger, diffed against reality at verify time (loki-mode, high/L)
Before running verification for a change/checklist-item, the runtime writes a tamper-evident ledger of EXPECTED observable outcomes (e.g. 'GET /health -> 200 {status:ok}', 'test X fails before fix, passes after', 'endpoint Y should now exist'). At verify time, actual results are compared to the pre-committed prediction; any expectation silently dropped or contradicted becomes a finding. Reuse the proof-verify canonical-hash + drift pattern so the ledger is tamper-evident and edits-after-the-fact are detectable. Forces a falsifiable prediction, cutting self-serving post-hoc rationalization.
Acceptance criteria:
- .loki/expectations/<iter>.json written BEFORE the verify/checklist run, each entry {id, statement, check_ref, expected}, canonicalized and hashed like proof-generator
- loki verify (or the completion gate) reads the ledger and emits a finding for any expectation with no matching executed check, or whose actual contradicts expected
- An unevaluable expectation maps to inconclusive->CONCERNS, never VERIFIED (reuse verify.sh Entanglement-2)
- The ledger hash is embedded in evidence.json/proof.json so an edited-after-the-fact expectation is detectable
Validation: Test: seed a ledger with 3 expectations, run verify, assert (1) a met expectation passes, (2) a contradicted one is a finding, (3) a dropped/unexecuted one is a finding, (4) editing the ledger after write breaks the embedded hash. Before/after: same build with ledger disabled vs enabled must surface >=1 contradiction that post-hoc-only grading missed on a deliberately-mismatched fixture.

### #4 Golden-master parallel-run equivalence harness + per-boundary characterization (heal/migrate) (loki-mode, critical/L)
MERGED (harness + boundary-characterization). During archaeology/guardrail, capture outputs at natural system boundaries (CLI stdout/exit, HTTP responses, DB state deltas, file/queue outputs) into .loki/healing/behavioral-baseline/ as golden masters. During modernize/validate, re-run the SAME boundary probes against modernized code and diff. Replace hook_post_healing_modify's current whole-suite pass/fail (migration-hooks.sh:580) with per-boundary comparison so verification is implementation-agnostic and cannot be satisfied by overfit unit tests. Any divergence blocks the phase gate unless documented as intentional. Turns the playbook's 'side-by-side identical outputs' from a prompt suggestion into machine-verified evidence. The behavioral-baseline/ dir is currently mkdir'd (loki:14323) but never populated or compared.
Acceptance criteria:
- cmd_heal archaeology (and migrate guardrail) writes >=1 golden-master artifact per detected boundary into .loki/healing/behavioral-baseline/
- hook_healing_phase_gate for modernize->validate fails closed unless boundary outputs match baseline OR a documented-intentional-change record exists
- hook_post_healing_modify compares boundary outputs to baseline, not only whole-suite exit code; a change keeping unit tests green but altering a CLI/API boundary is BLOCKED
- diff report enumerates every changed boundary (old vs new) in loki heal --report and structured evidence JSON
- Degrades honestly ('no boundaries detected') rather than false-green
Validation: Fixture: a Python2->Python3 (or C->Java) sample repo. Capture baseline, apply (1) a behavior-preserving refactor -> gate passes; (2) a transform that keeps unit tests green but changes a CLI output -> gate BLOCKS. Assert baseline artifacts exist post-archaeology (grep count > 0, currently 0). Matches references/legacy-healing-patterns.md:156-181 prescribed system-boundary approach.

### #5 Runtime/boot smoke gate in loki verify (shipped evidence includes 'it actually runs') (loki-mode, high/L)
Promote the build-loop's playwright/http smoke into loki verify as a deterministic runtime gate: detect the start command (or use the persisted setup recipe from rank 9), boot the app with a timeout, hit a health/root path, capture status + a screenshot artifact, tear down, record in evidence.json as reproducible. Closes the biggest trust gap vs Devin (compiles + green-tests != works); the screenshot becomes a proof artifact. Runtime-not-reachable -> inconclusive->CONCERNS, never VERIFIED. Fail-open: without a detectable app, output is byte-identical to today.
Acceptance criteria:
- verify_gate_runtime added to verify_main gate list, skipped (not failed) only when no start command/setup recipe is detectable
- A successful boot records HTTP status + artifact path in evidence.json with reproducible=true
- Boot failure -> Critical/High finding; boot-not-attempted-but-app-detected -> inconclusive->CONCERNS
- No regression: without a detectable app, output byte-identical to today (mirrors --hosted fail-open pattern)
Validation: Fixture web app: (A) healthy boot -> evidence.json has status 200 + screenshot path + reproducible=true; (B) broken start command -> Critical finding, verdict not VERIFIED; (C) library repo with no app -> gate skipped, evidence.json byte-identical to pre-change baseline (diff must be empty).

### #6 LLM-calibrated engineering-hours estimator emitted into proof.json per build (+ calibration gate) (loki-mode, high/L)
MERGED (estimator + calibration). Replace the iterations x 15min heuristic (loki:23478) with an LLM estimator that reads the actual work (diff stat, files changed, tests written, task/PRD scope, iteration transcript) and predicts equivalent human-engineering-hours plus a low/high band. Persist as an effort_estimate object in per-build proof.json so it rides the trust/evidence rail. Fall back to the heuristic when no LLM is available, labeled 'heuristic (uncalibrated)' vs 'estimated' so the number is never silently fabricated. Ship a validation harness (ground-truth engineer-hour set) that computes an error metric (r_log or MAE-in-log-space); estimates may only be labeled 'calibrated' once the metric clears a threshold. This is the load-bearing primitive both the dollar ROI surface and any guarantee depend on, and it directly serves the 'accuracy is the moat, no fabrication' rule.
Acceptance criteria:
- proof.json gains effort_estimate: {hours, low, high, method:'llm'|'heuristic', model, inputs_hash}
- loki metrics TIME SAVED reads per-build estimates when present, falls back to iterations x 15min only when absent, labeling the method
- Estimator input is real work (diff stat + files + tests + scope), NOT iteration count alone; unit test feeds two builds of different scope and asserts different hours
- A validation dataset of builds with engineer-hour ground truth exists in benchmarks/; estimator error metric computed and reported; threshold gates 'calibrated' vs 'uncalibrated' labeling
- No LLM -> heuristic path clearly labeled 'heuristic (uncalibrated)', never presented as validated
Validation: Unit test: two builds of clearly different scope (2-iter schema tweak vs full-stack feature) must yield materially different hours (heuristic gives both 30min; assert estimator does not). Calibration: score LLM estimates against the ground-truth set, report r_log/MAE; assert copy stays 'uncalibrated' until threshold cleared. This IS the validation gate for the entire ROI chain.

### #7 Persist a deterministic per-repo setup/run recipe (reusable setup skill) consumed by verify (loki-mode, high/M)
On first successful build/boot, save .loki/setup-recipe.json capturing deterministic steps to install, seed, auth, and start the app (commands + env var NAMES + health path). Replay on subsequent verify/e2e runs instead of re-detecting heuristically. This is Devin's 'saved login/setup skill'; it reduces the top adoption need (reliably reaching a runnable state) and enables the runtime gate (rank 5) for repos needing auth/seed. Distinct from cmd_setup_skill (which installs the Loki skill, not a repo recipe). Secrets never persisted (only env var NAMES; reuse proof_redact.py).
Acceptance criteria:
- .loki/setup-recipe.json written after a verified boot with {install, seed, env_keys(no secret values), start, health_path}
- verify_gate_runtime prefers the recipe over heuristic detection when present
- Secrets never persisted into the recipe (only env var NAMES); reuse proof_redact.py patterns
- Recipe replayed idempotently and its use recorded in evidence.json
Validation: Fixture repo needing seed+auth: first run writes recipe; second run reaches runnable state via recipe (assert no heuristic re-detection ran, e.g. log marker). Assert recipe contains env var NAMES but zero secret VALUES (grep for known secret pattern must return nothing). Measure: time-to-runnable second run < first run.

### #8 Make rarv_instruction mode-aware + add 'stop-when-verified, gates are authority' directive (loki-mode, high/M)
MERGED (mode-aware rarv + stop directive). build_prompt currently emits the same 'There is NEVER a finished state - always find the next improvement' rarv_instruction (run.sh:13770) in every mode, including PRD/checkpoint runs just auto-switched to finite scope (a direct self-contradiction). Gate it on AUTONOMY_MODE/PERPETUAL_MODE: for finite runs replace with 'When the PRD requirements are implemented and completion gates pass, claim done via loki_complete_task and STOP; do not add unrequested improvements. Verify once -- the completion gates (tests, checklist, evidence) are the authority on done; do not re-verify redundantly.' Keep never-finished text only for genuine perpetual mode. Delete the unverifiable '2-3x quality improvement' clause (biases toward redundant self-verification). This is the orchestration analog of Cognition's length penalty and the prompt root of the 14-iter convergence bug. COMPLEMENTARY to the in-flight 'council evaluates on completion claim' fix (that changes when the council checks; this stops the prompt telling the model never to stop) -- not a duplicate.
Acceptance criteria:
- In a PRD run (auto-switched to checkpoint) the emitted build_prompt no longer contains 'There is NEVER a finished' or 'always find the next improvement'
- In a perpetual/no-promise run the never-finished text still appears (behavior preserved)
- The '2-3x quality improvement' clause removed from all modes; finite-mode prompt contains the concise 'stop when verified-done, gates are the authority' directive
- Deterministic completion gates (council_evidence_gate/checklist/heldout/assumption) unchanged and still block on failure
- loki-ts/src/runner/build_prompt.ts parity string updated (parity-locked)
Validation: String assertions on emitted build_prompt for each mode (finite lacks 'NEVER finished', perpetual retains it; '2-3x' absent everywhere). Behavioral: a spec satisfiable in ~1 iteration claims completion within a small bounded iteration count on a benchmark spec, with all completion gates still passing (verification not weakened -- run completion-council tests, assert no coverage regression). Confirm dual-route (bash + Bun) parity.

### #9 Add a mergeability rubric dimension to run_code_review (weighted, tech-lead framing) (loki-mode, high/M)
Extend (do not replace) the existing severity mechanism with a 'maintainer-mergeability' reviewer whose rubric covers scope creep, dead/duplicated code, and conformance to the surrounding code's conventions -- and have the aggregator produce a weighted quality SCORE alongside the binary block verdict (FrontierCode-style: 0 on any blocker, else weighted non-blocker sum). Reuse has_blocking (run.sh:10770) for the blocker layer; add the weighted score as a reported quality metric, not a new hard gate initially. Upgrades loki's review from 'CI + architecture' toward 'tech lead' on the axes it currently misses (the specialist pool is security/test/perf/dependency/architecture; none carries a 'would a maintainer merge this' mandate).
Acceptance criteria:
- A mergeability-focused reviewer added to the pool with a rubric prompt covering scope, dead code, and convention-conformance
- Aggregator emits a numeric quality score (0 if any blocker, else weighted non-blocker sum) in aggregate.json
- Existing Critical/High = block, Medium/Low = non-blocking behavior preserved unchanged
- Score reported/surfaced but not a new hard gate without explicit opt-in flag
- No emojis/em-dashes in prompt text; dual-route (bash + Bun) parity maintained
Validation: Fixture PRs: (A) tight 3-file fix -> high score, no scope blocker; (B) 40-file sprawling diff touching unrelated code -> scope blocker, score 0. Assert existing block behavior unchanged on a known-Critical fixture. Prove the score is discriminating on the FrontierCode-style benchmark (rank 12): mergeable vs unmergeable tasks should separate on the weighted score.

### #10 Code-scope / locality gate in autonomy/verify.sh (advisory-first) (loki-mode, medium/M)
Turn the already-computed VERIFY_DIFF_FILES/INS/DEL (verify.sh:154-164) into an enforced gate: configurable caps on total files changed and net line growth, plus an optional LLM semantic-locality check that flagged edits stay within the files/functions the task requires. Emit a 'scope' record on violation. Advisory-with-warning by default (record, don't hard-block) to avoid adoption friction; LOKI_SCOPE_ENFORCE=1 makes it blocking. Over-broad diffs are the #1 human merge-rejection reason FrontierCode targets, and loki currently measures the numbers but never uses them as a gate. N/A to greenfield full builds.
Acceptance criteria:
- verify.sh emits a structured scope record: files_changed, net_lines, verdict (ok|warn|block) with thresholds used
- Thresholds configurable via env (LOKI_SCOPE_MAX_FILES, LOKI_SCOPE_MAX_NET_LINES) with sane defaults
- Advisory by default (surfaces in verify output + SARIF), blocking only under LOKI_SCOPE_ENFORCE=1
- Optional semantic-locality LLM check gated behind its own flag (off by default, zero added latency/cost)
- No behavior change on greenfield loki start
Validation: Fixture change-mode diffs: (A) 3 files within scope -> verdict ok; (B) 40 files -> verdict warn (default) and block under LOKI_SCOPE_ENFORCE=1. Assert greenfield loki start output byte-identical before/after. Assert the scope record appears in evidence.json + SARIF.

### #11 Wire grill findings into the verification/completion gate (loki-mode, medium/M)
Feed the pre-build Devil's-Advocate grill's surfaced ambiguities/missing-acceptance-criteria into checklist generation and the completion gate: unresolved High grill findings become required checks or block completion until acknowledged (reuse the existing assumption-ledger gate in completion-council.sh). grill.sh currently writes a standalone report never consumed by verify/council. Makes the Devil's-Advocate posture actually harden what gets verified rather than being advisory-only.
Acceptance criteria:
- grill High findings converted into checklist items or assumption-ledger entries
- Unresolved High grill findings block completion via an existing gate path (not a new bespoke one)
- Opt-out knob preserves current standalone behavior
- No double-firing when grill was not run (gate inert, like the held-out gate NONE branch)
Validation: Fixture spec with a known ambiguity: run grill -> High finding -> assert it becomes a required check and blocks completion until acknowledged. Assert gate is inert (no finding) when grill was not run. Confirm reuse of the assumption-ledger path (no new bespoke gate) via code inspection + existing completion-council test suite passing.

### #12 FrontierCode-style scored mergeability benchmark harness for loki change-mode output (loki-mode, high/L)
Not a runtime feature -- the measurement instrument. Assemble a small suite of change-mode tasks with maintainer rubrics (blocker + weighted non-blocker) and reverse-classical tests, run loki verify / issue-mode against them, and produce a per-task mergeability score. This is what lets loki claim an accuracy/mergeability number and is the validation_plan backbone for ranks 1, 2, 9, 10. Aligns with pending task #49 (reproducible speed+accuracy benchmark) and #51 (council/RARV-C research update, gated on benchmark).
Acceptance criteria:
- A handful of tasks with base repo + rubric (blocker/non-blocker) + reverse-classical tests
- Harness runs loki change-mode and produces a per-task mergeability score
- Reproducible, documented, wired into the existing benchmarks/ conventions
- Reports a headline mergeability % comparable across loki versions
Validation: Self-validating: run harness on current loki, record baseline mergeability %. Re-run after ranks 1/2/9 land; assert the % moves (this IS the before/after proof for the accuracy items). Reproducibility check: two runs on the same loki version produce the same score within tolerance.

### #13 Modernization readiness + target-selection triage (loki heal --assess, pre-flight) (loki-mode, medium/M)
Add loki heal --assess (or a readiness step auto-run before archaeology) that scans a codebase read-only and outputs: estimated LOC/language mix, technical-debt signals, maintenance-risk indicators, placement on the playbook's 4-level maturity model, and a RANKED list of low-risk high-visibility targets to start with (playbook weeks 1-2). Reduces the top adoption-friction question 'where do I start' to one command, reusing loki's existing complexity-detection machinery. Human-readable + structured JSON for the dashboard.
Acceptance criteria:
- Single command emits a readiness report with maturity-level placement + ranked candidate targets + rationale
- Ranking prefers isolated/low-blast-radius modules (matches playbook weeks 1-2)
- Runs read-only (no modification), zero required flags
- Output is both human-readable and structured JSON for the dashboard
Validation: Fixture legacy repo with a mix of isolated and highly-coupled modules: assert the ranking places the isolated module above the coupled one, assert zero filesystem modifications (git status clean after run), assert valid JSON output parses.

### #14 Route loki heal modernize/validate through the RARV-C loop + completion council (loki-mode, medium/L)
loki heal is single-shot per phase (claude -p, loki:14465-14502), bypassing the RARV-C loop, completion council, and 8 quality gates that make loki start/migrate trustworthy. For behavior-changing phases (stabilize/isolate/modernize/validate), execute via run_autonomous with LOKI_INJECT_FINDINGS/LOKI_OVERRIDE_COUNCIL/LOKI_AUTO_LEARNINGS auto-enabled and the legacy-healing-auditor in the review pool. Archaeology-only can stay single-shot. Gives modernization builds the same iterative verification and override-council trust loki start already provides.
Acceptance criteria:
- cmd_heal for phases stabilize|isolate|modernize|validate invokes the RARV loop (run.sh path), not a bare claude -p call
- RARV-C closure flags default-on within heal (documented in skills/healing.md, verified by grep of cmd_heal)
- legacy-healing-auditor fires and can BLOCK on behavioral change without characterization update
- A deliberately-broken transform is caught + reverted by the loop, proven on a fixture
Validation: Fixture: run heal modernize with a deliberately-broken transform; assert the RARV loop catches + reverts it (vs current single-shot which would ship it). Grep cmd_heal to confirm run_autonomous path taken for the four phases. Assert legacy-healing-auditor appears in the review pool during heal. Pairs with rank 4 golden-master for the behavioral-change block proof.

### #15 Lower the no-claim council convergence floor so genuinely-finished no-promise runs stop sooner (loki-mode, medium/M)
For the convergence-detection (NO explicit completion claim) path only, reduce the effective floor: allow council_should_stop to evaluate as early as MIN_ITERATIONS=1 when tests+checklist evidence already indicate done, or check every iteration once evidence is green instead of every 5th (currently CHECK_INTERVAL=5, MIN_ITERATIONS=3). The explicit-claim path already bypasses this (run.sh:17418), so this only helps analysis-mode / no-promise runs -- COMPLEMENTARY to the in-flight 'council evaluates on completion claim' fix (which is the explicit-claim path), not a duplicate. Keep stagnation and evidence gates intact -- changes WHEN the stop check runs, not WHETHER work is verified.
Acceptance criteria:
- A no-promise run that is genuinely complete can stop before iteration 5 when evidence gates pass
- Stagnation and evidence gates (completion-council.sh) still block premature/unverified stops
- Explicit-claim completion path behavior unchanged
- Gated behind existing LOKI_COUNCIL_CHECK_INTERVAL/MIN_ITERATIONS so operators can restore old behavior
Validation: Fixture no-promise/analysis run that is complete by iteration 2: assert it can stop before iteration 5 with evidence gates green. Negative test: an unverified/stagnating run still does NOT stop early (evidence gate blocks). Assert explicit-claim path timing unchanged via existing completion-council tests.

### #16 Instruct the inner dev agent to batch independent tool calls in a single message (loki-mode, low/S)
Add a short build_prompt directive (all modes): 'When issuing independent read-only operations (reads, greps, file lookups, LSP checks) that do not depend on each other, issue them in a single message so they run in parallel; do not serialize independent lookups.' The direct, cheap analog of Cognition's parallel-tool-call fix at the exact layer loki controls (the prompt to claude -p). Zero adoption friction (internal prompt string), no verification impact. Parity mirror in loki-ts.
Acceptance criteria:
- build_prompt emits a parallel/batch tool-call directive in every mode
- Parity mirror added to loki-ts/src/runner/build_prompt.ts
- Directive is <= 2 sentences and adds no new env knob
- A representative run shows the inner agent issuing at least one multi-tool-call message for independent lookups (spot-checked in agent.log / stream-json)
Validation: String assertion: directive present in all build_prompt mode variants and in loki-ts parity string. Behavioral spot-check: on a representative run, grep agent.log/stream-json for at least one message issuing multiple independent tool calls. Confirm no new env knob added.

### #17 autonomi-saas: hours-saved / ROI receipt overlay consuming loki-mode proof.json effort_estimate (autonomi-saas, medium/L)
In autonomi-saas, overlay the per-build effort_estimate from loki's proof.json (rank 6) onto the Evidence Receipt and aggregate into an account-level ROI dashboard ('this month: ~N engineer-hours, ~$M at a configurable blended rate'). Aggregation matches the level where the estimator is honest (Devin's aggregation-honest framing). $ requires an operator-set rate; unset shows hours only, never a fabricated dollar figure. The natural home for a Devin-style productivity guarantee (SaaS carries billing/tenancy); the guarantee is founder-gated and blocked until the estimator is calibrated (rank 6). No cross-tenant leakage (respects the per-build two-read split used for #17).
Acceptance criteria:
- BFF reads proof.json effort_estimate per build and stores it against the tenant/build
- Account view aggregates hours (+ $ if rate set) across builds, labeled with the aggregation-honest caveat
- Guarantee logic (if pursued) founder-gated and blocked until estimator has a validation number
- No cross-tenant leakage in the aggregate (respects the per-build two-read split for #17)
Validation: Two-tenant fixture: assert tenant A's aggregate excludes tenant B's builds (cross-tenant leak test, reuse #17 harness). Assert $ absent when no rate configured. Assert guarantee copy is blocked/hidden while estimator method='heuristic' or label='uncalibrated'. Depends on rank 6 shipping first.

### #18 Add optional bearer-token auth + explicit loopback bind to loki mcp --transport http (loki-mode, low/S)
The one place loki's surface maps directly onto ToolHive's gateway. mcp/server.py:2639 calls mcp.run(transport='http', port=args.port) with no explicit host and no auth. Pass an explicit host (default 127.0.0.1) and support an optional LOKI_MCP_AUTH_TOKEN that the server requires on every request. Low-cost hardening of an already-shipping command; loopback default unchanged (zero adoption friction, token opt-in). Latent-not-exposed today (FastMCP loopback default) but the explicit bind + opt-in token close it honestly.
Acceptance criteria:
- loki mcp --transport http binds 127.0.0.1 explicitly (verified via ss/lsof, not 0.0.0.0)
- When LOKI_MCP_AUTH_TOKEN is set, requests without a matching bearer are rejected 401; when unset, behavior is unchanged
- Docs note the token env var; default local stdio path untouched
Validation: Start loki mcp --transport http, verify bind address via lsof/ss is 127.0.0.1 not 0.0.0.0. With LOKI_MCP_AUTH_TOKEN set: request without bearer -> 401, with matching bearer -> 200. With it unset: behavior byte-identical to today. Confirm stdio path unaffected.

### #19 autonomi-saas: hosted sandbox backend abstraction (gVisor-first) behind a SandboxBackend interface (autonomi-saas, medium/XL)
FOUNDER-GATED. Define one SandboxBackend interface (create/exec/collect-diff/flush/destroy) and implement gVisor as the first backend for per-build/per-verification isolation, mirroring Managed Agents' disposable untrusted-sandbox. Concrete unblock for founder-gated backlog ranks 14/36/42. Borrow brood-box's diff-then-flush and Managed Agents' decoupling as PATTERNS, not dependencies; libkrun-microVM is a strong second backend to evaluate in the selection spike. Sandbox treated as untrusted: no tenant secrets/signing keys reachable from inside. This is real but scoped to autonomi and already triaged/founder-gated in the repo docs; it does NOT outrank the accuracy moat despite the source 'critical' label.
Acceptance criteria:
- A SandboxBackend interface exists with create/exec/collect-diff/flush/destroy and at least one working backend (gVisor)
- Each hosted build/verification runs in its own disposable sandbox destroyed on completion
- Sandbox is treated as untrusted: no tenant secrets or signing keys reachable from inside
- Selection spike documents gVisor vs Firecracker vs Kata vs libkrun with a chosen default + rationale (satisfies rank 42)
- Pre-flush diff review gates change persistence; per-domain egress allowlist (default provider API + git host, deny-by-default option); secret paths (.env*, keys) non-overridably excluded from any flushed change set
Validation: Isolation test: attempt to read a mounted tenant secret from inside the sandbox -> must fail. Disposability: assert sandbox is destroyed post-build (no lingering container). Egress: request to a non-allowlisted domain blocked, provider API + git host allowed. Diff-then-flush: an unapproved change is not persisted to the tenant workspace. Founder-gated: do not start until the founder unblocks; kept below the accuracy moat.

### #20 autonomi-saas: externalize the session as a durable append-only log decoupled from the sandbox (autonomi-saas, medium/L)
FOUNDER-GATED. Move build state off local .loki/ files into a durable session store (the persistence backend at backlog rank 16) so the harness/sandbox can crash or scale horizontally without losing progress -- Managed Agents' session/harness/sandbox decoupling. Enables resume-across-workers and starting reasoning before the sandbox is fully provisioned. NOT applicable to loki-mode local (its .loki/ file state is correct for single-user). Scoped to autonomi, founder-gated; below the accuracy moat.
Acceptance criteria:
- A PersistenceBackend interface with a first prod store (Postgres or SQLite) exists (satisfies backlog rank 16)
- A hosted build survives a worker/sandbox restart and resumes from the durable session
- The harness reads session state independently of any specific sandbox instance
Validation: Crash-resume test: kill the worker/sandbox mid-build, restart, assert the build resumes from the durable session with no lost progress. Horizontal test: two workers read the same session store without corruption. Assert loki-mode local .loki/ path is untouched (scoped to autonomi only).

