# Phase 5 Research: Completion Council Inventory

**File:** `autonomy/completion-council.sh`  
**Lines of Code:** 1771  
**Functions:** 19  
**Date:** 2026-04-25

## 1. Complete Function Inventory

| Function | Line Range | Purpose |
|----------|-----------|---------|
| `council_augment_from_managed_memory()` | 84–105 | Retrieve prior completion verdicts from managed memory store for context augmentation |
| `council_init()` | 111–145 | Initialize council state directory, JSON state file, and tracking variables |
| `council_track_iteration()` | 151–240 | Track code convergence (git diff hash), agent done signals, and populate convergence.log |
| `council_circuit_breaker_triggered()` | 246–264 | Detect stagnation (no changes >= limit) or repeated done signals (>= 2) |
| `council_vote()` | 270–477 | Orchestrate voting of all COUNCIL_SIZE members (v1 path); invoke severity budget; anti-sycophancy check |
| `council_gather_evidence()` | 483–622 | Compile markdown evidence file: PRD, git status, test results, queue status, build state, checklist verification |
| `council_reverify_checklist()` | 629–634 | Re-run checklist verification before evaluation (calls checklist_verify if available) |
| `council_checklist_gate()` | 642–732 | Hard gate: block completion if critical checklist items failing (reads verification-results.json, waivers.json) |
| `council_member_review()` | 738–860 | Invoke AI provider (claude -p, codex, gemini, cline, aider) with role-specific prompt; strip convergence data if LOKI_BLIND_VALIDATION=true |
| `council_devils_advocate()` | 866–944 | Anti-sycophancy voter: invoked when unanimous APPROVE detected; intentionally finds reasons to reject |
| `council_heuristic_review()` | 950–1013 | Fallback evaluation when no AI provider available; checks test results, PRD, TODO density |
| `council_evaluate_member()` | 1028–1124 | Core heuristic evaluation: check test failures, code convergence, error logs, role-specific checks; returns COMPLETE or CONTINUE |
| `council_aggregate_votes()` | 1137–1221 | Poll all COUNCIL_SIZE members via council_evaluate_member(); compute 2/3 ceiling threshold; write round-N.json |
| `council_devils_advocate_review()` | 1236–1327 | Skeptical re-evaluation when unanimous COMPLETE: check test logs, failed queue, TODO density, uncommitted changes, error events |
| `council_evaluate()` | 1340–1385 | Unified pipeline: reverify checklist → hard gate check → aggregate votes → if unanimous, run devil's advocate → return verdict |
| `council_managed_should_stop()` | 1405–1599 | v7.0.0 Phase 4: invoke providers.managed.run_completion_council multiagent session; project AgentVerdicts to legacy verdict files |
| `council_should_stop()` | 1605–1708 | Main entry point: check enabled/min iterations → circuit breaker → scheduling → council_evaluate → write COMPLETED marker → write report |
| `council_write_report()` | 1714–1752 | Write final markdown report to council/report.md with convergence data, config, vote history |
| `council_get_dashboard_state()` | 1758–1771 | Return JSON fragment for dashboard-state.json exposing council enabled/size/threshold/signals |

## 2. The Completion-Decision Pipeline

**Order of function calls from `council_should_stop()` (lines 1605–1708):**

```
council_should_stop() [line 1605]
  ├─ Check COUNCIL_ENABLED [line 1606]
  ├─ Check ITERATION_COUNT >= COUNCIL_MIN_ITERATIONS [line 1611]
  ├─ Optional: council_managed_should_stop() [line 1622]
  │  └─ (Only if LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true)
  ├─ council_augment_from_managed_memory() [line 1630]
  │  └─ (Silent no-op unless both managed flags on)
  ├─ council_circuit_breaker_triggered() [line 1634]
  ├─ Scheduling gate: circuit_triggered OR (ITERATION_COUNT % COUNCIL_CHECK_INTERVAL == 0) [line 1642]
  ├─ council_evaluate() [line 1651]
  │  ├─ council_reverify_checklist() [line 1348]
  │  ├─ council_checklist_gate() [line 1351]
  │  ├─ council_aggregate_votes() [line 1358]
  │  │  └─ For each of COUNCIL_SIZE members:
  │  │     └─ council_evaluate_member(role) [line 1155]
  │  ├─ If aggregate returns COMPLETE and unanimous:
  │  │  └─ council_devils_advocate_review() [line 1372]
  │  └─ Return verdict: 0 (COMPLETE) or 1 (CONTINUE)
  ├─ council_write_report() [line 1660]
  ├─ Shadow-write managed memory verdict [line 1676] (background job &)
  └─ Return 0 (STOP) or 1 (CONTINUE)
```

