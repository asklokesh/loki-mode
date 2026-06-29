# PRD-Reuse Done-Recognition Gate -- Implementation Plan

Architect design. DESIGN ONLY: no production code in this doc, one file created
(this plan). Read-only against the engine. No emojis. No em dashes.

Repo: /Users/lokesh/git/loki-mode
Feature: when a no-PRD run reuses a previously generated PRD, model-verify
whether the codebase already satisfies that PRD before rebuilding a task queue
and re-running the RARV loop. If verified done, finish through the normal
completion path and tell the user clearly. If not, build only the unsatisfied
requirements. If inconclusive, build (safe default). Never fake-green.

---

## 1. The bug, restated as a control-flow gap

On a no-PRD run over a project Loki already built and completed, the auto-detect
block in `run_autonomous()` (autonomy/run.sh:15140-15217) calls
`decide_generated_prd_action()` (autonomy/run.sh:5590). When the codebase
signature matches the stored one it returns `reuse`, and the block does exactly:

    reuse) ... prd_path="$_gen_prd" ;;

Control then falls straight through to `populate_prd_queue "$prd_path"`
(autonomy/run.sh:15439), which extracts all `prd-*` features from the PRD
(autonomy/run.sh:14580, dedup only by `existing_ids` at 14878), and into the
main RARV loop. Nothing on the `reuse` path ever asks "is this reused PRD
already satisfied by the current codebase?" So a genuinely-done project gets a
fresh 11-task queue plus new iteration-N work, re-running RARV over completed
work. The prior run had already written `.loki/signals/COMPLETION_REQUESTED`,
`.loki/state/completion.json`, and `completion-evidence.md`; the reuse path
ignores all of it.

The fix is a single localized gate between the action decision and the
queue/loop, that re-verifies ground truth with the model and routes to one of
three outcomes.

---

## 2. Integration point (exact function + line region)

Two-part, both inside `run_autonomous()`:

### 2a. Set up the gate inputs in the existing decision block (15140-15217)
No structural change. The block already computes `GENERATED_PRD_ACTION`,
`_gen_prd`, and `_prd_date`. We add nothing here except (optionally) reading the
gate's outcome variable later. Leave 15140-15217 byte-stable for the static
prompt prefix; the action variable continues to be set once per run.

### 2b. Add the gate as a self-contained function called AFTER load_state,
AFTER the restarted-run snapshot, and BEFORE the delegate-branch/start-sha block
and queue build.

Verified line ordering inside `run_autonomous()`:
- 15238  `load_state` (15239 already reads `ITERATION_COUNT` right after).
- ~15248 start-sha capture (`_start_sha_file`, `mkdir .loki/state`).
- 15259  delegate-branch block (`LOKI_DELEGATE_BRANCH`, spawns `loki/delegate-*`).
- 15313-15319 restarted-run snapshot + export.
- 15328-15331 `LOKI_TRUST_RUN_ID` minted (`record_trust_event_bash run_start`).
- 15439  `populate_prd_queue`.

