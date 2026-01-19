# Quality Gates

**Never ship code without passing all quality gates.**

## The 7 Quality Gates

1. **Input Guardrails** - Validate scope, detect injection, check constraints (OpenAI SDK)
2. **Static Analysis** - CodeQL, ESLint/Pylint, type checking
3. **Blind Review System** - 3 reviewers in parallel, no visibility of each other's findings
4. **Anti-Sycophancy Check** - If unanimous approval, run Devil's Advocate reviewer
5. **Output Guardrails** - Validate code quality, spec compliance, no secrets (tripwire on fail)
6. **Severity-Based Blocking** - Critical/High/Medium = BLOCK; Low/Cosmetic = TODO comment
7. **Test Coverage Gates** - Unit: 100% pass, >80% coverage; Integration: 100% pass

## Guardrails Execution Modes

- **Blocking**: Guardrail completes before agent starts (use for expensive operations)
- **Parallel**: Guardrail runs with agent (use for fast checks, accept token loss risk)

**Research:** Blind review + Devil's Advocate reduces false positives by 30% (CONSENSAGENT, 2025)

---

## Velocity-Quality Feedback Loop (CRITICAL)

**Research from arXiv 2511.04427v2 - empirical study of 807 repositories.**

### Key Findings

| Metric | Finding | Implication |
|--------|---------|-------------|
| Initial Velocity | +281% lines added | Impressive but TRANSIENT |
| Quality Degradation | +30% static warnings, +41% complexity | PERSISTENT problem |
| Cancellation Point | 3.28x complexity OR 4.94x warnings | Completely negates velocity gains |

### The Trap to Avoid

```
Initial excitement -> Velocity spike -> Quality degradation accumulates
                                               |
                                               v
                               Complexity cancels velocity gains
                                               |
                                               v
                               Frustration -> Abandonment cycle
```

**CRITICAL RULE:** Every velocity gain MUST be accompanied by quality verification.

### Mandatory Quality Checks (Per Task)

```yaml
velocity_quality_balance:
  before_commit:
    - static_analysis: "Run ESLint/Pylint/CodeQL - warnings must not increase"
    - complexity_check: "Cyclomatic complexity must not increase >10%"
    - test_coverage: "Coverage must not decrease"

  thresholds:
    max_new_warnings: 0  # Zero tolerance for new warnings
    max_complexity_increase: 10%  # Per file, per commit
    min_coverage: 80%  # Never drop below

  if_threshold_violated:
    action: "BLOCK commit, fix before proceeding"
    reason: "Velocity gains without quality are net negative"
```

### Metrics to Track

```
.loki/metrics/quality/
+-- warnings.json      # Static analysis warning count over time
+-- complexity.json    # Cyclomatic complexity per file
+-- coverage.json      # Test coverage percentage
+-- velocity.json      # Lines added/commits per hour
+-- ratio.json         # Quality/Velocity ratio (must stay positive)
```

---

## Blind Review System

**Launch 3 reviewers in parallel in a single message:**

```python
# ALWAYS launch all 3 in ONE message
Task(model="opus", description="Code review: correctness", prompt="Review for bugs...")
Task(model="opus", description="Code review: security", prompt="Review for vulnerabilities...")
Task(model="opus", description="Code review: performance", prompt="Review for efficiency...")
```

**Rules:**
- ALWAYS use opus for reviews (deep analysis)
- NEVER aggregate before all 3 complete
- ALWAYS re-run ALL 3 after fixes
- If unanimous approval -> run Devil's Advocate

---

## Severity-Based Blocking

| Severity | Action |
|----------|--------|
| Critical | BLOCK - fix immediately |
| High | BLOCK - fix before commit |
| Medium | BLOCK - fix before merge |
| Low | TODO comment, fix later |
| Cosmetic | Note, optional fix |

See `references/quality-control.md` for complete details.
