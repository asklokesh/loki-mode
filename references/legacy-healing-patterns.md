# Legacy Healing Patterns Reference

## Sources (Validated)

Every pattern in this document is traced to a specific source. If a pattern is our synthesis (not directly from a paper), it is marked as such.

| # | Source | Year | Key Contribution |
|---|--------|------|-----------------|
| 1 | Michael Feathers, *Working Effectively with Legacy Code* | 2004 | Characterization tests, seams, dependency-breaking |
| 2 | Martin Fowler, Strangler Fig Application | 2004 | Incremental replacement via facade |
| 3 | Eric Evans, *Domain-Driven Design* Ch.14 | 2003 | Anti-Corruption Layer |
| 4 | Amazon AGI Lab, "How Agentic AI Helps Heal Systems" | 2026 | Friction-as-semantics, RL gyms, agents as universal API |
| 5 | arXiv:2602.22518, RepoMod-Bench | 2026 | System-boundary testing for behavioral equivalence |
| 6 | arXiv:2602.04341, Model-Driven Modernization | 2026 | Observability + contract tests for conformance |
| 7 | arXiv:2506.02290, HEC | 2025 | Equivalence verification via equality saturation |
| 8 | arXiv:2502.12466, EquiBench | 2025 | LLM code equivalence reasoning benchmarks |
| 9 | arXiv:2510.18509, VAPU | 2025 | Multi-agent pipeline for autonomous legacy updates |
| 10 | arXiv:2504.11335, Code Reborn | 2025 | COBOL-to-Java AI-driven, 93% accuracy |
| 11 | arXiv:2501.19204, Multi-Agent Web App Upgrades | 2025 | Autonomous legacy web application upgrades |
| 12 | AWS Transform | 2025-2026 | Decomposition agents, semantic seeding, 1.1B LOC analyzed |
| 13 | GitHub Copilot Legacy Systems | 2025 | 3-agent pattern: extract, test, rewrite |
| 14 | Mark Seemann, Empirical Characterization Testing | 2025 | Falsifiable experiment pattern for characterization |
| 15 | arXiv:2511.04427v2 | 2025 | Velocity-quality tradeoff (807 repos studied) |
| 16 | ThoughtWorks, Strangler Fig Guide | 2025 | Practical implementation steps |

---

## 1. Characterization Testing (Feathers, 2004)

### The Core Technique

Michael Feathers defines a characterization test as "a test you write to understand the behavior of the system." It captures WHAT the code does, not what it SHOULD do.

### Feathers' Recipe

```
1. Use a piece of code in a test harness
2. Write an assertion that you KNOW will fail
3. Let the failure tell you what the actual behavior is
4. Change the test so it expects the behavior the code produces
5. The test now documents actual behavior
```

### Why "Write a failing assertion" Matters (Seemann, 2025)

Mark Seemann's empirical characterization testing (2025) explains: writing a failing test is a falsifiable experiment. If you write an assertion you EXPECT to pass, you might write a tautology. The failing assertion forces you to discover what the code actually does.

### Characterization vs Unit Tests

| Aspect | Characterization Test | Unit Test |
|--------|---------------------|-----------|
| **Verifies** | What code DOES | What code SHOULD do |
| **Written** | After code exists | Before code exists (TDD) |
| **When they differ** | Characterization wins during healing | Unit test wins in new development |
| **Purpose** | Change detector | Correctness proof |

### Dependency-Breaking Techniques (Feathers)

Feathers catalogs 24 dependency-breaking techniques. Most relevant for healing:

- **Sprout Method/Class**: Add new behavior in a new method/class, called from the legacy code
- **Wrap Method/Class**: Wrap legacy behavior, adding new behavior before/after
- **Extract and Override**: Extract dependency to a method, override in test subclass
- **Introduce Seam**: Find a place where behavior can be altered without modifying the call site
- **Pinch Point**: A narrow place in the dependency graph where you can intercept behavior

---

## 2. Strangler Fig Pattern (Fowler, 2004)

### Definition

Named after strangler figs that gradually grow around a host tree until they replace it. In software: gradually replace legacy components while both old and new run simultaneously.

### Implementation (ThoughtWorks, 2025)

```
1. Identify system boundaries
   - NOT arbitrary code boundaries
   - Natural business domain boundaries
   - Where the system interfaces with users or other systems

2. Define thin slices
   - Small enough to replace safely
   - Big enough to deliver business value
   - Independent and self-contained where possible

3. Introduce indirection layer (facade/proxy)
   - Routes requests to old or new based on readiness
   - Must NOT become a bottleneck
   - Must NOT be a single point of failure

4. Develop new component
   - Behind the indirection layer
   - With characterization tests from the old component

5. Route traffic
   - Canary: send 5% to new, 95% to old
   - Compare outputs
   - Gradually increase

6. Retire old component
   - Only after new component is verified at 100% traffic

7. Iterate for next slice
```

### Best Practices (ThoughtWorks + AWS)

