# Outcome Frontier: held-out tasks with deterministic oracles

> ## NOTHING HERE HAS BEEN RUN
>
> No task in this document has been executed. No tool has been scored. No cost
> has been spent producing it. Every number below is either a pre-registered
> threshold or an estimate labelled as one. There are no results in this file,
> and any cell that looks like a result is a worked example of the FORMAT, not
> an observation. If you are looking for evidence, this document contains none
> by design - it is the thing you run to GET evidence.

## What this is, and what governs it

This is the operational layer under section 2b of
[`docs/COMPETITIVE-SCORECARD.md`](./COMPETITIVE-SCORECARD.md). That section
defines the tier ladder T0-T5 and the nine scored dimensions. This document does
not restate either; read 2b first.

One correction to the brief that commissioned this file, because a document
about honest measurement cannot open with an unverified citation. There is no
heading named `2b-FROZEN` anywhere in this repository (verified:
`grep -rn "2b-FROZEN" . --include='*.md'` returns nothing at the current
worktree commit). The frozen status block is the **"Status separation"** table
at the end of section 2b, which sorts every claim into Measured capability /
Planned experiments / Aspirational. That table governs this document, and this
document lands entirely in its **Planned experiments** row.

What 2b leaves open is the thing that decides whether the exercise is worth
running at all: *who decides whether a task succeeded.* 2b names dimensions. It
does not name oracles. This file supplies oracles for three of the six tiers and
is honest about which dimensions have no oracle and never will.

**Mapping to 2b tiers.** Three tasks, one per required shape:

| This doc | 2b tier | Shape |
|---|---|---|
| TASK-B | T1 | Brownfield change in an unfamiliar repo |
| TASK-M | T2 | Multi-file migration with real coupling |
| TASK-S | T5 | Scientific / research task - **PLAN ONLY** |

## The property that decides whether any of this is worth running

An agent benchmark is worthless when the thing being measured also decides
whether it passed. This has three failure modes and all three are common:

1. **Self-grading.** The agent reports its own success. The report is an output
   of the system under test, so it measures the reporter, not the work.
2. **LLM-judge-as-oracle.** A model scores free text against a rubric. This is
   not deterministic, is not reproducible across model versions, and correlates
   with verbosity and formatting. Dressing it as an oracle is the single most
   common way a benchmark becomes a story.
3. **In-context oracle.** The test the agent is scored against was visible in
   the repo it was working in. The agent can pass by reading the answer, and the
   benchmark cannot tell that apart from solving the problem.

