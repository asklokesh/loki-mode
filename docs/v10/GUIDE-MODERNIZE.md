# loki modernize guide

`loki modernize` converts a legacy codebase to a modern target with no
human steps, using behavior captured from the old code as proof of
equivalence. It is a v10 engine subcommand (docs/v10/MODERNIZE.md is the
design source of truth; this page is the user-facing summary).

## What it does

- Inventories the repo, builds a dependency graph, and clusters files into
  units sized to convert in well under an agent's reliable working horizon.
- Prints a cost, wall-time and risk estimate before any model spend.
- Captures the old code's behavior (inputs, outputs, exceptions) as a
  sealed oracle, then converts each unit and checks the new code against
  that oracle case by case, held-out cases included.
- A unit is only ever claimed proven when its equivalence rate is 100% on
  every case. Anything less is reported as NOT PROVEN with the reason; it
  is never rounded up.
- Ships one pull request per wave of units, with old and new code coexisting
  behind a routing flag until every unit in that wave is proven.

## When to use it

Use it to port a legacy codebase (Python 2 to 3 today; Java 8 to 21 next)
where you want a paper trail of exactly what was proven equivalent and
what was not, rather than a model's unverified claim that the port works.
Do not use it for the existing `loki migrate` (a different, agent-judged
legacy engine); that command is unchanged and out of scope here.

Only two targets exist right now: `python3` and `java21`. COBOL-to-Java and
AngularJS-to-React are planned but not built.

## Commands and flags

```
loki modernize <repo> --to "<target>" [--budget USD] [--workers N] [--remote URL]
               [--resume <mid>] [--dry-run] [--provider P] [--no-pr]
```

| Flag | Meaning |
|---|---|
| `<repo>` | Required. Path to the repo to convert. |
| `--to` | Required. Target: `python3` or `java21`. An unrecognized target exits 2 and lists the supported ones. |
| `--budget` | USD hard cap for the whole run. Dispatch stops once spend plus the in-flight estimate would exceed it. |
| `--workers` | Concurrent unit workers. Default 4. Max 32 without `--remote`; use `--remote` for more. |
| `--remote` | Dispatches units to a remote worker cluster at the given URL instead of running them locally. |
| `--resume` | Resumes a prior run from its modernization id (`mod-<utc>-<short>`), picking up where the event log left off. |
| `--dry-run` | Runs inventory only: prints the unit count, wave plan and estimate, then exits 0 with zero model spend. |
| `--provider` | Overrides the model provider used for unit conversion. |
| `--no-pr` | Keeps everything local; skips opening a pull request. |

Running it with no arguments prints the same usage text.

## Worked example

Estimate a conversion with no spend, using up to 8 local workers:

```
loki modernize ./legacy-service --to python3 --dry-run --workers 8
```

This inventories the repo, clusters it into units, and prints the unit
count, wave plan, and cost/time/risk estimate, then stops. Nothing is
converted and no model is called.

To actually run it with a budget cap and no pull request:

```
loki modernize ./legacy-service --to python3 --budget 50 --no-pr
```

If it is interrupted, resume it with the modernization id it printed:

```
loki modernize ./legacy-service --to python3 --resume mod-20260928-ab12cd
```

## Limits

- Only `python3` and `java21` targets exist. Passing anything else fails
  with exit 2.
- Oracle capture, planning and execution beyond the dry-run estimate are
  still landing; a non-dry-run invocation today stops after printing the
  estimate and reports that oracle capture and execution are not built
  yet.
- The Java target's dependency graph builder is not wired in yet; a
  `java21` run reports that gap honestly instead of clustering on an
  empty graph.
- A unit is claimed proven only when its captured-case equivalence rate is
  100%, including held-out cases. Anything short of that stays NOT PROVEN
  with its reason; the tool never claims more than the evidence supports.
- `--workers` above 32 requires `--remote`; without it, the run fails
  rather than silently capping the value.
