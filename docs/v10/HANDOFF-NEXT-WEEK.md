# Handoff to next week (D59, written 2026-10-01; resume Wednesday 2026-10-07)

## On npm now (updated 2026-10-02T23:52Z after the D60 sprint)
- latest and next: 10.6.7 (`npm view loki-mode dist-tags` gave latest 10.6.7, next 10.6.7 at 23:51Z; moved by the D49 auto-promote after Post-Release Smoke passed on bfce1db12; the D58 real-repo gate is still not wired into promote).

## Releases this window and their CI
- 10.6.0 (9f9569c35, tree d922ef170): Tests, Bun Parity, Coverage, Security Audit all green on train/72 and on main. Published.
- 10.6.1 (9bc3cfcc7): Tests red, shard 7, `test-engine10-docs.sh` (the D57 docs pass removed the README loki10-default marker). Not published.
- 10.6.2 (5c1e3324d): Tests red from W1-ROUTE (moat P5 egress-blocked-start-seal-verify, P5 local-provider-no-claude-sidecalls, P9 injection-cannot-reach-token; `loki run --help` flags; UI bare loki; progressive isolation help; platform-divergent construct; docs-drift `loki agent` in docs/R10-MARKETPLACE-PLAN.md). Not published; W1-ROUTE reverted (30096450f).
- 10.6.3 (f289f8bf2): Tests red, shard 7, `test-ui-bare-loki` (LEAK3 prints http://127.0.0.1:57374/start where the test expects otherwise). Not published; LEAK3 reverted (05410c554).
- 10.6.4 (3a4df211c): every Tests job failed installing deps (npm 404 on baseline-browser-mapping-2.11.27.tgz, a fresh publish not yet propagated; 200 a few minutes later). Not published; content carried into 10.6.5.
- 10.6.5 (0472f306a): Moat suite red, P9 injection-cannot-reach-token regressed by the minimal `loki start <ref>` route (b2e3afc43): the P9 probe drives `loki start <issue>` and expects a provider session; engine10 exited rc=2 first. Not published; start route reverted (621437c0a).
- 10.6.6 (456058bae): scope control, Control Plane v0, train-cycle fix, docs. Tests, Bun Parity, Coverage, Security Audit all green; Release succeeded. Published.

## D60 sprint (2026-10-02, one hour, all five slices in 10.6.7)
- 10.6.7 (bfce1db12, train/79 1917333e1): Tests, Bun Parity, Coverage, Security Audit, First-run gate, SBOM, Release, Post-Release Smoke, Promote all success.
- Shipped: `loki start` runs Loki 10 (moat P9 probe ported, moat rc=0); dashboard prints the bound port (LEAK3, test-ui-bare-loki rc=0); reviewer-first PR body; issue-to-PR Action on Loki 10 plus nightly `loki backlog` example; visible cost cap ($20 default, `--max-cost`, loki.yaml `budgets.per_run`, BUDGET_STOP exit 3).
- Open: no real end-to-end exit 3 run of the cost cap yet; root action.yml still uses `loki start --simple`.
- D61 (speed, docs/v10/D61-SPEED.md) paused by the governor; slice 17 partial work in worktree agent-ad890c5afa3648ae6. Peer GO covers slices 1, 2, 7, 8, 17 behind LOKI_SPEED=1.
- D58 basics 1 and 2 below are superseded by 10.6.7 (now PASS on CI; still unproven on a real repo).

## D58 basics
1. `loki start` runs v10: FAIL. Both the minimal route (b2e3afc43, a 7-line bin/loki start arm) and the full re-route regress moat P9, because tests/moat P9 drives `loki start <issue>` through the legacy path; port that probe to the v10 issue path first, then re-land b2e3afc43. The full re-route W1-ROUTE is built (branch slice-D57-W1-ROUTE, commit a8ed5461a, which is based on the old main that still has the CP-00 JWT commits, so cherry-pick it, never merge it) but turned Tests red as listed above. Its docs follow-up is f001bc0f1.
2. Dashboard: FAIL. LEAK3 (bound URL, scoped reuse, 57374-57399 guard; branch slice-P0-DASH-LEAK3, ceba8a6de) failed `test-ui-bare-loki` in CI and was reverted. The Control Plane v0 live view (CP-RELAND) ships in 10.6.6, off unless LOKI_CONTROL_URL is set.
3. Scope control: SHIPPED in 10.6.6 (D58-SCOPE, reverts unrelated edits, lists them in NOT PROVEN). Unproven on a real repo.
4. Clean install: PASS on 10.6.0 (per-platform @oven/bun-* deps; post-release smoke passed, which is what fired the promote).
5. Real-repo gate before latest moves: FAIL. `scripts/real-repo-gate.sh` exists but promote does not call it, and it needs operator provider auth (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, plus GH_TOKEN) that this session does not have. Not run against latest.

## NOT DONE and why
- W1-ROUTE and its docs cleanup: red CI (above); dropped per D46 rule 2.
- LEAK3 dashboard fix: red CI (`test-ui-bare-loki`); dropped. Its test expectation and the new bound-URL output disagree; decide which is right.
- Real-repo gate run: no provider auth in the session; never reads stored keys.
- Coverage W1-ROUTE removed and must be replaced when it re-lands: `why --json` schema test, eval harness cost checks (R2, S41-01), five trust-core probe cases (CTO sign-off).
- Wiring the real-repo gate into promote.yml (so latest cannot move without it).

## Founder queue
- Re-land W1-ROUTE with the moat P5/P9 regressions fixed first (moat outranks everything).
- Decide whether promote must call the real-repo gate, and supply provider auth for it.
- The D59 override (release without waiting for CI) expired at 20:10Z; the Release workflow's required-ci still enforced green Tests throughout.
- Housekeeping: about 43 worktrees under .claude/worktrees (cap 15); backup branches backup/train-67..70 and backup/main-pre-rebuild hold the CP-00 JWT lineage, so never push them.
