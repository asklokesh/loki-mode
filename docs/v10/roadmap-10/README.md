# Roadmap to 10/10 in every category

Owner: Chief of Staff. Written 2026-10-17 at v11.17.56. No dates: every item ships as soon as it is green and reviewed (D96, D102).

Why this folder exists: no existing doc owns the 10/10-versus-all-competitors program. PLAN-V12.md is the P12 plan, ROADMAP-D63.md covers the D63 pillars, SCORECARD-PLAN.md covers D41 measurement. This folder is the one index; slices still go to BOARD.md and bugs still need a FAILURE-CLASSES.md row first (D86).

Trigger: when the founder says "work on roadmap", execute every unchecked item here autonomously with parallel agent teams, release each approved slice, and tick the box in the same release commit.

## Scoreboard

| Category | Loki now | Best competitor today | Why we are not 10 | Bar to beat (10/10) | File |
|---|---|---|---|---|---|
| Measurement (enabler) | 3 | SWE-bench / Terminal-Bench publishers | No PROVEN cost run, no catch rate, no public benchmark since 2026-01 | Every other score below is backed by a dated, reproducible number | [01-measurement.md](01-measurement.md) |
| Cost | 6 | Aider; Cursor Composer about $0.07/task | Run4: Loki 1.41x MORE than lean raw on 6 tasks; NOT PROVEN | PROVEN_AT(0.5) vs all 3 floors, n>=3, ledger-checked | [02-cost.md](02-cost.md) |
| Speed | 7 | Cursor Composer Fast (6.7 min avg), Codex | Medium p50 2.5-4x raw; small 1.31x raw; Wall killed at 90s in half of runs | Small paired time ratio CI lower bound >= 1.0; medium p50 <= raw | [03-speed.md](03-speed.md) |
| First run / adoption | 8 | Lovable (2-3 min, zero install), Cursor, Claude Code | Time to first sealed PR never measured; 5 host tools; MCP deeplink likely exits 2 | Clean machine to first sealed PR p50 <= 120s, measured nightly with a real provider | [04-first-run.md](04-first-run.md) |
| Deploy | 7.5 | Replit (code + DB rollback), Vercel + Neon (DB branch per preview) | No DB setup, no per-PR preview URL, no auto rollback on Netlify/Cloudflare, bash only | Preview URL in every PR, auto rollback on all 4 providers, DB hook, Bun route | [05-deploy.md](05-deploy.md) |
| Stability | 7.5 | No clear leader; bar is a public status page | Main Tests red about 10h; longest green streak 23; caps break after merge (FC-60) | 24h green streak, red-to-green under 1h, merged-train guards on every push | [06-stability.md](06-stability.md) |
| Delivered quality / autonomy | 7.5 | Claude Code, Codex (Terminal-Bench 2.0 about 82%) | No arm beats raw on medium; D50 sonnet loss; moat P3/P4 pending, P9 regressed | Medium completion >= 85.7% at <= $0.5085; moat 9 of 9; public Terminal-Bench and SWE-bench Pro | [07-quality.md](07-quality.md) |
| Proof / trust | 9 | Nobody signs spec + tests + result (Loki's opening) | Self-generated trust root, no transparency log, no published catch rate, closed verifier bundle | Third-party verifiable receipts (Rekor), published catch rate, independent audit | [08-proof.md](08-proof.md) |
| Safety / security | 8.5 | Codex (offline agent phase, secret strip, domain allowlist), Claude Code (Seatbelt/bubblewrap), Copilot (default scans, branch limits) | Default bypassPermissions, no sandbox on engine10, PUBLIC gist share, redact TS/Python parity gaps, no npm provenance | Sandboxed by default, egress allowlist, redaction parity, npm provenance, SHA-pinned actions | [09-safety.md](09-safety.md) |

Overall now: 7.5. Target: 10 in every row, each backed by a command plus its output.

## Execution order

1. Measurement first (01). Nothing in cost, speed or quality can be claimed without it. Run in parallel with step 2.
2. Stability P0s (06 epics STAB-1..STAB-3). Main must be green before the swarm scales up again; red main hides regressions.
3. Safety P0s (09 epics SAFE-1, SAFE-2): public gist default and redaction parity are live leak risks.
4. Cost and speed levers (02, 03), each gated by a measured arm from step 1.
5. First-run and deploy (04, 05) in parallel with step 4; different file sets.
6. Quality and moat (07), then proof trust root (08).
7. Re-score every row with evidence; publish the scoreboard.

Parallelism: categories own non-overlapping file sets except `loki-ts/src/util/redact.ts` (09 only) and `loki-ts/src/engine10/stages/wall.ts` (03 owns; 02 and 07 consume). Architects split each epic into slices per PLAN-V12 ground rules: engine10 core cap 5000, e10ext 1500, features 3000, contrib 1200; new logic goes in util/ or runner/; hot files are edited by the Captain only.

## Master checklist

Each line is an epic. Stories, acceptance criteria and todo boxes live in the category file.

### 01 Measurement
- [ ] MEAS-1 Bench rows carry loki_version, cost_profile and one cost truth
- [ ] MEAS-2 Bench Wall uses the task interpreter; Loki rows can reach VERIFIED
- [ ] MEAS-3 C-F1 run5: 5 arms, 3 floors, n=3, 20 tasks
- [ ] MEAS-4 Medium A/B on all 14 tasks, n=3, cost never null
- [ ] MEAS-5 Seeded-defect catch rate on real runs (wrong-pass.json)
- [ ] MEAS-6 Terminal-Bench 2.0 and SWE-bench Pro runs, side by side with raw
- [ ] MEAS-7 Real-provider time-to-first-sealed-PR, nightly
- [ ] MEAS-8 Public scoreboard page generated from result files

### 02 Cost
- [ ] COST-A Small-task lean path actually triggers (sizing)
- [ ] COST-B Focused implement brief (files + exact test command)
- [ ] COST-C Flip measured-OFF knobs (cost lean profile, TRIM, judge batch)
- [ ] COST-D Cost correctness followups (alias flags, run.sh .5 cap, negative price, TEN-COST-59 sibling)
- [ ] COST-E Publish PROVEN_AT(0.5)

### 03 Speed
- [ ] SPD-A Wall off the critical path (concurrent default, limit fix)
- [ ] SPD-B Pre-model overhead measured and under 2s warm
- [ ] SPD-C Parallel verify/base jobs default after A/B
- [ ] SPD-D Speed tier tasks and LOKI_SPEED A/B
- [ ] SPD-E Equal-parallelism scorecard rule

### 04 First run / adoption
- [ ] FR-A One command from clean machine to first sealed PR
- [ ] FR-B Fewer host requirements on the v10 path
- [ ] FR-C Every preflight fatal is telemetered and has a named fix
- [ ] FR-D IDE / MCP one-click actually works
- [ ] FR-E Zero-install web entry (hosted try)

### 05 Deploy
- [ ] DEP-A Per-PR preview URL with health in the PR body
- [ ] DEP-B Auto rollback on all 4 providers
- [ ] DEP-C Database provisioning hook
- [ ] DEP-D Continuous health watch with rollback suggestion
- [ ] DEP-E Deploy on the Bun route
- [ ] DEP-F Secrets never on argv

### 06 Stability
- [ ] STAB-1 Main green now and kept green (core budget, P9, FC-01, L2)
- [ ] STAB-2 Merged-train guard job on every main push
- [ ] STAB-3 Nightly cannot read green when it ran nothing
- [ ] STAB-4 Green-streak and time-to-fix metrics in pulse
- [ ] STAB-5 Public status page
- [ ] STAB-6 Repo hygiene (295 unmerged branches, BOARD unparsed rows, stale metrics)

### 07 Delivered quality / autonomy
- [ ] QUAL-A Beat raw on medium tier
- [ ] QUAL-B Close the D50 sonnet loss
- [ ] QUAL-C Moat 9 of 9 (P3 Wall, P4 model freedom, P9)
- [ ] QUAL-D Close A-119b weakening holes
- [ ] QUAL-E Public benchmark numbers

### 08 Proof / trust
- [ ] PRF-A Third-party verifiable trust root (transparency log, key directory)
- [ ] PRF-B Browser verifier and open verifier source
- [ ] PRF-C Receipts record every proof opt-out
- [ ] PRF-D Published catch rate and independent audit

### 09 Safety / security
- [ ] SAFE-1 `loki share` private by default and redacted
- [ ] SAFE-2 Redaction parity and ReDoS fix (SECURITY-26 rework, N2/N3/N4)
- [ ] SAFE-3 Sandbox by default on engine10
- [ ] SAFE-4 Network egress allowlist and offline agent phase
- [ ] SAFE-5 Policy gate covers commit, push, deploy and network
- [ ] SAFE-6 Supply chain: npm provenance, OIDC publish, SHA-pinned actions
- [ ] SAFE-7 One shared secret pattern list; SARIF can gate

## Done definition for the program

- Every row in the scoreboard reads 10 with a cited command, exit code and result file.
- METRICS.md, the public scoreboard and this README agree.
- No open P0 in FAILURE-CLASSES.md for any category.

## Feature 100

The next 100 user-facing features, ranked by expected user impact. Items 1-20 are ship-first. Each row names the open issue that carries it; rows marked existing reuse an issue that was already filed. Every item was checked against the shipped command surface and the open issue list on 2026-10-23, so none repeats a shipped feature.

Honest note on the goal. "10x better than Claude Code in every category, 100x better than Factory and Devin" is a TARGET, not a claim. Nothing in this section asserts that Loki is ahead today. Each item names the metric it moves and a target; the comparison is measured per item through the bench issues #348 (unbenchmarked wins), #355 (pre-registered discriminating tasks) and #350 (UX scorecard with measured baselines). A competitor baseline cites either a `--help` output run on this host on 2026-10-23 or a fetched documentation URL; where neither shows the capability the cell says UNKNOWN, which means not found, not absent.

Sources: Claude Code 2.1.309 and droid 0.190.0 `--help` were run on 2026-10-23. codex is not installed on this host, so Codex cells cite https://learn.chatgpt.com/docs/codex/cli or the rows measured on codex-cli 0.146.0 in docs/COMPETITIVE-SCORECARD.md. Devin cells cite https://docs.devin.ai/ pages listed in https://docs.devin.ai/llms.txt. Factory cells cite https://docs.factory.com/cli/getting-started/overview.

Tier follows docs/v10/OPERATING-MODEL.md: HIGH touches the moat, verifier, Seal, auth or security.

### Ranked list

| Rank | Id | Area | Feature | Size | Tier | Issue |
|---|---|---|---|---|---|---|
| 1 | ship-first R100-001 | onboarding | Zero-question first run with an already logged-in provider | M | MEDIUM | #357 |
| 2 | ship-first R100-002 | trust | Seal any agent's diff: signed receipt for changes Claude Code, Codex or a human already made | M | HIGH | #345 (existing) |
| 3 | ship-first R100-003 | autonomy | In-place resume after a human answers a blocked question | L | MEDIUM | #358 |
| 4 | ship-first R100-004 | deploy | Per-PR preview URL with its health result in the PR body | M | MEDIUM | #359 |
| 5 | ship-first R100-005 | team | PR and issue comment commands: /loki fix, /loki explain, /loki reseal | M | HIGH | #360 |
| 6 | ship-first R100-006 | trust | Spec clause matrix in the PR body and receipt comment | M | HIGH | #342 (existing) |
| 7 | ship-first R100-007 | speed | Live run view: `loki status --follow` streams stages, edits, tests and cost | S | LOW | #361 |
| 8 | ship-first R100-008 | autonomy | Background runs and one run list across repos | M | MEDIUM | #362 |
| 9 | ship-first R100-009 | autonomy | Run large multi-part tasks as decomposed, separately verified units | L | MEDIUM | #235 (existing) |
| 10 | ship-first R100-010 | team | Approval inbox: everything waiting on a human, across repos | M | MEDIUM | #363 |
| 11 | ship-first R100-011 | memory | Learn from what users edit: amended or rejected Loki PRs become lessons | M | MEDIUM | #364 |
| 12 | ship-first R100-012 | trust | Seal as a required merge check: `loki github protect` | S | HIGH | #365 |
| 13 | ship-first R100-013 | trust | Seal web apps by driving the spec's user flows in a real browser | L | HIGH | #249 (existing) |
| 14 | ship-first R100-014 | ecosystem | Read every agent's rules: CLAUDE.md, AGENTS.md, Cursor, Copilot and Windsurf rule files | S | LOW | #366 |
| 15 | ship-first R100-015 | providers | Model shootout on your own task: `loki compare` | M | MEDIUM | #367 |
| 16 | ship-first R100-016 | trust | Verify a receipt in the browser, offline, with no install | M | HIGH | #368 |
| 17 | ship-first R100-017 | onboarding | Single-binary install with no node or python3 required | M | MEDIUM | #369 |
| 18 | ship-first R100-018 | deploy | Automatic rollback on all four deploy providers | M | MEDIUM | #370 |
| 19 | ship-first R100-019 | dashboard | Leader screen: work in, sealed shipped, cost per sealed change, waiting on a human | M | MEDIUM | #371 |
| 20 | ship-first R100-020 | onboarding | Native Windows support | L | MEDIUM | #372 |
| 21 | R100-021 | onboarding | Name the provider failure cause and its fix on the Reason line | S | LOW | #351 (existing) |
| 22 | R100-022 | onboarding | Check publish capability at intake, before any work | S | MEDIUM | #231 (existing) |
| 23 | R100-023 | onboarding | Zero-install try in a dev container or Codespace | S | LOW | #373 |
| 24 | R100-024 | onboarding | Starter task suggestions from issues, TODOs and failing tests | S | LOW | #374 |
| 25 | R100-025 | onboarding | `loki try <repo-url>`: one command to a sealed sample change on any public repo | S | LOW | #375 |
| 26 | R100-026 | speed | Readable plan with cost in under 10 seconds | S | LOW | #376 |
| 27 | R100-027 | speed | Desktop and phone push notifications when a run needs you or finishes | S | LOW | #377 |
| 28 | R100-028 | speed | Best-of-N implement for small tasks | M | MEDIUM | #378 |
| 29 | R100-029 | speed | Warm engine daemon for sub-second start | M | MEDIUM | #379 |
| 30 | R100-030 | speed | Re-seal in under a minute after a human edits a Loki PR | M | HIGH | #380 |
| 31 | R100-031 | speed | Opt-in fast mode with ledger premium and fallback | M | MEDIUM | #279 (existing) |
| 32 | R100-032 | speed | Progress mirrored to the Slack thread and a live PR checklist | S | LOW | #381 |
| 33 | R100-033 | deploy | Database provisioning per preview | L | MEDIUM | #382 |
| 34 | R100-034 | deploy | Run the spec's user flows against the live deploy URL | M | HIGH | #383 |
| 35 | R100-035 | deploy | Container image build and push with SBOM bound to the receipt | M | MEDIUM | #384 |
| 36 | R100-036 | deploy | Kubernetes deploy with canary through the user's own kube context | L | HIGH | #385 |
| 37 | R100-037 | deploy | `loki deploy init`: detect a logged-in deploy CLI and write config with no questions | S | LOW | #386 |
| 38 | R100-038 | team | CODEOWNERS-aware reviewers on every Loki PR | S | LOW | #387 |
| 39 | R100-039 | team | Fill the repo's pull request template | S | LOW | #388 |
| 40 | R100-040 | team | Team memory shared through git | M | MEDIUM | #389 |
| 41 | R100-041 | team | Team login for the shared Control Plane | L | HIGH | #188 (existing) |
| 42 | R100-042 | team | Bitbucket and Azure DevOps pull requests | M | MEDIUM | #390 |
| 43 | R100-043 | team | Release notes written from sealed receipts | S | LOW | #391 |
| 44 | R100-044 | ide | VS Code extension: run panel and receipt viewer | L | MEDIUM | #392 |
| 45 | R100-045 | ide | Ready-made ACP configs for Zed and JetBrains | S | LOW | #393 |
| 46 | R100-046 | ide | Start, status and seal commands in the Claude Code plugin | S | LOW | #394 |
| 47 | R100-047 | ide | Full-screen terminal UI with approve, steer and pause keys | M | LOW | #395 |
| 48 | R100-048 | ide | Images and mockups as task input | M | MEDIUM | #396 |
| 49 | R100-049 | ide | MCP one-click install works on a clean machine | S | LOW | #397 |
| 50 | R100-050 | ide | Start, steer and answer runs from the Control Plane in the browser | M | MEDIUM | #398 |
| 51 | R100-051 | ide | Answer blocked questions from the phone with a push reply action | S | MEDIUM | #399 |
| 52 | R100-052 | memory | Code embedding provider for memory retrieval | M | MEDIUM | #248 (existing) |
| 53 | R100-053 | memory | Search every past run: `loki history search` | S | LOW | #400 |
| 54 | R100-054 | memory | `loki blame <file>:<line>`: which run, clause and decision produced this line | S | LOW | #401 |
| 55 | R100-055 | memory | Personal profile applied across repos | M | MEDIUM | #402 |
| 56 | R100-056 | memory | Memory page in the Control Plane: view, pin, edit and forget lessons | S | LOW | #403 |
| 57 | R100-057 | memory | Playbooks: save a sealed run as a reusable task recipe | M | LOW | #404 |
| 58 | R100-058 | memory | Reverted changes become lessons and regression-test proposals | S | MEDIUM | #405 |
| 59 | R100-059 | cost | Live cost meter with alerts at 50, 80 and 100 percent of budget | S | LOW | #406 |
| 60 | R100-060 | cost | Estimate accuracy: show actual vs estimate and self-calibrate | S | LOW | #407 |
| 61 | R100-061 | cost | Monthly budgets per repo and per user | M | MEDIUM | #408 |
| 62 | R100-062 | cost | Cost breakdown by stage and route with savings against an all-top-model baseline | S | LOW | #409 |
| 63 | R100-063 | cost | Finance export: monthly CSV of spend by repo, user and sealed change | S | LOW | #410 |
| 64 | R100-064 | cost | Warn when attached MCP tool definitions cost too many tokens | S | LOW | #290 (existing) |
| 65 | R100-065 | cost | Show prompt-cache savings per run | S | LOW | #411 |
| 66 | R100-066 | cost | Quote approval for expensive runs | S | MEDIUM | #412 |
| 67 | R100-067 | providers | Provider adapters for GitHub Copilot CLI, cursor-agent and Factory droid | M | MEDIUM | #413 |
| 68 | R100-068 | providers | Any OpenAI-compatible endpoint on every route | M | MEDIUM | #414 |
| 69 | R100-069 | providers | Judge client from the provider the user configured | M | HIGH | #267 (existing) |
| 70 | R100-070 | providers | One effort and thinking knob across all five providers | M | MEDIUM | #346 (existing) |
| 71 | R100-071 | providers | Doctor auth rows and a zero-token probe for every provider | S | MEDIUM | #347 (existing) |
| 72 | R100-072 | providers | Hybrid local and cloud: offload cheap stages to a local model when present | M | MEDIUM | #415 |
| 73 | R100-073 | providers | New-model check: `loki models --new` compares a new model on your recent tasks | S | LOW | #416 |
| 74 | R100-074 | providers | Model route settings in the Control Plane with live prices | S | LOW | #417 |
| 75 | R100-075 | autonomy | Maintenance autopilot: dependency upgrades, lint debt and flaky tests as sealed PRs | M | MEDIUM | #418 |
| 76 | R100-076 | autonomy | Preserve working state across compaction | M | MEDIUM | #277 (existing) |
| 77 | R100-077 | autonomy | Relay operator input to a running worker | M | MEDIUM | #278 (existing) |
| 78 | R100-078 | autonomy | Every run in its own worktree by default | M | HIGH | #232 (existing) |
| 79 | R100-079 | autonomy | Multi-day missions with milestone receipts | L | MEDIUM | #419 |
| 80 | R100-080 | autonomy | Overnight backlog window with a morning report | S | LOW | #420 |
| 81 | R100-081 | autonomy | Move a run to another machine: export and import run state | M | MEDIUM | #421 |
| 82 | R100-082 | dashboard | Run replay: step through stages with the diff and test output at each step | M | LOW | #422 |
| 83 | R100-083 | dashboard | Compare two runs side by side | S | LOW | #423 |
| 84 | R100-084 | dashboard | Weekly digest to Slack or email | S | LOW | #424 |
| 85 | R100-085 | dashboard | Stage time and cost chart per run | S | LOW | #425 |
| 86 | R100-086 | dashboard | Repo health page: seal rate, revert rate and change-failure rate trends | S | LOW | #426 |
| 87 | R100-087 | dashboard | Stuck-run alert when no progress for N minutes | S | LOW | #427 |
| 88 | R100-088 | ecosystem | Hosted template registry: search and publish | M | LOW | #428 |
| 89 | R100-089 | ecosystem | Custom gates in loki.yaml that feed the Seal | M | HIGH | #429 |
| 90 | R100-090 | ecosystem | `loki hooks install`: fast verify on pre-commit | S | LOW | #430 |
| 91 | R100-091 | ecosystem | Signed outbound run webhooks with a typed event schema | S | MEDIUM | #431 |
| 92 | R100-092 | ecosystem | One MCP config for every MCP-capable provider | M | MEDIUM | #343 (existing) |
| 93 | R100-093 | ecosystem | Use existing Claude Code and droid skills in any provider's run | M | MEDIUM | #432 |
| 94 | R100-094 | ecosystem | Embeddable TypeScript SDK: `runLoki({ spec })` | M | MEDIUM | #433 |
| 95 | R100-095 | trust | Receipts in a public transparency log | M | HIGH | #434 |
| 96 | R100-096 | trust | Clause-by-clause spec trace in the receipt | L | HIGH | #341 (existing) |
| 97 | R100-097 | trust | Numbered, anchored acceptance clauses from any spec | M | HIGH | #340 (existing) |
| 98 | R100-098 | trust | Vision pass over captured screenshots in the Seal | M | HIGH | #263 (existing) |
| 99 | R100-099 | trust | Audit evidence pack from receipts | S | HIGH | #435 |
| 100 | R100-100 | trust | Page and line anchors for PDF and DOCX specs | M | MEDIUM | #339 (existing) |

### Item detail

Items that reuse an existing issue carry their acceptance criteria in that issue.

#### R100-001 Zero-question first run with an already logged-in provider

- Issue: #357. Area: onboarding. Size: M. Tier: MEDIUM. Deps: FR-A, #347.
- Problem: A new user who already has claude, codex, opencode, cline or aider logged in still meets `loki setup` before the first build; every extra step loses users before their first VERIFIED build.
- Feature: `loki start "<task>"` in a fresh HOME detects a logged-in provider CLI, picks the default route, and runs with no prompt. `loki setup` becomes optional (extends FR-A in 04-first-run.md, `start.ts`, `doctor_fix.ts`).
- Acceptance:
  - In a clean HOME with only the claude CLI logged in, `loki start "add one line to README" </dev/null` emits its first stage event with 0 interactive prompts.
  - A fixture test stubs each of the 5 provider CLIs as logged in and `loki doctor --json` reports `provider_autodetected: true` for 5 of 5.
  - Gate `--entry start-empty` passes with 0 calls to `loki setup`.
  - Command start to first stage event p50 <= 15 s over 5 runs, logged by the MEAS-7 nightly.
- Metric and target: Time to first VERIFIED build p50 <= 120 s (04-first-run bar); first-run abandonment measured by `first_run_blocked` telemetry, target <= 10%.
- Competitor baseline: Claude Code: Interactive session is the default; login is `claude auth` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Install and sign-in are documented steps (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Devin for Terminal installs via a curl script (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: Interactive mode is the default (`droid` with no args) (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-002 Seal any agent's diff: signed receipt for changes Claude Code, Codex or a human already made

- Issue: #345 (existing). Area: trust. Size: M. Tier: HIGH. Deps: #337.
- Problem: Users who already code with another agent get no proof for that work, so Loki is only useful when Loki writes the code.
- Metric and target: Runs per user per week: target >= 3 sealed external diffs per active user per week.
- Competitor baseline: Claude Code: `ultrareview` prints findings, no signed receipt documented (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Local review of uncommitted changes, a commit or a base branch (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Devin Review page exists; no portable signed receipt found (https://docs.devin.ai/work-with-devin/devin-review.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-003 In-place resume after a human answers a blocked question

- Issue: #358. Area: autonomy. Size: L. Tier: MEDIUM. Deps: #278, #353, journal (#283, closed).
- Already exists (corrected 2026-10-23): `loki answer [<run-id>]` already ships in `loki-ts/src/features/blocked_answer.ts` (D63-C4), but the answer starts a new run. This item is the in-place resume under the same run id.
- Problem: Today a BLOCKED engine10 run is terminal; a Slack reply starts a new follow-up run (`loki-ts/src/contrib/slack_inbound.ts` lines 2-4), so completed work is re-done and users abandon blocked runs.
- Feature: A blocked run parks with its journal intact. `loki answer <run> "<text>"`, a Slack thread reply, or a PR comment resumes the same run id and skips completed slices.
- Acceptance:
  - Fixture: a run blocks at plan; `loki answer <run> "use postgres"` continues under the same run id and the journal shows 0 re-executed completed slices.
  - A Slack thread reply on a blocked run resumes the same run id (event log shows 1 `run.resumed`, 0 `run.started`).
  - An unanswered block stops cleanly after `LOKI_BLOCK_WAIT_S` (default 86400) and sends exactly 1 notification.
  - `loki status --json` reports `state: blocked` with the question text within 2 s of the block.
- Metric and target: Abandoned-run rate (BLOCKED never resumed) target <= 10%; human touches per shipped change target <= 1.
- Competitor baseline: Claude Code: `--resume` and `--continue` resume a conversation (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: "Return to a saved chat" via resume (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Slack thread sync lets messages go both ways in one session (https://docs.devin.ai/integrations/slack (fetched 2026-10-23)). Factory droid: `-r, --resume [sessionId]` and `--fork` (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-004 Per-PR preview URL with its health result in the PR body

- Issue: #359. Area: deploy. Size: M. Tier: MEDIUM. Deps: DEP-A.
- Problem: Reviewers cannot click a sealed change; they must pull and run it, which slows every review.
- Feature: On a PR run with a configured provider (Netlify, Vercel, Cloudflare, Fly), deploy to a preview destination, probe health, write the URL and probe result into the PR body and the receipt, and prune old previews (DEP-A in 05-deploy.md).
- Acceptance:
  - With each of 4 stubbed provider CLIs, `loki start --deploy --destination preview` writes a `preview_url` line into the PR body (4 of 4 fixtures).
  - `loki status --json` has a non-empty `deploy.preview_url` and an HTTP status of 200 from the probe on the success fixture.
  - The receipt records the preview URL and probe status; `loki verify` on that receipt exits 0.
  - `loki deploy prune --older-than 7d` removes previews older than 7 days and prints the count removed.
- Metric and target: Median time from PR open to first human review action target -30% vs no-preview PRs; week-2 return rate.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Deployment appears only as a verification example ("testing an automatic deployment") (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-005 PR and issue comment commands: /loki fix, /loki explain, /loki reseal

- Issue: #360. Area: team. Size: M. Tier: HIGH. Deps: verify-pr respond, D60-4 Action.
- Problem: Reviewers who want a change on a Loki PR must leave GitHub, open a terminal and run Loki themselves.
- Feature: The existing issue-to-PR GitHub Action listens for `/loki fix <text>`, `/loki explain` and `/loki reseal` comments from users with write access and runs them on the PR branch; untrusted comment text never shares a step with secrets (moat 9).
- Acceptance:
  - Workflow fixture: a collaborator comment `/loki fix rename foo to bar` produces 1 new commit on the PR branch and a fresh `loki/receipt` status.
  - The same comment from a non-collaborator starts 0 runs and posts 1 reply naming the missing permission.
  - `/loki explain` replies with the clause matrix in <= 60 lines.
  - A comment containing a prompt-injection fixture leaves secrets unread (the guard test asserts 0 secret env vars in the untrusted step).
- Metric and target: Runs per user per week target +50% for repos with the Action installed; human touches per shipped change.
- Competitor baseline: Claude Code: `--from-pr` resumes a session linked to a PR (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: GitHub Action page /codex/github-action listed (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: GitHub integration page (https://docs.devin.ai/integrations/gh.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-006 Spec clause matrix in the PR body and receipt comment

- Issue: #342 (existing). Area: trust. Size: M. Tier: HIGH. Deps: #340, #341.
- Problem: Reviewers cannot see which requirement each test proves.
- Metric and target: Human review time per sealed PR target -30%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-007 Live run view: `loki status --follow` streams stages, edits, tests and cost

- Issue: #361. Area: speed. Size: S. Tier: LOW. Deps: event log.
- Already exists (corrected 2026-10-23): `loki cockpit --follow` already exists as an inline-image multi-repo view. This item is the text and JSONL stream for one run in `loki-ts/src/commands/status.ts`.
- Problem: During a long run users see little; they cancel runs that were progressing.
- Feature: `loki status --follow [--json]` prints one line per event (stage, file edited, test result, cost) and Ctrl-C detaches without stopping the run (extends `status.ts` and the event log).
- Acceptance:
  - `loki status --follow --json` emits >= 1 JSONL event per stage transition; a fixture run asserts 7 stage events.
  - The first event prints within 2 s of `loki start`.
  - After Ctrl-C on the follower, `loki status --json` still reports `state: running`.
  - Each cost event carries `usd_so_far` and a test compares the last value to the ledger total within 1%.
- Metric and target: Abandoned-run rate target -25%; time to first visible progress <= 5 s.
- Competitor baseline: Claude Code: `--output-format stream-json` and `--include-partial-messages` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: `codex exec --json` prints JSONL events (docs/COMPETITIVE-SCORECARD.md, measured on codex-cli 0.146.0 (codex is not installed on this host on 2026-10-23)). Devin: Users follow Devin's work in real time and open progress steps (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-008 Background runs and one run list across repos

- Issue: #362. Area: autonomy. Size: M. Tier: MEDIUM. Deps: #232.
- Already exists (corrected 2026-10-23): `loki start --bg` and `--detach` already exist in `autonomy/loki`, and `loki projects` lists registered repos. This item is `loki runs`, `loki attach` and `loki runs stop` only.
- Problem: A run ties up the terminal; users with several repos cannot see every running build in one place.
- Feature: `loki start --bg` returns a run id, `loki runs` lists every run across registered projects (`loki projects`) with state, cost and verdict, and `loki attach <id>` re-joins one.
- Acceptance:
  - `loki start --bg "<task>"` returns a run id and exits 0 in <= 2 s.
  - With 3 registered fixture projects and 4 runs, `loki runs --json | jq length` prints 4.
  - `loki attach <id>` shows live events for that run; `loki runs stop <id>` moves it to `stopped` within 5 s.
  - `loki runs --json` rows carry 5 keys: id, repo, state, usd, verdict.
- Metric and target: Runs per user per week target +40%; concurrent runs per active user.
- Competitor baseline: Claude Code: `--bg`, `agents`, `attach`, `logs`, `stop` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: "Move work to Codex cloud" (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: The Devin API is listed on the docs home (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: `daemon` runs the Factory daemon server (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-009 Run large multi-part tasks as decomposed, separately verified units

- Issue: #235 (existing). Area: autonomy. Size: L. Tier: MEDIUM. Deps: journal (#283, closed).
- Problem: Big asks fail or stall as one unit.
- Metric and target: Completion rate on multi-part tasks target >= 85%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: Missions: multi-agent work via `droid exec --mission` (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-010 Approval inbox: everything waiting on a human, across repos

- Issue: #363. Area: team. Size: M. Tier: MEDIUM. Deps: R100-003.
- Problem: Blocked questions, PRs awaiting approval and deploys awaiting promotion are spread across terminals, Slack and GitHub; work waits for hours.
- Feature: `loki inbox` and a Control Plane page list each waiting item with one action (answer, approve, promote, dismiss).
- Acceptance:
  - Fixture with 3 repos and 4 waiting items: `loki inbox --json | jq length` prints 4.
  - `loki inbox approve <id>` marks the item done and the next `loki inbox --json` prints 3.
  - The Control Plane inbox page renders 200 items in <= 1 s (Playwright timing fixture).
  - Each item shows its wait age; items older than 24 h are flagged.
- Metric and target: Median wait for a human action target <= 30 min; human touches per shipped change.
- Competitor baseline: Claude Code: `claude agents` lists background agents (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: Session Insights page (https://docs.devin.ai/product-guides/session-insights.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-011 Learn from what users edit: amended or rejected Loki PRs become lessons

- Issue: #364. Area: memory. Size: M. Tier: MEDIUM. Deps: memory learn, outcomes.
- Problem: Users fix the same Loki habits by hand on every PR; nothing learns from their code edits (`loki memory learn` reads review comments only).
- Feature: When a Loki PR is merged after human commits, or closed unmerged, the human diff becomes a scoped, cited lesson injected into later runs in that repo.
- Acceptance:
  - Fixture PR where a human renames 3 identifiers before merge: `loki memory lessons --json` gains 1 lesson citing the PR number and hunk.
  - `loki memory brief` for the next run in that repo contains the lesson text.
  - `loki memory forget <id>` removes it and the next brief no longer contains it.
  - Lessons from repo A appear in 0 briefs for repo B unless the lesson is promoted.
- Metric and target: Human commits per Loki PR target -20% by a user's 4th week; week-2 return rate.
- Competitor baseline: Claude Code: `--bare` help names auto-memory as a feature it skips (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: AGENTS.md instructions file (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Devin Memory and Dreaming page (https://docs.devin.ai/product-guides/memory.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: Repository instructions via AGENTS.md (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-012 Seal as a required merge check: `loki github protect`

- Issue: #365. Area: trust. Size: S. Tier: HIGH. Deps: TEN-DEPLOY-07 commit status.
- Problem: The receipt status is advisory; teams cannot require it before merge without hand-editing branch protection.
- Feature: `loki github protect [--dry-run]` makes `loki/receipt` a required status check on the default branch, and the Action re-verifies the receipt on every PR push.
- Acceptance:
  - `loki github protect --dry-run` prints exactly 1 branch-protection API call and changes nothing.
  - Fixture repo: a PR with no receipt shows `loki/receipt` failure; a valid receipt shows success; a tampered receipt shows failure (3 of 3).
  - Removing protection with `loki github protect --off` restores the previous required checks list byte-identical.
- Metric and target: Repos with the check required, target >= 30% of active repos; week-4 retention of those repos.
- Competitor baseline: Claude Code: `ultrareview` prints findings; no merge-gate receipt in help (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: GitHub Action page listed (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Devin Review page (https://docs.devin.ai/work-with-devin/devin-review.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-013 Seal web apps by driving the spec's user flows in a real browser

- Issue: #249 (existing). Area: trust. Size: L. Tier: HIGH. Deps: #263.
- Problem: Boot probes and screenshots do not prove a user flow works.
- Metric and target: Post-merge change-failure rate for web apps target -30%.
- Competitor baseline: Claude Code: `--chrome` Claude in Chrome integration (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: Environment setup page (https://docs.devin.ai/onboard-devin/environment.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-014 Read every agent's rules: CLAUDE.md, AGENTS.md, Cursor, Copilot and Windsurf rule files

- Issue: #366. Area: ecosystem. Size: S. Tier: LOW. Deps: none.
- Problem: Teams already wrote rules for other agents; Loki reads AGENTS.md (v7.21) but not `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`, `.windsurfrules` or `GEMINI.md`.
- Feature: One loader folds every known rule file into the run brief and `loki doctor` lists which were loaded and which conflict.
- Acceptance:
  - Fixture with 6 rule files: `loki memory brief --json | jq '.sources | length'` prints 6.
  - Two contradictory rules produce 1 `conflict` row in `loki doctor --json`.
  - A repo with 0 rule files adds 0 bytes to the brief.
- Metric and target: Week-2 return rate for repos with existing rule files; human commits per Loki PR target -10%.
- Competitor baseline: Claude Code: `import` imports config from another AI coding agent (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: AGENTS.md support (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: UNKNOWN. Factory droid: AGENTS.md support (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-015 Model shootout on your own task: `loki compare`

- Issue: #367. Area: providers. Size: M. Tier: MEDIUM. Deps: loki bench.
- Problem: Users cannot tell which model or provider is best and cheapest for their repo; `loki bench vs` needs a task-spec file.
- Feature: `loki compare "<task>" --routes a,b,c` runs the task on N routes in isolated worktrees, prints sealed, cost and time per route, and `--adopt <route>` saves the winner.
- Acceptance:
  - `loki compare "x" --routes a,b,c --dry-run` prints 3 planned arms each with an estimated USD.
  - An executed stub fixture writes 3 rows each with verdict, usd and seconds.
  - `loki compare --adopt <route>` writes the route into loki.yaml and `loki models --json` shows it as default.
  - All arm worktrees are removed after the run (0 left in `git worktree list`).
- Metric and target: Cost per sealed change target -30% for users who adopt a route.
- Competitor baseline: Claude Code: `--model` and `--fallback-model` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-016 Verify a receipt in the browser, offline, with no install

- Issue: #368. Area: trust. Size: M. Tier: HIGH. Deps: PRF-B.
- Problem: A reviewer outside engineering cannot check a receipt without installing Loki.
- Feature: `loki proof export --html` writes one self-contained page that verifies a receipt with the public key, offline (PRF-B in 08-proof.md).
- Acceptance:
  - The exported page is a single file under 1 MB.
  - A headless check shows PASS for the sample receipt and FAIL for a tampered copy (2 of 2).
  - The page makes 0 network requests (CSP `connect-src 'none'`, asserted in the headless check).
- Metric and target: Receipts verified by a non-author, target >= 1 per sealed PR on team repos.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-017 Single-binary install with no node or python3 required

- Issue: #369. Area: onboarding. Size: M. Tier: MEDIUM. Deps: FR-B.
- Already exists (corrected 2026-10-23): `build:binary` (`bun build --compile`) already exists in `loki-ts/package.json`. This item is building and attaching the 5 targets in `.github/workflows/release.yml`.
- Problem: Install needs node, python3, jq, git and curl plus a provider; each missing tool is a dead end.
- Feature: Release attaches compiled binaries (Bun compile) so the v10 path needs only git and a provider CLI (extends FR-B).
- Acceptance:
  - The release attaches 5 binaries: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64.
  - With node and python3 off PATH, `./loki version --json` exits 0 and `./loki start --dry-run "x"` exits 0.
  - Each binary is <= 120 MB.
- Metric and target: Install-to-first-run success rate target >= 95%; time to first VERIFIED build.
- Competitor baseline: Claude Code: `install` installs the Claude Code native build (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: Devin for Terminal installs via curl (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: `update` installs droid updates (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-018 Automatic rollback on all four deploy providers

- Issue: #370. Area: deploy. Size: M. Tier: MEDIUM. Deps: DEP-B, DEP-D.
- Already exists (corrected 2026-10-23): `--auto-rollback` already exists on `loki start` and `loki deploy`, for Vercel and Fly only. This item adds Netlify, Cloudflare and a timed health watch.
- Problem: `loki rollback deploy` prints the rollback command but never runs it; a bad deploy stays live until a human acts.
- Feature: With `--auto-rollback`, a failed health watch after deploy runs the provider rollback, records it in the receipt, and notifies (DEP-B, DEP-D).
- Acceptance:
  - With 4 stubbed provider CLIs and a health URL failing 3 probes, rollback runs once per provider (4 of 4).
  - `loki status --json` reports `deploy.state: rolled_back` and the receipt records the rollback.
  - With `--auto-rollback` off, 0 rollback commands run and 1 suggestion prints.
- Metric and target: Mean time to recover from a bad deploy target <= 5 min.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-019 Leader screen: work in, sealed shipped, cost per sealed change, waiting on a human

- Issue: #371. Area: dashboard. Size: M. Tier: MEDIUM. Deps: kpis.
- Problem: V10-VISION promises one screen for leaders; numbers exist across `loki report kpis`, outcomes and the ledger but not together.
- Feature: `loki report kpis --leader` and a Control Plane page show the 4 numbers per week across registered repos.
- Acceptance:
  - `loki report kpis --leader --since 7d --json` has 4 keys: work_in, shipped_sealed, usd_per_sealed, waiting_on_human.
  - The Control Plane leader page shows the same 4 values as the CLI on a fixture (4 of 4 equal).
  - A weekly digest posts the 4 numbers to the configured notify channel once per 7 days.
- Metric and target: Weekly active leaders viewing the page; week-4 retention of team accounts.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Personal Analytics and Session Insights pages (https://docs.devin.ai/enterprise/security-access/personal-analytics.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-020 Native Windows support

- Issue: #372. Area: onboarding. Size: L. Tier: MEDIUM. Deps: R100-017.
- Problem: Windows users without WSL cannot run Loki.
- Feature: PowerShell install and a Windows-native Bun route for `loki start`, `loki verify` and `loki status`.
- Acceptance:
  - On a windows-latest runner, `npm i -g loki-mode` then `loki version --json` exits 0.
  - `loki start --dry-run "x"` and `loki verify --json` exit with documented codes (0 or 2) on Windows.
  - INSTALLATION.md has a Windows section with 1 install command.
- Metric and target: Installs from Windows hosts; time to first VERIFIED build on Windows p50 <= 180 s.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: Windows install, Windows sandbox and WSL pages (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Windows support page (https://docs.devin.ai/onboard-devin/environment/windows-support.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-021 Name the provider failure cause and its fix on the Reason line

- Issue: #351 (existing). Area: onboarding. Size: S. Tier: LOW. Deps: none.
- Problem: Auth, login and credit failures read as generic errors.
- Metric and target: First-run abandonment target <= 10%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-022 Check publish capability at intake, before any work

- Issue: #231 (existing). Area: onboarding. Size: S. Tier: MEDIUM. Deps: none.
- Problem: A run builds for minutes, then cannot open a PR.
- Metric and target: Runs lost to publish failure target 0 per 100.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-023 Zero-install try in a dev container or Codespace

- Issue: #373. Area: onboarding. Size: S. Tier: LOW. Deps: FR-E.
- Problem: Prospects will not install a CLI to see a sealed run (FR-E).
- Feature: A `.devcontainer/` config and README badge; the container boots and runs `loki tour`, then a live task when a key is present.
- Acceptance:
  - `devcontainer up` on the repo finishes and `loki tour` exits 0 inside it.
  - Link to verified sample receipt in <= 180 s, timed in CI.
  - The container image needs 0 manual installs (asserted by a script with no network after boot).
- Metric and target: Link-to-verified-receipt p50 <= 180 s; conversion from try to install.
- Competitor baseline: Claude Code: `--cloud` creates a cloud session (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Cloud environments page (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Environment blueprints (https://docs.devin.ai/onboard-devin/environment/blueprints.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-024 Starter task suggestions from issues, TODOs and failing tests

- Issue: #374. Area: onboarding. Size: S. Tier: LOW. Deps: loki next.
- Problem: A new user in a repo does not know what small task to give first.
- Feature: `loki next` with no active run proposes 3 small tasks from open issues, TODO/FIXME lines and failing tests, each with a cost estimate; picking a number starts it.
- Acceptance:
  - Fixture with 2 issues and 5 TODOs: `loki next --suggest --json | jq length` prints 3.
  - Each suggestion carries `est_usd` and `source` (issue, todo or test).
  - `loki next --suggest --pick 1` starts a run within 2 s.
  - The command finishes in <= 10 s with no model call.
- Metric and target: Time to first VERIFIED build; day-1 runs per new user target >= 2.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-025 `loki try <repo-url>`: one command to a sealed sample change on any public repo

- Issue: #375. Area: onboarding. Size: S. Tier: LOW. Deps: R100-024.
- Problem: Evaluators want to see Loki on a real repo without touching their own checkout.
- Feature: Clone a public repo into a run-owned temp worktree, pick a starter task, run it, show the receipt, then clean up.
- Acceptance:
  - `loki try https://github.com/<fixture> --dry-run` prints the clone path, task and estimate.
  - After the run, `loki verify <receipt>` exits 0 and the temp dir is removed (0 leftover dirs).
  - The user's current checkout has 0 changed files.
- Metric and target: Evaluator conversion to install; time to first VERIFIED build.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Index a Repository page (https://docs.devin.ai/onboard-devin/index-repo.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-026 Readable plan with cost in under 10 seconds

- Issue: #376. Area: speed. Size: S. Tier: LOW. Deps: loki plan.
- Problem: Users wait before they see whether Loki understood the task.
- Feature: `loki plan` streams a one-screen plan and cost estimate from the small tier first, then refines.
- Acceptance:
  - First plan line prints in <= 3 s and the full plan in <= 10 s p50 over 5 fixture tasks with a real provider.
  - The plan is <= 40 lines and lists acceptance clauses.
  - The later refined plan differs from the first in a printed diff of <= 20 lines or prints `unchanged`.
- Metric and target: Plan-to-start conversion target >= 70%.
- Competitor baseline: Claude Code: `--permission-mode` includes a plan mode choice (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: `--use-spec` starts in spec mode (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-027 Desktop and phone push notifications when a run needs you or finishes

- Issue: #377. Area: speed. Size: S. Tier: LOW. Deps: notify.
- Already exists (corrected 2026-10-23): Desktop notifications already exist on the legacy route (`send_notification` in `autonomy/run.sh`), and `loki notify` sends to slack, discord and webhook. This item adds a desktop channel and ntfy to `loki notify` and engine10.
- Problem: Users miss a blocked question for hours because notify only covers Slack, Discord and webhooks.
- Feature: Add `desktop` (macOS and Linux) and `ntfy` channels to `loki notify`, fired on blocked, done and failed.
- Acceptance:
  - `loki notify test --channel desktop` exits 0 on macOS and Linux runners.
  - A fixture run fires exactly 2 events (blocked, done) to a stub ntfy server.
  - `loki notify status` lists the 2 new channels.
- Metric and target: Median time from block to answer target <= 15 min.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Devin sends direct messages for alerts (https://docs.devin.ai/integrations/slack (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-028 Best-of-N implement for small tasks

- Issue: #378. Area: speed. Size: M. Tier: MEDIUM. Deps: M-17 scheduler.
- Already exists (corrected 2026-10-23): Two parallel attempts already exist behind `LOKI_E10_ATTEMPTS=2` (default off) in `loki-ts/src/features/attempts.ts`. This item makes that the default for small tasks and records the arms in the receipt.
- Problem: One unlucky attempt costs a whole retry round.
- Feature: `LOKI_BEST_OF=2` runs 2 implementations in parallel worktrees on the cheap tier and keeps the first that seals (extends the modernize best-of-2 scheduler to start).
- Acceptance:
  - Fixture: 2 worktrees created, 1 sealed result kept, the other deleted (0 left).
  - The receipt records `arms: 2` and the chosen arm.
  - Wall time with N=2 is <= 1.1x N=1 on the paired fixture set.
- Metric and target: First-attempt seal rate target +15 points.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-029 Warm engine daemon for sub-second start

- Issue: #379. Area: speed. Size: M. Tier: MEDIUM. Deps: SPD-B.
- Already exists (corrected 2026-10-23): The warm engine already ships (D61): `loki-ts/src/features/warm.ts` and `warm_client.ts`, on by default. This item is limited to measuring startup overhead and a read-only `loki daemon status`; if warm p50 is already at or under 1 s, #379 closes as a duplicate of D61.
- Problem: Each `loki start` pays engine boot, repo map and test map cost.
- Feature: `loki daemon` keeps the Bun engine, repo map and test map warm per repo; `loki start` attaches when it is running.
- Acceptance:
  - With the daemon up, pre-model overhead is <= 1 s p50 over 10 starts (SPD-B probe).
  - `loki daemon status --json` lists warm repos.
  - Killing the daemon makes the next start fall back cold with 0 errors.
- Metric and target: Time to first stage event; runs per user per week.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: `daemon` runs the Factory daemon server (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-030 Re-seal in under a minute after a human edits a Loki PR

- Issue: #380. Area: speed. Size: M. Tier: HIGH. Deps: fast_verify.
- Problem: A one-line human tweak drops the receipt and a full re-verify is slow.
- Feature: `loki verify --reseal` re-runs only the checks affected by the new commits and issues an updated receipt.
- Acceptance:
  - Fixture 1-file edit: `loki verify --reseal` finishes in <= 60 s and exits 0.
  - The new receipt references the prior receipt id and the new head sha.
  - An edit that breaks a clause exits non-zero and names the clause.
- Metric and target: Share of human-edited PRs that keep a valid receipt target >= 80%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: Local review of uncommitted changes or a commit (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-031 Opt-in fast mode with ledger premium and fallback

- Issue: #279 (existing). Area: speed. Size: M. Tier: MEDIUM. Deps: router.
- Problem: Users who value time cannot trade money for speed.
- Metric and target: Time to sealed PR target -30% when enabled.
- Competitor baseline: Claude Code: Fast mode is documented for Claude Code (session guidance); `--effort` flag (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-032 Progress mirrored to the Slack thread and a live PR checklist

- Issue: #381. Area: speed. Size: S. Tier: LOW. Deps: slack_inbound.
- Problem: Teammates who started a run from Slack or an issue cannot see progress without a terminal.
- Feature: Each stage transition edits one Slack thread message and a draft PR checklist in place.
- Acceptance:
  - Fixture run: 1 Slack message edited >= 5 times, 0 new messages per stage.
  - The draft PR body checklist ticks 7 stage boxes by the end.
  - Edits are rate-limited to <= 1 per 5 s per thread.
- Metric and target: Abandoned-run rate for Slack-started runs target -25%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Automations post run results to a channel (https://docs.devin.ai/integrations/slack (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-033 Database provisioning per preview

- Issue: #382. Area: deploy. Size: L. Tier: MEDIUM. Deps: R100-004.
- Problem: Apps with a database cannot get a working preview.
- Feature: A deploy hook creates a database (Postgres in Docker, or a branch on the user's provider), runs migrations and injects the URL (DEP-C).
- Acceptance:
  - Fixture app with 2 migrations: the preview database reports 2 applied migrations.
  - The URL reaches the app as an env var and never appears on argv (ps fixture finds 0).
  - Pruning a preview drops its database (0 left).
- Metric and target: Share of previews that pass health for apps with a DB target >= 90%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-034 Run the spec's user flows against the live deploy URL

- Issue: #383. Area: deploy. Size: M. Tier: HIGH. Deps: #249, R100-004.
- Problem: A deploy can pass a health probe while the main flow is broken.
- Feature: After deploy, run the browser flow checks from #249 against the deployed URL and record them in the receipt.
- Acceptance:
  - Fixture: a deployed app with a broken login flow reports 1 failing clause and exit code 2.
  - A healthy deploy records N of N flows passing in the receipt.
  - Flow checks finish in <= 120 s for 5 flows.
- Metric and target: Post-deploy incident rate target -30%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-035 Container image build and push with SBOM bound to the receipt

- Issue: #384. Area: deploy. Size: M. Tier: MEDIUM. Deps: DEP-F.
- Problem: Teams that ship containers must build and push by hand after Loki finishes.
- Feature: `loki deploy --target container --registry <url>` builds the image, pushes it, and binds the digest and an SBOM to the receipt.
- Acceptance:
  - Fixture with a local registry: 1 image pushed and its digest equals the receipt's `image_digest`.
  - An SBOM file is attached and listed in the receipt (1 entry).
  - Registry credentials never appear in the receipt (redaction test finds 0).
- Metric and target: Share of container repos that deploy through Loki.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-036 Kubernetes deploy with canary through the user's own kube context

- Issue: #385. Area: deploy. Size: L. Tier: HIGH. Deps: R100-018.
- Problem: Teams on Kubernetes cannot use `loki deploy`.
- Feature: Generate or reuse manifests, apply to the user's current context with a canary step, health-gate, and roll back on failure.
- Acceptance:
  - `loki deploy --target k8s --dry-run` prints the manifests and 0 cluster writes.
  - On a kind cluster fixture, the canary takes 10% of replicas, then promotes after 3 passing probes.
  - A failing probe rolls back and the receipt records it.
- Metric and target: Share of k8s repos that deploy through Loki.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-037 `loki deploy init`: detect a logged-in deploy CLI and write config with no questions

- Issue: #386. Area: deploy. Size: S. Tier: LOW. Deps: none.
- Problem: First deploy needs provider flags and env files the user has to look up.
- Feature: Detect logged-in netlify, vercel, wrangler or flyctl, pick the project, and write the deploy block to loki.yaml.
- Acceptance:
  - Fixture with 1 stubbed logged-in CLI: `loki deploy init` writes loki.yaml with 0 prompts.
  - With 2 logged-in CLIs it asks exactly 1 question.
  - `loki deploy --dry-run` succeeds right after init.
- Metric and target: Time from first VERIFIED build to first deploy p50 <= 5 min.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-038 CODEOWNERS-aware reviewers on every Loki PR

- Issue: #387. Area: team. Size: S. Tier: LOW. Deps: github publish.
- Problem: Loki PRs land with no reviewer and wait.
- Feature: Request reviewers from CODEOWNERS for touched paths and list owners per file in the PR body.
- Acceptance:
  - Fixture with 3 owner rules: the PR requests exactly the 2 matching owners.
  - The PR body lists the owner for each of the changed files.
  - No CODEOWNERS file requests 0 reviewers and prints 1 hint.
- Metric and target: Median time to first review target -30%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-039 Fill the repo's pull request template

- Issue: #388. Area: team. Size: S. Tier: LOW. Deps: R100-006.
- Problem: Loki PR bodies ignore the team's template, so reviewers reject them.
- Feature: When `.github/pull_request_template.md` exists, Loki fills each section from the receipt and plan.
- Acceptance:
  - Fixture template with 4 headings: the PR body contains the 4 headings, each non-empty.
  - Checkbox items proven by the receipt are ticked; unproven ones stay unticked.
  - Repos with no template keep today's body byte-identical.
- Metric and target: Loki PRs merged without body edits target >= 90%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: GitHub Pull Request Templates page (https://docs.devin.ai/integrations/pr-templates.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-040 Team memory shared through git

- Issue: #389. Area: team. Size: M. Tier: MEDIUM. Deps: R100-011.
- Problem: Each teammate's Loki learns alone.
- Feature: `loki memory push` and `pull` sync redacted, approved lessons through a committed `.loki/team-memory/` folder.
- Acceptance:
  - Fixture with 2 clones: a lesson pushed in clone A appears in clone B's brief after pull.
  - A lesson containing a secret fixture is redacted (0 secret matches in the committed file).
  - Only lessons marked approved are pushed (fixture with 3 lessons, 1 approved, pushes 1).
- Metric and target: Week-4 retention of team repos.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: AGENTS.md checked into the repo (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Knowledge Onboarding page (https://docs.devin.ai/onboard-devin/knowledge-onboarding.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-041 Team login for the shared Control Plane

- Issue: #188 (existing). Area: team. Size: L. Tier: HIGH. Deps: none.
- Problem: Teams cannot share one dashboard safely beyond localhost.
- Metric and target: Weekly active viewers per team.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-042 Bitbucket and Azure DevOps pull requests

- Issue: #390. Area: team. Size: M. Tier: MEDIUM. Deps: push-mr.
- Problem: V10-VISION promises neutrality across GitHub, GitLab and Bitbucket; only GitHub and GitLab publish today.
- Feature: Publish branches and open PRs on Bitbucket Cloud and Azure DevOps with the receipt in the body.
- Acceptance:
  - Fixture remotes for each host: 1 PR created per host via stubbed API (2 of 2).
  - The PR body carries the receipt id; tokens never appear on argv (0 matches).
  - `loki doctor --json` reports the host type for 4 hosts.
- Metric and target: Share of non-GitHub repos among active repos.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-043 Release notes written from sealed receipts

- Issue: #391. Area: team. Size: S. Tier: LOW. Deps: receipts.
- Problem: Teams write release notes by hand from PR titles.
- Feature: `loki report release-notes <from>..<to>` groups sealed changes by clause and area, with receipt links and a list of unsealed commits.
- Acceptance:
  - Fixture range with 5 sealed and 2 unsealed commits: output lists 5 under changes and 2 under not sealed.
  - Each entry links its receipt id.
  - `--format json` emits the same 7 rows.
- Metric and target: Teams using it per release; week-4 retention.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-044 VS Code extension: run panel and receipt viewer

- Issue: #392. Area: ide. Size: L. Tier: MEDIUM. Deps: R100-007.
- Problem: VS Code users must switch to a terminal to start, steer and read receipts.
- Feature: An extension that starts runs, follows status, answers blocked questions and renders the receipt and clause matrix, talking to the CLI (no new engine).
- Acceptance:
  - The extension activates in VS Code and lists the current run from `loki status --json` within 2 s.
  - Start, steer and answer buttons call the CLI; a fixture asserts 3 CLI invocations.
  - Receipt view shows verdict and N of N clauses equal to `loki proof` output.
- Metric and target: Runs per user per week for VS Code users; week-2 return rate.
- Competitor baseline: Claude Code: `--ide` connects to an IDE on startup (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Codex IDE extension (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Embedded editor in Devin Session Tools; no VS Code page in the index (https://docs.devin.ai/work-with-devin/devin-session-tools.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: IDE integrations page (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-045 Ready-made ACP configs for Zed and JetBrains

- Issue: #393. Area: ide. Size: S. Tier: LOW. Deps: loki acp.
- Problem: `loki acp` exists but users must hand-write editor config.
- Feature: `loki acp --print-config zed|jetbrains` prints a working snippet and `loki acp --check` runs the handshake.
- Acceptance:
  - `loki acp --print-config zed` prints valid JSON that parses with 1 agent entry.
  - `loki acp --check` completes an initialize round-trip in <= 3 s.
  - Both editors' docs pages link the snippet.
- Metric and target: Runs started from editors per week.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: ACP pages for JetBrains, Zed and Xcode (https://docs.devin.ai/cli/acp/zed.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-046 Start, status and seal commands in the Claude Code plugin

- Issue: #394. Area: ide. Size: S. Tier: LOW. Deps: R100-002.
- Problem: The plugin ships grill, spec-status and handoff commands, but not start, status or seal.
- Feature: Add `/loki-start`, `/loki-status` and `/loki-seal` commands to `plugins/loki-mode/commands/`.
- Acceptance:
  - Plugin manifest lists 3 new commands and plugin lint passes.
  - Each command calls the CLI with fixed argv (a test asserts 3 argv shapes).
  - `/loki-seal` on a fixture diff prints a receipt id.
- Metric and target: Runs started from inside Claude Code per week.
- Competitor baseline: Claude Code: `plugin` manages plugins (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: `plugin` manages plugins (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-047 Full-screen terminal UI with approve, steer and pause keys

- Issue: #395. Area: ide. Size: M. Tier: LOW. Deps: R100-007.
- Problem: Watching a run means juggling `status`, `logs` and `diff`.
- Feature: `loki tui` shows stages, diff, tests and cost in panes; keys a, s and p approve, steer and pause.
- Acceptance:
  - `loki tui --once` renders 4 panes to a fixed-size pty snapshot.
  - Pressing p in a fixture writes 1 PAUSE signal.
  - The UI redraws in <= 100 ms per event on the fixture stream.
- Metric and target: Session length and runs per user per week.
- Competitor baseline: Claude Code: Interactive terminal session is the default (`claude` with no subcommand). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: Interactive mode is the default (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-048 Images and mockups as task input

- Issue: #396. Area: ide. Size: M. Tier: MEDIUM. Deps: #263.
- Problem: Users cannot give a screenshot or mockup as part of the spec.
- Feature: `loki start --image mock.png` attaches images to the plan and Wall stages; the Wall may write visual acceptance clauses.
- Acceptance:
  - `loki start --image a.png --dry-run` lists 1 image in the brief.
  - Images over 10 MB are refused with 1 named error.
  - The receipt hashes each input image (1 hash per image).
- Metric and target: Share of UI tasks sealed on first attempt.
- Competitor baseline: Claude Code: `--file` downloads file resources at startup (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Image inputs page (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Files can be attached to a Slack mention (https://docs.devin.ai/integrations/slack (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-049 MCP one-click install works on a clean machine

- Issue: #397. Area: ide. Size: S. Tier: LOW. Deps: FR-D.
- Problem: A README deeplink with no env can exit 2 on a non-TTY launch (FR-D).
- Feature: Deeplinks and `loki mcp install` carry the auto-bootstrap env.
- Acceptance:
  - Clean-HOME non-TTY launch answers `tools/list` with exit 0.
  - `loki mcp install` output for 4 clients carries `LOKI_MCP_AUTO_BOOTSTRAP=1` (4 of 4).
  - README deeplinks decode to configs with the env set (count equals deeplink count).
- Metric and target: MCP installs that reach a first tool call target >= 90%.
- Competitor baseline: Claude Code: `mcp` configures MCP servers (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: MCP page (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: MCP marketplace page (https://docs.devin.ai/work-with-devin/mcp.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: `mcp` manages MCP servers (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-050 Start, steer and answer runs from the Control Plane in the browser

- Issue: #398. Area: ide. Size: M. Tier: MEDIUM. Deps: #188.
- Problem: Users away from the terminal cannot act on a run from the dashboard.
- Feature: Control Plane run page gets start, steer and answer actions over the existing API.
- Acceptance:
  - A Playwright fixture starts a run from the page and `loki status --json` shows it running within 3 s.
  - Steer and answer actions write 1 inbox entry each.
  - Actions need the dashboard token; an unauthenticated POST gets 401.
- Metric and target: Runs started outside the terminal per week.
- Competitor baseline: Claude Code: `--remote-control` session from browser or phone (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Codex cloud (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: Follow and take over work in the web app (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-051 Answer blocked questions from the phone with a push reply action

- Issue: #399. Area: ide. Size: S. Tier: MEDIUM. Deps: R100-003, R100-027.
- Problem: A blocked question on a commute waits until the user is back at a desk.
- Feature: The ntfy channel from R100-027 carries reply actions that call the inbox API.
- Acceptance:
  - A stub ntfy reply resumes the blocked fixture run (1 `run.resumed`).
  - Replies are signed; an unsigned reply is rejected (1 refusal).
  - End-to-end reply to resume <= 5 s on the fixture.
- Metric and target: Median time from block to answer target <= 15 min.
- Competitor baseline: Claude Code: `--remote-control` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: Reply in the Slack thread (https://docs.devin.ai/integrations/slack (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-052 Code embedding provider for memory retrieval

- Issue: #248 (existing). Area: memory. Size: M. Tier: MEDIUM. Deps: none.
- Problem: Retrieval falls back to grep without a local model.
- Metric and target: Lesson hit rate per run.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-053 Search every past run: `loki history search`

- Issue: #400. Area: memory. Size: S. Tier: LOW. Deps: none.
- Problem: Users cannot find the run where a decision or fix was made.
- Feature: Full-text search across runs, receipts, decisions and lessons with run id and date.
- Acceptance:
  - Fixture with 20 runs: `loki history search auth --json` returns the 3 matching runs.
  - Each hit carries run id, date, file and line.
  - Search over 1000 runs finishes in <= 1 s.
- Metric and target: Week-2 return rate.
- Competitor baseline: Claude Code: `-r, --resume [value]` resumes by session id or search (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Resume a saved chat (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: UNKNOWN. Factory droid: `search|find` searches across local sessions (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-054 `loki blame <file>:<line>`: which run, clause and decision produced this line

- Issue: #401. Area: memory. Size: S. Tier: LOW. Deps: P12-37 decisions.
- Problem: Months later nobody knows why Loki wrote a line.
- Feature: Map a line to its commit, receipt, clause and decision record.
- Acceptance:
  - Fixture: `loki blame src/a.ts:10 --json` returns run id, receipt id and clause id.
  - A line not written by Loki returns `not_loki` with exit 0.
  - Output in <= 1 s on a 1000-commit fixture.
- Metric and target: Repeat users of trust features per week.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-055 Personal profile applied across repos

- Issue: #402. Area: memory. Size: M. Tier: MEDIUM. Deps: R100-011.
- Problem: A user repeats the same preferences in every repo.
- Feature: `~/.loki/profile.yaml` holds editable preferences (test style, commit style, language), learned from lessons the user promotes, applied to every repo below repo rules.
- Acceptance:
  - `loki memory profile --json` lists entries with source lesson ids.
  - Repo rules override profile entries (a fixture conflict resolves to the repo rule).
  - `loki memory profile forget <key>` removes it from the next brief.
- Metric and target: Week-4 retention.
- Competitor baseline: Claude Code: Auto-memory named in `--bare` help (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: Devin Memory page (https://docs.devin.ai/product-guides/memory.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-056 Memory page in the Control Plane: view, pin, edit and forget lessons

- Issue: #403. Area: memory. Size: S. Tier: LOW. Deps: R100-011.
- Problem: Lessons are only manageable from the CLI.
- Feature: A Control Plane page over `loki memory lessons` with use counts and outcomes.
- Acceptance:
  - The page lists the same N lessons as `loki memory lessons --json` (N equal).
  - Forget in the UI removes the lesson from the next brief.
  - Pinned lessons appear first in the brief (order test).
- Metric and target: Lessons edited per active user per month.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Devin Memory page (https://docs.devin.ai/product-guides/memory.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-057 Playbooks: save a sealed run as a reusable task recipe

- Issue: #404. Area: memory. Size: M. Tier: LOW. Deps: templates.
- Problem: Repeated chores (upgrade a dependency, add an endpoint) are re-described every time.
- Feature: `loki playbook save <run> <name>` stores the spec, parameters and checks; `loki playbook run <name> key=value` reuses it.
- Acceptance:
  - `loki playbook save` writes 1 recipe file with named parameters.
  - `loki playbook run upgrade dep=react` fills the parameter into the spec (fixture diff).
  - `loki playbook list --json` lists recipes with last verdict.
- Metric and target: Runs per user per week from playbooks.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Creating Playbooks and Using Playbooks pages (https://docs.devin.ai/product-guides/creating-playbooks.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: Skills: reusable procedures via `/skills` (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-058 Reverted changes become lessons and regression-test proposals

- Issue: #405. Area: memory. Size: S. Tier: MEDIUM. Deps: outcomes.
- Problem: `loki outcomes` sees a revert but nothing learns from it.
- Feature: On a detected revert of a sealed change, record a lesson and propose a regression test for the next run in that area.
- Acceptance:
  - Fixture with 1 reverted sealed commit: `loki memory lessons --json` gains 1 lesson citing the revert sha.
  - The next run touching the same file gets the proposed test in its brief.
  - A revert of an unsealed commit adds 0 lessons.
- Metric and target: Post-merge change-failure rate target -20%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-059 Live cost meter with alerts at 50, 80 and 100 percent of budget

- Issue: #406. Area: cost. Size: S. Tier: LOW. Deps: R100-007.
- Problem: Users learn the cost after the run.
- Feature: Status, follow view and notify show spend so far and projected final cost; alerts fire at 50, 80 and 100 percent of `--budget`.
- Acceptance:
  - Fixture run with budget 1.00: notify receives exactly 3 alerts at 0.50, 0.80 and 1.00.
  - `loki status --json` has `usd_so_far` and `usd_projected`.
  - Projected cost at the halfway stage is within 30% of final on the fixture set.
- Metric and target: Runs stopped by surprise cost target 0 per 100.
- Competitor baseline: Claude Code: `--max-budget-usd` with `--print` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: Per-user ACU limits (https://docs.devin.ai/enterprise/features/usage-policies.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-060 Estimate accuracy: show actual vs estimate and self-calibrate

- Issue: #407. Area: cost. Size: S. Tier: LOW. Deps: estimate.
- Problem: Users stop trusting estimates that are never checked.
- Feature: After each run print estimate vs actual; `loki cost --history` shows the error per size class and the estimator uses it.
- Acceptance:
  - `loki cost --history --json` lists rows with `est_usd`, `actual_usd`, `error_pct`.
  - After 10 fixture runs the median absolute error is reported per size class (3 classes).
  - Estimates after calibration move toward actuals on the fixture (error drops).
- Metric and target: Median estimate error target <= 25%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-061 Monthly budgets per repo and per user

- Issue: #408. Area: cost. Size: M. Tier: MEDIUM. Deps: ledger.
- Problem: Teams cannot cap spend across runs.
- Feature: `budgets:` in loki.yaml sets monthly caps per repo and per user; runs that would exceed pause with a named reason.
- Acceptance:
  - Fixture: monthly cap 10 with 9.50 spent: a run estimated at 1.00 pauses before any model call.
  - `loki report cost --month --json` shows spent and remaining per repo.
  - Caps apply across runs started by CLI, Slack and Action (3 entry fixtures).
- Metric and target: Teams with caps set; overspend incidents target 0.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Per-user ACU limits (Usage Policies page) (https://docs.devin.ai/enterprise/features/usage-policies.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-062 Cost breakdown by stage and route with savings against an all-top-model baseline

- Issue: #409. Area: cost. Size: S. Tier: LOW. Deps: ledger.
- Problem: Users cannot see where money goes or what routing saved.
- Feature: `loki report cost --breakdown` lists cost per stage and model and the counterfactual cost at the top model.
- Acceptance:
  - Fixture ledger with 4 stages: output has 4 rows summing to the run total within 0.01 USD.
  - A `savings_usd` field equals counterfactual minus actual.
  - `--json` and text agree on all totals.
- Metric and target: Cost per sealed change visible to users; retention of cost-sensitive users.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Usage page (https://docs.devin.ai/admin/billing/usage.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-063 Finance export: monthly CSV of spend by repo, user and sealed change

- Issue: #410. Area: cost. Size: S. Tier: LOW. Deps: ledger.
- Problem: Finance needs spend tied to delivered work.
- Feature: `loki report cost --month 2026-10 --csv` exports rows per run with repo, user, usd and verdict.
- Acceptance:
  - Fixture month with 12 runs: CSV has 12 rows plus a header with 6 columns.
  - Sum of the usd column equals the ledger total within 0.01.
  - No secrets or prompts appear in the CSV (redaction test, 0 matches).
- Metric and target: Team accounts retained past month 2.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Usage page (https://docs.devin.ai/admin/billing/usage.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-064 Warn when attached MCP tool definitions cost too many tokens

- Issue: #290 (existing). Area: cost. Size: S. Tier: LOW. Deps: none.
- Problem: Hidden tool definitions inflate every call.
- Metric and target: Prompt tokens per run target -10% for warned users.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-065 Show prompt-cache savings per run

- Issue: #411. Area: cost. Size: S. Tier: LOW. Deps: ledger.
- Problem: Users do not see that cache reuse saved money.
- Feature: Run summary and kpis show cache read tokens and the dollar saving.
- Acceptance:
  - Fixture ledger with cache reads: summary prints `cache_saved_usd` > 0.
  - A run with 0 cache reads prints 0.00.
  - The value equals tokens times the price delta from model-pricing.json (unit test).
- Metric and target: Perceived value; week-2 return rate.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-066 Quote approval for expensive runs

- Issue: #412. Area: cost. Size: S. Tier: MEDIUM. Deps: R100-010.
- Problem: A large backlog run can spend more than a user expects.
- Feature: Runs whose estimate exceeds `quote_over_usd` wait for approval in the inbox, Slack or terminal before any model call.
- Acceptance:
  - Fixture with quote_over_usd 5 and estimate 8: 0 model calls before approval.
  - Approval through `loki inbox approve` starts the run within 2 s.
  - Runs under the threshold start with 0 prompts.
- Metric and target: Overspend incidents target 0.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-067 Provider adapters for GitHub Copilot CLI, cursor-agent and Factory droid

- Issue: #413. Area: providers. Size: M. Tier: MEDIUM. Deps: #347.
- Problem: Users of those agents cannot run Loki on their existing subscription.
- Feature: Three new provider configs in `providers/` with the same contract and doctor rows.
- Acceptance:
  - `loki provider list` shows 3 new providers.
  - Each passes the provider contract test with a stub CLI (3 of 3).
  - `loki doctor --json` has an auth row for each (3 rows).
- Metric and target: Active users on non-Claude providers.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: `exec` runs non-interactively for scripts (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-068 Any OpenAI-compatible endpoint on every route

- Issue: #414. Area: providers. Size: M. Tier: MEDIUM. Deps: #267.
- Problem: OpenAI-shaped gateways work only through the aider and cline routes.
- Feature: `loki provider add openai-compatible --base-url <url> --model <id>` works for implement and judge stages.
- Acceptance:
  - Fixture stub endpoint receives implement and judge calls (2 call types).
  - `loki doctor --json` probes the endpoint with 0 tokens spent.
  - The API key never appears on argv (ps fixture, 0 matches).
- Metric and target: Share of runs on self-hosted gateways.
- Competitor baseline: Claude Code: `gateway` runs the enterprise auth gateway (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-069 Judge client from the provider the user configured

- Issue: #267 (existing). Area: providers. Size: M. Tier: HIGH. Deps: none.
- Problem: Bedrock, Vertex and Foundry users need a second key for judges.
- Metric and target: Runs blocked by missing judge auth target 0.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-070 One effort and thinking knob across all five providers

- Issue: #346 (existing). Area: providers. Size: M. Tier: MEDIUM. Deps: none.
- Problem: Effort settings differ per provider.
- Metric and target: Cost per sealed change.
- Competitor baseline: Claude Code: `--effort` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-071 Doctor auth rows and a zero-token probe for every provider

- Issue: #347 (existing). Area: providers. Size: S. Tier: MEDIUM. Deps: none.
- Problem: Auth failures appear mid-run.
- Metric and target: First-run abandonment.
- Competitor baseline: Claude Code: `doctor` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: `codex doctor` (docs/COMPETITIVE-SCORECARD.md, measured on codex-cli 0.146.0 (codex is not installed on this host on 2026-10-23)). Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-072 Hybrid local and cloud: offload cheap stages to a local model when present

- Issue: #415. Area: providers. Size: M. Tier: MEDIUM. Deps: models --local.
- Problem: Users with Ollama pay cloud prices for lint fixes and unit tests.
- Feature: When `loki models --local` finds a capable model, route the cheapest stages to it by default and record it in the receipt.
- Acceptance:
  - Fixture with a stub local endpoint: 2 named cheap stages route locally.
  - The receipt lists the local model for those stages.
  - If the local endpoint is down, the stage falls back to cloud with 1 warning.
- Metric and target: Cost per sealed change target -20% for local-capable users.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-073 New-model check: `loki models --new` compares a new model on your recent tasks

- Issue: #416. Area: providers. Size: S. Tier: LOW. Deps: R100-015, #268.
- Problem: Users learn of a better model late.
- Feature: When the Models API lists a new model, offer a `loki compare` run on the last 3 sealed tasks and recommend.
- Acceptance:
  - Fixture catalog delta of 1 model: `loki models --new --json` lists 1 entry.
  - `--compare` plans 3 tasks times 2 routes (6 arms) in dry-run.
  - No spend happens without the explicit `--execute` flag (0 model calls in dry-run).
- Metric and target: Cost per sealed change trend over model releases.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-074 Model route settings in the Control Plane with live prices

- Issue: #417. Area: providers. Size: S. Tier: LOW. Deps: #188.
- Problem: Changing per-stage models needs env vars.
- Feature: A settings page that reads and writes the route in loki.yaml with prices from model-pricing.json.
- Acceptance:
  - Saving a route on the page changes `loki models --json` output (1 field).
  - Prices shown equal model-pricing.json for every listed model.
  - Invalid routes are refused with a named error.
- Metric and target: Users who change routes; cost per sealed change.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-075 Maintenance autopilot: dependency upgrades, lint debt and flaky tests as sealed PRs

- Issue: #418. Area: autonomy. Size: M. Tier: MEDIUM. Deps: loki trigger.
- Problem: Chores never get scheduled.
- Feature: `loki maintain deps|lint|flaky` runs on a `loki trigger` schedule and keeps at most N open PRs.
- Acceptance:
  - `loki maintain deps --dry-run` lists outdated packages with a planned PR count.
  - With max_open 2 and 5 candidates, 2 PRs open and 3 wait.
  - Each PR carries a receipt; a failed upgrade opens 0 PRs and 1 inbox item.
- Metric and target: Sealed PRs per repo per week; week-8 retention.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Scheduled Sessions page (https://docs.devin.ai/product-guides/scheduled-sessions.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-076 Preserve working state across compaction

- Issue: #277 (existing). Area: autonomy. Size: M. Tier: MEDIUM. Deps: none.
- Problem: Long runs lose state on compaction.
- Metric and target: Long-run completion rate.
- Competitor baseline: Claude Code: `--autocompact` window (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-077 Relay operator input to a running worker

- Issue: #278 (existing). Area: autonomy. Size: M. Tier: MEDIUM. Deps: none.
- Problem: Steering waits for a stage boundary.
- Metric and target: Human touches per shipped change.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-078 Every run in its own worktree by default

- Issue: #232 (existing). Area: autonomy. Size: M. Tier: HIGH. Deps: none.
- Problem: A second run in one checkout collides with the first.
- Metric and target: Concurrent runs per user.
- Competitor baseline: Claude Code: `--worktree` and `--tmux` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: `-w, --worktree` (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-079 Multi-day missions with milestone receipts

- Issue: #419. Area: autonomy. Size: L. Tier: MEDIUM. Deps: R100-009.
- Problem: Work bigger than one run has no shape across days.
- Feature: `loki mission start <spec>` splits into milestones, each sealed with its own receipt, resumable across days; `loki mission status` shows progress.
- Acceptance:
  - Fixture spec with 3 milestones: 3 receipts, each referencing the mission id.
  - Stopping after milestone 1 and running `loki mission resume` starts milestone 2 (0 re-runs of 1).
  - `loki mission status --json` reports 3 milestones with states.
- Metric and target: Completion rate of multi-week work; week-4 retention.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: Missions via `/missions` or `droid exec --mission` (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-080 Overnight backlog window with a morning report

- Issue: #420. Area: autonomy. Size: S. Tier: LOW. Deps: loki backlog.
- Problem: Backlog runs during work hours compete with the user's own quota.
- Feature: `loki backlog <repo> --until 07:00` runs until the time window ends and posts one morning digest.
- Acceptance:
  - Fixture with a 2-minute window: 0 units start after the window ends.
  - Exactly 1 digest is sent with sealed, failed and waiting counts.
  - Unfinished units are left resumable (journal shows them pending).
- Metric and target: Sealed PRs per user per week target +50%.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Scheduled Sessions (https://docs.devin.ai/product-guides/scheduled-sessions.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-081 Move a run to another machine: export and import run state

- Issue: #421. Area: autonomy. Size: M. Tier: MEDIUM. Deps: R100-003.
- Problem: A run started on a laptop cannot continue on a server.
- Feature: `loki run export <id>` writes a redacted bundle; `loki run import` resumes it elsewhere at the same stage.
- Acceptance:
  - Export then import on a second fixture checkout resumes at the same stage id.
  - The bundle contains 0 secret fixture matches.
  - A bundle for a different repo head is refused with 1 named error.
- Metric and target: Abandoned-run rate.
- Competitor baseline: Claude Code: `--teleport` resumes a teleport session (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Move work to Codex cloud (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: `/handoff` from terminal to cloud Devin (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: `computer` manages relay computer registrations (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-082 Run replay: step through stages with the diff and test output at each step

- Issue: #422. Area: dashboard. Size: M. Tier: LOW. Deps: timeline.
- Problem: The human timeline shows phases, not what changed at each step.
- Feature: Extend the Control Plane timeline with a scrubber that shows diff, tests and cost at each stage.
- Acceptance:
  - Fixture run with 7 stages: the scrubber has 7 positions.
  - Each position shows the diff stat equal to the journal for that stage.
  - Loading a 500-event run takes <= 1 s.
- Metric and target: Time to understand a failed run; repeat dashboard visits.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Session Insights page (https://docs.devin.ai/product-guides/session-insights.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-083 Compare two runs side by side

- Issue: #423. Area: dashboard. Size: S. Tier: LOW. Deps: cp_runs_compare.
- Problem: Users cannot see why one attempt sealed and another did not.
- Feature: A Control Plane page over the existing runs-compare data: verdict, cost, time, clauses and diff.
- Acceptance:
  - Selecting 2 fixture runs shows 5 compared fields.
  - Clause differences are highlighted (fixture with 1 differing clause shows 1).
  - The page values equal `cp_runs_compare` output.
- Metric and target: Repeat dashboard visits.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-084 Weekly digest to Slack or email

- Issue: #424. Area: dashboard. Size: S. Tier: LOW. Deps: R100-019.
- Problem: Users forget Loki between sessions.
- Feature: Once a week, post sealed changes, cost, waiting items and top lesson to the notify channel.
- Acceptance:
  - Fixture week: 1 digest with 4 sections.
  - Opt-out with `LOKI_DIGEST=0` sends 0.
  - Numbers equal `loki report kpis --since 7d`.
- Metric and target: Week-2 and week-4 return rate.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Automations post run results to a channel (https://docs.devin.ai/integrations/slack (fetched 2026-10-23)). Factory droid: UNKNOWN.

#### R100-085 Stage time and cost chart per run

- Issue: #425. Area: dashboard. Size: S. Tier: LOW. Deps: events.
- Problem: Users cannot see which stage is slow or expensive.
- Feature: A per-run chart of stage durations and costs from the ledger and events.
- Acceptance:
  - Fixture run with 7 stages renders 7 bars.
  - Bar totals equal the run's wall time and cost within 1%.
  - The chart renders in light and dark themes (2 snapshots).
- Metric and target: Users who change settings after viewing.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-086 Repo health page: seal rate, revert rate and change-failure rate trends

- Issue: #426. Area: dashboard. Size: S. Tier: LOW. Deps: outcomes.
- Problem: `loki outcomes` numbers are CLI only.
- Feature: A Control Plane page with weekly trends from `loki outcomes` and receipts.
- Acceptance:
  - Fixture with 4 weeks of receipts shows 4 points per series (3 series).
  - Values equal `loki outcomes --json` for each week.
  - UNKNOWN weeks render as gaps, never as 0.
- Metric and target: Team account retention.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Session Insights (https://docs.devin.ai/product-guides/session-insights.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-087 Stuck-run alert when no progress for N minutes

- Issue: #427. Area: dashboard. Size: S. Tier: LOW. Deps: notify.
- Problem: A wedged run burns time unnoticed.
- Feature: If no event arrives for `LOKI_STUCK_MIN` (default 15) minutes, notify once with the last stage and a suggested action.
- Acceptance:
  - Fixture with a silent run: 1 alert after the threshold, 0 before.
  - The alert names the last stage and event time.
  - A run that resumes events clears the alert state.
- Metric and target: Abandoned-run rate.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-088 Hosted template registry: search and publish

- Issue: #428. Area: ecosystem. Size: M. Tier: LOW. Deps: loki template.
- Problem: `loki template` installs from source only; a central hub is listed as future work in its help.
- Feature: `loki template search <q>` and `loki template publish` against a static registry index in a public repo.
- Acceptance:
  - `loki template search api --json` returns entries from a fixture index.
  - `loki template publish` validates the manifest as data and opens 1 PR to the index repo (dry-run).
  - Installed templates keep the existing no-code-execution rule (0 executed files).
- Metric and target: Templates installed per week.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: Use case gallery (https://docs.devin.ai/use-cases/gallery/index.md, listed in https://docs.devin.ai/llms.txt, fetched 2026-10-23). Factory droid: UNKNOWN.

#### R100-089 Custom gates in loki.yaml that feed the Seal

- Issue: #429. Area: ecosystem. Size: M. Tier: HIGH. Deps: gates.
- Problem: Teams cannot add their own checks (Lighthouse, k6, license scan) to the Seal.
- Feature: `gates:` entries with a command, pass condition and timeout run with the other gates and are recorded as exogenous evidence.
- Acceptance:
  - Fixture with 2 custom gates: the receipt lists 2 extra gate rows with exit codes.
  - A failing custom gate blocks the Seal (exit 2).
  - A gate exceeding its timeout is recorded as UNKNOWN, never pass.
- Metric and target: Teams with custom gates; week-8 retention.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: Hooks run shell commands around lifecycle events (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-090 `loki hooks install`: fast verify on pre-commit

- Issue: #430. Area: ecosystem. Size: S. Tier: LOW. Deps: fast_verify.
- Problem: Developers find problems only in CI.
- Feature: Install a pre-commit hook that runs the fast verify on staged changes.
- Acceptance:
  - `loki hooks install` writes 1 hook and `--uninstall` removes it.
  - On a fixture commit the hook finishes in <= 1 s.
  - An existing hook is chained, not overwritten (fixture keeps its output).
- Metric and target: Daily active developers per repo.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-091 Signed outbound run webhooks with a typed event schema

- Issue: #431. Area: ecosystem. Size: S. Tier: MEDIUM. Deps: notify.
- Problem: Integrators parse free-form notify messages.
- Feature: Run lifecycle events posted as JSON with a schema version and an HMAC signature header.
- Acceptance:
  - Fixture run posts 4 lifecycle events to a stub receiver.
  - Each event validates against the published schema (4 of 4).
  - A receiver check with the wrong secret fails HMAC verification.
- Metric and target: Integrations built per month.
- Competitor baseline: Claude Code: `--include-hook-events` in stream-json (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: Hooks around lifecycle events (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-092 One MCP config for every MCP-capable provider

- Issue: #343 (existing). Area: ecosystem. Size: M. Tier: MEDIUM. Deps: none.
- Problem: MCP servers must be configured per provider.
- Metric and target: MCP usage per run.
- Competitor baseline: Claude Code: `--mcp-config` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: MCP page (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: UNKNOWN. Factory droid: `mcp` (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-093 Use existing Claude Code and droid skills in any provider's run

- Issue: #432. Area: ecosystem. Size: M. Tier: MEDIUM. Deps: #259.
- Problem: Skills written for one agent are lost when switching providers.
- Feature: Load `SKILL.md` folders from known skill dirs into the brief for every provider, with a doctor row.
- Acceptance:
  - Fixture with 2 skill folders: `loki memory brief --json` lists 2 skills.
  - A skill with a risky pattern is refused by the skill lint (#259) with 1 named finding.
  - `LOKI_SKILLS=0` loads 0.
- Metric and target: Users who switch providers and stay.
- Competitor baseline: Claude Code: `--disable-slash-commands` disables skills (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: Skills via `/skills` (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-094 Embeddable TypeScript SDK: `runLoki({ spec })`

- Issue: #433. Area: ecosystem. Size: M. Tier: MEDIUM. Deps: R100-091.
- Problem: Platforms that want to embed Loki shell out and parse text.
- Feature: A typed SDK export that starts a run, streams events and returns the receipt.
- Acceptance:
  - A fixture script imports the SDK, runs a stub task and receives a receipt object.
  - Event stream yields >= 7 stage events typed by the schema.
  - The SDK package has 0 runtime dependencies beyond the CLI's own.
- Metric and target: Embedded runs per week.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: The Devin API is listed on the docs home (https://docs.devin.ai/ (fetched 2026-10-23)). Factory droid: Exec mode for scripts and CI (https://docs.factory.com/cli/getting-started/overview (fetched 2026-10-23)).

#### R100-095 Receipts in a public transparency log

- Issue: #434. Area: trust. Size: M. Tier: HIGH. Deps: PRF-A.
- Problem: A self-generated trust root cannot be checked by a third party.
- Feature: Opt-in upload of receipt digests to Sigstore Rekor; `loki verify` checks inclusion (PRF-A).
- Acceptance:
  - `loki proof publish --rekor --dry-run` prints 1 planned entry.
  - On a staging log fixture, verify confirms inclusion (1 proof).
  - With the flag off, 0 network calls happen (egress fixture).
- Metric and target: Receipts verified by third parties.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-096 Clause-by-clause spec trace in the receipt

- Issue: #341 (existing). Area: trust. Size: L. Tier: HIGH. Deps: #340.
- Problem: Users cannot see which clauses were proven, judged or unproven.
- Metric and target: Reviewer trust; human review time.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-097 Numbered, anchored acceptance clauses from any spec

- Issue: #340 (existing). Area: trust. Size: M. Tier: HIGH. Deps: #339.
- Problem: Specs have no stable clause ids.
- Metric and target: Clauses proven per run.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: `--use-spec` spec mode (`droid --help`, droid 0.190.0, run 2026-10-23).

#### R100-098 Vision pass over captured screenshots in the Seal

- Issue: #263 (existing). Area: trust. Size: M. Tier: HIGH. Deps: none.
- Problem: Visual regressions pass text checks.
- Metric and target: UI change-failure rate.
- Competitor baseline: Claude Code: `--chrome` (`claude --help`, Claude Code 2.1.309, run 2026-10-23). Codex CLI: Image inputs (https://learn.chatgpt.com/docs/codex/cli (fetched 2026-10-23)). Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-099 Audit evidence pack from receipts

- Issue: #435. Area: trust. Size: S. Tier: HIGH. Deps: receipts.
- Problem: Auditors ask for change-management evidence that teams assemble by hand.
- Feature: `loki proof export --audit <from>..<to>` writes a zip of receipts, a CSV index and a verification script (evidence export only, no certification claim).
- Acceptance:
  - Fixture range with 6 receipts: the zip contains 6 receipts and a 6-row CSV.
  - The bundled verify script exits 0 offline on the pack.
  - Tampering 1 receipt makes the script exit non-zero and name it.
- Metric and target: Enterprise accounts retained.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.

#### R100-100 Page and line anchors for PDF and DOCX specs

- Issue: #339 (existing). Area: trust. Size: M. Tier: MEDIUM. Deps: none.
- Problem: Clauses from documents cannot point back to their source.
- Metric and target: Clauses traced to source.
- Competitor baseline: Claude Code: UNKNOWN. Codex CLI: UNKNOWN. Devin: UNKNOWN. Factory droid: UNKNOWN.