| Practice | Source | Rationale |
|----------|--------|-----------|
| Start with low-risk components | ThoughtWorks | Build confidence before tackling critical paths |
| Handle shared databases via views/APIs | ThoughtWorks | Direct DB access creates hidden coupling |
| Use feature flags and canary releases | ThoughtWorks | Reversible deployment |
| Maintain a living migration roadmap | ThoughtWorks | Track what's strangled, in-progress, and next |
| Use semantic seeding for decomposition | AWS Transform | Groups code into natural domains automatically |

---

## 3. Anti-Corruption Layer (Evans, DDD 2003)

### Definition

A layer that isolates a new system from a legacy system by translating between their models. Prevents the legacy model from "corrupting" the clean design of the new system.

### Components

```
+-------------------+
|  Modern System    |  Clean domain model
+--------+----------+
         |
+--------v----------+
| Anti-Corruption    |
| Layer              |
|  +-- Facade       |  Simplified interface to legacy
|  +-- Adapter      |  Converts data formats
|  +-- Translator   |  Maps domain concepts
+--------+----------+
         |
+--------v----------+
|  Legacy System    |  Untouched
+-------------------+
```

### Connection to Amazon's "Universal API"

Amazon AGI Lab describes agents that "effectively become a universal API" by managing legacy idiosyncrasies behind the scenes. This IS an anti-corruption layer, but implemented by an AI agent that learns the legacy system's behavior through its UI rather than through hand-coded middleware.

**Key difference:** Traditional ACL is hand-coded and static. Amazon's approach uses AI agents trained on system behavior to create dynamic, adaptive ACLs.

---

## 4. Behavioral Equivalence Verification

### System-Boundary Testing (RepoMod-Bench, arXiv:2602.22518)

**Key insight:** "Software behavior is best verified at the system boundary rather than the unit level."

RepoMod-Bench showed that unit-level testing allows agents to "overfit" to tests. System-boundary testing with implementation-agnostic test suites is the correct approach.

```yaml
system_boundary_testing:
  natural_boundaries:
    - CLI output for a given set of inputs
    - REST API responses for known requests
    - Database state after operations
    - File outputs for batch jobs
    - Message queue payloads

  approach:
    1: "Capture outputs at ALL system boundaries before modernization"
    2: "Store as golden master (behavioral baseline)"
    3: "Run the SAME tests against modernized code"
    4: "Any difference = behavioral change requiring documentation"

  findings:
    small_repos: "91.3% pass rate on projects under 10K LOC"
    large_repos: "15.3% pass rate on projects over 50K LOC"
    implication: "Break large codebases into smaller components before modernizing"
```

### Observability-Based Verification (arXiv:2602.04341)

The Model-Driven Modernization paper uses observability (logs, metrics, traces) and contract tests to verify behavioral and non-functional conformance.

```yaml
observability_verification:
  capture_during_stabilize:
    - "Add structured logging to all critical paths"
    - "Add metrics (response time, error rate, throughput)"
    - "Add distributed tracing"

  verify_after_modernize:
    - "Compare log patterns (same operations should produce same log sequences)"
    - "Compare metrics (response time within 2x, error rate equal or lower)"
    - "Compare traces (same service interactions)"

  contract_tests:
    - "Define contracts at adapter boundaries"
    - "Verify contracts after each modernization step"
    - "Contracts are NOT unit tests -- they verify interface compliance"
```

### Formal Equivalence (Research Stage)

HEC (arXiv:2506.02290) uses e-graphs and equality saturation for formal equivalence checking. EquiBench (arXiv:2502.12466) benchmarks LLM ability to reason about code equivalence.

**Honest assessment:** Formal equivalence verification is research-stage. Loki uses system-boundary testing and observability, not formal verification.

---

## 5. Multi-Agent Modernization Patterns

### AWS Transform Decomposition (2025-2026)

AWS Transform uses specialized AI agents organized by domain:

| Agent Category | Purpose | Loki Equivalent |
|---------------|---------|-----------------|
| **Code Agent** | Analyze types, LOC, complexity, dependencies | Archaeology phase, sonnet |
| **Data Source Agent** | Identify databases, files, configs and their usage | Archaeology phase, sonnet |
| **Decomposition Agent** | Group code into logical domains via semantic seeding | Isolate phase, opus |
| **Refactor Agent** | Transform legacy code to modern language | Modernize phase, sonnet |
| **Reforge Agent** | Optimize refactored code for maintainability | Modernize phase, sonnet |
| **Testing Agent** | Generate test plans from application dependencies | All phases, sonnet |

**Semantic Seeding:** AWS Transform identifies natural domain boundaries by analyzing code semantics, not just syntactic structure. This determines WHERE to place strangler fig boundaries.

### GitHub Copilot 3-Agent Pattern (2025)

GitHub uses three sequential agents for COBOL modernization:

```
Agent 1: Extract business logic from legacy code
    |
    v
Agent 2: Generate characterization tests that validate that logic
    |
    v
Agent 3: Generate modern code that passes those tests
```

**Key insight from Julia Kordick (Microsoft):** She never learned COBOL. She brought AI expertise and worked with domain experts who had decades of knowledge. The agent bridges the knowledge gap.

