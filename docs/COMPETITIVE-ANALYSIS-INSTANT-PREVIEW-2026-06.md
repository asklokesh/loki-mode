# Loki Mode vs Replit Agent / Lovable / Bolt.new -- Instant-Preview & Self-Healing Gap Analysis

Date: 2026-06-09
Author: autonomous analysis (verified against Loki source + competitor web research at knowledge cutoff Jan 2026 plus June 2026 web search)
Status: analysis + prioritized TODO. The TODO is the planning checkpoint, not an auto-launched implementation.

## 1. The user's framing

> "When users prompt a spec or idea, [Replit/Lovable/Bolt] just builds and spins up UI so users can try it. They are clever at suggesting what to add/update/improve/remove, finding bugs while the app runs and fixing them autonomously before the user realizes. Why are we not able to do that? We are lacking something that is causing friction for users (devs, enterprises, non-technical consumers)."

This is correct as a *felt experience* gap. It is NOT correct that Loki lacks the underlying capability. The gap is mostly **surfacing and loop-tightness**, plus a real **category difference**.

## 2. What the competitors actually do (verified June 2026)

### Replit Agent 3
- Runs autonomously up to ~200 minutes ("10x more autonomous than Agent 2").
- "Self-healing" loop: spins up a real browser, simulates user behavior (click/type/login), captures logs, and fixes bugs it hits during testing. Calls out "Potemkin interfaces" (looks-done-but-broken).
- REPL-based verification at scale; provisions database; verifies every button/API call.
- Code-to-Device: builds + previews native mobile via Expo QR instantly.
- "Stacks": agents building agents. RulesSync for replit.md across projects.
- Hosted: your project runs on Replit's cloud, instant live preview built into the IDE.

### Lovable
- Three modes: Visual Edits (click an element), Plan Mode (conversational), Agent Mode (autonomous codebase exploration + proactive debugging + real-time web search).
- Live preview updates in real time; checkpoint/version system to revert a bad edit.
- Pricing: Free (5 daily credits), Pro $25/mo, Business $50/mo; plus usage-based Cloud/AI billing on shipped apps.
- Hosted; greenfield-biased (build a new app from a prompt).

### Bolt.new (StackBlitz)
- WebContainer: Node runs natively *in the browser*, no server. Live preview updates as code generates; you click/fill/interact immediately.
- Agent has full control of filesystem, node server, package manager, terminal, browser console; human-in-the-loop chat + hand-edit.
- Bolt V2: Bolt Cloud (DB, auth, storage, edge functions, analytics, hosting), one-click Netlify deploy. Opus 4.6 with adjustable reasoning depth (Jan 2026).
- Hosted/in-browser; greenfield-biased.

Common thread: **hosted text-to-app**. Instant live preview is free because the runtime IS their cloud/browser sandbox. The inner loop (build -> see -> fix) is conversational, visible, real-time.

## 3. What Loki actually has (verified in source)

| Capability | Competitors | Loki today | Source |
|---|---|---|---|
| Starts the built app on a detected port | yes | YES (`app_runner_start`, `_detect_port`) | `autonomy/app-runner.sh:498,150` |
| Health check + crash watchdog + auto-restart | yes | YES (`app_runner_watchdog`, `app_runner_should_restart`, `app_runner_health_check`) | `autonomy/app-runner.sh:769,735,678` |
| Browser smoke test of the running app | yes (their core loop) | YES, batch (`playwright-verify.sh`) | `autonomy/playwright-verify.sh` |
| Crash/playwright signal fed back into next iteration to self-correct | yes, tight realtime | YES, batch (`app_runner_info`/`playwright_info` injected into `build_prompt`) | `autonomy/run.sh:10544,10561,10761` |
| Verified completion gate (no fabricated "done") | partial | YES (`council_evidence_gate`) | `completion-council.sh` |
| Failure-memory: past failures injected to avoid repeats | partial | YES (`retrieve_anti_patterns`) | `memory/retrieval.py` |
| **Clickable live preview URL / embedded app the user can try** | YES, central | **NO -- app runs but URL is not surfaced in dashboard** | gap: `dashboard/server.py` has no preview route |
| **Real-time visible inner loop (watch it build/fix as it happens)** | YES | Partial -- dashboard shows iterations/logs, but app preview not embedded; loop is a longer autonomous batch | gap |
| **Proactive "suggest add/improve/remove" surfaced to user** | YES | Partial -- analysis pass exists internally; not surfaced as user-facing suggestions | gap |
| Works on existing/brownfield repos | weak (greenfield-biased) | STRONG | `loki heal`, codebase analysis |
| No hosted-runtime lock-in; your machine, your code | NO (vendor cloud) | YES | local-first CLI |
| Multi-provider (Claude/Codex/Cline/Aider) | NO | YES | `providers/*.sh` |

## 4. Where Loki is BETTER (keep + lead with these)

