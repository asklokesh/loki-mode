# BMAD Integration -- Epic and Story Breakdown

**Date:** 2026-02-25
**Scope:** Epic 1 only (P0 -- BMAD Artifact Pipeline)
**Version Target:** v6.1.0

Epics 2 (Engine Embedding) and 3 (Voice Agent Layer) are documented as future work
but explicitly deferred pending P0 value validation.

---

## Epic 1: BMAD Artifact Pipeline (P0 -- Must Have)

**Goal:** Enable Loki Mode to consume BMAD Method output artifacts as structured input,
producing higher-quality analysis scores and richer execution context than freeform PRDs.

**Success Metric:** `loki start --bmad-project <path>` discovers, parses, and loads BMAD
artifacts with zero regression on existing non-BMAD workflows.

---

### Story 1.1: BMAD PRD Format Adapter

**Size:** M
**Dependencies:** None
**Files to create:** `autonomy/bmad-adapter.py`

**Description:**
Create a standalone Python module (stdlib only) that discovers BMAD output artifacts,
parses their YAML frontmatter, normalizes heading structure, extracts project classification
metadata, and produces a normalized PRD document suitable for prd-analyzer.py.

**Acceptance Criteria:**

- **Given** a directory containing `_bmad-output/planning-artifacts/prd-*.md`
  **When** bmad-adapter.py is invoked with the project path
  **Then** it discovers the PRD file automatically

- **Given** a BMAD PRD with YAML frontmatter (`stepsCompleted`, `inputDocuments`, `workflowType`)
  **When** the adapter parses it
  **Then** frontmatter is extracted as metadata and stripped from the document body

- **Given** a BMAD PRD with sections like `## Executive Summary`, `## Project Classification`
  **When** the adapter normalizes headings
  **Then** sections are preserved as-is (no destructive remapping)

- **Given** a BMAD project with `architecture.md` alongside the PRD
  **When** the adapter runs
  **Then** architecture content is appended as supplementary context

- **Given** a BMAD project with `epics.md`
  **When** the adapter runs
  **Then** epic/story data is extracted into a structured task list (JSON)

- **Given** a non-BMAD project directory (no `_bmad-output/`)
  **When** the adapter is invoked
  **Then** it exits with a clear error message and non-zero exit code

- **Given** a BMAD project with incomplete workflow state (`stepsCompleted` missing entries)
  **When** the adapter runs
  **Then** it warns about incomplete artifacts but processes what exists

---

### Story 1.2: Enhanced PRD Analyzer for BMAD Documents

**Size:** S
**Dependencies:** Story 1.1 (adapter output format)
**Files to modify:** `autonomy/prd-analyzer.py`

**Description:**
Add BMAD-specific heading patterns and content patterns to the existing dimension system.
Add an optional `--architecture` flag to score an architecture document alongside the PRD.
Maintain full backward compatibility with freeform PRDs.

**Acceptance Criteria:**

- **Given** a BMAD PRD with `## Executive Summary`
  **When** prd-analyzer.py scores it
  **Then** the section is recognized (new heading pattern in `feature_list` or new dimension)

- **Given** a BMAD PRD with `## Functional Requirements` containing `FR1:` items
  **When** prd-analyzer.py scores it
  **Then** `feature_list` dimension scores HIGH

- **Given** a BMAD PRD with `## Non-Functional Requirements` > `### Security`, `### Performance`
  **When** prd-analyzer.py scores it
  **Then** `security` and `deployment` dimensions score at least PARTIAL

- **Given** the `--architecture path/to/architecture.md` flag
  **When** prd-analyzer.py runs
  **Then** tech_stack, data_model, and api_spec dimensions are also scored from architecture.md

- **Given** a freeform PRD (no BMAD structure)
  **When** prd-analyzer.py scores it
  **Then** results are identical to the current version (zero regression)

- **Given** a BMAD PRD and a freeform PRD of equivalent completeness
  **When** both are scored
  **Then** BMAD PRD scores equal or higher (structured methodology bonus not required but allowed)

---

### Story 1.3: `--bmad-project` CLI Flag

**Size:** M
**Dependencies:** Story 1.1 (adapter), Story 1.2 (enhanced analyzer)
**Files to modify:** `autonomy/loki`, `autonomy/run.sh`

**Description:**
Add a `--bmad-project <path>` flag to `loki start`. When provided, the CLI runs
bmad-adapter.py to discover and parse BMAD artifacts, then feeds the normalized output
into the standard PRD analysis pipeline. BMAD context (architecture decisions, epic list)
is injected into build_prompt() as a supplementary context block.

**Acceptance Criteria:**

- **Given** `loki start --bmad-project ./my-project`
  **When** `./my-project/_bmad-output/` exists with BMAD artifacts
  **Then** artifacts are discovered, parsed, and loaded into `.loki/` state

- **Given** `loki start --bmad-project ./my-project`
  **When** `./my-project/_bmad-output/` does NOT exist
  **Then** CLI prints error and exits with non-zero code

- **Given** BMAD artifacts are loaded
  **When** build_prompt() constructs the iteration prompt
  **Then** a `BMAD_CONTEXT` block is injected with architecture summary and active epic