Every oracle below is decidable by a process that is not the agent, not a
language model, and not visible to the agent during the run. Where a dimension
genuinely requires human judgement, it is listed in
[NOT DETERMINISTIC](#dimensions-that-are-not-deterministic-and-are-not-scored)
and is **not scored**. It is not converted into an LLM judge.

---

## TASK-B (T1): brownfield change in an unfamiliar repo

**Shape.** A bug fix or small feature inside a real, mature open-source
repository that the agent has never been given context for. Not a greenfield
build. The value being measured is comprehension of code someone else wrote.

**Instance selection (mechanical, not curated).** From a public repo pinned at a
specific commit SHA, select closed issues that (a) have a linked merge commit,
(b) whose merge commit modifies at least one non-test source file AND at least
one test file, (c) were closed AFTER the knowledge cutoff of every model under
test. Sort candidates by issue number and take the first N that satisfy the
filter. The person tuning the harness does not choose which issues are in the
set - the filter and the sort order do. See
[Held-out discipline](#held-out-discipline-mandatory).

**What the agent gets.** The repo checked out at the PARENT of the fix commit,
plus the issue title and body as written by the original reporter. Nothing else.
The issue text is not rewritten, hinted, or clarified - a rewritten issue is a
hint, and the whole point of brownfield is that real requests are underspecified.

**What is withheld.** The test files added or modified by the fix commit are
removed from the working tree the agent receives. This is load-bearing and must
be verified per instance before the run: if the oracle test is present in the
tree, the agent can read the expected behaviour directly and the oracle measures
nothing. An instance where the test cannot be cleanly withheld (for example, the
fix modifies an existing test the agent needs for unrelated context) is
**dropped from the set and the drop is reported**, not silently patched around.

### Oracle

Post-hoc, the withheld test files are restored from the fix commit and the
repo's own test runner is executed against the agent's tree.

- **PASS**: every restored test passes AND the repo's pre-existing suite still
  passes at its pinned baseline (no regressions).
- **PARTIAL**: restored tests pass but the pre-existing suite regresses, or a
  strict subset of restored tests passes.
- **FAIL**: anything else, including a tree that does not build.

This is deterministic, runs offline, costs nothing beyond CPU, and is decided by
the upstream project's own test code written by the upstream maintainers before
this benchmark existed.

### What this oracle CANNOT catch

- **A correct fix that the upstream test does not cover.** Upstream tests encode
  the fix the maintainer actually wrote. A different, equally valid fix can fail
  them. This biases toward the upstream solution and against novel ones.
- **A fix that passes by coincidence.** Tests can pass on a change that is right
  for the wrong reason and will break on the next input.
- **Code quality of the diff.** A 400-line change and a 3-line change that both
  pass score identically. Maintainability is not measured here (see NOT
  DETERMINISTIC).
- **Overfitting to the test's literal assertions** if any part of the test
  leaked into context through a stack trace, CI config, or changelog.
- **Whether the agent understood the issue** versus pattern-matched a similar
  fix elsewhere in the repo.

---

## TASK-M (T2): multi-file migration with real coupling

**Shape.** Migrate every call site of an internal API to a replacement API
across a codebase where the call sites differ structurally - some in loops, some
behind conditionals, some with the old signature's argument order, some already
partly migrated. Coupling is the point: a task whose files are independent is N
single-file tasks wearing a trenchcoat.

**Instance selection.** Derived from a real migration commit in a pinned public
repo (same cutoff filter as TASK-B), or from a synthetic-but-fixed corpus
generated once, frozen, and stored outside this repo. If synthetic, the
generator's seed is recorded and the corpus is never regenerated between tools -
a regenerated corpus is a different experiment.

**What the agent gets.** The repo at the pre-migration commit, plus the
migration instruction as a specification of the NEW API's contract (signature,
semantics, deprecation reason). Not a list of the files to change - finding them
is the task.

### Oracle

Three independent deterministic checks, all run post-hoc by the harness. All
three must hold for PASS.

1. **Type checker / compiler.** The project's own `tsc --noEmit`, `mypy`, or
   equivalent at its pinned config. Exit code only. Catches signature
   mismatches and broken call sites.
2. **Held-out integration tests.** Tests exercising the migrated behaviour
   end-to-end, withheld from the agent's tree exactly as in TASK-B, restored and
   run afterward. These assert BEHAVIOUR is preserved across the migration, not
   just that it compiles.
3. **Zero-residual-call-site invariant.** An AST query (not a grep - a grep
   matches strings in comments and strings) asserting that zero call sites of
   the old API remain reachable in source.

**The invariant must not be satisfiable by deletion.** Check 3 alone is trivially
passed by deleting every call site. It is only meaningful in conjunction with
check 2, which fails if the behaviour those call sites provided has disappeared.
Additionally the harness asserts a **call-site count floor**: the number of NEW
API call sites must be at least the number of OLD API call sites that existed
pre-migration. **The consolidation allowance is 0.** An agent may still
legitimately merge two call sites into one, but each such consolidation is
reported individually and justified against the behaviour check; a justified
consolidation does not count against the floor, and an unreported one fails it.
The allowance is fixed at 0 here rather than left as a threshold to be set
later, because an unspecified threshold in a pre-registration document is the
exact defect the frozen-rubric rule below names: a parameter set after seeing
results is a parameter chosen because of them. Stating this relationship is the
entire reason check 3 is not reported on its own.

- **PASS**: all three checks hold.
- **PARTIAL**: type check and invariant hold, integration tests partly fail.
- **FAIL**: type check fails, or call sites remain, or the count floor is
  breached.

### What this oracle CANNOT catch

- **Semantically wrong migrations that are behaviourally equivalent on the
  tested paths.** Untested paths are unmeasured.
- **Consolidation that is technically legal but wrong** - the count floor's
  allowance is a judgement call frozen in advance, and a clever wrong answer can
  sit inside it.
- **Dynamic call sites.** Reflection, string-keyed dispatch, and
  `getattr`-style access are invisible to an AST query. Instances that use them
  should be excluded at selection time, and the exclusion reported.
- **Migration quality**: whether the resulting code is idiomatic, whether the
  diff is reviewable, whether a human would merge it.
- **Partial credit for a correct-but-incomplete migration** that stopped at a
  hard file. The oracle is binary per check; PARTIAL is coarse.

---

## TASK-S (T5): scientific / research task

> **THIS ONE IS A PLAN, NOT AN OPERATIONALIZED TASK.**
>
> Stated plainly and without hedging: TASK-B and TASK-M can be executed as
> written by someone who has not read anything else. TASK-S cannot. It requires
> a specific paper to be chosen, its artifact availability confirmed, and its
> headline number and tolerance transcribed before it is runnable. What follows
> is the design and the selection rule, not a runnable instance. Do not report
> TASK-S results alongside the other two as if they were equally rigorous.

**Shape.** Reproduce a published quantitative result. The agent is given a paper
(or its methods section) and the raw data or the data-acquisition instructions,
and must produce the reported figure through its own implementation.

**Why reproduction rather than open-ended research.** Open-ended research has no
deterministic oracle - novelty and usefulness require a domain expert, which is
why 2b lists them as needing a domain judge. Reproduction is the largest subset
of research work that IS decidable: the answer exists, it is a number, and the
agent has not been given it.

**Instance selection.** A paper with (a) a publicly available dataset, (b) a
headline numeric result stated with enough precision to compare against, (c)
publication date after every model's cutoff, or an obscure enough result that
memorization is implausible - and this second condition is weak, see RISKS. The
paper's own reference implementation, if one exists, is NOT given to the agent
and is used only as the differential comparison.

**What the agent gets.** The paper's methods section with the results section
removed, and the dataset. The number it is being scored against is not in its
context.

### Oracle

Numeric reproduction within a pre-registered tolerance.

- The tolerance is **stated before the run**, derived from the paper's own
  reported variance or confidence interval where one exists, or set at a fixed
  relative tolerance recorded in the frozen rubric where one does not.
- **PASS**: the agent's produced figure falls within tolerance of the published
  figure.
- **PARTIAL**: the agent produces a figure by a defensible method that falls
  outside tolerance.
- **FAIL**: no figure produced, or the pipeline does not run.

Secondary deterministic check where a reference implementation exists:
differential comparison of outputs on identical input. This is a stronger signal
than the headline number alone, because a single scalar can be hit by accident.

### What this oracle CANNOT catch

- **Memorization.** If the result is in the training data, reproduction measures
  recall, not method. This is the dominant threat and it is not fully
  mitigable - see RISKS.
- **Right number, wrong method.** A scalar within tolerance can be reached by a
  pipeline that is wrong in ways that would diverge on any other dataset. The
  differential check reduces this only where a reference implementation exists.
- **Whether the reproduction is a good scientific artifact** - reusable,
  documented, correct in its statistics.
- **Novelty or usefulness.** Reproduction measures neither, by construction.
  2b's "Novelty/usefulness" dimension has no oracle here and is not scored.
- **The paper being wrong.** If the published number is itself an error, the
  oracle rewards reproducing an error.

---

## Pre-registration

Everything in this section is frozen BEFORE the first run. This is the whole
difference between a benchmark and a story.

### QUALITY

Scored solely by the per-task oracle above. Three values only: PASS / PARTIAL /
FAIL, with the per-task definitions as written. No aggregate quality score is
computed across tasks - three tasks cannot support an average, and a mean over
three ordinal values is not a measurement.

There is **no LLM-judged quality dimension**. If a quality question cannot be
answered by the oracle, it appears in the NOT DETERMINISTIC list and goes
unscored.

### COST

- **Measured**: total USD spend attributable to the run.
- **Read from**: the per-run receipt's `cost.usd`, surfaced as `cost_usd`, which
  is the convention `tools/cost-per-outcome.py` and `tools/receipt-stats.py`
  already read (`tools/cost-per-outcome.py:151`,
  `tools/receipt-stats.py:138`). This document adopts that convention rather
  than inventing a second one.
- **UNKNOWN, never 0.** A run that recorded no cost did not cost zero dollars.
  It reads UNKNOWN, it is excluded from every total, and the exclusion is
  reported on the same row as the figure it was excluded from. This rule is
  inherited verbatim from `tools/cost-per-outcome.py`, whose module docstring
  states it as honesty rule 1 and enforces it by letting the MEASURED COUNT
  decide UNKNOWN rather than the total. An unmeasured run is not evidence of
  cheapness; it is an absent measurement.

**Cross-tool comparability - the load-bearing caveat.** The above reads Loki's
artifacts. Competing tools emit no receipt. An oracle that can only read our own
cost artifact silently advantages us, and a founder reading `$X vs UNKNOWN` will
read UNKNOWN as "free" or as "broken" when it means neither.

The pre-registered rule:

1. Cost is captured uniformly where the provider exposes a per-run usage record
   independent of the tool (provider-side billing or usage API, bracketed by the
   harness around the run). That figure, not the tool's self-report, is the
   comparable one.
2. Where a tool provides no such record, its cost reads **UNKNOWN** for that run.
3. **A measured figure and an UNKNOWN cannot be differenced, ratioed, or ranked
   against each other.** A cost comparison is reported only across tools that
   were all measured by the same route. If only one tool has a measurable cost,
   there is no cost comparison in that experiment, and the section says so
   instead of showing one column with a number and one column empty.

### TIME

- **Measured**: wall clock from run start to run end.
- **Read from**: the tool's own emitted artifacts. For Loki, timestamps in
  `.loki/events.jsonl` (flat `{"timestamp","type","data"}` schema, per
  `autonomy/completion-council.sh:3893`), and where the run produces a preview,
  `.loki/app-runner/first-preview.json`. For tools that emit no timestamped
  artifact, an external timestamp bracket written by the harness immediately
  before spawn and immediately after exit - written by the harness, not by the
  tool.
- **NEVER `ps etime` on a supervising process.** This is not a stylistic
  preference. This repo hit exactly this bug: a hung benchmark harness reported
  39 minutes for a 20-minute run because `etime` measured the WAITER's lifetime,
  not the work. `pgrep -f` additionally matches the waiter itself. Any time
  figure sourced from a process table is void and is re-measured, not adjusted.

**Cross-tool comparability applies to TIME exactly as it does to COST**, and for
a sharper reason. Our `events.jsonl` clock starts after the engine is already
up; a harness bracket around a competitor includes process spawn, client init,
and teardown. Differencing the two makes our number smaller for reasons that are
not speed - RISK 7 (harness asymmetry) expressing itself inside a scored
dimension. Therefore: **the comparable wall clock is the harness bracket,
applied uniformly to every tool INCLUDING ours.** The tool's own artifacts
(`.loki/events.jsonl`, `.loki/app-runner/first-preview.json`) are the
finer-grained internal breakdown - reported, never used for a cross-tool
difference. A harness-written timestamp around spawn and exit is not a
process-table read, so this satisfies the prohibition above rather than evading
it.

### The frozen rubric

The scored dimensions are exactly: **QUALITY** (oracle verdict), **COST**,
**TIME**. Three. That is the entire rubric.

> **A dimension added after seeing results is a dimension chosen because of
> them.** If, after the first run, someone proposes a fourth dimension, that
> proposal is evidence about the results and not about the rubric. The honest
> handling is to run it as a NEW, separately-reported experiment against a
> re-frozen rubric, and to state in the report that the dimension was added
> post-hoc and on which observation. Silently widening the rubric converts a
> benchmark into a search for a framing in which we win.

---

## Held-out discipline (mandatory)

1. **Task instances are not selected by whoever tunes the harness.** Selection
   is by the mechanical filter stated per task - repo pinned at a SHA, filter
   predicate, deterministic sort, first N. The filter is written down before the
   candidate list is inspected. If an instance is dropped (unwithhold-able test,
   dynamic dispatch, missing dataset), the drop and its reason are reported
   alongside the results. An unreported drop is a selection effect.

2. **One scored attempt per tool per task.** The first run is the run. A retry
   after seeing the result is a DIFFERENT EXPERIMENT: it is reported separately,
   labelled as a retry, with the observation that prompted it stated. It is
   never averaged into the first attempt, and the first attempt is never
   replaced. "Best of N" where N was chosen after seeing the failures is not a
   measurement of capability; it is a measurement of how many tries the
   experimenter was willing to fund.

3. **Task text is NEVER committed to this repo.** A task stored in the
   repository is a task inside the context of the thing being measured - any
   agent running in this tree can read it, and every future model trained on
   this repo has seen it. This document therefore contains task SHAPES,
   SELECTION RULES, and ORACLE DEFINITIONS, and contains no task text, no repo
   URL, no issue number, no paper title, and no expected value.

   **Where they live instead**: task instances are stored outside this
   repository and outside any directory an agent under test is given - a private
   store, referenced from the run harness by identifier only. The run report
   cites instances by opaque ID. Resolving an ID to its content is a manual step
   performed by the person running the experiment. If an instance's text ever
   appears in this repo, in a commit message, or in a run log committed here,
   that instance is **burned** and is replaced, not reused.

---

## Calibration caveat (must not be softened)

`tools/calibration-audit.py` scores **AGREEMENT WITH THE COUNCIL MAJORITY, NOT
ACCURACY.** The council's outcome is mechanically derived from the votes
(`approve_count >= threshold`), so a voter's own prediction partially CAUSES the
label it is subsequently scored against. A voter scoring perfectly there may
simply be voting with the crowd. No artifact on disk records whether the council
was actually RIGHT, so ground-truth calibration is not computable from that
substrate at all.

Therefore, in this document and any report generated from it:

- Calibration is **a caveat, never an accuracy term and never a quality term.**
- Calibration is **never a scored dimension.** It is not in the frozen rubric
  above and may not be added to it. A high calibration figure is not evidence
  that any task was completed well, and must never be cited as though it were.

Factual note on availability: `tools/calibration-audit.py` is not present in
this worktree at the current commit. It exists on another branch (introduced in
commit `8c33d123`), whose own module docstring states this circularity in the
same terms. The caveat above stands at full strength regardless of which branch
the tool is on - it is a prohibition on how a class of number may be used, not a
description of a file.

---

## Dimensions that are NOT deterministic and are NOT scored

These are inherited from 2b's scored-dimension table, where they are defined.
They are listed here because this document's job is to say which of them have
oracles. **These do not.** They are marked NOT DETERMINISTIC and left unscored
rather than approximated with an LLM judge.

| Dimension (defined in 2b) | Why it has no oracle |
|---|---|
| Completion quality *beyond the oracle verdict* | 2b defines it as judged against intent. Intent is not a file. The oracle covers "does it pass"; "is it what was wanted" is human. |
| Maintainability | Requires reading the diff as a future maintainer. No checker distinguishes a clean fix from a working mess. |
| Intervention rate | Countable in principle, but what counts as an intervention is a judgement about whether a nudge was necessary or merely habitual. |
| Novelty / usefulness (T5) | 2b already states this needs a domain judge. Reproduction deliberately sidesteps it and therefore does not measure it. |
| User value ("would the requester ship it") | 2b's own framing: the only dimension that ends in a human. It ends in a human here too. |
| Recovery after induced failure | Requires deliberate fault injection not designed here; the fault set would be chosen by the harness tuner, which is the selection effect this document exists to avoid. |
| Verification tax | The time/token half is measurable; "how often it changed an outcome" requires knowing the counterfactual outcome, which is not observable from a single run per task. |

Being unscored is not the same as being unimportant. Several of these matter
more than the ones that are scored. They are excluded because a fabricated
measurement of an important thing is worse than an acknowledged gap.

---

## RISKS: what could make these results misleading even if executed perfectly

1. **Training-data contamination.** The dominant threat. Public repos, their
   issues, their fixes, and published papers with their numbers are all
   plausibly in training data. Post-cutoff filtering is a mitigation, not a
   solution: cutoffs are approximate, self-reported, and differ per tool, so a
   date filter that holds one model out may not hold another. A tool that
   memorized the fix and a tool that derived it produce identical oracle
   verdicts. **This affects TASK-S most severely** and is why TASK-S results, if
   ever produced, carry lower evidential weight than TASK-B or TASK-M.

2. **n is far too small for a ranking.** Three task shapes, one instance each,
   one attempt each. This can support existence claims ("tool X solved this
   instance") and cannot support comparative claims ("tool X is better than tool
   Y"). Any percentage computed over three tasks is theatre. Reporting a winner
   from this design would be the central misuse.

3. **Selection effects that survive the mechanical filter.** The filter is
   mechanical but the CHOICE OF FILTER is not - which repo, which language,
   which issue-shape predicate. A filter that happens to select tasks resembling
   our own test corpus advantages us. Mitigation: fix the repo and filter before
   inspecting candidates, and report the drop list.

4. **Oracle gaming.** A held-out test suite is a target once the agent infers it
   exists. Agents can write code that special-cases plausible test inputs, or
   over-fit to behaviour implied by the issue text. TASK-M's residual-call-site
   invariant is specifically gameable by deletion, which is why it is never
   reported without the behaviour check and the count floor. Assume any oracle
   stated publicly will eventually be optimized against.

5. **Tool-version drift mid-experiment.** These CLIs ship frequently - this repo
   itself releases hourly. A run of tool A on Monday and tool B on Wednesday
   compares two different weeks, not two tools. Mitigation: pin and record the
   exact version of every tool, and re-run the whole matrix if any version
   changes mid-experiment. A partially-refreshed matrix is void.

6. **Environment non-determinism.** Network flakiness, rate limits, provider-side
   model routing, and nondeterministic sampling mean the same tool on the same
   task can produce different outcomes. With one attempt per task, a single rate
   limit is indistinguishable from a capability failure. Rate-limit and
   infrastructure failures must be recorded as INFRASTRUCTURE, not FAIL, and
   such a run is re-run - which is itself a deviation from one-attempt
   discipline and must be reported as one.

7. **Harness asymmetry.** We wrote the harness. Our tool's artifacts are
   first-class to it; competitors are driven through whatever CLI surface they
   expose. Effort spent making our own path work smoothly and not theirs is an
   advantage that looks like capability. Mitigation: drive every tool through
   its documented non-interactive entry point only, and report any tool for
   which the harness needed tool-specific accommodation.

8. **The oracle can be wrong.** Upstream tests can be flaky, papers can report
   errors, and type checkers have config-dependent behaviour. A deterministic
   oracle is reproducible, which is not the same as correct.

---

## COST-TO-RUN estimate

**This is an estimate, not a measurement.** No run has occurred; nothing here is
read from an artifact. It exists so the expenditure can be approved or declined
before rather than after.

**Assumptions** (each is a place the estimate can be wrong):

- 3 tasks x 1 attempt x the number of tools compared. At 4 tools that is 12
  scored runs.
- Per-run agentic spend of roughly $2-$15 depending on tool, model tier, and
  iteration count. The spread is wide because iteration count is the dominant
  cost term and is exactly what the experiment is measuring - it cannot be
  known in advance without circularity.
- Oracle execution (test runs, type checks, AST queries) is local CPU only:
  effectively $0 in provider spend.
- TASK-S is excluded from this estimate because it is a plan, not a runnable
  task. Adding it means adding dataset acquisition and compute of unknown size.
- Setup labour (instance selection, test-withholding verification, harness
  wiring per tool) is human time and is NOT included in the dollar figure.

**Estimated provider spend**: roughly **$25 to $180** for a 4-tool, 2-task
(TASK-B and TASK-M) matrix. The upper bound is what to budget; the lower bound
is what to hope for.

**Estimated wall clock**: roughly **4 to 12 hours** of run time for the matrix
if run serially, plus an estimated **1 to 3 days of human setup** dominated by
instance selection and by verifying per instance that the oracle tests are
genuinely withheld. The setup is the expensive half and is not parallelizable by
adding tools.

**What the money buys.** Existence claims on two task shapes with
non-self-graded oracles, and a reusable harness. It does NOT buy a ranking - see
RISKS 2. A founder approving this should approve it as instrumentation, not as a
competitive result, and should decline it if a ranking is what is wanted, because
this design cannot produce one honestly.

---

*Status per section 2b's Status separation table: **Planned experiments**. Zero
runs to date.*
