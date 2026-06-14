# Quality Gates

**Never ship code without passing all quality gates.**

## The 11 Quality Gates

1. **Input Guardrails** - Validate scope, detect injection, check constraints (OpenAI SDK)
2. **Static Analysis** - CodeQL, ESLint/Pylint, type checking
3. **Blind Review System** - 3 reviewers in parallel, no visibility of each other's findings
4. **Anti-Sycophancy Check** - If unanimous approval, run Devil's Advocate reviewer
5. **Output Guardrails** - Validate code quality, spec compliance, no secrets (tripwire on fail)
6. **Severity-Based Blocking** - Critical/High/Medium = BLOCK; Low/Cosmetic = TODO comment
7. **Test Coverage Gates** - Unit: 100% pass, >80% coverage; Integration: 100% pass
8. **Mock Detector** - Classifies internal vs external mocks; flags tests that never import source code, tautological assertions, and high internal mock ratios
9. **Test Mutation Detector** - Detects assertion value changes alongside implementation changes (test fitting), low assertion density, and missing pass/fail tracking
10. **Backward Compatibility** - Behavioral preservation, friction safety, institutional knowledge retention (healing mode)
11. **Documentation Coverage** - README exists, docs freshness within 10 commits, API docs for packages

## Gate 10: Backward Compatibility & Behavioral Preservation (v6.67.0)

**Triggered when:** `LOKI_HEAL_MODE=true` or `loki heal` is active, or diff touches files flagged in `.loki/healing/friction-map.json`.

**Purpose:** Prevent accidental removal of institutional logic or behavioral changes to legacy code without explicit documentation.

**Checks:**
1. **Friction Safety** - If modified code matches a friction-map entry, verify `safe_to_remove` is true or `classification` is `true_bug`
2. **Characterization Test Coverage** - Modified legacy components must have characterization tests in `.loki/healing/characterization-tests/`
3. **Comment Preservation** - Deleted comments containing business rule keywords (hack, workaround, compliance, per requirement) must be extracted to `institutional-knowledge.md` first
4. **Adapter Verification** - Replaced components must have an adapter layer that preserves the original interface
5. **Behavioral Baseline** - If a baseline exists in `.loki/healing/behavioral-baseline/`, outputs must match or differences must be documented as intentional

**Severity:**
- Removing friction point classified as `business_rule` or `unknown` without approval = **Critical** (BLOCK)
- Missing characterization test for modified legacy component = **High** (BLOCK)
- Deleted business rule comment without knowledge extraction = **Medium** (BLOCK)
- Missing adapter for replaced component = **High** (BLOCK)
- Behavioral baseline mismatch without documentation = **Medium** (BLOCK)

**Disabling**: gate 10 only fires when `LOKI_HEAL_MODE=true` or
`.loki/healing/friction-map.json` exists in the project root (v7.4.20).
Greenfield projects skip the auditor entirely. To suppress on a healing
project, set `LOKI_HEAL_MODE=false`.

---

## Gate 11: Documentation Coverage (v6.75.0)

**Triggers when:** Diff touches public APIs, new files added, library/package releases

**Checks:**
- Every exported function/class/endpoint has a doc entry in `.loki/docs/`
- README.md exists and is non-empty in project root
- Documentation SHA is within 10 commits of HEAD
- CLAUDE.md (if exists) references current key files

**Severity:**
- Missing API docs = Medium (BLOCK for npm/pip packages)
- Stale docs = Low (TODO)

**Skip:** Internal-only changes, test-only changes, config changes

**Disabling (not recommended for packages):**
```bash
LOKI_GATE_DOC_COVERAGE=false  # Disable gate 11
```

---

## Gate 8 and 9: Automated Test Integrity

Gates 8 (Mock Detector) and 9 (Test Mutation Detector) run during the VERIFY phase and are enabled by default.

**How they run:**
- Gate 8 runs `tests/detect-mock-problems.sh` against all test files in the project
- Gate 9 runs `tests/detect-test-mutations.sh` against recent commits (default: last 5, or use `--commit HASH` for targeted checks)
- Both produce findings at HIGH/MEDIUM/LOW severity levels
- HIGH findings = automatic FAIL (same as other blocking gates)

**Disabling**: gates 8 and 9 are baked into the test pipeline (the bash
scripts at `tests/detect-mock-problems.sh` and
`tests/detect-test-mutations.sh`); they have no env-var toggle today.
Skip the gate by not running the script in your CI.

---

## v7.5.0 Phase 1 environment flags

These four flags activate the override council and structured-findings
pipeline added in v7.5.0. All default off; behavior is byte-identical
when unset.