### VAPU Pipeline (arXiv:2510.18509)

VAPU uses a multi-agent pipeline with verification:

```
Requirements -> Developer Agent -> Verification Agent -> Finalizer Agent
                    |                    |                    |
                    v                    v                    v
              Modify code        Check success        Complete phase
                                 Give feedback         or revert
```

**Key result:** Medium-parameter models (Nova Pro 1.0, DeepSeek-V3) excelled at low error rate, while larger models (Claude 3.5 Sonnet, GPT-4o) excelled on harder tasks.

---

## 6. Institutional Knowledge Extraction

### Sources of Knowledge (Ordered by Value)

| Source | Value | Method | Validation |
|--------|-------|--------|------------|
| Code comments (hack, workaround, don't touch) | High | Regex scan | Cross-reference with git blame |
| Git blame history | High | `git log --follow --diff-filter=M` | Date + author + commit message |
| Error messages | Medium | Grep user-facing strings | Often encode business rules |
| Test fixtures | Medium | Analyze expected values | Encode business expectations |
| Configuration (magic numbers, thresholds) | Medium | Find hardcoded values | Trace usage to business logic |
| Dead code | Low-Medium | Static analysis for unreachable code | May be called dynamically |
| Documentation | Variable | Read docs, verify against code | Often outdated |

### Comment Archaeology Patterns

```bash
# High-value patterns (likely encode business rules)
grep -rn "hack\|workaround\|kludge\|temporary" --include="*.py" ./src/
grep -rn "don't touch\|do not modify\|fragile\|careful" --include="*.py" ./src/
grep -rn "per .* requirement\|compliance\|regulation" --include="*.py" ./src/
grep -rn "see ticket\|see bug\|see issue\|JIRA" --include="*.py" ./src/

# Code age analysis
git log --format='%at %H' --diff-filter=M -- <file> | head -1
```

---

## 7. Healing Anti-Patterns (Validated)

| Anti-Pattern | Why It Fails | What to Do | Source |
|-------------|-------------|-----------|--------|
| **Big Bang Rewrite** | Destroys institutional knowledge, 15.3% success rate at 50K+ LOC | Strangler Fig | Fowler 2004, arXiv:2602.22518 |
| **Fixing Quirks Without Classification** | "This sleep(2) is unnecessary" -- may prevent race condition | Classify friction first | Amazon AGI Lab 2026 |
| **Unit-Level Equivalence Testing** | Allows test overfitting, misses system-level behavioral changes | System-boundary testing | arXiv:2602.22518 |
| **Comment Deletion as "Cleanup"** | Removes institutional knowledge permanently | Extract to institutional-knowledge.md first | Synthesis |
| **Test Deletion** | "These tests are weird/slow" -- they capture critical behaviors | Keep until characterization complete | Feathers 2004 |
| **Over-Abstracting** | Adding clean architecture layers adds complexity | Anti-corruption layer at boundaries only | Evans 2003 |
| **Skipping Archaeology** | "I can see what this does" -- you see structure, not semantics | Always characterize before modifying | Feathers 2004, Amazon 2026 |
| **Ignoring Dead Code** | May be called via reflection, dynamic dispatch, or external systems | Runtime analysis before removal | Feathers 2004 |

---

## 8. Scale Constraints (Honest Assessment)

Based on arXiv:2602.22518 (RepoMod-Bench) and arXiv:2504.11335 (Code Reborn):

| Codebase Size | Expected Outcome | Strategy |
|---------------|-----------------|----------|
| <10K LOC | 91.3% automated pass rate | Full automated healing |
| 10K-50K LOC | ~50% automated pass rate | Automated archaeology + guided modernization |
| 50K-200K LOC | ~15% automated pass rate | Break into components first, then heal each |
| >200K LOC | Not practical end-to-end | AWS Transform or similar enterprise tooling |

**Code Reborn (arXiv:2504.11335) findings for COBOL-to-Java:**
- 93% accuracy (vs 75% manual, 82% rule-based tools)
- 35% complexity reduction
- 33% coupling reduction
- Tested on 50,000 COBOL files

---

## 9. Language-Specific Patterns (Condensed)

### COBOL / Mainframe
- COPYBOOK files = shared data structures (must map ALL usage)
- PARAGRAPH names = business process steps
- 88-level conditions = enum-like business rules
- PERFORM THRU = transaction boundaries
- **200 billion lines still running** banks, insurance, government

### Legacy Java (Pre-8)
- XML configuration (Spring XML, Hibernate HBM) = wiring
- EJB session beans = transaction semantics
- Servlet filter chain ordering matters
- JNDI lookups = deployment dependencies
- ThreadLocal = hidden state

### Legacy PHP (Pre-7)
- register_globals behavior (security risk)
- mysql_* functions (SQL injection risk)
- include/require with variable paths (dynamic loading)
- Session handling with custom save handlers

### Legacy Python (2.x)
- print statement vs function
- unicode/str confusion
- Integer division behavior (// vs /)
- Old-style classes
- Run `2to3 --no-diffs -w` in report mode first
