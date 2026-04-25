# build_prompt() Function Analysis

**Phase 4 Research Deliverable B2**
**Repository:** loki-mode  
**Date:** 2025-04-25  
**Scope:** Bash-to-TypeScript/Bun migration parity verification

## 1. Function Location and Size

| Metric | Value |
|--------|-------|
| File | autonomy/run.sh |
| Start Line | 8912 |
| End Line | 9382 |
| Total Lines of Code | 471 |
| Blank/Comment Lines | ~92 |
| Executable Statements | ~379 |

## 2. Function Signature

```bash
build_prompt() {
    local retry="$1"      # retry count (0 = first attempt, 1+ = resume)
    local prd="$2"        # path to PRD file (optional, empty string if no PRD)
    local iteration="$3"  # current iteration number (1-indexed)
}
```

**Parameters:**
- `$1 (retry)`: Integer, 0-based retry/resume counter. Triggers resume-specific context injection.
- `$2 (prd)`: File path string (relative or absolute) to PRD markdown file, or empty string for codebase-analysis mode.
- `$3 (iteration)`: Integer iteration counter (typically 1 on first run, increments on each cycle).

**Returns:** Outputs to stdout. No return value; function uses `echo` and `printf`.

## 3. Environment Variables Read

| Variable | Source | Default | Used Where | Meaning |
|----------|--------|---------|------------|---------|
| `PHASE_UNIT_TESTS` | External (run.sh bootstrap) | "false" | Line 8919 | Enable UNIT_TESTS in SDLC phases list |
| `PHASE_API_TESTS` | External | "false" | Line 8920 | Enable API_TESTS in SDLC phases list |
| `PHASE_E2E_TESTS` | External | "false" | Line 8921 | Enable E2E_TESTS in SDLC phases list |
| `PHASE_SECURITY` | External | "false" | Line 8922 | Enable SECURITY in SDLC phases list |
| `PHASE_INTEGRATION` | External | "false" | Line 8923 | Enable INTEGRATION in SDLC phases list |
| `PHASE_CODE_REVIEW` | External | "false" | Line 8924 | Enable CODE_REVIEW in SDLC phases list |
| `PHASE_WEB_RESEARCH` | External | "false" | Line 8925 | Enable WEB_RESEARCH in SDLC phases list |
| `PHASE_PERFORMANCE` | External | "false" | Line 8926 | Enable PERFORMANCE in SDLC phases list |
| `PHASE_ACCESSIBILITY` | External | "false" | Line 8927 | Enable ACCESSIBILITY in SDLC phases list |
| `PHASE_REGRESSION` | External | "false" | Line 8928 | Enable REGRESSION in SDLC phases list |
| `PHASE_UAT` | External | "false" | Line 8929 | Enable UAT in SDLC phases list |
| `MAX_PARALLEL_AGENTS` | External (bootstrap, line 547) | 10 | Line 8933 (RARV instruction) | Max concurrent agents limit in RALPH WIGGUM MODE |
| `COMPLETION_PROMISE` | External (bootstrap) | "" | Lines 8941-8945 | Promise text shown when PRD complete; drives completion instruction |
| `AUTONOMY_MODE` | External | "" | Line 8949 | String value; if "perpetual" triggers perpetual mode suffix |
| `PERPETUAL_MODE` | External | "false" | Line 8949 | Boolean; if "true" triggers perpetual mode suffix |
| `LOKI_HUMAN_INPUT` | External (from .loki/HUMAN_INPUT.md or CLI) | "" | Line 9030 | Human directive string; injected at priority level |
| `LOKI_LEGACY_PROMPT_ORDERING` | External | "false" | Line 9250 | If "true", use pre-v6.82.0 dynamic-first ordering (legacy path) |
| `PROVIDER_DEGRADED` | External (bootstrap, line 770) | "false" | Lines 9252, 9304 | If "true", use simplified degraded-provider prompt format |
| `TARGET_DIR` | External (bootstrap, defaults to ".") | "." | Lines 9008, 9010, 9221, 9321 | Base directory for .loki/ state files |
| `ITERATION_COUNT` | External (from run_autonomous loop, used in context functions) | N/A | Used by context functions like `load_startup_learnings()` | Current iteration number (for context retrieval) |
| `PROJECT_DIR` | External (bootstrap) | N/A | Line 9371 (_LOKI_PROJECT_DIR env var) | Project root directory for memory system |

