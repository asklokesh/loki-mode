# Quality Gates

Loki Mode never calls work done until it is verified. Before any change is
accepted, it passes a stack of quality gates: deterministic checks plus a
multi-agent review. This page describes the gate stack, the completion-time
evidence and held-out checks, and the environment variables that control them.

For the completion vote itself (the 3-member voting council, convergence
detection, and circuit breaker) see [[Completion Council]]. The gates on this
page run alongside and feed into that decision.

---

## The 11 Quality Gates

| # | Gate | What it checks |
|---|------|----------------|
| 1 | Input Guardrails | Validate scope, detect prompt injection, check constraints |
| 2 | Static Analysis | CodeQL, ESLint/Pylint, type checking |
| 3 | Blind Review System | 3 reviewers in parallel, no visibility of each other's findings |
| 4 | Anti-Sycophancy Check | On unanimous approval, run a Devil's Advocate reviewer |
| 5 | Output Guardrails | Validate code quality, spec compliance, no secrets |
| 6 | Severity-Based Blocking | Critical/High/Medium = BLOCK; Low/Cosmetic = TODO comment |
| 7 | Test Coverage Gates | Unit: 100% pass, over 80% coverage; Integration: 100% pass |
| 8 | Mock Detector | Flags tests that never import source, tautological assertions, high internal-mock ratios |
| 9 | Test Mutation Detector | Detects assertion changes alongside implementation changes (test fitting), low assertion density |
| 10 | Backward Compatibility | Behavioral preservation, friction safety, institutional-knowledge retention (healing mode) |
| 11 | Documentation Coverage | README exists, docs freshness within 10 commits, API docs for packages |

Severity-based blocking is the rule that ties them together: any Critical, High,
or Medium finding blocks completion. Low and cosmetic findings become TODO
comments rather than blockers.

### Gate 10: Backward Compatibility (healing mode)

Gate 10 fires only when `LOKI_HEAL_MODE=true`, when `loki heal` is active, or
when the diff touches files listed in `.loki/healing/friction-map.json`.
Greenfield projects skip it entirely. It prevents accidental removal of
institutional logic or behavioral changes to legacy code without explicit
documentation, checking friction safety, characterization-test coverage,
business-rule comment preservation, adapter verification, and behavioral
baselines.

### Gate 11: Documentation Coverage

Gate 11 fires when a diff touches public APIs, adds new files, or releases a
library/package. It checks that exported symbols are documented, that a non-empty
README exists, that documentation is within 10 commits of HEAD, and that any
`CLAUDE.md` references current key files. Missing API docs block for npm/pip
packages. Disable (not recommended for packages) with
`LOKI_GATE_DOC_COVERAGE=false`.

### Gates 8 and 9: Test integrity

The Mock Detector and Test Mutation Detector run during the VERIFY phase and are
enabled by default. They run `tests/detect-mock-problems.sh` and
`tests/detect-test-mutations.sh`; HIGH findings fail the gate like any other
blocking gate. They have no env-var toggle; skip them by not running the scripts
in your CI.

---

## Verified-completion evidence gate (v7.19.1, default-on)

The completion council will not accept a "done" claim without evidence. Before
completion is honored, the evidence gate requires:

- a nonzero git diff versus the run-start SHA (something was actually shipped), and
- green tests (the test runner passed).

The diff is the union of committed, staged, unstaged, and untracked changes
(gitignored artifacts and `.loki/` runtime state do not count). When the gate
blocks, it prints the reason and the one-step opt-out, writes
`.loki/council/evidence-block.json`, and surfaces in the dashboard Quality Gates
panel. A persistent block keeps iterating up to `LOKI_MAX_ITERATIONS` and then
stops cleanly; it cannot hang.

Honest limit: this proves something-changed-and-tests-pass, not PRD-semantic
correctness (the council vote is the semantic check). The common false-block is a
project that was already red before the run; the opt-out is the escape hatch.

```bash
LOKI_EVIDENCE_GATE=0   # opt out: completion is honored without the evidence
                       # check. Default is on (1).
```

### Inconclusive-baseline disclosure (v7.28.0)

When the evidence gate cannot establish a diff baseline (reason `no_git_repo` or
`no_run_start_sha`) it still passes through. It never blocks a non-git project,
but completion in that case is no longer independently verified. Instead of
passing silently, the gate writes `.loki/state/evidence-inconclusive.json`
(recording the reason, iteration, and timestamp), emits an `evidence_inconclusive`
trust event, and the run summary in `.loki/COMPLETION.txt` carries one honest
line:

```
Evidence gate: inconclusive (<reason>) - completion not independently verified
```

The record is removed automatically on a later run that resolves a conclusive
baseline. This is a diff-baseline-only disclosure: red tests still block
completion independently, regardless of the inconclusive state.

