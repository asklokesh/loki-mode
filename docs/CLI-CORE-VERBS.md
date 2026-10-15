# Core verbs (CLI reference)

The commands most people use, with their main flags. The complete generated
command table is `docs/CLI-REFERENCE.md` (do not edit that file by hand).
`loki help` prints the grouped summary; `loki help all` prints every command;
`loki help <topic>` prints a topic (start, models, providers, agents, verify,
exit-codes, config); `loki help <command>` runs `<command> --help`. Scripts that
parse the old default `loki help` output must switch to `loki help all`.

`loki start` is the primary path. Everything else is a shortcut, a check, or an
alternative surface for the same engine. Claude Code is the default Tier-1
provider; other providers and model routes are additions selected with
`--provider` or `LOKI_MODEL_ROUTE`.

## Start

| Command | What it does |
| --- | --- |
| `loki start [SPEC]` | The primary path. Build from a PRD file, an issue (`owner/repo#N`, issue URL, `PROJ-1`), a quoted task or a one-word brief. Alias: `run`. Shorthand: `loki "<task>"`, `loki owner/repo#N` |
| `loki edit "<change>"` | One targeted change to the current repo in one pass. No PRD, plan, council, PR or branch switch |
| `loki quick "<task>"` | One small task with a verify loop, no PR |
| `loki chat` | Interactive alternative to `loki start` (Plan and Build modes, slash commands) |

`start` flags: `--no-pr`, `--deep`, `--provider NAME`, `--max-cost USD`
(aliases `--budget`, `--budget-limit`), `--session-model TIER`, `-v` (verbose),
`--quiet`, `--json`, `--engine legacy|engine10`, `--explain-route`. Flags that
only the previous loop honors (`--simple`, `--complex`, `--parallel`,
`--isolation`, `--sandbox`, `--max-iterations`, `--compliance`, ...) send that
one call to the previous loop with a one-line notice.

Spend cap: `--max-cost`, else `budgets.per_run` in `loki.yaml`, else $100 when
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, else no dollar cap
(subscription). Model routes: `LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start prd.md`.

### loki edit

`loki edit [paths...] "<change>"` with `--verify` (fast verifier), `--receipt`
(unsigned receipt in `.loki/edit-receipts/`), `--commit` (only touched files, by
name; skipped when verify failed) and `--dry-run` (plan only). `LOKI_EDIT_MODEL`
overrides the model. Claude provider only for now.

### loki chat

Needs a TTY (otherwise exit 2; use `loki quick`). Starts in Plan mode
(read-only); `/plan` and `/build` switch. Slash commands: `/plan`, `/build`,
`/run <prd|brief>` (starts a normal `loki start` run with the chat's model and
provider), `/quick`, `/edit`, `/verify`, `/receipt`, `/cost`, `/diff`, `/undo`,
`/model <id>`, `/provider <name>`, `/help`, `/exit`. `loki chat --attach` joins a
running or the last `loki start` session (`/status`, `/steer`, `/diff`,
`/verify`, `/receipt`, `/stop`). `loki chat --tui` launches the Claude Code TUI
with Loki context. Bare `loki` does not open chat.

## Check

| Command | What it does |
| --- | --- |
| `loki status [--json]` | Current run status |
| `loki verify [--fast] [--json] [--pubkey FILE]` | Deterministic verification with CI-gate exit codes |
| `loki receipt` (alias of `proof`) | Inspect the proof-of-run receipt |
| `loki diff` / `loki undo <run> [--plan]` | Show what a run changed; plan or apply an undo |
| `loki route [start\|quick] <args> [--json]` | Print the engine, provider, model, input type and reason without running |

Every run ends with one unified summary on both engines: `Result:`, `Files:`,
`Cost:` (marked `(estimated)` or `not measured`), `Elapsed:`, `Receipt:` and a
`next:` line. `--quiet` prints only that block; `--json` adds a `summary`
object; `NO_COLOR=1` disables color.

## Configure

| Command | What it does |
| --- | --- |
| `loki setup [--yes] [--check]` | First-run wizard: tools, Claude login, provider, model route, spend cap. Flags: `--provider`, `--model`, `--budget USD`, `--global` |
| `loki doctor [--fix] [--json]` | Check prerequisites, providers and login. `--fix` creates state dirs and a default config and prints exact commands for the rest; never runs sudo |
| `loki config list\|get\|set\|path\|show\|validate` | Settings; `config list --json` for machines |
| `loki models [--local] [--json]` | Model routes (openrouter, ollama, lmstudio, llamacpp, vllm, custom); `--local` probes local runtimes and prints ready-to-paste values |
| `loki agents list\|new\|show\|export --claude` | Custom child agents in `.loki/agents/*.md` (project) or `~/.config/loki/agents/` (user). `loki agent` (singular) is the unchanged built-in agent-type command |
| `loki provider list\|set NAME` | Providers and install status |

## --json

`status`, `doctor`, `verify`, `config list` and `models` accept `--json`.
`status`, `doctor` and `models` emit native JSON. `verify` and `config list`
emit one object from the shared helper `autonomy/lib/json-output.sh`:

```json
{"command": "verify", "exit_code": 0, "ok": true, "output": "..."}
```

The process exit code equals `exit_code`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Failure |
| 2 | Usage error for an unknown command, or setup error |
| 3 | Missing component, or verifier error |
| 64 | Usage error for `verify`, `quick` and `start` (unknown option, missing task) |

Severity rises with the code. `loki verify` codes and the CI-gate guidance are
in `docs/exit-codes.md`.

## Unknown commands

An unknown command prints a "Did you mean" suggestion (edit distance), points
to `loki help` and `loki help all`, and exits 2. A bare one-word `loki <word>`
is the command namespace; use `loki start <word>` for a one-word brief.
