# Loop harness audit, and one proposed measurement slice

Audit only. No runtime behaviour is changed by this document, and the proposal
at the end is read-only by construction.

Every figure here was measured against the working tree at `4d8625bb`
(v9.12.5) on 2026-08-04. Commands are included so each can be re-run rather
than trusted.

## What already exists

### Structured traces

`.loki/events.jsonl` is the trace surface, written by `emit_event_json`
(`autonomy/run.sh:2435`) with a UTC timestamp and arbitrary `key=value` pairs.
**26 distinct event types** are emitted:

```
agent_prompt              budget_exceeded            budget_warning
capability_degraded       code_review_complete       code_review_council_complete
code_review_*_oversized   code_review_start          dashboard_crash
gate_stuck                iteration_complete         iteration_start
managed_agents_fallback   managed_review_council_ok  phase_change
policy_denied             provider_failover          provider_recovery
review_verification_failed session_end               session_start
stage_complete            task_completion_claim      watchdog_alert
```

```bash
grep -ohE 'emit_event_json "[a-z_]+"' autonomy/run.sh | sort -u
```

### Verifier surface

Gate functions in `autonomy/run.sh`:

```
_evidence_gate_and_surface     _invariant_gate_and_surface
_semantic_gate_and_surface     _loki_supervised_completion_gates_pass
gate_failure_disposition       build_gate_escalation_context
run_doc_quality_gate           run_magic_debate_gate
```

Plus the 3-reviewer blind council, whose completion is traced by
`code_review_complete` and `code_review_council_complete`.

## The gap, stated precisely

**The verifiers run, but they do not record what the directive asks for.**

`code_review_complete` carries exactly three fields:

```
review_id=<id>  source=managed  iteration=<n>
```

`review_verification_failed` carries:

```
reason=<slug>  iteration=<n>  implementation_retry=<bool>
```

Neither carries any of:

| Field the directive asks for | Emitted today |
|---|---|
| eligibility (did this verifier apply?) | no |
| deterministic criterion | no |
| retry cap / timeout cap | no |
| latency | no |
| tokens | no |
| cash cost | no |
| verdict | partial (failure reason only) |
| changed the terminal outcome? | no |
| false-positive review | no |
| rollback switch | no |

The `_evidence_gate_and_surface`, `_invariant_gate_and_surface` and
`_semantic_gate_and_surface` functions emit **nothing structured at all** --
grepping their bodies for `emit|json|cost|latency|duration|verdict` returns no
matches.

So a loop-harness manifest cannot be *derived* from today's traces. It would
have to be *fabricated*, which is the failure mode this codebase treats as
worse than an absent measurement.

### Why that matters more than it sounds

This session produced a concrete example of the cost. A gate false positive
(mock-integrity firing on `require.resolve` + `spawnSync`) made first-pass
completion impossible for every npm user, and it was invisible until someone
ran the real thing. With per-verifier records carrying `verdict`,
`changed_terminal_outcome` and `false_positive_reviewed`, that class shows up
as a measurement rather than a field report.

## Other audit axes, briefly

**Memory / skills / prompts.** The main-loop prompt is assembled in memory and
never persisted (`build_prompt`, `autonomy/run.sh:8987`), so prompt-version
attribution is not currently possible. Review prompts *are* persisted
(`run.sh:14700`). Any prompt-versioning proposal has to start by making the
main prompt observable, and that is a runtime change -- out of scope here.

**Context compression.** The prompt splits at `[CACHE_BREAKPOINT]` into a
cache-stable prefix and a volatile tail. That is a real, already-shipped
compression discipline. It is not currently measured per-run.

**Model routing by quality/latency/cost.** `get_rarv_tier()` maps iteration to
model tier. The mapping is deterministic and readable; what is absent is any
*recorded* per-call association between the tier chosen and the outcome it
produced, which is what a routing evaluation would need.

## Proposal: `loop-harness-v1`, read-only, one slice

**Do not add a loop. Do not change runtime architecture.** The single coherent
reversible slice is a **report over traces that already exist**, plus the
smallest instrumentation that makes the report non-vacuous.

### Phase A -- report only, zero runtime change

