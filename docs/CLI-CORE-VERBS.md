# Core verbs

The commands most people use, with their main flags. The complete generated
command table is `docs/CLI-REFERENCE.md` (do not edit that file by hand).
`loki help` prints the grouped summary; `loki help all` prints every command;
`loki help <topic>` prints a topic (start, models, providers, agents, verify,
exit-codes, config).

Claude Code is the default provider. Other providers and model routes are
additions selected with `--provider` or `loki provider set`.

## Start

| Command | What it does |
| --- | --- |
| `loki chat` | Interactive session |
| `loki start [SPEC]` | Build from a PRD file, an issue (`owner/repo#N`, `PROJ-1`) or no argument. Alias: `run` |
| `loki edit "<change>"` | One targeted change to the current repo |
| `loki quick "<task>"` | One small task, no PR |

`start` flags: `--provider NAME`, `--simple`, `--complex`, `--no-dashboard`,
`--isolation none|worktree|docker`, `--spec FILE`, `--budget USD`,
`--config PATH`, `--compliance PRESET`.

## Check

| Command | What it does |
| --- | --- |
| `loki status [--json]` | Current run status |
| `loki verify [--fast] [--json] [--pubkey FILE]` | Deterministic verification with CI-gate exit codes |
| `loki receipt` (alias of `proof`) | Inspect the proof-of-run receipt |
| `loki undo <run> [--plan]` | Plan or apply an undo of a run |

## Configure

| Command | What it does |
| --- | --- |
| `loki setup` | First-run setup |
| `loki config [show\|list\|set\|get\|validate\|path]` | Settings; `config list --json` for machines |
| `loki models [--local]` | Model tiers and routes; `--local` shows local models |
| `loki agents` / `loki route "<task>"` | Agent roles; where a task would be routed |
| `loki doctor [--json]` | Check the setup |
| `loki provider list\|set NAME` | Providers and install status |

`chat`, `route`, `agents` and `models --local` are delivered by sibling work in
the same release as this help rework.

## --json

`status`, `doctor`, `verify`, `config list` and `models` accept `--json`.
`status` and `doctor` emit native JSON. `verify` and `config list` emit one
object from the shared helper `autonomy/lib/json-output.sh`:

```json
{"command": "verify", "exit_code": 0, "ok": true, "output": "..."}
```

The process exit code equals `exit_code`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Failure |
| 2 | Usage error (unknown command or flag) |
| 3 | Missing component |

Severity rises with the code. Per-command detail: `docs/exit-codes.md`.

## Unknown commands

An unknown command prints a "Did you mean" suggestion (edit distance), points
to `loki help` and `loki help all`, and exits 2.