## 4. Input Files from .loki/ Directory

| File Path | Format | Variable Assigned To | Line | Condition | Truncation |
|-----------|--------|----------------------|------|-----------|------------|
| `.loki/CONTINUITY.md` | Markdown | Referenced in RARV instruction | 8933 | Always | Mentioned but not read by build_prompt() itself |
| `.loki/state/relevant-learnings.json` | JSON | Referenced in RARV instruction | 8933 | Always | Mentioned but not read by build_prompt() itself |
| `.loki/state/resources.json` | JSON | Referenced in RARV instruction | 8933 | Always | Mentioned but not read by build_prompt() itself |
| `.loki/SKILL.md` | Markdown | Referenced in sdlc_instruction | 8956 | Always | Referenced but not read |
| `.loki/skills/` | Directory | Referenced in sdlc_instruction | 8956 | Always | Referenced but not read |
| `.loki/quality/gate-failures.txt` | Plain text | `gate_failure_context` | 9010 | If file exists | Full file read, ~N/A |
| `.loki/quality/static-analysis.json` | JSON | Parsed for summary | 9012 | If gate-failures.txt exists | Python extracts 'summary' field |
| `.loki/quality/test-results.json` | JSON | Parsed for summary | 9017 | If gate-failures.txt exists | Python extracts 'summary' field |
| `.loki/checklist/checklist.json` | JSON | Check for existence | 9049 | If no PRD checklist exists | Not read; just checked for file existence |
| `.loki/checklist/verification-results.json` | JSON | `checklist_status` | 9052 | If exists and checklist_summary function available | Via checklist_summary() function |
| `.loki/app-runner/state.json` | JSON | `app_runner_info` | 9061 | If file exists | Python reads and formats status line |
| `.loki/verification/playwright-results.json` | JSON | `playwright_info` | 9077 | If file exists | Python reads and formats test results |
| `.loki/bmad-metadata.json` | JSON | Check for existence | 9095 | If file exists | Not directly read; presence check |
| `.loki/bmad-architecture-summary.md` | Markdown | `bmad_arch` | 9097 | If bmad-metadata.json exists | `head -c 16000` (16 KB limit) |
| `.loki/bmad-tasks.json` | JSON | `bmad_tasks` | 9101 | If bmad-metadata.json exists | Python parses, truncates to 32 KB if needed |
| `.loki/bmad-validation.md` | Markdown | `bmad_validation` | 9117 | If bmad-metadata.json exists | `head -c 8000` (8 KB limit) |
| `.loki/mirofish-context.json` | JSON | `mirofish_context` | 9157 | If file exists | Python parses and formats advisory summary |
| `.loki/mirofish/pipeline-state.json` | JSON | `mirofish_context` | 9186 | If mirofish-context.json not found | Python checks status and progress |
| `.loki/openspec/delta-context.json` | JSON | `openspec_context` | 9134 | If file exists | Python parses deltas for added/modified/removed reqs |
| `.loki/magic/specs` | Directory | Count and list specs | 9221 | If directory exists | `find` counts .md files; max spec names list |
| `.loki/memory/ledgers/LEDGER-*.md` | Markdown (newest) | Via `load_ledger_context()` | 9130 | If retry > 0 | `head -100` lines (100 line limit) |
| `.loki/memory/handoffs/*.json` or *.md | JSON/Markdown (newest) | Via `load_handoff_context()` | 9230-9265 | If retry > 0 | JSON parsed and formatted; markdown head -80 lines |
| `.loki/state/memory-context.json` | JSON | Via `load_startup_learnings()` | 8283 | If iteration == 1 | Python parses memory_count and top 5 memories |
| `.loki/memory/index.json` | JSON | Existence check for memory system | 9365 | Always | Via `retrieve_memory_context()` function |
| `.loki/queue/in-progress.json` | JSON | Via `load_queue_tasks()` | 9036 | If file exists | Python extracts first 3 tasks |
| `.loki/queue/pending.json` | JSON | Via `load_queue_tasks()` | 9036 | If file exists | Python extracts first 3 tasks |
| `.loki/generated-prd.md` | Markdown | Referenced in resume message | 9366 | If no $prd provided on resume | Mentioned but not read by build_prompt() |

## 5. Queue Input Format and Aggregation

