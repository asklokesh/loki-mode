# P0 Verification-Credibility Sweep -- Architecture Plan

Persisted from the Architect (opus). Every line number re-verified by grep.
Goal: make Loki's verification layer honest and real. A hollow wedge is
existential for a "proof of done" product. Fix or remove every false/hollow gate
claim, wire the unwired detectors, make anti-sycophancy act.

## 0. Verified ground truth

- P0-1: enforce_test_coverage() at autonomy/run.sh:7031. `local coverage_pct=0`
  at 7038 is never reassigned; no coverage tool invoked. 7257 emits min_coverage
  (the threshold), not a measured value. Gate decides purely on test_passed.
- P0-2: skills/quality-gates.md:5-17 lists 11 gates; gates 1 (Input Guardrails)
  and 5 (Output Guardrails) have NO gate function. wiki/Quality-Gates.md:14-28
  duplicates. (21 'guardrail' refs in autonomy/ are CLI help/comments/flags.)
- P0-3: tests/detect-mock-problems.sh + tests/detect-test-mutations.sh invoked
  0 times in autonomy/run.sh. quality-gates.md:74-77 claims HIGH=FAIL.
- P0-4: anti-sycophancy block run.sh:8316-8323 only logs + writes
  anti-sycophancy.txt. No Devil's-Advocate re-review. INERT. Bun mirror
  loki-ts/src/runner/quality_gates.ts:804-808 equally inert.
- Gate inventory: phantom (Input/Output Guardrails); wired-but-unlisted
  (run_magic_debate_gate at run.sh:14067); "Gate 10 Backward Compat" is the
  legacy-healing-auditor SPECIALIST (run.sh:7875-7979), conditional, not a loop
  gate; "Gate 6 Severity Blocking" is the block policy inside code review, not a
  function.

### Functions actually invoked in orchestration (run.sh:13938-14084)
enforce_static_analysis (13945); enforce_test_coverage (13967); run_code_review
(13987); run_doc_quality_gate (14058); run_magic_debate_gate (14070); plus
conditional legacy-healing-auditor reviewer.

## 1. Canonical final gate list (THE CONTRACT -- docs transcribe, never recompute)

Honest count after this sweep: 8 gates.

| # | Gate | Function / mechanism | Blocking | Opt-out flag |
|---|------|---------------------|----------|--------------|
| 1 | Static Analysis | enforce_static_analysis (run.sh:6699) | Yes (ladder) | PHASE_STATIC_ANALYSIS=false |
| 2 | Test Suite (pass/fail) | enforce_test_coverage (run.sh:7031) | Yes (red blocks) | PHASE_UNIT_TESTS=false |
| 3 | Blind Code Review (3-reviewer council + severity blocking) | run_code_review (run.sh:7788) | Yes (Crit/High block) | PHASE_CODE_REVIEW=false |
| 4 | Anti-Sycophancy / Devil's Advocate (on unanimous PASS) | run_code_review sub-step (run.sh:8316+) | Yes (DA Crit/High block) | LOKI_GATE_DEVILS_ADVOCATE=false |
| 5 | Mock Integrity Detector | enforce_mock_integrity -> tests/detect-mock-problems.sh | Yes (HIGH blocks) | LOKI_GATE_MOCK=false |
| 6 | Test Mutation Detector | enforce_mutation_integrity -> tests/detect-test-mutations.sh | Yes (HIGH blocks) | LOKI_GATE_MUTATION=false |
| 7 | Documentation Coverage | run_doc_quality_gate (run.sh:7388) | Yes | LOKI_GATE_DOC_COVERAGE=false |
| 8 | Magic Modules Debate | run_magic_debate_gate (run.sh:7495) | Yes (BLOCK sev) | LOKI_GATE_MAGIC_DEBATE=false |

Conditional auditor (documented separately, NOT numbered): Backward-Compatibility
/ legacy-healing-auditor (healing mode only). Removed: Input/Output Guardrails.

