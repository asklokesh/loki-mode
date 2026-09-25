# Founder queue

Things only the founder can do or decide. Append-only. The loop never blocks on
this file; each item says what the loop does meanwhile.

| # | Date | Item | Why only you | Loop does meanwhile |
|---|---|---|---|---|
| 1 | 2026-09-25 | Review the stash `pre-v10 leftover (founder review)` (commit `2c00b2eb`, `git stash show -p 2c00b2eb`). Six uncommitted files found at v10 start: `coverage/clover.xml`, `coverage/lcov-report/index.html`, `loki-ts/tests/integration/loki_start_e2e.test.ts`, `tests/fixtures/project-graph/acme/ui/.loki/state/project-graph.json`, `tests/test-proven-pr-receipt.sh`, `web-app/tests/e2e/filewatcher.spec.ts`. Apply, or drop. | Not the loop's work; build prompt 1b says stash, never commit or discard. | Works on a clean main. |
| 2 | 2026-09-25 | Add a cheap-model key (DeepSeek, OpenRouter or MiniMax) to the environment the loop runs in. | Needs an account and a card. | Uses Claude Haiku 4.5 or the cheapest OpenAI model reachable through opencode as the provisional floor (build prompt section 5). |
| 3 | 2026-09-25 | Daily model budget is **$50/day** unless you change this line. | Money. | Stays under it; deterministic work when out. |
| 4 | 2026-09-25 | Expected founder items for v10: SOC 2 audit, sales motion, Claude Marketplace partner application, GitHub and GitLab partnerships, pricing. | Contracts, money, legal. | Engineering ships readiness docs only, never a certification claim. |
| 5 | 2026-09-25 | Five older stashes predate v10 (`stash@{1}`..`stash@{5}`, v9.22.10 era and three `autonomi/*` branches). Keep or drop. | Not created by the loop. | Leaves them alone. |
| 6 | 2026-09-25 | On this Mac (macOS 27.0), `/usr/bin/python3` stops at "You have not agreed to the Xcode license agreements". Run `sudo xcodebuild -license accept` once. It may be why the seatbelt test in `tests/dashboard/test_build_supervisor.py` fails locally and blocks the pre-push hook (D5); not proven. | Needs sudo. | Investigates the seatbelt test separately (BACKLOG). |