Required call site: BETWEEN `load_state` (15238) and the start-sha / delegate
block (~15248-15259). At that window `ITERATION_COUNT` is live (15239 reads it,
so the gate's fresh-vs-resume disclosure works) AND neither the start-sha capture
nor the delegate branch has run yet, so a verified-done project never spawns a
stray `loki/delegate-*` branch or moves the diff window. Placing the gate at
15319 (after the delegate block) would defeat that, which is why the call site is
the pre-15248 window, not the restarted-snapshot line.

One ordering tradeoff to fold in at edit time: `LOKI_TRUST_RUN_ID` is minted at
15328-15331, AFTER this window. If the done path records a trust event, either
mint the run id inside the gate or hoist 15328-15331 above the gate. Prefer
hoisting the mint (15328-15331) to just after `load_state` so both the gate and
the existing call site see a stable id; verify no other consumer depends on its
current position before moving it.

Why not 15218 with a bare `exit 0`: 15218 is before `load_state`, so
`ITERATION_COUNT` is not yet restored, and a bare `exit` skips main's terminal
finalization (section 6.1). The gate must instead return through `run_autonomous`
so `main()` runs its terminal block.

- Before `populate_prd_queue` (15439): a done verdict must short-circuit the
  ENTIRE queue-build + loop, and an incomplete verdict must hand the queue
  builder its "only-unsatisfied" filter before it runs.

New function name: `reuse_done_recognition_gate` (call once, run-scoped).
The function returns control by either (a) running the council-parity
finalization subset and `return 0` from `run_autonomous`, so `main()`'s terminal
block (18595-18629) finishes the run (done -- see section 6.1), or (b) writing a
satisfied-requirements manifest and falling through (incomplete), or (c) doing
nothing and falling through (inconclusive / fast-path build).

---

## 3. Which GENERATED_PRD_ACTION values arm the gate

The gate runs only on a no-PRD run that is reusing an existing generated PRD:

- `reuse`        -> ARM the gate. Canonical bug case (codebase unchanged).
- `user_owned`   -> ARM the gate. Codebase unchanged, PRD hand-edited; same
                    "already built" situation. The model verifies against the
                    hand-edited requirements.
- `update`       -> ARM the gate, but FAST-STOP DISABLED. Codebase changed
                    since the PRD, so the PRD is stale by definition (that is why
                    the action is `update`). Judging "already done?" against a
                    spec that is about to be rewritten is a false-stop risk, so on
                    the `update` path the gate may resolve ONLY to incomplete or
                    inconclusive -- never to a fast-stop `done`. Its value here is
                    exclusively the incremental-queue case: mark which still-valid
                    requirements are met so the rebuild touches only the gap. A
                    model `done` on the `update` path is treated as inconclusive
                    (fall through to build / normal update flow).
- `generate`     -> DO NOT arm. First run / forced regen (LOKI_PRD_REGEN). There
                    is no prior PRD to be "already satisfied"; maps to the
                    negative fast-path (build).

Guard condition at the call site:

    case "${GENERATED_PRD_ACTION:-}" in
        reuse|user_owned|update) reuse_done_recognition_gate "$prd_path" ;;
    esac

Only `reuse` and `user_owned` (codebase unchanged) may terminate as a
fast-stop `done`. `update` may resolve only to incomplete/inconclusive. For
`reuse`/`user_owned`, "incomplete" is still possible (user deleted code, a
requirement regressed). The model decides the verdict; the action selects whether
to arm AND whether a `done` verdict is allowed to fast-stop.

---

## 4. Fast-path hints (cheap, EXCLUSIVELY negative)

Before any model call, evaluate cheap deterministic signals. CRITICAL CONSTRAINT
(requirements 1 and 3): the fast path may only ever short-circuit toward BUILD
(skip the model, fall through to queue). There is NO deterministic
"checklist all-verified -> stop" shortcut. A positive done verdict is ALWAYS the
model's, grounded in re-verified reality. The very bug shows the deterministic
checklist artifact was stale/desynced (14-vs-19 discrepancy), so it can never be
trusted as a positive done signal.

Negative fast-path: skip the model and fall through to BUILD when ground-truth
"surely not done" signals hold, e.g.:
- No `.loki/signals/COMPLETION_REQUESTED` AND no `.loki/state/completion.json`
  AND no `.loki/checklist/checklist.json`: the project was never completed by a
  prior run; there is nothing plausibly done. Build. (Cheapest, most common
  miss-avoidance: never pay for a model call on a project with zero completion
  footprint.)
- Provider unavailable / degraded (`_loki_done_recog_provider_ok` mirrors
  `_loki_prd_enrich_provider_ok`, autonomy/lib/prd-enrich.sh:65): cannot
  model-verify -> inconclusive -> build (never assert done offline).
- Explicit opt-out (LOKI_REUSE_DONE_RECOG=0): build.

These are hints/inputs only. Their PRESENCE (a completion signal exists) does NOT
short-circuit to done; it merely makes the model call worthwhile. The model still
re-runs tests and re-checks each requirement.

---

