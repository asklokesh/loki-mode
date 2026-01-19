# Artifact Generation & Code Transformation

## Artifact Generation (Antigravity Pattern)

**Auto-generate verifiable deliverables for audit trail without human intervention.**

```yaml
artifact_generation:
  purpose: "Prove autonomous work without line-by-line code review"
  location: ".loki/artifacts/{date}/{phase}/"

  triggers:
    on_phase_complete:
      - verification_report: "Summary of tests passed, coverage, static analysis"
      - architecture_diff: "Mermaid diagram showing changes from previous state"
      - decision_log: "Key decisions made with rationale (from CONTINUITY.md)"

    on_feature_complete:
      - screenshot: "Key UI states captured via Playwright"
      - api_diff: "OpenAPI spec changes highlighted"
      - test_summary: "Unit, integration, E2E results"

    on_deployment:
      - release_notes: "Auto-generated from commit history"
      - rollback_plan: "Steps to revert if issues detected"
      - monitoring_baseline: "Expected metrics post-deploy"
```

---

## Artifact Types

### Verification Report
```yaml
format: "markdown"
contents:
  - Phase name and duration
  - Tasks completed (from queue)
  - Quality gate results (7 gates)
  - Coverage metrics
  - Known issues / TODOs
```

### Architecture Diff
```yaml
format: "mermaid diagram"
contents:
  - Components added/modified/removed
  - Dependency changes
  - Data flow changes
```

### Screenshot Gallery
```yaml
format: "png + markdown index"
capture:
  - Critical user flows
  - Error states
  - Before/after comparisons
```

**Why artifacts matter for autonomous operation:**
- Creates audit trail without human during execution
- Enables async human review if needed later
- Proves work quality through outcomes, not code inspection
- Aligns with "outcome verification" over "line-by-line auditing"

---

## Code Transformation Agent (Amazon Q Pattern)

**Dedicated workflows for legacy modernization - narrow scope, deterministic verification.**

```yaml
transformation_agent:
  purpose: "Autonomous code migration without human intervention"
  trigger: "/transform or PRD mentions migration/upgrade/modernization"

  workflows:
    language_upgrade:
      steps:
        1. Analyze current version and dependencies
        2. Identify deprecated APIs and breaking changes
        3. Generate migration plan with risk assessment
        4. Apply transformations incrementally
        5. Run compatibility tests after each change
        6. Validate performance benchmarks
      examples:
        - "Java 8 to Java 21"
        - "Python 2 to Python 3"
        - "Node 16 to Node 22"

    database_migration:
      steps:
        1. Schema diff analysis (source vs target)
        2. SQL dialect conversion rules
        3. Data type mapping
        4. Generate migration scripts
        5. Run verification queries
        6. Validate data integrity
      examples:
        - "Oracle to PostgreSQL"
        - "MySQL to PostgreSQL"
        - "MongoDB to PostgreSQL"

    framework_modernization:
      steps:
        1. Dependency audit and compatibility matrix
        2. Breaking change detection
        3. Code pattern updates (deprecated -> modern)
        4. Test suite adaptation
        5. Performance regression testing
      examples:
        - "Angular to React"
        - ".NET Framework to .NET Core"
        - "Express to Fastify"

  success_criteria:
    - All existing tests pass
    - No regression in performance (< 5% degradation)
    - Static analysis clean
    - API compatibility maintained (or documented breaks)
```

**Why this fits autonomous operation:**
- Narrow scope with clear boundaries
- Deterministic success criteria (tests pass, benchmarks met)
- No subjective judgment required
- High value, repetitive tasks

---

## Code-Only Agent Pattern (rijnard.com)

**Enforce execution through code, creating verifiable "code witnesses".**

```yaml
code_only_principle:
  benefit: "Produces executable, verifiable behavior traces"

  patterns:
    - Return small outputs (<1KB) inline
    - Write large results to JSON files with path references
    - Use dynamic languages (Python, TypeScript) for native runtime injection

  enforcement:
    - Tool PreHooks to catch banned operations
    - Initial prompting toward code-generation patterns
```

**Key Insight:** LLM outputs should be executable code, not prose descriptions. This creates an auditable trace of what actually happened.

---

## Release Notes Generation

**Auto-generate from commit history:**

```bash
# Generate release notes from git commits
git log --oneline v2.0.0..HEAD | \
  grep -E "^[a-f0-9]+ (feat|fix|perf|refactor):" | \
  sed 's/^[a-f0-9]* /- /'
```

```yaml
release_notes_template:
  sections:
    - "## New Features" (feat: commits)
    - "## Bug Fixes" (fix: commits)
    - "## Performance" (perf: commits)
    - "## Breaking Changes" (BREAKING: in commit body)
    - "## Migration Guide" (if breaking changes)
```
