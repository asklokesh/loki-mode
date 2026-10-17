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