## 5. Model-intelligence verification design

Mirror the proven, mockable single-call pattern of prd-enrich
(autonomy/lib/prd-enrich.sh). New library: `autonomy/lib/done-recognition.sh`,
sourced at the gate call site the same way prd-enrich.sh is sourced at
autonomy/run.sh:14931-14937.

### 5.1 The single model-call primitive (the ONE provider touch, mockable)

    _loki_done_recog_invoke <prompt>   # echoes the raw model response

Implementation copies `_loki_prd_enrich_invoke` (autonomy/lib/prd-enrich.sh:43)
verbatim in shape: `command -v claude`, `timeout "${LOKI_DONE_RECOG_TIMEOUT}"`,
`claude --dangerously-skip-permissions -p "$prompt"`, return 1 on any
nonzero/empty. Tests stub THIS function to return canned JSON, exactly as
prd-enrich tests stub `_loki_prd_enrich_invoke`. This is the injection seam that
makes a bash+model gate deterministically testable.

Bounds (mirror prd-enrich):
    : "${LOKI_DONE_RECOG_TIMEOUT:=180}"
    : "${LOKI_DONE_RECOG_MAX_PRD_CHARS:=16000}"
    : "${LOKI_DONE_RECOG_MAX_TEST_CHARS:=4000}"

### 5.2 Ground-truth re-verification BEFORE the model call

The model must judge against re-run reality, not artifacts alone. Before
building the prompt, the gate captures fresh ground truth:

1. Tests: reuse `ensure_completion_test_evidence` (autonomy/run.sh:9094) which
   calls `enforce_test_coverage` (autonomy/run.sh:8595) and persists
   `.loki/quality/test-results.json`. This is the SAME evidence axis the
   completion council/evidence gate reads, so the gate cannot reach a verdict
   that contradicts the council. `enforce_test_coverage` is CWD-safe (it anchors
   every path on `${TARGET_DIR:-.}` internally, confirmed at 8595-8607), so it
   is safe at this pre-loop site. Swallow rc with `|| true` (red tests are data,
   not a crash). If no runner exists, the file records `runner:none` and the
   test axis is honestly inconclusive (feeds "inconclusive -> build" unless the
   model can establish done by code inspection alone, which it should treat
   conservatively).

2. Requirements list: derive from the reused PRD (`$prd_path`, i.e.
   `.loki/generated-prd.md`). Cap to LOKI_DONE_RECOG_MAX_PRD_CHARS.

3. Existing completion evidence (as INPUT/hint only): the prior
   `completion-evidence.md`, `.loki/state/completion.json`, and
   `.loki/checklist/checklist.json` are passed to the model as context labeled
   "PRIOR CLAIMS, possibly stale -- verify against the code, do not trust."

### 5.3 The prompt and the structured return

The prompt instructs the model to: read the PRD requirements; for EACH
requirement, inspect the actual code (and the fresh test-results.json) and
decide whether it is met NOW; treat all prior Loki artifacts as unverified
claims; and return ONLY a JSON object (no prose, no fences), defensively parsed
(slice first `{` to last `}`, mirroring prd-enrich's array slice at
prd-enrich.sh:326):

    {
      "verdict": "done" | "incomplete" | "inconclusive",
      "summary": "<one sentence for the user>",
      "tests": { "passed": <int>, "total": <int>, "green": true|false },
      "requirements": [
        { "id": "<stable id or title slug>",
          "title": "<requirement>",
          "status": "met" | "unmet" | "uncertain",
          "evidence": "<file:line or test name proving it>" }
      ]
    }