## 3. The Three Voter Agents

### 3.1 Requirements Verifier

**Invocation (council_member_review, line 738):**
```bash
# Provider: claude CLI (default PROVIDER_NAME)
# Model: PROVIDER_MODEL_FAST (default: haiku)
# Call: echo "$prompt" | claude --model "$council_model" -p 2>/dev/null
```
**Prompt Template (lines 774–775):**
```
"You are the REQUIREMENTS VERIFIER. Check if every requirement from the PRD has been 
implemented. Look for missing features, incomplete implementations, and unmet acceptance 
criteria. Be thorough - check code structure, not just claims."
```
**Input Evidence:** PRD (first 100 lines), git status, recent commits, test results, queue status, build state, convergence data (if not blind-validated).  
**Output Parse:** Extract `VOTE:APPROVE|REJECT|CANNOT_VALIDATE`, `REASON:`, `ISSUES: SEVERITY:description`

### 3.2 Test Auditor

**Invocation (council_member_review, line 738):**
```bash
# Provider: claude CLI
# Model: PROVIDER_MODEL_FAST (default: haiku)
# Call: echo "$prompt" | claude --model "$council_model" -p 2>/dev/null
```
**Prompt Template (lines 777–778):**
```
"You are the TEST AUDITOR. Verify that adequate tests exist and pass. Check test 
coverage, edge cases, error handling. Look at test results and build output. A project 
without passing tests is NOT complete."
```
**Input Evidence:** Same as requirements_verifier.  
**Output Parse:** Same format.

### 3.3 Devil's Advocate

**Two invocation paths:**

**Path 1: Anti-sycophancy (council_devils_advocate, line 866)** - Called when unanimous APPROVE at `council_vote()` line 407:
```bash
# Provider: claude CLI
# Model: PROVIDER_MODEL_FAST (default: haiku)
# Call: echo "$prompt" | claude --model "$council_model" -p 2>/dev/null
```
**Prompt Template (lines 885–904):**
```
"ANTI-SYCOPHANCY CHECK: All council members unanimously APPROVED this project.
Your job is to be the CONTRARIAN. Find ANY reason this should NOT be approved.
[evidence]
Look for: missing functionality, tests not actually passing, TODO/FIXME comments, 
inadequate docs, untested edge cases. Output VOTE:APPROVE or VOTE:REJECT"
```

**Path 2: Skeptical re-evaluation (council_devils_advocate_review, line 1236)** - Called when unanimous COMPLETE at `council_evaluate()` line 1372:
```bash
# Heuristic-based checks, NOT AI invocation
# Checks: test logs pass indicator, failed queue, TODO/FIXME density, uncommitted changes, error events
```
**Prompt Template:** None (heuristic only).

## 4. Severity Budget: Computation and Thresholds

**Where computed:** `council_vote()`, lines 332–383 (per-member severity filtering).

**Thresholds and Budget Variables:**
- `COUNCIL_SEVERITY_THRESHOLD` (env var): "critical", "high", "medium", or "low" (line 354)
- `COUNCIL_ERROR_BUDGET` (env var, float 0.0–1.0): ratio of non-blocking issues tolerated (line 366)

