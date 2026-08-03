# Confidence-Based Routing Reference

> **STATUS: DESIGN NOTE, NOT IMPLEMENTED.** Nothing in this document is wired
> into the runtime. Do not configure against it.
>
> Verified against source at v9.8.1:
> - `LOKI_CONFIDENCE_ROUTING` is read once (`autonomy/run.sh:1319`) and only
>   printed to a log line (`autonomy/run.sh:21182`). No code branches on it.
> - `LOKI_CONFIDENCE_AUTO_APPROVE`, `LOKI_CONFIDENCE_DIRECT`,
>   `LOKI_CONFIDENCE_SUPERVISOR` and `LOKI_CONFIDENCE_CALIBRATION_DAYS` are
>   read nowhere in the repo.
> - `calculate_task_confidence()`, `save_confidence_calibration()`, the
>   `force_routing` / `require_human_review` task metadata, and the Brier-score
>   calibration dashboard do not exist in source.
>
> The Python and bash blocks below are illustrative pseudocode for a proposed
> design. They are kept as a design record. For the routing that actually runs,
> see `skills/model-selection.md` and `get_rarv_tier()` in `autonomy/run.sh`.

Design pattern drawn from HN discussions and the Claude Agent SDK guide.

---

## Overview

**Traditional Routing (Binary):**
```
IF simple_task → direct routing
ELSE → supervisor mode
```

**Confidence-Based Routing (Multi-Tier):**
```
Confidence >= 0.95 → Auto-approve (fastest)
Confidence >= 0.70 → Direct with review (fast + safety)
Confidence >= 0.40 → Supervisor orchestration (full coordination)
Confidence < 0.40  → Human escalation (too uncertain)
```

---

## Confidence Score Calculation

### Multi-Factor Assessment

```python
def calculate_task_confidence(task) -> float:
    """
    Calculate confidence score (0.0-1.0) based on multiple factors.

    Returns weighted average of confidence pillars.
    """
    scores = {
        "requirement_clarity": assess_requirement_clarity(task),
        "technical_feasibility": assess_feasibility(task),
        "resource_availability": check_resources(task),
        "historical_success": query_similar_tasks(task),
        "complexity_match": match_agent_capability(task)
    }

    # Weighted average (can be tuned)
    weights = {
        "requirement_clarity": 0.30,
        "technical_feasibility": 0.25,
        "resource_availability": 0.15,
        "historical_success": 0.20,
        "complexity_match": 0.10
    }

    confidence = sum(scores[k] * weights[k] for k in scores)
    return round(confidence, 2)


def assess_requirement_clarity(task) -> float:
    """Score 0.0-1.0 based on requirement specificity."""
    # Check for ambiguous language
    ambiguous_terms = ["maybe", "perhaps", "might", "probably", "unclear"]
    ambiguity_count = sum(1 for term in ambiguous_terms if term in task.description.lower())

    # Check for concrete deliverables
    has_spec = task.spec_reference is not None
    has_acceptance_criteria = task.acceptance_criteria is not None

    base_score = 1.0 - (ambiguity_count * 0.15)
    if has_spec: base_score += 0.2
    if has_acceptance_criteria: base_score += 0.2

    return min(1.0, max(0.0, base_score))


def assess_feasibility(task) -> float:
    """Score 0.0-1.0 based on technical feasibility."""
    # Check for known patterns
    known_patterns = check_pattern_library(task)

    # Check for external dependencies
    external_deps = count_external_dependencies(task)

    # Check for novel technology
    novel_tech = uses_unfamiliar_tech(task)

    score = 0.8  # Start optimistic
    if known_patterns: score += 0.2
    score -= (external_deps * 0.1)
    if novel_tech: score -= 0.3

    return min(1.0, max(0.0, score))


def check_resources(task) -> float:
    """Score 0.0-1.0 based on resource availability."""
    # Check API quotas
    apis_available = check_api_quotas(task.required_apis)

    # Check agent availability
    agents_available = check_agent_capacity(task.required_agents)

    # Check budget
    estimated_cost = estimate_task_cost(task)
    budget_available = estimated_cost < get_remaining_budget()

    available_count = sum([apis_available, agents_available, budget_available])
    return available_count / 3.0


def query_similar_tasks(task) -> float:
    """Score 0.0-1.0 based on historical success with similar tasks."""
    similar_tasks = find_similar_tasks(task, limit=10)

    if not similar_tasks:
        return 0.5  # Neutral if no history

    success_rate = sum(1 for t in similar_tasks if t.outcome == "success") / len(similar_tasks)
    return success_rate
```

---

## Routing Decision Matrix

### Tier 1: Auto-Approve (Confidence >= 0.95)

**Characteristics:**
- Highly specific requirements
- Well-established patterns
- All resources available
- 90%+ historical success rate

**Action:**
```python
if confidence >= 0.95:
    log_auto_approval(task, confidence)
    execute_direct(task, review_after=False)
```

**Examples:**
- Run linter on specific file
- Execute unit test suite
- Format code with prettier
- Update package version in package.json

### Tier 2: Direct with Review (0.70 <= Confidence < 0.95)

**Characteristics:**
- Clear requirements but some unknowns
- Familiar patterns with minor variations
- Most resources available
- 70-90% historical success

**Action:**
```python
if 0.70 <= confidence < 0.95:
    result = execute_direct(task, review_after=True)

    # Quick automated review
    issues = run_static_analysis(result)
    if issues.critical or issues.high:
        flag_for_human_review(result, issues)
    else:
        approve_with_monitoring(result)
```

