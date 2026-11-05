# CLI modernization inventory

Generated from `loki-ts/src/cli/registry.ts` by `bun loki-ts/scripts/gen-cli-modern-doc.ts`. Do not edit by hand; the registry guard fails when this file is stale.

Classes: KEEP (the 11 commands in `loki --help` and completions), HIDE (keeps working, never shown: machine consumers, CI, dev and enterprise ops), FOLD (behavior moves into the command in the Replacement column; the old name stays a hidden alias that runs unchanged; the replacement may not exist yet), REMOVED (no dependent found; bin/loki exits 2 with the replacement line).

## Counts

- KEEP: 12
- HIDE: 41
- FOLD: 61
- REMOVED: 30
- Total rows: 144
- Registry paths (commands and nested subcommands): 215

## Commands

| Command | Where dispatched | Class | Reason | Replacement |
| --- | --- | --- | --- | --- |
| version | loki-ts/src/cli.ts | HIDE | Bun-native, no legacy dependency |  |
| status | bun route, bash fallthrough | KEEP | Reads both engines; fold legacy fields into the v10 view |  |
| stats | loki-ts/src/cli.ts | HIDE | Deprecated alias; use report session |  |
| doctor | bun route, bash fallthrough | KEEP | Core onboarding gate |  |
| provider | bun route, bash fallthrough | FOLD | Provider-agnostic core | loki config set provider NAME |
| memory | bun route, bash fallthrough | HIDE | Memory still carries legacy store paths |  |
| rollback | bun route, bash fallthrough | FOLD | Checkpoint restore is engine-neutral | loki undo <run> |
| backup | autonomy/loki | HIDE | Enterprise retention and backup (D99 item 7) |  |
| restore | autonomy/loki | HIDE | Enterprise retention and backup (D99 item 7) |  |
| receipt | bun route, bash fallthrough | KEEP | The Evidence Receipt |  |
| proof | bun route, bash fallthrough | KEEP | Alias of receipt |  |
| wiki | bun route, bash fallthrough | FOLD | Bun-native knowledge feature | loki chat |
| control | bun route, bash fallthrough | KEEP | D56 control plane, on by default |  |
| runs | loki-ts/src/cli.ts | FOLD | R100-008: one list over the loki projects registry | loki status |
| intent | loki-ts/src/cli.ts | FOLD | Read-only intent view | loki status <run> |
| kpis | loki-ts/src/cli.ts | HIDE | Bun-native KPI report |  |
| report | bun route, bash fallthrough | HIDE | Mixed route; only kpis is Bun |  |
| trust | bun route, bash fallthrough | FOLD | Trust trajectory surface | loki status --json |
| crash | bun route, bash fallthrough | HIDE | Local-only crash plumbing |  |
| contract | loki-ts/src/cli.ts | HIDE | v10 delivery contract |  |
| start | bun route, bash fallthrough | KEEP | One engine (engine10); flags still legacy-shaped |  |
| slack | loki-ts/src/cli.ts | HIDE | Bun-native integration |  |
| queue | loki-ts/src/cli.ts | FOLD | Governor-aware batch of issue-mode runs | loki start owner/repo#1 owner/repo#2 |
| issues | loki-ts/src/cli.ts | FOLD | Mass issue pickup on the T7 queue | loki start owner/repo --label L --limit N --parallel K |
| undo | loki-ts/src/cli.ts | KEEP | UNDO-1/2: --plan is read-only, apply behind LOKI_UNDO=1 |  |
| verify-pr | loki-ts/src/cli.ts | FOLD | VPR-2: fail-to-pass check, LOKI_VERIFY_PR=1 | loki verify <PR url> |
| answer | loki-ts/src/cli.ts | FOLD | v10 blocked-run flow | loki start --answer "<text>" |
| engine10 | loki-ts/src/cli.ts | HIDE | The v10 engine |  |
| internal | loki-ts/src/cli.ts | HIDE | Hidden plumbing |  |
| completion | loki-ts/src/cli.ts | HIDE | Hidden plumbing; completions install themselves |  |
| __complete | loki-ts/src/cli.ts | HIDE | Hidden plumbing for generated completions |  |
| help | autonomy/loki | HIDE | Core |  |
| chat | autonomy/loki | KEEP | Provider-neutral conversational verb |  |
| edit | autonomy/loki | FOLD | Provider-neutral single-edit verb | loki "<change>" --no-pr |
| diff | autonomy/loki | FOLD | Passes extra args to git diff | loki status <run> |
| models | autonomy/loki | FOLD | Provider-neutral model tiers | loki config list |
| setup | autonomy/loki | FOLD | Onboarding gate | loki doctor --fix |
| quick | autonomy/loki | FOLD | Routes to the v10 lean path by default | loki "<task>" --no-pr |
| quickstart | autonomy/loki | FOLD | Onboarding path | loki "<idea>" in an empty folder |
| init | autonomy/loki | REMOVED | Templates predate v10 | Use: loki "<idea>" in an empty folder |
| template | autonomy/loki | REMOVED | Engine-neutral | Use: loki start "<one-line goal>" |
| verify | autonomy/loki | KEEP | Legacy proof vs v10 verify split |  |
| keys | autonomy/loki | FOLD | Receipt signing | loki receipt key |
| review | autonomy/loki | HIDE | Gates are legacy-shaped |  |
| dashboard | autonomy/loki | FOLD | Overlaps Control Plane | loki control serve |
| config | autonomy/loki | KEEP | Mixed legacy keys |  |
| mcp | autonomy/loki | HIDE | Engine-neutral |  |
| acp | autonomy/loki | HIDE | Engine-neutral |  |
| stop | autonomy/loki | KEEP | Session control |  |
| pause | bun route, bash fallthrough | FOLD | Session control; Bun writes the Loki 10 run request, bash keeps the legacy PAUSE file | loki stop --graceful |
| resume | bun route, bash fallthrough | FOLD | Session control; Bun clears a Loki 10 pause, bash keeps the legacy resume | loki start |
| cancel | bun route, bash fallthrough | FOLD | Session control; Loki 10 only | loki stop --graceful |
| why | autonomy/loki | FOLD | Outcome explainer | loki status |
| next | autonomy/loki | FOLD | Guided flow | loki status |
| logs | autonomy/loki | FOLD | Engine-neutral | loki status |
| ship | autonomy/loki | REMOVED | Delivery | Use: loki deploy |
| deploy | autonomy/loki | KEEP | Delivery |  |
| import | autonomy/loki | REMOVED | Spec intake | Use: loki start <ref or file> |
| github | autonomy/loki | HIDE | Integration |  |
| issue | autonomy/loki | REMOVED | Issue-mode | Use: loki start owner/repo#N |
| ci | autonomy/loki | HIDE | Engine-neutral |  |
| modernize | bun route, bash fallthrough | HIDE | Routed to engine10 modernize |  |
| share | autonomy/loki | FOLD | Engine-neutral | loki receipt share |
| assets | autonomy/loki | REMOVED | Engine-neutral | Use: loki chat |
| export | autonomy/loki | FOLD | Duplicates report export | loki verify <run> --sarif |
| notify | autonomy/loki | FOLD | Engine-neutral | loki status |
| tour | autonomy/loki | FOLD | Onboarding | loki start outside a repo |
| wow | autonomy/loki | FOLD | Onboarding: loki tour --live | loki start outside a repo |
| try | autonomy/loki | REMOVED | Onboarding: never touches your checkout | Use: loki start <repo url> --no-pr from a fresh clone |
| factory | autonomy/loki | FOLD | propose, execute, operate unchanged | loki start -v |
| welcome | autonomy/loki | FOLD | Onboarding | loki doctor |
| onboard | autonomy/loki | FOLD | Overlaps wiki | loki chat |
| setup-skill | autonomy/loki | FOLD | Setup | loki doctor --fix |
| self-update | autonomy/loki | HIDE | Maintenance |  |
| self_update | autonomy/loki | HIDE | Alias of self-update |  |
| update | autonomy/loki | HIDE | Alias of self-update |  |
| remote | autonomy/loki | REMOVED | Engine-neutral | Use: loki status |
| rc | autonomy/loki | REMOVED | Alias of remote |  |
| cockpit | autonomy/loki | FOLD | Engine-neutral | loki control serve |
| code | autonomy/loki | REMOVED | Overlaps wiki | Use: loki chat |
| context | autonomy/loki | REMOVED | Engine-neutral | Use: loki chat |
| ctx | autonomy/loki | REMOVED | Alias of context |  |
| secrets | autonomy/loki | HIDE | Security |  |
| api | autonomy/loki | FOLD | Engine-neutral | loki control serve |
| sandbox | autonomy/loki | HIDE | Isolation |  |
| docker | autonomy/loki | HIDE | Isolation |  |
| web | autonomy/loki | HIDE | Overlaps Control Plane UI |  |
| preview | autonomy/loki | FOLD | Delivery | loki deploy |
| telemetry | autonomy/loki | FOLD | Privacy surface | loki config set telemetry off |
| otel | autonomy/loki | FOLD | Alias of telemetry |  |
| syslog | autonomy/loki | HIDE | Legacy log paths |  |
| explain | autonomy/loki | FOLD | Knowledge | loki chat |
| docs | autonomy/loki | FOLD | Core | loki help |
| test | autonomy/loki | HIDE | Legacy runner |  |
| bench | autonomy/loki | HIDE | Engine-neutral |  |
| voice | autonomy/loki | REMOVED | Experimental | Use: loki start |
| own | autonomy/loki | FOLD | Legacy handoff | loki chat |
| handoff | autonomy/loki | FOLD | Alias of own |  |
| secure | autonomy/loki | REMOVED | Security | Use: loki doctor |
| compliance | autonomy/loki | HIDE | Enterprise |  |
| enterprise | autonomy/loki | HIDE | Enterprise |  |
| projects | autonomy/loki | FOLD | Engine-neutral | loki control serve |
| audit | autonomy/loki | HIDE | Enterprise |  |
| cost | autonomy/loki | FOLD | Duplicates report cost | loki start --dry-run |
| metrics | autonomy/loki | HIDE | Duplicates report metrics |  |
| sentrux | autonomy/loki | FOLD | Legacy gate input | loki start |
| magic | autonomy/loki | HIDE | Legacy UI generator |  |
| estimate | autonomy/loki | FOLD | Estimates the legacy PRD flow | loki start <PRD> --dry-run |
| plan | autonomy/loki | FOLD | Legacy PRD flow | loki start <PRD> --dry-run |
| grill | autonomy/loki | FOLD | Legacy PRD flow | loki start <PRD> --dry-run |
| spec | autonomy/loki | FOLD | Legacy PRD flow | loki start <PRD> --dry-run |
| backlog | autonomy/loki | FOLD | Drives legacy RARV per issue | loki start owner/repo --label L --parallel K |
| workspace | autonomy/loki | HIDE | Control Plane spawns workspace run; users get it via start --workspace |  |
| council | autonomy/loki | REMOVED | Legacy RARV gate | It drove the removed legacy loop; use: loki start "<goal>" |
| compound | autonomy/loki | REMOVED | Legacy memory pipeline | It drove the removed legacy loop; use: loki start "<goal>" |
| cluster | autonomy/loki | REMOVED | Legacy RARV | It drove the removed legacy loop; use: loki start "<goal>" |
| optimize | autonomy/loki | REMOVED | Legacy RARV | It drove the removed legacy loop; use: loki start "<goal>" |
| ultracode | autonomy/loki | REMOVED | Legacy Claude-only | It drove the removed legacy loop; use: loki start "<goal>" |
| monitor | autonomy/loki | REMOVED | Legacy engine state | It drove the removed legacy loop; use: loki start "<goal>" |
| watch | autonomy/loki | REMOVED | PRD flow | Rerun with: loki start <PRD> |
| watchdog | autonomy/loki | REMOVED | Legacy engine | It drove the removed legacy loop; use: loki start "<goal>" |
| cleanup | autonomy/loki | REMOVED | Legacy run.sh orphans | It drove the removed legacy loop; use: loki start "<goal>" |
| state | autonomy/loki | FOLD | Legacy engine | loki start "<goal>" |
| agent | autonomy/loki | FOLD | Legacy engine | loki start "<goal>" |
| agents | autonomy/loki | HIDE | Custom child agents are still read by reviewers |  |
| trigger | autonomy/loki | HIDE | Event automation server (FR03 extends it) |  |
| failover | autonomy/loki | FOLD | Legacy engine | loki start "<goal>" |
| reset | autonomy/loki | REMOVED | Legacy engine | It drove the removed legacy loop; use: loki start "<goal>" |
| merge | autonomy/loki | HIDE | Control Plane merge list and run |  |
| heal | autonomy/loki | HIDE | Referenced by docs; no engine10 consumer verified |  |
| migrate | autonomy/loki | FOLD | Superseded by modernize | loki "modernize <what> to <target>" |
| dogfood | autonomy/loki | REMOVED | Legacy engine | It drove the removed legacy loop; use: loki start "<goal>" |
| steer | autonomy/loki | FOLD | Session control | loki chat --attach |
| outcomes | autonomy/loki | REMOVED | Legacy outcome store | It drove the removed legacy loop; use: loki start "<goal>" |
| worktree | autonomy/loki | REMOVED | Legacy parallel mode | It drove the removed legacy loop; use: loki start "<goal>" |
| wt | autonomy/loki | REMOVED | Alias of worktree |  |
| checkpoint | autonomy/loki | FOLD | Legacy engine | loki undo |
| cp | autonomy/loki | FOLD | Alias of checkpoint |  |
| analyze | autonomy/loki | FOLD | Legacy analyze flow | loki start "<goal>" |
| demo | autonomy/loki | FOLD | Legacy engine demo | loki start outside a repo |
| run | autonomy/loki | FOLD | Alias; use start | loki start |
| trust-metrics | autonomy/loki | REMOVED | Alias; use trust detail | Use: loki status --json |
| serve | autonomy/loki | FOLD | Alias; use api start | loki control serve |
| open | autonomy/loki | REMOVED | Alias; use dashboard open | Use: loki control serve |

## Registry gaps (nested paths dispatched but not yet in the registry)

- audit: 8
- code: 5
- compliance: 1
- config: 4
- context: 5
- cost: 7
- deploy: 1
- docs: 4
- enterprise: 2
- explain: 5
- export: 7
- github: 7
- import: 1
- init: 21
- issue: 2
- magic: 12
- memory: 7
- metrics: 7
- modernize: 3
- next: 1
- notify: 6
- onboard: 5
- own: 1
- pause: 1
- preview: 1
- projects: 8
- proof: 5
- provider: 3
- quick: 1
- resume: 1
- rollback: 2
- secrets: 3
- secure: 3
- setup-skill: 1
- share: 7
- ship: 1
- syslog: 3
- telemetry: 1
- template: 4
- version: 1
- web: 1
