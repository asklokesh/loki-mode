# CLI modernization inventory

Generated from `loki-ts/src/cli/registry.ts` by `bun loki-ts/scripts/gen-cli-modern-doc.ts`. Do not edit by hand; the registry guard fails when this file is stale.

Classes: KEEP-MODERN (v10-native or engine-neutral), UPDATE (live but needs modernizing), DROP-LEGACY (drives only the legacy engine; removed under LEGACY-ZERO, hidden from help and completions meanwhile), DELETE (deprecated alias).

## Counts

- KEEP-MODERN: 61
- UPDATE: 22
- DROP-LEGACY: 31
- DELETE: 14
- Total rows: 128
- Registry paths (commands and nested subcommands): 177

## Commands

| Command | Where dispatched | Class | Reason |
| --- | --- | --- | --- |
| version | loki-ts/src/cli.ts | KEEP-MODERN | Bun-native, no legacy dependency |
| status | bun route, bash fallthrough | UPDATE | Reads both engines; fold legacy fields into the v10 view |
| stats | loki-ts/src/cli.ts | DELETE | Deprecated alias; use report session |
| doctor | bun route, bash fallthrough | KEEP-MODERN | Core onboarding gate |
| provider | bun route, bash fallthrough | KEEP-MODERN | Provider-agnostic core |
| memory | bun route, bash fallthrough | UPDATE | Memory still carries legacy store paths |
| rollback | bun route, bash fallthrough | KEEP-MODERN | Checkpoint restore is engine-neutral |
| proof | bun route, bash fallthrough | KEEP-MODERN | The Evidence Receipt moat |
| receipt | bun route, bash fallthrough | DELETE | Alias of proof; shown only under 'loki help aliases' |
| wiki | bun route, bash fallthrough | KEEP-MODERN | Bun-native knowledge feature |
| control | bun route, bash fallthrough | KEEP-MODERN | D56 control plane, on by default |
| kpis | loki-ts/src/cli.ts | KEEP-MODERN | Bun-native KPI report |
| report | bun route, bash fallthrough | UPDATE | Mixed route; only kpis is Bun |
| trust | bun route, bash fallthrough | KEEP-MODERN | Trust moat surface |
| crash | bun route, bash fallthrough | KEEP-MODERN | Local-only crash plumbing |
| contract | loki-ts/src/cli.ts | KEEP-MODERN | v10 delivery contract |
| start | bun route, bash fallthrough | UPDATE | Forks between v10 and the SDK loop; flags still legacy-shaped |
| slack | loki-ts/src/cli.ts | KEEP-MODERN | Bun-native integration |
| queue | loki-ts/src/cli.ts | KEEP-MODERN | Governor-aware batch of issue-mode runs |
| answer | loki-ts/src/cli.ts | KEEP-MODERN | v10 blocked-run flow |
| engine10 | loki-ts/src/cli.ts | KEEP-MODERN | The v10 engine |
| internal (hidden) | loki-ts/src/cli.ts | KEEP-MODERN | Hidden plumbing |
| completion (hidden) | loki-ts/src/cli.ts | KEEP-MODERN | Hidden plumbing; completions install themselves |
| __complete (hidden) | loki-ts/src/cli.ts | KEEP-MODERN | Hidden plumbing for generated completions |
| help | autonomy/loki | KEEP-MODERN | Core |
| quick | autonomy/loki | UPDATE | Routes to the v10 lean path by default |
| quickstart | autonomy/loki | KEEP-MODERN | Onboarding path |
| init | autonomy/loki | UPDATE | Templates predate v10 |
| template | autonomy/loki | KEEP-MODERN | Engine-neutral |
| verify | autonomy/loki | UPDATE | Legacy proof vs v10 verify split |
| keys | autonomy/loki | KEEP-MODERN | Trust moat |
| review | autonomy/loki | UPDATE | Gates are legacy-shaped |
| dashboard | autonomy/loki | UPDATE | Overlaps Control Plane |
| config | autonomy/loki | UPDATE | Mixed legacy keys |
| mcp | autonomy/loki | KEEP-MODERN | Engine-neutral |
| acp | autonomy/loki | KEEP-MODERN | Engine-neutral |
| stop | autonomy/loki | KEEP-MODERN | Session control |
| pause | autonomy/loki | KEEP-MODERN | Session control |
| resume | autonomy/loki | KEEP-MODERN | Session control |
| why | autonomy/loki | KEEP-MODERN | Outcome explainer |
| next | autonomy/loki | KEEP-MODERN | Guided flow |
| logs | autonomy/loki | KEEP-MODERN | Engine-neutral |
| ship | autonomy/loki | KEEP-MODERN | Delivery |
| deploy | autonomy/loki | KEEP-MODERN | Delivery |
| import | autonomy/loki | KEEP-MODERN | Spec intake |
| github | autonomy/loki | KEEP-MODERN | Integration |
| issue | autonomy/loki | KEEP-MODERN | Issue-mode |
| ci | autonomy/loki | KEEP-MODERN | Engine-neutral |
| modernize | bun route, bash fallthrough | KEEP-MODERN | Routed to engine10 modernize |
| share | autonomy/loki | KEEP-MODERN | Engine-neutral |
| assets | autonomy/loki | KEEP-MODERN | Engine-neutral |
| export | autonomy/loki | UPDATE | Duplicates report export |
| notify | autonomy/loki | KEEP-MODERN | Engine-neutral |
| tour | autonomy/loki | KEEP-MODERN | Onboarding |
| welcome | autonomy/loki | KEEP-MODERN | Onboarding |
| onboard | autonomy/loki | UPDATE | Overlaps wiki |
| setup-skill | autonomy/loki | KEEP-MODERN | Setup |
| self-update | autonomy/loki | KEEP-MODERN | Maintenance |
| self_update | autonomy/loki | DELETE | Alias of self-update; shown only under 'loki help aliases' |
| update | autonomy/loki | DELETE | Alias of self-update; shown only under 'loki help aliases' |
| remote | autonomy/loki | KEEP-MODERN | Engine-neutral |
| rc | autonomy/loki | DELETE | Alias of remote; shown only under 'loki help aliases' |
| cockpit | autonomy/loki | KEEP-MODERN | Engine-neutral |
| code | autonomy/loki | UPDATE | Overlaps wiki |
| context | autonomy/loki | KEEP-MODERN | Engine-neutral |
| ctx | autonomy/loki | DELETE | Alias of context; shown only under 'loki help aliases' |
| secrets | autonomy/loki | KEEP-MODERN | Security |
| api | autonomy/loki | KEEP-MODERN | Engine-neutral |
| sandbox | autonomy/loki | KEEP-MODERN | Isolation |
| docker | autonomy/loki | KEEP-MODERN | Isolation |
| web | autonomy/loki | UPDATE | Overlaps Control Plane UI |
| preview | autonomy/loki | KEEP-MODERN | Delivery |
| telemetry | autonomy/loki | KEEP-MODERN | Privacy surface |
| otel | autonomy/loki | DELETE | Alias of telemetry; shown only under 'loki help aliases' |
| syslog | autonomy/loki | UPDATE | Legacy log paths |
| explain | autonomy/loki | KEEP-MODERN | Knowledge |
| docs | autonomy/loki | KEEP-MODERN | Core |
| test | autonomy/loki | UPDATE | Legacy runner |
| bench | autonomy/loki | KEEP-MODERN | Engine-neutral |
| voice | autonomy/loki | UPDATE | Experimental |
| own | autonomy/loki | UPDATE | Legacy handoff |
| handoff | autonomy/loki | DELETE | Alias of own; shown only under 'loki help aliases' |
| secure | autonomy/loki | KEEP-MODERN | Security |
| compliance | autonomy/loki | KEEP-MODERN | Enterprise |
| enterprise | autonomy/loki | KEEP-MODERN | Enterprise |
| projects | autonomy/loki | KEEP-MODERN | Engine-neutral |
| audit | autonomy/loki | KEEP-MODERN | Enterprise |
| cost | autonomy/loki | UPDATE | Duplicates report cost |
| metrics | autonomy/loki | UPDATE | Duplicates report metrics |
| sentrux | autonomy/loki | UPDATE | Legacy gate input |
| magic | autonomy/loki | UPDATE | Legacy UI generator |
| estimate | autonomy/loki | DROP-LEGACY | Estimates the legacy PRD flow |
| plan | autonomy/loki | DROP-LEGACY | Legacy PRD flow |
| grill | autonomy/loki | DROP-LEGACY | Legacy PRD flow |
| spec | autonomy/loki | DROP-LEGACY | Legacy PRD flow |
| intent | autonomy/loki | DROP-LEGACY | Legacy PRD flow |
| backlog | autonomy/loki | DROP-LEGACY | Drives legacy RARV per issue |
| workspace | autonomy/loki | DROP-LEGACY | Drives legacy RARV |
| council | autonomy/loki | DROP-LEGACY | Legacy RARV gate |
| compound | autonomy/loki | DROP-LEGACY | Legacy memory pipeline |
| cluster | autonomy/loki | DROP-LEGACY | Legacy RARV |
| optimize | autonomy/loki | DROP-LEGACY | Legacy RARV |
| ultracode | autonomy/loki | DROP-LEGACY | Legacy Claude-only |
| monitor | autonomy/loki | DROP-LEGACY | Legacy engine state |
| watch | autonomy/loki | DROP-LEGACY | PRD flow |
| watchdog | autonomy/loki | DROP-LEGACY | Legacy engine |
| cleanup | autonomy/loki | DROP-LEGACY | Legacy run.sh orphans |
| state | autonomy/loki | DROP-LEGACY | Legacy engine |
| agent | autonomy/loki | DROP-LEGACY | Legacy engine |
| trigger | autonomy/loki | DROP-LEGACY | Legacy engine |
| failover | autonomy/loki | DROP-LEGACY | Legacy engine |
| reset | autonomy/loki | DROP-LEGACY | Legacy engine |
| merge | autonomy/loki | DROP-LEGACY | Legacy parallel mode |
| heal | autonomy/loki | DROP-LEGACY | Legacy engine |
| migrate | autonomy/loki | DROP-LEGACY | Superseded by modernize |
| dogfood | autonomy/loki | DROP-LEGACY | Legacy engine |
| steer | autonomy/loki | DROP-LEGACY | Needs legacy prompt injection |
| outcomes | autonomy/loki | DROP-LEGACY | Legacy outcome store |
| worktree | autonomy/loki | DROP-LEGACY | Legacy parallel mode |
| wt | autonomy/loki | DELETE | Alias of worktree; shown only under 'loki help aliases' |
| checkpoint | autonomy/loki | DROP-LEGACY | Legacy engine |
| cp | autonomy/loki | DELETE | Alias of checkpoint; shown only under 'loki help aliases' |
| analyze | autonomy/loki | DROP-LEGACY | Legacy analyze flow |
| demo | autonomy/loki | DROP-LEGACY | Legacy engine demo |
| run | autonomy/loki | DELETE | Alias; use start |
| trust-metrics | autonomy/loki | DELETE | Alias; use trust detail |
| serve | autonomy/loki | DELETE | Alias; use api start |
| open | autonomy/loki | DELETE | Alias; use dashboard open |

## Registry gaps (nested paths dispatched but not yet in the registry)

- audit: 8
- code: 5
- compliance: 1
- config: 3
- context: 5
- cost: 6
- deploy: 1
- docs: 4
- enterprise: 2
- explain: 5
- export: 6
- github: 5
- import: 1
- init: 21
- issue: 2
- magic: 12
- memory: 7
- metrics: 6
- modernize: 3
- next: 1
- notify: 6
- onboard: 5
- own: 1
- pause: 1
- preview: 1
- projects: 8
- proof: 6
- provider: 3
- quick: 1
- resume: 1
- rollback: 2
- secrets: 3
- secure: 3
- setup-skill: 1
- share: 6
- ship: 1
- syslog: 3
- telemetry: 1
- template: 4
- version: 1
- web: 1
