# Core verbs (CLI reference)

The 11 commands in `loki --help`, with their main flags. The complete generated
command table is `docs/CLI-REFERENCE.md` (do not edit that file by hand).
`loki help` prints the 11; `loki help all` adds the hidden and renamed commands;
`loki help <topic>` prints a topic (start, models, providers, agents, verify,
exit-codes, config); `loki help <command>` runs `<command> --help`. Every other command keeps working
unchanged; it is just not shown on the front page.

`loki start` is the primary path. Everything else is a shortcut, a check, or an
alternative surface for the same engine. Claude Code is the default Tier-1
provider; other providers and model routes are additions selected with
`--provider` or `LOKI_MODEL_ROUTE`.

## The 11 commands

| Command | What it does |
| --- | --- |
| `loki "<goal>"` | Build it: a goal, a PRD file or an issue (`owner/repo#N`). Shorthand for `loki start` |
| `loki start [SPEC]` | The primary path. Build from a PRD file, an issue (`owner/repo#N`, issue URL, `PROJ-1`), a quoted task or a one-word brief. Alias: `run` |
| `loki chat [--attach]` | Interactive alternative to `loki start`; `--attach` joins the running build |
| `loki status [--json]` | What is running and where it stands |
| `loki verify [base] [--fast] [--json] [--pubkey FILE]` | Deterministic verification with CI-gate exit codes |
| `loki receipt [run]` | The proof-of-run receipt (`list`, `show`, `open`, `share`, `badge`, `md`, `bundle`). `proof` is the old name and still works |
| `loki stop` | Stop the running build |
| `loki undo <run> [--plan]` | Plan or apply an undo of a run |
| `loki deploy` | Deploy a VERIFIED run |
| `loki doctor [--fix] [--json]` | Check prerequisites, providers and login. `--fix` creates state dirs and a default config and prints exact commands for the rest; never runs sudo |
| `loki config list\|get\|set\|path\|show\|validate` | Settings; `config list --json` for machines |
| `loki control serve` | The local UI (Control Plane): `serve`, `stop`, `status`, `backfill`, `prune` |

`start` flags: `--no-pr`, `--deep`, `--provider NAME`, `--model ID`, `--max-cost USD`
(aliases `--budget`, `--budget-limit`), `--session-model TIER`, `-v` (verbose),
`--quiet`, `--json`, `--detach` (`-d`), `--engine legacy|engine10`, `--explain-route`. Flags that
only the previous loop honors (`--simple`, `--complex`, `--parallel`,
`--isolation`, `--sandbox`, `--max-iterations`, `--compliance`, ...) send that
one call to the previous loop with a one-line notice.

### Run in the background

`loki start "<task>" --detach` (also `loki "<task>" --detach`, `loki owner/repo#N --detach`, `loki quick ... --detach`) starts the run in its own session and returns at once, so closing the terminal or logging out does not stop it. It prints the pid and the log path (`.loki/logs/detached-*.log`); follow it with `loki status --follow`, stop it with `loki cancel`. When it finishes it reports as a foreground run does: a VERIFIED run opens a ready PR, a PARTIAL run a draft PR, an issue run posts its status comment, and Slack gets the PR, blocked, stuck and finished messages when `LOKI_SLACK_WEBHOOK_URL` is set (see `docs/slack.md`). Exit code: 0 once detached; if the engine refuses or fails within the first `LOKI_DETACH_SETTLE_S` seconds (default 3) the launcher prints the log tail and exits with the engine's own code, and a refusal that comes later lands only in the log (also check `loki status`). Two runs in one checkout are refused by the run lock. The detached run has no terminal, so prompts and the cost forecast behave as in CI. On macOS the run holds a `caffeinate -i` assertion, which blocks idle sleep only: a closed lid on battery still sleeps the Mac. For a run that must survive that, use a machine that stays on, such as the issue-to-pr workflow on a `runs-on: self-hosted` runner (`docs/examples/loki-issue-to-pr.yml.example`, not changed or tested by this feature). Not yet supported with `--spec` or `--attempts`.

Spend cap: `--max-cost`, else `budgets.per_run` in `loki.yaml`, else $100 when
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, else no dollar cap
(subscription). Model routes: `LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start prd.md`.

Every run ends with one unified summary on both engines: `Result:`, `Files:`,
`Cost:` (marked `(estimated)` or `not measured`), `Elapsed:`, `Receipt:` and a
`next:` line. `--quiet` prints only that block; `--json` adds a `summary`
object; `NO_COLOR=1` disables color.

### loki chat

Needs a TTY (otherwise exit 2; use `loki quick`). Starts in Plan mode
(read-only); `/plan` and `/build` switch. Slash commands: `/plan`, `/build`,
`/run <prd|brief>` (starts a normal `loki start` run with the chat's model and
provider), `/quick`, `/edit`, `/verify`, `/receipt`, `/cost`, `/diff`, `/undo`,
`/model <id>`, `/provider <name>`, `/help`, `/exit`. `loki chat --attach` joins a
running or the last `loki start` session (`/status`, `/steer`, `/diff`,
`/verify`, `/receipt`, `/stop`). `loki chat --tui` launches the Claude Code TUI
with Loki context. Bare `loki` does not open chat.

### loki edit (renamed, still works)

`loki edit [paths...] "<change>"` with `--verify` (fast verifier), `--receipt`
(unsigned receipt in `.loki/edit-receipts/`), `--commit` (only touched files, by
name; skipped when verify failed) and `--dry-run` (plan only). `LOKI_EDIT_MODEL`
overrides the model. Claude provider only for now.

## Commands that moved

Nothing was removed in this release: every command below still runs exactly as
before and is only hidden from `loki --help` and completions. The Replacement
column is where its behavior is going; a few targets arrive in later releases
(for example `loki start --answer` and `loki receipt key`), and until each one
lands the old name is the way to do it. `loki help all` prints this list and the
hidden commands for machine consumers, CI and operators (`review`, `merge`,
`workspace`, `trigger`, `memory`, `report`, `mcp`, `acp`, ...). The full table,
with the planned removal of commands that have no dependents, is the generated
`docs/CLI-INVENTORY.md`.

| Old command | Replacement |
| --- | --- |
| `quick "<task>"`, `edit "<change>"` | `loki "<task>" --no-pr` |
| `run`, `resume` | `loki start` |
| `answer` | `loki start --answer "<text>"` |
| `steer` | `loki chat --attach` |
| `issues`, `queue`, `backlog` | `loki start owner/repo ...` |
| `plan`, `estimate` | `loki start <PRD> --dry-run` |
| `setup` | `loki doctor --fix` |
| `models`, `provider` | `loki config` |
| `proof`, `keys` | `loki receipt` |
| `verify-pr` | `loki verify <PR url>` |
| `rollback` | `loki undo <run>` |
| `dashboard` | `loki control serve` |
| `why`, `trust` | `loki status` |
| `quickstart`, `tour`, `demo`, `wow`, `factory` | `loki start` (first run) |
| `docs` | `loki help` |

`loki route [start|quick] <args> [--json]` still prints the engine, provider,
model, input type and reason without running anything.

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
