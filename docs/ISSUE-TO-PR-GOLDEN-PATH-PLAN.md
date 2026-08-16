# Issue-to-PR Golden Path -- Architecture and Acceptance Plan

Lane: LOKI-GOLDEN-PATH-68. Status: plan for the first user-visible slice.

## 0. Two scope facts stated up front

**Which file was read as AGENTS.md.** There is no `AGENTS.md` at the repo root.
The two candidates are `skills/agents.md` (263 lines) and `references/agents.md`
(1043 lines). `skills/agents.md` was read in full; it is the agent-dispatch and
structured-prompting module, and its "Project AGENTS.md" section (L184-192)
defines the AAIF priority order this repo follows. It contains no numbered
feature list.

**Where the feature numbering comes from.** The directive names features
1, 2, 3, 4, 9, 10. No document in this repo contains a numbered list of >=10
items describing the issue-to-PR journey. `docs/CAPABILITY-BACKLOG.md` has a
numbered priority table but it stops at 6 and is about verification-tax
measurement, not this journey. This was verified exhaustively, not
assumed: searches over the semantics (`review-ready`, `time to first`,
`issue to PR`, `golden path`) across every file type, every local and remote
ref, and deleted files in git history found no such list. The phrase "golden
path" appears nowhere in the repo, and the closest founder mandates
(`docs/COCKPIT-UX-MANDATE.md`, the deleted `docs/KILLER-FEATURE-MANDATE.md`)
carry 6 and 7 items respectively on unrelated subjects.

Therefore this plan maps the six labels onto the six required-outcome clauses in
the directive itself, in the order the directive states them. This is an
assumption, and it is recorded here so it can be corrected cheaply:

| # | Feature | Directive clause |
|---|---------|------------------|
| 1 | Single entrypoint | one `loki start <issue>` path |
| 2 | Exact acceptance context import | imports exact issue acceptance context |
| 3 | Early machine-readable status/plan | useful machine-readable early result inside 60s |
| 4 | One unified review-ready result | completes with one unified review-ready result |
| 9 | Consent-gated PR | PR created/prepared only after existing consent rules |
| 10 | Truthful evidence receipt | attaches a truthful evidence/outcome receipt |

Features 5-8 are unallocated under this reading. Nothing in this slice claims
to implement them.

## 1. What already exists (verified by reading, not assumed)

This journey is mostly assembled, not missing. The slice is integration.

| Seam | Location | State |
|---|---|---|
| Issue ref parsing | `autonomy/issue-parser.sh:89` `parse_issue_ref` | Handles URL, `owner/repo#N`, bare `N` |
| Acceptance extraction | `autonomy/issue-parser.sh:154` `extract_acceptance_criteria` | Extracts checkboxes + Acceptance Criteria / Requirements sections |
| Structured issue output | `autonomy/issue-parser.sh:423` `output_json` | Emits `acceptance_criteria` as a JSON field |
| Single entrypoint | `autonomy/loki:2779` | `loki start` already detects issue refs and re-dispatches to `cmd_run` |
| PR creation (attached) | `autonomy/loki:10237` | `gh pr create` in the `cmd_run` github branch |
| PR creation (detached) | `autonomy/loki:10088` | second `gh pr create` inside the detached inner script |
| Evidence receipt render | `autonomy/lib/proof-pr.sh:49` `render_evidence_receipt_md` | Print-only, honesty-gated, never blocks PR creation |
| Proof assembly | `autonomy/lib/proof-generator.py:1097` `_build_proof` | Emits facts/assessments/honesty blocks |
| Time to first artifact | `.loki/state/first-artifact.json` (writer `run.sh:23292`, reader `run.sh:4271`) | `seconds_to_first_artifact`, write-once |
| Intervention socket | `autonomy/lib/trust_trajectory.py:145` `_interventions_value` | Reads `proof.interventions`; documents that no writer exists yet |
| Zero-spend preview pattern | `autonomy/quickstart.sh:475` + `_qs_load_preview:510` | `--dry-run --json`, schema-v1, bounded + validated |
| Test harness pattern | `tests/cli/test-quickstart.sh` | Source-level stubs, zero spend, zero network |

### Required product facts: already present vs missing

Present in `proof.json` today: elapsed time (`wall_clock_sec`), iterations
(`_collect_iterations`, with progress/rework attribution), exact changed files
(`_git_diffstat`), test outcomes (`_collect_tests`), spec (`_collect_spec`).

Missing and in scope for this slice: time to first useful result,
human-intervention count, acceptance-criteria coverage, PR state/URL,
uncertainty, rollback, and lint/typecheck/build commands recorded alongside
their outcomes.

## 2. Architecture of the slice

Four small additions on existing seams. No new subsystem, no new gate, no new
artifact format (`docs/CAPABILITY-BACKLOG.md:45-50` explicitly forbids the
last two).

