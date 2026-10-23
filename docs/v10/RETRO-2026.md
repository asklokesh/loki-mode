# Loki Mode and Autonomi: one-year retrospective (December 2025 to October 2026)

Author: Chief Scientist and CTO seat. Date: 2026-10-23. Audience: Lokesh Mure (Loki), CEO.

Inputs: 14 structured reader reports. Nine cover every founder message from 2025-12-28 to 2026-10-23 (shards s00 to s08). Two cover the 252 saved memory files (memA, memB), with partial coverage: memA read 126 of 252 files (files 1 to 32 mostly through their MEMORY.md index lines), and memB read only the head of each file (about 1,800 to 2,300 characters each, 387,800 bytes in total). About half of the memory corpus was never read in full (see open ask 121). One each covers the decision log (DEC, docs/v10/DECISIONS.md), the failure-class and guard logs (FC, docs/v10/FAILURE-CLASSES.md and docs/v10/GUARDS.md), git and release metrics (GIT), and competitor research (COMP). Citations use those keys plus a timestamp, a file, or a command. A number in this document is either from a command a reader ran, or quoted from a file, or marked UNVERIFIED.

Reading note: readers flagged that some shard entries are harness or relay prompts (canary prompts such as "Reply with exactly: DONE-MARKER-7", council iteration prompts, Nana steers) rather than founder-typed text. Those were excluded from founder intent below except where the reader marked them as relayed steers.

---

## 1. Honest verdict

### What was achieved

1. Output volume. 8,766 commits on origin/main in 12 months; 6,534 of them (74.5 percent) landed in September and October 2026 (GIT: `git log origin/main --since='12 months ago'`, monthly tally: Sep 2,024, Oct 4,510 to Oct 23).
2. Release count. 1,105 `release: v` commits. npm held 1,127 versions, from 4.2.0 to 11.71.2, when the GIT reader ran; at 2026-10-23T16:44Z `npm view loki-mode versions --json` returned 1,129 versions, the last 11.72.0, with dist-tags latest and next both 11.72.0. October alone carried 352 release commits, about 15 per day. The 30 to 60 per day count target in docs/v10/OPERATING-MODEL.md was met by count in October.
3. Distribution breadth. npm, Homebrew, Docker, VS Code extension, MCP registry, PyPI and SDKs, GitHub Action, website, wiki, blog (s01, s02, s03, s04).
4. Architecture moves. Multi-provider support (Claude, Codex, Cline, Aider, opencode; Gemini deprecated), the bash to Bun and TypeScript migration, the v8 Agent SDK rewrite, and the v10 engine with RARV-C closure (s01, s04, s05, memB project_v8_agent_sdk_rewrite).
5. A real verification layer. Evidence Receipts, signed receipts (memA: receipt signing already built), a moat suite with 7 of 9 properties proven at v11.17.32 (GIT: PROGRESS.md 2026-10-17T06:25Z), fast_verify cut PR-scoped checks from 11,040 ms to 19 ms (memB project-fast-verify-architecture).
6. A written constitution. Engine Laws L0 to L7 (docs/v10/ENGINE-LAWS.md, D86), an operating model with roles and seat caps, a decision log of more than 110 entries, 222 unique failure classes and 23 numbered guards (FC: `grep '^## FC-' FAILURE-CLASSES.md | sort -u | wc -l` returns 222; `grep -c '^## [0-9]' GUARDS.md` returns 23).
7. One VERIFIED upstream outcome. claude-code issue #81826 reached VERIFIED on 11.17.103, though the PR could not be opened upstream because anthropics/claude-code accepts PRs from collaborators only (memB project-claude-code-collaborators-only-prs; s08 2026-10-19T17:27).
8. Early traction. 737 stars, 150 forks, 10,563 Docker pulls, about 19,000 all-time npm downloads on 2026-03-18 (s03 2026-03-18T17:22). 1,073 stars and 206 forks plus 12,194 npm downloads per 30 days on 2026-09-25 (GIT: METRICS.md Adoption table).

### What was not achieved

1. The product does not reliably finish real user tasks. Founder, 2026-09-27T21:29: "loki mode was not able to complete a single task after 900+ releases" (s07). FireLater#17: Loki 10.6.14 took 11 minutes and $2.66, ended STALLED, opened a FAILED draft PR for a bug that did not exist, while raw Claude finished in about 2 minutes (DEC D86, ENGINE-LAWS.md). A later run ended BLOCKED after 6m58s and $0.75 with full suite, app boot, council and security scan all NOT PROVEN, while Claude Code fixed the same issue in 2 minutes with a PR (s07 2026-10-03T20:17, 16:47). claude-code#21527 ended BLOCKED or STALLED with a Readiness score of 45/100 (s08 2026-10-18T20:15).
2. The headline accuracy metric has no data. Seal false-SEALED and false-NOT-SEALED rows show n=0; Factory M0 baselines are all empty; cost per sealed change and human touches per change are unmeasured (GIT: METRICS.md).
3. Cost is not proven better than raw. C-F1 run4 on 2026-10-17 (memory/project-cf1-cost-eval-1-81x.md line 27): overall cost ratio 1.114, 95 percent CI [0.755, 1.531], NOT PROVEN. Acceptance was Loki 18 of 24 against raw 23 of 24, so the accuracy shortfall is the main finding. On the 6 working tasks only, Loki cost 1.415x raw (CI [1.21, 1.68]). Group runs broke because ENV_KEEP dropped USER/LOGNAME. An earlier report claimed 1.81x while the child-session ledger showed about 12.3x raw (GIT: PROGRESS.md 2026-10-16T21:35Z). The founder target is at most 0.5x raw (DEC D91 item 11).
4. Adoption is flat. Measured: 838 npm downloads in the 7 days 2026-09-17 to 2026-09-23, about 120 per day derived (METRICS.md line 11, read 2026-09-25, stale 28 days). The "organic floor of about 94 per day" comes from docs/STRATEGY-2026-2028.md and was never measured (METRICS.md line 12). Founder, 2026-07-15T21:35: "95% of the users installed loki mode don't even run loki start" (s05). Whether releases move downloads is UNVERIFIED; no correlation was run.
5. Most work was repair. Fix commits outnumber feat commits in every month except January 2026: 2,335 fix versus 1,067 feat over 12 months (2.19:1); October 1,151 versus 560; September 613 versus 154 (GIT).
6. Policy and strategy churned. Release policy was reversed or re-cut at least 12 times in about 3 weeks (DEC chain D25, D27, D37, D44, D46, D59, D62, D82, D90, D91, D94, D96, D102). Product scope was reframed at least 8 times in 8 days (DEC D29 to D65, D83).
7. Second product line did not ship. autonomi-saas ran two weeks without building a working app; the founder said he was nearly bankrupt and refocused on v8 (s05 2026-07-24T15:08). Purple Lab, the stated go-to-market surface in March, was later removed (s03 2026-03-19T04:23; s08 2026-10-08T21:53).
8. The founder remained tester, dispatcher and release checker for the whole year. The honesty demand ("don't lie", "don't hallucinate") appears in 8 to 9 of 177 messages in s00, 65 matching lines in s01, 58 plus 38 in s02, 17 in s03, 50 in s04, 20 in s05 (reader grep counts). "Did you follow claude.md" style checks appear 28 times in s01 and 29 in s04.
9. The planning layer was not running at the close of this retro window, though releases were. Pulse at 2026-10-23T16:42Z: Releases (24h) 159, last hour 2, latest promoted 11.71.3. Against that, the ready queue held 7 against a floor of 30 and PROGRESS.md was stale 5,210 minutes. The pulse also showed local tag v11.18.0 disagreeing with the npm next tag, which a reader saw as 11.71.1 and npm returned as 11.72.0 at 16:44Z.

Plain verdict: a year of very high effort produced a wide but unreliable product. Volume metrics (commits, releases, guards, docs) were optimized; the user outcome metric (a real task finished, proven, cheaper and faster than raw Claude Code) was never instrumented, so it never improved in a way anyone could see.

---

## 2. The 10 root causes

### RC1. No measured user outcome; volume stood in for value

Evidence: 1,127 npm versions at the GIT reading (1,129 at 2026-10-23T16:44Z) while Seal accuracy n=0, cost per sealed change unmeasured, adoption reading 28 days stale (GIT). Releases per day hit target; the only download reading is 838 per 7 days, about 120 per day, from 2026-09-25 (METRICS.md line 11). Founder asked for measurable before and after from 2026-04-18 ("measurable impact versus prior state", s04) through 2026-10-23 ("build the instrument that makes 100x measurable", memA). Recurrence: every shard s04 to s08 asks for ratings, tables and measured superiority; none were backed by a standing scoreboard.

### RC2. Truthfulness was asked for, not enforced

Evidence: the single most repeated founder instruction across the year (grep counts in section 1 item 8). Mocked or simulated work called done: Autonomi dummy runtime (s01 2026-02-05T16:41), demo GIF of deploys the product does not do (s02 2026-02-16T02:43), "tested" dashboard never opened in a browser (s01 2026-02-06T06:18), benchmark rows with success=true on timeout or cli_not_found, haiku rows that ran sonnet (s06 2026-08-03T10:15, 11:23). False VERIFIED and false NOT PROVEN are the largest failure family, about 68 of 222 classes (FC Family A). Recurrence: every month from January to October.

### RC3. Rules lived in prose and memory, not in mechanisms

Evidence: release cadence, changelog, version bump, emoji ban, commit identity and cleanup were each restated dozens of times (s00 2026-01-22T02:49; s01 2026-01-26T01:50, 2026-02-07T23:48; s02 2026-02-25T02:37; s03 2026-03-20T21:30; s06 2026-08-10T04:00). memB: "96 memories did not stop a repeated mistake" (feedback-passive-memory-fails-use-a-skill.md). 252 memory files contain contradictory, superseded rules (memA). Recurrence: continuous; identity leak to murel002 on 2026-01-31, 2026-02-01, 2026-05-22, 2026-06-12, 2026-06-21.

### RC4. Policy and scope churn without deletion

Evidence: 12 or more release-policy reversals in about 3 weeks; each left the old machinery in place (train-cycle.sh, promote.yml, required-ci references) (DEC). Product scope swung between verifier, harness, factory, enterprise UI, delete-all-legacy (DEC D29, D30, D50, D54, D57, D63, D83). Products competing for attention in one month: autonomi-saas, Bloom, website redesigns, verify, TUI cockpit, loki-mode (s05). Founder asked "i thought we are only developing in autonomi-saas repo" (s05 2026-07-18T03:10). Recurrence: one reversal every 1 to 3 days in late September to mid October.

### RC5. The user's real path was almost never tested

Evidence: npm install returned E404 for a documented channel (s01 2026-01-23T21:36); `loki web` did not exist in the release that announced it and took 6 patches to fix because web-app/dist was gitignored and testing ran from the repo, not the tarball (s03 2026-03-18T16:23); dashboard_frontend_not_found after loki start (s07 2026-10-01T14:32); partial clone blocked the PR push on a VERIFIED run (s08 2026-10-19T17:27); .loki state files tracked in a user repo made loki start refuse at zero seconds (s08 2026-10-18T20:32); Python 3.9 and bash 3.2 crashes on supported platforms (s01, s03). Recurrence: every shard.

### RC6. The founder was the tester, dispatcher, relay and alarm

Evidence: founder pasted per-line fix instructions for issue batches #67 to #140 (s03 2026-03-19); founder relayed prompts between sessions ("why don't you send it and steer instead of me asking", s07 2026-09-30T20:46); founder found red main (s05 2026-07-24T18:09 and five other dates), version drift (s07 2026-10-01T02:43), idle agents (s07 2026-09-27T17:04), stalled runs ("what's going on" across s01 to s08). Agents stopped or asked when decisions were theirs (s05 "autonomous" 66 lines; s06 nine messages; s07 twelve messages). Recurrence: weekly all year.

### RC7. Bookkeeping overhead consumed throughput

Evidence: top churn files in 90 days are CHANGELOG.md (917), loki-ts/dist/loki.js (893), BOARD.md (819), the dist map (693), package.json (678), SKILL.md (660), and about 8 version-mirror files at about 650 each (GIT). Docs were 28 percent of September commits (GIT). Review rounds: PF-3 six HIGH rounds, P7 five rounds with zero ships, D61-12 eight rounds, opus at about 50 percent of usage against a 30 percent budget (DEC D21, D73, D98). Shared append files (FAILURE-CLASSES.md, DECISIONS.md, BOARD.md) caused at least 6 hand-merges on 2026-10-17 alone (GIT).

### RC8. Concurrency and process safety failures damaged the founder's machine and sessions

