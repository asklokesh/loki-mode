# Magic Modules A/B Benchmark

Measures whether the Magic Modules debate gate actually changes outcomes
versus running with the gate disabled, on the same PRD.

## What it does

For a single PRD, runs `loki start` twice:
1. **A: gate ON** — `LOKI_GATE_MAGIC_DEBATE=true` (the default)
2. **B: gate OFF** — `LOKI_GATE_MAGIC_DEBATE=false`

Captures from each run:
- Iteration count
- Wall-clock duration
- Number of magic specs in `.loki/magic/specs/`
- Number of magic components in `.loki/magic/registry.json`
- Number of distinct files modified
- Token cost from `.loki/metrics/efficiency/` (if present)
- Final status (completed / max-iterations / error)

Emits a side-by-side comparison table.

## Why it exists

Past audits (see `docs/audits/v6.76.x-honest-audit.md`) noted that the magic
debate gate had been claimed to improve accessibility / performance / consistency
of generated UI components, but no measurement had ever been done. This bench
is the answer.

## Honesty notes

This benchmark requires a real provider invocation (Claude CLI logged in).
Running it costs real tokens. Do NOT run as part of CI by default.

The "quality" axis is hard to measure objectively. We measure the cheap
proxies (file count, iteration count, debate pass rate, token cost). For
true quality you still need to open the generated components in a browser
and inspect them.

## Usage

```bash
cd benchmarks/magic-ab
./run.sh                          # uses prd.md, default 8 iteration budget per arm
./run.sh --max-iterations 4       # quick check
./run.sh --prd ./other-prd.md     # custom PRD
./run.sh --skip-a                 # only run gate-OFF
./run.sh --skip-b                 # only run gate-ON
```

After both arms finish:

```bash
python3 compare.py results/A-*.json results/B-*.json
```
