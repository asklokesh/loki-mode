# Advanced Patterns

## Problem Classification with Expert Hints (OptiMind Pattern)

**Classify problems before solving. Apply domain-specific expert hints.**

```yaml
problem_classification:
  categories:
    crud_operations:
      hints:
        - "Check for existing similar endpoints before creating new"
        - "Ensure proper input validation and error handling"
        - "Follow RESTful conventions for HTTP methods"
      common_errors:
        - "Missing input validation"
        - "Inconsistent error response format"

    authentication:
      hints:
        - "Never store plain text passwords"
        - "Use established libraries (bcrypt, argon2)"
        - "Implement rate limiting on auth endpoints"
      common_errors:
        - "Token expiration not handled"
        - "Missing CSRF protection"

    database_operations:
      hints:
        - "Always use parameterized queries"
        - "Consider indexing for frequent queries"
        - "Handle connection pooling"
      common_errors:
        - "N+1 query patterns"
        - "Missing transaction boundaries"

    frontend_components:
      hints:
        - "Consider accessibility from the start"
        - "Handle loading and error states"
        - "Implement proper form validation"
      common_errors:
        - "Missing aria labels"
        - "Unhandled async state"

    infrastructure:
      hints:
        - "Use environment variables for config"
        - "Implement health check endpoints"
        - "Consider horizontal scaling"
      common_errors:
        - "Hardcoded secrets"
        - "Missing graceful shutdown"
```

---

## Ensemble Solution Generation (OptiMind Pattern)

**For complex problems, generate multiple solutions and select by consensus.**

```yaml
ensemble_approach:
  when_to_use:
    - Architecture decisions with multiple valid approaches
    - Performance optimization with unclear bottlenecks
    - Security-sensitive implementations
    - Refactoring with multiple strategies

  workflow:
    1. Generate 3 distinct solutions (different approaches)
    2. Evaluate each against criteria (performance, maintainability, security)
    3. Select by consensus or weighted scoring
    4. Document why alternatives were rejected

  example:
    task: "Implement caching for API responses"
    solutions:
      - Redis with TTL-based invalidation
      - In-memory LRU cache
      - HTTP cache headers + CDN
    selection: "Redis - best for distributed deployment"
    rejected_reasons:
      - "In-memory: doesn't scale horizontally"
      - "CDN: requires infrastructure changes"
```

---

## Formal State Machines (k8s-valkey-operator Pattern)

**Explicit phase transitions with defined states. No ambiguous states.**

```yaml
sdlc_state_machine:
  states:
    - BOOTSTRAP
    - DISCOVERY
    - ARCHITECTURE
    - INFRASTRUCTURE
    - DEVELOPMENT
    - QA
    - DEPLOYMENT
    - GROWTH

  transitions:
    BOOTSTRAP -> DISCOVERY: "Project structure created, dependencies installed"
    DISCOVERY -> ARCHITECTURE: "PRD analyzed, requirements documented"
    ARCHITECTURE -> INFRASTRUCTURE: "System design approved, API spec complete"
    INFRASTRUCTURE -> DEVELOPMENT: "Cloud resources provisioned, DB schema applied"
    DEVELOPMENT -> QA: "All features implemented, unit tests passing"
    QA -> DEPLOYMENT: "All tests passing, security scan clean"
    DEPLOYMENT -> GROWTH: "Production deployed, monitoring active"

  invariants:
    - "Cannot skip phases"
    - "Phase completion requires all quality gates"
    - "Rollback preserves state consistency"

idempotent_operations:
  principle: "All operations safe under retry"
  patterns:
    - "Check state before modifying"
    - "Use upsert instead of insert"
    - "Kubernetes-style reconciliation loops"
```

---

## Constitutional AI Self-Critique (Anthropic)

```yaml
constitution:
  core_principles:
    - "Never sacrifice quality for velocity"
    - "Verify before trusting"
    - "Learn from every failure"
    - "Maintain state consistency"
    - "Protect user data and secrets"

self_critique_workflow:
  1. Generate solution
  2. Critique against principles
  3. Identify violations
  4. Revise to address violations
  5. Re-critique until compliant
```

---

## Debate-Based Verification (DeepMind)

**For critical changes, use structured debate between AI critics.**

```
Proponent (defender)  -->  Presents proposal with evidence
         |
         v
Opponent (challenger) -->  Finds flaws, challenges claims
         |
         v
Synthesizer           -->  Weighs arguments, produces verdict
         |
         v
If disagreement persists --> Escalate to human
```

**Use for:** Architecture decisions, security-sensitive changes, major refactors.

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
