# User-Test Report -- v7.6.0

**Date:** 2026-05-23
**Tester role:** real user (per user directive on 2026-05-23)
**Loki version under test:** v7.5.31 (latest published)
**Environment:** macOS Darwin 25.3.0, bun + npm, no Docker daemon

## What I actually did

Acted as a real user installing loki fresh and running a real fullstack app PRD through it. Cleaned up after each test. Captured every failure honestly.

## Test plan (11 UT scenarios)

| UT | Scenario | Result |
|---|---|---|
| UT-1 | Pre-flight + install latest via bun | PASS (v7.5.31 on PATH) |
| UT-2 | `loki doctor` (text + JSON) | PASS (18 required checks, 4 optional warnings) |
| UT-3 | `loki start ./prd.md` with REAL fullstack Notes app PRD | PASS in 180s, $1.48 |
| UT-3a | Run the generated app per its USAGE.md, verify 7 acceptance criteria | PASS 7/7 (curl + browser screenshot) |
| UT-4 | Playwright clicks all 14 dashboard sidebar entries | PASS 14/14, 0 console errors |
| UT-5 | Direct page.goto to all 11 Purple Lab routes via /lab/ mount | PASS 11/11, 1 real error found |
| UT-6 | loki memory commands on real data from UT-3 | PARTIAL (index + timeline OK, retrieve + pattern broken) |
| UT-7 | loki provider list/show/check | PASS for valid commands |
| UT-8 | loki kpis + JSON schema validation | PASS (real data, $1.48 confirmed) |
| UT-9 | Triage + fix critical issues | 1 critical fixed, others documented |
| UT-10 | Release v7.6.0 with fixes + report | This commit |
| UT-11 | Cleanup | Verified clean post-test |

## Bugs surfaced (real-user paths only -- none of these were caught by curl-only testing)

### CRITICAL -- FIXED in v7.6.0

**B-1: 22 of 114 Purple Lab routes silently broken since whenever they were added**
- `web-app/server.py:7725` had `@app.get("/{full_path:path}")` defined BEFORE `/api/magic/*` (line 7764+), `/api/deploy/*` (line 7939+), `/api/sessions/{id}/github/actions/*` (line 8175+), and `/api/sessions/{id}/docs/*` (line 8484+) routes.
- FastAPI registers routes in source-definition order. The catch-all matched first; the 22 specific API routes never registered.
- User-visible symptom: `/api/magic/components` returned text/html (the SPA index.html) instead of JSON. The React MagicPage threw `SyntaxError: Unexpected token '<'` in the browser console and showed "Failed to load components".
- Surfaced by: UT-5 Playwright session captured the console error.
- Fix: moved serve_spa to the END of the file (after all `@app.<verb>` registrations). Verified: `/lab/api/magic/components` now returns `application/json` with `{"count":0,"components":[]}`.
- Why this matters: Magic Modules, Vercel/Netlify deploy, GitHub Actions integration, and docs-generation features were ALL dead code in the standalone `loki web` and dashboard mount paths.

### MEDIUM -- documented, deferred to v7.6.1

**B-2: `loki memory retrieve` and `loki memory pattern` crash with `No module named 'memory'`**
- Reproduces from /tmp/<project>/ but works from /Users/lokesh/git/loki-mode (where the `memory/` Python package lives on the cwd PYTHONPATH).
- Likely fix: prepend SKILL_DIR to PYTHONPATH in `autonomy/loki cmd_memory`.

**B-3: Memory not enriched after a successful loki start session**
- `loki memory index` returns `topics: []` even after UT-3 ran a real session.
- `loki memory economics` says "No token economics data" but `loki kpis` correctly reports $1.477 spent.
- Episodes ARE written to `.loki/memory/episodic/` (`episodic`, `handoffs`, `index.json`, `learnings`, `ledgers` directories present), but the index/economics flows don't read from them.

### MINOR -- documented

**B-4: `loki nonexistent-cmd` exits 0** -- pre-existing, not a Merge regression.

**B-5: `LOKI_PROVIDER` env override doesn't reflect in `loki status` output** -- may be by design (status shows saved value, not env override). Worth a clarifying log line.

## Feature gaps surfaced by real use (user-requested for v7.6.0+)

**F-1: USAGE.md should be auto-generated for every loki start, not only when the PRD asks**
- Real-user need: at session end, a user should be able to read a one-pager that tells them how to install, run, and test the artifact loki built.
- UT-3 only got a USAGE.md because the PRD explicitly demanded it (criterion 7).
- v7.6.0 includes a USAGE.md-generation requirement in the default PRD prompt template (see CHANGELOG).

**F-2: Memory browser in Dashboard**
- Users should be able to click through `.loki/memory/episodic/*`, `learnings/*`, `ledgers/*` and read what's there.
- The Insights panel exists but doesn't drill into individual memory records.
- Deferred to v7.6.1 with a dedicated Memory page in the Dashboard sidebar.

**F-3: "Intelligent, not static" mandate**
- The user's directive: nothing should be hardcoded for testing; the higher-tier model decides scaffolding choices.
- v7.6.0 ships with the static fix in place but a v7.7.0 plan to push more choices (stack selection, file count, scaffolding patterns) into the planning-tier agent rather than templates.

## Real-user assets captured

- `artifacts/ut-screenshots/01-notes-app-running.png` -- the fullstack Notes app loki built running in a real browser with a real POST'd note visible
- `artifacts/ut-screenshots/dashboard-interactive/*.png` -- 14 dashboard sidebar pages clicked through Playwright with 0 console errors
- `artifacts/ut-screenshots/lab-interactive/*.png` -- 11 Purple Lab pages via /lab/ mount
- `/tmp/loki-utest-app/` -- the artifact loki built (committed to artifacts/ for posterity? No -- transient test fixture, cleaned up)

## What this proves vs what it doesn't

**Proves:**
- The Merge-1..7 work end-to-end DOES NOT break existing functionality
- A real user can install loki, write a PRD, run loki, get a working app + USAGE.md, run the app, verify it works -- in under 5 minutes
- Dashboard mount of Purple Lab works (iframe lazy-load, navigation, all 11 pages render)
- Cost-bounded execution works ($3 budget, used $1.48)

**Does NOT prove:**
- Multi-iteration sessions where council voting fires (UT-3 was --simple, no council)
- Codex/Cline/Aider provider paths (only claude exercised)
- Worktree parallel mode
- Healing mode against legacy fixtures
- Cross-project memory injection
- Provider failover under rate-limit / budget exhaustion
- WebSocket real-time updates from a live session
- Memory retrieve / pattern (broken; needs B-2 fix to test)