**Computation Logic (lines 326–383):**
```bash
if [ "$vote_result" = "REJECT" ] && [ "$COUNCIL_SEVERITY_THRESHOLD" != "low" ]; then
  # For each issue line in member_issues:
  for sev in $severity_order; do
    if [ "$sev" = "$issue_severity" ] && threshold not yet reached:
      has_blocking_issue=true
      break
    if [ "$sev" = "$COUNCIL_SEVERITY_THRESHOLD" ]:
      threshold_reached=true
  done
  
  # Apply error budget: if no blocking issues, check ratio
  if [ "$has_blocking_issue" = "false" ]; then
    ratio = non_blocking_count / total_issue_count
    if ratio > COUNCIL_ERROR_BUDGET:
      budget_exceeded=true
      vote_result stays REJECT
    else:
      vote_result = APPROVE (override)
```

**Severity Order:** critical > high > medium > low (line 336)

**Budget Default:** COUNCIL_ERROR_BUDGET typically 0.3 or 0.0 (disables budget if 0).

## 5. Unanimous + Devil's Advocate Override Logic

**Source:** `council_vote()` lines 406–422 (v1 anti-sycophancy) and `council_evaluate()` lines 1369–1377 (v7 managed).

**Pseudo-code:**

```
FUNCTION council_vote():
  # Step 1: Collect votes
  FOR each member in council:
    vote = council_member_review(member)
    IF vote == APPROVE:
      approve_count++
    ELSE:
      reject_count++
  
  # Step 2: Anti-sycophancy gate (v1 bash path)
  IF approve_count == COUNCIL_SIZE AND COUNCIL_SIZE >= 2:
    log_warn("Unanimous approval detected - anti-sycophancy check")
    contrarian_verdict = council_devils_advocate(evidence_file)
    contrarian_vote = parse(contrarian_verdict, "VOTE:")
    
    IF contrarian_vote == REJECT OR CANNOT_VALIDATE:
      log_warn("Anti-sycophancy: Devil's advocate overrode unanimous approval")
      approve_count = approve_count - 1
      reject_count = reject_count + 1
    ELSE:
      log_info("Anti-sycophancy: Devil's advocate confirmed approval")
  
  # Step 3: Tally
  threshold = ceiling(COUNCIL_SIZE * 2 / 3)
  IF approve_count >= threshold:
    RETURN APPROVED
  ELSE:
    RETURN REJECTED

FUNCTION council_evaluate():
  # Step 1: Aggregate
  aggregate_result = council_aggregate_votes()
  
  # Step 2: If unanimous COMPLETE (v7 variant)
  IF aggregate_result == COMPLETE:
    complete_count = extract from round-N.json
    IF complete_count == COUNCIL_SIZE AND COUNCIL_SIZE >= 2:
      da_result = council_devils_advocate_review(round)
      IF da_result == OVERRIDE_CONTINUE:
        log_warn("Devil's advocate overrode unanimous COMPLETE")
        RETURN 1 (CONTINUE)
    RETURN 0 (COMPLETE)
  ELSE:
    RETURN 1 (CONTINUE)
```

## 6. Files Written

**Directory Structure:** `.loki/council/` and `.loki/quality/reviews/`