### Doc files to update to "8 gates" (docs owner)
README.md (22,29,196,255); SKILL.md (3,10); CLAUDE.md (44);
plugins/loki-mode/README.md (4); wiki/Quality-Gates.md (14-48);
wiki/Environment-Variables.md (62); wiki/Home.md (3,13); wiki/CLI-Reference.md
(230); docs/cursor-comparison.md (14,177,195); docs/COMPARISON.md (40,210,362);
skills/quality-gates.md (5,13,14-17,19-66,69-82,650,655,668); skills/00-index.md
(51). CHANGELOG.md: NEW top entry ONLY; never rewrite historical entries
(5837/6181/6335/6340).

## 2. P0-1 Coverage honesty (Fix B) -- Slice A (run.sh owner) + Slice B (docs)
- run.sh: remove dead `local coverage_pct=0` (7038). Relabel logs: 13966
  "test suite (pass/fail)"; 7265/7270 "Test suite gate".
- KEEP the min_coverage JSON field at 7257 (consumed by autonomy/loki:27529-27530,
  16138 and asserted in tests/test-report-command.sh:116,
  tests/test-completion-council-affirmative-evidence.sh:126,
  tests/test-evidence-gate.sh:155). Only change misleading consumer strings in
  autonomy/loki (27530, 16138) to "Min coverage TARGET (not measured)".
- docs (skills/quality-gates.md): :13 drop ">80% coverage" -> "coverage % not
  measured in this release"; :650/:655 reword to pass/fail + target-only; :668
  remove coverage.json artifact line. Note Fix A (real measurement) as follow-up.

## 3. P0-2 Phantom guardrails -- Slice B (docs only)
Remove gates 1 & 5 entirely (do not "mark planned"). Renumber to the 8-gate
table. Edit skills/quality-gates.md:5-17, wiki/Quality-Gates.md:14-28, + all
list files in section 1.

## 4. P0-3 Wire detectors -- Slice A (run.sh) + Slice D (scripts) + Slice C (Bun)
Exit-code asymmetry (load-bearing):
- detect-mock-problems.sh exits 1 on CRITICAL/HIGH (179-182), 0 otherwise.
  Exit code already = block-on-HIGH.
- detect-test-mutations.sh exits 0 unless --strict; --strict blocks on ANY
  finding (over-blocks MED/LOW). DO NOT use --strict. Wrapper greps stdout for
  [HIGH] to decide block; route MED/LOW to findings injection.

New run.sh functions (place after run_magic_debate_gate ~7560):
  enforce_mock_integrity()      # HIGH -> return 1; MED/LOW -> findings file
  enforce_mutation_integrity()  # grep -c '\[HIGH\]' >0 -> return 1; MED/LOW -> findings
Both cd "${TARGET_DIR}", use LOKI_GATE_TIMEOUT wrapping, write findings into
${TARGET_DIR}/.loki/quality/ for the Phase-1 findings injector.

Orchestration insert: after the pause-check at 13983, before code-review at
13985. Mirror the existing pattern with track_gate_failure/clear_gate_failure +
gate_failures string. Toggles LOKI_GATE_MOCK / LOKI_GATE_MUTATION (matches
existing LOKI_GATE_DOC_COVERAGE / LOKI_GATE_MAGIC_DEBATE convention).

Detector-script (Slice D): optional --block-high mode on detect-test-mutations.sh
(exit 2 on HIGH) keeping --strict intact; OR rely on wrapper grep (no script
change). Verify detect-mock-problems.sh exit semantics. Do NOT touch run.sh.

## 5. P0-4 Anti-sycophancy acts -- Slice A (run.sh) + Slice C (Bun)
Read run_code_review 7788-8316 first. At 8316-8323 unanimous block: dispatch ONE
Devil's-Advocate reviewer reusing the existing reviewer-invocation +
parse_verdict helpers; if DA returns Crit/High set has_blocking=true so the
EXISTING block at 8326-8330 fires (return 1). Keep anti-sycophancy.txt for audit.
Gate behind LOKI_GATE_DEVILS_ADVOCATE (default true).

