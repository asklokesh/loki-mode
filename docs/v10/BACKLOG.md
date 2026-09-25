# Backlog

Ranked. Moat work and red-main fixes always rank first. Each item: milestone,
the metric it moves, status. Plans live in the item.

Status values: todo, in progress, shipped (version), parked (reason).

## Now

1. **Moat suite `tests/moat/` (M0).** Metric: moat properties proven (0 of 9 measured before this). Status: in progress (cycle 1).
   Plan: one script per property emitting `CASE <id> PASS|FAIL`; runner enforces a shrink-only `pending.txt` ratcheted against the last release tag (D2); registered in the local-ci fast tier and a dedicated "Moat suite" job in the Tests workflow (tags fetched). Enforced now: P1 portable proof (with two fixes: Bun `--jwks` passthrough, stripped signature fails), P6 in-place brownfield, the P2 subset that holds. Everything else lands as real failing cases, pending with a milestone.

## Next (moat gaps the audits found, 2026-09-25)

2. **P7 no fabricated data (M7, pulled forward: moat).** Admin page mounts three sample-data panels (`web-app/src/pages/AdminPage.tsx:393,401,405`); unmeasured cost rendered as `$0.00` in `loki-fleet.js:52`, `loki-analytics.js:428`, `ProjectWorkspace.tsx:804`. Fix, rebuild bundles, promote the P7 cases.
3. **P9 Rule of Two (M3, pulled forward: moat).** `loki-issue-to-pr.yml` holds issue text, secrets and push in one step; no `author_association` gate on `/loki`; checkout persists credentials; provider env keeps `GH_TOKEN`. Split read and push jobs; scrub tokens from the provider env.
4. **P2 remaining honest-verdict gaps.** Council approval on inconclusive evidence exits 0 (M2 Seal verdict); `loki verify` and `--fast` exit-code renumber (v10.0.0, breaking).
5. **P3 the Wall + P8 load-bearing proof (M2).** Separate check-author context; freeze and hash checks; no-op ablation in the Seal with N/A path.
6. **P4 model freedom (M0).** Add `claude-opus-5-5` to the catalog after confirming the id; seeded-defect corpus (100+ mostly deterministic defects); floor vs top wrong-pass measurement.
7. **P5 sovereignty (M9).** Egress-blocked start, seal, verify; `doctor --airgap` false "air-gap ready" for opencode with a remote default.

## M0 measurement (after the moat suite)

8. Factory eval: greenfield and brownfield items with known-good outcomes; Seal rate, cost per sealed change, lead time, human touches; top, floor, routed.
9. Seeded-defect corpus (shared with item 6).
10. Adoption eval: scripted fresh-machine run, time to first sealed PR, decisions asked.
11. Head-to-head arms: raw Claude Code (Opus 5.5), raw Codex (through opencode/OpenAI route, or recorded as a gap), hidden tests.
12. Baselines into `METRICS.md`.

## Carried over from v9

13. `docs/INSTALLATION.md:446` pins `asklokesh/loki-mode:8.0.0` in a live `docker run` block; add the line to the release bump list, not just the value.
14. Work selector `select_next_work()` in worktree branch `worktree-agent-a8fad9a6e301fe297` (19/0 tests, 8 mutations verified). Candidate for M5 backlog mode.

## Later milestones

M1 one command, M2 Seal and Wall, M3 assign like a teammate, M4 system map, M5 the line, M6 ship and operate, M7 one screen, M8 legacy lane, M9 enterprise readiness, M10 simplify and ship v10.0.0. Items get broken out here when their milestone comes up.