- **Given** BMAD epics are loaded
  **When** the task queue is populated
  **Then** each BMAD story becomes a `.loki/queue/` task with priority and acceptance criteria

- **Given** `loki start ./prd.md` (no --bmad-project flag)
  **When** the CLI runs
  **Then** behavior is identical to current version (zero regression)

- **Given** `loki start --bmad-project ./my-project --prd ./override.md`
  **When** both flags are provided
  **Then** the explicit PRD takes precedence; BMAD artifacts provide supplementary context only

- **Given** the `--bmad-project` flag
  **When** `loki help start` is run
  **Then** the flag appears in help text with usage description

---

### Story 1.4: BMAD Artifact Chain Validator

**Size:** S
**Dependencies:** Story 1.1 (adapter)
**Files to create:** Validation logic within `autonomy/bmad-adapter.py`

**Description:**
Validate that BMAD artifacts form a consistent chain: product-brief references are
reflected in PRD, PRD requirements trace to architecture decisions, architecture maps
to epics. Report consistency gaps as warnings (not blockers).

**Acceptance Criteria:**

- **Given** a BMAD project with product-brief, PRD, architecture, and epics
  **When** the validator runs
  **Then** it checks that PRD references product-brief themes

- **Given** a BMAD PRD with 20 Functional Requirements and epics.md
  **When** the validator runs
  **Then** it reports how many FRs are covered by at least one epic story

- **Given** a BMAD project missing architecture.md
  **When** the validator runs
  **Then** it warns about the missing artifact but does not block processing

- **Given** an inconsistency (FR in PRD with no matching story in epics)
  **When** the validator runs
  **Then** the gap is reported as a warning in the adapter output

---

### Story 1.5: BMAD Integration Tests

**Size:** M
**Dependencies:** Stories 1.1-1.4
**Files to create:** `tests/test-bmad-integration.sh`, `tests/fixtures/bmad/`

**Description:**
Comprehensive test suite covering BMAD adapter parsing, analyzer scoring, CLI flag
behavior, artifact chain validation, and backward compatibility. Test fixtures created
from BMAD's own templates populated with realistic data.

**Acceptance Criteria:**

- **Given** test fixtures in `tests/fixtures/bmad/` with realistic BMAD output
  **When** `bash tests/test-bmad-integration.sh` runs
  **Then** all tests pass with zero failures

- **Given** a fixture with a well-formed BMAD PRD
  **When** the adapter and analyzer are run on it
  **Then** quality score is >= 7.0/10

- **Given** a fixture with a freeform PRD (non-BMAD)
  **When** the analyzer scores it before and after the Story 1.2 changes
  **Then** scores are identical (backward compatibility)

- **Given** a fixture with malformed BMAD artifacts (missing frontmatter, partial steps)
  **When** the adapter processes it
  **Then** it handles gracefully with warnings, no crashes

- **Given** a fixture with incomplete artifact chain (PRD but no architecture)
  **When** the adapter and validator run
  **Then** processing succeeds with chain-gap warnings

- **Given** the `--bmad-project` CLI flag
  **When** tested against fixtures
  **Then** discovery, loading, and prompt injection all work correctly

- **Given** the test suite
  **When** run after any code change
  **Then** execution completes in under 30 seconds

---

## Epic 2: BMAD Engine Embedding (P1 -- Deferred)

**Goal:** Programmatically execute BMAD step-file workflows within Loki Mode, enabling
interactive requirements elicitation without requiring a separate BMAD-aware LLM session.

**Status:** Deferred. Requires P0 success validation first.

### Planned Stories (not detailed)

- Story 2.1: BMAD agent YAML parser
- Story 2.2: Step-file processor (execute BMAD workflows programmatically)
- Story 2.3: Session state manager (track step progress, partial artifacts)
- Story 2.4: Dashboard "Elicitation" panel
- Story 2.5: Party Mode adapter (multi-agent collaboration)

---

## Epic 3: Voice Agent Layer (P2 -- Deferred)

**Goal:** Transform voice.sh from simple transcription to a structured dialogue system
that can facilitate BMAD requirements elicitation conversations.

**Status:** Deferred. Highest risk. Requires both P0 and P1 success validation.

### Planned Stories (not detailed)

- Story 3.1: Structured dialogue manager
- Story 3.2: BMAD step-to-voice mapper
- Story 3.3: Technical term correction loop
- Story 3.4: Voice session persistence
- Story 3.5: Dual-mode interface (voice for elicitation, visual for review)

---

## Dependency Graph

```
Story 1.1 (Adapter) -----> Story 1.2 (Analyzer Enhancement)
     |                           |
     |                           v
     +---> Story 1.4 (Validator) ---> Story 1.3 (CLI Flag)
                                           |
                                           v
                                      Story 1.5 (Tests)
```

Stories 1.1 and 1.2 can be developed in parallel.
Story 1.3 depends on both 1.1 and 1.2.
Story 1.4 is part of 1.1 but can be developed in parallel.
Story 1.5 depends on all other stories but fixture creation can start immediately.