Verdict rules enforced in the prompt AND re-derived defensively in bash/python
(never trust the model's top-line verdict blindly):
- `done` requires ALL requirements `met` AND tests green in the fresh
  test-results.json (or `runner:none` with the model citing concrete code
  evidence for every requirement). If the model says `done` but the fresh
  test-results.json shows red or any requirement is `unmet`/`uncertain`, the gate
  DOWNGRADES to `incomplete` (or `inconclusive`). The trust decision is grounded
  in re-verified reality, so a model overclaim cannot fake-green.
- `incomplete` when one or more requirements are `unmet` (with at least one
  `met`, or none).
- `inconclusive` when the model could not establish ground truth (parse failure,
  empty response, all `uncertain`, provider error). Falls to build.

This satisfies requirement 1 (model judgment, not a hardcoded checklist rule),
requirement 3 (trust moat: done is model-verified against re-run tests + code,
never asserted from a stale artifact; inconclusive -> build), and keeps the
verdict consistent with the council's evidence axis.

---

## 6. Outcome routing

### 6.1 done -> finish through the normal completion path (NOT a bare exit)

A bare `exit 0` would skip finalization and risk leaving status/dashboard in a
"running" state with no fresh trust evidence. Instead, REFRESH the verified
completion record and exit through the same machinery a normal finish uses.

Verified exit path. The gate runs INSIDE `run_autonomous()` (the pre-loop
window in section 2b). `main()` calls `run_autonomous "$PRD_PATH"` at
autonomy/run.sh:18515 (`|| result=$?`) and then UNCONDITIONALLY runs its terminal
finalization at 18595-18629 -- `_advance_current_phase "COMPLETED"`, the COMPLETED
marker (18604-18606), proof-of-run (18597-18598), and HANDOFF.md (18614-18629).
That terminal block lives in `main()`, NOT in `run_autonomous()`. So when the
gate `return`s from `run_autonomous` (with or without entering the loop), control
returns to `main()` at 18515 and the terminal finalization runs exactly once.
This is the mechanism that makes step 3's receipt promise real -- a pre-loop
`return` reaches the terminal because the terminal is in the caller, not in the
loop body.

Concretely, on `done` the gate:
1. Writes a fresh verified-completion record reflecting the NOW re-run results.
   The fresh `.loki/quality/test-results.json` is already on disk. Reuse the
   standalone completion-summary writer `build_completion_summary`
   (autonomy/run.sh:3026), which emits both `.loki/state/completion.json`
   (3196-3210) and `completion-evidence.md` -- the SAME writer the council
   approval path uses (called from completion-council.sh:3211). Confirm it is
   callable standalone from the pre-loop site (it reads git/state, not loop
   locals); if it requires loop-set vars, pass them explicitly or factor the
   write. The per-requirement `requirements[]` array is recorded as the evidence
   body, so the record is reconciled-and-refreshed, not a parallel fabricated one.
2. Runs the same finalization subset the council approval path runs (mirroring
   autonomy/run.sh:17688-17704), then RETURNS from `run_autonomous` so `main()`'s
   terminal block (18595-18629) does the COMPLETED marker, phase-advance, proof,
   and handoff. To avoid double-writing the COMPLETED marker / phase, the gate
   should do the council-parity pieces that the main terminal does NOT
   (`council_write_report`, `run_memory_consolidation`, `on_run_complete`,
   `emit_completion_summary complete`, `save_state ... reuse_already_satisfied`)
   and let main own `_advance_current_phase "COMPLETED"` + the COMPLETED marker
   (18604-18606). Verify at edit time which subset main already covers so neither
   is run twice:
       type council_write_report &>/dev/null && council_write_report
       run_memory_consolidation
       on_run_complete                  # autonomy/run.sh:3516 (optional PR/summary/ping)
       emit_completion_summary complete # autonomy/run.sh:3367
       save_state ${RETRY_COUNT:-0} "reuse_already_satisfied" 0
       return 0   # back to main() -> terminal finalization at 18595-18629
   Do NOT `exit`. Do NOT enter the loop. A `return 0` (clean) is correct here; a
   `return 2` is unnecessary because there is no loop to stop -- the pre-loop
   return already skips queue-build and iteration.

   Alternative (if `build_completion_summary` proves loop-coupled): have the gate
   only write the COMPLETED marker + refreshed completion.json + advance phase,
   then `return 0`; main's `is_completed()` check (17205) is INSIDE the loop and
   so is irrelevant on the pre-loop return -- the loop never runs. Either way the
   single guaranteed terminal is main's 18595-18629. Pick the
   `build_completion_summary`-reuse route if it is standalone-safe (preferred:
   one writer, no divergence); fall back to the marker-only route otherwise.
3. The proof-of-run + HANDOFF.md generation (autonomy/run.sh:18597-18629) runs in
   main's terminal block after `run_autonomous` returns, so the user gets a
   receipt with the honest re-run headline.

This is the "interacts with completion machinery without contradicting it"
requirement: we reconcile WITH the prior evidence, refreshed against re-run
reality, and exit through the one true completion path. No double-gating: the
council never runs because the loop never starts; the gate produced the same
kind of evidence the council would have read.

### 6.2 incomplete -> incremental queue (only unsatisfied requirements)

`populate_prd_queue` (14580) builds ALL features; its only filter is the
`existing_ids` dedup at 14878. To make it incremental we add ONE read-point:

- The gate writes a satisfied-requirements manifest:
  `.loki/state/satisfied-requirements.json`:

      {
        "prd_sha": "<hash of the PRD the verdict was computed against>",
        "generated_at": "<iso8601>",
        "satisfied": ["prd-001 title or stable id", "..."],
        "source": "reuse-done-recognition"
      }

  Identity is by the same requirement key the queue builder uses to mint task
  ids (`prd-NNN` is positional at 14877; to be robust, key on the feature TITLE
  and let the manifest store titles, matched case-insensitively in the builder).

- `populate_prd_queue` reads the manifest once (guarded: only when it exists AND
  its `prd_sha` matches the current PRD hash, so a stale manifest is ignored) and
  SKIPS any feature whose title is in `satisfied[]`, alongside the existing
  `existing_ids` skip at 14878:

      if task_title_satisfied(feat["title"]):  # new, manifest-driven
          continue

  Result: only unmet requirements become `prd-*` tasks; the RARV loop works only
  the remaining gap, not a from-scratch rebuild. If the manifest is absent or
  stale, the builder behaves exactly as today (full build) -- safe default.

- Disclosure: the gate logs "N of M requirements already satisfied; building
  only the K unmet (<titles>). Pass --fresh-prd to rebuild from scratch."

Then the gate falls through (no exit); the run proceeds into queue-build and the
loop normally, now scoped to the gap.

### 6.3 inconclusive -> build (safe default, never falsely done)

Do nothing: write no manifest, no completion. Log "Could not verify whether the
project already satisfies its spec (<reason>); proceeding to build." Control
falls through to the normal full queue-build + loop. This is the prd-enrich
graceful-fallback contract (provider missing / timeout / unparsable ->
deterministic fall-through), applied to the done decision. NEVER declare done on
inconclusive.

---

## 7. User-facing messaging (enterprise UX, requirement 2)

- done:
  "This project already satisfies its spec. Verified N/N requirements met and
  tests green (re-ran the suite now). Nothing to build. To rebuild from scratch
  run `loki start --fresh-prd`; to extend it, edit the spec or pass a new/changed
  PRD." (emitted via log + emit_completion_summary complete.)
  Risk-mitigating clarity: a user who genuinely WANTS to extend a done project
  must immediately see the two escape hatches (--fresh-prd, new/changed spec).
  Make that the last line of the done message so it is unmissable.

- incomplete:
  "This project partially satisfies its spec: K of M requirements still need
  work (<short list>). Building only those. (Pass --fresh-prd to rebuild
  everything.)"

- inconclusive:
  "Could not confirm whether the existing code already satisfies the reused spec
  (<reason: provider unavailable / tests inconclusive / unparsable verdict>).
  Proceeding to build to be safe."

All strings: plain text, no emojis, no em dashes (repo convention).

---

## 8. Interaction with existing council / completion machinery (no double-gate)

- On `done`: the loop never starts, so council_should_stop / council_vote /
  council_evidence_gate never run. The gate produces the SAME evidence those
  gates read (fresh test-results.json + completion.json), so there is no
  contradictory or parallel notion of "done." The completion finalization
  subset it runs is the SAME one the council approval path runs
  (run.sh:17688-17704), so dashboards/markers/memory stay consistent.
- On `incomplete`/`inconclusive`: the gate adds no completion state; the normal
  loop, council, and evidence gate are fully in force for the (possibly reduced)
  remaining work. No behavior change to those paths.
- The fast-path uses the council's artifacts (COMPLETION_REQUESTED,
  completion.json, checklist.json) only as NEGATIVE inputs (their absence ->
  build), never as a positive done shortcut, so it cannot inherit the stale-
  artifact bug.

