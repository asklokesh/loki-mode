# RELEASE-11: one major train (11.0.0) - single source of truth

Founder directive 2026-10-04T01:35Z (relayed by steering): one big MAJOR release in 1-2h (window ends about 03:35Z) using at most 10% of the weekly limit. Hard stop: a real 94% weekly reading. Seats: D87 cap of 4 sonnet builders, sonnet reviewers, opus only as a one-question advisor on trust rows, haiku for docs.

Rules:
- Every brief quotes its row verbatim. No row ID means no build.
- DONE needs a commit plus the check output pasted in Evidence.
- No dummy UI, no placeholder routes, no "coming soon". If a row cannot be real in the window, mark it DEFERRED with a reason.
- CHANGELOG and docs are written only from DONE rows.
- The release cuts when every A row is DONE and every B row is DONE or DEFERRED. Moat P9 must be green on the release commit, and this cannot be waived.

Status tokens: TODO, BUILDING, REVIEW, DONE, DEFERRED.

## TIER A (must ship)
| ID | Item | Owner seat | Acceptance check | Status | Evidence |
|---|---|---|---|---|---|
| A1a | FC-25 safeGit (approved) | CoS (release) | 10.11.1 on npm latest; moat P9 CASE P9.injection-cannot-reach-token PASS on the release commit | REVIEW | ed47d6f6f publish skipped (gate: fc16b real-go 8.7s vs 5s timeout, run 37168233387, full rerun same); fix 5463a5c93 + CI wiring 1e99d77f2 (control-plane 25/0, dep-inventory 6/0); republished as release 962efc4b2 v10.11.2 pushed 01:46Z, awaiting npm latest |
| A1b | FC-25b filter/textconv/gpg blanking (30dc7f77a) | CoS merge | review-fc16b APPROVE at dc7a0aece (bun 3692/0, tsc 0, P9 4/4, M1-M3 mutations red); LFS functional check: `git lfs` repo status/checkout through safeGit still works | REVIEW | 180bc085b + 0b2e7e549 (worktree-agent-a40d7baa7bac33ecf): builder bun 3695/0, tsc OK, P9 4/4, LFS regression test green, mutations (ATTR_SOURCE restored, global keys blanked) red; review-fc16b re-reviewing on main |
| A2a | FC-22 S5 cap sizing | builder fix-s5-cap | FC21B-FC22-PLAN.md S5 Wall checks in tests/engine10/fc21_cap.test.ts green; full bun test + tsc 0 | REVIEW | d1be73c18 (slice-fc21b-s5): builder fc21_cap 14/0, cap suites 25/0, tsc 0, full bun 3601/3 fail (flake claim unverified); mutations ceiling red; S4 wiring notes handed to A2b; rev-s5 (sonnet) reviewing on main |
| A2b | FC-21b + FC-22 S4 earned VERIFIED after limit, A1, A2, L7 outcome | sonnet builder 1 after S5 merges | FC21B-FC22-PLAN.md S4 Wall checks in fc21b_verdict.test.ts + fc21_limit.test.ts; keep test.scoped_out; full bun test + tsc 0; opus advisor answers one question on the VERIFIED rule | BUILDING | b-a2b seated 01:40Z on main + S5 d1be73c18 |
| A3a | R1 stale CP restart (FC-26) | sonnet builder 2 | test: CP running with version X, installed Y -> `loki control serve` restarts it (recorded PID only); UI shows "Control Plane is out of date, restarting" when /health version differs | REVIEW | 53d7fbf69 (worktree-agent-a75b4739376811b2b): builder CP 476/0, loki-ts 3607/0, tsc clean; a3-stale-cp.test.ts + live.test.tsx; rev-a3 (sonnet) reviewing |
| A3b | R2 fixture ingest refusal + wider cleanup | sonnet builder 2 | test: ingest from a source under tmpdir or a test run-id prefix (e37-, e10-sig, e10-sg) is refused; startup cleanup removes origin_repo-null test rows and keeps real rows; every runner sets hermetic HOME + LOKI_CONTROL=0 (guard test) | REVIEW | 53d7fbf69: ingest refusal + cleanup v2 marker + runner-hermetic.test.ts (red on root bunfig.toml before fix); rev-a3 reviewing |
| A3c | R3 truthful run summary | sonnet builder 2 | test: a run FAILED in under 1s with no verify event shows its real stop reason, never "did not pass verification"; root cause of the 0.13s deaths (cc22, e606) named in FAILURE-CLASSES | REVIEW | root cause (b-a3): founder text went to POST /v1/start --brief with repo=HOME, planStart spawn.ts:47 accepted it, loki start died in 0.13s; A4b summaryLine gives 'The run failed before verification ran.' (4e57b813e); FAILURE-CLASSES row pending |
| A4-ASK-1 | Ask Loki read-only tools in TypeScript (steering 01:28Z: no new Python), a stdio MCP server at packages/control-plane/src/ask/tools_server.ts; gh reads only if they fit, else a follow-up | b-ask-mcp | ask_tools.test.ts: runs_compare returns both ids, verdicts and costs; an artifact outside the allowlist is refused; tools/list equals the read set exactly; no write tool | DONE | merge 12aa9a51d + lock e8d9ab71f; rev-ask1 APPROVE: ask_tools 5/0, server+db 274/0 (re-run on main after lock: 274/0 rc=0), tsc 36 errors identical to main, mutations (drop allowlist, add write tool) red; gh tools and run_get diffstat via safeGit are follow-ups |
| A4-ASK-2 | Ask Loki CP job (slices 4, 5, 6, 7, 9, 10): threads persisted in control.db, async worker on the user's provider (default claude), read-only tools, SSE stream, follow-ups replay prior turns | sonnet builder ask-cp | the slice 4-7, 9 and 10 Wall checks; free text never reaches /v1/start (guard test: the ask module never imports planStart or spawnStart); a real thread answering "whats going on so far" from the founder's 9 runs, with run-id citations (screenshot) | REVIEW | 7e5d36257 (rebased on 5463a5c93): both rev-ask2 blockers fixed (resolveToolsServer + bundled dist/ask-tools-server.js in files; opencode refused); builder CP 506/0, tsc 36=36; rev-ask2b (sonnet) re-reviewing |
| A4a | CP-REDESIGN-2 information architecture (steering spec items 1-8) | sonnet builder 3 (UI) | ui tests green; the sidebar is navigation only; Overview has 4 KPI tiles and a NEEDS YOU inbox; the Runs table is grouped by issue; no "unmeasured" on list views; the composer is removed and the New run issue picker is real (gh issues, registered repos only, explicit confirm; free text never starts a run); an Ask Loki chat page (CP-ASK slices 11-13) with a thread view, streamed answers, follow-ups and Ask history in the sidebar; Loki may OFFER a "Start a run on X#N?" button that opens the confirm dialog, never an auto-start; screenshots of the founder's 9 real runs, reviewed by steering | BUILDING | |
| A3d | /v1/start refuses non-registered or non-git repos, HOME and / (L2); A3e dead-PID reconciler (L6, run 59b1 "Running 10h"); A3f cleanup removes the junk runs cc22 and e606 by rule | b-a3 | tests for each of these | REVIEW | 53d7fbf69: repoRefusal spawn.ts:26 (HOME, /, non-git), reconcile.ts (STOPPED after 120s, no kill), rule cleanup; issues route with stubbed gh; rev-a3 reviewing |
| A4b | Run detail truthfulness (steering 01:24Z items 1-5) | sonnet builder 5 (UI data layer) | (1) Why comes from the terminal stop reason: one sentence, fully ANSI-stripped, raw output behind "Show raw". (2) One shared display mapping (Verified, Partly verified, Failed, Needs your answer, Already done, Stopped (budget), Unverified (signature not checked), Tampered), and no enum string rendered anywhere. (3) receipt.json is the source of truth, with an adapter for old receipt versions; "unmeasured" only when the receipt lacks the field. (4) No owner tag unless one is recorded. (5) A block caused by Loki's own rules (FC-19 classifier) shows the "Loki's own rules stopped this run ... Retry on the latest version" text with Retry as the primary action. Compat fixture: one run each from 10.6.x, 10.7.1, 10.9.1 and 10.10.5 renders with zero garbage and zero false "unmeasured". Screenshots include run e10-20261003T200907Z-fea1 | REVIEW | fb8b0a967, c7c821eec, 7cfbc76f8, 4e57b813e (worktree-agent-a2317650f8cd8d91a): CP 481/0, ui 193/0, ui build ok; compat 10.6.14/10.7.1/10.9.1/10.10.5 + fea1 screenshots ANSI-free; open: stage-row 'unmeasured' in model.ts; rev-a4b (sonnet) reviewing |
| A5 | First-run onboarding checklist (real doctor checks) | sonnet builder 3 after A4 | the CP shows each `loki doctor` check with its real pass/fail; a test proves a failing check renders failing | TODO | |
| A6a | `loki status` CP URL fix | sonnet builder 4 | test: `loki status` prints the URL the running CP actually listens on | BUILDING | |
| A6b | LEGACY-ZERO W1-01: remove `loki legacy` and LOKI_ENGINE, plus the start-line text | sonnet builder 4 | `loki legacy` exits with a removal message; grep for LOKI_ENGINE in loki-ts/src and autonomy/ has 0 live reads; full bun test + tsc 0 + local-ci fast tier | BUILDING | |
| A7 | FireLater#17 gate rerun on the RC | steering | steering posts the receipt verdict for the RC | TODO | |