**A. Carry acceptance criteria forward (feature 2).**
`extract_acceptance_criteria` already produces the exact criteria; they are
rendered into a generated PRD and then lost. Persist the parsed criteria to
`.loki/state/issue-context.json` at import time so later stages can key on the
exact text rather than re-deriving it from prose.

**B. Early machine-readable plan (feature 3).**
Write `.loki/state/journey-plan.json` from the issue-parse output *before the
first provider call*. Because it is derived from `gh` output and not from model
output, it does not depend on provider latency at all -- the 60s budget becomes
deterministic rather than conditional. Shape and validation discipline mirror
the quickstart schema-v1 preview.

**C. Receipt facts (features 4 and 10).**
Extend `_build_proof` with the missing facts, and extend
`render_evidence_receipt_md` to print them. Both follow the honesty rule already
enforced throughout this codebase: absent measurement renders nothing, never a
fabricated zero (`run.sh:4258`, `proof-generator.py` `_compute_degraded`).
Acceptance coverage is reported as *stated vs addressed*, never as a pass/fail
verdict, because no deterministic checker exists for free-text criteria; claiming
one would be the exact "fake green" this repo's trust core forbids.
Interventions fill the socket `trust_trajectory.py:145` already reads.

**D. Consent-gated PR (feature 9).**
The consent rules already exist; the gap is that there are **two**
`gh pr create` call sites and a guard on one leaves the other unguarded. This
slice covers the attached path at `autonomy/loki:10237` and adds a
prepare-only mode that writes the PR title/body to disk without mutating
GitHub. The detached path at `:10088` is explicitly **not** covered by this
slice and is named in section 5 as remaining work.

## 3. Files to change

| File | Change |
|---|---|
| `autonomy/issue-parser.sh` | Persist parsed issue context (incl. exact acceptance criteria) to `.loki/state/issue-context.json` |
| `autonomy/loki` | Write `journey-plan.json` before the provider call; add prepare-only PR mode at the `:10237` seam |
| `autonomy/lib/proof-generator.py` | Collect the 7 missing facts into the existing `facts` block |
| `autonomy/lib/proof-pr.sh` | Render the new facts in the receipt, honesty-gated |
| `tests/cli/test-issue-to-pr.sh` | New: end-to-end journey test with mocked `gh` + provider |

Deliberately unchanged: `autonomy/run.sh` prompt construction. CLAUDE.md records
that goal scoring is byte-mirrored between `run.sh` and
`loki-ts/src/runner/goal_score.ts` and that parity fixtures diverge if one side
is edited. Staying out of `build_prompt` also avoids the prompt-cache prefix
rule and the `loki-ts` dist-rebuild requirement entirely.

## 4. Acceptance tests

All zero-spend, zero-network, no external GitHub mutation. `gh` and the provider
are PATH-shimmed exactly as `tests/cli/test-quickstart.sh` shims its boundaries.

1. **Issue ref forms** -- URL, `owner/repo#N`, and bare `N` all resolve to the
   same parsed context.
2. **Exact acceptance import** -- criteria in `issue-context.json` match the
   fixture issue body verbatim, including checkbox items.
3. **Early plan exists and validates** -- `journey-plan.json` is written before
   any provider invocation, and parses against the expected schema.
4. **Provider-free dry-run** -- the full journey runs to a printed contract with
   the provider shim asserting it was never called.
5. **No PR without consent** -- default path performs no `gh pr create`; the
   `gh` shim records every invocation and the test asserts the mutation set is
   empty.
6. **Prepare-only writes locally** -- prepare mode produces a PR body on disk
   and still performs no GitHub mutation.
7. **Receipt truthfulness** -- with facts absent, the receipt omits them rather
   than printing zeros; with facts present, it prints the measured values.
8. **Acceptance coverage is not a verdict** -- coverage renders as stated vs
   addressed and never emits a pass/fail claim.

## 4a. What shipped (post-implementation)

Implemented as planned, with one deviation recorded honestly:

- `autonomy/issue-parser.sh` -- `_gp_criteria_lines` + `write_journey_context`,
  called from the `parse_github_issue` chokepoint so every caller is covered.
- `autonomy/loki` -- `--prepare-pr` at BOTH `loki start` and `cmd_run`; a
  prepare-only block that writes `pr-title.txt` / `pr-body.md` / `pr.json` and
  never invokes `gh`; PR state recorded on the published path only on ACTUAL
  success, so a failed create cannot leave a "created" claim behind.
- `autonomy/lib/proof-generator.py` -- `_collect_journey` + the top-level
  `interventions` mirror.
- `autonomy/lib/proof-pr.sh` -- journey rows, each conditional on measurement.
- `tests/cli/test-issue-to-pr.sh` -- 13 assertions, all passing.

**Two dead-code defects found and fixed during verification.** Both were caught
only by driving the real CLI; every unit test stayed green through both.