```bash
LOKI_INJECT_FINDINGS=1     # inject structured per-finding records into the
                           # next iteration's prompt (instead of just the
                           # comma-separated gate-failure tokens)

LOKI_OVERRIDE_COUNCIL=1    # enable the 3-judge override council on BLOCK
                           # when .loki/state/counter-evidence-<iter>.json
                           # exists. Requires LOKI_INJECT_FINDINGS=1.

LOKI_AUTO_LEARNINGS=1      # auto-write structured learnings to
                           # .loki/state/relevant-learnings.json on every
                           # code_review gate failure

LOKI_HANDOFF_MD=1          # write a structured handoff doc to
                           # .loki/escalations/handoff-*.md before PAUSE
                           # (in addition to the bare PAUSE signal)
```

Optional: `LOKI_AUTO_LEARNINGS_EPISODE=1` also writes the learning into
the Python episodic memory layer via `memory.engine.save_episode`.

## Default-on verification-integrity gates (v7.41.1)

These three gates are default-ON accuracy guards (opt-out, never opt-in).
They close "verification theater" gaps where a gate could pass without
actually verifying. Set each to its off value only to restore the older
half-blind behavior.

```bash
LOKI_REVIEW_INCONCLUSIVE_BLOCK=1  # default 1. Treat a code-review round that
                                  # produced no parseable VERDICT (NO_OUTPUT
                                  # or zero real verdicts) as a BLOCK instead
                                  # of a silent pass. Set 0 to disable.

LOKI_COMPLETION_TEST_CAPTURE=1    # default 1. The verified-completion gate
                                  # captures fresh test evidence when
                                  # test-results.json is absent, instead of
                                  # passing half-blind. Set 0 to disable.

LOKI_AUTO_DOCS=true               # default true. Auto-generate the .loki/docs/
                                  # suite in the loop before the documentation
                                  # gate scores, instead of nagging the user to
                                  # run 'loki docs generate'. Set false to disable.
```

The code-review diff also excludes `.loki/` and `.git/` (top-level and
nested `**/.loki/**`) so reviewers score real source changes, not runtime
state bloat. This is unconditional, not gated.

## Other opt-in environment flags (Release 3)

Two more default-off flags added for hybrid search and parallel concurrency.
Both are no-ops when unset (behavior identical to before).

```bash
LOKI_DYNAMIC_CONCURRENCY=1       # scale the parallel-session cap DOWN under
                                 # CPU/memory pressure (default off). Full
                                 # knobs and defaults: skills/parallel-workflows.md
                                 # (Dynamic Resource-Aware Session Concurrency)

LOKI_CODE_INDEX_AUTOREINDEX=1    # auto incremental re-index of the semantic
                                 # code index before a search when stale
                                 # (default off = warn-if-stale). Details:
                                 # references/mcp-integration.md (Built-in
                                 # Hybrid Codebase Search)
```

## Output-token compressor (caveman, default-on, Claude-only)

