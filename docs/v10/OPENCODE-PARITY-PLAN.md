# v11.4.0 plan: beat opencode by 1-2 points in every category

Founder directive (2026-10-15): close every gap an outside assessment found
against opencode. Keep Loki autonomous. Keep the harness and internals
(RARV-C, receipts, Seal, council) as they are, and keep Claude Code as the
primary provider. Ship all of it as one MINOR release, v11.4.0, built in
parallel. Under the founder's standing waiver nothing is tested.

Founder clarification (2026-10-15): `loki start` is always the primary
path. `loki chat` is an alternative surface. Every improvement in this
release (model routes, local models, providers, agents, routing, exit codes,
run summary, onboarding) must work through `loki start` first. Chat must hand
off to and from `loki start` without friction: `/run` in chat starts the same
run with the same model, provider and agents, and chat can attach to a
running or finished `loki start` session (status, steer, diff, verify).

## Scorecard target

| Category | Was (Loki / opencode) | Target | Slices |
|---|---|---|---|
| Everyday user experience | 6 / 8 | 10 | OC-CHAT, OC-OUTPUT |
| Installation and onboarding | 6 / 8 | 10 | OC-ONBOARD, OC-DOCS |
| Learning curve | 5 / 8 | 10 | OC-ROUTE, OC-HELP |
| Interactive coding and exploration | 6 / 9 | 10 | OC-CHAT |
| Small, targeted changes | 7 / 8 | 10 | OC-EDIT |
| Model/provider flexibility | 5 / 9 | 10 | OC-MODELS, OC-OPENCODE-E10 |
| Local-model setup | 5 / 8 | 10 | OC-MODELS |
| Multi-agent workflow design | 7 / 8 | 10 | OC-AGENTS |
| Documentation consistency | 4 / 7 | 10 | OC-DOCS |
| Predictability across commands/upgrades | 5 / 6 | 10 | OC-ROUTE, OC-EXIT, OC-PARITY-COST, OC-PARITY-ENFORCE |

## Todo (one slice each, parallel, own branch `slice-OC-<KEY>`)

- [x] OC-CHAT: `loki chat` opens an interactive session (the first cut
  also opened it from bare `loki` on a TTY; that was reverted, and bare `loki`
  stays unchanged). Plan mode is read-only and Build mode edits; `/plan`
  and `/build` switch between them. Slash commands: /run, /quick, /edit,
  /verify, /receipt, /model, /provider, /cost, /diff, /undo, /help, /exit.
  `loki chat --tui` launches Claude Code's own TUI.
- [x] OC-ROUTE: one predictable execution path. Flag-first calls, PRD files
  and one-word starts reach the same engine as the positional form. The
  legacy engine runs only on an explicit `--engine legacy` or
  `LOKI_ENGINE=legacy`. `loki route <args>` prints the engine and why.
- [x] OC-EXIT: close the three `loki verify` exit-code gaps and use one
  exit-code contract for verify, run, quick and edit. Update
  docs/exit-codes.md and remove the KNOWN-ISSUES entry.
- [x] OC-MODELS: model routes over the Claude harness, so every Tier-1
  control still works. Routes: `--model openrouter/<id>`, `ollama/<id>`,
  `lmstudio/<id>`, `llamacpp/<id>`, `vllm/<id>`, and any
  Anthropic-compatible base URL. `loki models` lists routes;
  `loki models --local` discovers local runtimes.
- [x] OC-PARITY-COST: engine10 measures cost for Codex, Cline and Aider.
- [x] OC-PARITY-ENFORCE: engine10 enforces the budget kill, a post-iteration
  guard scan and native sandbox flags for Codex, Cline, Aider and opencode.
  Receipts still list `kill blocking not enforced` because the scan is post-hoc.
- [x] OC-OPENCODE-E10: opencode becomes a supported engine10 provider.
- [x] OC-AGENTS: configurable child agents in `.loki/agents/*.md` (model,
  provider, tools, permissions, prompt), managed with
  `loki agents list|new|show`. Councils and reviewers use them when present,
  and they export to Claude Code subagents.
- [x] OC-EDIT: `loki edit "<change>"` makes a fast single-pass edit with no
  PR, plan or council. It shows the diff; `--verify` and `--receipt` are
  opt-in.
- [x] OC-ONBOARD: `loki setup` wizard and `loki doctor --fix`. Claude Code
  first, with required and optional prerequisites stated plainly.
- [x] OC-HELP: `loki help` shows the core verbs, `loki help all` shows the
  full surface, and `loki help <topic>` covers topics. Mistyped commands get
  "did you mean" suggestions, and `--json` works the same everywhere.
- [x] OC-OUTPUT: one run summary across engines (result, cost, time,
  receipt, next step), with `--quiet` and NO_COLOR honored.
- [ ] OC-START-INTEGRATION (after merge): wire every feature above into
  `loki start` (`--model <route>`, `--provider`, configured agents, unified
  summary, exit codes, explain-route). Bare `loki` keeps its current
  behavior and does not open chat. Seamless chat handoff: `/run` reuses the
  chat's model, provider and agents; `loki chat --attach` joins the current
  or last `loki start` session; the run summary's next step names
  `loki chat --attach`.
- [x] OC-DOCS (after merge; README, INSTALLATION, GUIDE, QUICKSTART and
  COMPARE-OPENCODE written): README, INSTALLATION, GUIDE and a new QUICKSTART
  agree with the code on prerequisites, the spend cap, routing and providers.
  Add docs/COMPARE-OPENCODE.md.
- [ ] Release: merge onto train-v11.4.0, rebuild loki-ts dist, write a full
  CHANGELOG v11.4.0 section, run `scripts/release.sh minor --bump-only`,
  push main, and confirm the release run.