`tools/loop-harness-report.py`, a read-only reader in the shape of the existing
`api_*` modules:

- reads `.loki/events.jsonl`
- emits one row per verifier invocation it can actually observe
- **every field it cannot derive reads UNKNOWN, never a default**
- carries the standard envelope: `source`, `freshness_s`, `reason`
- exits 3 (nothing to check) on a workspace with no verifier events

This is honest on day one: most columns read UNKNOWN, and the report says so.
That is the correct starting point -- it makes the gap visible and measurable
rather than asserting a completeness that does not exist.

### Phase B -- instrumentation, only where A proves it is needed

Add the missing fields to the three gate functions and the council completion
event. Each addition is one `emit_event_json` call with named fields, and each
is independently revertable.

Phase B is **not** proposed for adoption yet: it changes runtime behaviour, and
the directive says keep runtime unchanged unless an evidenced deterministic
requirement justifies it. Phase A produces that evidence.

### What would make this worth automating

The directive's bar is the right one: automate only when offline replay and
online outcomes prove quality-adjusted lift exceeds latency and cost. Phase A
cannot clear that bar and does not try -- it is the measurement that would let
a later proposal clear it.

## Rollback

Phase A adds one file under `tools/` and touches no runtime path. Rollback is
deleting it. Nothing in `.loki/` is written, so there is no state to unwind.

## The four surfaces, measured

| Surface | State | Evidence |
|---|---|---|
| Composable core-agent loop | present, modular | `run_autonomous()` + `get_rarv_tier()` + `build_prompt()` are separable functions |
| Bounded verification loop | present, **unmeasured** | 3 gate fns emit 0 structured records; `code_review_complete` carries 3 fields |
| Real-system event-driven loop | present, **partial contract** | `autonomy/trigger-server.py`: auth 7, timeout 12, idempotency 4, retry 2 -- but dedupe 0, dead-letter 0, backpressure 0 |
| Self-improvement / hill-climbing | present, **not wired to traces** | `LOKI_AUTO_LEARNINGS` appears 0 times in `run.sh`; the TS route has it (`counter_evidence.ts`, `episode_bridge.ts`) |

```bash
for p in idempot dedupe dead.letter backpressure retry timeout auth; do
  printf '%-16s %s\n' "$p" "$(grep -ciE "$p" autonomy/trigger-server.py)"
done
```

### The three exact gaps

1. **Verifier records carry no cost, latency, criterion, or effect.** This is
   the blocker for every downstream ask -- a marginal-lift comparison, a
   promotion rule, and a canary decision all need per-verifier cost and
   outcome, and none is emitted.

2. **The trigger contract is three properties short.** Auth, timeout,
   idempotency and bounded retry exist. Dedupe, dead-letter state and
   backpressure do not. An idempotent trigger without dedupe still processes a
   duplicate delivery; without dead-letter state a poisoned message retries to
   its cap and vanishes.

3. **The learnings loop is route-asymmetric.** `LOKI_AUTO_LEARNINGS` is
   documented as default-on in the Bun runner and is absent from `run.sh`, so
   the bash route contributes nothing to hill-climbing. Any trace-driven
   improvement claim measured on one route does not transfer to the other.

## Why architecture stays unchanged

Every downstream ask in the directive -- matched online cohorts, marginal-lift
per verifier, a promotion rule, a canary window -- is **downstream of
measurement that does not exist**. Building a manifest, a cohort comparison or
an automation rule on top of absent instrumentation would produce numbers with
no referent.

The cheapest surface that changes this is Phase A: a read-only reader that
reports what IS recorded and names what is not. It is implemented and tested
(`tools/loop-harness-report.py`, 8 assertions, both fabrication modes
mutation-tested). Against this repo's own trace it reads 776 records, finds no
verifier events, and exits 3 with a reason rather than printing an empty table
that reads as a clean run.

**The smallest reversible next step** is adopting Phase A and running it over
a real build's trace. That yields the first honest per-verifier row set, and
its UNKNOWN columns are the evidenced requirement that would justify Phase B
instrumentation -- which is a runtime change and is deliberately not proposed
until that evidence exists.
