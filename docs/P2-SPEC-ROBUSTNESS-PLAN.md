# P2 Spec Robustness Plan (P2-1 spec interrogation gate + P2-2 assumption ledger)

Status: design for implementation. No version bump, no commit in this arc.

## Goal

Loki must stay accurate even when the input spec is WRONG, ambiguous, or
incomplete. Today two building blocks already detect spec defects but neither
feeds the autonomous loop:

- `autonomy/grill.sh` invokes the provider once with a Devil's-Advocate prompt
  and writes 10-15 hardest spec questions to `.loki/grill/report.md`. It is
  CLI-only (`grep grill autonomy/run.sh` = 0 invocations) and nothing reads its
  output.
- `autonomy/prd-analyzer.py` detects missing PRD dimensions and has a
  deterministic `_make_assumption()` map, writing `.loki/prd-observations.md`,
  which nothing reads. Its interactive Q&A is inert in non-TTY (autonomous) runs.

The fix: run interrogation automatically in DISCOVERY, classify the findings,
record every spec gap as a first-class ASSUMPTION in a tracked ledger, BLOCK
completion while high-severity assumptions are unconfirmed-and-unacknowledged,
and surface the ledger in the proof-of-done output. Defects are SURFACED as
recorded assumptions, never silently autocorrected.

## Core design decision: auto-acknowledgment lifecycle (prevents the trap)

A naive "block completion while any high-severity assumption is unconfirmed"
hard-blocks EVERY ambiguous run to max-iterations, because in autonomous
(non-TTY) mode no human can ever set `confirmed=yes`. We never reach the
"done, plus here is what I assumed" output the goal demands.

Resolution: split the gate from the lifecycle.

- The gate `council_assumption_ledger_gate` is a PURE function of ledger state.
  It blocks iff an entry has `severity=high AND confirmed=false AND
  acknowledged=false`.
- The auto-acknowledgment lifecycle lives in run.sh (NOT in the gate). Once an
  assumption has been written into the ledger AND injected into the build prompt
  at least once, run.sh marks it `acknowledged=true`. Default-on; opt-out
  `LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1` keeps a human-in-the-loop path where only
  `confirmed=true` clears the block.

This is the OPPOSITE of silent autocorrect: the assumption is recorded,
injected into the agent's prompt, and surfaced in proof-of-done. Acknowledgment
records "Loki has SEEN this gap and proceeded with a stated default", not "Loki
hid it". The gate still has teeth on the first iteration (high-sev unacknowledged
blocks) and in the require-confirm path.

## Severity rule (deterministic, no LLM)

grill emits no severity. Classify by section / keyword on the read side:

- HIGH: security blind spots; scale/reliability blind spots; missing or
  untestable acceptance criteria; any line containing contradiction keywords
  (contradict, conflict, inconsistent, mutually exclusive).
- MEDIUM: ambiguities; unstated assumptions; underspecified behavior; all
  prd-analyzer missing-dimension assumptions.

This guarantees a HIGH tier exists (so the gate has teeth) and is fully
deterministic (so tests are reproducible).

## Taxonomy mapping (classification, read-side only)

grill section -> finding class:
- "Ambiguities and missing acceptance criteria" -> ambiguous (HIGH if the line
  references acceptance criteria / testable / measurable; else MEDIUM)
- "Unstated assumptions" -> underspecified (MEDIUM)
- "Security blind spots" -> missing (HIGH)
- "Scale and reliability blind spots" -> missing (HIGH)
- any line with a contradiction keyword (any section) -> contradictory (HIGH)
- prd-analyzer missing dimensions -> missing (MEDIUM, deterministic default)

"None identified." lines are skipped (no fabricated findings).

grill output contract is NOT changed (it is parsed by the loki-grill skill).
We classify a COPY of its markdown; grill.sh stays byte-identical.

## No-fabrication rule for ledger content

A grill finding is a QUESTION, not a resolution. The ledger `assumption` field
for a grill-derived gap is an honest "spec gives no answer; proceeding with the
implementer default for <area>" plus `affects=<area>`. We do NOT invent a
specific resolution the build will not actually follow. prd-analyzer assumptions
reuse its existing deterministic `_make_assumption()` text verbatim.

## Ledger schema (`.loki/assumptions/`)

One JSON file per assumption: `.loki/assumptions/<id>.json`, plus a
human-readable `.loki/assumptions/ledger.md` rollup regenerated on each write.
Each entry:

```json
{
  "id": "a-0001",
  "gap": "<the spec defect / unanswered question, verbatim>",
  "assumption": "<honest stated default Loki proceeds with>",
  "why": "<why this assumption / where the gap came from: grill|prd-analyzer>",
  "severity": "high|medium",
  "class": "ambiguous|contradictory|underspecified|missing",
  "affects": "<area, e.g. security, acceptance-criteria, data-model>",
  "source": "grill|prd-analyzer",
  "confirmed": false,
  "acknowledged": false,
  "created_at": "<iso8601>"
}
```

