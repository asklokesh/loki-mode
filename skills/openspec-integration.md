# OpenSpec Integration

> **Reference:** OpenSpec delta specs use ADDED/MODIFIED/REMOVED sections to describe changes to existing system behavior. See `.loki/openspec/delta-context.json` for the parsed delta context injected into your prompt.

---

## When This Module Applies

- Your prompt contains an `OPENSPEC DELTA CONTEXT` section
- The project has `.loki/openspec/delta-context.json`
- The session was started with `--openspec` flag
- Tasks in `.loki/queue/pending.json` have `metadata.openspec_group`

**If none of the above are true, do not load this module.**

---

## Delta-Aware Development Rules

### ADDED Requirements

New behavior that does not exist in the codebase yet.

1. Create NEW files and functions following existing codebase patterns
2. Do NOT modify existing code unless the new feature integrates with it
3. Write tests for every scenario (GIVEN/WHEN/THEN from the delta spec)
4. Reference: `delta-context.json` → `deltas.<domain>.added[]`

```
# Mental model for ADDED
Read scenario -> Write test -> Implement -> Verify test passes
```

### MODIFIED Requirements

Existing behavior that is changing. This is the most common delta type in brownfield work.

1. Find the EXISTING code that implements this requirement
2. Modify IN PLACE -- do NOT create new files for modified behavior
3. Check the `(Previously: ...)` annotation to understand what changed
4. Update existing tests to match the new behavior
5. Reference: `delta-context.json` → `deltas.<domain>.modified[]` (each entry has a `"previously"` field)

```
# Mental model for MODIFIED
Read "(Previously: ...)" -> Find existing code -> Update code -> Update tests -> Verify
```

**Common mistake:** Treating MODIFIED as ADDED and creating new files. Always search the codebase first for the existing implementation.

### REMOVED Requirements

Behavior that is being deprecated or deleted.

1. Find and remove or deprecate the code implementing this requirement
2. Check the `(Deprecated: ...)` annotation for the reason
3. Remove associated tests
4. Ensure no orphaned imports or dead code remains
5. Reference: `delta-context.json` → `deltas.<domain>.removed[]` (each entry has a `"reason"` field)

```
# Mental model for REMOVED
Read "(Deprecated: ...)" -> Find existing code -> Remove code -> Remove tests -> Verify no dead refs
```

---

## Task Execution

Tasks are generated from OpenSpec `tasks.md` and loaded into `.loki/queue/pending.json`.

- Each task has `metadata.openspec_group` indicating its group name (string, from `## N. Group Name` headings in tasks.md)
- Execute tasks in group order (group 1 before group 2, etc.)
- Within a group, tasks can run in parallel if they touch different files
- Mark tasks complete in the queue when done

```json
{
  "id": "openspec-1.3",
  "title": "Implement session timeout change",
  "description": "[OpenSpec] Authentication: Implement session timeout change",
  "priority": "medium",
  "status": "pending",
  "source": "openspec",
  "metadata": {
    "openspec_source": "tasks.md",
    "openspec_group": "Authentication"
  }
}
```

---

## Scenario Verification

After implementing a requirement, verify its scenarios.

1. Each scenario has GIVEN (precondition), WHEN (action), THEN (expected outcome)
2. Write test cases that map 1:1 to scenarios
3. Use the scenario name as the test name for traceability
4. Verification results are tracked in `.loki/openspec/verification-map.json`

```python
# Scenario: "Idle timeout" -> test name matches scenario
def test_idle_timeout():
    # GIVEN an authenticated session
    session = create_authenticated_session()
    # WHEN 15 minutes pass without activity
    advance_time(minutes=15)
    # THEN the session is invalidated
    assert session.is_expired()
```

The verification map tracks each scenario with `"verified": false` initially. After tests pass, the orchestrator updates verified status.

```json
{
  "scenarios": [
    {
      "domain": "auth",
      "requirement": "Session Expiration",
      "scenario": "Idle timeout",
      "given": "an authenticated session",
      "when": "15 minutes pass without activity",
      "then": "the session is invalidated",
      "verified": false
    }
  ]
}
```

---

## Source Mapping

`.loki/openspec/source-map.json` maps each task ID to its origin in tasks.md.

| Field | Purpose |
|-------|---------|
| `file` | Source file (always `tasks.md`) |
| `line` | Line number in tasks.md (1-indexed) |
| `group` | Task group name from `## N. Group Name` heading |

```json
{
  "openspec-1.1": { "file": "tasks.md", "line": 3, "group": "Authentication" },
  "openspec-1.2": { "file": "tasks.md", "line": 4, "group": "Authentication" },
  "openspec-2.1": { "file": "tasks.md", "line": 7, "group": "Dashboard" }
}
```

Use this to trace implementation decisions back to the specification.

---

## Complexity Levels

The adapter classifies complexity based on task count, spec file count, and design.md presence. Checked in order (first match wins):

| Level | Condition | Agent Strategy |
|-------|-----------|----------------|
| enterprise | 20+ tasks OR 10+ spec files | Full agent team |
| complex | 11-20 tasks OR 6-10 spec files | Task tool parallelization |
| standard | 4-10 tasks OR 2-5 spec files OR design.md present | Parallel where possible |
| simple | 1-3 tasks, 1 spec file, no design | Single agent, sequential |

---

## Output Files Reference

All output files are written to `.loki/` by the adapter (`autonomy/openspec-adapter.py`):

| File | Purpose |
|------|---------|
| `.loki/openspec-prd-normalized.md` | Synthesized PRD from proposal + specs + design |
| `.loki/openspec-tasks.json` | Task list parsed from tasks.md |
| `.loki/openspec/delta-context.json` | Structured deltas with stats and complexity |
| `.loki/openspec/source-map.json` | Task ID to tasks.md line mapping |
| `.loki/openspec/verification-map.json` | Scenario verification tracking |

---

## Common Mistakes

| Mistake | Correction |
|---------|------------|
| Creating new files for MODIFIED requirements | Search codebase first, update existing code in place |
| Ignoring `(Previously: ...)` annotations | These tell you exactly what changed -- read them |
| Not writing tests for GIVEN/WHEN/THEN scenarios | Every scenario must have a corresponding test |
| Treating all deltas as ADDED | Most brownfield work is MODIFIED -- check the delta type |
| Skipping REMOVED cleanup | Dead code and orphaned imports cause maintenance burden |
| Implementing groups out of order | Group 1 must complete before group 2 starts |
