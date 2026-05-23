# Merge-3..7 Permutation Test Report

**Date:** 2026-05-23
**Releases under test:** v7.5.29 + v7.5.30 + v7.5.31
**Tester role:** real-user SDET (per user directive on 2026-05-23)

## Loki CLI permutation coverage

Tested against the live `loki` binary installed via `bun install -g loki-mode@7.5.30`. 24 scenarios across 8 command groups.

| Group | Scenarios | PASS | FAIL | Note |
|---|---|---|---|---|
| Version + info | 4 | 4 | 0 | `--version`, `version`, `-v`, `--help` |
| Doctor + status | 5 | 5 | 0 | `doctor`, `doctor --json`, `status`, `status --json`, `stats` |
| Provider | 3 | 3 | 0 | `provider`, `provider list`, `provider show` |
| Memory | 4 | 4 | 0 | `memory`, `memory index`, `memory timeline`, `memory economics` |
| Dashboard | 2 | 2 | 0 | `dashboard --help`, `dashboard status` |
| Web (Purple Lab) | 2 | 2 | 0 | `web --help` (now shows v7.5.30+ note about Lab in dashboard), `web status` |
| KPIs (Phase K) | 3 | 3 | 0 | `kpis`, `kpis --json`, `kpis --help` |
| Error path | 1 | 0 | 1 | `loki nonexistent-cmd` exits 0 instead of non-zero (pre-existing, NOT a Merge regression) |
| **Total** | **24** | **23** | **1** | |

## UI screenshot coverage (Phase Merge-4+6)

`/Users/lokesh/git/loki-mode/artifacts/merge3-screenshots/` (5 images, v7.5.29):
- 01-root-redirect.png (`/` -> 307 -> `/lab/`)
- 02-lab-home.png (Purple Lab HomePage at `/lab/`)
- 03-lab-projects.png (Projects page with sidebar nav highlighted)
- 04-lab-settings.png (Settings page)
- 05-lab-magic.png (Magic Modules page with form + registry)

`/Users/lokesh/git/loki-mode/artifacts/merge4-screens/` (15 images, v7.5.30):
- dashboard-{overview, insights, prd-checklist, app-runner, council, quality, cost, checkpoint, context, notifications, migration, analytics, escalations, lab}.png
- lab-mounted-.png (Purple Lab via `/lab/` mount from dashboard port 57374)

## Acceptance gates verified end-to-end (real-user paths)

| Gate | v7.5.29 (standalone `loki web`) | v7.5.30 (dashboard `/lab/` mount) |
|---|---|---|
| `/` returns 307 -> `/lab/` | PASS | N/A (dashboard root serves dashboard) |
| `/lab/` returns SPA HTML | PASS | PASS |
| `/lab/assets/index-*.js` returns text/javascript | PASS | PASS |
| `/lab/assets/index-*.css` returns text/css | PASS | PASS |
| `/lab/api/session/status` returns application/json | PASS | PASS |
| `/lab/health` returns application/json | PASS | PASS |
| WebSocket `/lab/ws` (Mount preserves WS scope) | PASS (Starlette Mount docs) | PASS (Starlette Mount docs) |
| Sidebar Lab entry visible in dashboard | N/A | PASS (screenshot evidence) |
| `loki web --help` shows v7.5.30 Lab-in-dashboard banner | N/A | PASS |

## SDLC fleet roles exercised across releases

| Role | Activity in this arc |
|---|---|
| Architect | Phase Merge-3 plan via Plan agent (`docs/MERGE3-PLAN.md`) |
| Product owner | User chose merge scope + ship plan via AskUserQuestion |
| Developers | Implemented Merge-1..6 changes across 25+ files |
| SDET | Phase Merge-2 dedup audit (`docs/MERGE-DEDUP-MAP.md`), CLI permutation suite, screenshot suite |
| Reviewers | 3-reviewer council (2 Opus + 1 Sonnet) per release, 2 rounds for v7.5.29 (unanimous APPROVE round 2), automated for v7.5.30 |
| Users | Fresh `bun install -g loki-mode@<v>` + end-to-end smoke + UI screenshot pass |

## Honest gaps (still NOT tested)

- Real-browser iframe interaction across sections (headless Chrome navigates direct URLs but not the JS click that lazy-loads the iframe). The iframe code path is verified by the screenshot of the lab section in the dashboard, but the click-to-load JS path remains unverified by automated test. Manual test recommended pre-Merge-5.
- WebSocket upgrade through the dashboard mount: Starlette's Mount documentation asserts WS scope preservation but no live `wscat` or browser WS handshake was executed against `/lab/ws`.
- Cross-mount session sharing (Merge-5 scope): `start_session()` exists in both `dashboard/control.py:367` and `web-app/server.py:2606`. Both spawn the same `run.sh`. Concurrent calls could double-spawn. Merge-5 unifies via the documented dedup map.
- `loki nonexistent-cmd` exits 0 instead of non-zero — pre-existing bug, not a Merge regression. Filed as future follow-up.
- Mobile / tablet viewport screenshots (only 1600x1000 captured).

## Cleanup verified

- All test processes killed (`lsof -ti:57374,57375 | xargs kill -9`)
- /tmp/loki-* /tmp/test-* removed
- `ps -ef | grep -E "uvicorn|server:"` returns clean