1. **Local-first, no vendor lock-in.** Your code never leaves your machine; no hosted runtime you can be evicted from or surprised-billed on (Lovable's dual-layer billing is a known pain). Enterprises care about this.
2. **Brownfield/existing repos.** Replit/Lovable/Bolt are greenfield-biased (prompt -> new app). Loki runs on real existing codebases, including `loki heal` for legacy systems.
3. **Verified completion + failure-memory.** Evidence gate blocks fabricated "done"; anti-pattern memory prevents repeating mistakes across runs. The hosted tools mostly re-discover bugs each session.
4. **Multi-provider + your own keys/budget.** Not locked to one model vendor or a credit economy.
5. **Depth of autonomous SDLC** (RARV, council review, quality gates) vs a single conversational agent.

## 5. Where Loki is WORSE (the real friction)

1. **No instant "try it" moment.** The app DOES start (app-runner), but the dashboard never hands the user a clickable URL or embedded preview. This is the single biggest felt gap and it is a *surfacing* fix, not a build.
2. **Setup friction.** Competitors are zero-install (open a browser). Loki needs the `claude` CLI, a terminal, `loki start`. Non-technical consumers stall here.
3. **The inner loop is a long batch, not a watched conversation.** Users can't see "it's testing the login button now and fixing it." Same capability, far less visible.
4. **Suggestions aren't surfaced.** Loki's analysis pass reasons about what to add/fix internally, but doesn't present a user-facing "here's what I'd improve next" list.
5. **First-run time-to-wow.** No 30-second "look, it works" the way a hosted preview gives.

## 6. Honest category line (for positioning, not inferiority)

Hosted text-to-app SaaS (Replit/Lovable/Bolt): instant live preview, tight visible loop, friendly to non-technical users -- but your code on their cloud, vendor + credit lock-in, greenfield-biased.

Loki Mode: local-first CLI driving Claude on your own machine -- brownfield-capable, no hosted-runtime lock-in, multi-provider, verified completion + memory -- but no instant hosted preview and higher setup friction.

The wins below close the *experience* gap without giving up the local-first advantages.

## 7. Prioritized TODO (by blast radius / friction reduction)

### P0 -- Live Preview surfacing (the headline win; cheapest path to "try it")
The app already starts with crash watchdog. Surface it.
- **Dashboard:** add a "Live App" panel that reads `.loki/app-runner/state.json` (status, port, url, crash_count), shows a clickable `http://localhost:<port>` link + an embedded iframe + health/crash badge + "Restart app" button (wire to existing `app_runner_restart`).
- **CLI:** `loki preview` (alias `loki open`) -- prints the running app URL and opens the browser; honest message if no app is running yet.
- **API:** `GET /api/app-runner` (state passthrough), `POST /api/app-runner/restart`.
- Pure surfacing of existing state; no new runtime behavior. Lowest risk, highest felt impact.

### P1 -- Tighter, visible self-healing loop
- Stream app-runner crash events + playwright pass/fail to the dashboard timeline in near-real-time (event bus already exists, `events/bus.py`).
- Dashboard "what just happened" feed: "app crashed -> reading log -> fixing -> restarted -> smoke test passed."
- Honest framing: this exposes the EXISTING batch loop more visibly; it does not claim Replit's per-click realtime browser sim.

### P2 -- Proactive suggestions surfaced to the user
- Add a structured "Suggestions" output from the analysis pass (add/improve/remove/risk), persisted to `.loki/suggestions.json`.
- Dashboard "Suggestions" panel + `loki suggest` CLI to print them.
- These are advisory; the user opts in to queue any as tasks.

### P3 -- First-run time-to-wow / setup friction
- `loki try <one-line-idea>`: scaffold a tiny app, build it, auto-start app-runner, open preview -- a guided 60-second "it works" path (honest: real build, not simulated).
- Doctor-style preflight that detects missing `claude` CLI and guides install.

### P4 -- Non-technical on-ramp (longer term, optional)
- Evaluate an optional hosted/containerized preview for users who can't run locally (collides with zero-egress posture; opt-in only, deferred).

## 8. What this session will actually implement

Per user direction ("update dashboard and backend cli or api accordingly", "plan it perfectly", "complete autonomously"): implement **P0 (Live Preview surfacing)** end-to-end (dashboard + CLI + API), both runtime routes where applicable, council-reviewed, local-ci 42/42, channels validated. P1-P4 are scoped follow-ups.

## 9. SWE-bench note (unrelated but pending, must be stated)
Primary-source data in `benchmarks/results/` shows ONLY patch generation (299/300 generated, `fixed_by_rarv:0`, status PATCHES_GENERATED, the official evaluator was never run, no resolve/pass-rate figure exists; some patches are prose not diffs). There is no "release 660." Publishing a SWE-bench resolve score would be fabrication. The only real measured number is HumanEval **98.78%** (162/164). Recommendation: lead with HumanEval; keep SWE-bench as "harness exists, resolve-rate not yet measured" + the repro command; offer to run the official evaluator as an opt-in upgrade.

## Sources (competitor research, June 2026)
- Replit Agent 3: https://blog.replit.com/introducing-agent-3-our-most-autonomous-agent-yet , https://blog.replit.com/automated-self-testing , https://docs.replit.com/core-concepts/agent
- Lovable: https://lovable.dev/ , https://lovable.dev/pricing , https://www.nocode.mba/articles/lovable-ai-app-builder
- Bolt.new: https://github.com/stackblitz/bolt.new , https://capacity.so/blog/what-is-bolt-new , https://www.banani.co/blog/bolt-new-ai-review-and-alternatives