| File | Format | Written By | Line | Purpose |
|------|--------|-----------|------|---------|
| `.loki/council/state.json` | JSON | `council_init()` | 129 | Council metadata: initialized, enabled, vote tallies, verdicts array |
| `.loki/council/convergence.log` | TSV (5 cols) | `council_track_iteration()` | 215 | timestamp\|iteration\|files_changed\|consecutive_no_change\|done_signals |
| `.loki/council/votes/iteration-N/evidence.md` | Markdown | `council_gather_evidence()` | 487 | PRD, git state, test results, queue, build, checklist, playwright, hard gate status |
| `.loki/council/votes/iteration-N/member-M.txt` | Text | `council_member_review()` | 821 | Raw voter output: VOTE:, REASON:, ISSUES: lines |
| `.loki/council/votes/contrarian.txt` | Text | `council_devils_advocate()` | 942 | Anti-sycophancy voter output: VOTE: REJECT or APPROVE |
| `.loki/council/votes/devils-advocate-round-N.json` | JSON | `council_devils_advocate_review()` | 1305 | Skeptical check result: round, issues_found, details, override boolean |
| `.loki/council/votes/round-N.json` | JSON | `council_aggregate_votes()` | 1192 | Round tally: complete_votes, continue_votes, threshold, verdict, votes array |
| `.loki/council/gate-block.json` | JSON | `council_checklist_gate()` | 697 | Hard gate block status: blocked, iteration, failures array (created if critical checklist items fail) |
| `.loki/council/report.md` | Markdown | `council_write_report()` | 1717 | Final council report: date, iteration, verdict, convergence, config, vote history |
| `.loki/COMPLETED` | Text | `council_should_stop()` | 1657 | Marker file written when council approves completion: "Council approved at iteration N on ISO8601" |
| `.loki/managed/council-augment.txt` | Text | `council_augment_from_managed_memory()` | 91 | Retrieved prior verdict context from managed memory (if LOKI_MANAGED_MEMORY=true) |
| `.loki/managed/completion-council-round-N.json` | JSON | `council_managed_should_stop()` | 1572 | Sidecar: managed run summary (session_id, elapsed_ms, partial, majority, voters array) |

## 7. Files Read

| File | Read By | Line | Purpose |
|------|---------|------|---------|
| `.loki/generated-prd.md` | `council_gather_evidence()` | 496 | PRD fallback if `COUNCIL_PRD_PATH` not provided |
| `.loki/logs/test-*.log` | `council_gather_evidence()` | 522 | Test result logs (last 20 lines extracted) |
| `.loki/logs/*test*.log` | `council_gather_evidence()` | 522 | Test result logs (pattern match) |
| `test-results.json` | `council_gather_evidence()` | 531 | Test results (last 20 lines) |
| `.loki/checklist/verification-results.json` | `council_checklist_gate()` | 660 | Checklist verification results (status, categories, items with priority/status) |
| `.loki/checklist/waivers.json` | `council_checklist_gate()` | 668 | Waiver list to exclude critical failures (item_id, active) |
| `.loki/checklist/checklist.json` | `council_reverify_checklist()` | 630 | Checklist schema (triggers re-verification) |
| `.loki/queue/pending.json` | `council_evaluate_member()` | 1086 | Pending task count (requires_verifier check) |
| `.loki/queue/failed.json` | `council_devils_advocate_review()` | 1263 | Failed task count (for skeptical re-evaluation) |
| `.loki/verification/playwright-results.json` | `council_gather_evidence()` | 597 | Playwright smoke test results (passed, checks, errors) |
| `.loki/quality/test-results.json` | `council_managed_should_stop()` | 1428 | Test summary for managed council context |
| `package.json` / `requirements.txt` / `Cargo.toml` / `go.mod` | `council_gather_evidence()` | 563–577 | Project type detection (Node, Python, Rust, Go) |
| `git status`, `git diff`, `git log` | Multiple | 507–514, 165–173 | Git repository state, diffs, history |
| `.loki/events.jsonl` | `council_devils_advocate_review()` | 1289 | Recent error events (tail -50, grep error count) |

## 8. Background Jobs and Parallel Dispatch

**Background jobs spawned with `&`:**

1. **Managed memory shadow-write (council_should_stop, lines 1673–1680):**
   ```bash
   (
     cd "${PROJECT_DIR:-.}" && \
     LOKI_TARGET_DIR="$loki_dir/.." \
     timeout 15 python3 -m memory.managed_memory.shadow_write \
       --verdict "$_verdict_file" >/dev/null 2>&1 || true
   ) &
   disown 2>/dev/null || true
   ```
   **Purpose:** Persist final council verdict to managed memory store for future augmentation.  
   **Timeout:** 15 seconds.  
   **Silent:** Errors suppressed.

**No other background jobs detected.** Council member invocations are **sequential** (line 307: `while [ $member -le $COUNCIL_SIZE ]`). AI provider calls block waiting for response (lines 828, 911, etc.).