## TIER B (thin, real v1s; each is a sonnet slice of 30 minutes or less, or DEFERRED)
Seats free up only after the Tier A rows. A B row is attempted only if a seat is free AND the real weekly reading is under 90%. Otherwise it is DEFERRED with the reason "budget/window".
| ID | Item | Acceptance check | Status | Evidence |
|---|---|---|---|---|
| B1 | `--attempts N` verifier-selected best-of-N (D61 units) | test: the winner is the attempt with the most Loki-executed passing checks; it never uses a model self-report | TODO | |
| B2 | "Loki Receipt" GitHub check (existing Action runs `loki verify --pubkey`) | workflow test on a fixture receipt posts success; a tampered receipt posts failure; autopilot merge stays opt-in | TODO | |
| B3 | `gh attestation` of the receipt (DSSE) + 1-page Agent Change Receipt spec | `gh attestation verify` passes on a fixture; the spec doc exists | TODO | |
| B4 | Cross-lab review `review: codex or claude` before seal | test: the second provider can flag or block, never upgrade a verdict | TODO | |
| B5 | Committed shared .loki/project.json | test: a committed model is loaded and the cache key honors it | TODO | |
| B6 | Jira and Linear write-back (opt-in) | test with a stubbed API: the comment carries outcome, PR and receipt digest | TODO | |
| B7 | `pr.author: me or bot` | test: argv uses the gh user or the app token per config | TODO | |
| B8 | Per-repo cost analytics in the CP | test: aggregation over real run rows by origin_repo | TODO | |
| B9 | Scoreboard v1: Loki vs raw `claude -p` on 3 repos | real runs with numbers in METRICS.md; cost counted inside the 10% budget | TODO | |

## TIER C (DEFERRED; a 1-page doc each in docs/v11/, no code; haiku)
C1 multi-user logins, roles and SSO. C2 hosted or remote runner. C3 reproducible environments. C4 Bitbucket and Azure DevOps. C5 open or local models. C6 secrets handling. C7 Windows. C8 public benchmark. C9 opt-in telemetry. C10 the 8090 teardown. C11 MCP-MODERN (next minor). Status: DEFERRED. Evidence: the doc path, once written.

## Budget log (real readings only)
| Time (Z) | Weekly % | Seats live | Note |
|---|---|---|---|
| 01:43 | 86 (steering reading) | 7 sonnet | 94 about 2.5h out at pace |
| 01:35 | 84 (steering reading) | fix-s5-cap | directive received |
| 01:24 | 85 (steering /usage) | 8 sonnet | stop seating at 92 |