**Source Functions:** `load_queue_tasks()` (lines 8823-8906)

**Files read:**
- `.loki/queue/in-progress.json` (checked first, highest priority)
- `.loki/queue/pending.json` (fallback)

**JSON Format Accepted (2 variants):**

```json
[
  {
    "id": "unique-id",
    "type": "task_type",
    "source": "prd" or "api" or other,
    "title": "Human-readable title",
    "description": "Longer description",
    "acceptance_criteria": ["criterion1", "criterion2"],
    "user_story": "As a... I want... So that...",
    "payload": { "action": "..." }
  }
]
```

or (alternative format):

```json
{
  "tasks": [
    { ... same task objects ... }
  ]
}
```

**Aggregation Logic:**
- Limits extraction to first 3 tasks (line 8841)
- Detects source: if `source=="prd"` or `id` starts with "prd-", uses rich format (title, description[:300 chars], acceptance criteria[:5], user_story)
- Otherwise uses legacy format (extracts `type`, `payload.action` or `payload.goal`, truncates to 500 chars)
- Removes newlines, normalizes whitespace
- Outputs as `IN-PROGRESS TASKS (EXECUTE THESE):\n...` followed by `PENDING:\n...`

**Injected Variable:** `queue_tasks` (line 9036 via `load_queue_tasks()`)

**Output Location in Prompt:** Line 9371, conditional printf if `queue_tasks` is non-empty

## 6. Prompt Structure (Ordered Sections)

The prompt is assembled in **two phases** (cache-aware, v6.82.0+):

### Phase 1: STATIC PREFIX (cache-stable, lines 9346-9357)

These sections are byte-identical across iterations N and N+1 if PRD and provider are unchanged.

| Section | Variable | Emitted By | Line | Content | Conditional? |
|---------|----------|------------|------|---------|---|
| `<loki_system>` tag | N/A | `printf '<loki_system>\n'` | 9346 | XML-style wrapper open | No |
| PRD anchor | `prd_anchor` | `printf '%s\n'` | 9347 | "Loki Mode" or "Loki Mode with PRD at {path}" | Depends on `$prd` |
| RARV instruction | `rarv_instruction` | `printf '%s\n'` | 9348 | "RALPH WIGGUM MODE..." (278+ chars, includes MAX_PARALLEL_AGENTS interpolation) | No (always present) |
| SDLC instruction | `sdlc_instruction` | `printf '%s\n'` | 9349 | "SDLC_PHASES_ENABLED: [comma-list]..." | No (always present) |
| Autonomy suffix | `autonomous_suffix` | `printf '%s\n'` | 9350 | Either perpetual-mode rules or standard rules, depends on `AUTONOMY_MODE` / `PERPETUAL_MODE` | Yes (conditional on mode) |
| Memory instruction | `memory_instruction` | `printf '%s\n'` | 9351 | "MEMORY_SYSTEM: Relevant context..." | No (always present) |
| Analysis instruction | `analysis_instruction` | `printf '%s\n'` | 9355 | "CODEBASE_ANALYSIS_MODE: No PRD..." | Yes, only if `$prd` is empty |
| `</loki_system>` tag | N/A | `printf '</loki_system>\n'` | 9357 | XML-style wrapper close | No |
| Cache breakpoint marker | N/A | `printf '[CACHE_BREAKPOINT]\n'` | 9358 | Literal `[CACHE_BREAKPOINT]` on single line | No |

### Phase 2: DYNAMIC CONTEXT (volatile, changes per iteration, lines 9361-9381)

Wrapped in `<dynamic_context iteration="..." retry="...">` tags.

