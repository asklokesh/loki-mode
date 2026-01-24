# Prompt Repetition Pattern Reference

Research-backed technique from arXiv 2512.14982v1: "Prompt Repetition Improves Non-Reasoning LLMs"

---

## Overview

**Key Finding:** Repeating prompts improves accuracy from 21.33% → 97.33% on position-dependent tasks without latency penalty.

**Why It Works:** Causal language models process tokens sequentially without future context. Repetition enables bidirectional attention within the parallelizable prefill stage.

---

## When to Apply

### ✅ USE Prompt Repetition For:
- **Haiku agents** (non-reasoning model)
- **Structured tasks** (unit tests, linting, formatting)
- **Position-dependent operations** (finding items in lists, parsing structured data)
- **Simple bug fixes** (typos, imports, syntax errors)

### ❌ DO NOT Use For:
- **Opus agents** (reasoning model - neutral/slightly negative effect)
- **Sonnet agents** (reasoning model - neutral effect)
- **Complex reasoning tasks** (architecture decisions, planning)
- **Creative generation** (doesn't help with open-ended tasks)

---

## Implementation Pattern

### Basic Repetition (2x)

```python
# Standard prompt (no repetition)
Task(
    model="haiku",
    description="Run unit tests",
    prompt="Execute all unit tests in tests/ directory and report results"
)

# With prompt repetition (2x)
base_prompt = "Execute all unit tests in tests/ directory and report results"
repeated_prompt = f"{base_prompt}\n\n{base_prompt}"

Task(
    model="haiku",
    description="Run unit tests",
    prompt=repeated_prompt
)
```

### Enhanced Repetition (3x)

For tasks requiring attention to position-dependent elements:

```python
# 3x repetition for complex structured tasks
base_prompt = "Find all TODO comments in codebase and categorize by priority"
repeated_prompt = f"{base_prompt}\n\n{base_prompt}\n\n{base_prompt}"

Task(
    model="haiku",
    description="Categorize TODOs",
    prompt=repeated_prompt
)
```

---

## Performance Impact

### Benchmarks from Research Paper

| Model | Task | Baseline | 2x Repetition | 3x Repetition |
|-------|------|----------|---------------|---------------|
| Gemini 2.0 Flash-Lite | NameIndex | 21.33% | 97.33% | 98.67% |
| GPT-4o | NameIndex | 56.67% | 86.67% | 90.00% |
| Claude 3 Sonnet | NameIndex | 48.00% | 82.67% | 85.33% |
| Deepseek V3 | NameIndex | 62.67% | 88.00% | 91.33% |

**Aggregate Results:**
- Wins: 47/70 tests improved
- Losses: 0/70 tests degraded
- Neutral: 23/70 tests unchanged

### Latency Impact

**Zero latency penalty** - repetition occurs in parallelizable prefill stage, not sequential generation.

---

## Loki Loop Integration

### Automatic Application

Loki Loop automatically applies prompt repetition for Haiku agents on eligible tasks:

```python
def prepare_task_prompt(task, model):
    """Prepare prompt with optional repetition based on model and task type."""
    base_prompt = task.prompt

    # Apply repetition for Haiku on structured tasks
    if model == "haiku" and is_structured_task(task):
        # 2x repetition for standard tasks
        if task.complexity == "simple":
            return f"{base_prompt}\n\n{base_prompt}"

        # 3x repetition for position-critical tasks
        elif requires_position_accuracy(task):
            return f"{base_prompt}\n\n{base_prompt}\n\n{base_prompt}"

    return base_prompt  # No repetition for reasoning models


def is_structured_task(task):
    """Determine if task benefits from prompt repetition."""
    structured_keywords = [
        "test", "lint", "format", "parse", "find", "list",
        "extract", "categorize", "count", "filter"
    ]
    return any(kw in task.description.lower() for kw in structured_keywords)


def requires_position_accuracy(task):
    """Check if task requires precise position/order handling."""
    position_keywords = [
        "order", "sequence", "position", "index", "nth",
        "first", "last", "middle", "between"
    ]
    return any(kw in task.description.lower() for kw in position_keywords)
```

### Manual Override

Disable repetition for specific tasks:

```python
Task(
    model="haiku",
    description="Generate creative names",
    prompt="Suggest 10 creative product names",
    metadata={"disable_prompt_repetition": True}
)
```

---

## Research Citations

**Paper:** Leviathan, Y., Kalman, M., & Matias, Y. (2025). *Prompt Repetition Improves Non-Reasoning LLMs*. arXiv:2512.14982v1.

**Key Quotes:**
- "Prompt repetition wins 47 out of 70 tests, with 0 losses"
- "No increase in output lengths or generation times"
- "Results neutral to slightly positive when reasoning enabled"

---

## Best Practices

1. **Always repeat for Haiku** on structured tasks (unit tests, linting, parsing)
2. **Never repeat for Opus/Sonnet** (reasoning models see no benefit)
3. **Use 2x repetition** as default (diminishing returns beyond 3x)
4. **Test with/without** repetition on critical tasks to validate improvement
5. **Monitor token usage** - input tokens increase 2-3x (but still cost-effective due to accuracy gains)

---

## Cost-Benefit Analysis

### Example: Unit Test Execution

**Without Repetition:**
- Accuracy: 65%
- Input tokens: 500
- Retries needed: 2-3
- Total cost: 500 + (500 × 2) = 1500 tokens

**With 2x Repetition:**
- Accuracy: 95%
- Input tokens: 1000 (2x)
- Retries needed: 0-1
- Total cost: 1000 + (1000 × 0.5) = 1500 tokens

**Result:** Same cost, 46% higher accuracy.

---

**Version:** 1.0.0 | **Research Source:** arXiv 2512.14982v1 (2025)
