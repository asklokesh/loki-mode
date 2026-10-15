# Harness attribution benchmark contract

Question answered: what does Loki add to the same underlying coding agent, and is the benefit worth its cost? This protocol turns "Loki beats Claude Code" from opinion into task-level evidence. It implements the benchmark protocol of the Loki Mode living review (comparison "harness attribution").

Status: pilot. Six tasks, small n. A pilot reports variance; it is not statistical proof of superiority. No result has been produced by this change; running the benchmark is a separate, paid step.

## Command

```bash
loki bench attribution --dry-run                       # validate task set, print plan, no model call
loki bench attribution --model <model-id> --execute    # run, spends API budget
loki bench attribution --report <result.json>          # re-render the markdown report
```

Source checkout only (the `benchmarks/` tree is not in the published npm package). Implementation: `benchmarks/bench/attribution.py`, reusing `benchmarks/bench/adapters` (process-tree reaping on timeout, the Claude JSON parser, the Loki adapter and its cost collection).

Options: `--tasks id,id`, `--repeats N` (default 1), `--model ID` (default `claude-sonnet-5`, or `LOKI_BENCH_MODEL`), `--budget-usd X` (default 5), `--timeout SECONDS` (default 900, capped by each task's `agent_timeout_s`), `--out-dir DIR`, `--tasks-dir DIR`.

Without `--execute` the command only prints the plan. `--dry-run` never probes tools and never spawns `claude` or `loki`.

## Arms and controls

| Control | raw_claude | loki |
|---|---|---|
| Command | `claude -p <prompt> --output-format json --model M --dangerously-skip-permissions --max-budget-usd B` | `loki start <prompt-file> --provider claude --no-dashboard --yes` |
| Model | `M` (exact id) | `LOKI_SESSION_MODEL=M` when M is an alias or a `claude-*` id |
| Permissions | skip-permissions | skip-permissions (the Loki claude provider default) |
| Budget | `--max-budget-usd B` | `LOKI_BUDGET_LIMIT=B` |
| Wall-clock cap | same, process tree reaped on timeout | same |
| Repo seed | byte-identical seed, fresh git repo with one fixed "seed" commit | same |
| Prompt text | task `prompt.md` inline | the same text as a PRD file kept outside the workspace |

Also controlled: runs are isolated in separate scratch directories; the arm that goes first alternates per task and repeat; the environment passed to child processes is scoped (no inherited tree); `LOKI_NO_BROWSER=1`.

Pinned and recorded in every result JSON: `claude --version`, `loki version`, Loki repo commit SHA, Python version, model id, budget, timeout, repeats, and per task the sha256 of the seed tree, the acceptance tree and the prompt.

Known, unavoidable differences (disclosed in every report): Loki receives the prompt as a PRD file and runs its own planning, review and verification loop; that overhead is the thing being measured. Provider comparisons (Loki on other backends) are out of scope here and must be run separately so model and harness effects are not mixed.

## Tasks

Pilot set under `benchmarks/attribution/tasks/<id>/`: 2 bug fixes, 2 features, 1 refactor, 1 integration.

```
task.json            id, class, prompt, seed, acceptance {dir, cmd, timeout_s}, reference, agent_timeout_s
prompt.md            the only instruction either arm sees
seed/                the agent workspace contents
acceptance/          HIDDEN test; copied into the workspace only after the run, overwriting same-named files
reference/           a known-good solution overlay; never shown to an agent, used only by tests
```

Hidden acceptance: the workspace is created from `seed/` only. After the agent finishes, `acceptance/` is copied over it and `acceptance.cmd` is run; exit code 0 means accepted. The loader rejects a task whose acceptance test also appears in the seed. Support files the test depends on (for example `service.py` in the integration task) are shipped in `acceptance/` so tampering is overwritten. The test suite asserts that every task fails on the unmodified seed and passes on its reference solution.

Neither arm grades itself. No council, RARV-C or LLM judge takes part in scoring.

Task selection is disclosed by the committed task directories. Add tasks by adding directories; the pilot mix check warns when the set differs from 2/2/1/1.

## Metrics

All computed per arm (and per task class) by `compute_metrics`; every run is a row, and failures, timeouts and harness errors stay in every denominator.

| Metric | Definition |
|---|---|
| Acceptance rate | accepted / assigned, with a 95% Wilson interval |
| False-completion rate | (reported success and not accepted) / reported success. Null when nothing reported success |
| Cost per accepted task | total measured spend across ALL attempts / accepted. Null (`undefined_no_accepted`) when none accepted |
| Unmeasured cost | A run with no cost figure is `unmeasured`, never zero. If some but not all runs are unmeasured, `cost_status` is `partial_lower_bound`, the per-accepted value is null and only a lower bound is given. If all are unmeasured, `unmeasured` |
| Elapsed time | median time over accepted runs, reported with the completion rate (completed / assigned), timeout count and error count; median over all runs is also given |

"Reported success" means: raw arm, `claude -p` exits 0 and its JSON has `is_error` false; Loki arm, `loki start` exits 0. Cost sources: raw arm uses the `total_cost_usd` Claude reports; Loki arm uses Loki's shared efficiency cost collection. Cost is API-dollar accounting; subscription consumption is not comparable and is not converted.

Not measured by this harness: human effort, recovery success, review quality. Report them separately and do not infer them from these results.

## Output

`--out-dir` (default `benchmarks/attribution/results/`) receives `attribution-<UTC stamp>.json` (plan, pinned environment, every row, summary) and the matching `.md` (pinned conditions, summary by arm, summary by class, task-level rows, disclosures). Publish failures, timeouts and exclusions with the report; do not drop rows.

## Interpreting a pilot

Use the pilot to size a larger run: variance per task, repeat count needed, timeouts. Do not claim superiority from overlapping confidence intervals on a handful of runs. Repeat with `--repeats` greater than 1 before drawing conclusions about rates.

## Tests

`python3 benchmarks/bench/tests/test_attribution.py` covers the metrics math, dry-run (asserts no process is spawned), plan ordering, task-set integrity, hidden-acceptance placement and tamper resistance. It makes no model call.