| Section | Variable | Emitted By | Line | Content | Conditional? |
|---------|----------|------------|------|---------|---|
| `<dynamic_context>` tag | N/A | `printf '<dynamic_context iteration="%s" retry="%s">\n'` | 9361 | Attributes: iteration number, retry count | No |
| Resume context | N/A | `printf 'Resume iteration #%s...'` | 9364-9366 | "Resume iteration #N (retry #M). PRD: ..." or "... Use .loki/generated-prd.md if exists." | Yes, only if `$retry > 0` |
| Human directive | `human_directive` | `[ -n "$human_directive" ] && printf ...` | 9369 | "HUMAN_DIRECTIVE (PRIORITY): {content}" | Yes, if LOKI_HUMAN_INPUT set |
| Gate failure context | `gate_failure_context` | `[ -n "$gate_failure_context" ] && printf ...` | 9370 | "QUALITY_GATE_FAILURES FROM PREVIOUS ITERATION: [...]" | Yes, if .loki/quality/gate-failures.txt exists |
| Queue tasks | `queue_tasks` | `[ -n "$queue_tasks" ] && printf ...` | 9371 | "QUEUED_TASKS (PRIORITY): ..." | Yes, if queue files exist |
| BMAD context | `bmad_context` | `[ -n "$bmad_context" ] && printf ...` | 9372 | "BMAD_CONTEXT: ..." with architecture, tasks, validation | Yes, if .loki/bmad-metadata.json exists |
| OpenSpec context | `openspec_context` | `[ -n "$openspec_context" ] && printf ...` | 9373 | "OPENSPEC DELTA CONTEXT: ADDED/MODIFIED/REMOVED [...]" | Yes, if .loki/openspec/delta-context.json exists |
| MiroFish context | `mirofish_context` | `[ -n "$mirofish_context" ] && printf ...` | 9374 | Market validation results or status | Yes, if mirofish files exist |
| Magic Modules context | `magic_context` | `[ -n "$magic_context" ] && printf ...` | 9375 | Component spec list and instructions | Yes, if .loki/magic/specs/ exists |
| Checklist status | `checklist_status` | `[ -n "$checklist_status" ] && printf ...` | 9376 | "PRD_CHECKLIST_INIT:" or "PRD_CHECKLIST_STATUS: ..." | Yes, conditional on checklist state |
| App runner info | `app_runner_info` | `[ -n "$app_runner_info" ] && printf ...` | 9377 | "APP_RUNNING_AT: ..." or "APP_CRASHED: ..." | Yes, if .loki/app-runner/state.json exists |
| Playwright info | `playwright_info` | `[ -n "$playwright_info" ] && printf ...` | 9378 | "PLAYWRIGHT_SMOKE_TEST: PASSED/FAILED" | Yes, if .loki/verification/playwright-results.json exists |
| Memory context section | `memory_context_section` | `[ -n "$memory_context_section" ] && printf ...` | 9379 | "CONTEXT: {ledger|handoff|startup_learnings|retrieved_memory}" | Yes, if context was loaded |
| Completion instruction | `completion_instruction` | `printf '%s\n'` | 9380 | "COMPLETION_PROMISE: ..." or "NO COMPLETION_PROMISE SET..." | No (always present) |
| `</dynamic_context>` tag | N/A | `printf '</dynamic_context>\n'` | 9381 | XML-style wrapper close | No |

## 7. Variable Substitutions in Heredocs/Printf Blocks

All variable substitution happens in bash string interpolation BEFORE printf outputs. Single `%s` format specifiers in printf receive already-expanded variables. Variable substitution points:

| Variable | Expansion Point | Bash Location | Notes |
|----------|-----------------|---------------|----|
| `$iteration` | Build phase (line 8915) | Throughout SDLC phases loop, rarv_instruction, completion_instruction | Integer; used in completion_instruction (line 8944: "Iteration $iteration of max $MAX_ITERATIONS") |
| `$retry` | Build phase | Used in printf format string (line 9361) and completion_instruction branching | Integer; condition at line 9362 |
| `$prd` | Build phase | Used to determine prd_anchor (line 9338-9339) and in printf format (line 9364) | Pathname; expanded before any output |
| `$phases` | Built from PHASE_* variables | Concatenated string with commas, trailing comma removed (line 8930) | Used in sdlc_instruction (line 8956, no explicit var but embedded in string line 8956) |
| `${MAX_PARALLEL_AGENTS}` | Bootstrap (line 547) | Embedded in rarv_instruction string (line 8933) | Integer; substring interpolation in bash |
| `${COMPLETION_PROMISE}` | Bootstrap | Embedded in completion_instruction at lines 8942, 8944 | Conditional: if set, user-provided completion text; if not, generic instruction |
| `${LOKI_HUMAN_INPUT:-}` | External | Conditional check at line 9030; embedded in human_directive string if set | String; empty default if not set |
| `${TARGET_DIR:-.}` | Bootstrap (default ".") | Used in file existence checks (lines 9008, 9010, 9221, 9321) | Pathname; used in file I/O not direct output |

