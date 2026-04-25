# Live Managed Memory Tests

This directory contains opt-in integration tests that exercise the real
Anthropic Managed Agents Memory beta API. They are intentionally NOT
run by default and NOT included in CI.

## Activation

Both environment variables must be set for any test in this directory
to execute. With either missing, every test is reported as `SKIPPED`
and ZERO network requests are made.

```
LOKI_LIVE_TESTS=1
ANTHROPIC_API_KEY=sk-ant-...
```

## Running

```
LOKI_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... \
    python3 -m pytest tests/live/ -v
```

## What runs

| File | Coverage |
|------|----------|
| `test_memory_roundtrip.py` | `ManagedClient.stores_get_or_create`, `memory_create`, `memory_read`, `memories_list` |
| `test_retrieve.py` | `memory.managed_memory.retrieve.retrieve_related_verdicts` against a seeded store |
| `test_shadow_write.py` | `memory.managed_memory.shadow_write.shadow_write_pattern` and `shadow_write_verdict` end-to-end |

## Resource hygiene

Every test creates resources under a uuid-suffixed path prefix:

```
loki-livetest-<label>-<uuid6>/...
```

All test entries live in a single shared store named
`loki-livetest-shared`. The Managed Memory beta does not yet expose a
stable store-delete in `ManagedClient`, so each test best-effort
deletes the individual memory entries it wrote in `tearDown`. The
shared store remains across runs, but the prefix convention makes any
orphaned entry trivially identifiable for out-of-band cleanup:

```python
from memory.managed_memory.client import ManagedClient
c = ManagedClient()
store = c.stores_get_or_create(name="loki-livetest-shared")
print(c.memories_list(store_id=store["id"], path_prefix="loki-livetest-"))
```

## Out of scope

- Live load/perf tests
- Billing or cost assertions
- Mocking the live SDK (use `tests/managed_memory/` for mocked tests)
- Running these tests in default CI

## Why opt-in?

1. They consume real API quota and incur billing on the active key.
2. The Managed Agents Memory API is a private beta; flags can change.
3. CI runners do not have access to a project ANTHROPIC_API_KEY.

## Contract enforced by `tests/live/__init__.py`

This package MUST NOT import `anthropic` directly. All SDK access goes
through `memory.managed_memory.client.ManagedClient`, which is the
only file in the repository allowed to import `anthropic`. A grep
guard verifies this:

```
grep -rE "^[[:space:]]*(import|from) anthropic" tests/live/
```

should return zero matches.