Stable id = `a-` + zero-padded counter over existing files (idempotent: a second
DISCOVERY run with the same findings does not duplicate; dedupe on the `gap`
text hash).

## Build surface (files + functions)

1. NEW `autonomy/spec-interrogation.sh` (sourced by run.sh; standalone-testable):
   - `spec_interrogation_classify_report <report.md path>`: pure classifier.
     Reads grill markdown, emits one TSV/JSON finding per question line with
     class + severity. Takes a file so a fixture report drives the test with no
     `claude` call.
   - `spec_interrogation_severity_for <section> <line>`: deterministic severity.
   - `spec_ledger_write <gap> <assumption> <why> <severity> <class> <affects>
     <source>`: idempotent writer (dedupe on gap hash) -> `.loki/assumptions/`.
   - `spec_ledger_rebuild_md`: regenerate `.loki/assumptions/ledger.md`.
   - `spec_ledger_high_unresolved_count`: count entries with
     `severity=high AND confirmed=false AND acknowledged=false` (gate input;
     also reused by the summary).
   - `spec_ledger_acknowledge_all`: set `acknowledged=true` on all entries
     (auto-ack lifecycle helper; default path).
   - `spec_interrogation_run <spec_path>`: orchestrator. Default-on
     (`LOKI_SPEC_GRILL=0` opts out). Provider-aware: source grill.sh, call
     `grill_check_provider`; if provider absent, log honest message, skip the
     grill subcall (NO fabricated questions), but STILL fold prd-analyzer
     missing-dimension assumptions into the ledger so degrade surfaces something
     non-blocking. On provider present: run `grill_main` (writes report.md),
     classify it, write ledger entries. Always non-fatal to the run.

2. `autonomy/run.sh` DISCOVERY (~13056, after prd-analyzer + council_init,
   before the iteration loop): source spec-interrogation.sh and call
   `spec_interrogation_run "$prd_path"`. This is the grep-able grill invocation
   the task requires. Best-effort (`|| true`), never blocks startup.

3. `autonomy/run.sh` auto-ack lifecycle: after the build prompt is constructed
   each iteration (assumptions are injected into the prompt via build_prompt),
   call `spec_ledger_acknowledge_all` UNLESS
   `LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1`. Inject the high-severity assumption
   list into the build prompt (so the agent sees the gaps it must respect).

4. `autonomy/completion-council.sh` `council_assumption_ledger_gate` (new),
   slotted into `council_evaluate` right after `council_evidence_gate`
   (mirrors 2510-2513). Same defensive `COUNCIL_STATE_DIR` default, opt-out
   `LOKI_ASSUMPTION_GATE=0`. Blocks iff `spec_ledger_high_unresolved_count > 0`.
   Writes `.loki/council/assumption-block.json` on block, removes it on pass.
   Also wired into the completion-promise route in run.sh (~14525 pattern) and
   the code_review gate chain (~15013) so the promise path cannot bypass it.

5. `autonomy/run.sh` `build_completion_summary` (~2637): emit an
   "Assumptions recorded: N (M high-severity)" block into COMPLETION.txt and the
   ledger list, plus the count into completion.json. So "done" means "done, plus
   here are the N places your spec was ambiguous and what I assumed."

6. NEW `tests/test-spec-interrogation.sh` (bash convention, ok/bad counters,
   source the module, mktemp fixtures):
   - (a) classifier on a fixture grill report writes classified findings to the
     ledger (ambiguous/contradictory/underspecified/missing + high/medium).
   - (b) a ledger with one high/confirmed:false/acknowledged:false entry makes
     `council_assumption_ledger_gate` return 1 (BLOCK) and write
     assumption-block.json.
   - (c) clean spec (no high-sev entries, or all acknowledged) -> gate returns 0
     (no spurious block), no block file.
   - (d) no provider -> `spec_interrogation_run` degrades cleanly: honest
     message, prd-analyzer assumptions still folded (medium, non-blocking), run
     proceeds, gate passes.

## Gate reachability (resolved open question)

The existing gates fire from THREE sites: `council_evaluate` (~2510), the
completion-promise route (~14525), and the code_review gate chain (~15013). The
new gate is wired into all three so high-sev unacknowledged assumptions cannot
slip through the promise path.

## Opt-out knobs (all default-on, intelligent)

- `LOKI_SPEC_GRILL=0` -> skip interrogation entirely.
- `LOKI_ASSUMPTION_GATE=0` -> gate is pass-through.
- `LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1` -> require human `confirmed=true`
  (disables auto-ack); the human-in-the-loop path.

No "user must decide the type" knob. Classification + severity are automatic.

## Constraints

No emojis, no em dashes, no version bump, no commit, no push. Provider-aware,
degrade cleanly, no fabricated questions when provider absent.
