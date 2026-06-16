# Testing

## Mandatory Testing Rules

1. Write tests FIRST. Commit the test before writing implementation.
2. Tests must call REAL functions with REAL inputs and assert REAL outputs.
3. Mock ONLY external dependencies: HTTP APIs, databases, file system, third-party services.
4. NEVER mock internal modules, utility functions, or any code that is part of this project.
5. NEVER change a test's expected value to make it pass. If a test fails, the implementation is wrong. Fix the code, not the test.
6. If you believe a test expectation is incorrect, document WHY and flag for council review. Do not silently change it.
7. Every test file must have at least one assertion per tested function.

Gate 5 (mock integrity detector) and Gate 6 (mutation detector) enforce rules 3-5 automatically.
Violations result in automatic FAIL during VERIFY phase.

---

## E2E Testing with Playwright MCP

**Use Playwright MCP for browser-based testing.**

```python
# E2E test after feature implementation
Task(
    subagent_type="general-purpose",
    model="sonnet",
    description="Run E2E tests for auth flow",
    prompt="""Use Playwright MCP to test:
    1. Navigate to /login
    2. Fill email and password fields
    3. Click submit button
    4. Verify redirect to /dashboard
    5. Check user name appears in header

    Use accessibility tree refs, not coordinates."""
)
```

**Best Practices:**
- Use accessibility tree refs instead of coordinates
- Test critical user flows after each feature
- Capture screenshots for error states
- Run after unit tests, before deployment

---

## Property-Based Testing (Kiro Pattern)

**Auto-generate edge case tests from specifications.**

```yaml
property_based_testing:
  purpose: "Verify code meets spec constraints with hundreds of random inputs"
  tools: "fast-check (JS/TS), hypothesis (Python), QuickCheck (Haskell)"

  extract_properties_from:
    - OpenAPI schema: "minLength, maxLength, pattern, enum, minimum, maximum"
    - Business rules: "requirements.md invariants"
    - Data models: "TypeScript interfaces, DB constraints"

  examples:
    - "email field always matches email regex"
    - "price is never negative"
    - "created_at <= updated_at always"
    - "array length never exceeds maxItems"
```

**When to use:**
- After implementing API endpoints (validate against OpenAPI)
- After data model changes (validate invariants)
- Before deployment (edge case regression)

---

## Event-Driven Hooks (Kiro Pattern)

**Trigger quality checks on file operations, not just at phase boundaries.**

```yaml
hooks_system:
  location: "autonomy/hooks/"

  triggers:
    on_file_write:
      - lint: "npx eslint --fix {file}"
      - typecheck: "npx tsc --noEmit"
      - secrets_scan: "detect-secrets scan {file}"

    on_task_complete:
      - contract_test: "npm run test:contract"
      - spec_lint: "spectral lint .loki/specs/openapi.yaml"

    on_phase_complete:
      - memory_consolidate: "Extract patterns to semantic memory"
      - metrics_update: "Log efficiency scores"
      - checkpoint: "git commit with phase summary"
```

**Benefits:**
- Catches issues 5-10x earlier than phase-end review
- Reduces rework cycles
- Aligns with Constitutional AI (continuous self-critique)

---

## Visual Design Input

**When given design mockups or screenshots:**

1. **Discovery Phase:** Extract visual requirements from mockups
2. **Development Phase:** Implement UI matching design specs
3. **QA Phase:** Visual regression testing with Playwright screenshots
4. **Verification:** Compare screenshots against original designs

```python
# Capture screenshot for comparison
Task(
    model="sonnet",
    description="Visual regression test",
    prompt="""Use Playwright MCP to:
    1. Navigate to implemented feature
    2. Capture screenshot
    3. Compare against design mockup at designs/feature.png
    4. Report visual differences"""
)
```

---

## Test Strategy by Phase

| Phase | Test Type | Tool |
|-------|-----------|------|
| Development | Unit tests | Haiku (parallel) |
| Development | Integration tests | Sonnet |
| QA | E2E tests | Playwright MCP |
| QA | Property-based tests | fast-check/hypothesis |
| Pre-deployment | Full regression | All of above |

---

## Review-to-Memory Learning

**Pipe code review findings into semantic memory to prevent repeat mistakes.**

```yaml
review_learning:
  trigger: "After every code review cycle"

  workflow:
    1. Complete 3-reviewer blind review
    2. Aggregate findings by severity
    3. For each Critical/High/Medium finding:
       - Extract pattern description
       - Document prevention strategy
       - Save to .loki/memory/semantic/anti-patterns/
    4. Link to episodic memory for traceability

  output_format:
    pattern: "Using any instead of proper TypeScript types"
    category: "type-safety"
    severity: "high"
    prevention: "Always define explicit interfaces for API responses"
```