---

## 9. Test strategy (deterministic bash + mocked model)

New test: `tests/test-reuse-done-recognition.sh`, style mirroring the prd-enrich
and stop-scoping tests (bash, set -u, ok/bad counters, mktemp -d under /tmp with
trap-rm on every exit, no network, no real agent). The model call is injected by
overriding `_loki_done_recog_invoke` to echo canned JSON, exactly as prd-enrich
tests override `_loki_prd_enrich_invoke`.

Cases:
- T1 done verdict + green test-results.json -> gate routes to completion:
  assert `.loki/COMPLETED` written, `.loki/state/completion.json` refreshed,
  NO `.loki/queue/pending.json` prd-* tasks built, normal-terminal return.
- T2 model says done but fresh test-results.json is RED -> DOWNGRADE: assert NOT
  done (incomplete/inconclusive), no COMPLETED marker (no fake-green).
- T3 model says done but a requirement is `unmet` -> downgrade to incomplete;
  assert satisfied-requirements manifest excludes the unmet one.
- T4 incomplete -> manifest written with the met titles; stub populate read-point
  test asserts only unmet features become tasks (feed a 3-feature PRD, mark 2
  satisfied, assert 1 task).
- T5 inconclusive (invoke returns nonzero / empty / unparsable) -> no manifest,
  no completion, falls through to full build.
