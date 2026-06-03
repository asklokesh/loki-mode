# Adapter Output Schema (R2 benchmark harness)

Frozen contract. Source of truth: `benchmarks/bench/bench_schema.py`
(`SCHEMA_VERSION = "1.0"`). Adapters (Slice C) build against this.

## The hard boundary

An adapter runs ONE tool on a prepared workdir and reports cost + provenance.
**An adapter NEVER reports success, quality, passed, score, or any outcome.**
The GRADER (`runner.grade`) decides success by running the held-out acceptance
command outside the agent and reading its exit code. This is enforced in code:
`validate_adapter_output()` REJECTS any dict carrying a forbidden judgment key
(`success`, `quality`, `passed`, `score`, `graded`, `verdict`, `pass`, `fail`,
`result`, `won`, `winner`).

## Adapter interface

Call convention (Slice C, what the runner actually invokes):

    run(workdir, spec, *, model="...", timeout=<seconds>, runner=None) -> dict

- `workdir` -- the prepared temp dir (fixture already copied in).
- `spec` -- a PATH to a prompt/message file inside the workdir. NAME COLLISION
  WARNING: this is NOT the task-spec dict. The runner materializes
  `task_spec["prompt"]` into `BENCH_PROMPT.md` in the workdir and passes that
  path. Adapters consume it as a path: `loki start <spec>`,
  `aider --message-file <spec>`, `claude -p <spec contents>`.
- `model` -- model/provider label.
- `timeout` -- hard wall-clock cap in seconds (NOTE: keyword is `timeout`, not
  `timeout_s`; the runner maps the task-spec `agent_timeout_s` to this).
- `runner` -- injectable `subprocess.run`-compatible callable so tests drive the
  adapter end-to-end with NO paid calls (used by `_base.run_cli`).

`manual.py` is the exception: `run(workdir=None, spec=None, *, manual_entry=,
tool=)`. It records externally-supplied numbers and is NOT invoked through the
uniform path above (default VS_TOOLS keeps it off the hot path).

Output (the adapter returns, as a JSON object):

| Field | Type | Notes |
|---|---|---|
| `tool` | string (required) | tool identifier, e.g. `loki`, `aider`, `claude_code` |
| `tool_version` | string (required) | pinned version; `verify` re-checks it |
| `model_used` | string (required) | model the tool actually used |
| `duration_s` | number (required) | wall-clock of the agent run |
| `iterations` | int | tool-reported iterations, `0` if n/a |
| `tokens_in` | int or null | null == unknown |
| `tokens_out` | int or null | null == unknown |
| `cost_usd` | number or null | **null == NOT collected. Never coerce to 0.** |
| `cache_read_tokens` | int | default `0` |
| `cache_creation_tokens` | int | default `0` |
| `exit_status` | string (required) | `completed` \| `timeout` \| `error_rc_N` |
| `provenance` | object (required) | how the number was produced; `verified: false` for externally supplied (manual.py) |

## Cost source

The runner aggregates cost from adapter-output. The loki adapter populates
`cost_usd` via the shared efficiency module
`autonomy/lib/efficiency_cost.py::_collect_efficiency(loki_dir) -> (cost, model)`
(extracted from `proof-generator.py` by Slice C). Until that module exists the
runner falls back to loading `proof-generator.py` by path. In both cases the
cost dict shape is exactly proof-generator's:
`{usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens}`,
and `usd = None` means "not collected" (kept, never zeroed).

## Helpers

- `validate_adapter_output(out) -> [problems]` (empty list == valid; rejects forbidden keys)
- `normalize_adapter_output(out) -> dict` (fills optional defaults, preserves null cost/tokens)