1. **Wrong chokepoint.** The first implementation hooked
   `issue-parser.sh::parse_github_issue`, which serves ONLY the deprecated
   `loki issue parse|view`. `loki start` / `loki run` route through
   `fetch_issue` (`autonomy/issue-providers.sh:333`), so features 2 and 3 were
   dead on the required path. Re-hooked at the `fetch_issue` call site in
   `cmd_run`, which is also provider-agnostic (github/gitlab/jira/azure). A
   follow-on bug surfaced there too: `ISSUE_OWNER`/`ISSUE_REPO` are re-cleared
   by later `parse_issue_reference` calls, producing a `"/#42"` ref; the ref now
   comes from the normalized JSON's `repo` field.

2. **Unreachable after exec.** `cmd_start` exec-replaces the process
   (`autonomy/loki:3490`), so everything after a bare call in `cmd_run` is
   unreachable -- including the PRE-EXISTING `if $create_pr` block, which
   explains why the detached route reimplements PR creation instead of sharing
   it. Verified empirically with a minimal repro, not inferred. `--prepare-pr`
   now subshells the runner so control returns; the default path keeps the bare
   call, because subshelling everything would change signal and Ctrl+C
   semantics for existing users.

A third defect was found in the test harness itself: the issue fixture was
built with `python3 -c '...' FIXTURE_BODY="$body"`, which passes a positional
argument rather than an environment variable, so `os.environ` raised and
`2>/dev/null` hid it. The empty fixture made the CLI fail to fetch while
assertions passed for the wrong reason. Fixed, and an explicit non-empty guard
now fails loudly rather than vacuously.

**Deviation.** The first draft of `_gp_criteria_lines` carried a `grep -vE '^#'`
guard against a section heading leaking in as a criterion. Mutation testing
showed the guard was never reached: `extract_acceptance_criteria`'s `sed` range
already terminates at the next `^#`, and four separate constructions failed to
produce a heading that reached the filter. It was removed rather than kept as
decorative defense. The horizontal-rule guard beside it was tested the same way,
found genuinely load-bearing (a bare `---` survives the bullet-strip as a lone
`-` and would become a phantom criterion), and kept with a dedicated test.

## 4b. Required product facts: delivered vs not

| Fact | Status |
|---|---|
| Elapsed time | delivered (pre-existing `wall_clock_sec`) |
| Time to first useful result | delivered (reads the existing `first-artifact.json`) |
| Iterations | delivered (pre-existing, incl. progress/rework split) |
| Human interventions | delivered; writer added at `run.sh::handle_pause` |
| Exact changed files | delivered (pre-existing `_git_diffstat`) |
| Test command + outcome | delivered (pre-existing) |
| Build command + outcome | delivered (pre-existing) |
| **Lint command + outcome** | **NOT delivered** |
| **Typecheck command + outcome** | **NOT delivered** |
| Acceptance-criteria coverage | delivered as *stated*, never as *met* (see below) |
| PR state / URL | delivered (`prepared` and `created`) |
| Uncertainty | delivered (counts `honesty.degraded[]`) |
| Rollback | delivered (`git reset --hard <base_sha>`) |

**Lint and typecheck are not delivered, and nothing in the receipt pretends they
are.** There is no lint or typecheck record anywhere in the proof chain today
(`grep -rn "lint\|typecheck" autonomy/lib/proof-generator.py
autonomy/lib/proof-pr.sh` returns nothing). Emitting them would require
instrumenting the gate-execution path in `run.sh` to record each command and
exit code -- real scope, and beyond a first coherent slice. Because every row in
this receipt is conditional on measurement, their absence renders no row rather
than a false green.

**Acceptance coverage is a correspondence, not a verdict.** `addressed_count` is
deliberately `null`, not `0`: there is no deterministic checker for free-text
criteria, and `0` would read as "none met", which is not known. The row states
how many criteria the issue asked for and says plainly that they are not
machine-verified.

## 5. Explicitly not done in this slice

- Lint and typecheck command/outcome capture (see section 4b).
- The detached `gh pr create` (the inner detached script) is unguarded by this
  slice's prepare-only mode, and the pre-existing attached `--pr` block remains
  dead code after the `cmd_start` exec. This slice does NOT revive it: making
  `--pr` publish from the attached path would turn a currently-inert flag into
  one that mutates GitHub, which is a behavior change requiring its own consent
  review rather than a side effect of this work.
- GitLab (`glab`) parity for prepare-only mode.
- Acceptance-criteria coverage is a reported correspondence, not a verified one.
  There is no deterministic checker for free-text criteria and this slice does
  not pretend to add one.
- Features 5-8 under the numbering assumption in section 0.
- No version bump, no release, no commit, no push.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Numbering assumption in section 0 is wrong | Recorded explicitly; the six implemented clauses come verbatim from the directive, so the work stands even if labels are renumbered |
| Two PR call sites, one guarded | Named as remaining work rather than silently half-fixed |
| Receipt could overstate | Every new fact follows the existing absent-renders-nothing rule; coverage is never a verdict |
| Dirty worktree | All new writes go to `.loki/state/`, which is run state, not tracked source |