**Key Parity Hazard:** All variable substitutions happen in bash BEFORE string variables are passed to printf. There is NO template literal substitution happening inside the printf blocks themselves -- all `$VAR` and `${VAR:-default}` are resolved to bash values before the printf command executes. This is critical for TS port: all variables must be resolved in the TS layer before assembling the prompt string.

## 8. Output Destination

**Primary:** stdout via `printf` and `echo` statements (lines 9315-9381)

**Captured By Caller:** Line 10352 in run_autonomous loop:
```bash
prompt=$(build_prompt "$retry" "$prd_path" "$ITERATION_COUNT")
```

The prompt output is captured into the `prompt` variable and subsequently passed to the AI provider invocation (line 10371+). The function itself produces no file output; all I/O is stdout.

**No Side Effects on .loki/ files:** build_prompt() is read-only. It does NOT:
- Write to .loki/ files
- Create directories
- Log to files (references logging functions but does not call them)
- Modify state files

## 9. Side Effects

**Zero persistent side effects.** build_prompt() is a pure prompt-assembly function.

- Does NOT write .loki/ files
- Does NOT call mkdir
- Does NOT log to .loki/logs/ (references .loki/logs/ in SDLC instruction text but does not invoke logging)
- Does NOT call git commands
- Read-only access to .loki/ files and external env vars