**Examples:**
- Implement CRUD endpoint from OpenAPI spec
- Write unit tests for new function
- Fix bug with clear reproduction steps
- Refactor function following established pattern

### Tier 3: Supervisor Mode (0.40 <= Confidence < 0.70)

**Characteristics:**
- Some ambiguity in requirements
- Novel patterns or approaches needed
- Partial resource availability
- 40-70% historical success

**Action:**
```python
if 0.40 <= confidence < 0.70:
    # Full orchestrator coordination
    plan = orchestrator.create_plan(task)
    agents = orchestrator.dispatch_specialists(plan)
    result = orchestrator.synthesize_results(agents)

    # Mandatory review before acceptance
    review_result = run_full_review(result)
    if review_result.approved:
        accept_with_monitoring(result)
    else:
        retry_with_constraints(result, review_result.issues)
```

**Examples:**
- Design new architecture for feature
- Implement feature with unclear edge cases
- Integrate unfamiliar third-party API
- Refactor with multiple valid approaches

### Tier 4: Human Escalation (Confidence < 0.40)

**Characteristics:**
- High ambiguity or unknowns
- Novel/unproven approach required
- Missing critical resources
- <40% historical success

**Action:**
```python
if confidence < 0.40:
    escalation_report = generate_escalation_report(task, confidence)

    # Write to signals directory
    write_escalation_signal(
        task_id=task.id,
        reason="confidence_too_low",
        confidence=confidence,
        report=escalation_report
    )

    # Wait for human decision
    wait_for_approval_signal(task.id)
```

**Examples:**
- Make breaking API changes
- Delete production data
- Choose between fundamentally different architectures
- Implement unspecified security model

---

## Confidence Tracking

### State Schema

```json
{
  "task_id": "task-123",
  "timestamp": "2026-01-14T10:00:00Z",
  "confidence_assessment": {
    "overall_score": 0.85,
    "factors": {
      "requirement_clarity": 0.90,
      "technical_feasibility": 0.92,
      "resource_availability": 0.75,
      "historical_success": 0.80,
      "complexity_match": 0.88
    }
  },
  "routing_decision": "direct_with_review",
  "routing_tier": 2,
  "rationale": "High confidence but novel tech stack requires review",
  "estimated_success_probability": 0.85,
  "fallback_plan": "escalate_to_supervisor_if_fails"
}
```

### Storage Location

```
.loki/state/confidence-scores/
├── {date}/
│   └── {task_id}.json
└── aggregate-metrics.json  # Rolling statistics
```

---

## Calibration

### Continuous Learning

Track actual outcomes vs predicted confidence:

```python
def calibrate_confidence_model():
    """Update confidence assessment based on actual outcomes."""
    recent_tasks = load_tasks(days=7)

    for task in recent_tasks:
        predicted = task.confidence_score
        actual = 1.0 if task.outcome == "success" else 0.0

        # Calculate calibration error
        error = abs(predicted - actual)

        # Update factor weights if systematic bias detected
        if error > 0.3:  # Significant miscalibration
            adjust_confidence_weights(task, error)

    # Save updated calibration
    save_confidence_calibration()
```

### Monitoring Dashboard

Track calibration metrics:
- **Brier Score:** Mean squared error between predicted confidence and actual outcome
- **Calibration Curve:** Plot predicted vs actual success rate
- **Tier Accuracy:** Success rate by routing tier

---

## Configuration

### Environment Variables

```bash
# Enable confidence-based routing (default: true)
LOKI_CONFIDENCE_ROUTING=${LOKI_CONFIDENCE_ROUTING:-true}

# Confidence thresholds (can be tuned)
LOKI_CONFIDENCE_AUTO_APPROVE=${LOKI_CONFIDENCE_AUTO_APPROVE:-0.95}
LOKI_CONFIDENCE_DIRECT=${LOKI_CONFIDENCE_DIRECT:-0.70}
LOKI_CONFIDENCE_SUPERVISOR=${LOKI_CONFIDENCE_SUPERVISOR:-0.40}

# Calibration frequency (days)
LOKI_CONFIDENCE_CALIBRATION_DAYS=${LOKI_CONFIDENCE_CALIBRATION_DAYS:-7}
```

### Override Per Task

```python
# Force specific routing regardless of confidence
Task(
    description="Critical security fix",
    prompt="...",
    metadata={
        "force_routing": "supervisor",  # Override confidence-based routing
        "require_human_review": True
    }
)
```

---

## Production Validation

### HN Community Insights

From production deployments:
- **Auto-approve threshold (0.95):** 98% success rate observed
- **Direct-with-review (0.70-0.95):** 92% success rate, 8% caught by review
- **Supervisor mode (0.40-0.70):** 75% success rate, requires iteration
- **Human escalation (<0.40):** 60% success rate even with human input (inherently uncertain tasks)

### Cost Savings

Confidence-based routing reduces costs by:
- **Auto-approve tier:** 40% faster, uses Haiku
- **Direct-with-review:** 25% faster, uses Sonnet
- **Supervisor mode:** Standard cost, uses Opus for planning

Average cost reduction: 22% compared to always-supervisor routing.

---

## Best Practices

1. **Start conservative** - Use higher thresholds initially, lower as calibration improves
2. **Monitor calibration** - Weekly reviews of predicted vs actual success rates
3. **Log all decisions** - Essential for debugging and improvement
4. **Adjust per project** - Novel domains may need higher escalation thresholds
5. **Human override** - Always allow manual routing decisions

---

**Version:** 1.0.0 | **Pattern Source:** HN Production Discussions + Claude Agent SDK Guide