- T6 negative fast-path: no COMPLETION_REQUESTED + no completion.json + no
  checklist -> model NOT called (assert the stub recorded zero calls), full
  build.
- T7 provider not ok (stub `_loki_done_recog_provider_ok` false) -> inconclusive
  fast-path, build, model NOT called.
- T8 action gating: GENERATED_PRD_ACTION=generate -> gate not armed (no model
  call); reuse/user_owned/update -> armed.
- T9 manifest staleness: prd_sha mismatch -> populate_prd_queue ignores manifest
  and does a full build (safe default).
- T10 no-emoji/no-em-dash static grep over the new lib and the new strings.

Register in scripts/local-ci.sh (mirror the prd-enrich registration):
  run_check "tests/test-reuse-done-recognition.sh (reuse done-recognition gate)" \
            "bash tests/test-reuse-done-recognition.sh 2>&1 | tail -3"

Sourceability: the gate logic lives in `autonomy/lib/done-recognition.sh` (like
prd-enrich.sh), which is independently sourceable in the test without sourcing
run.sh. The `populate_prd_queue` read-point change is tested by exercising
populate_prd_queue in a temp project (it is already invoked in integration-style
tests) or by awk-extracting the python heredoc filter, defaulting to the
sourceable-lib approach for the gate proper.

---

## 10. Rollout

- Phase 1 (one release): env-gated DEFAULT-ON with a documented opt-out, so the
  intelligent default ships immediately (requirement 5: unified default, not a
  new knob) but operators retain an escape hatch:
      LOKI_REUSE_DONE_RECOG=1   # default (on)
      LOKI_REUSE_DONE_RECOG=0   # opt out (legacy reuse-then-build behavior)
  No new user-facing CLI flag is added; --fresh-prd / LOKI_PRD_REGEN already
  exist as the rebuild escape hatch and are surfaced in every gate message.
- Because the safe default on any uncertainty is BUILD (the legacy behavior), the
  blast radius of a wrong gate is bounded: worst case it behaves like today.
- After one release of field evidence (proof-of-run + trust metrics show the gate
  is correctly recognizing done without false-done), drop the env gate to
  hard-on (keep `=0` opt-out for one more release, then remove).

