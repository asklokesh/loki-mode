# real-run: real scenarios against the installed tarball

`scripts/real-run.sh <scenario>` exists because every real bug found in the D91 push came from a real run, not a fixture. It never touches the repo checkout: it runs `npm pack --ignore-scripts` (so the committed `loki-ts/dist` is what ships), installs the tarball into a temp prefix under a run-owned temp dir, and runs the scenario with `LOKI_NO_SKILL_LINK_HEAL=1 LOKI_NO_BROWSER=1` against that installed `loki`.

## Usage

```bash
bash scripts/real-run.sh --dry trivial-sum        # pack + install + fixture, no model call (CI-safe)
bash scripts/real-run.sh --validate router-on      # parse the scenario file only
bash scripts/real-run.sh --check-receipt R.json trivial-sum   # apply receipt assertions to a file
bash scripts/real-run.sh --tsv-out results.tsv trivial-sum    # BILLED: real model run
```

Env: `REAL_RUN_TARBALL` reuses a tarball, `REAL_RUN_TIMEOUT` (default 1200s) bounds the loki call, `REAL_RUN_SCENARIO_DIR` overrides the scenario directory, `REAL_RUN_TSV` is the default for `--tsv-out`.

## Scenarios

Files `tests/real-run/scenarios/<name>.sh`, sourced by the script. Shipped: `trivial-sum` (about $0.10), `two-bug`, `attempts-2`, `router-on`, `issues-dry-run` (needs network, no model).

| Variable | Meaning |
| --- | --- |
| `SC_DESC` | one line description |
| `SC_BILLED` | 1 if the scenario calls a model |
| `SC_FIXTURE` | generator name under `scripts/b9-fixtures/` (`trivial-sum`, `two-bug`) |
| `SC_ARGS` | array of loki arguments |
| `SC_ENV` | array of `NAME=value` entries |
| `SC_RECEIPT` | array of assertions on the newest `.loki/runs/*/receipt.json`: `path == v`, `!=`, `<=`, `>=`, or `path exists` (dotted path, for example `cost.usd`) |
| `SC_CONSOLE` | array of extended regexes that must match the console output |

## Output

One `PASS`/`FAIL` line per assertion; exit 1 on any FAIL, 2 on usage or scenario errors. A TSV line is printed (and appended with `--tsv-out`): `ts scenario verdict wall_s cost_usd input_tokens output_tokens result`. Fields the receipt does not carry are `NA`, never 0. B9 and the 10x metrics can reuse the TSV.

`tests/test-real-run.sh` covers scenario parsing, the `--dry` install from the packed tarball, and assertion failure on a doctored receipt.