## 6. P0-5 Honest per-gate table -- Slice B (docs)
Replace skills/quality-gates.md:5-17 + prose 19-82 with the 8-gate table plus
columns: detects X / does NOT detect Y / opt-out flag / blocking. Honesty
entries: gate 2 "does NOT detect coverage %"; gate 5 "does NOT detect semantic
correctness of mocks"; gate 6 "does NOT detect logically-correct-but-weak
assertions".

## 7. Bash <-> Bun parity matrix
| Change | Bun mirror | File |
|--------|-----------|------|
| P0-1 label/honesty | Yes (light) | quality_gates.ts runTestCoverage (402): no false % strings |
| P0-2 gate count | docs only | -- |
| P0-3 mock gate | Yes | quality_gates.ts: add mock_integrity to GateName (69-74) + runMockIntegrity + sequence (1474-1480) + toggle |
| P0-3 mutation gate | Yes | quality_gates.ts: add mutation_integrity + runMutationIntegrity + sequence + toggle |
| P0-4 devil's advocate | Yes | quality_gates.ts runCodeReview (709), inert at 804-808: add DA dispatch + block |
| P0-5 doc table | docs only | -- |
Bun escalation ladder is generic; new gates inherit once added to union+sequence.

## 8. Slice boundaries (independent; no file collisions)
- Slice A -- run.sh runtime (ONE owner, serialized): P0-1 (run.sh + autonomy/loki
  strings), P0-3 new funcs + orchestration insert, P0-4. Owns autonomy/run.sh +
  autonomy/loki exclusively.
- Slice B -- Docs (ONE owner): P0-2 + P0-5 + all "11->8 gates" edits. Both edit
  skills/quality-gates.md so MUST be one slice. New CHANGELOG entry only.
- Slice C -- Bun parity (ONE owner): loki-ts/src/runner/quality_gates.ts only.
- Slice D -- Detector scripts (ONE owner): tests/detect-test-mutations.sh
  --block-high; verify detect-mock-problems.sh. No run.sh.
- Slice E -- SDET tests (ONE owner; after A/C/D): fixtures + assertions.
Order: D and B parallel anytime; A depends on D contract; C mirrors A; E last.

## 9. Test plan (SDET, Slice E)
- P0-1: grep assert no ">80%"/"min_coverage: 80% # Never drop"/"coverage.json"
  in any list doc. Behavior: passing tests pass, failing tests block.
- P0-2: grep assert zero live "11 gates"/"Input Guardrails"/"Output Guardrails"
  (CHANGELOG excepted); "8" present in quality-gates.md + wiki.
- P0-3 mock: fixture with tautological assertion -> enforce_mock_integrity
  returns 1, BLOCKS, track_gate_failure increments. Clean -> 0, clears. MED-only
  -> 0 + findings file.
- P0-3 mutation: fixture commit changing assertion values + impl (HIGH) ->
  returns 1, BLOCKS. MED-only -> 0 + findings (proves not over-blocking).
- P0-4: unanimous PASS + DA High -> run_code_review returns 1. Unanimous PASS +
  DA clean -> 0 + anti-sycophancy.txt exists.
- Parity: Bun sequence includes mock_integrity + mutation_integrity; runCodeReview
  blocks on DA High; existing loki-ts tests green.

## 10. Risks + binding constraints
Risks: (1) min_coverage JSON field has live consumers + 3 test assertions -- keep
field, fix strings only. (2) mutation --strict over-blocks -- parse HIGH instead.
(3) detectors run against TARGET project test files -- cd TARGET_DIR + timeout
wrap. (4) stale cross-file comment line refs exist; do not chase, do not add new.

Binding constraints (every dev agent): NO version bumps (integrator once); NO
commits/push; NO emojis; NO em dashes; full gate applies (touches runtime/gates/
parity); stay inside your slice file ownership; run.sh is single-owner.

Canonical count decision: 8 (recommended). Keeping backward-compat numbered
would make it 9 but reintroduces the listed-but-not-a-loop-gate honesty gap this
sweep exists to close.
