# Legacy System Healing

## Research Foundation

This module synthesizes ideas from multiple validated sources. Each technique is cited.

| Source | Key Contribution | Citation |
|--------|-----------------|----------|
| Amazon AGI Lab (2026) | Friction-as-semantics, agents as universal API over legacy UIs | [amazon.science blog](https://www.amazon.science/blog/how-agentic-ai-helps-heal-the-systems-we-cant-replace) |
| Michael Feathers (2004) | Characterization testing, dependency-breaking techniques, seams | *Working Effectively with Legacy Code*, Prentice Hall |
| Martin Fowler (2004) | Strangler Fig pattern for incremental replacement | [martinfowler.com/bliki/StranglerFigApplication](https://martinfowler.com/bliki/StranglerFigApplication.html) |
| Eric Evans (2003) | Anti-Corruption Layer to isolate legacy from modern code | *Domain-Driven Design*, Addison-Wesley |
| RepoMod-Bench (2026) | System-boundary testing for behavioral equivalence | arXiv:2602.22518 |
| Model-Driven Modernization (2026) | Observability + contract tests for conformance | arXiv:2602.04341 |
| HEC (2025) | Equivalence verification via equality saturation | arXiv:2506.02290 |
| VAPU (2025) | Multi-agent pipeline for autonomous legacy updates | arXiv:2510.18509 |
| Code Reborn (2025) | AI-driven COBOL-to-Java, 93% accuracy | arXiv:2504.11335 |
| AWS Transform (2025-2026) | Decomposition agents, semantic seeding, domain grouping | [AWS blog](https://aws.amazon.com/blogs/migration-and-modernization/accelerate-your-mainframe-modernization-journey-using-ai-agents-with-aws-transform/) |
| GitHub Copilot (2025) | 3-agent pattern: extract logic, generate tests, generate modern code | [github.blog](https://github.blog/ai-and-ml/github-copilot/how-github-copilot-and-ai-agents-are-saving-legacy-systems/) |

---

## When to Load This Module

- `loki heal` command invoked
- Working with legacy codebases (COBOL, FORTRAN, old Java, PHP 5, Python 2, jQuery-era JS)
- Brownfield modernization projects
- `--target` flag used with `loki migrate`
- Codebase archaeology / knowledge extraction tasks

---

## Core Principles

### 1. Friction is Semantics (Amazon AGI Lab)

**Source:** Amazon AGI Lab -- "The logic behind legacy systems reveals itself most clearly through friction."

System quirks are not bugs. They are the real behavior. The modal that appears late encodes a sequencing rule. The field that refuses input until another value is saved. The form that resets because a backend job restarted midflow. These behaviors ARE the semantics.

```yaml
friction_detection:
  rule: "Before 'fixing' any quirk, verify it is not an undocumented business rule"
  action: "Document in .loki/healing/friction-map.json"
  classification:
    business_rule: "Keep and document. Gate 10 blocks removal."
    true_bug: "Fix with characterization test proving the fix."
    unknown: "Keep until classified. NEVER remove unknown friction."
```

**Friction Map Schema:**
```json
{
  "frictions": [
    {
      "id": "friction-001",
      "location": "src/billing/invoice.py:234",
      "behavior": "Sleep 2s before committing transaction",
      "classification": "business_rule|true_bug|unknown",
      "evidence": "Prevents race condition with external payment gateway callback",
      "discovered_by": "archaeology_scan",
      "timestamp": "2026-01-25T10:00:00Z",
      "safe_to_remove": false
    }
  ]
}
```

### 2. Characterize Before Modifying (Feathers)

**Source:** Michael Feathers, *Working Effectively with Legacy Code* (2004)

A characterization test describes the ACTUAL behavior of existing code, not the INTENDED behavior. It is a change detector, not a correctness proof. Mark Seemann (2025) emphasizes: "Write an assertion that you know will fail" -- this prevents tautological tests.

```yaml
characterization_testing:
  feathers_recipe:
    1: "Use a piece of code in a test harness"
    2: "Write an assertion that you KNOW will fail"
    3: "Let the failure tell you what the actual behavior is"
    4: "Change the test so that it expects the behavior the code produces"
    5: "Repeat -- the test now documents the actual behavior"

  key_distinction: |
    Characterization tests capture WHAT THE CODE DOES.
    Unit tests verify WHAT THE CODE SHOULD DO.
    When these differ, the characterization test wins during healing --
    because users depend on actual behavior, not intended behavior.

  seemann_2025: |
    "A characterization test is a falsifiable experiment. The implied
    hypothesis is that the test will fail. If it does not fail, you've
    falsified the prediction." (Mark Seemann, Nov 2025)
```

### 3. Strangler Fig Pattern (Fowler)

**Source:** Martin Fowler, 2004. Named after strangler figs that gradually grow around a host tree.

Do NOT rewrite. Gradually replace components while both old and new run simultaneously. A facade/proxy routes traffic to old or new based on readiness.

```yaml
strangler_fig:
  steps:
    1: "Identify system boundaries (not arbitrary code boundaries)"
    2: "Define thin slices -- small enough to replace, big enough to deliver value"
    3: "Introduce indirection layer (the 'fig' that grows around the tree)"
    4: "Develop new component behind the indirection"
    5: "Route traffic to new component"
    6: "Retire old component when new one is verified"
    7: "Iterate for next slice"

  best_practices:
    - "Start with low-risk components that have good test coverage"
    - "The facade must not become a bottleneck or single point of failure"
    - "Handle shared databases via views or APIs, not direct access"
    - "Use CI/CD, canary releases, and feature flags"
```

### 4. Anti-Corruption Layer (Evans, DDD)

**Source:** Eric Evans, *Domain-Driven Design* (2003), Chapter 14

When integrating with a legacy system, create a layer that translates between your modern domain model and the legacy model. This prevents the legacy model from "corrupting" your clean design.

```yaml
anti_corruption_layer:
  purpose: "Translate between modern and legacy models without contamination"
  components:
    facade: "Simplified interface to the legacy subsystem"
    adapter: "Converts legacy data formats to modern types"
    translator: "Maps between domain concepts across systems"

  # This is what Amazon AGI Lab calls making the agent a "universal API"
  # The agent manages legacy idiosyncrasies behind the scenes.
  amazon_connection: |
    Amazon's insight: when agents learn the UI layer deeply enough,
    they function as a synthetic API -- a stable programmatic surface
    over infrastructure that can't be changed. This IS an anti-corruption
    layer, implemented by an AI agent instead of hand-coded middleware.
```

### 5. System-Boundary Verification (RepoMod-Bench)

**Source:** arXiv:2602.22518 (Feb 2026) -- "Software behavior is best verified at the system boundary rather than the unit level."

Do NOT compare outputs byte-for-byte at the unit level. Verify functional equivalence at natural system interfaces: CLIs, REST APIs, message queues, file outputs.

```yaml
system_boundary_verification:
  key_insight: |
    RepoMod-Bench showed that unit-level testing allows agents to
    "overfit" to tests. System-boundary testing with implementation-agnostic
    test suites is the correct approach for verifying modernization.

  approach:
    - "Identify natural system boundaries (CLI, API, file I/O, DB queries)"
    - "Write tests at those boundaries that are language-agnostic"
    - "Run the SAME tests against old and new implementations"
    - "Differences = behavioral changes that need explicit documentation"

  repomod_finding: |
    Pass rates drop from 91.3% on projects under 10K LOC to 15.3% on
    projects over 50K LOC. Autonomous modernization at scale remains
    a significant open challenge (arXiv:2602.22518).

  model_driven_approach: |
    arXiv:2602.04341 validates using observability (logs, metrics, traces)
    and contract tests to verify behavioral and non-functional conformance
    during modernization. Telemetry feeds back into rule guards.
```

---

## Healing Pipeline

### Phase Gates

Each phase has deterministic gates (shell-level enforcement via `autonomy/hooks/migration-hooks.sh`).

```yaml
phases:
  1_archaeology:
    name: "Codebase Archaeology"
    actions:
      - "Map dependency graph (Feathers: find 'seams' and 'pinch points')"
      - "Catalog all friction points (Amazon: friction-as-semantics)"
      - "Write characterization tests for critical paths (Feathers recipe)"
      - "Extract institutional knowledge from comments and git history"
      - "Classify code by age and change frequency (fossilized vs radioactive)"
    gate: "friction-map.json has >0 entries AND characterization tests pass at 100%"

  2_stabilize:
    name: "Stabilize (Add Observability)"
    actions:
      - "Add logging/tracing without changing behavior (arXiv:2602.04341)"
      - "Extract configuration from hardcoded values"
      - "Add type annotations/hints where possible"
      - "Set up contract tests at system boundaries (RepoMod-Bench approach)"
    gate: "All characterization tests still pass AND no new static warnings"

  3_isolate:
    name: "Strangler Fig Setup"
    actions:
      - "Identify component boundaries using AWS Transform's decomposition approach"
      - "Create anti-corruption layer at boundaries (Evans, DDD)"
      - "Add integration tests at adapter boundaries"
      - "Set up routing/facade for traffic splitting (Fowler)"
    gate: "Components can be tested independently through their adapters"

  4_modernize:
    name: "Incremental Replacement"
    actions:
      - "Replace ONE component at a time behind its anti-corruption layer"
      - "Run system-boundary tests after each replacement (arXiv:2602.22518)"
      - "Verify friction behaviors are preserved (or explicitly documented as removed)"
      - "Use GitHub's 3-agent pattern where applicable:"
      - "  Agent 1: Extract business logic from legacy component"
      - "  Agent 2: Generate characterization tests for that logic"
      - "  Agent 3: Generate modern implementation that passes those tests"
    gate: "System-boundary tests pass + new component tests pass"

  5_validate:
    name: "Behavioral Conformance Verification"
    actions:
      - "Run full system-boundary test suite against both old and new"
      - "Compare with observability data from stabilize phase (arXiv:2602.04341)"
      - "Verify no institutional logic was lost"
      - "Generate healing report with explicit list of behavioral changes"
    gate: "Functional equivalence at system boundaries OR documented intentional changes"
```

---

## Healing RARV Cycle

The standard RARV cycle adapted for healing work:

```
REASON: What is the riskiest undocumented behavior?
   |
   v
ACT: Write a characterization test that captures it (Feathers recipe).
   |
   v
REFLECT: Does the test capture ACTUAL behavior, not INTENDED behavior?
         (If you wrote what you THINK the code does, you wrote a unit test,
          not a characterization test.)
   |
   v
VERIFY: Run the test.
   |
   +--[PASS]--> Behavior documented. Store friction point. Move to next.
   |
   +--[FAIL]--> You misunderstood the system. This IS the learning.
                Update your model. Store in episodic memory.
                (Amazon: "the hardest part is teaching why workflows fail")
```

---

## Structured Fault Injection (Honest Alternative to RL Gyms)

**Honesty note:** Amazon's RL gyms train neural models through reinforcement learning in thousands of synthetic environments. Loki cannot do RL training. What Loki CAN do is structured fault injection to discover failure modes systematically.

```yaml
structured_fault_injection:
  what_this_is: "Systematic probing of error paths to build understanding"
  what_this_is_not: "Reinforcement learning in synthetic environments"

  protocol:
    1_happy_path:
      - "Run all existing tests -- record pass/fail baseline"
      - "Execute documented workflows end-to-end"

    2_boundary_probing:
      - "Send null/empty/max-length inputs to all entry points"
      - "Test with invalid dates, negative numbers, special characters"
      - "Test concurrent access if applicable"

    3_dependency_failure:
      - "What happens when the database is slow?"
      - "What happens when an external API returns 500?"
      - "What happens when a config file is missing?"

    4_document_everything:
      - "Every failure mode goes into .loki/healing/failure-modes.json"
      - "After 3+ similar failures, consolidate into semantic memory"
```

---

## Multi-Agent Decomposition (AWS Transform Pattern)

**Source:** AWS Transform uses specialized agents for different aspects of legacy analysis.

```yaml
decomposition_agents:
  # Adapted from AWS Transform's agent categories
  code_agent:
    purpose: "Analyze source code artifacts -- types, LOC, complexity, dependencies, missing elements"
    loki_mapping: "Run during archaeology phase with sonnet"

  data_source_agent:
    purpose: "Identify data sources (databases, files, configs) and their metadata"
    loki_mapping: "Run during archaeology phase with sonnet"

  decomposition_agent:
    purpose: "Group code into logical domains using semantic seeding"
    loki_mapping: "Run during isolate phase with opus"
    aws_detail: |
      AWS Transform uses semantic seeding to organize applications into
      logical domains while dependency detection ensures proper separation.
      This identifies the natural lines of demarcation for strangler fig slices.

  # GitHub Copilot's 3-agent pattern for actual modernization
  github_3_agent:
    agent_1: "Extract business logic from legacy component"
    agent_2: "Generate characterization tests that validate that logic"
    agent_3: "Generate modern code that passes those tests"
    source: "github.blog/ai-and-ml/github-copilot/how-github-copilot-and-ai-agents-are-saving-legacy-systems/"
```

---

## Health Score Formula

The health score is NOT a magic number. It is a weighted composite of measurable metrics.

```yaml
health_score:
  formula: |
    health = (0.30 * characterization_coverage)
           + (0.25 * friction_resolution_rate)
           + (0.20 * test_pass_rate)
           + (0.15 * knowledge_extraction_completeness)
           + (0.10 * static_analysis_improvement)

  components:
    characterization_coverage:
      definition: "Critical paths with characterization tests / total critical paths"
      range: "0.0 to 1.0"
      weight: 0.30
      rationale: "Feathers: untested code is the primary risk in legacy systems"

    friction_resolution_rate:
      definition: "Classified friction points / total friction points"
      range: "0.0 to 1.0"
      weight: 0.25
      rationale: "Unknown friction is unmanaged risk (Amazon: friction-as-semantics)"

    test_pass_rate:
      definition: "Passing characterization tests / total characterization tests"
      range: "0.0 to 1.0"
      weight: 0.20
      rationale: "Failing characterization tests mean behavior has changed"

    knowledge_extraction_completeness:
      definition: "Components with documented institutional knowledge / total components"
      range: "0.0 to 1.0"
      weight: 0.15
      rationale: "Undocumented knowledge is permanent risk (Amazon: retiring devs)"

    static_analysis_improvement:
      definition: "1 - (current_warnings / baseline_warnings), clamped to [0, 1]"
      range: "0.0 to 1.0"
      weight: 0.10
      rationale: "arXiv:2511.04427v2: +30% warnings negates velocity gains"
```

---

## Healing-Specific Code Review

When `loki heal` is active, the code review specialist pool includes:

| Specialist | Focus | Trigger Keywords |
|-----------|-------|-----------------|
| **legacy-healing-auditor** | Behavioral preservation, friction safety, institutional knowledge | legacy, heal, migrate, cobol, fortran, refactor, modernize, deprecat |

**Legacy Healing Auditor checks:**
- Behavioral change without characterization test update (Feathers)
- Removal of friction classified as `business_rule` or `unknown` (Amazon)
- Missing anti-corruption layer for replaced components (Evans)
- Institutional knowledge loss (deleted comments, removed error messages)
- Breaking changes to undocumented APIs consumed by other systems

---

## Healing Metrics

```
.loki/healing/
  friction-map.json              # All identified friction points
  failure-modes.json             # Cataloged failure modes
  institutional-knowledge.md     # Extracted tribal knowledge
  healing-progress.json          # Component-by-component healing status
  behavioral-baseline/           # Pre-healing system-boundary outputs
  characterization-tests/        # Tests that capture current behavior
```

**Progress Tracking:**
```json
{
  "codebase": "./src",
  "started": "2026-01-25T10:00:00Z",
  "components": [
    {
      "name": "billing/invoice",
      "phase": "stabilize",
      "critical_paths_total": 15,
      "critical_paths_characterized": 12,
      "friction_points": 12,
      "friction_classified": 8,
      "characterization_tests": 47,
      "characterization_passing": 47,
      "institutional_rules_extracted": 8,
      "baseline_warnings": 23,
      "current_warnings": 18,
      "health_score": 0.74
    }
  ],
  "overall_health": 0.74
}
```

---

## Healing Signals

| Signal | Purpose | Emitted When |
|--------|---------|-------------|
| `FRICTION_DETECTED` | New friction point found | Archaeology scan finds quirky behavior |
| `BEHAVIOR_CHANGE_RISK` | Proposed change may alter legacy behavior | Code review detects behavioral modification |
| `INSTITUTIONAL_KNOWLEDGE_FOUND` | Tribal knowledge extracted from code | Comment/history analysis reveals business rule |
| `HEALING_PHASE_COMPLETE` | Component completed a healing phase | Phase gate passed |
| `LEGACY_COMPATIBILITY_RISK` | Breaking change to legacy API detected | System-boundary test fails |

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOKI_HEAL_MODE` | `false` | Enable healing mode |
| `LOKI_HEAL_PHASE` | `archaeology` | Current healing phase |
| `LOKI_HEAL_PRESERVE_FRICTION` | `true` | Warn before removing friction points |
| `LOKI_HEAL_BASELINE_DIR` | `.loki/healing/behavioral-baseline/` | Pre-healing snapshots |
| `LOKI_HEAL_STRICT` | `false` | Block ALL behavioral changes without approval |

---

## Known Limitations

Honest assessment of what this module can and cannot do:

| Capability | Status | Notes |
|-----------|--------|-------|
| Characterization test generation | Agent-guided | Agent writes tests following Feathers recipe, not fully automated |
| Friction detection | Heuristic | Pattern matching for sleeps, retries, magic values. Not exhaustive. |
| Equivalence verification | System-boundary | Not formal verification (HEC/arXiv:2506.02290 is research-stage) |
| Multi-agent decomposition | Sequential | True parallel decomposition like AWS Transform requires cloud infra |
| Institutional knowledge extraction | Best-effort | Comment/blame analysis. Cannot extract unwritten tribal knowledge. |
| Scale | <50K LOC practical | RepoMod-Bench: pass rates drop to 15.3% above 50K LOC |

---

## Quick Reference

```bash
# Start healing a legacy codebase
loki heal ./legacy-app

# Archaeology only (extract knowledge, don't modify)
loki heal ./legacy-app --archaeology-only

# Resume healing from last checkpoint
loki heal ./legacy-app --resume

# View healing progress
loki heal --status

# View friction map
loki heal --friction-map ./legacy-app

# Generate healing report
loki heal --report

# Strict mode: block any behavioral change without approval
LOKI_HEAL_STRICT=true loki heal ./legacy-app
```