**Functions called (read-only):**
- `load_ledger_context()` (line 8968): Reads .loki/memory/ledgers/, returns string or empty
- `load_handoff_context()` (line 8970): Reads .loki/memory/handoffs/, returns string or empty
- `load_startup_learnings()` (line 8984): Reads .loki/state/memory-context.json, returns string or empty
- `retrieve_memory_context()` (line 9001): Calls Python to read .loki/memory/index.json, returns string or empty
- `load_queue_tasks()` (line 9036): Reads .loki/queue/*.json, returns string or empty

All are read-only wrappers.

## 10. Prompt Length Analysis

**Typical prompt structure (dynamic-first ordering, PRD mode, iteration 5):**

### Static Prefix (cache-stable, constant across iterations):
- `<loki_system>` wrapper: 30 bytes
- prd_anchor: ~40 bytes ("Loki Mode with PRD at path/to/prd.md")
- RARV instruction: ~3,800 bytes (RALPH WIGGUM MODE... full cycle instructions)
- SDLC instruction: ~300 bytes (phases list varies)
- Autonomy suffix: ~800-1000 bytes (depends on AUTONOMY_MODE)
- Memory instruction: ~400 bytes
- Analysis instruction: 0 (only if no PRD)
- Wrapper close + cache marker: 50 bytes
- **Subtotal: ~5,400-5,600 bytes**

### Dynamic Context (volatile, per-iteration):
- `<dynamic_context>` tag: 40 bytes
- Resume context (if retry > 0): ~100 bytes
- Human directive (if present): 0-500 bytes
- Gate failure context (if present): 500-2000 bytes
- Queue tasks (if present): 500-2000 bytes (3 tasks max)
- BMAD context (if present): 100-16000 bytes (16 KB arch limit + 32 KB tasks limit)
- OpenSpec context (if present): 500-3000 bytes
- MiroFish context (if present): 200-1000 bytes
- Magic Modules context (if present): 200-500 bytes
- Checklist status (if present): 200-1000 bytes
- App runner info (if present): 50-200 bytes
- Playwright info (if present): 50-200 bytes
- Memory context section (if present): 500-3000 bytes
- Completion instruction: ~600 bytes
- Wrapper close: 20 bytes
- **Subtotal: ~1,500-30,000 bytes (depends on context availability)**

**Total Typical Range:** 6,900-35,600 bytes (all contexts present) / ~7,000 bytes (minimal)

**Token Estimate (claude-3.5-sonnet):** 
- ~1.3 tokens per 4 bytes (UTF-8 ASCII)
- Minimal: ~1,800 tokens
- Maximal: ~9,200 tokens (with all contexts)
- Typical (iteration 5, some contexts): ~4,000-6,000 tokens

**Truncation Points:**
- BMAD architecture: `head -c 16000` (line 9098)
- BMAD tasks JSON: Python truncates to 32 KB if needed (lines 9108-9111)
- BMAD validation: `head -c 8000` (line 9118)
- Ledger context: `head -100` lines (line 9133)
- Handoff context (markdown): `head -80` lines (line 9262)
- Startup learnings: top 5 memories (line 8341)
- Queue task description: 300 chars (line 8854)
- Queue task criteria: first 5 (line 8860)
- Queue task action (legacy): 500 chars (line 8878)
- MiroFish concerns: first 5 (line 8171)
- MiroFish rankings: first 5 (line 8174)
- MiroFish quotes: first 3 (line 8178)

No hard token limit is enforced by build_prompt() itself; the orchestrator may truncate the final prompt before sending to provider.

---

## Appendix: Variable Cross-Reference

| Bash Variable | Source | Assigned At | Used In | Notes |
|---------------|--------|-------------|---------|-------|
| `retry` | Parameter $1 | Line 8913 | Lines 8966, 9362, 9361 | Retry count; triggers context loading |
| `prd` | Parameter $2 | Line 8914 | Lines 8994, 9254, 9338, 9364 | PRD path or empty string |
| `iteration` | Parameter $3 | Line 8915 | Lines 8944, 9000, 9361 | Iteration counter |
| `phases` | Concatenated from PHASE_* | Line 8918-8930 | Line 8956 (via sdlc_instruction) | SDLC phase list |
| `rarv_instruction` | Hardcoded template | Line 8933 | Line 9348 | RALPH WIGGUM instructions |
| `completion_instruction` | Conditionally built | Lines 8940-8945 | Line 9380 | Completion rules (promise-based or max-iteration-based) |
| `autonomous_suffix` | Conditionally built | Lines 8948-8953 | Line 9350 | Perpetual vs. standard autonomy rules |
| `sdlc_instruction` | Hardcoded template | Line 8956 | Line 9349 | SDLC phase execution instructions |
| `analysis_instruction` | Hardcoded template | Line 8959 | Line 9355 | Codebase analysis mode (if no PRD) |
| `memory_instruction` | Hardcoded template | Line 8962 | Line 9351 | Memory system instructions |
| `context_injection` | Conditional builds | Lines 8965-9004 | Line 9044 (wrapped in memory_context_section) | Aggregated context from ledger/handoff/startup/retrieved |
| `gate_failure_context` | Conditionally built | Lines 9007-9023 | Line 9370 | Quality gate failures from previous iteration |
| `human_directive` | Conditional extraction | Lines 9025-9032 | Line 9369 | Human input from LOKI_HUMAN_INPUT or .loki/HUMAN_INPUT.md |
| `queue_tasks` | Function call `load_queue_tasks()` | Line 9036 | Line 9371 | Queued tasks from .loki/queue/*.json |
| `memory_context_section` | Conditional wrapper | Lines 9041-9045 | Line 9379 | Formatted context_injection (if non-empty) |
| `checklist_status` | Conditional builds | Lines 9047-9057 | Line 9376 | PRD checklist init or verification status |
| `app_runner_info` | Conditional Python extraction | Lines 9060-9073 | Line 9377 | App runner state (running/crashed) |
| `playwright_info` | Conditional Python extraction | Lines 9075-9091 | Line 9378 | Playwright smoke test results |
| `bmad_context` | Conditional builds | Lines 9093-9130 | Line 9372 | BMAD architecture/tasks/validation context |
| `openspec_context` | Conditional Python extraction | Lines 9132-9153 | Line 9373 | OpenSpec delta context |
| `mirofish_context` | Conditional Python extraction | Lines 9155-9217 | Line 9374 | MiroFish market validation results |
| `magic_context` | Conditionally built | Lines 9219-9232 | Line 9375 | Magic Modules specs and instructions |
| `prd_anchor` | Conditional build | Lines 9337-9342 | Line 9347 | Prompt header identifying mode and PRD |
| `ledger` | Function call `load_ledger_context()` | Line 8968 | Line 8973 (into context_injection) | Ledger content from most recent LEDGER-*.md |
| `handoff` | Function call `load_handoff_context()` | Line 8970 | Line 8976 (into context_injection) | Handoff content from recent .json or .md |
| `startup_learnings` | Function call `load_startup_learnings()` | Line 8984 | Line 8986 (into context_injection) | Pre-loaded memories from CLI startup |
| `memory_context` | Function call `retrieve_memory_context()` | Line 9001 | Line 9003 (into context_injection) | Retrieved memories from memory system |