---

## 11. Risks and mitigations

- R1 (highest, requirement 2): a genuinely-done project the user WANTS to extend.
  Mitigation: the done message's final line names BOTH escape hatches
  (`--fresh-prd` to rebuild, edit/pass a new spec to extend). The gate only
  fires on a NO-PRD reuse run; the moment the user supplies a changed/new PRD,
  the user-PRD path (found_prd at 15159, or persist_user_prd) takes precedence
  and the gate's reuse arming does not apply.
- R2 false-done (fake-green): mitigated by re-running tests NOW
  (ensure_completion_test_evidence) and DOWNGRADING any model `done` that the
  fresh test-results.json or an `unmet`/`uncertain` requirement contradicts. The
  positive verdict is never sourced from a stale artifact.
- R3 false-incomplete (rebuilds something already done): bounded -- worst case is
  today's behavior (it rebuilds). The incremental manifest only ever REDUCES
  work; if the model is unsure it marks `uncertain` (not satisfied) and that
  requirement is rebuilt. No regression vs status quo.
- R4 model cost on every reuse run: the negative fast-path skips the call
  entirely on projects with no completion footprint (the common case for a fresh
  reuse that is clearly not done is rare; the common reuse over a built project
  pays one bounded call). Timeout-bounded (LOKI_DONE_RECOG_TIMEOUT). On non-
  claude/degraded providers the call is skipped (inconclusive -> build).
- R5 manifest/PRD identity drift: manifest is guarded by `prd_sha`; a mismatch is
  ignored and a full build runs. Keying on feature title (not positional
  prd-NNN) avoids index-shift misskips.
- R6 finalization ordering: the gate runs after load_state and before the
  delegate-branch/start-sha block, so a done verdict never spawns a delegate
  branch or moves the diff window. Verify final line placement at edit time
  against the live ordering of 15238 (load_state), the delegate block (~15259),
  and 15439 (populate_prd_queue).

---

## 12. Files touched (for the eventual implementation, not this doc)

- autonomy/lib/done-recognition.sh (NEW): `_loki_done_recog_invoke`,
  `_loki_done_recog_provider_ok`, `reuse_done_recognition_gate`, payload/parse
  python heredocs. Mirrors autonomy/lib/prd-enrich.sh.
- autonomy/run.sh:
  - new call site after ~15319 (source the lib like 14931-14937; arm the gate per
    section 3 guard).
  - populate_prd_queue (14580): one manifest read-point + per-feature skip near
    14878 (section 6.2).
  - reuse the existing finalization functions (3367, 3516, 1653, 13190, 17692)
    and completion-summary writer `build_completion_summary` (3026, which writes
    3196-3210) on the done path -- no new completion code.
- tests/test-reuse-done-recognition.sh (NEW).
- scripts/local-ci.sh: register the new test.
- CHANGELOG.md + version-bump locations: per the repo's standard bump list (see
  the prior reuse design's section 9 for the canonical 14-location list).
- Docs: a short note in the no-PRD reuse documentation that a reuse run now
  verifies whether the project is already done and stops fast if so.

---

## 13. Divergences from the prior design (loki-plan/v7734-prd-reuse-design.md)

That doc designed the reuse/update/generate DECISION and the codebase signature.
It is now implemented (decide_generated_prd_action at run.sh:5590). This plan
builds the next layer ON TOP of its `reuse` outcome:
- The prior doc's `reuse` ends at "point prd_path at the generated PRD and run."
  This plan inserts the done-recognition gate between that and the queue/loop.
- The prior doc relied on a deterministic signature to decide reuse-vs-update.
  This plan deliberately does NOT add any deterministic done-shortcut; the
  done/incomplete TRUST decision is the model's, grounded in re-run tests + code,
  precisely because the signature/checklist artifacts proved untrustworthy as a
  done signal (the 14-vs-19 checklist desync in the live bug). The signature
  still does its job (reuse-vs-update); the new gate adds the satisfied-or-not
  judgment the signature was never meant to make.