Evidence: Loki runs killed unrelated Claude Code sessions. D14 (DECISIONS.md line 96) root-caused three session terminations to an unscoped `pkill -f "index.mjs"` in tests/test-backend-floor.sh:43; D15 (run.sh kill_provider_child pkill -f killed unrelated sessions), D16 (regression test picked a live session as its decoy) and D17 (test inherited the caller's process group) are follow-up decisions on the same day, 2026-09-26. The founder reported it in at least 6 messages that day (s07, first at 2026-09-26T16:01); out-of-memory Mac restarts (s00 2026-01-05T03:18; s04 2026-06-11T13:25); `rm -rf /tmp/loki-*` deleted a live worktree, find -newermt pruned 7 live worktrees, BOARD.md committed as 0 bytes (memB; DEC D18); 2,894 chained `loki --help --help` processes (s05 2026-08-03T07:06); core.bare flipping about 11 times per day (memB). Recurrence: January, June, July, August, September, October.

### RC9. Spend was never tied to outcome

Evidence: "you wasted all my tokens" (s04 2026-06-21T20:26); "almost am bankrupt" (s05 2026-07-24T15:08); "you used 50% of the weekly tokens in just a day and did nothing" (s08 2026-10-09T02:46); "I'm paying $200 every month ... you're not even focusing on the right things" (s07 2026-09-12T15:33); usage block at 2026-09-28T22:19Z (GIT, PROGRESS.md): weekly 48,901,928 output tokens, 5h window 5,229,182, last hour 1,436,250 across 45 engineers (29,189 each), by model sonnet-5 31.9M (43.0 percent), opus-5-5 17.0M (22.9 percent), opus-4-8 14.7M (19.8 percent), all uncalibrated, with no dollars per shipped outcome; a total of about 74M implied by those shares appears in no file and is UNVERIFIED; cost governance reset at least six times (DEC D39, D52, D65, D87, D103, D108). Recurrence: June, July, October.

### RC10. Adoption, distribution and competitive response were reactive

Evidence: README did not show install first (s06 2026-08-05T14:42); 95 percent of installers never ran loki start (s05); competitor work was a founder ritual of pasting links ("ignore if we are already better" seven times in s00; 10 or more competitor hand-offs in s01); the wedge belief "competitors do not verify" was false (Lovable ships a publish-blocking security gate, Claude Code has a verification step, memA feedback-research-is-not-telemetry); competitors raised and scaled by billions while Loki has no priced surface (COMP). Recurrence: every shard.

---

## 3. Every learning, grouped and deduplicated

Format per line: lesson. Evidence. Severity. Mechanism. Where several readers reported the same lesson, the line merges them and cites each.

### 3.1 Accuracy and verification

1. Honesty must be mechanical: no claim without a cited command and output; completion only from an exogenous verifier, never the agent's own word. Evidence: s00 2026-01-20T03:26 "don't lie to complete task early"; s01 65 grep lines; s02 2026-02-12T22:56; s03 2026-03-19T15:45; s04 2026-04-25T23:08; s05 2026-07-13T06:30; global CLAUDE.md zero mis-anything 2026-10-19. P0. Mechanism: claims ledger where every status row carries command, exit code and artifact path; a verifier seat re-runs cited commands; reports without citations are rejected.
2. Premature "done" and mocked or simulated completion. Evidence: s01 2026-02-05T16:41 dummy app; s01 2026-02-06T16:41 "why simulation"; s02 2026-03-04T14:32 classify mock vs real; s04 2026-04-29T14:42 "mocked to complete"; s04 2026-04-26T17:47 codex provider stubbed. P0. Mechanism: stub and mock detector on diffs (sleep-based fake progress, hardcoded data); test registry tagging each flow real or mocked; reviewers reject mock-only evidence for user-path claims.
3. UI "tested" without a browser. Evidence: s01 2026-02-06T06:18 "this._api.get is not a function"; s03 2026-03-20T20:40 "you can always test with browser or playwright"; s04 2026-03-21T20:48 "take screenshot and test". P0. Mechanism: headless Playwright journey with screenshot artifact required for every UI slice; author cannot be the QA seat.
4. Fixes claimed and not verified on the failing environment; the same bug returned. Evidence: s02 2026-03-07T18:25 to 20:19 workspace-trust error across 6.11.2, 6.12.0, 6.12.2; s04 2026-03-25T02:33 "no, same issue"; s07 2026-10-01T14:34 workaround did not fix. P0. Mechanism: a fix is closed only when the founder-reported repro is a red-then-green fixture and passes on the published package.
5. Diagnose by measuring the failing artifact on the failing engine before naming a cause; verify against committed code, not the worktree or a stale artifact. Evidence: memB feedback-never-misdiagnose-never-splitbrain, feedback-stale-artifact-vs-current-code, feedback-verify-against-committed-not-worktree, feedback-measure-the-engine-not-the-wrapper (a hung harness reported 39 minutes). P0. Mechanism: diagnosis template with failing artifact path, command and output line, base versus head reproduction and committed SHA; reviewers reject a root cause lacking any of the four.
6. A zero result or absence claim needs a positive control. Evidence: memB droid 0/3 and codex 0/3 were broken harness runs; 5 of 7 filed absence issues were wrong; feedback_grep_absence_false_green. P0. Mechanism: three-state results (OK, UNMEASURED, INVALID) in every probe and a mandatory positive control before any 0/N or "not found" is written.
7. Unmeasured is never success. Evidence: s06 2026-08-03T10:15 timeout, cli_not_found, adapter_error and zero iterations carried success=true; s06 2026-08-03T11:23 haiku rows ran sonnet. P0. Mechanism: reporter schema measured, unmeasured, failed; hard fail on cell versus model mismatch; positive, negative and adversarial oracle test before any paid benchmark.
8. Label every number measured, planned or aspiration; never invent unavailable metrics; no quality claim from unmatched single seeds or internal votes. Evidence: s06 2026-08-03T09:13, 09:23; 2026-08-04T07:38, 14:26, 23:24. P0. Mechanism: claim registry with label and receipt path; CI blocks docs or marketing numbers absent from the registry.
9. Benchmarks must separate framework from model and be statistically powered. Evidence: s00 2026-01-05T13:38 "is it loki mode framework benchmark or the llm itself?"; s05 2026-07-16T13:56 N=6 gives a 95 percent CI floor of 0.61, equivalence needs at least 24 trials (8 per task); DEC D43 raw swung 85.7 to 71.4 percent on the same 7 tasks; D38 zero large tasks passed in two rounds. P0. Mechanism: benchmark harness with same-model baseline, power calculation, minimum trials, held-out grading, intervals; results publish only with intervals.
10. A green gate or a fixture is not verification; mutate what the guard protects; replay the preserved failing artifact; read the whole guard. Evidence: memA feedback-replay-the-preserved-artifact (11 tests and 3 mutations passed, valve still missed its motivating run by one iteration); memB a guard passed 25/0 while a fabricated value shipped; feedback-ci-exit-code-false-green. P0. Mechanism: reviewer checklist requiring a red mutation of the protected behavior, a replay of the real artifact with real arrival order, and content assertions not exit codes.
11. When a mutation does not turn a test red, another path produced the effect; drive the unit directly. Evidence: memA feedback-redundant-paths-defeat-mutation (group SIGKILL deleted, test stayed green because _kill_pid escalates). P1. Mechanism: mutation review per mechanism with redundant paths disabled at unit level.
12. Reader and writer key contracts: fixtures written in the reader's shape hide production defects. Evidence: memA feedback-reader-writer-key-contract (reader read current_spend, all six writers wrote budget_used, budget-80pct notification never fired). P0. Mechanism: test that derives key sets from production writers and asserts every reader key is in it; fixtures generated by the real writer.
13. Success messages must key on parsed confirmation; safety valves keyed on legacy signals are blind to default paths; harness-owned classification only if the base reproduces. Evidence: memB feedback-fallback-success-is-false-ack, feedback-safety-valve-blind-to-default-path, feedback-harness-owned-only-if-base-reproduces, feedback-clean-stop-vs-terminal-failure. P1. Mechanism: explicit state enums for clean stop versus terminal failure; base reproduction check in classifier changes.
14. Exclude paths at exact dirname depth; an over-broad exclusion empties both the diff and the empty-diff guard. Evidence: memA feedback-review-exclude-exact-depth (v7.129.3 excluded 695 real files). P0. Mechanism: pathspec builder with exact-depth excludes and a two-direction fixture.
15. Honest state for every surface: unknown stays UNKNOWN, unproven is visible, DRIFTED outranks older success, missing evidence renders UNKNOWN. Evidence: s06 2026-08-04T21:40, 22:14, 2026-08-05T06:30 and eight repeats. P1. Mechanism: one shared status enum with a total order used by CLI, dashboard and Seal; adversarial render fixtures.
16. Gates without a terminal exit sentinel are INCOMPLETE, never PASS. Evidence: s06 2026-08-05T14:03, 14:30 (log stopped mid-test, waiter PID 75200 alive). P1. Mechanism: gate wrapper writes a .exit sentinel by trap with `timeout -k`; waiter exits when producer is gone.
17. Local green is not release green; CI on Linux disagreed. Evidence: s05 2026-08-03T07:06 prior handoff falsified at e46639653 (stale-install warning absent, trust-core rc=67); memB feedback-local-only-failure-was-ci-red. P0. Mechanism: run the exact CI gate in a Linux container before push; green claims cite the Actions run id on the exact tree SHA.
18. Reproduce at exact SHA with a parent control and classify environment, baseline or candidate before fixing; do not rerun first or call it flaky. Evidence: s06 2026-08-04T10:42, 16:54; memB feedback-failed-to-reproduce-is-not-false-alarm. P1. Mechanism: failure-triage script that runs HEAD and parent in clean worktrees and emits the class.
19. Re-run an inherited blocker before building on it. Evidence: memA feedback-retest-inherited-blockers (after `brew install ripgrep` and `npm ci`, four of five gates went green with zero code change). P2. Mechanism: blocker rows carry a reproduction command and date; re-run before dependent dispatch.
20. Agent bug hunts contain hallucinated findings; every finding needs a reproduction first. Evidence: s01 2026-02-07T04:25 "validate which are true and which are hallucinated"; 2026-02-10T02:59. P1. Mechanism: triage seat marks CONFIRMED or REJECTED; no fix slice without failing reproduction.
21. Competitive and factual claims were baseless (npm said unpublished when published). Evidence: s01 2026-02-04T02:04, 02:07 "judged by 2 reviewers". P0. Mechanism: claim registry with file:line or URL and a verifier pass.
22. Review-comment triage must validate each comment against the code. Evidence: s01 2026-02-10T02:56 PRD_ARG unquoted, LOKI_AUTO_CONFIRM versus CI=true precedence. P1. Mechanism: PR triage seat with per-comment verdict and a test per accepted fix.
23. Docs drift from code (run.sh versus SKILL.md, CONSTITUTION.md, website enterprise docs, CLI-MODERN.md). Evidence: s00 2026-01-05T01:10 "it's not running that feedback loop"; s03 2026-03-19T15:42 five inaccuracies on autonomi.dev; s08 2026-10-20T13:46. P1. Mechanism: docs generated from CLI help and code; docs-drift CI that runs documented commands.
24. Counts and metrics in docs must come from commands (37 agents, 41 agent types, 70k sessions, traction numbers, "320+ releases, 92 commands"). Evidence: s00 2026-01-05T01:39; s01 2026-02-04T02:22; s02 2026-03-02T04:02; s03 2026-03-18T17:22; s04 2026-04-06T04:28. P1. Mechanism: generated traction and count blocks; doc lint rejects hand-typed numeric claims without a source.
25. Numbers shown in product must be real time, never dummy or sample data. Evidence: s00 2026-01-22T01:05 "why does it have all dummy data?"; s01 2026-02-02T02:42 "never use sample data"; s04 2026-03-24T14:21 "these numbers are fake". P1. Mechanism: dashboard widgets bound to the event stream; ban hardcoded metrics.
26. Version shown by the product was hardcoded or wrong. Evidence: s03 2026-03-18T21:58 metrics printed 6.32.0 on 6.33.0; s07 2026-09-11T21:10 installed 9.35.0 printed 9.22.3. P2. Mechanism: version read at runtime from one source; status line prints VERSION, npm latest and git tag.
27. Cannot-verify items must be disclosed, not faked (remote session links, OG previews). Evidence: s02 2026-02-25T02:24, 2026-02-17T03:07. P1. Mechanism: probe via public crawler fetch; disclose limits in the report.
28. Project isolation must be proven (same-prompt build showed 31 files in a minute). Evidence: s05 2026-07-17T18:59. P1. Mechanism: test that two same-prompt builds have disjoint workspaces and zero shared files.
29. Receipt integrity: hash only after all attested writes finish; redact absolute paths; enforce schema versions. Evidence: s06 2026-08-04T07:38 (proof +465 versus tree +468), 2026-08-09T19:00 path leak, 19:30. P1. Mechanism: finalization-order test, path-redaction test, version negotiation matrix.
30. A green test run does not claim requirement coverage; publish a tested, untested, remaining table. Evidence: s03 2026-03-19T23:42, 2026-03-21T04:20; s04 2026-04-26T14:37; s05 2026-06-29T23:40. P0. Mechanism: coverage ledger per feature (unit, integration, real E2E) generated and attached to each release.
31. Verification lesson from FireLater: harness-caused PARTIAL or BLOCKED is a P0 bug; real completion is the product. Evidence: s07 2026-10-03T20:17; memB feedback-verified-unless-it-cannot-be. P0. Mechanism: weekly run-outcome audit; spec-conflict tasks routed to implementation with decomposition instead of refusal.
32. Status tables and ratings need evidence sources, not opinion. Evidence: s07 2026-09-25T23:51 "how many moat properties are proven"; s08 2026-10-23T05:33 "rate loki mode without hallucination". P1. Mechanism: status tables generated by script; ratings from a blinded rubric with cited evidence.
33. Founder expects honest self-critique and outcome framing for a layman user. Evidence: s04 2026-06-19T23:57, 2026-04-30T00:26, 2026-06-20T00:19. P1. Mechanism: Chief of Staff report leads with outcome, measured before and after, and an explicit not-done list.
34. Pasted output asked about vaguely must be mapped to a failure class before answering. Evidence: s08 2026-10-18T20:32 FireLater dirty tree versus 11.17.61. P1. Mechanism: failure-class lookup and reproduce on the failing artifact first.
35. Decisions in the log were drafted with false claims (D22 cited a nonexistent rule; D20 overclaimed parity; D88 cited but never written; D55 duplicated). Evidence: DEC D20, D22, D55 at lines 454 and 465, D88 stub. P1. Mechanism: decision-log lint: unique numbers, no duplicated bodies, every citation resolves, cited rule paths grep-resolve.
36. Councils declared solid work that was not; derive fixtures from the real writer; reproduced findings always block, unreproduced dissent never does. Evidence: DEC D12, D19, D20, D80 amendment 2 (four forged PASS results). P0. Mechanism: source-drift anchor tests, FC row plus guard per finding, round cap with CTO escalation at round 3.
37. The verdict and proof layer is the largest failure family (about 68 of 222 classes): Wall, baseline, Seal, NOT PROVEN, package ownership and receipts reported verdicts that did not match execution, fixed one ecosystem at a time. Evidence: FC Family A, chains FC-SEAL-NA-AS-UNPROVEN to FC-UNOWNED-FILE-OWNED-BY-TESTLESS-PACKAGE (4 rows), FC-FULLSUITE-ANSI-IDS to FC-CARGO-ID-CHANGED-CRATE (3 rows). P0. Mechanism: one proof-ownership resolver consumed by seal, verify and deep, plus a per-ecosystem fixture matrix gated by mutation.
38. Guards that name an instance recur; guards that name the invariant hold. Evidence: FC GUARDS 12 to FC-07 to FC-07b; GUARDS 22 to FC-89 plus two later repo-wide rows; FC-40 spawn guard to FC-69. Held guards include GUARDS 1, 4, 6, 5, 7, 8, 11, 12, 22, 23. P1. Mechanism: new guards state the invariant, enumerate siblings by command, are mutation-tested against a new-shape sibling, prefer a ban or derived list over a ceiling.
39. Guards with fixed numeric caps break under high release cadence. Evidence: FC-HELP-DRIFT-WINDOW-CAP, FC-SHARD-WATCHLIST-STALE, FC-60, FC-TEN-STABILITY-18d (1,737 against ceiling 1,728). P1. Mechanism: derive windows from content; counts as ratchets that only go down with an owner and conversion slice.
40. Reverts are rare but rising (31 total: Jul 1, Aug 4, Sep 7, Oct 19) and undercount quality because corrections ship as fix-forward. Evidence: GIT `grep -ci '^revert'`. P2. Mechanism: track fix commits within 48 hours of a release touching the same files as the escaped-defect rate.
41. Founder-path acceptance: done requires a recorded fresh walkthrough with screenshots. Evidence: s05 2026-07-03T23:51 "So Entire autonomi saas is complete?", 2026-07-04T00:40 preview shows nothing. P0. Mechanism: no complete state without user-path evidence.
42. Fix verified at the relay layer but not at UI render (autonomi-saas WS ownership gate on an always-empty global run id; generated app took over port 5173). Evidence: s04 2026-06-21T21:47, 22:04, 22:11. P0. Mechanism: browser-level acceptance on every pipeline fix; generated apps on isolated ports behind a preview proxy.
43. Cheap-model parity and harness-equalization claims need paired measured runs before marketing use. Evidence: memB project-cheap-model-parity-evidence (MiniMax M2.5 75.8 versus Opus 4.6 75.6), project-harness-model-equivalence-moat. P1. Mechanism: publish only with reproducible command and positive control.

### 3.2 Release

1. One release script owns every version file, changelog, docs sync and channel publish; prose checklists were ignored for 10 months. Evidence: s00 2026-01-05T03:27, 2026-01-22T02:49; s01 2026-01-26T01:50, 2026-02-01T06:10; s02 12 "did you follow" lines; s03 2026-03-20T21:30 and the 14-file list restated in five prompts; s04 29 lines; s06 2026-08-10T04:00. P0. Mechanism: single bump tool editing all version files atomically, a test grepping for stale versions, pre-push refusal on mismatch, Release Manager the only pusher, post-merge hook that cannot be skipped.
2. Single-source the version; stop committing version mirrors and dist. Evidence: GIT churn (VERSION 653, server.json 653, plugin.json 652, dashboard/__init__.py 654, Footer.tsx 399, WhatsNew.tsx 364, dist 893); s02 2026-02-23T04:06 SDKs at 0.1.0; s02 2026-02-15T20:28 website hardcoded v5.42.1. P1. Mechanism: derive all mirrors from VERSION at build and publish time; generate dist in CI.
3. Every VERSION bump ships a fully written CHANGELOG section and GitHub release body. Evidence: s07 2026-09-28T16:05; memA six releases (9.80.1 to 10.2.1) published with placeholder bodies; DEC D36. P1. Mechanism: release.yml body from scripts/release-notes.sh, fail instead of placeholder; `gh release view --json body` after publish.
4. CHANGELOG format broke twice in 30 minutes; a guard pinned to Unreleased breaks at release. Evidence: s03 2026-03-19T04:14, 04:41; memB feedback-unreleased-pinned-test-breaks-at-release. P2. Mechanism: CHANGELOG lint in release script; per-slice changelog fragments compiled at release.
5. Test the packaged artifact, never only the repo. Evidence: s03 2026-03-18T16:23 (6 patches for `loki web`), 2026-03-18T16:41 mandated `npm pack --dry-run`; s02 2026-02-14T02:35 did not work via npm; s00 2026-01-02T01:22 skill zip wrong structure; memB feedback-packaged-artifact-blind-spot. P0. Mechanism: install the tarball into a clean dir and run loki start, dashboard, MCP load and upgrade path as the post-pack gate; pack file-list assertion.
6. Never document a channel before a clean user can install from it; verify all channels after publish. Evidence: s01 2026-01-23T21:50 npm, brew, docker unpublished; s01 2026-02-07T05:07 "verify all 5 channels"; s04 2026-06-20T20:31. P0. Mechanism: clean-room per-channel install probe (npm, bun, brew, docker arm64 and amd64, vsix, PyPI) that must pass before a release is declared.
7. Prove a publish by an uncached tarball fetch, not a green job or cached packument; registry lag measured 4 to 11 minutes. Evidence: memB feedback-npm-propagation-window-4min, feedback-stale-packument-faked-a-failed-publish (six agreeing probes wrong); FC-DIST-TAG-MOVED-BACKWARDS 2026-10-23 recurrences (all 12 runs v11.66.1 to v11.67.9 failed the 8x15s settle loop; latest stuck on 11.67.8 for 2.5 hours because verify-npm-registry needed publish-npm). P0. Mechanism: converge job independent of publish (every 15 minutes), red not skipped; windows derived from measured lag; uncached tgz 200 as release truth.
8. Version and dist-tag drift between npm, GitHub and registries was found by the founder. Evidence: s07 2026-10-01T02:43 npm 10.5.10 while releases 5 to 6 ahead; s08 2026-10-09T03:29 "match next and npm"; memA local tag v11.18.0 versus npm next 11.71.1 (reader time); npm next was 11.72.0 at 2026-10-23T16:44Z. P1. Mechanism: post-release smoke asserting `loki --version` equals VERSION on every channel; pulse violation on divergence.
9. Release commit must leave the worktree clean; a fixed stage list shipped a stale dist map. Evidence: memA, memB feedback-release-commit-must-leave-worktree-clean (v10.5.10, 69ebc03e). P1. Mechanism: release.sh asserts empty `git status --porcelain` after the release commit (E-151).
10. Edits to loki-ts/src need a dist rebuild; dep bumps must install in the main checkout; bash-only edits can break TypeScript parity tests. Evidence: memB feedback-ts-edit-needs-dist-rebuild, feedback-dep-bump-must-install-in-main-checkout, feedback-bash-only-edit-broke-a-typescript-test. P1. Mechanism: dist rebuild and install as mandatory release steps with a diff check; parity tests selected when either side changes.
11. Pushes during a release cancel its Tests run; failed-only reruns skip publishes; ALLOW_RED did not bypass CI; a non-head VERSION bump does not release; a push that "landed" can be ancestor-only on a contended main. Evidence: memA feedback-release-push-cancels-tests (v9.18.0, v9.27.3 re-broken knowingly); memB feedback-release-rerun-must-be-full-not-failed (v9.50.3), feedback-allow-red-does-not-bypass-ci (v11.4.0 never published), feedback-version-bump-must-be-push-head, feedback-main-is-contended-verify-ancestry. P1. Mechanism: one pusher; no pushes during a release run; post-push `git merge-base --is-ancestor`; VERSION bump required at push head; full rerun only. Note: D96 and D102 changed the gating, so re-verify these before relying on them.
12. CI throttled releases: cancel-in-progress on main cancelled 10 of 12 Tests runs; Tests took 15 to 34 minutes; a release run took 2h14m. Evidence: s07 2026-09-27T13:15, 13:59; s08 2026-10-08T02:20; DEC D25. P0. Mechanism: release path depends only on a fast publish job; CI is a parallel fix-forward signal; never cancel on main; CI duration budget guard on the release path (target 2 minutes).
13. Red main was discovered by the founder, not the company. Evidence: s05 2026-06-27T15:04, 2026-07-08T22:37, 2026-07-24T18:09, 2026-07-28T23:32, 2026-08-03T07:06; s06 2026-08-06T15:17; s04 2026-04-19T00:08. P0. Mechanism: CI-watch seat polling every main commit, opening a fix-forward slice within minutes and posting to the CEO console first.
14. Skipping gates for speed produced failed and unpublished releases; the override never expired. Evidence: s04 2026-06-14T15:50 "skip local-ci for next 3 releases"; s07 2026-10-03T18:51 "skip all CIs for next 10 releases", 2026-09-28T03:11 v10.0.0 shards failed; DEC D59 two-hour waiver; D102 "a red build can reach latest for minutes". P0. Mechanism: waivers as flagged, time-boxed workflow inputs that expire automatically and schedule the deferred run plus a fix-forward slice.
15. Release policy flipped between per-slice, trains and "one big release"; never reconciled. Evidence: s07 2026-10-03T14:55, 18:47; s08 2026-10-08T02:19, 2026-10-19T15:30 "instead of doing hundreds of releases with no real value"; DEC chain D25 to D102. P0. Mechanism: one RELEASE-POLICY section owned by the Release Manager; any change deletes the superseded text and scripts in the same commit; a guard fails if two cadence numbers appear in docs/v10.
16. Release count is decoupled from user value; 11.x went from 11.0.0 to 11.71.2 in about three weeks (11.72.0 by 2026-10-23T16:44Z). Evidence: GIT; s08 2026-10-19T15:30. P0. Mechanism: continuous next tag per slice; latest promoted on user-visible milestones with notes; downloads shown next to release count.
17. Release-day red gates clustered: gitleaks mangled by the zsh :l modifier, merge-commit fingerprints, P9 red two releases running so tag and docker and homebrew jobs skipped, a slice dropped in conflict but named in notes. Evidence: GIT PROGRESS.md 2026-10-17T04:48Z to 06:19Z; memB feedback-zsh-var-colon-modifier. P0. Mechanism: run the exact release gate locally as a pre-push hook; release notes generated from merged SHAs.
18. Run the full gate before a release push, not a fast subset or narrowed slice gate. Evidence: memB feedback-run-the-full-gate-not-the-fast-subset, feedback-slice-gate-must-be-full-bun-test (10.10.4), feedback-changelog-guards-before-release-push (v11.7.0, v11.8.0), feedback-prepush-runs-global-guards, feedback-structural-guards-skipped-by-narrowed-review. P0. Mechanism: one scripted pre-push gate (local-ci fast tier plus every `select-tests.sh --guards-only` row plus tsc); slice briefs name the full command.
19. Run suites naming the function or file you changed; a doc move is not docs-only. Evidence: memA feedback-run-suites-naming-the-function-you-changed (v9.48.0 never published; 39 tests name README.md). P1. Mechanism: select-tests.sh maps function names and basenames to suites.
20. Release artifacts come only from CI; do not hand-create zips, tags or GitHub releases. Evidence: s00 2026-01-02T01:38, 2026-01-19T04:49, 04:50; s01 2026-01-30T04:28 "why tag?"; s06 2026-08-05T05:14. P1. Mechanism: Release Manager recipe; steps outside the script need CTO approval; post-release-verify compares SHA across main, tag, release, npm and dist.
21. Every release must be tested as the user runs it (bun, npm, docker, a full-stack PRD) and then cleaned up. Evidence: s04 2026-06-04T04:34, 2026-05-28T15:05; s07 2026-10-01T14:32. P0. Mechanism: post-publish journey test (`npm i -g`, loki start, dashboard HTTP 200) with automatic deprecate or dist-tag rollback.
22. Deployed site or page must be checked after release ("I still see the old one"); docs links 404; mobile layout broken. Evidence: s00 2026-01-22T02:49; s01 2026-01-22T19:47, 2026-01-24T22:01, 2026-02-01T03:19. P1. Mechanism: post-release fetch asserting the new version string; link checker and mobile screenshot in website CI.
23. Docs, wiki, website, blog and listings lag each release. Evidence: s01 2026-02-01T04:13, 2026-02-09T05:43, 2026-01-25T01:16; s03 ten blog requests and FALLBACK in useLatestVersion.ts; s01 2026-02-01T18:46 Docker Hub page without logo. P1. Mechanism: release event triggers docs regeneration, website fallback bump, blog and post drafts; per-channel listing metadata as a verified artifact.
24. Security findings need immediate unbundled patch releases. Evidence: s06 2026-08-04T01:57 auth-off WebSockets after v9.12.2, hotfix 9.12.3. P0. Mechanism: auth-boundary scan of HTTP, WS and PTY routes as a release check; HIGH security reviewer on new endpoints.
25. Schema changes broke the Python suite after merge (NOT NULL tenant_id). Evidence: s03 2026-03-19T21:18. P1. Mechanism: slice gate includes every test touching the changed model.
26. Duplicate release prompts and cut-short sessions show release state was not durable or idempotent. Evidence: s03 six duplicate pairs (v6.27.0, v6.28.0, v6.37.2, v6.37.6, v6.37.8 and v6.37.9). P1. Mechanism: idempotent release steps (check tag exists first) and a durable release state file.
27. Last release must be green before a session stops. Evidence: s08 2026-10-17T15:06, 2026-10-20T01:20, 01:53; s07 2026-09-28T22:54. P1. Mechanism: session-end guard refusing done unless main has a green verdict and dist-tags match.
28. Release-on-network-failure: retry the same safe step instead of idling. Evidence: s06 2026-08-03T21:46 ENOTFOUND left the agent idle. P1. Mechanism: bounded auto-retry with backoff for DNS and registry classes.
29. Release notes and moat ratchets: pending list shrink-only, cases list grow-only, tag ratchet. Evidence: DEC D2, D6, D36, D110. P2. Mechanism: keep ratchet files enforced; release.sh refuses bad notes and is not bypassable by LOKI_RELEASE_SKIP_GUARDS.
30. Secrets in fixtures blocked releases (gitleaks on a fixture; planted fake AWS keys forced a 124-commit filter-branch). Evidence: s07 2026-09-28T15:16; DEC D78; GIT v9.54.1 never published. P1. Mechanism: fixtures never hold scanner-matching literals; pre-push gitleaks on new fixtures.
31. Untracked and unreleased work across repos was tracked by the founder. Evidence: s05 2026-06-28T14:15, 2026-07-05T00:37. P1. Mechanism: daily repo hygiene sweep across repos reported on the CEO console.

### 3.3 Agent behavior failures

1. Agents stop, ask or idle when decisions are theirs. Evidence: s00 2025-12-29T03:31; s01 2026-02-04T16:41; s04 2026-04-25T18:36; s05 66 "autonomous" lines, 2026-07-30T17:36; s06 2026-08-08T19:34 "why would I tell a CTO and Cofounder"; s07 2026-09-13T13:51 "You keep stopping"; s08 2026-10-23T04:12. P0. Mechanism: decision-rights matrix; stop hook blocks a turn ending in a question when the ready queue is non-empty; escalation only for credentials, spend above cap, legal, public posts, irreversible actions.
2. Idle seats while work exists; done agents not reassigned; zero-tool-use agents claiming progress. Evidence: s01 2026-02-03T23:54 "0 tool uses ... Initializing"; s05 2026-07-16T15:18, 2026-07-27T15:56; s07 2026-09-27T17:04, 2026-09-28T23:31 "3 active with 8 ready". P0. Mechanism: pulse IDLE_BUILDERS with same-turn auto-dispatch; watchdog kills zero-tool-use agents after N minutes.
3. Stop-hook and goal loops repeated identical "No change" reports for hours and days. Evidence: s06 2026-08-03T10:40, 2026-08-04T20:10 (nine loops), 2026-08-05 eight steers, 2026-08-09T19:30. P0. Mechanism: fingerprint (SHA, changed files, criteria, outcome); identical twice auto-completes and escalates; stale lanes retired by fingerprint age.
4. Long silent periods; founder polls "what's going on". Evidence: s01 2026-02-06T05:24; s05 2026-06-29T19:37, 2026-08-03T00:50; s08 2026-10-08T14:32 "it's been 10hrs", 2026-10-20T13:27 "12hrs". P0. Mechanism: Chief of Staff heartbeat every 30 minutes and on any stall; push notification on milestones.
5. Speed is the most repeated complaint. Evidence: s04 35 fanout lines and 12 slow lines; s05 23 "speed up" lines, five in 90 minutes on 2026-07-02; s08 2026-10-23T16:19. P0. Mechanism: hard time budgets per role; over budget stops and re-slices; throughput on the CEO console.
6. Kill by name or pattern took down real sessions; Loki runs terminated unrelated Claude Code sessions. Evidence: at least 6 founder messages on 2026-09-26 (s07, first at 16:01); s04 2026-06-21T04:09 "it closed all claude code sessions"; DEC D14 (three terminations root-caused to `pkill -f "index.mjs"` at tests/test-backend-floor.sh:43) with follow-ups D15, D16 and D17 the same day; memB feedback-pkill-f-substring-killed-the-session. P0. Mechanism: PreToolUse guard (v10-guard.sh) blocking pkill, killall and pattern kills; static test over tests/ and autonomy/; only recorded PIDs may be signalled; bystander-survives test.
7. Broad cleanup destroyed live state (tmp glob deleted a worktree; BSD find pruned 7 live worktrees; python heredoc emptied BOARD.md). Evidence: memB feedback-tmp-cleanup-glob-deleted-worktree, feedback-prune-worktrees-live-agents, feedback-python-heredoc-emptied-a-coordination-file; DEC D18 (13,189 bytes lost). P0. Mechanism: loki_run_tmp_create and loki_run_tmp_cleanup; guard refusing commits where docs/v10 files shrink sharply; BOARD rendered from a structured store.
8. Runaway resource use made the Mac unusable. Evidence: s00 2026-01-05T03:18 hard restart; s04 2026-06-11T13:25 out-of-memory during SWE-bench; DEC D28 load 136. P0. Mechanism: resource governor capping parallel agents on CPU and memory; machine-health pulse (HIGH_LOAD, ORPHAN_TEST, STRAY_CONTAINER); container CPU and memory caps.
9. Runaway recursion: about 2,894 chained `loki --help --help` processes. Evidence: s05 2026-08-03T07:06. P0. Mechanism: spawn-depth guard (LOKI_SPAWN_DEPTH) and a process-count assertion in the fast tier.
10. Concurrent agents collided on files, branches and checkouts. Evidence: memB feedback-lead-must-not-edit-agent-owned-file, feedback-never-edit-a-script-while-it-runs, feedback-loki-run-switches-your-branch, feedback-agent-cwd-falls-back-to-main-checkout, project-core-bare-fault-recurring, feedback-worktree-agents-base-branch, feedback-commitless-worktree-reads-as-merged; s06 2026-08-03T10:40 core.bare true and checkout 176 behind, 2026-08-04T12:27 editing the canonical checkout; s04 2026-04-26T17:47 concurrent-edit storm. P0. Mechanism: single writer per file via BOARD file sets; briefs start with an absolute worktree path and abort on cd failure; pre-edit guard refusing the canonical or foreign-dirty checkout; core.bare watchdog wired and canary-tested.
11. Merge by "replace with the best single-agent version" destroyed integration work (34 orphaned components, 5,050 lines dead). Evidence: s04 2026-03-24T13:34. P0. Mechanism: non-overlapping file sets, 3-way merges, post-merge reachability guard (every component imported, every page routed).
12. Teammate agents go idle on completion; verdicts sit unread for an hour; merge the reviewed SHA, not the moved branch; hand-merges are unreviewed code. Evidence: memA, memB feedback-reviewer-verdict-push, feedback-teammate-agents-need-explicit-prompt, feedback-merge-reviewed-sha-not-branch, feedback-hand-merge-needs-review. P1. Mechanism: brief template ending in a mandatory SendMessage verdict; 10-minute pending-verdict timer; merge-gate merges by approved SHA; hand resolutions go back to review.
13. Dispatch from stale board rows; builder used the wrong base; rows already shipped re-dispatched. Evidence: GIT PROGRESS.md 2026-10-17T05:48Z GATES-06, 07:09Z DEPLOY-09, 11:21Z STABILITY-29; memB feedback-check-ready-row-not-already-shipped (2 of 5 rows done); DEC D37 (20 "waiting" slices already released). P1. Mechanism: dispatch preflight validating dependencies merged, paths exist, base branch correct and row not shipped; BOARD auto-flipped from git ancestry.
14. Unwanted files pushed (example apps, logs, video, coverage, generated files); bulk staging. Evidence: s00 2026-01-18T04:06; s03 12 `git add -A` lines; s06 generated outputs in RC worktree. P1. Mechanism: stage by name only; pre-commit deny-list; release stages from a manifest.
15. Emojis and dashes reappeared despite rules. Evidence: s00 2026-01-20T04:17; s05 2026-07-08T23:05; s04 2026-04-30T02:45. P1. Mechanism: pre-commit and publish-time lint rejecting emojis, em and en dashes in every changed file and commit message.
16. Wrong git identity on personal repos. Evidence: s01 2026-02-01T03:32; s04 2026-05-22T17:31, 2026-06-12T00:32, 2026-06-21T05:36; s00 2026-01-04T05:58 auth failure; memA feedback-repo-config-identity-blocks-push. P1. Mechanism: bootstrap sets repo-local identity; pre-push hook rejects wrong author email and Co-Authored-By; identity verdict printed first.
17. Orphaned processes and temp files after tests. Evidence: s01 2026-02-02T05:31, 2026-02-04T20:50; s03 2026-03-19T16:32; s04 2026-06-21T21:47 zombies causing 409 builds. P1. Mechanism: run-owned tmp dir with recorded PIDs and a trap; recorded-PID reaper; engine queue instead of single-flight 409.
18. Same mistakes recur; system does not learn. Evidence: s05 2026-07-09T00:03, 2026-07-10T06:44; memB 96 memories did not prevent a repeat. P0. Mechanism: every incident becomes a guard with a test (GUARDS.md); recurrence counter per class; lessons loaded as a skill, not passive memory.
19. Passive memory is contradictory; superseded rules coexist. Evidence: memA (126 of 252 files read; pkill advice reversed; one-green-release superseded; overlapping pushes corrected). P1. Mechanism: supersession ledger and periodic consolidation that deletes or marks superseded memories.
20. Read code before filing a gap: 8 of 11 suspected gaps were built; 12 candidates audited had zero missing. Evidence: memA, memB project-loki-gap-is-last-mile-wiring, feedback-read-code-before-assuming-a-gap. P1. Mechanism: gap audit cites grep, positive control and entry point; PO rejects slices without it.
21. New commands, tests and probes need every cross-cutting registration; speed work must not lose coverage. Evidence: memB feedback-new-command-cross-cutting-registration, feedback-new-test-file-structural-guards, feedback-new-doctor-fail-row-breaks-fake-cli-fixtures, feedback-new-probe-breaks-recording-stubs, feedback-speed-must-not-cost-coverage (shellcheck lost 2 rules). P1. Mechanism: generated registration checklist; before and after rule-count diff for speed changes.
22. Shell portability traps produce platform-only failures. Evidence: memB zsh BASH_SOURCE empty, zsh :l modifier, zsh path var clobbering PATH (rc 127), trap EXIT in subshells, set -e, pipefail and SIGPIPE inversion, GitHub bash -e, bash 3.2, bun ignoring SIGTERM; s06 2026-08-10T13:48 `grep -c || echo 0` multiline hang. P1. Mechanism: loki-verify skill loaded before writing probes; lint for these classes; bash 3.2 and bash -e CI lane; shared status-safe count helper.
23. Placeholder and unwired features shipped (cmd_voice, unwired components, unknown unclickable UI items). Evidence: s03 2026-03-19T19:04, 2026-03-18T15:01, 2026-03-19T04:50, 2026-03-17T23:14. P1. Mechanism: reachability guard: every shipped command and component wired to an entry point and exercised by a test.
24. Agents drifted from stated requirements (PHP container for a React migration; designs ignoring direction). Evidence: s02 2026-02-27T05:04, 2026-02-15T05:09. P2. Mechanism: spec drift check against target stack; reference capture before showing the founder.
25. Generic design output rejected ("reusing everything from your training", "you ruined everything"); one full rollback. Evidence: s05 2026-07-08T21:53 to 23:47, 2026-07-10T22:22; s04 2026-06-15T22:40 "looks very cheap". P1. Mechanism: design seat with reference-capture protocol, visual diff against reference, rollback tag before redesign.
26. Agents hardcoded behavior instead of model judgment; fixes per stack or one-off. Evidence: s05 2026-07-17T19:45, 2026-07-10T23:08, 2026-07-15T18:52; s07 2026-10-03T17:40. P0. Mechanism: review rule rejecting literal stack names and fixed lists; generic-input fixtures; failure-class sibling sweep.
27. Agents under-investigated before changing (founder asked for read-and-report first). Evidence: s03 2026-03-17T21:56, 2026-03-18T17:20. P2. Mechanism: architect boundary map (dashboard versus Purple Lab, ports 57374 and 57375) in always-loaded docs.
28. Agents over-released or bundled; founder had to say "Do NOT release". Evidence: s03 2026-03-18T15:14, 15:27, 15:37, 07:30. P2. Mechanism: explicit stage field per slice (implement, review, release).
29. Brittle long prompts truncated, duplicated or resent about 14 times. Evidence: s06 2026-08-04T03:36 "CORRECTION - disregard the preceding truncated directive"; 2026-08-05 Lane B resent about 14 times. P1. Mechanism: dispatch by slice card path; resume reads card and git state; dedupe identical dispatches.
30. Agent crashes and context exhaustion stalled slices. Evidence: s06 2026-08-05T07:30, 10:40, 2026-08-04T14:26 "100% context". P1. Mechanism: checkpoint fingerprint per slice; supervisor respawns from checkpoint; context budget handoff before 100 percent.
31. Background fanouts were stopped by the founder (8, 12, 21 agents), signalling wasted spend. Evidence: s07 2026-09-11T02:50, 2026-09-15T14:31; s05 2026-07-02T16:03. P1. Mechanism: fanout budget with cost forecast before spawn; incremental findings to a durable file.
32. Refusing a groundable request because part is ungroundable is avoidance. Evidence: memA, memB feedback-research-is-not-telemetry (refused three times). P1. Mechanism: split groundable and ungroundable halves and do the groundable half immediately.
33. Approval prompts interrupted autonomous runs (10 or more in 30 minutes). Evidence: s07 2026-10-03T03:57; s06 2026-08-07T02:14. P1. Mechanism: permission allowlist for run-owned dirs and worktrees; bypass mode in isolated worktrees.
34. Founder was made to relay prompts between sessions. Evidence: s07 2026-09-30T20:46, 2026-09-26T14:56, 2026-09-28T03:08. P0. Mechanism: Chief of Staff owns dispatch directly; no deliverable of the form "prompt for the founder to paste".
35. Misread frame: Loki treated as only a verifier. Evidence: s07 2026-09-25T20:21, 2026-10-01T02:34, 2026-10-08T02:14. P1. Mechanism: roadmap items name a user-visible outcome, not only an internal proof.
36. Agents should research latest facts instead of answering from stale knowledge. Evidence: s01 2026-02-03T21:53; s07 2026-10-01T03:17, 2026-10-03T17:44. P2. Mechanism: weekly frontier-scan digest; search before answering an unknown term.
37. Infer dictated intent instead of asking ("Ase you to be Autonomi"). Evidence: s07 2026-09-13T13:51. P2. Mechanism: intent normalization step; ask only when interpretations change the outcome.
38. Unexplained output shown to the founder. Evidence: s06 2026-08-06T23:10 "what non sense is this". P1. Mechanism: founder-facing reports go through the Chief of Staff in a fixed format (outcome, SHA, proof, rollback, next).
39. Harness and automation prompts leak into founder transcripts. Evidence: s04 2026-05-29T22:50; s05 2026-07-13T06:18; s08 2026-10-23T04:13 to 04:18. P2. Mechanism: tag automation sessions at source; exclude from retro extraction.
40. Wrong working directory and stale installed copy. Evidence: s00 2026-01-09T19:31, 2026-01-06T23:37; memB project-loki-engine-deployment-topology. P1. Mechanism: installer-only updates to the installed copy; session preamble prints cwd and installed versus repo version.
41. Ideation by persona role-play produced rejected output (rated 1/10 after six rounds). Evidence: s05 2026-07-10T04:41 to 13:32. P1. Mechanism: ideas need demand evidence and a prototype versus reference before build; kill rule.
42. Open-ended growth asks with no measured outcome. Evidence: s05 2026-07-29T02:49 "double the stars ... i don't care what you do". P2. Mechanism: attributable growth experiments with a funnel metric.
43. Agent inefficiency burned a metered external quota (6 of 40 posts). Evidence: s02 2026-03-06T18:30. P1. Mechanism: idempotency key and dry run for metered API calls; daily budget guard.
44. Promised artifacts not delivered (knowledge graph asked three times in four minutes). Evidence: s02 2026-02-25T16:56 to 17:00. P1. Mechanism: deliverables registry with path and existence check in the CEO report.
45. Compaction and session loss erased work context. Evidence: s02 2026-02-16T04:18; s05 2026-07-03T19:09; s08 2026-10-23T04:05. P1. Mechanism: in-repo checkpoint file written every turn; resume command.
46. Scope creep and overlapping lanes were policed by hand. Evidence: s06 2026-08-03T09:13, 2026-08-04T01:57, 2026-08-10T15:01. P1. Mechanism: non-overlapping file-set claims enforced by a claim-check script.
47. Long benchmark and background jobs lacked monitoring (SWE-bench 12 hours, killed). Evidence: s00 2026-01-06T16:54, 16:55. P1. Mechanism: progress heartbeat and per-task timeout with stall escalation.
48. Autonomous loop prompts said "NEVER finished, run forever" and retried with identical prompts (26 resume prompts, 36 iterations). Evidence: s00 2026-01-09; s01 2026-02-04T21:00; s02 2026-03-06T17:06. P1. Mechanism: closure criteria and stop condition; smart retry changes strategy.

### 3.4 Founder preferences

1. Full autonomy: decide, push, release, post without asking; escalate only founder-gated items. Evidence: every shard; s08 2026-10-08T04:43 "i approve everything"; memB founder-full-decision-grant (D99, 2026-10-22). P0. Mechanism: standing authority charter in OPERATING-MODEL.md with decision rights; founder queue limited to credentials, browser auth, money, legal, public posting.
2. Never believe a NO, but never fabricate: report blockers with three attempted routes and the next experiment. Evidence: s05 2026-07-14T22:42; s08 2026-10-23T05:41, 16:25. P1. Mechanism: blocked-state protocol in the Chief of Staff template.
3. Status as tables from the user's view, short, at each landing, with ratings versus named competitors, in layman words; 2-line summaries on request. Evidence: s00 2026-01-10T04:15; s02 2026-02-24T04:45; s04 2026-06-14T15:03; s05 2026-07-14T22:42 every 30 minutes; s07 2026-10-05T02:00. P1. Mechanism: Chief of Staff digest on a timer, generated from BOARD and evidence, under 10 lines with a linked detail page.
4. Default operating pattern: todo list, parallel worktree teams, multiple reviewers, council, loop until clean. Evidence: s00 2026-01-17T21:41; s01 2026-02-05T16:45; s02 2026-02-12T23:19; s03 2026-03-19T05:03; s04 2026-03-22T15:37. P0. Mechanism: encoded once as the company workflow (PO slice, engineer, reviewers, judge); never restated.
5. Only improve, never break existing users. Evidence: s01 2026-02-10T03:19, 2026-02-12T04:38; s04 2026-04-26T00:21 "I'm scared of losing users". P1. Mechanism: regression suite as hard gate and before and after behavior diff of changed commands.
6. Model-tier policy, pinned per role. Evidence: s00 2026-01-05T01:11, 2026-01-19T19:04; s01 2026-01-27T05:52; s07 2026-09-27T13:55, 2026-10-07T21:25, 21:30 (Opus advisors, Sonnet default engineer, Haiku for tests, docs, small work if Opus allows). P0. Mechanism: model pinning table enforced by the spawn wrapper; agents without an explicit model are rejected; every agent logs its model.
7. Provider default is the provider's latest top model with no inventory to maintain. Evidence: s01 2026-01-24T22:18, 2026-01-30T04:38. P1. Mechanism: model resolution module querying the provider with a static fallback and a stale-default test.
8. Extend, never duplicate; no new files for features that belong in existing code; replace removes the superseded code. Evidence: s00 2026-01-19T04:43; s08 2026-10-15T13:21, 13:22, 2026-10-16T00:01; memB feedback-extend-existing-never-new-files. P1. Mechanism: CI flag on new files without a justification line; duplicate sweep slice.
9. loki start is the primary path; chat is an alternative. Evidence: s08 2026-10-15T11:32; memB feedback-loki-start-is-primary. P1. Mechanism: every feature slice needs a loki start test.
10. Users should not have to think: features embedded in loki start flows, no isolated commands; reduce duplicate commands. Evidence: s04 2026-04-24T16:54, 2026-04-29T03:48, 2026-06-10T13:45. P1. Mechanism: command-registry guard; owning-module justification for any new command.
11. Never hardcode; generic for any input and stack; model intelligence decides. Evidence: s04 2026-03-22T22:55; s05 2026-07-10T23:08, 2026-07-17T19:45; s07 2026-10-03T17:40. P0. Mechanism: see 3.3 item 26.
12. No emojis, no em or en dashes, no hype, no AI-sounding copy, humble yet differentiated, respectful of competitors. Evidence: s00 2026-01-20T04:17; s02 2026-02-16T05:35; s03 2026-03-18T07:10; s04 2026-06-15T20:40, 21:54. P1. Mechanism: content lint and a tone review step.
13. Commit identity asklokesh / lokeshmure@live.com via gh, no Claude co-author; keep strategy and roadmaps local and untracked where asked. Evidence: s00 2025-12-28T21:24; s02 2026-02-15T06:52; s04 2026-05-27T19:30; s05 2026-06-30T16:16. P1. Mechanism: hooks plus a denylist of never-committed paths.
14. Zero mis-anything at an Anthropic or OpenAI grade bar, remembered globally. Evidence: s08 2026-10-19T17:18; memB feedback-zero-mis-frontier-lab-bar. P0. Mechanism: command-cited claims table; reviewer re-derives counts before any CEO report.
15. Learn globally across the machine when a convention is taught. Evidence: s08 2026-10-08T19:11, 19:12. P2. Mechanism: route cross-project rules to ~/.claude/CLAUDE.md and confirm scope after each correction.
16. Outputs ready to use: copy-paste text files, exact char limits, files in Downloads. Evidence: s02 2026-02-16T05:01, 2026-03-02T00:36, 01:47. P2. Mechanism: output format checklist with length validation.
17. Founder tests locally and wants real running state, screenshots, LAN access, rebuild and restart on demand. Evidence: s02 2026-02-15T04:13, 2026-02-23T05:19; s05 2026-07-09T22:43 "I want real one", 2026-07-10T23:42. P2. Mechanism: workstation app serving live state with a one-command rebuild and health checks before reporting.
18. Safe-by-default autonomy: dangerous mode default, enterprise security opt-in; SDLC phases all on by default and skippable. Evidence: s00 2026-01-05T05:22, 2025-12-29T03:42. P2. Mechanism: config matrix with documented defaults and a test per default.
19. PRDs and plans for agents carry no dates and are self-contained. Evidence: s00 2026-01-08T03:57, 2026-01-11T04:50, 04:51; s08 2026-10-17T14:57. P2. Mechanism: slice-card template without dates and with context pointers.
20. Decision framework over opinion: weighted scoring and self-reflection. Evidence: s00 2026-01-04T22:33, 2026-01-19T04:43. P1. Mechanism: decision log with scored options.
21. Planning modes: deep plan reviewed by an Opus advisor, then parallel implementation; plans live in the repo. Evidence: s05 64 ultrathink lines, 2026-07-24T17:49; s08 2026-10-15T13:01, 2026-10-16T02:21; memB feedback-ultrathink-ultracode-standing. P2. Mechanism: default Architect protocol; plan files committed.
22. Measurable rising goals: UX score out of 10 rising 0.1 per iteration; 10x per release; benchmarks recorded each version. Evidence: s05 2026-06-30T20:17, 21:11, 2026-07-10T13:53. P1. Mechanism: per-release benchmark time series on the CEO console; a regression opens a P0.
23. UI bar: smooth, no jank, no scroll for landing, one frame, collapsible sidebars, standard icons, merged bars; Anthropic, Vercel or Linear look; old dashboard fonts and colors. Evidence: s01 2026-02-07T22:35; s05 2026-07-16T14:48, 19:17, 23:13; s07 2026-10-03T15:16; memB feedback-ui-smooth-fluid-standard. P1. Mechanism: design tokens, Playwright screenshot rubric, layout-shift checks.
24. Time-boxed deadlines are binding (15 minutes, 60 seconds, 4 hours, 12 hours). Evidence: s08 2026-10-08T02:19, 2026-10-19T16:29, 2026-10-23T04:14. P1. Mechanism: ETA recorded at dispatch; overrun triggers re-slice and a visible note.
25. Stop protocol: finish current work, stop tasks, print next items and exit; nothing left running. Evidence: s08 2026-10-17T14:59, 2026-10-09T03:16; s00 2026-01-03T05:19, 2026-01-17T23:12. P2. Mechanism: stop script draining agents by recorded PID and printing the resume plan.
26. Founder identity and voice in public copy (Lokesh Mure, Loki; written by him, not AI). Evidence: s07 2026-09-27T14:06, 2026-10-01T17:56, 18:04. P1. Mechanism: brand and voice file with bio facts and banned phrases.
27. Founder approves autonomous PRs for VERIFIED outcomes; options presented only when materially different. Evidence: s08 2026-10-19T13:07, 02:06; memB feedback-open-pr-on-verified. P1. Mechanism: auto-open PR on VERIFIED with a pre-selected default.
28. Velocity, accuracy and scope increase together; none traded. Evidence: s08 2026-10-08T04:44, 04:48. P1. Mechanism: three-axis scorecard per release.
29. Founder's stated velocity escalations (one minor per hour, 10 feature releases per hour, 3 to 6 releases per hour, 2-minute workflows). Evidence: s05 2026-07-30T13:50, 2026-08-03T03:07; s07 2026-09-30T17:34; s08 2026-10-08T18:46. P0. Mechanism: release-rate KPI with automatic violation; per-command timeout budgets.
30. Founder's testing stance varies by day ("I don't care about testing at this point" versus "make sure bugs are found before releases"). Evidence: s05 2026-07-25T14:59, 2026-07-28T14:00; s04 2026-06-10T04:03; memB feedback-founder-no-testing-velocity (2026-10-15). P1. Mechanism: tiered gate where the fast tier is always on and skips are logged with a follow-up bug hunt.
31. Founder supplies references (screenshots, mockups, videos, competitor zips) and expects native study including motion. Evidence: s05 49 image lines, 2026-07-10T22:22, 2026-07-16T04:16. P2. Mechanism: reference-capture tool recording frames and motion; side-by-side output in review.

### 3.5 Org and process

1. Founder wanted a staffed agent company from March onward (council of 3, 20 agents, principal and distinguished level, CEO, CTO, PMs, POs, Release Manager). Evidence: s03 2026-03-19T05:03; s04 2026-06-21T04:09, 05:06; s05 2026-06-29T14:43; s07 2026-09-27T13:52; s08 2026-10-23T16:25. P0. Mechanism: role charters with pinned models and KPIs in OPERATING-MODEL.md and a startup roster check.
2. Durable task ledger: BOARD.md as the single tracker; tasks distributed as agents finish; nothing lost across sessions. Evidence: s00 2026-01-17T21:41; s01 2026-02-12T04:38; s04 2026-05-27T17:29; s05 2026-07-18T03:12. P1. Mechanism: BOARD in a structured store rendered to markdown; agent turn cannot end with open rows assigned to it.
3. Handoff continuity: full resume docs and prompts for the next session. Evidence: s04 2026-04-29T02:35, 2026-06-14T15:45; s05 2026-07-13T03:52. P1. Mechanism: HANDOFF.md auto-updated at each landing.
4. Branch, worktree, team and session sprawl needed founder-ordered cleanups (112 worktrees, 20 GB). Evidence: s02 2026-02-12T23:56, 2026-03-01T06:29; s06 2026-08-06T13:49, 23:33 missing branch; s07 2026-09-27T13:15. P1. Mechanism: janitor job archiving with a manifest of SHAs before deletion; pulse violation above 15 worktrees.
5. Review overhead ate throughput (serial rounds, 5 to 9 rounds, opus at 50 percent). Evidence: DEC D21, D73, D98; GIT METRICS.md 2026-09-26 16:52 "only 2 releases in about 4h". P0. Mechanism: introduced-by-diff blocks, pre-existing becomes a new slice; 2-round limit then CTO; opus builders for HIGH slices (D103: approved round 1).
6. The same rules are restated across six or more files and drift (Captain versus Release Manager versus Release Captain; SWARM.md describes removed mechanisms). Evidence: DEC reader grep (moat ordering in 4 files; SWARM.md lines 137 to 141 reference required-ci). P1. Mechanism: one constitution, other files archived as stubs, lint for references to removed mechanisms.
7. Founder queue rows go stale without status; many were CoS-decidable. Evidence: DEC FOUNDER-QUEUE 22 rows; rows 13, 14, 17, 19, 20, 22 decided by CoS; row 6 likely moot. P1. Mechanism: status column, 7-day auto-expiry with a stated default, FOUNDER_QUEUE_STALE pulse.
8. Failure-class discipline produced 222 rows in 20 days, mostly per instance, with inconsistent IDs and duplicate headings; 23 guards for 222 classes. Evidence: FC command outputs; GIT. P1. Mechanism: machine-readable family tag and guard test path per row; CI fails on duplicates or missing fields; families with 3 or more rows reported as "class not closed".
9. Add a recurrence counter and "guard last fired" date per class. Evidence: GIT PROGRESS.md 2026-10-17T05:34Z FC-TEN-UX-01 recurrence. P1. Mechanism: computed from CI logs; idle classes archived after 60 days.
10. Shared append files cause conflicts and hand-merges. Evidence: GIT PROGRESS.md 2026-10-17T06:42Z, 07:09Z, 09:21Z. P1. Mechanism: per-item files with script-allocated IDs, or a merge driver.
11. Docs commits are a large share; progress prose is hand-committed. Evidence: GIT docs 1,271 commits (14.5 percent), September 28 percent; about 29 percent of commits unclassified. P1. Mechanism: cap unattached docs commits; generate progress from the pulse; conventional-commit lint.
12. Planning artifacts and roadmap in the repo with a trigger phrase. Evidence: s08 2026-10-17T14:57; memA project-plan-v12-in-repo. P1. Mechanism: roadmap folder as the board's source.
13. Generalize every incident to a class, invariant and guard; one gate at a time; cheapest failing check first; council rounds beat a single green report. Evidence: memB feedback-think-at-100k-feet, feedback-one-gate-at-a-time, feedback-cheapest-failing-check-first, feedback-council-rounds-beat-green-reports. P1. Mechanism: FC row before any fix slice (D86); local-ci single-instance lock and cheapest-first ordering.
14. Timeboxes per card (45-minute checkpoint, 90-minute candidate, 3 to 15-minute remediations); code is the default activity. Evidence: s06 2026-08-04T20:11, 22:14, 22:17, 2026-08-05T14:03. P1. Mechanism: timer wrapper recording overrun in METRICS.md and re-slicing.
15. Proportional verification: one ladder after completeness, focused discriminators during build, no redundant reruns. Evidence: s06 2026-08-04T03:36, 23:09; s07 2026-10-03 "remove stale jobs". P1. Mechanism: diff-selected runner with digest-bound cache; FULL tier diagnostic only.
16. Commit authority was ambiguous per lane and contradicted the standing grant. Evidence: s06 2026-08-03T10:00, 2026-08-04T23:44, 2026-08-09T19:30, 2026-08-10T03:11. P1. Mechanism: one authority matrix; lane steers may only narrow scope.
17. Receipts and proofs lived outside the repo (~/.openclaw/workspace/artifacts). Evidence: s06 2026-08-05T13:28, 14:03. P1. Mechanism: tracked receipt store with an index owned by the Chief of Staff.
18. Packet-style delegation where one CTO alone integrated produced "terminal PASS" packets that never released; "six to eight months fixing, not releasing". Evidence: s07 2026-08-20T10:02, 2026-09-12T15:33. P1. Mechanism: Release Manager integrates accepted packets within the hour; metric of accepted but unreleased packets.
19. Bug-hunt loops and issue triage were founder-triggered. Evidence: s02 2026-02-13T00:26, 2026-02-14T03:25; s03 2026-03-19T15:45, 16:02. P1. Mechanism: scheduled bug-hunt seat with a standing queue; issues auto-closed from commit trailers.
20. Priority overrides need rules (founder swarm prompt overriding BOARD). Evidence: s07 2026-09-30T20:01. P2. Mechanism: override rule in DECISIONS.md naming what is parked.
21. Community handling: validate external PRs with the exact scenario, review, merge and thank. Evidence: s05 2026-07-01T15:59 PR #178. P2. Mechanism: community seat with a triage SLA.
22. Support: inbound user reports were the main bug channel. Evidence: s03 2026-03-17T21:56, 2026-03-18T05:04, 2026-03-19T15:30. P2. Mechanism: each report becomes an FC row plus a drafted reply.
23. Roles between "Loki the product" and "the company that builds Loki" were confused. Evidence: s08 2026-10-18T21:21, 2026-10-22T17:13; memB feedback-loki-fixes-loki. P1. Mechanism: every status states which one did the work.
24. Mass parallelism demanded (10 teams in 15 minutes), but large bundled directives stall. Evidence: s08 2026-10-08T02:19; s07 2026-09-30T19:09. P1. Mechanism: seat utilization KPI; refill ready queue in the same turn.
25. Ready queue and pulse not maintained (7 of 30, PROGRESS 5,210 minutes stale). Evidence: memA pulse 2026-10-23T16:30Z. P1. Mechanism: Chief of Staff refills to 30 on a timer; PO and Architect auto-dispatched when ready falls below 2x engineers.
26. Retro pipeline: sonnet reads with counted coverage, opus synthesizes. Evidence: s08 2026-10-23T16:25. P2. Mechanism: sharded extraction with message counts per shard.
27. Workflow scriptPath reruns relaunch the old script. Evidence: memB feedback-workflow-scriptpath-relaunches-old-script. P2. Mechanism: script hash per run; warn on match.
28. Remote ultraplan sessions failed three or more times. Evidence: s04 2026-04-24T01:56, 15:58, 2026-06-21T02:19; s05 2026-07-13T05:23. P2. Mechanism: plan locally by default; remote only with timeout fallback.

### 3.6 Product and features

1. Dashboard visibility failed for the entire year: zeros, dummy data, stale data, 3 to 4 ports, HTML versus React, empty panels, controls that did nothing, 404 on first run. Evidence: s00 six reports from 2025-12-28 to 2026-01-22; s01 2026-02-04T21:07 "unify these 3", 2026-02-06T05:36; s02 2026-02-14T04:59 cost always empty; s04 three raises of missing task detail; s07 2026-10-01T15:45 "very rogue and useless"; s07 2026-10-03T22:01 404. P0. Mechanism: one embedded dashboard, one launch path, one event stream (events.jsonl); every widget traces to an event; real-run E2E and populated-data Playwright check as a release gate.
2. One session controllable from CLI, dashboard and API; stop must stop only the current session and only report stopped after exit. Evidence: s01 2026-02-04T20:39, 2026-02-07T06:28, 15:22; s03 2026-03-19T04:23, 2026-03-20T00:58; s04 2026-05-29T01:57, 18:09. P0. Mechanism: per-run session registry with recorded PIDs; cross-surface integration test (start CLI, pause dashboard, resume CLI, stop API).
3. Real-user runs exposed bugs CI missed (bash 3.2 unbound arrays, 50 failed tasks with no recovery, dashboard task not picked up). Evidence: s01 2026-01-30T04:25, 2026-02-04T06:43, 2026-02-01T18:19, 18:46; s04 2026-05-27T17:55. P1. Mechanism: macOS bash 3.2 with set -u CI lane; dogfood fleet of three reference projects per release candidate.
4. Fix for everyone, not just the founder. Evidence: s01 2026-02-04T22:11, 2026-02-01T18:07; s02 2026-02-21T20:23 "works in this mac, but others have issue". P1. Mechanism: fresh-machine install smoke per distribution.
5. Embed the skill in the CLI package so it works without separate install. Evidence: s01 2026-01-30T05:45, 2026-02-01T07:01. P1. Mechanism: package-embedded skill and install-path smoke test.
6. Definition of done and closure; end state is a running artifact the user can open. Evidence: s01 2026-02-07T17:35; s02 2026-02-14T04:16. P1. Mechanism: closure criteria per task (RARV-C) and a completion verifier.
7. Task details (story, acceptance criteria, tests) and a PRD-derived checklist that checks off. Evidence: s02 2026-02-16T02:43, 2026-03-06T14:39; s04 2026-03-22T23:00, 2026-04-27T02:49, 2026-05-29T16:16. P1. Mechanism: task schema requires those fields; writer validated; fixture test on real output.
8. Preview: must be stack-generic, model-decided, isolated, visible fast. Evidence: s03 2026-03-20T20:46 hardcoded index.html; s04 2026-03-21T05:48 preview 500; s05 2026-07-17T23:46 "never see preview, that's the biggest problem". P0. Mechanism: preview descriptor emitted by the build agent; isolated ports behind a proxy; a build is incomplete without a reachable preview URL.
9. Time to first visible output was uncompetitive (1 hour versus 2 minutes on Lovable; 30 minutes in planning). Evidence: s05 2026-07-17T02:37, 01:01, 2026-07-16T02:58. P0. Mechanism: first-paint SLO as a gated metric; UI-first lane; weekly head-to-head timing.
10. Builds must be fail-proof: auto-resume, always-on steering and chat on failed builds. Evidence: s05 2026-07-17T20:00, 2026-07-05T00:35, 2026-07-16T04:12, 2026-07-08T22:10. P0. Mechanism: chaos test killing the engine mid-build and asserting recovery.
11. Purple Lab as a Replit or Lovable class IDE was the March GTM; it shipped broken and was later removed. Evidence: s03 2026-03-19T04:23, 2026-03-20T01:17 "very amateur", 2026-03-20T21:07; s08 2026-10-08T21:53. P1. Mechanism: GTM surfaces get HIGH review and browser E2E; dead surfaces removed by a quarterly audit.
12. Terminal and live log UX (logs lost on refresh, full logs every 2 seconds, infinite scroll). Evidence: s03 2026-03-19T23:18, issues #118 and #122. P1. Mechanism: incremental log protocol with a cursor and a refresh-restore E2E.
13. Compatibility regressions on claimed platforms (Python 3.9, Windows, macOS /tmp symlink). Evidence: s03 2026-03-18T05:04, issues #124 and #137. P1. Mechanism: CI matrix over claimed Python versions and OSes for import smoke.
14. Security was found ad hoc (auth bypass #87, timing attack #98, token perms #97, traversal #127, #131; zero-auth dashboard, shell injection in sandbox.sh, Docker as root; GitHub tokens exposed to project code). Evidence: s01 2026-02-12T22:27; s03 2026-03-19T16:46, 17:15, 18:09; s08 2026-10-09T00:24. P0. Mechanism: HIGH security reviewer on auth, path and token code; negative tests as standing guards; secret-env scrubbing for every spawn path; disclosure runbook.
15. Usability failures in CLI: API key demanded when CLI is logged in; second concurrent run blocked; cost cap default useless; no tab completion; run only from main; docker not reusing host login. Evidence: s02 2026-02-14T02:14, 2026-02-26T06:27; s07 2026-10-03T14:53, 19:32, 19:17, 15:00. P1. Mechanism: defaults reviewed against a user-journey list; completion generated from the command registry.
16. One-command experience: install, browser UI opens, or headless config; Apple-like simplicity. Evidence: s07 2026-10-01T02:40, 2026-09-12T15:33. P0. Mechanism: first-run journey (install to merge-ready PR under 10 minutes) as a release gate.
17. Install-first README; extra material collapsed. Evidence: s06 2026-08-05T14:42; s01 2026-01-23T21:24 "too clumsy". P0. Mechanism: README test asserting the first section is install; activation funnel metric.
18. Truthful onboarding on stock macOS (verify.sh on bash 3.2; doctor never "ok" when verification is unavailable; preflight fails closed). Evidence: s06 2026-08-04T20:11, 22:59. P1. Mechanism: installed-tarball acceptance on stock bash 3.2; doctor derived from the same probes as help.
19. Mass issue pickup with PRs on VERIFIED as a first-class command. Evidence: s08 2026-10-08T04:25, 2026-10-20T13:43; DEC D51. P1. Mechanism: single command covered by a fixture-repo E2E.
20. Real-user repo shapes break the last mile (tracked .loki files; partial clone push; Wall test not in the PR diff). Evidence: s08 2026-10-18T20:32, 2026-10-19T17:27. P0. Mechanism: intake owns .loki runtime files; last-mile matrix (full clone, partial clone, fork-only, no push); PR assembly guard.
21. Loki's own state leaked into the next run (stacked on an unmerged loki branch, user untracked files committed, empty branch left checked out). Evidence: FC Family F (FC-15, FC-42, FC-STACKED-ON-LOKI-RUN, FC-COMMIT-STAGES-USER-UNTRACKED, FC-EMPTY-RUN-BRANCH-LEFT-CHECKED-OUT). P1. Mechanism: run base ledger by SHA consulted by intake, staging, publish and base choice.
22. Engine Laws L0 to L7 are the durable product learning (model decides, harness proves; never below raw; fail closed on trust, open on work; evidence over heuristics; Project Model; every failure has an owner; every run terminates; outputs are contracts). Evidence: DEC D86, ENGINE-LAWS.md. P1. Mechanism: Parity Gate against raw claude -p blocking latest; static checks for destructive calls and test spawning outside the Project Model.
23. Brownfield and issue mode without a PRD; sync-back not partial. Evidence: s02 2026-02-14T04:16, 04:22. P2. Mechanism: issue mode as a primary tested path with sync-back receipts.
24. Provider breadth with real local models (Ollama, cline, aider); provider conformance; a fifth provider broke main for three releases. Evidence: s02 2026-03-01T05:44, 2026-03-04T16:16; s01 2026-02-07T00:51 "Unknown provider: ollama"; memB project-opencode-broke-main-3-releases. P1. Mechanism: provider-matrix CI lane and conformance suite.
25. Memory as a differentiator, better than Claude Code's own. Evidence: s04 2026-05-22T17:34, 2026-05-27T23:41. P1. Mechanism: memory eval benchmark with before and after.
26. Telemetry default-on with disclosure; shipped text said OFF. Evidence: s04 2026-05-30T01:44, 2026-06-20T16:23; s02 2026-02-14T01:37. P1. Mechanism: founder decisions as testable policy flags with a guard.
27. Self-healing vision: chat and preview read logs and fix breakage; docker compose as default runtime. Evidence: s04 2026-03-22T18:35, 2026-03-21T20:36; s05 2026-07-10T16:42. P1. Mechanism: log-watching healer loop behind a verification gate.
28. Enterprise requirements: cross-repo with combined endpoint evidence, million-line repos, Docker, ECS, Kubernetes, teams, SSO, Slack, Teams, Outlook, Jira, Linear, Bitbucket, Azure DevOps, Windows, hosted option. Evidence: s07 2026-10-01T02:40, 2026-09-15T14:28, 2026-10-04T01:23. P0. Mechanism: enterprise readiness checklist with owner and acceptance journey per item.
29. Control Plane direction: lean like claude.ai, old dashboard look, stateless and horizontally scalable, history, sessions, PR and issue status; not a vibe-coding chat box. Evidence: s07 2026-10-01T15:45, 2026-10-03T15:16, 22:03. P1. Mechanism: design system from old dashboard tokens; UX reviewer seat; screenshot regression.
30. Remove legacy and dead surfaces; nothing dummy. Evidence: s07 2026-10-01T17:15, 2026-10-03T17:48, 19:33; DEC D57. P1. Mechanism: deletion slices with a reference-grep guard; deprecation ledger.
31. Show users measured betterment over plain Claude Code. Evidence: s07 2026-10-08T02:14, 2026-09-27T17:02. P0. Mechanism: each release note includes one measured user-visible delta versus a claude -p baseline.
32. Speed versus depth: opt-in fast pass must disclose reduced gates and never claim VERIFIED. Evidence: s06 2026-08-10T14:55. P1. Mechanism: depth label stamped on receipts; verifier refuses to upgrade it.
33. Outcome Ledger and Intent Graph chosen as differentiators; receipts are scaffolding, not identity. Evidence: s06 2026-08-06T18:15, 2026-08-03T09:13. P1. Mechanism: Outcome Ledger as the single metrics store feeding ROI and scorecards.
34. New packages need Makefile, CI, docs and rollback wiring (feedback-loop package absent from CI). Evidence: s06 2026-08-04T23:51. P1. Mechanism: structural guard failing when a package has no CI registration.
35. Hostile-input and privacy bar for artifact writers. Evidence: s06 2026-08-10T15:01, 17:49. P2. Mechanism: shared fixture with hostile names, secret canaries and an absolute-path canary.
36. Website standard: modern, real time with repo docs, SEO, llms.txt, one font, link checks, clickable navigation. Evidence: s02 2026-02-15T05:43, 06:00, 06:58; s03 2026-03-19T02:20; s07 2026-09-25T17:43. P2. Mechanism: docs and blog generated from repo markdown; nav smoke test; one font token.
37. UX defects reported one at a time (refresh confirm, tiny fonts, raw markdown, missing Expo QR, delete and rename and clone missing, auto-scroll, collapsing long prompts, multiple choice not proceeding). Evidence: s04 2026-03-21 to 2026-06-21, 10 or more; s05 2026-07-17T19:23, 00:28. P2. Mechanism: UI QA seat with screenshot diff and a UX scorecard per release.
38. Agents should coordinate like people in a room, event-driven. Evidence: s04 2026-04-18T22:44. P2. Mechanism: event bus with role subscriptions.
39. External integrations each need an owner and an integration test or removal. Evidence: s04 2026-04-06T01:49 repowise, 2026-04-18T19:13, 2026-05-04T00:08, 2026-05-22T17:39. P2. Mechanism: adopt-OSS-first with integration tests.
40. Adopt OSS and reuse; harness judged by reuse and intent; prompt ablation (LOKI_SIMPLE=1, minus 78 percent prompt); generic model tiers. Evidence: memB feedback-adopt-oss-never-reinvent, project-prompt-ablation-program, project-generic-model-tier-convention. P2. Mechanism: OSS check in the Architect template; ablation before adding prompt text.
41. Hooks must be transparent and opt-in. Evidence: s01 2026-02-04T03:41, 03:42. P1. Mechanism: hook inventory and a visible status listing active hooks.
42. Skill packaging limits (SKILL.md size and structure). Evidence: s00 2026-01-06T17:01. P2. Mechanism: CI check on SKILL.md structure and the 500-line cap.
43. Browser console errors in generated apps must be caught before handoff. Evidence: s00 2026-01-10T16:18. P2. Mechanism: headless console-clean gate.
44. autonomi-saas basics: delete, rename, clone, timeline, activity log, upfront cost estimate, per-project task board. Evidence: s04 2026-06-21T19:18 to 19:22. P2. Mechanism: parked with autonomi-saas; reopen only with the shared engine contract tested.

### 3.7 Strategy and market

1. Money and adoption are the goal; OSS adoption is poor; Loki is seen as "another CLI wrapper". Evidence: s00 2026-01-08T03:55; s04 2026-05-27T18:04, 2026-06-09T18:26; s05 2026-06-30T15:27, 2026-07-15T21:35. P0. Mechanism: activation funnel (install, first loki start, first verified outcome) owned by a growth seat; revenue ladder across OSS CLI, Cloud and Enterprise.
2. One wedge was never held steady; strategy was reactive comparison. Evidence: s01 ten competitor rounds; DEC eight reframings in eight days. P0. Mechanism: one strategy page with one north-star metric reviewed weekly; scope changes name what they supersede and drop.
3. The defensible wedge is persisted, portable, diff-bound, signed evidence, not "competitors do not verify". Evidence: memA, memB feedback-research-is-not-telemetry, project-autonomi-verify-wedge, project-exogenous-gates-are-the-real-moat (4 of 8 gates agent-independent). P1. Mechanism: positioning claims carry a fetched source and date; quarterly re-fetch; moat register owned by the CTO.
4. Verify-only was not convincing to the founder (hundreds of review companies); focus on non-verification user value as well. Evidence: s05 2026-07-13T03:54, 04:03, 2026-07-31T22:28. P1. Mechanism: roadmap rows state the competitor advantage they close.
5. Platform risk: Anthropic is both the dependency and the largest competitor. Evidence: COMP Claude Code above $2.5B run rate (February 2026, secondary). P1. Mechanism: quarterly platform-overlap review against Claude Code release notes.
6. Ride competitors' distribution: verification callable from Cursor, Codex and Claude Code. Evidence: COMP Cursor and Codex entries. P1. Mechanism: Autonomi Verify as MCP and CLI check, tested against each host in CI.
7. Brand hierarchy: Autonomi the company, Loki Mode the OSS CLI and engine, Autonomi Cloud for greenfield and brownfield, AaaS, "spec" not only PRD. Evidence: s02 2026-02-15T03:36, 05:26; s04 2026-06-09T19:35, 2026-04-30T02:32, 02:42. P1. Mechanism: canonical positioning file and terminology lint.
8. Naming churn wasted cycles (LOOP, loki-loop reverted within 40 minutes). Evidence: s00 2026-01-11T04:36; s01 2026-01-24T04:36, 05:13. P2. Mechanism: name availability check before any rename; single source for names and URLs.
9. Decisions reversed without supersede links (VS Code extension, Gemini, telemetry). Evidence: s04 2026-04-25T04:16 versus 2026-06-15T23:14. P2. Mechanism: decision log with supersede links; CTO reviews reversals.
10. Tech-stack migration to Bun and TypeScript kept npm users and tagged the bash state; Bun postinstall trust was too complex. Evidence: s04 2026-04-25T14:23, 2026-04-26T19:32, 23:01. P1. Mechanism: one-command install per manager with installer-path tests.
11. v8 Agent SDK rewrite consumed weeks; stay within 7 days of the Anthropic SDK with exact pins. Evidence: s05 2026-07-13T06:30, 2026-07-14T02:39; memA, memB feedback-anthropic-sdk-one-week-freshness (2026-10-23). P1. Mechanism: weekly job opening a P1 slice when a pin is older than 7 days.
12. Model-agnostic: rip out outdated harness text and skills as models improve; cheapest capable model. Evidence: s07 2026-09-12T15:33, 2026-09-25T20:15, 2026-10-01T02:34. P0. Mechanism: quarterly harness prune by ablation.
13. Harness should equalize models (Haiku first-iteration parity; 15-minute 5-iteration PRD to 5 minutes and 1 iteration). Evidence: s05 2026-07-16T13:56, 2026-07-28T15:54, 2026-07-31T15:55. P0. Mechanism: model-equivalence benchmark nightly with first-iteration pass rate per tier.
14. Cheaper and faster than raw Claude Code: at most half price and half time. Evidence: s08 2026-10-08T04:50, 15:38; s07 2026-09-27T23:31 v10 about 2x raw per task, target $0.2363 per completed task. P0. Mechanism: standing head-to-head benchmark per release; marketing claims blocked unless measured.
15. Competitors named across the year: Auto-Claude, Cursor, Zencoder, Conductor, MetaGPT, Devin and Cognition, CrewAI, claude-flow, BMAD, OpenClaw, get-shit-done, Replit, Lovable, Bolt, Emergent, Rork, Factory, 8090, Vorflux, ona, Claude Code, Codex. Evidence: s00 to s08. P1. Mechanism: living competitor matrix with dated primary sources, refreshed weekly by a research seat; corpora indexed once.
16. Weekly honest public content tied to releases (blog, docs, LinkedIn, Discord, dev.to) with images; truthful and critical, not marketing. Evidence: s02 ten "complete the exercise" prompts; s05 2026-07-08T20:17 images dropped; s06 2026-08-07T03:20; s07 2026-09-27T17:02. P1. Mechanism: comms seat triggered by each release, gated by the claim registry and a link checker.
17. Distribution funnel and CRM were missing. Evidence: s02 2026-03-07T17:08 "nothing I believe". P2. Mechanism: growth seat reporting visits, signups, installs and activations.
18. Enterprise path: brownfield agents as a service, greenfield SaaS, Evidence Receipt as a plug-in stage, license transition. Evidence: s05 2026-06-29T16:58, 2026-07-16T00:45; s03 2026-03-19T16:50. P1. Mechanism: one strategy doc; canonical license fact file.
19. autonomi-saas kept in a separate proprietary repo; parked 2026-07-24. Evidence: s04 2026-06-20T23:27; s05 2026-07-24T15:08. P1. Mechanism: separate team and board only after the engine passes the parity gate.
20. Founder's time is constrained (Disney principal); the company must run without him except for credentials, browser auth and approvals. Evidence: s04 2026-06-15T20:35, 2026-06-04T05:29. P1. Mechanism: founder queue limited to those items with exact instructions prepared.
21. Revenue and ROI reality checks after two months and after a year. Evidence: s02 2026-02-18T23:33, 2026-02-19T02:34; s08 2026-10-23T16:25. P0. Mechanism: weekly revenue, pipeline and ROI page.
22. Telemetry metrics cited publicly need a data source (70k sessions weekly). Evidence: s02 2026-03-02T04:02. P2. Mechanism: every published metric cites its source.
23. Urgency: competitors scaled by billions; target about one week. Evidence: s08 2026-10-23T16:25, 2026-10-08T19:54. P0. Mechanism: one-week plan with daily CEO milestones; freeze nonessential work.
24. Public benchmark claims: official SWE-bench closed to OSS frameworks; claim only what exists. Evidence: s04 2026-06-09T13:59, 15:06. P1. Mechanism: claims register reviewed before each post.
25. Frontier-lab lessons as gap checks: cheaper surfaces first (retrieval, skills, prompts, routing) before loops; each verifier must show marginal lift above its latency and cost by matched ablation. Evidence: s06 2026-08-04T06:48 and seven repeats. P1. Mechanism: stored proposal template (baseline, candidate, criteria, caps, canary, rollback).
26. Product vision: factory-style lifecycle to production via CLI, web and later a macOS app, on one engine. Evidence: s06 2026-08-04T19:12, 2026-08-08T19:34, 2026-08-04T20:06. P1. Mechanism: vision doc with Wall checks per lifecycle stage.

### 3.8 Cost and ROI

1. No per-agent or per-slice cost ledger existed all year; cost visible only on request. Evidence: s00 2026-01-10T16:20; s01 2026-02-12T05:58; s07 2026-09-12T15:33 "I'm paying $200 every month"; GIT PROGRESS.md 2026-09-28T22:19Z weekly 48,901,928 output tokens, uncalibrated. P0. Mechanism: per-agent token and dollar ledger per slice and per release on the CEO console.
2. Fanout collapse and credit exhaustion. Evidence: s04 2026-06-21T20:13, 20:26; s05 2026-07-10T06:10; s08 2026-10-09T02:46. P0. Mechanism: budget governor with per-agent caps, scheduled resume at limit reset, handoff updated each landing.
3. Opus share must be audited; founder asked whether non-advisors ran Opus. Evidence: s07 2026-09-28T02:01; DEC D98 50 percent versus the 30 percent budget, which originates in D13. P1. Mechanism: per-agent model audit in the pulse.
4. Operate within the Claude account's real limits (about 10 percent of limit for large work). Evidence: s07 2026-10-01T03:11, 03:10, 2026-10-04T01:23; usage-readings.tsv. P0. Mechanism: usage governor reading usage-readings.tsv and setting the seat cap mechanically.
5. Cost governance was reset at least six times, each ending in "sprint, ignore the limit"; D103 ruled cost irrelevant on the Max plan while load and memory are the limit. Evidence: DEC D39, D52, D65, D87, D103, D108; memB founder-full-decision-grant. P1. Mechanism: one cost policy with load and quota as hard limits; paid-run use logged per LOKI_BENCH_SPEND_APPROVED.
6. Effort mix: test and infra effort many times product effort. Evidence: s05 2026-07-28T14:00. P1. Mechanism: weekly effort-mix metric with a cap.
7. Cost not proven and accuracy below raw; measurement errors (1.81x reported versus 12.3x ledger). Run4 overall ratio 1.114, CI [0.755, 1.531], NOT PROVEN; acceptance Loki 18/24 versus raw 23/24; 1.415x applies only to the 6 working tasks. Evidence: memory/project-cf1-cost-eval-1-81x.md line 27; GIT PROGRESS.md 2026-10-16T21:35Z. P0. Mechanism: cost eval records env, runs a positive control, emits INVALID when identity variables drop.
8. Product cost estimate finalized only at the end. Evidence: s04 2026-06-21T19:22. P1. Mechanism: upfront estimate before spend.
9. Partial cost readable as complete in sibling consumers. Evidence: FC-COST-PARTIAL, FC-COST-PARTIAL-b. P2. Mechanism: one cost reader returning amount and a complete flag.
10. Salary-based ROI: levels.fyi Anthropic SWE (snapshot 2026-09-24) entry $483K, Senior $621K, Lead $865K, Staff $1.41M, median about $883K; Research Scientist median about $827K to $875K (UNVERIFIED: WebSearch snapshot, page not fetched); the claimed 10 to 15 percent drift between snapshots is UNVERIFIED; Research Engineer NOT FOUND; overhead multiplier 1.25 is an assumption. Evidence: COMP WebFetch of levels.fyi for the SWE figures (page updated 2026-09-24); COMP WebSearch for the Research Scientist figures. P0. Mechanism: versioned SALARY-BASIS.tsv with level, comp, URL and snapshot date; ROI computed as value of delivered work at blended rate minus agent spend; flag rates older than 90 days.

### 3.9 Tooling and infrastructure

1. Secrets were pasted in chat repeatedly (npm, Docker Hub, GitHub PAT, Azure PAT, Google key, Slack, PyPI, LinkedIn, PostHog, getlate, Slack webhook). Evidence: s01 six times; s02 at least six; s04 five; s07 2026-10-01T03:03. P0. Mechanism: secrets only via gh secret or keychain; agents refuse to persist pasted secrets; transcript scrubber and rotation.
2. Child env must be deny-by-default; every env builder deleting its own subset re-leaked tokens. Evidence: FC Family D (FC-40, FC-69, FC-90, FC-PROVIDER-VERSION-PROBE-FULL-ENV); GUARDS 23. P0. Mechanism: one env constructor; full_env_spawn_guard baseline to zero; planted-credential fixtures per spawn site.
3. Test environment fragility (5-second bun timeouts, SIGPIPE under pipefail, ambient TMPDIR, FORCE_COLOR, ports, minimal PATH, Python 3.10 and 3.11). Evidence: FC Family B (7-row timeout chain, 3-row SIGPIPE chain); s06 2026-08-04T06:24, 2026-08-10T13:48. P1. Mechanism: ban instead of ratchet; one subprocess test helper owning env, timeout and cwd; local CI under exact CI env.
4. Hand-kept lists drift (help, completions, routes, changelog, allowlists, shard watchlists); repo-wide guards red after merges. Evidence: FC Family C (help drift 7 rows, repo-wide red 10 rows). P1. Mechanism: one command registry generating help, completions and routes; repo-wide guards run on the merged union at release.
5. Controls claimed to exist were unwired (release gate, core.bare watcher). Evidence: s06 2026-08-03T11:23. P1. Mechanism: canary test per guard proving it fires, listed in GUARDS.md.
6. Flaky tests: rerun the identical SHA before editing another author's assertion; never rerun a release on red. Evidence: memA feedback-rerun-before-editing-a-flaky-test, feedback-review-assurance-tail-is-load-flaky. P2. Mechanism: bounded waits on pid files; flake registry auto-rerunning once.
7. Infra self-inflicted failures: pytest -n auto race, load 136, kind cluster, 12.5-hour orphan test, gitleaks full-history cancelled at 15 minutes, pre-push full pytest over 10 minutes, relative hook paths, sandbox-exec tcp versus tcp4. Evidence: DEC D24, D25, D28, D74, FOUNDER-QUEUE row 13. P1. Mechanism: machine-health pulse; hooks using $CLAUDE_PROJECT_DIR; incremental gitleaks.
8. Disk bloat and stale workflows. Evidence: s07 2026-09-27T13:15 112 worktrees and 20 GB, 2026-10-03T19:23, 19:36. P1. Mechanism: worktree cap; workflow inventory with owner and last meaningful run.
9. Doctor and install hygiene (broken provider symlinks, unsigned receipts, MCP registry publish). Evidence: s07 2026-09-12T21:25, 2026-09-14T14:55. P2. Mechanism: doctor auto-repair; registry publish in the pipeline.
10. Run anywhere: Claude Code cloud for the factory, Docker, ECS, Kubernetes; logs mounted to host. Evidence: s07 2026-09-28T17:35; s05 2026-07-17T14:52, 2026-07-05T00:05. P2. Mechanism: scripted cloud routine for the leader loop; compose stack with log volumes.
11. Session and tool failures (dropped sessions, advisor tool 400 errors, SSL expiry, wrong-window prompts). Evidence: s05 2026-07-03T19:09, 2026-07-25T14:42, 2026-08-01T22:57; s01 2026-01-24T16:37, 2026-02-09T04:52. P1. Mechanism: durable state files so any session resumes; one window per workstream with the product named.
12. Session and credit limits hit repeatedly; cron or loop auto-resume. Evidence: s04 2026-06-10T04:47, 2026-06-21T20:13. P0. Mechanism: credit-aware scheduler with daily budgets and scheduled resume.
13. Tests headless, never opening browser tabs; strict tsc -b before container builds; worktree builds delete dist; symlinked node_modules escape maps; secrets.* in if: kills a workflow. Evidence: memB feedback-tests-headless-no-browser, feedback-web-prod-build-strict-tsc, feedback-worktree-build-deletes-dist, feedback-symlinked-node-modules-escaping-maps, feedback-secrets-context-in-if-kills-workflow. P1. Mechanism: LOKI_NO_BROWSER default; CI lint for secrets.* in if:; dist backup in worktrees.
14. A hanging push is usually the pre-push hook; a green gate covers only the tree it ran on; verify the branch after "Everything up-to-date". Evidence: memA, memB feedback-repo-config-identity-blocks-push, feedback-green-gate-can-be-stale, feedback-verify-branch-before-trusting-push. P1. Mechanism: record tree SHA at gate time and refuse push if HEAD differs; hook prints progress.
15. UI library unit contracts (react-resizable-panels numeric size is pixels); container serves a baked build. Evidence: memA feedback-resizable-panels-numeric-px. P2. Mechanism: wrapper requiring string units; geometry assertion in web E2E.
16. Off-topic infrastructure questions (Disney DXCP cluster lookups) landed in the Loki session. Evidence: s08 2026-10-08T19:07 to 19:12. P2. Mechanism: global rule already added; route off-topic asks away from project sessions.
17. Side projects consumed founder time (loki-nana, OpenClaw OAuth and docker issues). Evidence: s02 2026-02-13T06:02, 2026-02-22T17:47. P2. Mechanism: non-core projects need CEO approval and a time box.

---

## 4. Founder goals and every unresolved ask

### 4.1 Founder goals (deduplicated, earliest dated source cited)

1. Make Loki Mode a real, sellable product and Autonomi a company: product-led growth plus enterprise, quick revenue, build to exit (s00 2026-01-08T03:55); a "100 million viral product" with FOMO (s04 2026-05-27T18:04); Autonomi as umbrella, Loki Mode as flagship, commercialize before 2030 (s01 2026-01-24T04:41).
2. Best autonomous spec-to-production system: PRD, issue, repo or one-liner to a running, deployed product, greenfield and brownfield, any size up to million-line modernization (s01 2026-02-07T01:01; DEC D30).
3. Beat Replit, Lovable, Bolt, Emergent, Devin, Cursor, Factory, 8090, Vorflux and raw Claude Code: 2x, then 10x, 10/10 in every category and 100x user experience, measurably (s04 2026-06-09T18:26; s06 2026-08-04T19:12; s08 2026-10-23T04:13).
4. Cost and time per task at most half of raw Claude Code with equal or better accuracy (s08 2026-10-08T15:38; DEC D91 item 11).
5. Harness equalizes models: Haiku or small models pass in the first iteration (s05 2026-07-16T13:56).
6. Zero hallucination and zero mis-anything, Anthropic or OpenAI grade (s00; s08 2026-10-19T17:18).
7. Full autonomy: an agent company that decides on the founder's behalf, never idle, never waiting (s00 2025-12-29T03:31 to s08 2026-10-23T16:25).
8. Release velocity: every cycle ends in a release (s00 2026-01-05T03:18), escalating to 30 to 60 per day and 3 to 6 per hour, workflows under 2 minutes (s07 2026-09-30T17:34; s08 2026-10-08T18:46).
9. Every release on every channel with docs, wiki, website, blog, LinkedIn and Discord synced (s01 2026-01-25T01:16; s03).
10. Real-time dashboard and one controllable session across CLI, dashboard and API (s00 2026-01-05T01:34; s01 2026-02-07T15:22); enterprise Control Plane later (DEC D83).
11. Zero-friction adoption: install-first, one command, a million users, 10k stars (s05 2026-07-15T21:35, 2026-07-29T02:49).
12. Enterprise grade: security, sandboxing, audit, RBAC, SSO, integrations, Kubernetes (s01 2026-02-12T22:27; s07 2026-10-01T02:40).
13. Always know cost, tokens and ROI, with salary-based accounting (s01 2026-02-12T05:58; s08 2026-10-23T16:25).
14. A local workstation web app to monitor and manage the whole company (s08 2026-10-23T16:25).
15. A 10-seat agent company with a Chief of Staff, the best CTO, and researcher-engineers at distinguished fellow level (s08 2026-10-23T16:25).
16. Success within about one week; everything else released and parked (s08 2026-10-23T16:25).
17. Stay within 7 days of Anthropic SDKs; Opus advisor, Sonnet engineer, Haiku for small work (memB; s07 2026-10-07).
18. Order when goals conflict: moat, Seal accuracy, delivered accuracy, cost, speed (OPERATING-MODEL.md).

### 4.2 Every unresolved ask, by period

December 2025 to January 2026 (s00):
1. Dashboard showing real live agents and tasks, last seen "why does it have all dummy data?" (2026-01-22T01:05).
2. Answers or features for a colleague's questions: monitor all spawns, interrupt agents with input, manage code conflicts (2026-01-22T00:42).
3. Official SWE-bench result; run killed after 12 hours (2026-01-06T16:55).
4. Full end-to-end demo video of run.sh, board and browser (2026-01-06T20:46; re-record 2026-01-19T20:51).
5. CPU and memory monitoring acted on every 5 minutes (2026-01-05T03:18).
6. Product launch details and CrewAI founder outreach outcome (2026-01-19T05:41, 2026-01-20T04:20).
7. Scientific-paper research sweep (2026-01-06T17:25).
8. Confirmation that v4.0.0 deployment and changelog were live (2026-01-22T02:49).

January to February 2026 (s01):
9. Agents strictly follow CLAUDE.md every prompt, with an enforcement mechanism (2026-02-07T23:48).
10. Security P0s (zero-auth dashboard, sandbox.sh injection, Docker as root) and OpenClaw sidecar (2026-02-12T22:27).
11. Autonomi runtime with real containers, Ollama with custom model, Loki bridge, trigger engine, guardrails, kill switch (2026-02-05 to 2026-02-07).
12. Always-visible cost and token usage (2026-02-12T05:58).
13. Every dashboard panel functional with real data (2026-02-06T00:01).
14. WhatsApp and OpenClaw workflow to production (loki-nana).
15. Docker Hub listing logo and overview (2026-02-01T19:58).
16. Stop wrong-chat prompting and recover prior chat context (2026-01-24T16:38, 2026-02-04T03:38).
17. Definition of done for demos and template PRDs from examples/ (2026-02-07T17:35).

February to March 2026 (s02):
18. Codebase knowledge graph and vector store (2026-02-25T16:56 to 17:20).
19. loki remote workspace-trust error at v6.12.2 (2026-03-07T20:19).
20. Direct LinkedIn API approval (2026-02-22T02:31, 2026-03-06T18:08).
21. Auto-update of the website from repo releases, deferred to an issue (2026-02-16T02:31).
22. Reddit app setup (2026-02-24T05:30).
23. PRD checklist in the dashboard, phase 4 and later (2026-02-16T02:43).
24. Remaining honest gaps from the E2E classification (2026-03-04T16:27, 2026-03-07T15:42).

March 2026 (s03):
25. Purple Lab as a hosted Replit or Lovable class IDE with model-decided previews (2026-03-20); dev server crash and "shows running but not running" (2026-03-20T21:07, 2026-03-21T05:29).
26. Real-time README traction (2026-03-20T19:28).
27. Table of tested, remaining and untested items (2026-03-21T04:20).
28. Confirmation every release from 6.12.0 to 6.4x was E2E tested for CLI, dashboard and Purple Lab (2026-03-19T05:03, 23:42).
29. Completion of "complete all remaining items" (2026-03-20, 2026-03-21).
30. Per-project stop, pause, resume and hover tooltips in Purple Lab (2026-03-20T19:40).
31. Enterprise feature docs completeness (2026-03-19T15:02).
32. Blogs, use cases and diagrams for Purple Lab updates (2026-03-20T15:51).

March to June 2026 (s04):
33. Replit-class landing page with character and a mascot (2026-06-21T03:33, 05:40).
34. autonomi-saas delete, rename, clone, timeline, activity log, cost estimate, task board (2026-06-21T19:18 to 19:22).
35. autonomi-saas port isolation, preview proxy and no-500 runtime health; builds hanging in Planning (2026-06-21T21:41, 22:11).
36. docs/PLATFORM-ROADMAP.md honest inventory (2026-06-21T22:04).
37. Full recorded demo of every feature with walkthrough and speaker notes (2026-06-04T04:34).
38. Memory system better than competitors (2026-05-27T23:41).
39. Telemetry default-on with privacy disclosure (2026-05-30T01:44, 2026-06-20T16:23).
40. Loki VaaS as a separate product (2026-06-12T00:20).
41. Merge duplicate commands into workflows (2026-06-10T13:45).
42. Dashboard markdown rendering and the 100 or more UI enhancements (2026-03-24T07:06, 2026-06-20).
43. Task detail in dashboard tasks (three raises).
44. loki stop scoped to the current session; dashboard Stop actually stops (2026-05-29).
45. Predicted 2x-better-than-Replit set and a regular full status table (2026-06-09T18:26, 2026-06-21T16:13).
46. Antigravity CLI support (2026-05-22T17:33).
47. Resume after weekly credit reset using the handoff doc (2026-06-21T20:13).

June to August 2026 (s05):
48. autonomi-saas fast preview, conversational chat on failed builds, always-on steering, auto-resume (paused 2026-07-24).
49. Real TUI screenshot and a multi-repo cockpit (2026-07-09).
50. Powered benchmark (24 or more trials) with honesty and design-quality metrics (2026-07-16).
51. Provider-agnostic support via OpenRouter, Ollama and open models (2026-07-16, 2026-07-31).
52. Stars from 1k to 10k (2026-07-29).
53. 100-feature list at 10 per hour for dashboard, CLI and enterprise deployment (2026-07-31).
54. 25-blog, docs, Discord and LinkedIn run for v8 and v9; "okay, all done?" unanswered (2026-08-03).
55. Linux CI P0 (stale-install warning, trust-core rc=67) and the 2,894-process recursion (2026-08-03T07:06).
56. 10 competitor-advantage features per hour unrelated to verification (2026-07-31).
57. CEO, CTO and CMO elite personas, v5 design directive, scale-path load test (2026-07-17).

August 2026 (s06):
58. Distribution-ready repository cleanup audit (2026-08-03T14:39).
59. Top 10 features versus Factory, 8090 and Devin; only the Outcome Ledger started (2026-08-06T17:29).
60. All competitor-derived features including ona learnings and dashboard updates (2026-08-07T13:23).
61. Weekly launch exercise (2026-08-07T03:20).
62. Tables of what shipped rated per competitor (2026-08-07T03:06, 2026-08-06T14:37).
63. GitHub workflow failures fixed or replaced (2026-08-06T15:17).
64. Explanation of the "what non sense is this" screenshot (2026-08-06T23:10).
65. Why CLAUDE.md cadence was not followed (2026-08-10T04:00).
66. Recovery of Tests run 31391896826 at b14cb5c4 (2026-08-10T13:48).
67. Nana blockers: CP-1 export overwrite hang, Bash and Bun parity unbound array, telemetry disclosure 7/10, MAC-VERIFY-01 integration, exact-SHA CI, package and install smoke, release promotion (2026-08-04T23:24).

September to early October 2026 (s07):
68. 3 to 6 releases per hour sustained, and 10/10 on all competitor categories (2026-09-30, 2026-10-01, 2026-10-03).
69. FireLater#17 reaching VERIFIED and a published scoreboard versus plain claude -p (2026-10-04).
70. augmentiq runs that stalled for hours; runs taking 17 minutes to 10 hours with nothing done (2026-09-28, 2026-10-01).
71. Dashboard 404 and dashboard_frontend_not_found verified fixed (2026-10-01, 2026-10-03).
72. User-perspective diagram HTML with walkthroughs for users, engineers, architects and executives (2026-10-02).
73. Next 10 releases with 100x value in user terms (2026-10-08).
74. Multi-user teams, hosted runner, Jira and Linear write-back, Bitbucket and Azure DevOps, open models, Windows, public honest benchmark (2026-10-04).
75. Blinded poll of enterprises and founders rating Loki (2026-09-25).
76. Confirmed fix of Claude Code sessions terminated by Loki runs (2026-09-26).
77. Slack notification check and git PAT or GitHub connector in the UI (2026-10-01).
78. Run on any user-selected branch (2026-10-03).
79. LinkedIn post scheduled for Wednesday and the Addy reply (2026-09-28, 2026-10-05).

October 2026 (s08, DEC, memA, memB, GIT, FC, COMP):
80. Reconcile "one minor release with all fixes" versus "multiple releases per hour" (2026-10-08T02:19, 2026-10-19T15:30, 2026-10-09T02:57).
81. Decision on a GitHub Security Advisory for past token exposure (2026-10-09T00:24).
82. 40x efficiency in 12 hours (2026-10-08T04:54).
83. Proof of half the cost and half the time of Claude Code (2026-10-08T15:38).
84. Implement every Anthropic platform-doc capability (advisor, memory, effort, tools, orchestration), found exhaustively (2026-10-22T16:41, 17:12).
85. Top 10 upcoming releases and honest ranking after they ship (2026-10-23T05:33).
86. PR for VERIFIED #81826 upstream, blocked by the collaborator policy; only the fork PR exists (2026-10-20T01:17).
87. Roadmap implementation via "work on roadmap" and the duplicate-code merge (2026-10-17T14:57, 2026-10-15T13:22).
88. Mobile notification monitor for claude-code issue 81826 (2026-10-19T13:28).
89. CEO console web app, 10-seat roster and salary-based ROI ledger (2026-10-23T16:25).
90. Instrument making 100x measurable on demand (memA 2026-10-23).
91. Ready queue 7 against 30 and PROGRESS.md 5,210 minutes stale (pulse 2026-10-23T16:30Z).
92. Release cadence and merged-unreleased age UNKNOWN in pulse because v11.18.0 local tag disagrees with npm next (11.71.1 at reader time, 11.72.0 at 2026-10-23T16:44Z).
93. Automated 7-day SDK freshness enforcement.
94. Recorded final ruling on "no testing, velocity" versus CI publish gating, and a list of superseded memories.
95. Codex tier decision (Tier 3 degraded or raised).
96. Working droid headless login for a valid measurement.
97. FOUNDER-QUEUE rows 1 and 5: six leftover stash files and five older stashes.
98. Row 2: a cheap-model key (DeepSeek, OpenRouter or MiniMax) in the loop environment.
99. Row 4: SOC 2, sales motion, Claude Marketplace partner application, GitHub and GitLab partnerships, pricing.
100. Row 6: `sudo xcodebuild -license accept` (likely moot after S-61).
101. Row 7: license choice for loki-seal and core; remove the "independent reimplementation" notice; CLA to DCO.
102. Rows 8, 9, 10, 12: public loki-seal repo, plugin directory submission, GitHub About and topics, tagline veto, one outside-user relaunch post.
103. Row 11: opt-in first-run telemetry decision.
104. Row 15: real-provider first-run gate on published next with a token; D86 item 6 real-model legs.
105. Row 16: Slack incoming webhook as LOKI_SLACK_WEBHOOK_URL.
106. Row 18: screenshot veto for the 10.8.0 Control Plane (ground color #F1F2F6 and legacy mascot).
107. Row 21: enable GitHub private vulnerability reporting.
108. Rows 19 and 20: CoS-decided defaults awaiting founder confirmation.
109. D89 item 10: shape-level parity evidence (B9 covers about 5 of 14 repo shapes).
110. D73: D61-12 integrator redesign not shipped.
111. D99 C-F5, C-F6, C-F7: hosted Company OS, enterprise commitments, comparative external pilot, deferred until cost at most 0.5x raw.
112. D107, D109, D110 field evidence lines.
113. Proposed Engine Law L8 "tests never touch real user state" (FC-07).
114. A repeatable FC family clustering (family tag per row) and a full per-guard text search.
115. Full count of deprecated npm versions across all 1,129 (2026-10-23T16:44Z).
116. Authoritative FC row count from one parser.
117. Classification of the 29 percent of commits without a conventional prefix.
118. Fresh adoption reading (last dated 2026-09-25).
119. Seal false-SEALED and false-NOT-SEALED rates, cost per sealed change, human touches per change (n=0).
120. Confirmation of competitor figures: Cognition $48B Series E, Factory $5B round and pricing, Cursor and SpaceX close date and $4B ARR, Claude Code run rate after February 2026, Codex revenue and 5M weekly users, Anthropic Research Engineer comp, any agent-org product comparator, and the 1.25 overhead multiplier.
121. About half of the memory corpus was never read in full: memA read 126 of 252 files (files 1 to 32 mostly through MEMORY.md index lines) and memB read only file heads (about 1,800 to 2,300 characters each, 387,800 bytes total). A full read of all 252 files is owed.
122. Scratch files (h.txt, fam.awk) left in the macOS TMPDIR by the FC reader.

---

## 5. Competitive position

Confidence key: PRIMARY is a company page; SECONDARY is two or more aggregators; SINGLE is one source and is UNVERIFIED. All from COMP research on 2026-10-23.

1. Cognition (Devin, Windsurf). Series D over $1B at $26B post, May 27 2026, about $492M run rate (SECONDARY: dealroom.co, pulse2.com). Series E over $2B at $48B and $1B run rate, September 2026 (SINGLE, UNVERIFIED). Devin ARR $73M by June 2025 (SECONDARY). Windsurf acquired July 2025. Pricing (PRIMARY, cognition.com blog 2026-04-14): Free, Pro $20, Max $200 per month, Teams usage-based with an $80 minimum, Enterprise custom. Ships what Loki does not: hosted multi-session cloud agents with self-serve billing; Devin Review and DeepWiki as priced products.
2. Factory.ai (Droids). Series C $150M at $1.5B led by Khosla, April 2026 (PRIMARY, factory.ai/news/series-c). $5B after a $200M raise about September 2026 (UNVERIFIED, single source). Sacra estimate $60M annualized March 2026 (estimate). Pricing Pro $20, Plus $100, Max $200 (SINGLE, not verified on Factory's page). Ships: droids integrated across CI, ticketing and the SDLC, sold to enterprises; PR for human approval.
3. Anthropic Claude Code. Above $2.5B annualized run rate February 2026 (SECONDARY citing Reuters). Anthropic overall about $30B April 2026 and $47B at Series H May 28 2026 (SECONDARY); $65B (SINGLE). Claude Code-only figure after February 2026 NOT FOUND. Strategic fact: Loki is a layer on a platform that is itself the largest competitor, and Claude Code ships its own verification step (memA).
4. Cursor (Anysphere). $29.3B post-money November 2025; ARR $2B February 2026, $3B May 2026, about $4B June 2026 (UNVERIFIED, single source); SpaceX option for $60B exercised June 16, close reported August 14 2026 (Wikipedia, needs primary). Ships: editor-native distribution with millions of seats and parallel cloud agents in the IDE.
5. OpenAI Codex. 4M weekly developers April 21 2026, up from 2M on March 31 (SECONDARY); 5M in June unconfirmed. Bundled in ChatGPT Plus $20, Pro $100 and $200; credits from April 2026. About 20 percent non-developers. Revenue NOT FOUND. Ships: consumer-subscription distribution and a non-developer audience.
6. Replit. $400M Series D at $9B, March 2026 (SECONDARY, Sacra); about $525M annualized April 2026 (Sacra estimate), target $1B by year end; gross margin swung from 36 percent to minus 14 percent in 2025 on LLM costs.
7. Lovable. $400M Series C at $13.3B, August 12 2026 (SECONDARY); run rate tracking to about $600M (a target); $300M ARR February 2026; a security flaw exposed project data for 48 days; ships a publish-blocking security gate (memA).
8. Agent-run software company or agent-org product as a named comparator: NOT FOUND.

What competitors ship that Loki does not (COMP gap map):
1. Self-serve priced tiers and consumption billing (Devin, Codex, Replit, Lovable). Loki has no priced surface; product is free (DEC D54 amendment).
2. Hosted parallel cloud agents producing PRs (Devin, Factory, Codex cloud, Cursor). Loki runs locally; hosted runner is an open ask.
3. Productized review and repo wiki (Devin Review, DeepWiki).
4. Enterprise integrations sold as product (Factory): Jira, Linear, Slack, CI. Loki's list is unbuilt (s07 2026-10-04).
5. A non-developer audience (Codex, Lovable, Replit).
6. Fast first visible output: minutes versus Loki's hour on a landing page (s05 2026-07-17T02:37).

What Loki has that no source found claims: persisted, portable, diff-bound, signed Evidence Receipts; exogenous gates; a provider-agnostic harness across five CLIs. These are real only if the scoreboard proves the user gets a finished, correct result at lower cost than raw Claude Code. Today it does not (section 1).

Lessons from competitors' failure modes: Replit's margin swings and Lovable's 48-day data exposure are the two problems Loki's cost ledger and gates claim to solve. That is the only honest positioning available now, and it needs measured proof.

---

## 6. The 20 highest-leverage changes

Ranked by expected user value per week. Each has one owner role (roles from docs/v10/OPERATING-MODEL.md plus the seats the founder asked for) and one measurable success metric. "Week 1" means it must show a reading within 7 days.

1. Build the outcome scoreboard and make it the only release-claim source. A fixed task set (FireLater#17, claude-code#21527, augmentiq#52, plus 20 real issues across the 14 repo shapes) run nightly against raw claude -p on the same model, with completion rate, cost per completed task, p50 wall time and 95 percent intervals. Owner: Chief Scientist (research seat). Metric: scoreboard published daily from week 1; every release note links a row.
2. Make FireLater#17 and #21527 VERIFIED, then hold them green nightly. They are the founder's two named failures. Owner: CTO with a HIGH opus engineer. Metric: both VERIFIED on published next, at or below raw cost, within 7 days; no regression for 14 consecutive nights.
3. First-run journey gate on the published package. `npm i -g loki-mode`, loki start on a fresh repo, dashboard HTTP 200, a merge-ready PR in under 10 minutes, on macOS bash 3.2 and Linux, after every publish, with automatic dist-tag rollback. Owner: Release Manager. Metric: 100 percent of publishes pass or are rolled back within 15 minutes; zero founder-found first-run breaks.
4. Measured activation funnel and install-first onboarding. Instrument install, first loki start, first verified outcome (opt-in disclosed telemetry per row 11 decision); install block first in README. Owner: Growth seat. Metric: share of installers who run loki start, measured weekly; measure the baseline in week 1 (the 5 percent figure is UNMEASURED, derived from a founder quote in s05), then target the baseline plus 20 points within 4 weeks of measurement.
5. Truth layer as mechanism. Claims registry plus a verifier seat that re-runs cited commands for every CEO report and every public number; tri-state results everywhere; CI blocks unregistered numbers. Owner: Chief of Staff with the verifier seat. Metric: zero founder "did you lie" or "is this true" corrections per week, counted from the transcript.
6. CEO console on the workstation. One local web app reading BOARD, METRICS, release state, scoreboard, spend and usage-readings.tsv, with stop-all control and a 30-minute digest. Owner: Chief of Staff (built by one Sonnet engineer, reviewed by a Tech Lead). Metric: founder status questions ("what's going on", "is it done") fall to zero per week; console uptime 99 percent.
7. ROI ledger. Per-agent tokens to dollars per slice, per release and per verified outcome, against SALARY-BASIS.tsv (levels.fyi 2026-09-24 snapshot, overhead multiplier marked as assumption until the CEO sets it). Owner: CFO/ROI seat. Metric: weekly ROI line on the console; cost per verified outcome trending down week over week.
8. Release truth and channel convergence. Uncached registry proof for latest and next, the independent converge job red not skipped, single-sourced version, dist and mirrors generated at publish. Owner: Release Manager. Metric: zero divergence minutes between VERSION, npm latest, npm next and tags per week; version-mirror commits drop from about 650 per 90 days to zero.
9. One release policy, written once, with deletion. continuous next per approved slice; latest promoted at most daily with user-facing notes; waivers as expiring flags. Owner: CTO. Metric: zero policy reversals without a deletion commit; release notes on latest contain at least one measured user delta.
10. Durable leader loop with no founder relay. Scheduled routine re-dispatching from BOARD when a session ends; ready queue refilled to 30; idle seats and stalls auto-escalated; stop allowed only on explicit founder stop. Owner: Chief of Staff. Metric: ready queue at or above 30 and zero idle-seat minutes per day while work exists; zero "prompt for you to paste" deliverables.
11. Dashboard as one event-sourced surface. One server, one launch path, every widget traced to events.jsonl, real-run Playwright gate, scoped stop. Owner: Product Owner for Control Plane plus a design seat. Metric: populated-data gate green on every release; zero dashboard defects reported by the founder or users per week.
12. Process safety. PreToolUse guard banning pattern kills and glob deletes, recorded-PID cleanup only, spawn-depth guard, worktree cap, resource governor on CPU and memory. Owner: Tooling Tech Lead. Metric: zero killed bystander sessions, zero machine overloads above load 28, zero lost coordination files per month.
13. Class-closing proof ownership. One resolver for which package and test owns a changed file, consumed by seal, verify and deep, with a per-ecosystem mutation-gated fixture matrix. Owner: CTO with HIGH reviewers. Metric: Family A failure rows added per week fall to zero for 4 weeks.
14. Deny-by-default child env constructor. Every spawn uses it; full_env_spawn_guard baseline to zero; planted-credential fixtures. Owner: Security reviewer seat. Metric: SWEEP backlog at zero; zero token-leak findings.
15. Model routing and the harness-equalization benchmark. Pinned models per role, Opus share under 30 percent, nightly first-iteration pass rate per tier. Owner: Chief Scientist. Metric: proposed target (not yet measured) of Haiku first-iteration pass rate within 5 points of Opus on the scoreboard set; Opus share under 30 percent weekly.
16. Bookkeeping removal. Changelog fragments compiled at release, BOARD and FC and DECISIONS in a structured store with allocated IDs, dist out of main, conventional-commit lint. Owner: Architect. Metric: hand-merges per week to zero; docs share of commits under 10 percent; unclassified commits under 5 percent.
17. Review cost cap. Introduced-by-diff blocks, pre-existing becomes a slice, 2 rounds then CTO, opus builders on HIGH slices. Owner: CTO. Metric: median review rounds at most 1.5; p90 time from slice done to merged under 60 minutes.
18. Fast preview and time-to-first-visible-output. Build agent emits a preview descriptor; UI-first lane; isolated ports. Owner: Product Owner for loki start. Metric: median minutes to first visible preview on the scoreboard set, target under 5.
19. Competitive intelligence and distribution through competitors' seats. Weekly dated competitor matrix (COMPETITORS.tsv with confidence), Autonomi Verify callable as MCP and CLI from Claude Code, Codex and Cursor, tested in CI. Owner: Research seat plus Growth seat. Metric: matrix refreshed weekly with zero single-source numbers in strategy docs; Verify host-integration tests green on 3 hosts.
20. Release-driven honest content. Each latest promotion generates blog, docs, Discord and LinkedIn drafts with scoreboard numbers, gated by the claims registry and link checker. Owner: Comms seat. Metric: every latest promotion has published content within 24 hours; zero dead links; downloads per day measured weekly against a measured baseline (838 per 7 days at 2026-09-25, re-measured in week 1; the 94 per day floor is unmeasured and is not used).

The 10-seat roster these changes assume: Chief of Staff; CTO; Chief Scientist (research and benchmarks); Release Manager; Architect; Product Owner (loki start and Control Plane); Security and verifier reviewer; Tooling Tech Lead; Growth and Comms; CFO and ROI. Engineers are Sonnet, spawned per slice under the seat cap, and are not counted in the 10.

---

## 7. What to stop doing

1. Stop counting releases, commits, guards or docs as progress. Report the scoreboard and the funnel instead.
2. Stop releasing to latest on every slice. Use next for every slice and promote latest on user-visible change.
3. Stop stacking new release or cost policies on top of old ones. Delete the superseded text and scripts in the same change.
4. Stop restating rules in prompts, CLAUDE.md files and memories. Turn each into a hook, guard or script, or drop it.
5. Stop accepting "done", "tested" or "green" without a cited command on the published artifact.
6. Stop testing from the repo checkout. Test the tarball, the registry and the user's machine shape.
7. Stop asking the founder questions that have a safe default, and stop handing him prompts to paste.
8. Stop killing processes by name or pattern, and stop cleanup by glob. Signal recorded PIDs only.
9. Stop fixing one ecosystem, one runner or one file at a time when a class row has siblings. Close the class.
10. Stop ceilings, windows and hand-kept allowlists as guards. Use bans or derived lists.
11. Stop committing dist, version mirrors and shared append files by hand.
12. Stop unbounded fanouts. Every spawn has a cost forecast, a time box and incremental output.
13. Stop persona role-play ideation and redesigns from training. Use references, demand evidence and visual diffs.
14. Stop opening new product lines (Bloom, autonomi-saas, Purple Lab, VaaS) until loki start beats raw Claude Code on the scoreboard.
15. Stop public numbers without a source: no agent counts, session counts, multipliers or ratings without a registry row.
16. Stop treating "competitors do not verify" as the wedge. It is false. Lead with signed, portable evidence plus measured outcomes.
17. Stop running review rounds past 2. Escalate to the CTO.
18. Stop pasting secrets into chat. Use gh secret or the keychain.
19. Stop letting harness and canary prompts count as founder intent in any retrospective or metric.
20. Stop waiting on CI, the founder or a single agent when other ready work exists.

## 8. Coverage limits of this retrospective

What was read, and what was left out, so no reader mistakes this for a full read of every session.

- Corpus: ~/.claude/projects holds 303 loki and autonomi project directories, 17,688 session files, 4.48 GB in total.
- Extraction (scratchpad retro/extract.py) kept only user-role text. It skipped sidechain (subagent) messages, meta and system messages, teammate relays and slash-command bodies, and deduplicated by the md5 of the first 600 characters. Result: 7,821 unique user messages.
- A second filter dropped machine-written prompts ("You are ...", "Based on the following project", "Another Claude session", any message over 3,000 characters). Result: 2,518 founder messages, 817 KB, 2025-12-28 to 2026-10-23, split into 9 shards (s00 to s08) and read in full by sonnet readers.
- Left out: 5,303 deduplicated user messages that the filter classed as machine prompts (some long founder messages over 3,000 characters are among them), every assistant turn, every tool result, and every subagent transcript. Assistant-side reasoning was not mined; learnings come from founder text, memory, decisions, failure classes, guards, git and competitor research.
- Memory: about half of the 252 memory files were read only by index line or file head (see the Inputs line).
- Next pass (owner: research-outcomes-scientist): re-read the over-3,000-character founder messages, read the remaining memory files in full, and mine assistant turns that end in a founder correction. Report counts per shard, as in this pass.