---

## Held-out spec evals (v7.28.0, default-on when reserved)

Anti-reward-hacking for the checklist. Before the first verification, Loki
deterministically reserves a slice of the checklist items as held-out:
`count = clamp(round(0.25 * N), 1, 5)` for checklists with `N` of 4 or more items
(smaller checklists reserve nothing). Selection is reproducible, not random:
items are ranked by `sha256(id)` and the first `count` are taken, then written
once to `.loki/checklist/held-out.json` (idempotent).

Held-out item IDs are excluded from everything the build loop sees: the checklist
summary, the visible counts, and the per-iteration checklist gate all omit them,
so the build agent cannot tune to those specific acceptance checks. The
completion council evaluates them only at the ship gate. A held-out item whose
status is failing (and not waived) blocks completion exactly like any other
critical failure.

```bash
LOKI_HELDOUT_GATE=0   # opt out: the held-out gate never blocks completion.
                      # Default is on (1), and the gate is inert anyway when
                      # no held-out items were reserved (N < 4).
```

Honest limit: this protects the prompt feed, not against filesystem
access. The reservation lives on disk at `.loki/checklist/held-out.json`; an
agent with read access to the working tree can open that file and learn which
items were held out. The guarantee is that held-out items are kept out of the
build loop's own prompt context, not that they are sandboxed.

---

## Standalone verification: `loki verify`

`loki verify [base-ref]` runs the deterministic side of the gate stack against
any branch or PR diff outside the autonomous loop: build, tests, and static
analysis scoped to the changed files, a diff-scoped secret scan, and a dependency
audit. Exit codes are CI-gate usable: 0 VERIFIED, 1 CONCERNS, 2 BLOCKED.
Inconclusive evidence is never reported VERIFIED. When a spec lock exists
(`loki spec`), a drifted spec folds in a single Medium `SPEC_DRIFT` finding
(CONCERNS). See [[CLI Reference]] for full options.

---

## Optional cloud review: `loki review --ultra` (issue #168)

`loki review --ultra` adds an OPTIONAL cloud multi-agent review on top of Loki's
own local council, by wrapping the upstream `claude ultrareview` subcommand
(Claude Code 2.1.x). It is a deliberate, on-demand command, NOT an automatic
completion-council voice: the council runs many times per build, so auto-firing
a paid cloud call there would be a silent-billing footgun. Findings are advisory
only; they never block the completion gate.

It is PAID and opt-in (default OFF, zero behavior change when unused). Because
there is no price API, the disclosure states the cost-CLASS, never a dollar
figure:

> ultrareview is a PAID cloud operation billed by Anthropic, separate from local
> model spend. It may take up to 30 minutes.

Consent model:

- Interactive TTY without `--yes`: prompts "Run cloud ultrareview now? [y/N]"
  (default NO).
- Non-TTY / CI without confirmation: refuses with exit code 2 and makes zero
  cloud calls (the no-silent-bill guard; never hangs in CI).
- `--yes` / `-y`, or `LOKI_ULTRAREVIEW=1`, proceeds non-interactively (this
  command only; never a council auto-trigger).

If the installed `claude` does not support `ultrareview`, the command prints an
honest "please upgrade to 2.1.x" message and exits without a half-feature.

```bash
loki review --ultra                # confirm, then cloud-review the current branch
loki review --ultra 42             # cloud-review GitHub PR #42
loki review --ultra --yes          # skip the prompt (scripts)
loki review --ultra --format json  # raw bugs.json (emits 'claude ultrareview --json')
LOKI_ULTRAREVIEW=1 loki review --ultra   # non-interactive opt-in
```

---

## Override council on BLOCK (v7.5.0)

When a gate blocks but the agent has structured counter-evidence, an optional
3-judge override council can review the block rather than looping blindly. These
flags default off and are byte-identical to prior behavior when unset:

```bash
LOKI_INJECT_FINDINGS=1    # inject structured per-finding records into the next
                          # iteration's prompt
LOKI_OVERRIDE_COUNCIL=1   # enable the 3-judge override council on BLOCK
                          # (requires LOKI_INJECT_FINDINGS=1)
LOKI_AUTO_LEARNINGS=1     # auto-write structured learnings on code_review failure
LOKI_HANDOFF_MD=1         # write a structured handoff doc before PAUSE
```

---

## See Also

- [[Completion Council]] - the multi-agent voting system that gates completion
- [[CLI Reference]] - `loki verify`, `loki spec`, `loki grill`
- [[Environment Variables]] - all gate-related env vars in one place
- [[Configuration]] - council and gate configuration options
- [[Architecture]] - where the gates sit in the RARV-C closure loop
