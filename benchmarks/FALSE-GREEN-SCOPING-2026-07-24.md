# P0 False-Green Benchmark: scoping findings

Date: 2026-07-24. Read-only audit. Status: SCOPING ONLY, nothing implemented.
Deliverable named by the approved v8 competitive plan ("First slice").

## Headline

**False-green is not a benchmark to build. It is a report-layer computation over
data the R2 harness already records.** The audit found both halves already
present and already wired; what is missing is the single cross-product between
them. This shrinks P0 from "build a benchmark" to "compute and publish a
discordance rate", plus one genuinely-open normalization decision (section 4).

## 1. What already exists (verified against the repo)

| Half of false-green | Status | Evidence |
|---|---|---|
| GRADER verdict (ground truth) | **EXISTS** | `trial.success` = held-out acceptance exit == 0. Set ONLY by `runner.grade`. Held-out integrity via `acceptance.overlay` copied in AFTER the agent finishes (the SWE-bench test-patch pattern), so the agent cannot edit the test that grades it. `SCHEMA-result.md:8-19`. |
| Grader actually discriminates | **EXISTS, PROVEN** | `benchmarks/bench/tests/test_grader_discrimination.py` drives `runner.grade()` against a correct and a missing artifact, asserting True vs False, with no billable agent call. Without this the numbers would mean nothing. |
| DECLARED verdict (the agent's own claim) | **EXISTS for Loki** | `adapters/loki.py:107 _read_verify_verdict()` reads `.loki/proofs/<run_id>/proof.json` -> `honesty.headline` ("VERIFIED" / "NOT VERIFIED") and exposes it as `provenance.verify_verdict`. |
| The cross-product (false-green) | **IMPLEMENTED 2026-07-24** | `equivalence_report.py` now exposes two axes per cell: `false_green` (the headline, one normalization rule applied to every tool) and `false_green_structured` (Loki's receipt verdict, secondary). Denominator is CLAIMED trials, so the published number answers "when this tool says it is done, how often is it wrong". Guarded by `tests/test_bench_false_green.py` (12 tests, proven non-vacuous: 11 fail without the implementation). |

### The near-miss worth noting

`equivalence_report.py` ALREADY has an "honesty" axis reading `verify_verdict`
(`:190`), but it measures the wrong thing: "fraction of trials with a real proof
**present**, else not_captured" (`:11`). It counts whether a receipt EXISTS. It
never asks whether the receipt was RIGHT. Proof-presence and proof-correctness
are different metrics, and only the second one is the moat.

## 2. Provenance rule: ALREADY SATISFIED (no new corpus needed)

The plan required that Autonomi must not author the bug population (otherwise we
seed the bugs our own gates catch, which is source 08's prohibited "builder
authors all hidden tests"). The repo already satisfies this:

- `benchmarks/swebench-pro-pilot/` carries `pilot-subset-119.json`,
  `DATASET-SHA256.txt` (`b5b2462b...` over `sweap_eval_full_v2.jsonl`),
  `HARNESS-COMMIT.txt` (`ca10a60a`), and a pre-registered `METHODOLOGY.md`.
- `benchmarks/swebench/` has `loader.py` + `pinned-subset.json`.
- `bench_schema.py:69` already carries a per-task `"source"` field for
  provenance (e.g. `"swe-bench-verified"`).

`METHODOLOGY.md` already institutionalizes the exact discipline the plan asked
for, as binding Hard Rules: **"Loki never grades itself"**, "pre-register before
results", "never publish a generation rate as a score", "lead with the
conservative figure", "publish failures", "cost is raw and never blended".
Grading runs the official `swe_bench_pro_eval.py` out-of-container.

**Reconciliation with the founder decision "SWE-bench RESOLUTION is not the
headline":** no conflict. The published headline stays the false-green rate. The
SWE-bench population is used only as an externally-authored, SHA-pinned task
supply with held-out tests. Resolution rate gets stated as denominator context,
which the methodology rule requires publishing anyway. This is not plan drift.

## 3. Schema constraint (the thing not to break)

`adapters/_base.py:43` declares
`FORBIDDEN_ADAPTER_KEYS = ("success", "quality", "passed", "score", "verdict")`,
and `bench_schema.py:17` states the adapter "NEVER reports success/quality/
passed/score. The GRADER" does. This is deliberate and load-bearing: it is what
stops a tool from grading itself.

The declared verdict is a THIRD category: not an outcome, and not cost/
provenance in the ordinary sense. It currently lives under `provenance` as
`verify_verdict`, which respects the boundary (it is a record of what the tool
CLAIMED, never an input to scoring). Any false-green work must:

- keep the declared verdict OUT of `validate_result_row` / `summarize_trials`
  scoring paths,
- compute false-green in the REPORT layer only,
- bump `SCHEMA_VERSION` (currently `"1.0"`) deliberately if any field moves,
  since `bench_schema.py:7` says the version must change with any field change.

## 4. THE OPEN RISK: cross-tool normalization (blocks the comparative claim only)

This is the one genuinely unresolved question, and it decides whether the
headline can be comparative.

Loki has a STRUCTURED declared verdict (`proof.json` -> `honesty.headline`).
`adapters/claude_code.py` and `adapters/aider.py` have no equivalent. A grep for
proof/honesty/headline/verdict in those adapters returns nothing; the only
available signal is process-level (`_base.py:122` `rc = proc.returncode`).

Consequence: comparing Loki's strict structured claim against a comparator's
loose inferred claim ("exited 0, therefore it declared done") is not an
apples-to-apples measurement, and it biases IN LOKI'S FAVOR. A skeptical reviewer
will say so immediately, and they would be right. Publishing that comparison
without resolving this would reproduce exactly the credibility gap the benchmark
exists to close.

### RESOLVED 2026-07-24 (founder decision): option (b), one rule for all tools

**Normalization rule:** `declared complete = the tool terminated without error
AND produced a non-empty diff`, applied IDENTICALLY to every tool including
Loki. Loki's richer structured verdict (`proof.json` -> `honesty.headline`) is
DELIBERATELY IGNORED for the comparison and reported as a separate secondary
column.

Rationale: this deliberately handicaps our own advantage, which is the posture a
skeptic cannot attack, and it measures what a user actually experiences (the
tool stopped and implied success). A comparison that let Loki use a stricter
self-report than its comparators would be the biased number a reviewer rejects
on sight, reproducing the credibility gap this benchmark exists to close.

Implementation consequence: the false_green axis needs TWO measures per tool -
`false_green_normalized` (the headline, one rule, all tools) and, for Loki only,
`false_green_structured` (using honesty.headline). Publish both, lead with the
normalized one.

The original options, retained for the record:

- **(a) Loki-only first publication.** Publish Loki's false-green rate alone,
  with comparators explicitly deferred and the reason stated. Honest, cheap,
  weaker as a competitive claim.
- **(b) Define a normalization rule** applied identically to every tool, e.g.
  "declared complete = terminated without error and produced a non-empty diff",
  applied to Loki TOO (ignoring its richer proof signal for comparison purposes),
  with Loki's structured verdict reported as a separate secondary column.
  Stronger claim, requires defending the rule.

Recommendation: (b), because it measures what a user actually experiences (the
tool stopped and implied success), and it deliberately handicaps Loki's
advantage, which is the posture a skeptic cannot attack. (a) is the fallback if
budget forces it.

## 5. Cost note

Comparator runs multiply run cost by the number of tools. The existing pilot
pinned `LOKI_BUDGET_LIMIT=8` USD and a 5400s wall cap per instance at 1 trial.
Any fan-out across tools x 119 instances needs that arithmetic done BEFORE the
run, not during (memory: bench-timeout-silent-cell-loss - a timed-out cell
produces NO result file and a stdout-grepping runner advances silently).

## 6. Recommended next actions

1. Founder decision on section 4 (normalization rule vs Loki-only).
2. Implement false-green in the REPORT layer (`equivalence_report.py` /
   `report.py`): add a `false_green` axis = fraction of trials where
   `verify_verdict == "VERIFIED"` AND `success == False`, alongside the existing
   proof-presence axis. Keep `not_captured` semantics for tools with no declared
   verdict rather than scoring them as 0.
3. Add a discrimination test for the new axis, mirroring
   `test_grader_discrimination.py`: synthesize a VERIFIED-but-failing row and
   assert the axis reports it. No billable call.
4. Only then consider a paid run, with the cost arithmetic from section 5 done
   first and one de-risking cell before any fan-out.
