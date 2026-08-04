# loop-candidate-v1: proposal only

**GATE VERDICT: FALSE.** Nothing here is implemented, and nothing may be until
the gate closes. See the last section for the single gate-closing action.

| Gate | Verdict | Evidence |
|---|---|---|
| Local full tier | **DO NOT PUSH** | 161 passed, 3 failed, 0 deferred |
| Remote exact-SHA | **failure** | `Tests@dda8beec` completed/failure, Shell shard 2 |

## 0. Why this proposal is small

The six cheaper surfaces come first by directive, and the honest finding is
that **the one evidenced product defect this session surfaced cannot be
addressed by any of them**: `loki onboard --stdout` emits 0 bytes and exits 0
on a 4100-file repository while working on a small one. It is a bash command
that never calls a model, so memory, retrieval, skills, prompts, tool
descriptions, compression and routing are all inapplicable by construction.

That leaves routing as the only surface with both an evidenced question and
existing instrumentation. This proposal is therefore scoped to **one routing
candidate**, and it is deliberately the smallest thing that could clear the
preregistered bar.

## 1. Provenance

Every field pinned, no "current" or "latest":

| Field | Value |
|---|---|
| baseline runtime | `dda8beec` (origin/main), loki-mode 9.12.5 |
| candidate runtime | **none** -- this proposal changes no runtime code |
| harness | `tools/loop-harness-report.py` @ `2910a95d` (read-only) |
| task corpus | 1 spec, `wordcount` (pure helper + test), verbatim in both arms |
| grader | the produced test suite, executed; plus receipt `iterations.succeeded` |
| prompt version | unchanged; main-loop prompt is **NOT ATTRIBUTABLE** (assembled in memory, `run.sh:8987`) |
| skill version | unchanged |
| routing arm A | `LOKI_SESSION_MODEL=sonnet` |
| routing arm B | `LOKI_SESSION_MODEL=opus` |
| verifier set | unchanged; **records carry no cost/latency**, see §5 |

**The prompt row is a known provenance hole.** The main-loop prompt cannot be
versioned today, so any candidate that claims a prompt effect is unfalsifiable.
This proposal therefore claims none.

## 2. Success and noise criteria, preregistered

- **Primary**: cost_usd per successful run, matched on the identical spec.
- **Secondary**: wall_clock_sec, and `progress duration_ms` reported separately
  -- these are NOT the same quantity and are never summed. Wall clock includes
  orchestration; progress duration is measured work.
- **Success requires**: `iterations.succeeded >= 1` AND the produced test suite
  passes when executed. A receipt is not evidence the code works.
- **Noise rule**: a difference below **25%** on the primary is declared noise
  and not reported as an effect. Justification: the two prior UNMATCHED runs
  differed by 2.0x on the same nominal models, which bounds run-to-run
  variance well above any effect a single pair could detect.
- **Minimum n**: 5 matched pairs. Below that, report "insufficient", never a
  direction.

## 3. Caps

| Cap | Value |
|---|---|
| retries | 0 -- a failed arm is recorded as failed, never retried |
| per-run timeout | 900s (matches the runs already executed) |
| iterations per run | `LOKI_MAX_ITERATIONS=2` |
| total spend ceiling | **$25**, hard stop; at ~$0.70/run that is ~35 runs |
| canary population | **none** -- offline only; no production traffic |
| canary window | n/a until offline clears |

## 4. Evals

**Deterministic regression**: the existing suites, unchanged and frozen at the
baseline SHA. Any new failure disqualifies the candidate outright, regardless
of primary-metric movement.

**Ambitious artifact-level outcome**: one real `loki start` on a spec requiring
a multi-file artifact (module + test + usage doc), graded by (a) the produced
tests executing green, and (b) the receipt verifying via
`api_evidence.receipts_report`. Flat-or-better is required; a cost win with a
degraded artifact is a rejection, not a trade.

## 5. Verifier lift versus p95 latency and cost -- BLOCKED, stated as such

This element **cannot be satisfied today** and the proposal does not pretend
otherwise.

Verifier records carry no cost, latency, criterion, or terminal-outcome effect:
`code_review_complete` emits exactly `review_id`, `source`, `iteration`; the
three gate functions (`_evidence_`, `_invariant_`, `_semantic_gate_and_surface`)
emit nothing structured at all. So the denominator for "lift vs p95 latency and
cost" does not exist, and no matched on/off cohort can be computed.

Closing this needs runtime instrumentation, which the directive excludes
without an evidenced deterministic requirement. **This proposal therefore makes
no verifier claim and proposes no verifier change.**

## 6. One reversible candidate at a time

Exactly one variable moves: `LOKI_SESSION_MODEL`. It is an environment
variable, so reversal is unsetting it -- no code, no migration, no state.

Structured-trace learning is **read-only**: `loop-harness-report.py` reports
what traces contain and marks every underivable field UNKNOWN. It proposes
nothing automatically.

## 7. Replay, rollback, retention

- **Frozen replay**: each run's receipt pins `base_sha`, `head_sha`,
  `diff_sha256`, model, provider and cost. The spec is stored verbatim.
- **Automatic rollback**: none needed -- no runtime change to roll back. If the
  candidate loses, the env var is simply not set.
- **Retained prior version**: baseline is `dda8beec` on origin/main, immutable.

## 8. Trigger-to-receipt path

Already present and verified by execution, not by grep:

| Property | State |
|---|---|
| authentication | present |
| idempotency | present |
| dedupe | present -- `seen_delivery()`, lock-guarded bounded OrderedDict |
| backpressure | present -- bounded queue, 503 shed |
| bounded retry | present |
| timeout | present |
| dead-letter | **failures logged, not queryable** |

The one gap is a queryable failure record. It is narrow and **not proposed for
change** on this evidence.

## 9. Human approval

Required for: promotion to default, any spend beyond the $25 ceiling,
destructive or security-boundary changes, and any external action (publish,
tag, post). Not required for: running the offline arms within the ceiling.

## What would falsify this candidate

- any new deterministic regression -> reject
- artifact outcome degraded -> reject even if cheaper
- primary difference < 25% -> declare noise, no promotion
- fewer than 5 matched pairs -> report insufficient, no direction claimed

## THE SINGLE GATE-CLOSING ACTION

The gate is red because of **three failures, none introduced by the held
commits**:

| Failure | Class | Fixable here? |
|---|---|---|
| `test-onboard-command` (6) | pre-existing; identical at `1c80c85ff~1` | needs a runtime fix to `autonomy/loki` |
| `test-model-override` (1) | pre-existing; 65/66 identical at `1c80c85ff~1` | unknown, undiagnosed |
| `bun run typecheck` | environmental; `tsc` not installed locally | one install |

**The single next action: install the TypeScript toolchain so
`bun run typecheck` can execute locally.** It is the only one of the three that
is a local environment gap rather than a code defect, it is non-destructive and
reversible, and it removes the one failure that is not telling us anything
about the repository.

That alone does not turn the gate green -- the two pre-existing suite failures
remain, and deciding whether to fix them, accept the remote gate as the
documented equivalent, or waive them is a founder call, not mine.

**Implementation stops here.**