**Exception:** `council_aggregate_votes()` (line 1137) uses heuristic-based `council_evaluate_member()` which is fast (no AI), so all member evaluations complete synchronously before threshold computed.

## 9. State Machine: Stages of `council_should_stop()`

**Six distinct stages with state transitions:**

```
┌──────────────────────────────────────────────────────────────┐
│ PREPARING (lines 1606–1613)                                  │
│ ├─ Check: COUNCIL_ENABLED == true                            │
│ ├─ Check: ITERATION_COUNT >= COUNCIL_MIN_ITERATIONS          │
│ └─ State: If either check fails → return 1 (CONTINUE)        │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ DISPATCHING (lines 1621–1648)                                │
│ ├─ Call: council_managed_should_stop() if flag enabled       │
│ │  └─ Fallback silently on ManagedUnavailable                │
│ ├─ Call: council_augment_from_managed_memory()               │
│ ├─ Call: council_circuit_breaker_triggered()                 │
│ ├─ Scheduling gate: circuit_triggered OR                     │
│ │         (ITERATION_COUNT % COUNCIL_CHECK_INTERVAL == 0)    │
│ └─ State: If should_check != true → return 1 (CONTINUE)      │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ AWAITING_VERDICTS (line 1651)                                │
│ └─ Call: council_evaluate()                                  │
│    ├─ Phase 1: council_reverify_checklist()                  │
│    ├─ Phase 2: council_checklist_gate()                      │
│    │  └─ If gate blocks → return 1 (CONTINUE)               │
│    ├─ Phase 3: council_aggregate_votes()                     │
│    └─ (Awaiting all member verdicts...)                      │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ AGGREGATING (lines 1358–1367 in council_evaluate)            │
│ ├─ Extract: complete_count from round-N.json                 │
│ ├─ Threshold: ceiling(COUNCIL_SIZE * 2 / 3)                 │
│ └─ Verdict: COMPLETE if complete_count >= threshold else ... │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ DECIDING (lines 1369–1384 in council_evaluate)               │
│ ├─ If verdict != COMPLETE:                                   │
│ │  └─ Return 1 (CONTINUE) → loop again                       │
│ ├─ If verdict == COMPLETE AND unanimous:                     │
│ │  ├─ Call: council_devils_advocate_review()                 │
│ │  ├─ If overridden → Return 1 (CONTINUE)                    │
│ │  └─ Else → Return 0 (COMPLETE)                             │
│ └─ If verdict == COMPLETE AND NOT unanimous:                 │
│    └─ Return 0 (COMPLETE)                                    │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│ WRITING (lines 1652–1681)                                    │
│ ├─ Write: .loki/COMPLETED marker                             │
│ ├─ Call: council_write_report()                              │
│ │  └─ Writes: .loki/council/report.md                        │
│ ├─ Bg job: Shadow-write verdict to managed memory (timeout 15s) │
│ └─ Log: "COMPLETION COUNCIL: PROJECT APPROVED"               │
└──────────────────────────────────────────────────────────────┘
                           ↓
                    Return 0 (STOP)

      OR (Safety valve, lines 1687–1707)

                    Return 0 (FORCE STOP) if:
                    - Circuit breaker triggered AND
                      consecutive_no_change >= 2x limit
                    - OR total_done_signals >= limit
```

**State Variables Updated Throughout:**
- Line 178–182: `COUNCIL_CONSECUTIVE_NO_CHANGE` (convergence tracking)
- Line 195–200: `COUNCIL_DONE_SIGNALS` (agent completion claims)
- Line 232–238: `state.json` (persistent council state)

---

**Blind Validation:** If `LOKI_BLIND_VALIDATION=true` (default), evidence passed to voters strips convergence/iteration context (lines 763–767) to prevent bias.

**Hard Gate:** Blocks completion regardless of votes if critical checklist items fail (lines 1350–1354), unless waived (lines 668–674).

**Safety Valves:** Two circuit breakers prevent infinite loops (lines 1691–1705):
1. If stagnation exceeds 2x limit → force stop
2. If done signals exceed limit → force stop