[caveman](https://github.com/JuliusBrussee/caveman) is a Claude Code skill that
instructs the model to compress its OUTPUT tokens only (prose style), keeping all
technical substance. Loki ACTIVATES it on free-form generation (the main RARV dev
loop) and HARD-SUPPRESSES it on every parsed-output trust-gate subcall (council
votes, the code-review `^VERDICT:`, the adversarial probe, the merge-conflict
resolver, the USAGE.md regen). The suppression is by construction (one shared
helper sets `CAVEMAN_DEFAULT_MODE=off` on every parsed call site), so compression
can NEVER flip a verdict or completion decision.

The compression level is auto-selected per iteration from the run's RARV tier
(no user knob): planning iterations (architecture / design) compress at `lite` to
protect nuance; development / fast / unknown iterations stay at the conservative
`full`. Inference never picks `ultra` (auto ceiling = `full`); an explicit
`LOKI_CAVEMAN_LEVEL` overrides the inference entirely, and the never-raise-a-
user's-lower-global-level guard still applies.

Claude-provider-only: on Codex / Cline / Aider the run is byte-identical to
before. Vendor-less: Loki ships no copy of caveman and bootstraps the pinned
version on demand (idempotent, cached under `.loki/`). Savings are real but
bounded (output tokens only); there is no price API, so Loki discloses the
savings CLASS, never a dollar figure.

```bash
LOKI_CAVEMAN=0                  # opt out (default on). Disables activation; the
                                # parsed-subcall suppression still runs (it is a
                                # harmless no-op when caveman is absent).
LOKI_CAVEMAN_LEVEL=full         # explicit override (default: auto-inferred from
                                # the RARV tier). lite | full | ultra | wenyan |
                                # wenyan-lite|full|ultra. Set it to opt out of
                                # inference and pin one level.
LOKI_CAVEMAN_VERSION=1.9.0      # pinned caveman version (upgrade by bumping)
LOKI_CAVEMAN_AUTO_BOOTSTRAP=0   # disable the on-demand pinned install
```

Note: when `LOKI_LEGACY_COMPLETION_MATCH=true` (the legacy prose-grep completion
path), main-loop activation is automatically disabled so compression cannot
mangle the prose completion-promise. The default completion path (the
`loki_complete_task` MCP tool / completion signal file) is immune to compression
and keeps caveman on.

## Verified-completion evidence gate (v7.19.1, default-on)

The completion council will not accept a "done" claim without evidence. Before
completion is honored (on BOTH the council path AND the default
completion-promise route), `council_evidence_gate` requires:

- a nonzero git diff vs the run-start SHA (something was actually shipped), AND
- green tests (`.loki/quality/test-results.json` shows the runner passed).

The diff is the union of committed, staged, unstaged, and untracked changes
(`--exclude-standard`, so gitignored artifacts do not count), with `.loki/`
runtime state excluded. Inconclusive cases (no git repo, no baseline, no
test-results file, `runner=none`) pass through and never false-block a
legitimate first run.

```bash
LOKI_EVIDENCE_GATE=0       # opt out: completion is honored without the
                           # evidence check (byte-identical to pre-v7.19.1).
                           # Default is on (1).
```

When the gate blocks, it prints the reason and this opt-out to the terminal,
writes `.loki/council/evidence-block.json`, and surfaces in the dashboard
(`/api/council/gate` -> `evidence`; the Quality Gates panel shows a banner). A
persistent block keeps iterating only up to `MAX_ITERATIONS`, then stops
cleanly; it cannot hang. Honest limit: this proves something-changed-and-tests-
pass, not PRD-semantic correctness (the council vote is the semantic check).
The common false-block is a project that was ALREADY red before the run; the
one-step opt-out is the escape hatch.

**Inconclusive-baseline disclosure (v7.28.0):** when the gate cannot establish a
diff baseline (reason `no_git_repo` or `no_run_start_sha`) it still passes
through (it never blocks a non-git project), but completion is no longer
independently verified. Instead of passing silently, the gate writes
`.loki/state/evidence-inconclusive.json` (recording the reason, iteration, and
timestamp) and emits an `evidence_inconclusive` trust event. The run summary in
`.loki/COMPLETION.txt` then carries one honest line:
`Evidence gate: inconclusive (<reason>) - completion not independently
verified`. The record is removed automatically on any later run that resolves a
conclusive baseline. This is a diff-baseline-only disclosure: red tests still
block completion independently, regardless of the inconclusive state.

**Override-judge knobs (v7.5.4+):**

```bash
LOKI_OVERRIDE_JUDGES=claude,codex    # csv of provider names for the
                                     # 3-judge override council. Defaults
                                     # to the available installed providers
                                     # (claude, codex, cline, aider).
LOKI_OVERRIDE_REAL_JUDGE=0           # force the deterministic stub-judge
                                     # path (hermetic CI / cost control).
                                     # Default: 1 = real provider-backed
                                     # judges when their CLIs are present;
                                     # falls back to stub on missing CLI
                                     # or transient provider failure.
```

Implementation: `loki-ts/src/runner/quality_gates.ts:760` (judge dispatch),
`:780` (csv parse), `:987` (real-judge gate).

**Reachability note (v7.5.0/v7.5.1)**: these flags activate inside the
Bun runtime. Today `loki start <prd>` routes through the bash runner via
`bin/loki` shim fall-through, so the flags do not yet trigger on a real
`loki start`. They DO activate in any code path that calls
`loki-ts/src/runner/runQualityGates` directly (e.g. tests, programmatic
integration). End-to-end activation lands when Part A Phase 4 wires the
Bun `start` route. See CHANGELOG v7.5.0 NOT-tested section.

### Counter-evidence file format (`.loki/state/counter-evidence-<iter>.json`)

```json
{
  "iteration": 7,
  "evidence": [
    {
      "findingId": "eng-qa::- [Critical] dead code path bug at sdk/python/...",
      "claim": "this code path is dead duplicate; live code is at sdk/src/gauge/",
      "proofType": "duplicate-code-path",
      "artifacts": ["sdk/python/ is excluded by pyproject.toml"]
    }
  ]
}
```

`findingId` is `canonicalFindingId(finding)` -- `<reviewer>::<first 80 chars
of the finding's raw text>`. `proofType` MUST be one of:
`file-exists`, `test-passes`, `grep-miss`, `reviewer-misread`,
`duplicate-code-path`, `out-of-scope`. Entries with any other proofType
are silently dropped at load time. The override council uses a stub
judge in v7.5.x that approves any of those six trusted proofTypes;
real provider-backed judges land in Phase 2 of Part B.

**Cross-process gate counter (v7.5.5+)**: the per-iteration gate counter
at `.loki/state/gate-counter-<iter>.json` is now incremented under a
cross-process file lock via `withFileLockSync` in
`loki-ts/src/util/atomic.ts`. Concurrent gate runs (parallel worktrees,
overlapping `runQualityGates` invocations) no longer race the
read-modify-write, so override-council quotas and per-finding counters
remain consistent across processes. The lock file lives at
`.loki/state/gate-counter-<iter>.json.lock` and is released even on
crash via the primitive's `finally` cleanup.

---

## Held-out spec evals (v7.28.0, default-on when reserved)

Anti-reward-hacking for the checklist. Before the first verification,
`checklist_select_heldout` (`autonomy/prd-checklist.sh`) deterministically
reserves a slice of checklist items as held-out:
`count = clamp(round(0.25 * N), 1, 5)` for checklists with `N >= 4` items
(smaller checklists reserve nothing). Selection is reproducible, not random:
items are ranked by `sha256(id)` and the first `count` are taken, then written
once to `.loki/checklist/held-out.json` (idempotent: never reselected once
chosen).

Held-out item IDs are EXCLUDED from everything the build loop sees: the checklist
summary, the visible counts, and the per-iteration checklist gate all omit them,
so the build agent cannot tune to those specific acceptance checks. The
completion council evaluates them only at the ship gate via
`council_heldout_gate` (`autonomy/completion-council.sh`): a held-out item whose
status is `failing` (and not waived) blocks completion exactly like any other
critical failure. Each evaluation records a `heldout_eval` trust event with the
verdict and pass/fail counts (no event is emitted when nothing is reserved).

```bash
LOKI_HELDOUT_GATE=0       # opt out: the held-out gate never blocks completion.
                          # Default is on (1), and the gate is inert anyway when
                          # no held-out items were reserved (N < 4).
```

Honest limit: this protects against the PROMPT FEED, not against filesystem
access. The reservation lives on disk at `.loki/checklist/held-out.json`; an
adversarial agent with read access to the working tree can open that file and
learn which items were held out. The guarantee is that held-out items are kept
out of the build loop's own prompt context, not that they are sandboxed.

---

## Uncertainty-gated escalation (v7.19.2, default-on)

When Loki is likely stuck or thrashing, it escalates proactively to the human
via the existing PAUSE + notification + handoff machinery, rather than silently
burning iterations until max-iterations. No new metacognition: the system
reuses three proxy signals that already exist and escalates only when at least
two of the three co-occur for N consecutive rounds.

### Trigger condition

Three proxy signals are evaluated each iteration:

- **Proxy 1 (no-change counter):** `consecutive_no_change` in council state.json
  reaches `LOKI_UNCERTAINTY_NOCHANGE_MIN` (default: `COUNCIL_STAGNATION_LIMIT - 1`,
  i.e. one below the circuit-breaker limit so escalation fires before the
  breaker ends the run).
- **Proxy 2 (diff-hash oscillation):** the current iteration's combined diff
  hash matches a hash seen 2+ rounds back in a bounded ring buffer (A -> B -> A
  pattern). Detects oscillation/revert cycling; does not fire on the trivial
  immediate-repeat case which proxy 1 already covers.
- **Proxy 3 (persistent council split):** the last `LOKI_UNCERTAINTY_SPLIT_ROUNDS`
  consecutive council verdicts are all REJECTED-with-at-least-one-approver
  (split verdict). Stale between council votes; fresh exactly when proxy 1 is
  hot, because proxy 1 hot forces a circuit-breaker vote that refreshes verdicts.

Escalation fires when `hot_count >= 2` (at least two proxies hot simultaneously)
for `LOKI_UNCERTAINTY_ROUNDS` consecutive rounds AND the episode has not already
been escalated (one escalation per stuck-episode, with re-arm when co-occurrence
clears).

### Action

When the trigger condition is met, the run.sh action block:

1. Prints a loud terminal line with the opt-out env var.
2. Calls `write_structured_handoff "uncertainty_escalation"` (saves
   `.loki/memory/handoffs/<ts>.json` and `.md`).
3. Calls `notify_intervention_needed` with a structured reason string.
4. Writes a `.loki/signals/UNCERTAINTY_ESCALATION` marker file.
5. Touches `.loki/PAUSE`.

### Knobs

```bash
LOKI_UNCERTAINTY_ESCALATION=0    # Disable entirely. Byte-identical when off:
                                 # zero reads, zero writes, no state file.
                                 # Default: 1 (enabled). Toggle value is 0/1,
                                 # not false/true.
LOKI_UNCERTAINTY_ROUNDS=2        # Consecutive co-occurrence rounds required.
                                 # Recommended range 2-3. Default: 2.
LOKI_UNCERTAINTY_NOCHANGE_MIN=N  # Proxy 1 threshold. Unset = auto-computed as
                                 # COUNCIL_STAGNATION_LIMIT - 1 (floored at 1).
LOKI_UNCERTAINTY_SPLIT_ROUNDS=2  # Proxy 3 trailing split-round run length.
                                 # Default: 2.
```

Configurable via `config.yaml` under `completion.uncertainty.*` (see
`autonomy/config.example.yaml`).

### Honest limits

- **Perpetual-mode = notify-only by default.** `AUTONOMY_MODE` defaults to
  `perpetual`. In perpetual mode the existing consumer (`check_human_intervention`)
  auto-clears PAUSE and continues. Escalation therefore degrades to a notification
  plus a handoff document; it does NOT halt the run. The terminal prints an explicit
  warning at the escalation site: "Perpetual mode: PAUSE will be auto-cleared; this
  is notify-only and will NOT halt the run."
- **Proxy 2 is count-blind by origin.** It approximates oscillation with
  diff-hash recurrence-at-distance; it cannot distinguish a genuine revert from
  a coincidental identical tree state, and misses oscillation where the hash
  differs every round.
- **Proxy 3 is stale between council votes.** Verdicts are only appended when the
  council actually votes (every `COUNCIL_CHECK_INTERVAL` or circuit-forced). In
  practice p3 is always fresh in the regime that matters (proxy 1 hot forces a
  vote), but it may lag by up to `COUNCIL_CHECK_INTERVAL` iterations otherwise.
- **These are heuristics, not true metacognition.** The system does not know it
  is stuck; it infers stuckness from three correlated symptoms. A legitimately
  hard refactor that produces no net diff for several rounds while the council
  remains split can false-fire. Requiring >=2 co-occurring for N rounds reduces
  but does not eliminate false fires. The cost of a false fire is bounded: one
  notification + one handoff + one PAUSE (auto-cleared in perpetual), opt-out
  at the site.

---

## Guardrails Execution Modes

- **Blocking**: Guardrail completes before agent starts (use for expensive operations)
- **Parallel**: Guardrail runs with agent (use for fast checks, accept token loss risk)

**Research:** Blind review + Devil's Advocate reduces false positives by 30% (CONSENSAGENT, 2025)

---

## Chain-of-Verification (CoVe) Protocol

**Research:** arXiv 2309.11495 - "Chain-of-Verification Reduces Hallucination in Large Language Models"

### Core Insight

Factored, decoupled verification mitigates error propagation. Each verification is computed independently without access to the original response, preventing the model from rationalizing its initial mistakes.

### The 4-Step CoVe Process

```
Step 1: DRAFT          Step 2: PLAN           Step 3: EXECUTE        Step 4: REVISE
+-------------+        +---------------+      +-----------------+    +----------------+
| Generate    |  --->  | Self-generate |  --> | Answer each     | -> | Incorporate    |
| initial     |        | verification  |      | question        |    | corrections    |
| response    |        | questions     |      | INDEPENDENTLY   |    | into final     |
+-------------+        +---------------+      +-----------------+    +----------------+
                       "What claims     |      (factored exec)
                        did I make?     |      No access to
                        What could be   |      original response
                        wrong?"
```

### Step-by-Step Implementation

**Step 1: Draft Initial Response**
```yaml
draft_phase:
  action: "Generate initial code/response"
  model: "sonnet"  # Fast drafting
  output: "baseline_response"
```

**Step 2: Plan Verification Questions**
```yaml
verification_planning:
  prompt: |
    Review the response above. Generate verification questions:
    1. What factual claims did I make?
    2. What assumptions did I rely on?
    3. What could be incorrect or incomplete?
    4. What edge cases did I miss?
  output: "verification_questions[]"
```

**Step 3: Execute Verifications INDEPENDENTLY (Critical)**
```yaml
factored_execution:
  critical: "Each verification runs in isolation"
  rule: "Verifier has NO access to original response"

  # Launch in parallel - each is independent
  verifications:
    - question: "Does the function handle null inputs?"
      context: "Function signature and spec only"  # NOT the implementation
      verifier: "sonnet"
    - question: "Is the SQL query injection-safe?"
      context: "Query requirements only"
      verifier: "sonnet"
    - question: "Does the API match the documented spec?"
      context: "API spec only"
      verifier: "sonnet"
```

**Step 4: Generate Final Verified Response**
```yaml
revision_phase:
  inputs:
    - original_response
    - verification_results[]
  action: "Revise response incorporating all corrections"
  output: "verified_response"
```

### Factor+Revise Variant (Longform Code Generation)

For complex code generation, use the enhanced Factor+Revise pattern. The key difference from basic Factored execution is an **explicit cross-check step** where the model compares original claims against verification results before revision.

```yaml
factor_revise_pattern:
  step_1_draft:
    action: "Generate complete implementation"
    output: "draft_code"

  step_2_factor:
    action: "Decompose into verifiable claims"
    outputs:
      - "Function X handles error case Y"
      - "Loop invariant: Z holds at each iteration"
      - "API call returns type T"
      - "Memory is freed in all paths"

  step_3_independent_verify:
    # CRITICAL: Each runs with ONLY the claim + minimal context
    # No access to full draft code
    parallel_tasks:
      - verify: "Function X handles error case Y"
        context: "Function signature + error spec"
        result: "PASS|FAIL + evidence"
      - verify: "Loop invariant holds"
        context: "Loop structure only"
        result: "PASS|FAIL + evidence"

  step_3b_cross_check:
    # KEY DIFFERENCE: Explicit consistency check before revision
    action: "Compare original claims against verification results"
    prompt: "Identify which facts from the draft are CONSISTENT vs INCONSISTENT with verifications"
    output: "consistency_report"

  step_4_revise:
    inputs: [draft_code, verification_results, consistency_report]
    action: "Discard inconsistent facts, use consistent facts to regenerate"
    output: "verified_code"
```

### Why Factored Execution Matters

The paper tested 4 execution variants:
- **Joint**: Questions and answers in one prompt (worst - repeats hallucinations)
- **2-Step**: Separate prompts for questions vs answers (better)
- **Factored**: Each question answered separately (recommended)
- **Factor+Revise**: Factored + explicit cross-check step (best for longform)

Without factoring (naive verification):
```
Model: "Here's the code"
Model: "Let me check my code... looks correct!"  # Confirmation bias
```

With factored verification:
```
Model: "Here's the code"
Model: "Question: Does function handle nulls?"
[New context, no code visible]
Model: "Given a function that takes X, null handling requires..."  # Independent reasoning
```

**Key principle from the paper:** The verifier cannot see the original response, only the verification question and minimal context. This prevents rationalization of errors and breaks the chain of hallucination propagation.

### CoVe Integration with Blind Review

CoVe operates BEFORE blind review as a self-correction step:

```
Developer Code --> CoVe (self-verification) --> Blind Review (3 parallel)
                          |                            |
                   Catches errors early         Catches remaining
                   via factored checking        issues independently
```

**Combined workflow:**
```yaml
quality_pipeline:
  phase_1_cove:
    # Developer runs CoVe on their own code
    draft: "Initial implementation"
    verify: "Self-generated questions, factored execution"
    revise: "Corrected implementation"

  phase_2_blind_review:
    # 3 independent reviewers (no access to CoVe results)
    reviewers:
      - focus: "correctness"
      - focus: "security"
      - focus: "performance"
    # Reviewers see verified code but don't know what was corrected

  phase_3_aggregate:
    if: "unanimous approval"
    then: "Devil's Advocate review"
```

### Metrics

Track CoVe effectiveness:
```
.loki/metrics/cove/
+-- corrections.json     # Issues caught by CoVe before review
+-- false_positives.json # CoVe flags that were actually correct
+-- review_reduction.json # Reviewer findings before/after CoVe adoption
```

---

## Velocity-Quality Feedback Loop (CRITICAL)

**Research from arXiv 2511.04427v2 - empirical study of 807 repositories.**

### Key Findings

| Metric | Finding | Implication |
|--------|---------|-------------|
| Initial Velocity | +281% lines added | Impressive but TRANSIENT |
| Quality Degradation | +30% static warnings, +41% complexity | PERSISTENT problem |
| Cancellation Point | 3.28x complexity OR 4.94x warnings | Completely negates velocity gains |

### The Trap to Avoid

```
Initial excitement -> Velocity spike -> Quality degradation accumulates
                                               |
                                               v
                               Complexity cancels velocity gains
                                               |
                                               v
                               Frustration -> Abandonment cycle
```

**CRITICAL RULE:** Every velocity gain MUST be accompanied by quality verification.

### Mandatory Quality Checks (Per Task)

```yaml
velocity_quality_balance:
  before_commit:
    - static_analysis: "Run ESLint/Pylint/CodeQL - warnings must not increase"
    - complexity_check: "Cyclomatic complexity must not increase >10%"
    - test_coverage: "Coverage must not decrease"

  thresholds:
    max_new_warnings: 0  # Zero tolerance for new warnings
    max_complexity_increase: 10%  # Per file, per commit
    min_coverage: 80%  # Never drop below

  if_threshold_violated:
    action: "BLOCK commit, fix before proceeding"
    reason: "Velocity gains without quality are net negative"
```

### Metrics to Track

```
.loki/metrics/quality/
+-- warnings.json      # Static analysis warning count over time
+-- complexity.json    # Cyclomatic complexity per file
+-- coverage.json      # Test coverage percentage
+-- velocity.json      # Lines added/commits per hour
+-- ratio.json         # Quality/Velocity ratio (must stay positive)
```

---

## Specialist Review Pool (v5.30.0)

6 named expert reviewers. Select 3 per review based on change type.

**Inspired by:** Compound Engineering Plugin's 14 named review agents -- specialized expertise catches more issues than generic reviewers.

| Specialist | Focus Area | Trigger Keywords |
|-----------|-----------|-----------------|
| **security-sentinel** | OWASP Top 10, injection, auth, secrets, input validation | auth, login, password, token, api, sql, query, cookie, cors, csrf |
| **performance-oracle** | N+1 queries, memory leaks, caching, bundle size, lazy loading | database, query, cache, render, loop, fetch, load, index, join, pool |
| **architecture-strategist** | SOLID, coupling, cohesion, patterns, abstraction, dependency direction | *(always included -- design quality affects everything)* |
| **test-coverage-auditor** | Missing tests, edge cases, error paths, boundary conditions | test, spec, coverage, assert, mock, fixture, expect, describe |
| **dependency-analyst** | Outdated packages, CVEs, bloat, unused deps, license issues | package, import, require, dependency, npm, pip, yarn, lock |
| **legacy-healing-auditor** | Behavioral preservation, friction safety, institutional knowledge | legacy, heal, migrate, cobol, fortran, refactor, modernize, deprecat |

### Selection Rules

1. **architecture-strategist** is ALWAYS one of the 3 slots
2. Score remaining 4 specialists by counting trigger keyword matches in the diff content and changed file names
3. Top 2 scoring specialists fill the remaining slots
4. **Tie-breaker priority:** security-sentinel > test-coverage-auditor > performance-oracle > dependency-analyst
5. **No triggers match at all:** Default to security-sentinel + test-coverage-auditor

### Dispatch Pattern

Launch all 3 in ONE message. Each reviewer sees ONLY the diff -- NOT other reviewers' findings (blind review preserved).

```python
# ALWAYS launch all 3 in ONE message (parallel, blind)
Task(
    model="sonnet",
    description="Review: Architecture Strategist",
    prompt="""You are Architecture Strategist. Your SOLE focus is design quality.

    Review ONLY for: SOLID violations, excessive coupling, wrong patterns,
    missing abstractions, dependency direction issues, god classes/functions.

    Files changed: {files}
    Diff: {diff}

    Output format:
    VERDICT: PASS or FAIL
    FINDINGS:
    - [severity] description (file:line)
    Severity levels: Critical, High, Medium, Low"""
)

Task(
    model="sonnet",
    description="Review: Security Sentinel",
    prompt="""You are Security Sentinel. Your SOLE focus is security vulnerabilities.

    Review ONLY for: injection (SQL, XSS, command, template), auth bypass,
    secrets in code, missing input validation, OWASP Top 10, insecure defaults.

    Files changed: {files}
    Diff: {diff}

    Output format:
    VERDICT: PASS or FAIL
    FINDINGS:
    - [severity] description (file:line)
    Severity levels: Critical, High, Medium, Low"""
)

Task(
    model="sonnet",
    description="Review: {3rd_selected_specialist}",
    prompt="""You are {specialist_name}. Your SOLE focus is {focus_area}.

    Review ONLY for: {specific_checks}

    Files changed: {files}
    Diff: {diff}

    Output format:
    VERDICT: PASS or FAIL
    FINDINGS:
    - [severity] description (file:line)
    Severity levels: Critical, High, Medium, Low"""
)
```

### Rules (unchanged from blind review)

- ALWAYS use sonnet for reviews (balanced quality/cost)
- NEVER aggregate before all 3 complete
- ALWAYS re-run ALL 3 after fixes
- If unanimous PASS -> run Devil's Advocate (anti-sycophancy check)
- Critical/High findings = BLOCK (must fix before merge)
- Medium findings = TODO (track but don't block)
- Low findings = informational only

---

## Two-Stage Review Protocol

**Source:** Superpowers (obra) - 35K+ stars GitHub project

**CRITICAL: Never mix spec compliance and code quality review. They are separate stages.**

### Why Separate Stages Matter

Mixing stages causes these problems:
- **"Technically correct but wrong feature"** - Code is clean, well-tested, maintainable, but doesn't implement what the spec requires
- **Spec drift goes undetected** - Quality reviewers approve beautiful code that solves the wrong problem
- **False confidence** - "3 reviewers approved" means nothing if none checked spec compliance

### Stage 1: Spec Compliance Review

**Question:** "Does this code implement what the spec requires?"

```
Review this implementation against the specification.

Specification:
{paste_spec_or_requirements}

Implementation:
{paste_code_or_diff}

Check ONLY the following:
1. Does the code implement ALL required features from the spec?
2. Does the code implement ONLY what the spec requires (no scope creep)?
3. Are edge cases from the spec handled?
4. Do the tests verify spec requirements?

DO NOT review code quality, style, or maintainability.
Output: PASS/FAIL with specific spec violations listed.
```

**Stage 1 must PASS before proceeding to Stage 2.**

### Stage 2: Code Quality Review

**Question:** "Is this code well-written, maintainable, secure?"

```
Review this code for quality. Spec compliance has already been verified.

Code:
{paste_code_or_diff}

Check the following:
1. Is the code readable and maintainable?
2. Are there security vulnerabilities?
3. Is error handling appropriate?
4. Are there performance concerns?
5. Does it follow project conventions?

DO NOT verify spec compliance (already done).
Output: PASS/FAIL with specific issues listed by severity.
```

### Implementation in Loki Mode

```yaml
two_stage_review:
  stage_1_spec:
    reviewer_count: 1  # Spec compliance is objective
    model: "sonnet"
    must_pass: true
    blocks: "stage_2"

  stage_2_quality:
    reviewer_count: 3  # Quality is subjective, use blind review
    model: "sonnet"
    must_pass: true
    follows: "stage_1"
    anti_sycophancy: true  # Devil's advocate on unanimous

  on_stage_1_fail:
    action: "Return to implementation, DO NOT proceed to Stage 2"
    reason: "Quality review of wrong feature wastes resources"

  on_stage_2_fail:
    action: "Fix quality issues, re-run Stage 2 only"
    reason: "Spec compliance already verified"
```

### Common Anti-Pattern

```
# WRONG - Mixed review
Task(prompt="Review for correctness, security, performance, and spec compliance...")

# RIGHT - Separate stages
Task(prompt="Stage 1: Check spec compliance ONLY...")
# Wait for pass
Task(prompt="Stage 2: Check code quality ONLY...")
```

---

## Severity-Based Blocking

| Severity | Action |
|----------|--------|
| Critical | BLOCK - fix immediately |
| High | BLOCK - fix before commit |
| Medium | BLOCK - fix before merge |
| Low | TODO comment, fix later |
| Cosmetic | Note, optional fix |

See `references/quality-control.md` for complete details.

---

## Scale Considerations

> **Source:** [Cursor Scaling Learnings](../references/cursor-learnings.md) - integrators became bottlenecks at high agent counts

### Review Intensity Scaling

At high agent counts, full 3-reviewer blind review for every change creates bottlenecks.

```yaml
review_scaling:
  low_scale:  # <10 agents
    all_changes: "Full 3-reviewer blind review"
    rationale: "Quality critical, throughput acceptable"

  medium_scale:  # 10-50 agents
    high_risk: "Full 3-reviewer blind review"
    medium_risk: "2-reviewer review"
    low_risk: "1 reviewer + automated checks"
    rationale: "Balance quality and throughput"

  high_scale:  # 50+ agents
    critical_changes: "Full 3-reviewer blind review"
    standard_changes: "Automated checks + spot review"
    trivial_changes: "Automated checks only"
    rationale: "Trust workers, avoid bottlenecks"

risk_classification:
  high_risk:
    - Security-related changes
    - Authentication/authorization
    - Payment processing
    - Data migrations
    - API breaking changes
  medium_risk:
    - New features
    - Business logic changes
    - Database schema changes
  low_risk:
    - Bug fixes with tests
    - Refactoring with no behavior change
    - Documentation
    - Dependency updates (minor)
```

### Judge Agent Integration

Use judge agents to determine when full review is needed:

```yaml
judge_review_decision:
  inputs:
    - change_type: "feature|bugfix|refactor|docs"
    - files_changed: 5
    - lines_changed: 120
    - test_coverage: 85%
    - static_analysis: "0 new warnings"
  output:
    review_level: "full|partial|automated"
    rationale: "Medium-risk feature with good coverage"
```

### Cursor's Key Learning

> "Dedicated integrator/reviewer roles created more bottlenecks than they solved. Workers were already capable of handling conflicts themselves."

**Implication:** At scale, trust automated checks and worker judgment. Reserve full review for high-risk changes only.
